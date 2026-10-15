// cypher: the read-only escape hatch for questions no other tool answers. Guards, outermost first:
// 1. Text checks, on the query with string literals, backtick names and comments blanked (same length, so
//    `WHERE n.name = 'CREATE'` is fine): no write keyword, LOAD CSV (it reads files even in read-only mode) or FOREACH;
//    CALL only of the read procedures in READ_PROCS (procedure names are compared with backticks and spaces removed,
//    since the server accepts `db.labels` and db . labels). Non-ASCII next to a keyword never hides it (\w is ASCII), and
//    lookalike or invisible characters inside one make it no keyword at all, for the server too.
// 2. Work the timeout cannot stop: FalkorDB checks TIMEOUT between records, not while it evaluates one expression
//    (measured: a 15,000 x 15,000 reduce ran 4.5 s on a 2 s timeout). So reduce() and list iteration nested in list
//    iteration are refused, range() bounds must be numbers or $params, and all range() calls of a query together may
//    build at most RANGE_CAP values.
// 3. GRAPH.RO_QUERY: the server itself refuses anything that would write, including write-mode procedures.
// 4. A 5 s server-side timeout, which stops anything that streams records (a cartesian MATCH, chained UNWINDs).
// 5. Bounded output: the last RETURN of every UNION branch ends in LIMIT <= 201 (appended, or lowered), rows are cut
//    to 200, lists to 50 items, strings to 400 characters, the whole to CYPHER_CHAR_CAP characters, and at most
//    CYPHER_NODE_CAP graph objects become NodeRefs.
// Graph objects in the rows become NodeRef/EdgeRef only once looked up by internal id (a map literal shaped like a node
// or an edge arrives exactly like one, so it stays data and never becomes a citation); the stored node, and the stored
// edge's `src` document, are what count. String values that are ids of existing entities count as returned nodes too,
// so an answer can cite what a query found.
import { z } from "zod";
import type { ToolContext } from "../tool.js";
import { isRawEdge, isRawNode, isRawPath, toNodeRef, type RawEdge, type RawNode } from "../../graph/read.js";
import { typeFromId } from "../../util/ids.js";
import { Collector, EDGE, InputError, NODE, clip, compactProps, defineTool, getNodes, ro, type EdgeRow, type NodeRow } from "./common.js";

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

// The offset of the bracket closing the one at `open` (any of ( [ {), or -1. Literals are blanked, so counting works.
function closing(bare: string, open: number): number {
  let d = 0;
  for (let i = open; i < bare.length; i++) {
    const c = bare[i];
    if (c === "(" || c === "[" || c === "{") d++;
    else if ((c === ")" || c === "]" || c === "}") && --d === 0) return i;
  }
  return -1;
}

// The top-level comma-separated arguments of the call whose "(" is at `open`.
function callArgs(bare: string, open: number): string[] {
  const close = closing(bare, open);
  const out: string[] = [];
  let d = 0;
  let from = open + 1;
  for (let i = open + 1; i < (close < 0 ? bare.length : close); i++) {
    const c = bare[i];
    if (c === "(" || c === "[" || c === "{") d++;
    else if (c === ")" || c === "]" || c === "}") d--;
    else if (c === "," && d === 0) {
      out.push(bare.slice(from, i));
      from = i + 1;
    }
  }
  out.push(bare.slice(from, close < 0 ? bare.length : close));
  return out.map((a) => a.trim());
}

// range(a, b[, step]) builds its whole list inside one expression. Bounds must be numbers or $params, and the sizes
// of every range() in the query multiplied (UNWIND range … UNWIND range …) stay within RANGE_CAP.
function rangeReason(bare: string, params: Record<string, unknown>): string | null {
  const val = (s: string): number | null => {
    const v = /^\$\w+$/.test(s) ? params[s.slice(1)] : /^-?\d+(?:\.\d+)?(?:e\d+)?$/i.test(s) ? Number(s) : null;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  let product = 1;
  for (const m of bare.matchAll(/(?<![\w.$`])range\s*\(/gi)) {
    const xs = callArgs(bare, m.index + m[0].length - 1);
    const [a, b, step] = [val(xs[0] ?? ""), val(xs[1] ?? ""), xs.length > 2 ? val(xs[2]!) : 1];
    if (a === null || b === null || step === null) {
      return "range() bounds must be numbers or $params, so its size is known before it runs; UNWIND a list instead.";
    }
    if (step === 0) continue; // the server refuses it
    product *= Math.floor(Math.abs(b - a) / Math.abs(step)) + 1;
    if (product > RANGE_CAP) return `range() calls in one query may build at most ${RANGE_CAP.toLocaleString("en-US")} values together.`;
  }
  return null;
}

const REDUCE = /(?<![\w.$`])reduce\s*\(/i;
// List iteration: quantifiers (and the old extract/filter) and list comprehensions `[x IN list …]`.
const ITERATE = /(?<![\w.$`])(?:any|all|none|single|extract|filter)\s*\(|\[\s*(?:[A-Za-z_]\w*\s+)?IN\s/gi;

// Work inside one expression that the timeout cannot stop.
function expressionReason(bare: string): string | null {
  if (REDUCE.test(bare)) return "reduce() is not allowed: the timeout cannot stop it. UNWIND the list and aggregate with sum(), count() or collect().";
  const spans = [...bare.matchAll(ITERATE)].map((m) => {
    const open = m[0].startsWith("[") ? m.index : m.index + m[0].length - 1;
    return [open, closing(bare, open)] as const;
  });
  for (const [open] of spans) {
    if (spans.some(([o, c]) => o < open && (c < 0 || open < c))) {
      return "Nested list iteration (a comprehension or any/all/none/single inside another) is not allowed: the timeout cannot stop it. UNWIND one of the lists instead.";
    }
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
  return expressionReason(bare) ?? rangeReason(bare, params);
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

interface Bag { nodes: RawNode[]; edges: RawEdge[] }
const LOOKUP_CAP = 1_000; // graph objects looked up by internal id

// Raw FalkorDB values in what will be shown (lists cut to ARRAY_CAP, as shape() does).
function walk(v: unknown, bag: Bag): void {
  if (bag.nodes.length + bag.edges.length >= LOOKUP_CAP) return;
  if (isRawPath(v)) {
    bag.nodes.push(...v.nodes.slice(0, ARRAY_CAP + 1));
    bag.edges.push(...v.edges.filter(isRawEdge).slice(0, ARRAY_CAP));
  } else if (isRawNode(v)) bag.nodes.push(v);
  else if (isRawEdge(v)) bag.edges.push(v);
  else if (Array.isArray(v)) for (const x of v.slice(0, ARRAY_CAP)) walk(x, bag);
  else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x, bag);
}

const more = (n: number) => `…${n} more`;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

// The stored nodes and edges behind raw values, by internal id. A value only counts when the stored object has the
// same entity id (node) or the same type and endpoints (edge).
async function lookup(ctx: ToolContext, bag: Bag): Promise<{ nodes: Map<number, NodeRow>; edges: Map<number, EdgeRow> }> {
  const nodeIds = [...new Set([...bag.nodes.map((n) => n.id), ...bag.edges.flatMap((e) => [e.sourceId, e.destinationId])].map(num))]
    .filter((i): i is number => i !== null).slice(0, LOOKUP_CAP);
  const edgeKeys = [...new Map(bag.edges.filter((e) => num(e.id) !== null && num(e.sourceId) !== null && num(e.destinationId) !== null)
    .map((e) => [e.id, { r: e.id, s: e.sourceId, d: e.destinationId }])).values()].slice(0, LOOKUP_CAP);
  const [nodes, edges] = await Promise.all([
    nodeIds.length ? ro<{ i: number; n: NodeRow }>(ctx, `UNWIND $ids AS i MATCH (n) WHERE id(n) = i RETURN i, ${NODE("n")} AS n`, { ids: nodeIds }) : [],
    edgeKeys.length ? ro<{ i: number; e: EdgeRow }>(ctx,
      `UNWIND $es AS x MATCH (a) WHERE id(a) = x.s WITH x, a MATCH (a)-[r]->(b) WHERE id(r) = x.r AND id(b) = x.d RETURN x.r AS i, ${EDGE("r")} AS e`,
      { es: edgeKeys }) : [],
  ]);
  return { nodes: new Map(nodes.map((r) => [r.i, r.n])), edges: new Map(edges.map((r) => [r.i, r.e])) };
}

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

  const all: Bag = { nodes: [], edges: [] };
  walk(rows, all);
  const stored = await lookup(ctx, all);
  const entityId = (i: number) => stored.nodes.get(i)?.id ?? `#${i}`;
  const realNode = (v: RawNode): NodeRow | undefined => {
    const n = stored.nodes.get(v.id);
    return n && typeof n.id === "string" && n.id === v.properties.id ? n : undefined;
  };
  const realEdge = (v: RawEdge): EdgeRow | undefined => {
    const e = stored.edges.get(v.id);
    return e && e.type === v.relationshipType && e.from === entityId(v.sourceId) && e.to === entityId(v.destinationId) ? e : undefined;
  };

  const shape = (v: unknown, bag: Bag): unknown => {
    if (isRawPath(v)) {
      const nodes = v.nodes.slice(0, ARRAY_CAP + 1);
      const edges = v.edges.filter(isRawEdge).slice(0, ARRAY_CAP);
      bag.nodes.push(...nodes);
      bag.edges.push(...edges);
      const cut = v.edges.length > ARRAY_CAP;
      return {
        path: [...nodes.map((n) => toNodeRef(n).id), ...(cut ? [more(v.nodes.length - ARRAY_CAP - 1)] : [])],
        steps: [...edges.map((e) => `${entityId(e.sourceId)} -[${e.relationshipType}]-> ${entityId(e.destinationId)}`), ...(cut ? [more(v.edges.length - ARRAY_CAP)] : [])],
      };
    }
    if (isRawNode(v)) {
      const ref = toNodeRef(v);
      bag.nodes.push(v);
      return { id: ref.id, type: ref.label, name: ref.name, props: compactProps(Object.entries(v.properties).filter(([k]) => k !== "id" && k !== "name")) };
    }
    if (isRawEdge(v)) {
      bag.edges.push(v);
      return { from: entityId(v.sourceId), type: v.relationshipType, to: entityId(v.destinationId), ...compactProps(Object.entries(v.properties)) };
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
  const addNode = (n: NodeRow) => {
    if (col.nodes.has(n.id)) return;
    if (col.nodes.size >= CYPHER_NODE_CAP) capped = true;
    else col.node(n);
  };
  for (const bag of bags) {
    for (const v of bag.nodes) {
      const n = realNode(v);
      if (n) addNode(n);
    }
    for (const v of bag.edges) col.edge(realEdge(v));
  }

  // Plain id strings (`RETURN p.id`) of existing entities count as returned nodes, so they can be cited.
  const idLike = new Set<string>();
  const scan = (v: unknown) => {
    if (isRawNode(v) || isRawEdge(v) || isRawPath(v)) return; // looked up above; their props (src…) are not results
    if (typeof v === "string" && typeFromId(v) && !col.nodes.has(v) && idLike.size < CYPHER_NODE_CAP) idLike.add(v);
    else if (Array.isArray(v)) v.slice(0, ARRAY_CAP).forEach(scan);
    else if (v && typeof v === "object") Object.values(v).forEach(scan);
  };
  rows.slice(0, out.length).forEach(scan);
  const found = await getNodes(ctx, [...idLike]);
  for (const id of idLike) {
    const n = found.get(id);
    if (n) addNode(n);
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
    "Read-only Cypher, only when no other tool fits. Nodes have label Entity plus a type label and an id; current edges have until IS NULL. Return ids so they can be cited. Refused: writes, LOAD CSV, algo.*, reduce() and nested list iteration; 5 s timeout, 200 rows. Example: {\"query\":\"MATCH (t:Task) WHERE t.status = $s RETURN t.id, t.name\",\"params\":{\"s\":\"open\"}}",
  input: {
    query: z.string().min(1).describe("A read-only Cypher query"),
    params: z.record(z.string(), z.unknown()).optional().describe("Query parameters, referenced as $name"),
  },
  run: runCypher,
});
