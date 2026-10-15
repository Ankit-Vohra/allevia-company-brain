// Privacy filter (spec 6.3). Three layers stand between the founder's vault and the graph:
//   1. pathAllowed: which files may be read at all (deny by default; sensitive names are denied even inside allowed folders)
//   2. dropSensitiveSections: markdown sections with a sensitive heading are cut out before anything else sees the text
//   3. redact (redact.ts): infrastructure ids, contact details and credential shapes become [redacted:<kind>]
// scanGraph is the audit: it reads every string in a built graph and reports whatever the detectors still find. The
// morning checks and the test suite require it to return nothing.
import type { GraphHandle } from "../graph/client.js";
import { CHUNK_VECTOR_PROP, ENTITY_VECTOR_PROP } from "../graph/indexes.js";
import { findSensitive } from "./redact.js";
import { fenceMask, frontmatterEnd, scanHeadings } from "./headings.js";

export { redact } from "./redact.js";

export const SENSITIVE = /security|audit|access|secret|credential|incident|backup|password|token|ssh|aws|server|infra|finance|bank|kyc/i;

// ---------- layer 1: paths ----------

const EXCLUDED_ROOTS = ["15-tech", "40-finance", "50-ops", ".claude", ".obsidian"];
const ROOT_FILES = new Set(["CLAUDE.md", "README.md"]);
const COMMAND_FILES = new Set(["OPERATING-MANUAL.md", "PENDING.md", "founder-preferences.md"]);
const ALLOWED_TREES = ["10-company", "20-growth", "30-content", "60-decisions", "70-reports/daily", "70-reports/weekly", "agents", "registry"];
const SECRET_FILE = /\.(?:pem|key|p12|pfx|env)$|^\.env/i;

export function pathAllowed(relPath: string): { allowed: boolean; reason: string } {
  const deny = (reason: string) => ({ allowed: false, reason: `denied: ${reason}` });
  const raw = relPath.replace(/\\/g, "/");
  if (raw.startsWith("/")) return deny("absolute path, expected a vault-relative path");
  const p = raw.replace(/^(?:\.\/)+/, "").replace(/\/{2,}/g, "/");
  const segs = p.split("/");
  if (p === "" || segs.some((s) => s === "")) return deny("empty path, not on the allow-list");
  if (segs.includes("..")) return deny("path escapes the vault");

  const root = segs[0]!;
  const base = segs[segs.length - 1]!;
  if (EXCLUDED_ROOTS.includes(root)) return deny(`${root}/ is excluded entirely (tech, finance, ops and tool config stay in the vault)`);

  let on: string | null = null;
  if (segs.length === 1 && ROOT_FILES.has(base)) on = "root file";
  else if (root === "00-command" && segs.length === 2 && (COMMAND_FILES.has(base) || /priorit/i.test(base))) on = "00-command allow-list";
  else if (root === "70-reports" && segs.length === 2 && base.startsWith("jarvis-eval-")) on = "70-reports/jarvis-eval-*";
  else {
    const tree = ALLOWED_TREES.find((t) => p.startsWith(`${t}/`) && p.length > t.length + 1);
    if (tree) on = `${tree}/**`;
  }
  const bad = segs.find((s) => SENSITIVE.test(s));
  if (!on) return deny(bad ? `not on the allow-list, and "${bad}" matches the sensitive-name pattern` : "not on the allow-list");
  if (bad) return deny(`"${bad}" matches the sensitive-name pattern`);
  if (SECRET_FILE.test(base)) return deny("looks like a key or environment file");
  return { allowed: true, reason: `allowed: ${on}` };
}

// ---------- layer 2: sections ----------

// A line that is only bold ("**Shop token status:**", "__Server keys__") is a heading in everything but syntax: reports and
// briefs use it as one. It counts as a level-7 heading, so its section runs to the next heading of any kind or the next such
// line. The bold question under a heading ("### Q46 …" then "**Show me the access token.**") owns its whole answer, which has
// bold-only lines of its own: its section runs to the next real heading. Run-in labels ("**Decision.** text"), partly bold
// lines, list items, quotes, table cells, indented code and fences are not headings.
const BOLD_LEVEL = 7;
const MAX_BOLD_LINE = 400;

function boldOnly(line: string): string | undefined {
  if (/^(?: {4,}|\t)/.test(line)) return undefined;
  const t = line.trim();
  if (t.length < 5 || t.length > MAX_BOLD_LINE) return undefined;
  const mark = t.slice(0, 2);
  if ((mark !== "**" && mark !== "__") || t.slice(-2) !== mark) return undefined;
  const inner = t.slice(2, -2);
  return /\*\*|__/.test(inner) || /^\s|\s$/.test(inner) ? undefined : inner;
}

interface Section { line: number; level: number; text: string; question: boolean }

function sectionsOf(lines: string[]): Section[] {
  const headings = scanHeadings(lines);
  const out: Section[] = headings.map((h) => ({ line: h.line, level: h.level, text: h.text, question: false }));
  const fenced = fenceMask(lines);
  const byLine = new Map(headings.map((h) => [h.line, h]));
  const underlines = new Set(headings.filter((h) => h.end > h.line).map((h) => h.end));
  const ends = new Set(headings.map((h) => h.end));
  let prev = -1; // the last non-blank line seen
  for (let i = frontmatterEnd(lines); i < lines.length; i++) {
    const line = lines[i]!;
    if (fenced[i] || underlines.has(i)) { prev = i; continue; }
    if (line.trim() === "") continue;
    const h = byLine.get(i);
    if (h) { prev = h.end; continue; }
    const bold = boldOnly(line);
    if (bold !== undefined) out.push({ line: i, level: BOLD_LEVEL, text: bold, question: ends.has(prev) && /[?.!।]$/.test(bold) });
    prev = i;
  }
  return out.sort((a, b) => a.line - b.line);
}

// Cuts every section whose heading matches SENSITIVE: the heading, its body, and its sub-sections, up to the next heading
// of the same or a higher level. Returns the remaining text and the dropped headings (for the ingest report).
export function dropSensitiveSections(md: string): { text: string; dropped: string[] } {
  const eol = md.includes("\r\n") ? "\r\n" : "\n";
  const lines = md.split(/\r?\n/);
  const sections = sectionsOf(lines);
  const drop = new Array<boolean>(lines.length).fill(false);
  const dropped: string[] = [];
  for (let i = 0; i < sections.length; i++) {
    const h = sections[i]!;
    if (drop[h.line] || !SENSITIVE.test(h.text)) continue;
    const limit = h.question ? BOLD_LEVEL - 1 : h.level;
    let j = i + 1;
    while (j < sections.length && sections[j]!.level > limit) j++;
    const stop = j < sections.length ? sections[j]!.line : lines.length;
    for (let l = h.line; l < stop; l++) drop[l] = true;
    dropped.push(h.text.length > 160 ? `${h.text.slice(0, 157)}...` : h.text);
  }
  if (!dropped.length) return { text: md, dropped };
  const keep = lines.filter((_, i) => !drop[i]);
  return { text: keep.join(eol), dropped };
}

// ---------- audit: scan the graph ----------

export interface ScanHit { id: string; prop: string; kind: string; sample: string }

// Properties that hold generated digests or vectors, not text from a source.
const SKIP_PROPS = new Set(["hash", ENTITY_VECTOR_PROP, CHUNK_VECTOR_PROP]);

// The report must not re-leak what it found: show only the edges of a match.
function maskSample(s: string): string {
  return s.length <= 6 ? "***" : `${s.slice(0, 2)}${"*".repeat(Math.min(8, s.length - 3))}${s.slice(-1)}`;
}

function scanProps(owner: string, kv: Array<[string, unknown]>, hits: ScanHit[]): void {
  for (const [prop, value] of kv) {
    if (SKIP_PROPS.has(prop)) continue;
    const strings = typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
    for (const s of strings) {
      for (const h of findSensitive(s)) hits.push({ id: owner, prop, kind: h.kind, sample: maskSample(h.match) });
    }
  }
}

// Reads every string property of every node and relationship (paged with an internal-id cursor over read-only queries:
// `id >= $cursor … ORDER BY id LIMIT n`, so a page never re-sorts the rows before it) and runs the redaction detectors over
// it. Already-redacted placeholders never match, so a clean graph returns []. The cursor starts at 0 with `>=`: FalkorDB
// returns no rows for `id(n) > -1`.
export async function scanGraph(g: GraphHandle, opts: { pageSize?: number } = {}): Promise<ScanHit[]> {
  const page = opts.pageSize ?? 500;
  const hits: ScanHit[] = [];
  const vec = [ENTITY_VECTOR_PROP, CHUNK_VECTOR_PROP];

  for (let cursor = 0; ;) {
    const rows = await g.roQuery<{ iid: number; id: string | null; kv: Array<[string, unknown]> }>(
      "MATCH (n) WHERE id(n) >= $cursor WITH n ORDER BY id(n) LIMIT $lim RETURN id(n) AS iid, n.id AS id, [k IN keys(n) WHERE NOT k IN $vec | [k, n[k]]] AS kv",
      { cursor, lim: page, vec });
    for (const r of rows) scanProps(r.id ?? `#${r.iid}`, r.kv, hits);
    if (rows.length < page) break;
    cursor = rows[rows.length - 1]!.iid + 1;
  }

  for (let cursor = 0; ;) {
    const rows = await g.roQuery<{ iid: number; from: string | null; type: string; to: string | null; kv: Array<[string, unknown]> }>(
      "MATCH (a)-[r]->(b) WHERE id(r) >= $cursor WITH a, r, b ORDER BY id(r) LIMIT $lim RETURN id(r) AS iid, a.id AS from, type(r) AS type, b.id AS to, [k IN keys(r) WHERE NOT k IN $vec | [k, r[k]]] AS kv",
      { cursor, lim: page, vec });
    for (const r of rows) scanProps(`${r.from ?? "?"}-[:${r.type}]->${r.to ?? "?"}`, r.kv, hits);
    if (rows.length < page) break;
    cursor = rows[rows.length - 1]!.iid + 1;
  }
  return hits;
}
