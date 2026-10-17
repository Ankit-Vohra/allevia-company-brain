// How Allevia's answers look in Discord (pure functions, unit-tested): messages split under Discord's 2,000-character
// limit, [[id]] citations as small superscript numbers with one quiet sources line, the turn's checks as badges, and the
// link to the web path view.
import { markerText, numberCitations } from "../../shared/citations.js";
import type { TurnChecks } from "../../shared/contracts.js";

export const DISCORD_MAX = 2000;
export const THREAD_NAME_MAX = 100;
const LABEL_MAX = 40;
const SOURCES_MAX = 8;

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const isHigh = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;

// The last good place to cut `s` at or before `max`: a paragraph break, else a line break, else a space, else `max`
// itself (moved back one if that would split a surrogate pair). Returns [head, tail] with the separator dropped.
function cut(s: string, max: number): [string, string] {
  const window = s.slice(0, max + 1);
  for (const sep of ["\n\n", "\n", " "]) {
    const at = window.lastIndexOf(sep, max);
    if (at > max * 0.3) return [s.slice(0, at), s.slice(at + sep.length)];
  }
  const at = isHigh(s.charCodeAt(max - 1)) ? max - 1 : max;
  return [s.slice(0, at), s.slice(at)];
}

const fenceCount = (s: string): number => (s.match(/```/g) ?? []).length;

// Splits text into Discord messages of at most `max` characters, on paragraph, line or word boundaries where it can.
// A code block cut in two is closed at the end of one part and reopened (same language) at the start of the next.
export function splitMessage(text: string, max: number = DISCORD_MAX): string[] {
  const parts: string[] = [];
  let rest = text;
  let reopen = "";
  while (rest.length) {
    rest = reopen + rest;
    if (rest.length <= max) { parts.push(rest); break; }
    let [head, tail] = cut(rest, max);
    if (fenceCount(head) % 2 === 1) [head, tail] = cut(rest, max - 4); // room for the closing "\n```"
    reopen = "";
    if (fenceCount(head) % 2 === 1) {
      const open = head.lastIndexOf("```");
      const lang = /^```([\w+-]*)/.exec(head.slice(open))?.[1] ?? "";
      head = `${head}\n\`\`\``;
      reopen = `\`\`\`${lang}\n`;
    }
    parts.push(head);
    rest = tail.replace(/^\n+/, "");
  }
  return parts.filter((p) => p.length > 0);
}

// "metric:weekly-signups" -> "weekly signups"
const slugLabel = (id: string): string => id.slice(id.indexOf(":") + 1).replace(/[-_]+/g, " ").trim() || id;

const SUP = "⁰¹²³⁴⁵⁶⁷⁸⁹";
const sup = (s: string): string => s.replace(/\d/g, (d) => SUP[Number(d)]!).replace(/–/g, "⁻").replace(/, /g, " ");

// [[id]] -> a superscript number at the end of its clause ("unchanged.¹", "¹ ²" together), the same number each time an id
// is cited, and one small line under the text naming each: "-# Sources: ¹ Pause daily stories · ² weekly signups" (the
// node's name when a tool returned it, else the id's slug). Discord has no popover, so the names are a line, not chips.
export function renderCitations(text: string, names: ReadonlyMap<string, string>): string {
  const { md, ids } = numberCitations(text, (ns) => sup(markerText(ns)));
  if (!ids.length) return md;
  const shown = ids.slice(0, SOURCES_MAX).map((id, i) => `${sup(String(i + 1))} ${clip((names.get(id) ?? slugLabel(id)).replace(/[`*_~|]/g, "").trim(), LABEL_MAX)}`);
  const more = ids.length > SOURCES_MAX ? ` · +${ids.length - SOURCES_MAX} more in the path view` : "";
  return `${md.trimEnd()}\n-# Sources: ${shown.join(" · ")}${more}`;
}

const list = (xs: string[], n = 5): string => xs.slice(0, n).join(", ") + (xs.length > n ? ` +${xs.length - n}` : "");

// The turn's checks (spec §7.4) as badges. Failed checks are always shown, never hidden.
export function badges(c: TurnChecks): string {
  const out: string[] = [];
  if (c.citationsValid && c.numbersGrounded) out.push("✅ sources verified");
  if (!c.citationsValid) out.push(`⚠️ unverified source${c.invalidCitations.length === 1 ? "" : "s"}${c.invalidCitations.length ? `: ${list(c.invalidCitations)}` : ""}`);
  if (!c.numbersGrounded) out.push(`⚠️ unverified number${c.ungroundedNumbers.length === 1 ? "" : "s"}${c.ungroundedNumbers.length ? `: ${list(c.ungroundedNumbers)}` : ""}`);
  if (!c.simulatedDisclosed) out.push("⚠️ uses simulated data without saying so");
  if (!c.freshnessDisclosed) out.push("⚠️ may be out of date");
  return out.join(" · ");
}

// The web app's thread view, which lights the answer's path on the graph (web/src/App.tsx: /ask/:sessionId, ?tenant=).
export function pathViewUrl(webBase: string, tenant: string, sessionId: string): string {
  const id = encodeURIComponent(sessionId).replace(/%3A/gi, ":");
  return `${webBase.replace(/\/+$/, "")}/ask/${id}?tenant=${encodeURIComponent(tenant)}`;
}

export interface AnswerView {
  answer: string;
  checks: TurnChecks;
  names: ReadonlyMap<string, string>;
  url: string;
  error?: string;
}

// The final answer as Discord messages: the answer with labelled citations, then the badges and the path-view link
// (in <> so Discord shows no preview card).
export function renderAnswer(v: AnswerView): string[] {
  const body = v.answer.trim()
    ? renderCitations(v.answer.trim(), v.names)
    : `I couldn't finish this one: ${clip(v.error?.trim() || "something went wrong.", 300)}`;
  const footer = [v.answer.trim() ? badges(v.checks) : "", `Path view: <${v.url}>`].filter(Boolean).join(" · ");
  return splitMessage(`${body}\n\n${footer}`);
}

// A thread's name: the question on one line, mentions removed, within Discord's 100 characters.
export function threadName(question: string): string {
  const q = question.replace(/<@[!&]?\d+>|<#\d+>/g, " ").replace(/\s+/g, " ").trim();
  return q ? clip(q, THREAD_NAME_MAX) : "Question";
}
