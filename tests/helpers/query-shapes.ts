// The query shapes the product sends, recorded while the test suite runs, and the plan check run on them at the end
// (tests/setup/query-shapes.ts records, tests/setup/query-shapes.global.ts checks). A shape is the text of a Cypher
// statement; its parameters do not change the plan (GRAPH.EXPLAIN takes `$name` unbound). Only statements sent from
// code under src/ count: a test that reads the graph with a query of its own is not the product's.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { normalizeCypher, planScans, scansDespiteIdAnchor } from "./plan-lint.js";

export const SHAPES_ENV = "ALLEVIA_SHAPES_DIR";

// ---- recording (in each test worker) ----------------------------------------------------------------------------------

// The first frame of the stack that is not the GraphHandle itself: where the statement was sent from.
export function senderFile(stack: string | undefined): string | undefined {
  for (const line of (stack ?? "").split("\n").slice(1)) {
    const m = /\(?((?:file:\/\/)?\/[^():]+\.[cm]?[jt]sx?)(?::\d+:\d+)?\)?\s*$/.exec(line);
    if (!m) continue;
    const file = m[1]!;
    if (file.endsWith("/src/graph/client.ts") || file.endsWith("/tests/helpers/query-shapes.ts") || file.includes("/node_modules/") || file.startsWith("node:")) continue;
    return file;
  }
  return undefined;
}

// For a report: the statement helper `ro` in src/agent/tools/common.ts sends every agent read, so name its caller instead.
export function callerFile(stack: string | undefined): string | undefined {
  const frames: string[] = [];
  for (const line of (stack ?? "").split("\n").slice(1)) {
    const m = /\(?((?:file:\/\/)?\/[^():]+\.[cm]?[jt]sx?)(?::\d+:\d+)?\)?\s*$/.exec(line);
    if (m && !/\/src\/graph\/client\.ts$|\/tests\/helpers\/query-shapes\.ts$|\/node_modules\//.test(m[1]!)) frames.push(m[1]!);
  }
  return frames.find((f) => isProductFile(f) && !f.endsWith("/src/agent/tools/common.ts")) ?? frames[0];
}

export const isProductFile = (file: string | undefined): boolean => !!file && /\/src\/[^/]/.test(file) && !/\/tests\//.test(file);

export function shapeRecorder(dir: string): (cypher: string) => void {
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `${process.pid}.jsonl`);
  const seen = new Set<string>();
  return (cypher) => {
    const q = normalizeCypher(cypher);
    if (seen.has(q)) return;
    // not marked seen until it came from src/: the same text may be sent by a test first and by the product later
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 30; // the sender can be several helpers up
    const stack = new Error().stack;
    Error.stackTraceLimit = limit;
    const file = senderFile(stack);
    if (!isProductFile(file)) return;
    seen.add(q);
    appendFileSync(out, `${JSON.stringify({ q, file: callerFile(stack)!.replace(/^.*\/(src\/)/, "$1") })}\n`);
  };
}

// ---- checking (once, after the run) -----------------------------------------------------------------------------------

export function readShapes(dir: string): Array<{ q: string; file: string }> {
  if (!existsSync(dir)) return [];
  const byText = new Map<string, { q: string; file: string }>();
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort()) {
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (!line) continue;
      const r = JSON.parse(line) as { q: string; file: string };
      if (!byText.has(r.q)) byText.set(r.q, r);
    }
  }
  return [...byText.values()].sort((a, b) => a.q.localeCompare(b.q));
}

// Statements EXPLAIN does not plan like a query (DDL, procedures that are not part of a read).
export const notPlanned = (q: string): boolean =>
  /^(CREATE|DROP)\s+(VECTOR |FULLTEXT )?INDEX/i.test(q) || /^CALL\s+db\.(indexes|constraints|labels|propertyKeys|relationshipTypes)\b/i.test(q);

// Shapes that look a node up by id and scan anyway, on purpose. Each says why; the test fails if one stops matching.
export interface IntentionalScan { shape?: RegExp; file?: RegExp; why: string }

export interface ShapeReport { checked: number; unplannable: number; violations: Array<{ q: string; file: string; scans: string[] }> }

export async function checkShapes(
  explain: (q: string) => Promise<string[]>, shapes: Array<{ q: string; file: string }>, allowed: IntentionalScan[] = [],
): Promise<ShapeReport & { unusedAllowances: IntentionalScan[] }> {
  const report: ShapeReport = { checked: 0, unplannable: 0, violations: [] };
  const used = new Set<IntentionalScan>();
  for (const s of shapes) {
    if (notPlanned(s.q)) continue;
    let plan: string[];
    try {
      plan = await explain(s.q);
    } catch {
      report.unplannable++;
      continue;
    }
    report.checked++;
    const scans = scansDespiteIdAnchor(s.q, plan);
    if (!scans.length) continue;
    const allowance = allowed.find((a) => (a.shape || a.file) && (a.shape?.test(s.q) ?? true) && (a.file?.test(s.file) ?? true));
    if (allowance) { used.add(allowance); continue; }
    report.violations.push({ ...s, scans });
  }
  return { ...report, unusedAllowances: allowed.filter((a) => !used.has(a)) };
}

export { planScans };
