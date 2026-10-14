// ADR parser and graph mapper (spec 6.2): one file in 60-decisions/ is one Decision. Two house styles are read:
//   bold run-in:   `# 001 — Title` / `**Date** 2026-10-09 · **Status** accepted · **Decided by** founder` /
//                  `**Context.** …` `**Decision.** …` `**Consequences.** …`
//   heading style: optional front matter (status, date, decided_by, supersedes), `# ADR-006: Title`, `## Context` …
// Records with no labelled sections (a table, a paragraph) use their whole body as the decision. Other bold run-in
// blocks ("**Not in scope.**", "**Open questions.**") are not part of the three canonical sections and are left out.
import type { EdgeInput, NodeInput } from "../../graph/upsert.js";
import type { GraphWrite } from "../types.js";
import { entityId } from "../../util/ids.js";
import { parseMarkdown, splitParagraphs } from "../markdown.js";
import { redact } from "../redact.js";
import { FOUNDER_ID, founderNode } from "../actors.js";

export interface Adr {
  number: string;          // "008" ("" when neither the heading nor the file name has one)
  title: string;
  status: string;          // lower-case keyword: accepted, proposed, superseded, ... ("unknown" when absent)
  date?: string;           // YYYY-MM-DD
  decidedBy?: string;      // as written, e.g. "founder"
  context: string;
  decision: string;
  consequences: string;
  supersedes?: string[];   // ADR numbers this one replaces
}

export const isAdrPath = (path: string): boolean => /(?:^|\/)\d{1,4}-[^/]+\.md$/i.test(path);

const META_LABELS = new Set([
  "date", "status", "source", "decided by", "decision makers", "decision maker", "deciders", "supersedes", "superseded by",
  "author", "owner", "tags", "related",
]);
const STATUS_WORDS = /^(accepted|proposed|rejected|deprecated|superseded|draft|approved|settled|withdrawn)\b/i;
const MAX = 20_000; // bound on any one field: hostile input cannot make the regexes below expensive

const pad = (n: string | number): string => String(n).padStart(3, "0");

function unwrap(s: string): string {
  return s.split(/\n{2,}/)
    .map((p) => p.replace(/\n(?!\s*(?:[-*+]\s|\d+[.)]\s|\||#|>|`{3}))/g, " ").replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
}

const clean = (s: string): string => redact(s).text;

// ---------- header ----------

function readHeading(path: string, heading: string, fmNumber: unknown): { number: string; title: string } {
  const h = heading.replace(/[*`]/g, "").trim();
  let m = /^ADR[-\s_#]*(\d{1,4})\b\s*[—–:.-]?\s*(.*)$/i.exec(h);
  if (!m) m = /^#?(\d{1,3})\s*[—–:.-]\s*(.*)$/.exec(h);
  const fromFile = /^(\d{1,4})-/.exec(path.split("/").pop() ?? "")?.[1]; // the file name only: "60-decisions/" is not a number
  const fm = typeof fmNumber === "number" || typeof fmNumber === "string" ? /\d{1,4}/.exec(String(fmNumber))?.[0] : undefined;
  const num = m?.[1] ?? fm ?? fromFile;
  return { number: num ? pad(num) : "", title: (m ? m[2]! : h).trim() };
}

function metaFields(paragraph: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!paragraph || !/^\*\*[^*]+\*\*/.test(paragraph)) return out;
  const flat = paragraph.replace(/\s*\n\s*/g, " ").slice(0, MAX);
  const parts = flat.split(/\s+·\s+(?=\*\*)/);
  for (const part of parts) {
    const m = /^\*\*([^*]{1,40}?)\*\*[:.]?\s*(.*)$/s.exec(part.trim());
    if (m) out.set(m[1]!.toLowerCase().replace(/[:.]+$/, "").trim(), m[2]!.trim());
  }
  return META_LABELS.has([...out.keys()][0] ?? "") ? out : new Map();
}

function normStatus(raw: string | undefined): string {
  if (!raw) return "unknown";
  const t = raw.trim();
  const known = STATUS_WORDS.exec(t);
  if (known) return known[1]!.toLowerCase();
  return t.split(/[,;(]/)[0]!.trim().toLowerCase().slice(0, 40) || "unknown";
}

const isoDate = (v: unknown): string | undefined => {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  return typeof v === "string" ? /\d{4}-\d{2}-\d{2}/.exec(v)?.[0] : undefined;
};

function adrNumbers(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\bADR[-\s_#]*(\d{1,3})\b|(?<![\d.-])(\d{3})(?![\d.]|\d)/gi)) out.push(pad(m[1] ?? m[2]!));
  return out;
}

// ---------- body ----------

const CANON: Record<string, "context" | "decision" | "consequences"> = {
  context: "context", background: "context", decision: "decision", consequences: "consequences", consequence: "consequences",
};

function runInSections(paras: string[]): { sections: Partial<Record<"context" | "decision" | "consequences", string>>; loose: string[] } {
  const sections: Partial<Record<"context" | "decision" | "consequences", string>> = {};
  const loose: string[] = [];
  let current: "context" | "decision" | "consequences" | "other" | null = null;
  for (const p of paras) {
    const m = /^\*\*([^*]{1,60}?)\.?\*\*\.?\s*/s.exec(p);
    if (m) {
      const key = CANON[m[1]!.toLowerCase().replace(/[:.]+$/, "").trim()];
      current = key && !(key in sections) ? key : "other";
      if (current !== "other") sections[current] = p.slice(m[0].length);
    } else if (current === null) loose.push(p);
    else if (current !== "other") sections[current] += `\n\n${p}`;
  }
  return { sections, loose };
}

export function parseAdr(path: string, md: string): Adr {
  const pm = parseMarkdown(path, md.slice(0, 500_000));
  const fm = pm.frontmatter;
  const h1 = pm.sections.find((s) => s.level === 1);
  const { number, title } = readHeading(path, h1?.heading ?? "", fm.number ?? fm.adr);

  const body = h1 ? h1.text : pm.sections.filter((s) => s.level === 0).map((s) => s.text).join("\n\n");
  let paras = splitParagraphs(body);
  const meta = metaFields(paras[0]);
  if (meta.size) paras = paras.slice(1);

  const headed = Object.fromEntries(
    pm.sections.filter((s) => s.level >= 2 && CANON[s.heading.toLowerCase()]).map((s) => [CANON[s.heading.toLowerCase()]!, s.text]));
  const { sections, loose } = runInSections(paras);
  const text = { ...sections, ...headed };

  const statusRaw = meta.get("status") ?? (typeof fm.status === "string" ? fm.status : undefined);
  const dateRaw = meta.get("date") ?? fm.date;
  let decidedBy = meta.get("decided by") ?? meta.get("deciders") ?? meta.get("decision makers") ?? meta.get("decision maker")
    ?? (typeof (fm.decided_by ?? fm["decided-by"] ?? fm.deciders) === "string" ? String(fm.decided_by ?? fm["decided-by"] ?? fm.deciders) : undefined);
  const source = meta.get("source");
  if (!decidedBy && source && /^founder\b/i.test(source)) decidedBy = "founder";
  decidedBy = decidedBy?.split(/[(:"“]/)[0]!.trim().slice(0, 80) || undefined;

  const decision = unwrap(text.decision ?? loose.join("\n\n"));
  const supersedes = new Set<string>();
  const fmSup = fm.supersedes;
  for (const v of Array.isArray(fmSup) ? fmSup : fmSup === undefined ? [] : [fmSup]) {
    if (typeof v === "number") supersedes.add(pad(v));
    else if (typeof v === "string") (/^\d{1,3}$/.test(v.trim()) ? [pad(v.trim())] : adrNumbers(v)).forEach((n) => supersedes.add(n));
  }
  adrNumbers(meta.get("supersedes") ?? "").forEach((n) => supersedes.add(n));
  for (const m of decision.slice(0, MAX).matchAll(/\bsupersedes\s+(?:ADRs?[-\s_#]*)?(\d{3})\b/gi)) supersedes.add(m[1]!);
  supersedes.delete(number);

  const adr: Adr = {
    number,
    title: clean(title),
    status: normStatus(statusRaw),
    context: clean(unwrap(text.context ?? "")),
    decision: clean(decision),
    consequences: clean(unwrap(text.consequences ?? "")),
  };
  const date = isoDate(dateRaw);
  if (date) adr.date = date;
  if (decidedBy) adr.decidedBy = clean(decidedBy);
  if (supersedes.size) adr.supersedes = [...supersedes];
  return adr;
}

// ---------- graph mapping ----------

export interface AdrCtx {
  docId: string;
  asOf: string;
  // ADR number -> Decision id, for SUPERSEDES edges. Build it over all parsed ADRs (adrIdIndex); without it, or for an
  // unknown number, no SUPERSEDES edge is written (an edge needs both endpoints).
  adrIds?: ReadonlyMap<string, string>;
}

export const adrDecisionId = (a: Pick<Adr, "number" | "title">): string => entityId("Decision", [a.number, a.title].filter(Boolean).join(" "));

export function adrIdIndex(adrs: Adr[]): Map<string, string> {
  return new Map(adrs.filter((a) => a.number).map((a) => [a.number, adrDecisionId(a)]));
}

export function adrToWrite(a: Adr, ctx: AdrCtx): GraphWrite {
  const id = adrDecisionId(a);
  const props: NodeInput["props"] = { status: a.status, title: a.title };
  if (a.number) props.number = a.number;
  if (a.date) props.decidedAt = a.date;
  const nodes: NodeInput[] = [{
    type: "Decision", id, name: a.number ? `ADR ${a.number}: ${a.title}` : a.title,
    summary: (a.decision || a.context).slice(0, 500) || undefined,
    props, src: ctx.docId, asOf: ctx.asOf,
  }];
  const edges: EdgeInput[] = [];
  const since = a.date ? Date.parse(a.date) : NaN;
  const when = Number.isFinite(since) ? { since } : {};

  if (a.decidedBy && /\bfounder\b/i.test(a.decidedBy)) {
    nodes.push(founderNode());
    edges.push({ from: FOUNDER_ID, type: "DECIDED", to: id, ...when, props: a.date ? { at: a.date } : undefined, src: ctx.docId, asOf: ctx.asOf });
  }
  for (const n of a.supersedes ?? []) {
    const old = ctx.adrIds?.get(n);
    if (old && old !== id) edges.push({ from: id, type: "SUPERSEDES", to: old, ...when, src: ctx.docId, asOf: ctx.asOf });
  }
  edges.push({ from: id, type: "SOURCED_FROM", to: ctx.docId, src: ctx.docId, asOf: ctx.asOf });
  return { nodes, edges, observations: [] };
}
