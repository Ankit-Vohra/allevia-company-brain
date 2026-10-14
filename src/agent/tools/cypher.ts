// cypher: the read-only escape hatch for questions no other tool answers. Guards, outermost first:
// 1. Text checks, on the query with string literals, backtick names and comments blanked (same length, so
//    `WHERE n.name = 'CREATE'` is fine): no write keyword, LOAD CSV (it reads files even in read-only mode) or FOREACH;
//    CALL only of the read procedures in READ_PROCS (procedure names are compared with backticks and spaces removed,
//    since the server accepts `db.labels` and db . labels); no range() too large to build in memory.
// 2. GRAPH.RO_QUERY: the server itself refuses anything that would write, including write-mode procedures.
// 3. A 5 s server-side timeout.
// 4. Bounded output: the last RETURN of every UNION branch ends in LIMIT <= 201 (appended, or lowered), rows are cut
//    to 200, lists to 50 items, strings to 400 characters, the whole to CYPHER_CHAR_CAP characters, and at most
//    CYPHER_NODE_CAP graph objects become NodeRefs.
// Graph objects in the rows become NodeRef/EdgeRef, string values that are ids of existing entities count as returned
// nodes, and an edge's `src` document counts as a source, so an answer can cite what a query found.
import { z } from "zod";
import type { ToolContext } from "../tool.js";
import type { EdgeRef, NodeRef } from "../../../shared/contracts.js";
import { isRawEdge, isRawNode, isRawPath, toNodeRef, toPathResult, type RawEdge, type RawNode } from "../../graph/read.js";
import { typeFromId } from "../../util/ids.js";
import { Collector, InputError, clip, compactProps, defineTool, edgeText, getNodes, ro } from "./common.js";

export const CYPHER_TIMEOUT_MS = 5_000;
export const CYPHER_ROW_CAP = 200;
export const CYPHER_CHAR_CAP = 24_000;   // JSON size of the rows handed back
export const CYPHER_NODE_CAP = 100;      // graph objects turned into NodeRefs (and so into sources)
const ARRAY_CAP = 50;
const RANGE_CAP = 1_000_000;
const QUERY_MAX = 4_000;

const WRITE = /(?<![\w.$`])(CREATE|MERGE|SET|DELETE|DETACH|REMOVE|DROP|LOAD|FOREACH)(?![\w`])/i;
const WORD = (w: string) => new RegExp(`(?<![\\w.$\`])${w}(?![\\w\`])`, "gi");

// Procedures the escape hatch may CALL: catalogue reads and index lookups. Everything else is refused, including the
// write-mode db.idx.* create/drop and algo.*, which would also walk closed (historical) edges; important, topics,
// find_paths and impact_of run those over current edges.
const READ_PROCS = new Set([
  "db.labels", "db.relationshiptypes", "db.propertykeys", "db.indexes", "db.constraints", "db.meta.stats",
  "db.idx.fulltext.querynodes", "db.idx.fulltext.queryrelationships", "db.idx.vector.querynodes", "db.idx.vector.queryrelationships",
  "dbms.procedures", "dbms.functions",
]);

const LITERALS = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[^`]*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;

// Blanks string literals, comments and (unless keepNames) backtick-quoted names, keeping every offset.
export function stripLiterals(q: string, keepNames = false): string {
  return q.replace(LITERALS, (m) => (keepNames && m.startsWith("`") ? m : " ".repeat(m.length)));
}

const PROC_NAME = /^\s*((?:`[^`]*`|[A-Za-z_$][\w$]*)(?:\s*\.\s*(?:`[^`]*`|[A-Za-z_$][\w$]*))*)/;

// The procedure each CALL names (lowercased, no backticks or spaces); null when a CALL names none. CALL { … }
// subqueries are skipped: their clauses are checked with the rest of the text.
export function procedures(q: string): Array<string | null> {
  const bare = stripLiterals(q);
  const named = stripLiterals(q, true);
  const out: Array<string | null> = [];
  for (const m of bare.matchAll(WORD("CALL"))) {
    const rest = named.slice(m.index + m[0].length);
    if (/^\s*\{/.test(rest)) continue;
    const name = PROC_NAME.exec(rest)?.[1];
    out.push(name ? name.replace(/[`\s]/g, "").toLowerCase() : null);
  }
  return out;
}

// range(a, b[, step]) builds its whole list before any timeout check; literal or $param bounds are checked here.
function rangeReason(bare: string, params: Record<string, unknown>): string | null {
  const arg = String.raw`\s*(-?\d+(?:\.\d+)?(?:e\d+)?|\$\w+)\s*`;
  const re = new RegExp(String.raw`(?<![\w.$\`])range\s*\(${arg},${arg}(?:,${arg})?\)`, "gi");
  const val = (s: string | undefined): number | null => {
    if (s === undefined) return null;
    const v = s.startsWith("$") ? params[s.slice(1)] : Number(s);
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  for (const m of bare.matchAll(re)) {
    const [a, b, step] = [val(m[1]), val(m[2]), m[3] === undefined ? 1 : val(m[3])];
    if (a === null || b === null || step === null || step === 0) continue;
    if (Math.abs(b - a) / Math.abs(step) > RANGE_CAP) return `range() over more than ${RANGE_CAP.toLocaleString("en-US")} values is not allowed.`;
  }
  return null;
}

// Why a query is refused, or null when it may run.
export function writeReason(q: string, params: Record<string, unknown> = {}): string | null {
  const bare = stripLiterals(q);
  const w = WRITE.exec(bare);
  if (w) return `${w[1]!.toUpperCase()} is not allowed: cypher is read-only.`;
  for (const p of procedures(q)) {
    if (p === null) return "CALL must name a procedure, e.g. CALL db.labels() YIELD label.";
    if (p.startsWith("algo.")) return `${p} is not available here: graph algorithms run in important, topics, find_paths and impact_of, over current edges only.`;
    if (!READ_PROCS.has(p)) return `Procedure ${p} is not allowed: cypher may only CALL ${[...READ_PROCS].join(", ")}.`;
  }
  return rangeReason(bare, params);
}

// Brace depth at each offset of a blanked query (map literals are balanced, so only subquery bodies stay open).
function depthAt(bare: string, at: number): number {
  let d = 0;
  for (let i = 0; i < at; i++) d += bare[i] === "{" ? 1 : bare[i] === "}" ? -1 : 0;
  return d;
}

// The server sends at most `cap` rows: the last top-level RETURN of each UNION branch ends in LIMIT <= cap (appended
// on a new line, so a trailing // comment cannot swallow it; a bigger literal is lowered; a $param is clamped). A bare
// CALL … YIELD, where LIMIT is not valid, gets RETURN * LIMIT. Anything else (LIMIT 1+1, CALL without YIELD) is
// left alone and cut client-side.
export function boundRows(q: string, params: Record<string, unknown> | undefined, cap: number): { query: string; params?: Record<string, unknown> } {
  const bare = stripLiterals(q);
  const unions = [...bare.matchAll(WORD("UNION"))].filter((m) => depthAt(bare, m.index) === 0).map((m) => m.index);
  const starts = [0, ...unions.map((u) => u + "UNION".length)];
  const ends = [...unions, bare.length];
  let query = q;
  const p = params ? { ...params } : undefined;
  for (let i = ends.length - 1; i >= 0; i--) {
    const [s, e] = [starts[i]!, ends[i]!];
    const seg = bare.slice(s, e);
    const rets = [...seg.matchAll(WORD("RETURN"))].filter((m) => depthAt(bare, s + m.index) === 0);
    const ret = rets.at(-1);
    const insertAt = (text: string) => { query = query.slice(0, e) + text + query.slice(e); };
    if (!ret) {
      if (!unions.length && WORD("YIELD").test(seg)) insertAt(`\nRETURN * LIMIT ${cap}`);
      continue;
    }
    const tail = seg.slice(ret.index);
    if (!WORD("LIMIT").test(tail)) {
      insertAt(i === ends.length - 1 ? `\nLIMIT ${cap}` : `\nLIMIT ${cap}\n`);
      continue;
    }
    const lim = /(?<![\w.$`])LIMIT\s+(\d+|\$\w+)\s*$/i.exec(tail);
    if (!lim) continue;
    const arg = lim[1]!;
    if (arg.startsWith("$")) {
      const k = arg.slice(1);
      if (p && typeof p[k] === "number" && (p[k] as number) > cap) p[k] = cap;
    } else if (Number(arg) > cap) {
      const at = s + ret.index + lim.index + lim[0].lastIndexOf(arg);
      query = query.slice(0, at) + String(cap) + query.slice(at + arg.length);
    }
  }
  return { query, ...(p ? { params: p } : {}) };
}

// ---------- shaping rows ----------

interface Bag { nodes: NodeRef[]; edges: Array<{ e: EdgeRef; src: unknown }> }

// Raw FalkorDB values in what will be shown (lists cut to ARRAY_CAP, as shape() does).
function walk(v: unknown, nodes: RawNode[], edges: RawEdge[]): void {
  if (isRawPath(v)) {
    nodes.push(...v.nodes.slice(0, ARRAY_CAP + 1));
    edges.push(...v.edges.slice(0, ARRAY_CAP));
  } else if (isRawNode(v)) nodes.push(v);
  else if (isRawEdge(v)) edges.push(v);
  else if (Array.isArray(v)) for (const x of v.slice(0, ARRAY_CAP)) walk(x, nodes, edges);
  else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x, nodes, edges);
}

const more = (n: number) => `…${n} more`;

async function runCypher(args: { query: string; params?: Record<string, unknown> }, ctx: ToolContext) {
  const base = args.query.trim().replace(/;\s*$/, "");
  if (!base) throw new InputError("query is empty.");
  if (base.length > QUERY_MAX) throw new InputError(`query is ${base.length} characters; keep it under ${QUERY_MAX}.`);
  const reason = writeReason(base, args.params);
  if (reason) throw new InputError(reason, { refused: true });
  const bounded = boundRows(base, args.params, CYPHER_ROW_CAP + 1); // one extra row tells us it was capped
  let raw: Array<Record<string, unknown>>;
  try {
    raw = await ro(ctx, bounded.query, bounded.params, CYPHER_TIMEOUT_MS);
  } catch (e) {
    const msg = String((e as Error).message);
    if (/timed? ?out/i.test(msg)) throw e;
    throw new InputError(`Query failed: ${msg.slice(0, 300)}`);
  }
  const overRows = raw.length > CYPHER_ROW_CAP;
  const rows = raw.slice(0, CYPHER_ROW_CAP);

  // Internal node ids -> entity ids, from the nodes in the result; edges whose endpoints are not there are looked up.
  const rawNodes: RawNode[] = [];
  const rawEdges: RawEdge[] = [];
  walk(rows, rawNodes, rawEdges);
  const ids = new Map(rawNodes.map((n) => [n.id, toNodeRef(n).id]));
  const missing = [...new Set(rawEdges.flatMap((e) => [e.sourceId, e.destinationId]).filter((i) => !ids.has(i)))];
  if (missing.length) {
    for (const r of await ro<{ i: number; id: string }>(ctx, "MATCH (n) WHERE id(n) IN $ids RETURN id(n) AS i, n.id AS id", { ids: missing.slice(0, 500) })) ids.set(r.i, r.id);
  }
  const endpoints = (e: RawEdge) => ({ from: ids.get(e.sourceId) ?? `#${e.sourceId}`, to: ids.get(e.destinationId) ?? `#${e.destinationId}` });
  const edgeRef = (e: RawEdge): EdgeRef => {
    const p = e.properties;
    return { ...endpoints(e), type: e.relationshipType, ...(typeof p.since === "number" ? { since: p.since } : {}), until: typeof p.until === "number" ? p.until : null };
  };

  const shape = (v: unknown, bag: Bag): unknown => {
    if (isRawPath(v)) {
      const p = toPathResult(v);
      bag.nodes.push(...p.nodes.slice(0, ARRAY_CAP + 1));
      p.edges.slice(0, ARRAY_CAP).forEach((e, i) => bag.edges.push({ e, src: v.edges[i]!.properties.src }));
      const cut = p.edges.length > ARRAY_CAP;
      return {
        path: [...p.nodes.slice(0, ARRAY_CAP + 1).map((n) => n.id), ...(cut ? [more(p.nodes.length - ARRAY_CAP - 1)] : [])],
        steps: [...p.edges.slice(0, ARRAY_CAP).map(edgeText), ...(cut ? [more(p.edges.length - ARRAY_CAP)] : [])],
      };
    }
    if (isRawNode(v)) {
      const ref = toNodeRef(v);
      bag.nodes.push(ref);
      return { id: ref.id, type: ref.label, name: ref.name, props: compactProps(Object.entries(v.properties).filter(([k]) => k !== "id" && k !== "name")) };
    }
    if (isRawEdge(v)) {
      const e = edgeRef(v);
      bag.edges.push({ e, src: v.properties.src });
      return { from: e.from, type: e.type, to: e.to, ...compactProps(Object.entries(v.properties)) };
    }
    if (typeof v === "string") return clip(v);
    if (Array.isArray(v)) {
      if (v.length > ARRAY_CAP && v.every((x) => typeof x === "number")) return `[${v.length} numbers]`;
      const head = v.slice(0, ARRAY_CAP).map((x) => shape(x, bag));
      return v.length > ARRAY_CAP ? [...head, more(v.length - ARRAY_CAP)] : head;
    }
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x, bag)]));
    return v;
  };

  // Rows are kept while the JSON stays within CYPHER_CHAR_CAP; only kept rows contribute nodes, edges and sources.
  const out: unknown[] = [];
  const bags: Bag[] = [];
  let size = 2;
  for (const r of rows) {
    const bag: Bag = { nodes: [], edges: [] };
    const shaped = shape(r, bag);
    const len = JSON.stringify(shaped).length + 1;
    if (size + len > CYPHER_CHAR_CAP) break;
    size += len;
    out.push(shaped);
    bags.push(bag);
  }
  const overSize = out.length < rows.length;

  const col = new Collector();
  let capped = false;
  const addNode = (n: NodeRef) => {
    if (col.nodes.has(n.id)) return;
    if (col.nodes.size >= CYPHER_NODE_CAP) capped = true;
    else col.ref(n);
  };
  for (const bag of bags) {
    bag.nodes.forEach(addNode);
    for (const { e, src } of bag.edges) col.edgeRef(e, src);
  }

  // Plain id strings (`RETURN p.id`) of existing entities count as returned nodes, so they can be cited.
  const idLike = new Set<string>();
  const scan = (v: unknown) => {
    if (isRawNode(v) || isRawEdge(v) || isRawPath(v)) return; // already mapped; their props (src…) are not results
    if (typeof v === "string" && typeFromId(v) && !col.nodes.has(v) && idLike.size < CYPHER_NODE_CAP) idLike.add(v);
    else if (Array.isArray(v)) v.slice(0, ARRAY_CAP).forEach(scan);
    else if (v && typeof v === "object") Object.values(v).forEach(scan);
  };
  rows.slice(0, out.length).forEach(scan);
  const found = await getNodes(ctx, [...idLike]);
  for (const id of idLike) {
    const n = found.get(id);
    if (!n || col.nodes.has(id)) continue;
    if (col.nodes.size >= CYPHER_NODE_CAP) capped = true;
    else col.node(n);
  }

  const notes = [
    ...(overSize ? [`Output capped at ${CYPHER_CHAR_CAP.toLocaleString("en-US")} characters (${out.length} of ${rows.length}${overRows ? "+" : ""} rows); return fewer columns, ids instead of whole nodes, or aggregate.`]
      : overRows ? [`Capped at ${CYPHER_ROW_CAP} rows; aggregate or filter in the query.`] : []),
    ...(!rows.length ? ["The query returned no rows."] : []),
    ...(rows.length && out.length && !col.nodes.size ? ["Return ids (e.g. n.id) as well, so the answer can cite them."] : []),
    ...(capped ? [`Only the first ${CYPHER_NODE_CAP} nodes are citable.`] : []),
  ];
  return col.result(ctx, { columns: Object.keys(rows[0] ?? {}), rows: out, rowCount: out.length, truncated: overRows || overSize }, notes.join(" ") || undefined);
}

export const cypher = defineTool({
  name: "cypher",
  description:
    "Read-only Cypher, only when no other tool fits. Nodes have label Entity plus a type label and an id; current edges have until IS NULL. Return ids so they can be cited. Writes, LOAD CSV and algo.* are refused; 5 s timeout, 200 rows. Example: {\"query\":\"MATCH (t:Task) WHERE t.status = $s RETURN t.id, t.name\",\"params\":{\"s\":\"open\"}}",
  input: {
    query: z.string().min(1).describe("A read-only Cypher query"),
    params: z.record(z.string(), z.unknown()).optional().describe("Query parameters, referenced as $name"),
  },
  run: runCypher,
});
