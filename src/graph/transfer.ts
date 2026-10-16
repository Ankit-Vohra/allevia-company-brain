// Logical export and import of one graph, for moving a business between FalkorDB servers whose on-disk formats differ
// (DUMP/RESTORE carries the module's encoding version, so a 6.0 dump does not load on 4.x and back). The file is JSON
// lines, versioned:
//
//   {"kind":"header","format":"allevia-graph-export","version":1,"graph":…,"labels":[…],"indexes":[…],"constraints":[…],"counts":{…}}
//   {"kind":"node","i":<internal id>,"l":[labels],"p":{props},"f":[float keys],"v":[vector keys]}      one per node
//   {"kind":"edge","i":<internal id>,"t":type,"s":<source i>,"d":<target i>,"p":{props},"f":[float keys]} one per edge
//   {"kind":"end","nodes":n,"edges":m,"digest":sha256}
//
// Types: JSON has one number, FalkorDB has two, so the keys holding a Float are listed (an integral double such as 3.0
// would otherwise come back an Integer, and Cypher's 7 / 2 is 3), and so are the keys holding a vector (vecf32): a vector
// reads back as a list of numbers. Strings, Integers, Booleans and lists of those (and of non-integral Floats) round-trip
// as they are. Anything else (a map, a point, a date, a nested list, NaN, ±Infinity, a list holding an integral Float)
// is refused at export with the node and key named, rather than copied wrongly.
//
// Reads go through GRAPH.RO_QUERY in pages of PAGE rows keyed on the internal id (RESULTSET_SIZE drops rows past 10,000
// silently). A live graph can change while it is read, so the export reads the counts and the write stamp before and
// after, and reads again (up to 3 times) when they moved; a graph that never settles is refused. The safe way to move a
// business is with its writers stopped (docs/falkordb-cloud.md).
//
// Import writes nodes in batches of parameterised `UNWIND $rows AS r CREATE (n:Labels) SET n = r.p …`, one statement per
// label set, and remembers each new internal id; edges follow, one statement per type, anchored by id(). Labels are
// registered first in the source's order (labels(n) lists them in that order: see migrate.ts registerTypeLabels). Then
// the schema: the source's node indexes and constraints, and for a business graph the whole current schema
// (ensureSchema). Last, verification: the target is read back with the same reader and its digest (independent of
// internal ids), counts per label set and relationship type, and checksum of `id` values must equal the file's, and a
// sample of nodes is read again by id, vectors included, and compared value by value.
import { createHash } from "node:crypto";
import { createWriteStream, readFileSync } from "node:fs";
import { once } from "node:events";
import { GraphHandle, connect, type ConstraintInfo } from "./client.js";
import { ensureIndexes, ensureSchema, listIndexes, type IndexSpec } from "./indexes.js";

export const EXPORT_FORMAT = "allevia-graph-export";
export const EXPORT_VERSION = 1;
const PAGE = 500;                    // rows per read page (a node with two 384-d vectors is ~16 KB of reply)
const BATCH_BYTES = 256 * 1024;      // params per write statement (inlined into the query text)
const BATCH_ROWS = 2000;             // and never more rows than a result can hold
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type Prop = string | number | boolean | null | Prop[];
export interface ExportHeader {
  kind: "header"; format: string; version: number; graph: string; exportedAt: string;
  source: { moduleVersion: number | null };
  labels: string[];                  // in the source's label-id order
  relTypes: string[];
  indexes: IndexSpec[];              // node indexes
  edgeIndexes: number;               // relationship indexes (none in Allevia; an import refuses a file that has any)
  constraints: Array<Pick<ConstraintInfo, "type" | "label" | "props">>;
  counts: { nodes: number; edges: number };
}
export interface NodeLine { kind: "node"; i: number; l: string[]; p: Record<string, Prop>; f?: string[]; v?: string[] }
export interface EdgeLine { kind: "edge"; i: number; t: string; s: number; d: number; p: Record<string, Prop>; f?: string[]; v?: string[] }
export interface EndLine { kind: "end"; nodes: number; edges: number; digest: string }
export interface GraphDump { header: ExportHeader; nodes: NodeLine[]; edges: EdgeLine[]; end: EndLine }

export interface Summary {
  nodes: number; edges: number;
  labelSets: Record<string, number>; // "Entity:Task:Searchable" -> count
  relTypes: Record<string, number>;
  idChecksum: string;                // sha256 of the sorted `id` property values
  digest: string;                    // sha256 of the whole content, independent of internal ids
}

// ---------- reading ----------

const SUPPORTED = "['String','Integer','Float','Boolean','List','Vectorf32']";
const BAD_LIST = "any(x IN v WHERE NOT typeOf(x) IN ['String','Integer','Boolean','Float'] OR (typeOf(x) = 'Float' AND (x <> x OR x = floor(x))))";
const typed = (e: string) =>
  `[k IN keys(${e}) WHERE typeOf(${e}[k]) = 'Float'] AS f, [k IN keys(${e}) WHERE typeOf(${e}[k]) = 'Vectorf32'] AS v, ` +
  `[k IN keys(${e}) WHERE NOT typeOf(${e}[k]) IN ${SUPPORTED} OR (typeOf(${e}[k]) = 'List' AND ${BAD_LIST.replaceAll("IN v", `IN ${e}[k]`)})] AS bad`;
const NODE_PAGE = `MATCH (n) WHERE id(n) >= $from RETURN id(n) AS i, labels(n) AS l, properties(n) AS p, ${typed("n")} ORDER BY i LIMIT $limit`;
const EDGE_PAGE = `MATCH (a)-[r]->(b) WHERE id(r) >= $from RETURN id(r) AS i, type(r) AS t, id(a) AS s, id(b) AS d, properties(r) AS p, ${typed("r")} ORDER BY i LIMIT $limit`;

interface Row { i: number; p: Record<string, unknown>; f: string[]; v: string[]; bad: string[] }

function checkRow(what: string, r: Row): Record<string, Prop> {
  if (r.bad.length) throw new Error(`${what} has properties of a type the export does not carry: ${r.bad.join(", ")}`);
  for (const [k, x] of Object.entries(r.p)) {
    if (!IDENT.test(k)) throw new Error(`${what} has a property key that is not a plain identifier: ${JSON.stringify(k)}`);
    const nums = typeof x === "number" ? [x] : Array.isArray(x) ? x.filter((y) => typeof y === "number") : [];
    if (nums.some((y) => !Number.isFinite(y))) throw new Error(`${what}.${k} holds NaN or Infinity`);
  }
  return r.p as Record<string, Prop>;
}

const compact = <T extends { f?: string[]; v?: string[] }>(line: T): T => {
  if (!line.f?.length) delete line.f;
  if (!line.v?.length) delete line.v;
  return line;
};

async function readNodes(g: GraphHandle): Promise<NodeLine[]> {
  const out: NodeLine[] = [];
  for (let from = 0; ;) {
    const rows = await g.roQuery<Row & { l: string[] }>(NODE_PAGE, { from, limit: PAGE }, { timeoutMs: 60_000 });
    for (const r of rows) out.push(compact({ kind: "node", i: r.i, l: [...r.l], p: checkRow(`node ${r.i}`, r), f: r.f, v: r.v }));
    if (rows.length < PAGE) return out;
    from = rows[rows.length - 1]!.i + 1;
  }
}

async function readEdges(g: GraphHandle): Promise<EdgeLine[]> {
  const out: EdgeLine[] = [];
  for (let from = 0; ;) {
    const rows = await g.roQuery<Row & { t: string; s: number; d: number }>(EDGE_PAGE, { from, limit: PAGE }, { timeoutMs: 60_000 });
    for (const r of rows) out.push(compact({ kind: "edge", i: r.i, t: r.t, s: r.s, d: r.d, p: checkRow(`edge ${r.i}`, r), f: r.f, v: r.v }));
    if (rows.length < PAGE) return out;
    from = rows[rows.length - 1]!.i + 1;
  }
}

const emptyKey = (e: unknown) => /empty key/i.test(String((e as Error).message));

async function counts(g: GraphHandle): Promise<{ nodes: number; edges: number }> {
  const [n] = await g.roQuery<{ c: number }>("MATCH (n) RETURN count(n) AS c");
  const [r] = await g.roQuery<{ c: number }>("MATCH ()-[r]->() RETURN count(r) AS c");
  return { nodes: n?.c ?? 0, edges: r?.c ?? 0 };
}

async function writeStamp(db: Awaited<ReturnType<typeof connect>>, graph: string): Promise<string | null> {
  try {
    const v = await db.connection.then((c) => c.get(`allevia:graph-writes:${graph}`));
    return v == null ? null : String(v);
  } catch {
    return null;
  }
}

// The server's used_memory (INFO memory), in MB.
export async function usedMemoryMb(db: Awaited<ReturnType<typeof connect>>): Promise<number> {
  const info = String(await (await db.connection).info("memory"));
  return Number(/used_memory:(\d+)/.exec(info)?.[1] ?? NaN) / 1048576;
}

export async function moduleVersion(db: Awaited<ReturnType<typeof connect>>): Promise<number | null> {
  try {
    const mods = (await (await db.connection).sendCommand(["MODULE", "LIST"])) as unknown[][];
    for (const m of mods) {
      const i = m.indexOf("name");
      if (i >= 0 && m[i + 1] === "graph") return Number(m[m.indexOf("ver") + 1]);
    }
  } catch { /* a server that refuses MODULE LIST */ }
  return null;
}

// Everything in the graph, as the file holds it (no `end` digest checked here: see summarize).
export async function readGraph(g: GraphHandle, db: Awaited<ReturnType<typeof connect>>): Promise<GraphDump> {
  let moved = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = { c: await counts(g), s: await writeStamp(db, g.name) };
    const labels = (await g.roQuery<{ label: string }>("CALL db.labels() YIELD label RETURN label")).map((r) => r.label);
    const relTypes = (await g.roQuery<{ relationshipType: string }>(
      "CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType")).map((r) => r.relationshipType);
    const raw = await g.roQuery<{ entitytype: string }>("CALL db.indexes() YIELD entitytype RETURN entitytype");
    const indexes = await listIndexes(g);
    const constraints = (await g.constraints()).map((c) => ({ type: c.type, label: c.label, props: c.props }));
    const nodes = await readNodes(g);
    const edges = await readEdges(g);
    const after = { c: await counts(g), s: await writeStamp(db, g.name) };
    if (JSON.stringify(before) !== JSON.stringify(after) || nodes.length !== after.c.nodes || edges.length !== after.c.edges) {
      moved = `before ${JSON.stringify(before.c)}, after ${JSON.stringify(after.c)}, read ${nodes.length} nodes and ${edges.length} edges` +
        `${before.s !== after.s ? ", write stamp moved" : ""}`;
      continue;
    }
    const known = new Set(nodes.map((n) => n.i));
    const loose = edges.filter((e) => !known.has(e.s) || !known.has(e.d));
    if (loose.length) throw new Error(`${loose.length} edges point at nodes that were not read (edge ${loose[0]!.i})`);
    const header: ExportHeader = {
      kind: "header", format: EXPORT_FORMAT, version: EXPORT_VERSION, graph: g.name, exportedAt: new Date().toISOString(),
      source: { moduleVersion: await moduleVersion(db) }, labels, relTypes, indexes,
      edgeIndexes: raw.filter((r) => r.entitytype !== "NODE").length, constraints, counts: { nodes: nodes.length, edges: edges.length },
    };
    const s = summarize(nodes, edges);
    return { header, nodes, edges, end: { kind: "end", nodes: nodes.length, edges: edges.length, digest: s.digest } };
  }
  throw new Error(`${g.name} kept changing while it was read (3 attempts; last: ${moved}): stop its writers and export again`);
}

// ---------- canonical content ----------

const canonValue = (v: Prop, isFloat: boolean, isVec: boolean): unknown =>
  isVec && Array.isArray(v) ? ["vecf32", v.map((x) => Math.fround(Number(x)))] : isFloat ? ["float", v] : v;

function canonEntity(labels: string[], p: Record<string, Prop>, f?: string[], v?: string[]): string {
  const fs = new Set(f ?? []), vs = new Set(v ?? []);
  const props = Object.keys(p).sort().map((k) => [k, canonValue(p[k]!, fs.has(k), vs.has(k))]);
  return JSON.stringify([[...labels].sort(), props]);
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// Counts, id checksum and a digest of the whole content in which an edge names its endpoints by their content, so two
// copies of one graph agree whatever internal ids the server gave them.
export function summarize(nodes: NodeLine[], edges: EdgeLine[]): Summary {
  const nodeHash = new Map<number, string>();
  const labelSets: Record<string, number> = {};
  const relTypes: Record<string, number> = {};
  const ids: string[] = [];
  const lines: string[] = [];
  for (const n of nodes) {
    const c = canonEntity(n.l, n.p, n.f, n.v);
    nodeHash.set(n.i, sha(c));
    lines.push(`N ${c}`);
    const key = n.l.join(":");
    labelSets[key] = (labelSets[key] ?? 0) + 1;
    if (typeof n.p.id === "string") ids.push(n.p.id);
  }
  for (const e of edges) {
    lines.push(`E ${nodeHash.get(e.s)} ${e.t} ${nodeHash.get(e.d)} ${canonEntity([], e.p, e.f, e.v)}`);
    relTypes[e.t] = (relTypes[e.t] ?? 0) + 1;
  }
  lines.sort();
  ids.sort();
  return { nodes: nodes.length, edges: edges.length, labelSets, relTypes, idChecksum: sha(ids.join("\n")), digest: sha(lines.join("\n")) };
}

// ---------- the file ----------

export async function writeDump(dump: GraphDump, file: string): Promise<void> {
  const out = createWriteStream(file, { encoding: "utf8" });
  const put = async (o: unknown) => { if (!out.write(`${JSON.stringify(o)}\n`)) await once(out, "drain"); };
  await put(dump.header);
  for (const n of dump.nodes) await put(n);
  for (const e of dump.edges) await put(e);
  await put(dump.end);
  out.end();
  await once(out, "finish");
}

// Reads and checks a file: format and version known, every line well formed, the counts and digest in `end` equal to
// what the lines hold (a truncated or edited file is refused before anything is written).
export function readDump(file: string): GraphDump {
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
  const parsed = lines.map((l, n) => {
    try { return JSON.parse(l) as { kind?: string }; } catch { throw new Error(`${file}:${n + 1} is not JSON`); }
  });
  const header = parsed[0] as ExportHeader | undefined;
  if (header?.kind !== "header" || header.format !== EXPORT_FORMAT) throw new Error(`${file} is not an ${EXPORT_FORMAT} file`);
  if (header.version !== EXPORT_VERSION) throw new Error(`${file} is export version ${header.version}; this code reads version ${EXPORT_VERSION}`);
  const end = parsed[parsed.length - 1] as EndLine | undefined;
  if (end?.kind !== "end") throw new Error(`${file} has no end line: the export did not finish or the file was cut short`);
  const nodes = parsed.filter((x) => x.kind === "node") as NodeLine[];
  const edges = parsed.filter((x) => x.kind === "edge") as EdgeLine[];
  if (nodes.length + edges.length + 2 !== parsed.length) throw new Error(`${file} has lines of an unknown kind`);
  if (nodes.length !== end.nodes || edges.length !== end.edges || nodes.length !== header.counts.nodes || edges.length !== header.counts.edges) {
    throw new Error(`${file}: the counts in its header and end line do not match its lines`);
  }
  if (summarize(nodes, edges).digest !== end.digest) throw new Error(`${file}: its content does not match its digest`);
  return { header, nodes, edges, end };
}

// ---------- writing ----------

function batches<T>(rows: T[], size: (r: T) => number): T[][] {
  const out: T[][] = [];
  let cur: T[] = [], bytes = 0;
  for (const r of rows) {
    const b = size(r);
    if (cur.length && (bytes + b > BATCH_BYTES || cur.length >= BATCH_ROWS)) { out.push(cur); cur = []; bytes = 0; }
    cur.push(r);
    bytes += b;
  }
  if (cur.length) out.push(cur);
  return out;
}

// SET clauses for the typed keys of a batch, applied after `SET n = r.p`: the rows carry a Float or a vector in `r.x`
// (never in `r.p`: FalkorDB skips a SET whose value equals the stored one, and 3.0 equals the Integer 3, so an integral
// Float set over its Integer twin would stay an Integer). A row without the key keeps what `r.p` gave it.
function typedSets(v: string, rows: Array<{ f?: string[]; v?: string[] }>): string {
  const fk = [...new Set(rows.flatMap((r) => r.f ?? []))].sort();
  const vk = [...new Set(rows.flatMap((r) => r.v ?? []))].sort();
  for (const k of [...fk, ...vk]) if (!IDENT.test(k)) throw new Error(`property key ${JSON.stringify(k)} is not a plain identifier`);
  const sets = [
    ...fk.map((k) => `${v}.${k} = CASE WHEN r.x.${k} IS NULL THEN ${v}.${k} ELSE toFloat(r.x.${k}) END`),
    ...vk.map((k) => `${v}.${k} = CASE WHEN r.x.${k} IS NULL THEN ${v}.${k} ELSE vecf32(r.x.${k}) END`),
  ];
  return sets.length ? ` SET ${sets.join(", ")}` : "";
}

// The row's plain properties, and its Floats and vectors apart (see typedSets).
function splitTyped(p: Record<string, Prop>, f: string[] | undefined, vk: string[] | undefined): { p: Record<string, Prop>; x: Record<string, Prop> } {
  const typed = [...(f ?? []), ...(vk ?? [])];
  if (!typed.length) return { p, x: {} };
  const rest = { ...p }, x: Record<string, Prop> = {};
  for (const k of typed) { x[k] = rest[k]!; delete rest[k]; }
  return { p: rest, x };
}

export interface ImportReport {
  graph: string; nodes: number; edges: number; ms: number;
  schema: { indexes: number; constraints: Record<string, string>; problems: string[] };
  verify: VerifyReport;
}
export interface VerifyReport { ok: boolean; problems: string[]; spotChecked: number; summary: Summary }

// maxMemoryMb: the server's used_memory is read after every batch (and after the indexes); past it the import stops and drops
// what it wrote, so a small managed server (FalkorDB Cloud free: 100 MB, no eviction) never fills up.
export interface ImportOpts { graph?: string; replace?: boolean; log?: (msg: string) => void; spotChecks?: number; maxMemoryMb?: number }

export async function importDump(dump: GraphDump, url: string, opts: ImportOpts = {}): Promise<ImportReport> {
  const t0 = Date.now();
  const log = opts.log ?? (() => undefined);
  const name = opts.graph ?? dump.header.graph;
  if (!/^[A-Za-z0-9_]+$/.test(name) || name.includes("__")) throw new Error(`bad graph name ${JSON.stringify(name)}`);
  if (dump.header.edgeIndexes) throw new Error(`the source had ${dump.header.edgeIndexes} relationship indexes; this import does not recreate those`);
  for (const l of [...dump.header.labels, ...dump.header.relTypes]) if (!IDENT.test(l)) throw new Error(`label or type ${JSON.stringify(l)} is not a plain identifier`);
  const db = await connect(url);
  const g = new GraphHandle(name, db.selectGraph(name), db);
  if ((await db.list()).includes(name)) {
    const c = await counts(g).catch((e) => { if (emptyKey(e)) return { nodes: 0, edges: 0 }; throw e; });
    if (!opts.replace) throw new Error(`${name} already exists on the target (${c.nodes} nodes, ${c.edges} edges): pass --replace to overwrite it`);
    log(`dropping the existing ${name} (${c.nodes} nodes, ${c.edges} edges)`);
    await g.drop();
  }
  const memoryGuard = async (): Promise<void> => {
    if (opts.maxMemoryMb === undefined) return;
    const used = await usedMemoryMb(db);
    if (used <= opts.maxMemoryMb) return;
    await g.drop();
    throw new Error(`the server reached ${used.toFixed(1)} MB used (limit ${opts.maxMemoryMb} MB): stopped and dropped the partial ${name}`);
  };
  await memoryGuard();

  // labels in the source's order
  for (const l of dump.header.labels) await g.query(`CREATE (n:${l}) DELETE n`);

  // nodes, one statement shape per label set
  const map = new Map<number, number>();
  const bySet = new Map<string, NodeLine[]>();
  for (const n of dump.nodes) {
    for (const l of n.l) if (!IDENT.test(l)) throw new Error(`label ${JSON.stringify(l)} is not a plain identifier`);
    const k = n.l.join(":");
    bySet.set(k, [...(bySet.get(k) ?? []), n]);
  }
  let done = 0;
  for (const [set, rows] of bySet) {
    for (const b of batches(rows, (r) => JSON.stringify(r).length)) {
      const labels = set ? `:${set}` : "";
      const res = await g.query<{ i: number; n: number }>(
        `UNWIND $rows AS r CREATE (n${labels}) SET n = r.p${typedSets("n", b)} RETURN r.i AS i, id(n) AS n`,
        { rows: b.map((r) => { const s = splitTyped(r.p, r.f, r.v); return { i: r.i, p: s.p, x: s.x }; }) });
      if (res.length !== b.length) throw new Error(`a batch of ${b.length} ${set} nodes created ${res.length}`);
      for (const r of res) map.set(r.i, r.n);
      done += b.length;
      await memoryGuard();
    }
  }
  log(`${done} nodes written`);

  // edges, one statement shape per type
  const byType = new Map<string, EdgeLine[]>();
  for (const e of dump.edges) {
    if (!IDENT.test(e.t)) throw new Error(`relationship type ${JSON.stringify(e.t)} is not a plain identifier`);
    byType.set(e.t, [...(byType.get(e.t) ?? []), e]);
  }
  done = 0;
  for (const [t, rows] of byType) {
    for (const b of batches(rows, (r) => JSON.stringify(r).length)) {
      const res = await g.query<{ c: number }>(
        `UNWIND $rows AS r MATCH (a) WHERE id(a) = r.s MATCH (b) WHERE id(b) = r.d CREATE (a)-[e:${t}]->(b) SET e = r.p${typedSets("e", b)} RETURN count(e) AS c`,
        { rows: b.map((r) => {
          const s = map.get(r.s), d = map.get(r.d);
          if (s === undefined || d === undefined) throw new Error(`edge ${r.i} points at a node the file does not hold`);
          const sp = splitTyped(r.p, r.f, r.v);
          return { s, d, p: sp.p, x: sp.x };
        }) });
      if ((res[0]?.c ?? 0) !== b.length) throw new Error(`a batch of ${b.length} ${t} edges created ${res[0]?.c ?? 0}`);
      done += b.length;
      await memoryGuard();
    }
  }
  log(`${done} edges written`);

  // schema: the source's own node indexes and constraints; a business graph also gets the whole current schema
  log("indexes and constraints");
  await ensureIndexes(g, dump.header.indexes);
  const problems: string[] = [];
  const status: Record<string, string> = {};
  if (dump.nodes.some((n) => n.l.includes("Entity"))) {
    const r = await ensureSchema(g);
    problems.push(...r.constraints.problems);
  }
  for (const c of dump.header.constraints) {
    const have = await g.constraints();
    if (have.some((h) => h.type === c.type && h.label === c.label && h.props.join(",") === c.props.join(","))) continue;
    if (c.props.length !== 1) { problems.push(`constraint ${c.type} ${c.label}(${c.props.join(",")}) not recreated: several properties`); continue; }
    await g.createConstraint(c.type, c.label, c.props[0]!);
  }
  const settleEnd = Date.now() + 60_000;
  let cons = await g.constraints();
  while (cons.some((c) => c.status === "PENDING") && Date.now() < settleEnd) {
    await new Promise((r) => setTimeout(r, 100));
    cons = await g.constraints();
  }
  for (const c of cons) status[`${c.type} ${c.label}.${c.props.join(",")}`] = c.status;
  for (const c of cons) if (c.status !== "OPERATIONAL") problems.push(`constraint ${c.type} ${c.label}.${c.props.join(",")} is ${c.status}`);
  await memoryGuard();
  const idx = await listIndexes(g);

  log("verifying");
  const verify = await verifyGraph(dump, g, db, opts.spotChecks ?? 25);
  return {
    graph: name, nodes: dump.nodes.length, edges: dump.edges.length, ms: Date.now() - t0,
    schema: { indexes: idx.length, constraints: status, problems }, verify,
  };
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// Reads the target back and holds it to the file: digest, counts per label set and type, id checksum, label order, the
// source's indexes, and a sample of nodes read again by id with every property (vectors compared as float32).
export async function verifyGraph(dump: GraphDump, g: GraphHandle, db: Awaited<ReturnType<typeof connect>>, spotChecks: number): Promise<VerifyReport> {
  const problems: string[] = [];
  const want = summarize(dump.nodes, dump.edges);
  const back = await readGraph(g, db);
  const got = summarize(back.nodes, back.edges);
  if (got.nodes !== want.nodes || got.edges !== want.edges) problems.push(`counts: ${got.nodes} nodes / ${got.edges} edges, want ${want.nodes} / ${want.edges}`);
  for (const [k, n] of Object.entries(want.labelSets)) if (got.labelSets[k] !== n) problems.push(`label set ${k}: ${got.labelSets[k] ?? 0}, want ${n}`);
  for (const [k, n] of Object.entries(got.labelSets)) if (!(k in want.labelSets)) problems.push(`label set ${k}: ${n}, want none`);
  for (const [k, n] of Object.entries(want.relTypes)) if (got.relTypes[k] !== n) problems.push(`relationship ${k}: ${got.relTypes[k] ?? 0}, want ${n}`);
  if (got.idChecksum !== want.idChecksum) problems.push("id checksum differs");
  if (got.digest !== want.digest) problems.push("content digest differs");
  if (!sameJson(back.header.labels.slice(0, dump.header.labels.length), dump.header.labels)) problems.push("labels are registered in a different order");
  const have = new Set(back.header.indexes.map((i) => `${i.label}|${i.prop}|${i.type}`));
  for (const i of dump.header.indexes) if (!have.has(`${i.label}|${i.prop}|${i.type}`)) problems.push(`index ${i.type} ${i.label}.${i.prop} missing`);

  // spot checks through a different read: by the `id` property, every key with its type, vectors included (one query a node)
  const withId = dump.nodes.filter((n) => typeof n.p.id === "string" && n.l.includes("Entity"));
  const step = Math.max(1, Math.floor(withId.length / Math.max(1, spotChecks)));
  const sample = [...withId.filter((_, k) => k % step === 0).slice(0, spotChecks), ...withId.filter((n) => n.v?.length).slice(0, 5)];
  for (const n of sample) {
    const keys = Object.keys(n.p);
    const rows = await g.roQuery<{ kv: Array<[unknown, string]>; nk: number }>(
      "MATCH (n:Entity {id:$id}) RETURN [k IN $keys | [n[k], typeOf(n[k])]] AS kv, size(keys(n)) AS nk", { id: n.p.id, keys });
    const r = rows[0];
    if (!r || rows.length !== 1) { problems.push(`spot check ${String(n.p.id)}: ${rows.length} nodes`); continue; }
    if (r.nk !== keys.length) problems.push(`spot check ${String(n.p.id)}: ${r.nk} properties, want ${keys.length}`);
    keys.forEach((k, j) => {
      const [x, t] = r.kv[j]!;
      const want = n.p[k]!;
      const isVec = n.v?.includes(k), isFloat = n.f?.includes(k);
      const wantType = isVec ? "Vectorf32" : isFloat ? "Float" : typeof want === "string" ? "String" : typeof want === "boolean" ? "Boolean" : Array.isArray(want) ? "List" : "Integer";
      const ok = t === wantType && (isVec
        ? sameJson((x as number[]).map(Math.fround), (want as number[]).map((y) => Math.fround(Number(y))))
        : sameJson(x, want));
      if (!ok) problems.push(`spot check ${String(n.p.id)}.${k}: got ${t} ${JSON.stringify(x).slice(0, 60)}, want ${wantType} ${JSON.stringify(want).slice(0, 60)}`);
    });
  }
  return { ok: problems.length === 0, problems, spotChecked: sample.length, summary: got };
}
