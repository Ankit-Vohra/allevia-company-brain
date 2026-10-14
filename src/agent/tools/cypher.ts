// cypher: the read-only escape hatch for questions no other tool answers. Three guards: the text is rejected if it
// contains a write keyword or an index-changing procedure (string literals, backtick names and comments are blanked
// first, so `WHERE n.name = 'CREATE'` is fine); it runs through GRAPH.RO_QUERY, which the server refuses to execute
// if it would write; and it has a 5 s timeout and a 200-row cap (LIMIT appended when missing, rows sliced anyway).
// Graph objects in the rows become NodeRef/EdgeRef, and string values that are ids of existing entities count as
// returned nodes, so an answer can cite what a query found.
import { z } from "zod";
import type { ToolContext } from "../tool.js";
import { isRawEdge, isRawNode, isRawPath, toNodeRef, toPathResult, type RawEdge, type RawNode } from "../../graph/read.js";
import { typeFromId } from "../../util/ids.js";
import { Collector, InputError, clip, compactProps, defineTool, edgeText, getNodes, ro } from "./common.js";

export const CYPHER_TIMEOUT_MS = 5_000;
export const CYPHER_ROW_CAP = 200;
const WRITE = /(?<![\w.$`])(CREATE|MERGE|SET|DELETE|DETACH|REMOVE|DROP|LOAD|FOREACH)(?![\w`])/i;
const INDEX_PROC = /\bdb\s*\.\s*idx\s*\.[\w.]*?(create|drop)/i;

// Blanks string literals, backtick-quoted names and comments (same length, so positions survive).
export function stripLiterals(q: string): string {
  return q.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[^`]*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length));
}

// Why a query is refused, or null when it may run.
export function writeReason(q: string): string | null {
  const bare = stripLiterals(q);
  const w = WRITE.exec(bare);
  if (w) return `${w[1]!.toUpperCase()} is not allowed: cypher is read-only.`;
  if (INDEX_PROC.test(bare)) return "Index procedures are not allowed: cypher is read-only.";
  return null;
}

// Raw FalkorDB values found anywhere in the rows.
function walk(v: unknown, nodes: RawNode[], edges: RawEdge[]): void {
  if (isRawPath(v)) {
    nodes.push(...v.nodes);
    edges.push(...v.edges);
  } else if (isRawNode(v)) nodes.push(v);
  else if (isRawEdge(v)) edges.push(v);
  else if (Array.isArray(v)) for (const x of v) walk(x, nodes, edges);
  else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x, nodes, edges);
}

async function runCypher(args: { query: string; params?: Record<string, unknown> }, ctx: ToolContext) {
  const base = args.query.trim().replace(/;\s*$/, "");
  if (!base) throw new InputError("query is empty.");
  const reason = writeReason(base);
  if (reason) throw new InputError(reason, { refused: true });
  const hasLimit = /\bLIMIT\b/i.test(stripLiterals(base));
  const exec = async (text: string) => {
    try {
      return await ro(ctx, text, args.params, CYPHER_TIMEOUT_MS);
    } catch (e) {
      const msg = String((e as Error).message);
      if (/timed? ?out/i.test(msg)) throw e;
      throw new InputError(`Query failed: ${msg.slice(0, 300)}`);
    }
  };
  let rows: Array<Record<string, unknown>>;
  try {
    rows = await exec(hasLimit ? base : `${base} LIMIT ${CYPHER_ROW_CAP + 1}`); // one extra row tells us it was capped
  } catch (e) {
    if (hasLimit || !(e instanceof InputError)) throw e;
    rows = await exec(base); // e.g. a bare CALL … YIELD, where LIMIT is not valid
  }
  const truncated = rows.length > CYPHER_ROW_CAP;
  rows = rows.slice(0, CYPHER_ROW_CAP);

  // Internal node ids -> entity ids, from the nodes in the result; edges whose endpoints are not there are looked up.
  const rawNodes: RawNode[] = [];
  const rawEdges: RawEdge[] = [];
  walk(rows, rawNodes, rawEdges);
  const ids = new Map(rawNodes.map((n) => [n.id, toNodeRef(n).id]));
  const missing = [...new Set(rawEdges.flatMap((e) => [e.sourceId, e.destinationId]).filter((i) => !ids.has(i)))];
  if (missing.length) {
    for (const r of await ro<{ i: number; id: string }>(ctx, "MATCH (n) WHERE id(n) IN $ids RETURN id(n) AS i, n.id AS id", { ids: missing.slice(0, 500) })) ids.set(r.i, r.id);
  }
  const col = new Collector();
  const endpoints = (e: RawEdge) => ({ from: ids.get(e.sourceId) ?? `#${e.sourceId}`, to: ids.get(e.destinationId) ?? `#${e.destinationId}` });
  const shape = (v: unknown): unknown => {
    if (isRawPath(v)) {
      const p = toPathResult(v);
      p.nodes.forEach((n) => col.ref(n));
      p.edges.forEach((e) => col.edgeRef(e));
      return { path: p.nodes.map((n) => n.id), steps: p.edges.map(edgeText) };
    }
    if (isRawNode(v)) {
      const ref = toNodeRef(v);
      col.ref(ref);
      return { id: ref.id, type: ref.label, name: ref.name, props: compactProps(Object.entries(v.properties).filter(([k]) => k !== "id" && k !== "name")) };
    }
    if (isRawEdge(v)) {
      const { from, to } = endpoints(v);
      const p = v.properties;
      col.edgeRef({ from, type: v.relationshipType, to, ...(typeof p.since === "number" ? { since: p.since } : {}), until: typeof p.until === "number" ? p.until : null });
      return { from, type: v.relationshipType, to, ...compactProps(Object.entries(p)) };
    }
    if (typeof v === "string") return clip(v);
    if (Array.isArray(v)) return v.length > 50 && v.every((x) => typeof x === "number") ? `[${v.length} numbers]` : v.map(shape);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)]));
    return v;
  };
  const out = rows.map((r) => shape(r));

  // Plain id strings (`RETURN p.id`) of existing entities count as returned nodes, so they can be cited.
  const idLike = new Set<string>();
  const scan = (v: unknown) => {
    if (isRawNode(v) || isRawEdge(v) || isRawPath(v)) return; // already mapped; their props (src…) are not results
    if (typeof v === "string" && typeFromId(v) && !col.nodes.has(v) && idLike.size < 300) idLike.add(v);
    else if (Array.isArray(v)) v.forEach(scan);
    else if (v && typeof v === "object") Object.values(v).forEach(scan);
  };
  rows.forEach(scan);
  for (const n of (await getNodes(ctx, [...idLike])).values()) col.node(n);

  return col.result(ctx, { columns: Object.keys(rows[0] ?? {}), rows: out, rowCount: out.length, truncated },
    truncated ? `Capped at ${CYPHER_ROW_CAP} rows; aggregate or filter in the query.` : out.length ? undefined : "The query returned no rows.");
}

export const cypher = defineTool({
  name: "cypher",
  description:
    "Read-only Cypher on this business's graph, for questions no other tool covers. Nodes have label Entity plus a type label and an id; current edges have until IS NULL. Writes are refused; 5 s timeout; at most 200 rows. Example: {\"query\":\"MATCH (t:Task) WHERE t.status = $s RETURN t.id, t.name\",\"params\":{\"s\":\"open\"}}",
  input: {
    query: z.string().min(1).describe("A read-only Cypher query"),
    params: z.record(z.string(), z.unknown()).optional().describe("Query parameters, referenced as $name"),
  },
  run: runCypher,
});
