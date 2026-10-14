// PENDING.md parser and graph mapper (spec 6.2). The file is the founder's open-items list: tables whose first column
// is a ref (`| N5 | action | why |`), and bullet lines in action sections. This turns each item into a Task owned by
// the founder or an agent, with its status, done date and linked GitHub issues.
//
// Item rules (documented because they are heuristics over a human-edited file):
// - Table row: item only when the first cell is a ref like N5, A3, F10 (so the credentials table is ignored).
//   Action = the column headed action/item/question/risk/…, else the second cell. Owner = an "owner" column, else the
//   section heading ("founder" in it -> founder), else agent.
// - Bullet: item when it is struck through, carries "(owner: x)", or sits under a heading that reads as an open list
//   (needs, pending, agent work, check, gaps, ...) or a closed one (done, decided, live, ...). Narrative sections
//   (deploy logs, status notes) are skipped. Its ref is `b-` + a hash of the title, so striking a line through later
//   keeps the same Task and flips it to done instead of creating a second one.
// - Done: the action starts with ~~strike~~, or has an uppercase "DONE <date>", or sits under a closed heading.
// - Title: first sentence of the action (the struck text for done rows), redacted, at most 160 characters.
import type { EdgeInput, NodeInput } from "../../graph/upsert.js";
import type { GraphWrite } from "../types.js";
import { entityId, sha256 } from "../../util/ids.js";
import { fenceMask, frontmatterEnd, scanHeadings } from "../headings.js";
import { redact } from "../redact.js";
import { founderNode, isReservedId } from "../actors.js";

export interface PendingItem {
  ref: string;
  owner: string;      // "founder", "agent" (any agent) or a named agent id
  title: string;
  done: boolean;
  doneAt?: string;    // YYYY-MM-DD
  issues: string[];   // "#331", "app#331", "Org/repo#42"
  section: string;
}

export const MAX_TITLE = 160;
const MAX_TEXT = 4000;   // per item: bounds the work the regexes do on a hostile line
const MAX_LINE = 20_000;

const ISO = /\d{4}-\d{2}-\d{2}/;
const REF = /^[A-Z]{1,3}\d{1,4}$/;
const BULLET = /^ {0,1}[-*+]\s+\S/;
const CLOSED_SECTION = /\b(?:done|decided|live|shipped|closed|resolved)\b/i;
const OPEN_SECTION = /\b(?:needs?|pending|open|to-?do|blocking|blocked|agent work|follow-?ups?|check|gaps?|found by|risks?|waiting|expiring)\b/i;
const OWNER_MARK = /\(?\bowner:\s*([A-Za-z][\w-]*)/i;
const ABBREVIATION = /\b(?:e\.g|i\.e|vs|etc|approx|no|st|dr|mr|mrs|ms|inc|ltd|cf)$/i;
const ACTION_HEADER = /^(?:action|item|what|task|question|risk|title|decision)\b/i;

// ---------- text helpers ----------

function stripMd(s: string): string {
  return s
    .replace(/\[\[([^\]|]{0,200})\|([^\]]{0,200})\]\]/g, "$2")
    .replace(/\[\[([^\]]{0,200})\]\]/g, (_m, t: string) => t.split("#")[0]!.split("/").pop() ?? t)
    .replace(/\[([^\]]{1,200})\]\([^)]{0,300}\)/g, "$1")
    .replace(/~~|\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function firstSentence(t: string): string {
  const re = /[.!?](?=\s+[A-Z0-9"“(\[])/g;
  for (let m = re.exec(t); m; m = re.exec(t)) {
    if (ABBREVIATION.test(t.slice(0, m.index))) continue;
    return t.slice(0, m.index + (m[0] === "." ? 0 : 1));
  }
  return t;
}

function truncate(t: string): string {
  if (t.length <= MAX_TITLE) return t;
  const cut = t.slice(0, MAX_TITLE - 1).replace(/[\uD800-\uDBFF]$/, "");
  const sp = cut.lastIndexOf(" ");
  return `${(sp > 80 ? cut.slice(0, sp) : cut).replace(/[\s,;:(–—-]+$/, "")}…`;
}

const wordCount = (s: string): number => s.split(/\s+/).filter(Boolean).length;
const capitalise = (s: string): string => (/^[a-z]/.test(s) ? s[0]!.toUpperCase() + s.slice(1) : s);

// The struck text at the very start of an action: "~~Paste the listings~~ DONE ..." -> "Paste the listings". A strike
// that opens here and closes in a later table cell has no closing mark in this cell: the whole cell is struck.
function leadingStrike(action: string): { inner: string; rest: string } | undefined {
  const m = /^\s*(?:\*\*)?~~(.{1,500}?)(?:~~(?:\*\*)?|$)/s.exec(action);
  return m ? { inner: m[1]!, rest: action.slice(m[0].length) } : undefined;
}

function buildTitle(action: string, strike?: { inner: string; rest: string }): string {
  let src = strike ? strike.inner : action;
  if (strike && wordCount(strike.inner) < 3) {
    const was = /\bWas:\s*(.+)$/s.exec(action);
    if (was) src = was[1]!; // "~~Push~~ DONE ...; Was: **Publish the templates branch.** ..." -> the real action
  }
  const clean = redact(stripMd(src.replace(/\(\s*owner:[^)]*\)/gi, ""))).text.replace(/\s+/g, " ").trim();
  return truncate(capitalise(firstSentence(clean).replace(/[.;:,\s]+$/, "")));
}

// ---------- fields ----------

export function extractIssues(text: string): string[] {
  const out: string[] = [];
  const re = /\b([A-Za-z0-9_.-]{1,60}\/[A-Za-z0-9_.-]{1,60})#(\d{1,6})\b|\b(app|website|web|marketing|voice|brain|ops)\s+(?:PRs?\s+|issues?\s+)?#(\d{1,6})\b|(?<![\w/&-])#(\d{1,6})\b/gi;
  for (const m of text.matchAll(re)) {
    const ref = m[1] ? `${m[1]}#${m[2]}` : m[3] ? `${m[3]!.toLowerCase()}#${m[4]}` : `#${m[5]}`;
    if (!out.includes(ref)) out.push(ref);
  }
  return out;
}

function normOwner(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const m = /[a-z][a-z0-9-]*/.exec(raw.toLowerCase().replace(/^the\s+/, ""));
  const o = m?.[0];
  if (!o || ["done", "closed", "none", "tbd", "na", "n", "open"].includes(o)) return undefined;
  return o === "agents" ? "agent" : o;
}

const sectionOwner = (heading: string): string => (/founder/i.test(heading) ? "founder" : "agent");

function doneDate(action: string, strike: { rest: string } | undefined, heading: string): string | undefined {
  const upper = [...action.matchAll(/\bDONE\s+(\d{4}-\d{2}-\d{2})/g)].map((m) => m[1]!).sort().at(-1);
  if (upper) return upper;
  const word = /\b(?:done|closed|merged|shipped|decided|live)\b[^0-9\n]{0,24}(\d{4}-\d{2}-\d{2})/i.exec(action);
  if (word) return word[1];
  const afterStrike = strike ? ISO.exec(strike.rest)?.[0] : undefined;
  return afterStrike ?? ISO.exec(heading)?.[0];
}

interface Raw { ref: string; action: string; all: string; owner?: string; closedSection: boolean; section: string }

function toItem(r: Raw): PendingItem {
  const action = r.action.slice(0, MAX_TEXT);
  const strike = leadingStrike(action);
  const done = !!strike || /\bDONE\s+\d{4}-\d{2}-\d{2}/.test(r.all) || /^\W*(?:DONE|Done)\b/.test(action) || r.closedSection;
  const owner = normOwner(r.owner) ?? normOwner(OWNER_MARK.exec(r.all)?.[1]) ?? sectionOwner(r.section);
  const item: PendingItem = {
    ref: r.ref,
    owner: isReservedId(entityId("Agent", owner)) ? "agent" : owner,
    title: buildTitle(action, strike),
    done,
    issues: extractIssues(r.all.slice(0, MAX_TEXT)),
    section: redact(stripMd(r.section)).text.slice(0, 120),
  };
  if (done) {
    const at = doneDate(r.all.slice(0, MAX_TEXT), strike, r.section);
    if (at) item.doneAt = at;
  }
  return item;
}

// ---------- tables ----------

// Split a table row on `|`, except inside backticks and [[wiki|links]], and after a backslash.
function splitCells(line: string): string[] {
  const s = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cur = "";
  let tick = false;
  let wiki = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\\" && s[i + 1] === "|") { cur += "|"; i++; continue; }
    if (c === "`") tick = !tick;
    else if (!tick && c === "[" && s[i + 1] === "[") { wiki++; cur += "[["; i++; continue; }
    else if (!tick && c === "]" && s[i + 1] === "]" && wiki) { wiki--; cur += "]]"; i++; continue; }
    if (c === "|" && !tick && !wiki) { cells.push(cur.trim()); cur = ""; } else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

const isSeparator = (cells: string[]): boolean => cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));

function tableItems(block: string[], section: string): Raw[] {
  const rows = block.map(splitCells);
  if (rows.length < 3 || !isSeparator(rows[1]!)) return [];
  const header = rows[0]!.map((h) => stripMd(h).toLowerCase());
  const actionIdx = Math.max(1, header.findIndex((h, i) => i > 0 && ACTION_HEADER.test(h)));
  const ownerIdx = header.findIndex((h) => /owner|assignee/.test(h));
  const out: Raw[] = [];
  for (const cells of rows.slice(2)) {
    const ref = stripMd(cells[0] ?? "");
    const action = cells[actionIdx] ?? "";
    if (!REF.test(ref) || !action.trim()) continue;
    out.push({ ref, action, all: cells.join(" | "), owner: ownerIdx >= 0 ? stripMd(cells[ownerIdx] ?? "") : undefined, closedSection: false, section });
  }
  return out;
}

// ---------- parser ----------

export function parsePending(md: string): PendingItem[] {
  const lines = md.replace(/^﻿/, "").split(/\r?\n/).map((l) => (l.length > MAX_LINE ? l.slice(0, MAX_LINE) : l));
  const fenced = fenceMask(lines);
  const headings = new Map(scanHeadings(lines).map((h) => [h.line, h]));
  const items: PendingItem[] = [];
  const seen = new Set<string>();
  const add = (raw: Raw) => {
    const it = toItem(raw);
    if (!seen.has(it.ref)) { seen.add(it.ref); items.push(it); }
  };

  let section = "";
  for (let i = frontmatterEnd(lines); i < lines.length;) {
    if (fenced[i]) { i++; continue; }
    const h = headings.get(i);
    if (h) { section = h.text; i = h.end + 1; continue; }
    const line = lines[i]!;

    if (line.trimStart().startsWith("|")) {
      let j = i;
      while (j < lines.length && !fenced[j] && lines[j]!.trimStart().startsWith("|")) j++;
      for (const raw of tableItems(lines.slice(i, j), section)) add(raw);
      i = j;
      continue;
    }

    if (BULLET.test(line)) {
      let j = i + 1;
      while (j < lines.length && !fenced[j] && !headings.has(j) && lines[j]!.trim() !== "" && !BULLET.test(lines[j]!) && !lines[j]!.trimStart().startsWith("|")) j++;
      const text = [line.replace(/^ {0,1}[-*+]\s+/, ""), ...lines.slice(i + 1, j).map((l) => l.trim())].join(" ").replace(/\s+/g, " ").trim();
      i = j;
      const closed = CLOSED_SECTION.test(section);
      const wanted = leadingStrike(text) !== undefined || OWNER_MARK.test(text) || closed || OPEN_SECTION.test(section);
      if (!wanted) continue;
      const action = text.slice(0, MAX_TEXT);
      const strike = leadingStrike(action);
      const title = buildTitle(action, strike);
      if (!title) continue;
      const norm = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
      add({ ref: `b-${sha256(norm).slice(0, 8)}`, action, all: text, closedSection: closed, section });
      continue;
    }
    i++;
  }
  return items;
}

// ---------- graph mapping ----------

export interface MapCtx { docId: string; asOf: string }

function ownerNode(owner: string, ctx: MapCtx): NodeInput {
  if (owner === "founder") return founderNode();
  return {
    type: "Agent", id: entityId("Agent", owner), name: owner === "agent" ? "Any agent" : owner,
    summary: owner === "agent" ? "Placeholder owner in PENDING.md: any agent may pick the item up." : undefined,
    src: ctx.docId, asOf: ctx.asOf,
  };
}

export function pendingToWrite(items: PendingItem[], ctx: MapCtx): GraphWrite {
  const nodes = new Map<string, NodeInput>();
  const edges: EdgeInput[] = [];
  for (const it of items) {
    const taskId = entityId("Task", `pending ${it.ref}`);
    const props: NodeInput["props"] = { kind: "pending", status: it.done ? "done" : "open", title: it.title, ref: it.ref, owner: it.owner, section: it.section };
    if (it.doneAt) props.doneAt = it.doneAt;
    if (it.issues.length) props.issues = it.issues;
    nodes.set(taskId, { type: "Task", id: taskId, name: it.title, props, src: ctx.docId, asOf: ctx.asOf });

    const owner = ownerNode(it.owner, ctx);
    nodes.set(owner.id, owner);
    // No `functional` flag: the schema already says "a task has one current owner" (OWNS into a Task). `functional: true`
    // would mean "the owner has one current task" and close the owner's other tasks.
    edges.push({ from: owner.id, type: "OWNS", to: taskId, src: ctx.docId, asOf: ctx.asOf });
    edges.push({ from: taskId, type: "SOURCED_FROM", to: ctx.docId, src: ctx.docId, asOf: ctx.asOf });
  }
  return { nodes: [...nodes.values()], edges, observations: [] };
}
