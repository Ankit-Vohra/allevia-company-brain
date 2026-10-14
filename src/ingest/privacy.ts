// Privacy filter (spec 6.3). Three layers stand between the founder's vault and the graph:
//   1. pathAllowed: which files may be read at all (deny by default; sensitive names are denied even inside allowed folders)
//   2. dropSensitiveSections: markdown sections with a sensitive heading are cut out before anything else sees the text
//   3. redact (redact.ts): infrastructure ids, contact details and credential shapes become [redacted:<kind>]
// scanGraph is the audit: it reads every string in a built graph and reports whatever the detectors still find. The
// morning checks and the test suite require it to return nothing.
import type { GraphHandle } from "../graph/client.js";
import { CHUNK_VECTOR_PROP, ENTITY_VECTOR_PROP } from "../graph/indexes.js";
import { findSensitive } from "./redact.js";
import { scanHeadings } from "./headings.js";

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

// Cuts every section whose heading matches SENSITIVE: the heading, its body, and its sub-sections, up to the next heading
// of the same or a higher level. Returns the remaining text and the dropped headings (for the ingest report).
export function dropSensitiveSections(md: string): { text: string; dropped: string[] } {
  const eol = md.includes("\r\n") ? "\r\n" : "\n";
  const lines = md.split(/\r?\n/);
  const headings = scanHeadings(lines);
  const drop = new Array<boolean>(lines.length).fill(false);
  const dropped: string[] = [];
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i]!;
    if (drop[h.line] || !SENSITIVE.test(h.text)) continue;
    const next = headings.slice(i + 1).find((x) => x.level <= h.level);
    const stop = next ? next.line : lines.length;
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

// Reads every string property of every node and relationship (paged with SKIP/LIMIT over read-only queries) and runs
// the redaction detectors over it. Already-redacted placeholders never match, so a clean graph returns [].
export async function scanGraph(g: GraphHandle, opts: { pageSize?: number } = {}): Promise<ScanHit[]> {
  const page = opts.pageSize ?? 500;
  const hits: ScanHit[] = [];
  const vec = [ENTITY_VECTOR_PROP, CHUNK_VECTOR_PROP];

  for (let off = 0; ; off += page) {
    const rows = await g.roQuery<{ iid: number; id: string | null; kv: Array<[string, unknown]> }>(
      "MATCH (n) WITH n ORDER BY id(n) SKIP $off LIMIT $lim RETURN id(n) AS iid, n.id AS id, [k IN keys(n) WHERE NOT k IN $vec | [k, n[k]]] AS kv",
      { off, lim: page, vec });
    for (const r of rows) scanProps(r.id ?? `#${r.iid}`, r.kv, hits);
    if (rows.length < page) break;
  }

  for (let off = 0; ; off += page) {
    const rows = await g.roQuery<{ iid: number; from: string | null; type: string; to: string | null; kv: Array<[string, unknown]> }>(
      "MATCH (a)-[r]->(b) WITH a, r, b ORDER BY id(r) SKIP $off LIMIT $lim RETURN id(r) AS iid, a.id AS from, type(r) AS type, b.id AS to, [k IN keys(r) WHERE NOT k IN $vec | [k, r[k]]] AS kv",
      { off, lim: page, vec });
    for (const r of rows) scanProps(`${r.from ?? "?"}-[:${r.type}]->${r.to ?? "?"}`, r.kv, hits);
    if (rows.length < page) break;
  }
  return hits;
}
