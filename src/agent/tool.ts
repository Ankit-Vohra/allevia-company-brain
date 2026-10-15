// The tool contract. A tool is defined once (name, description, zod input, run) and bound to a request through
// ToolContext, so the same tool serves the Agent SDK runtime, the MCP server and tests. Every tool returns a
// ToolResult and records it in ctx.touched: that set is what the citation and number checks (spec §7.4) verify against,
// and what the UI lights up.
import type { z } from "zod";
import type { GraphHandle } from "../graph/client.js";
import type { EdgeRef, NodeRef, SourceRef, ToolResult } from "../../shared/contracts.js";

export interface ToolContext {
  graph: GraphHandle;
  tenant: string;
  turnId: string;
  agentId: string;          // roster id of the agent calling the tool
  asker: string;            // entity id of the person asking (e.g. person:founder)
  touched: TouchedSet;
  now: number;              // epoch ms, fixed per turn (tests pin it)
  embedQuery?: (text: string) => Promise<number[]>; // injected; vector search is skipped when absent
  readOnly?: boolean;       // MCP/public mode: write tools refuse
  signal?: AbortSignal;     // aborted when the agent's run is stopped (timeout, turn stopped): a write tool checks it
                            // right before it commits, so a run that was stopped mid-call changes nothing
}

export interface AlleviaTool<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  input: S;
  writes?: boolean;         // remember / propose_action
  run(args: z.infer<z.ZodObject<S>>, ctx: ToolContext): Promise<ToolResult>;
}

// Everything the agents saw during one turn: nodes, edges, sources, and every number that appeared in tool data.
export class TouchedSet {
  private nodeMap = new Map<string, NodeRef>();
  private edgeMap = new Map<string, EdgeRef>();
  private sourceMap = new Map<string, SourceRef>();
  private numberSet = new Set<string>();

  add(r: ToolResult): void {
    for (const n of r.nodes) this.nodeMap.set(n.id, n);
    for (const e of r.edges) this.edgeMap.set(`${e.from}|${e.type}|${e.to}`, e);
    for (const s of r.sources) { this.sourceMap.set(s.id, s); }
    collectNumbers(r.data, this.numberSet);
    if (r.note) collectNumbers(r.note, this.numberSet);
  }
  has(id: string): boolean { return this.nodeMap.has(id) || this.sourceMap.has(id); }
  nodes(): NodeRef[] { return [...this.nodeMap.values()]; }
  edges(): EdgeRef[] { return [...this.edgeMap.values()]; }
  sources(): SourceRef[] { return [...this.sourceMap.values()]; }
  numbers(): ReadonlySet<string> { return this.numberSet; }
  anySimulated(): boolean { return this.nodes().some((n) => n.simulated === true); }
  // The latest asOf by instant ("2026-10-14T23:00-05:00" is after "2026-10-15"); unparseable ones only as a fallback.
  newestAsOf(): string | undefined {
    const dates = [...this.nodes().map((n) => n.asOf), ...this.sources().map((s) => s.asOf)].filter((d): d is string => !!d);
    const at = (d: string): number => { const ms = Date.parse(d); return Number.isFinite(ms) ? ms : -Infinity; };
    return dates.reduce<string | undefined>((best, d) => (best === undefined || at(d) > at(best) || (at(d) === at(best) && d > best) ? d : best), undefined);
  }
}

// Numbers are normalised (no thousands separators, no trailing zeros) so "1,234" in data matches "1234" in an answer.
export function normaliseNumber(raw: string): string {
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : raw;
}

// Dates and times in tool data are not numbers: "2026-10-12" must not ground "12" (or 2026, or -10).
const DATE_LIKE = /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?|\d{4}[/.]\d{1,2}[/.]\d{1,2}|\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b|\b\d{1,2}:\d{2}(?::\d{2})?\b|\b\d{4}-?W\d{1,2}\b/g;
// A minus sign only where no digit or letter comes before it: "10-12" is two numbers, "abc-3" is 3.
const NUMERAL = /(?:(?<![\p{L}\p{N}])-)?\d[\d,]*(?:\.\d+)?/gu;

function collectNumbers(v: unknown, out: Set<string>): void {
  if (v === null || v === undefined) return;
  if (typeof v === "number") { if (Number.isFinite(v)) { out.add(normaliseNumber(String(v))); out.add(normaliseNumber(v.toFixed(1))); out.add(normaliseNumber(v.toFixed(0))); } return; }
  if (typeof v === "string") { for (const m of v.replace(DATE_LIKE, " ").matchAll(NUMERAL)) out.add(normaliseNumber(m[0])); return; }
  if (Array.isArray(v)) { for (const x of v) collectNumbers(x, out); return; }
  if (typeof v === "object") for (const x of Object.values(v as Record<string, unknown>)) collectNumbers(x, out);
}
