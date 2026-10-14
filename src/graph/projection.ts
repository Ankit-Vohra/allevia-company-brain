// Projections: throwaway graphs that hold only the edges valid "now" (or at asOf), so FalkorDB's algo.* procedures,
// which cannot filter on edge properties, see the right topology.
//
// SLIM, not GRAPH.COPY: copying a tenant rebuilds its vector and full-text indexes (about 5 s at 20k nodes / 60k
// edges, blocking the tenant). A projection is built from two reads (node ids + type labels; valid edges with their
// since/until) and written back in batches into a graph with no indexes, vectors or text. Each projected node keeps
// `id` and its type label, plus `Searchable` when its type is SEARCHABLE (so "Entity" can mean the searchable types).
//
// PAGED READS: FalkorDB caps a result at RESULTSET_SIZE rows (10,000 here) and drops the rest SILENTLY, so both reads
// page. Nodes page by internal id (WHERE id(n) >= $from ORDER BY id(n) LIMIT MAX_PAGE, $from = last id + 1: FalkorDB's
// id scan returns nothing for `id(n) > -1`, so the cursor is inclusive and starts at 0). Edges are read per window of
// NODE_WINDOW source nodes (an id range FalkorDB scans directly), each window paged the same way on id(r), so the read
// stays linear in the number of edges. The source is then counted: the rows read must match count() on the source (the
// read is retried while writes land under it, then ProjectionMismatch), and the finished projection must hold exactly
// those rows. An algorithm never runs on a partial graph.
//
// CACHE: the current-edges projection is kept per graph and reused until a write lands, or until CACHE_TTL_MS passes.
// noteGraphWrite (called by upsertNode/upsertEdge/closeEdge) records a write twice: an in-process counter, and a small
// Redis key beside the graph, `allevia:graph-writes:<graph>`, set to a fresh token on every write (expiring after a
// day; an expired key only costs one rebuild). Every cached use compares both, so a write from another process (a
// CLI ingest) invalidates the server's projection on its next use, not after the TTL. If the key cannot be read, the
// counter and the TTL still apply. Writes that bypass upsert must call noteGraphWrite themselves. asOf projections are
// built per call and dropped afterwards. closeAll() drops the cached projections (onClose hook below).
//
// TIME: every read of one call (counts, pages, the algorithm itself) spends one budget, `timeoutMs` (default
// DEFAULT_READ_TIMEOUT_MS). A cached build started by one caller runs on that caller's budget.
//
// Names: `<graph>__<cur|asof>_<created, base36 ms>_<rand>`. Tenant graphs never contain "__" (graphName forbids it).
// A sweep drops projections older than STALE_PROJECTION_MS, left behind by processes that died; the cache TTL is
// shorter, so a cached projection in use is never old enough to be swept.
import { randomBytes } from "node:crypto";
import { connect, onClose, onGraphDropped, openGraphByName, readBudget, GraphHandle, MAX_PAGE } from "./client.js";
import { SEARCHABLE, typeOfLabels, type RelType } from "./schema.js";
import { currentEdge } from "./read.js";
import { ProjectionMismatch } from "./errors.js";

export type ProjectionKind = "cur" | "asof";
export interface ProjectionOpts { timeoutMs?: number }
export const STALE_PROJECTION_MS = 10 * 60_000;
export const CACHE_TTL_MS = 5 * 60_000;
export const WRITE_STAMP_TTL_MS = 24 * 60 * 60_000;
export const SEARCHABLE_LABEL = "Searchable";

const PROJECTION = /^allevia_\w+?__(?:cur|asof)_([0-9a-z]+)_[0-9a-f]{8}$/;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NODE_WINDOW = 2000; // source nodes per edge-read window
const READ_ATTEMPTS = 3;  // reads of a source that keeps changing before ProjectionMismatch
const SEARCHABLE_SET = new Set<string>(SEARCHABLE);
const log = (what: string) => (e: unknown) => console.error(`[graph] ${what}: ${(e as Error).message}`);

export function projectionName(base: string, kind: ProjectionKind, at: number = Date.now()): string {
  return `${base}__${kind}_${at.toString(36)}_${randomBytes(4).toString("hex")}`;
}

export function isProjectionName(name: string): boolean {
  return PROJECTION.test(name);
}

// Drops projections older than maxAgeMs; returns their names. Young ones may belong to a live call elsewhere.
export async function sweepProjections(maxAgeMs: number = STALE_PROJECTION_MS): Promise<string[]> {
  const db = await connect();
  const cutoff = Date.now() - maxAgeMs;
  const stale = (await db.list()).filter((n) => {
    const m = PROJECTION.exec(n);
    return m !== null && parseInt(m[1]!, 36) < cutoff;
  });
  const dropped: string[] = [];
  for (const name of stale) {
    try {
      await new GraphHandle(name, db.selectGraph(name), db).drop();
      dropped.push(name);
    } catch (e) {
      log(`could not sweep projection ${name}`)(e);
    }
  }
  return dropped;
}

let swept: Promise<unknown> | undefined;
const sweepOnce = () => (swept ??= sweepProjections().catch(log("projection sweep failed")));

// ---------- write stamps ----------

const writes = new Map<string, number>();

export const writeStampKey = (graph: string): string => `allevia:graph-writes:${graph}`;

const redis = async () => (await connect()).connection;

// The graph's current write stamp; null when no write was stamped (or the key expired, or Redis refused).
async function readStamp(graph: string): Promise<string | null> {
  try {
    const v = await (await redis()).get(writeStampKey(graph));
    return v === null || v === undefined ? null : String(v);
  } catch (e) {
    log(`could not read the write stamp of ${graph}`)(e);
    return null;
  }
}

// Marks the graph written: the cached projection is rebuilt on its next use, in this process and in any other. The
// counter moves at once; the returned promise settles once the shared stamp is set (it never rejects). Await it when
// another process must see the write before you go on.
export function noteGraphWrite(graph: string): Promise<void> {
  writes.set(graph, (writes.get(graph) ?? 0) + 1);
  const token = `${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
  return redis()
    .then((r) => r.set(writeStampKey(graph), token, { expiration: { type: "PX", value: WRITE_STAMP_TTL_MS } }))
    .then(() => undefined, log(`could not stamp a write on ${graph}`));
}

// ---------- reading the source ----------

interface NodeRow { nid: number; id: string; labels: string[] }
interface EdgeRow { rid: number; s: number; d: number; t: string; since: number | null; until: number | null }
interface Snapshot { nodes: NodeRow[]; edges: EdgeRow[] }
type Budget = () => number;

const count = async (h: GraphHandle, cypher: string, params: Record<string, unknown>, left: Budget): Promise<number> =>
  (await h.roQuery<{ c: number }>(cypher, params, { timeoutMs: left() }))[0]?.c ?? 0;

async function readNodes(g: GraphHandle, left: Budget): Promise<NodeRow[]> {
  const out: NodeRow[] = [];
  for (let from = 0; ;) {
    const page = await g.roQuery<NodeRow>(
      "MATCH (n:Entity) WHERE id(n) >= $from RETURN id(n) AS nid, n.id AS id, labels(n) AS labels ORDER BY nid LIMIT $limit",
      { from, limit: MAX_PAGE }, { timeoutMs: left() });
    for (const r of page) out.push(r);
    if (page.length < MAX_PAGE) return out;
    from = page[page.length - 1]!.nid + 1;
  }
}

// Windows are consecutive slices of the sorted node ids; the first and last are open-ended, so a node created after
// the node read still has its edges read (and trips the count check instead of vanishing).
async function readEdges(g: GraphHandle, nids: number[], where: string, params: Record<string, unknown>, left: Budget): Promise<EdgeRow[]> {
  const out: EdgeRow[] = [];
  for (let i = 0; i < nids.length; i += NODE_WINDOW) {
    const lo = i === 0 ? undefined : nids[i - 1]; // exclusive
    const hi = i + NODE_WINDOW >= nids.length ? undefined : nids[i + NODE_WINDOW - 1]; // inclusive
    const conds = [lo === undefined ? "" : "id(a) > $lo", hi === undefined ? "" : "id(a) <= $hi", "id(r) >= $from", where].filter(Boolean);
    for (let from = 0; ;) {
      const page = await g.roQuery<EdgeRow>(
        `MATCH (a:Entity)-[r]->(b:Entity) WHERE ${conds.join(" AND ")}
         RETURN id(r) AS rid, id(a) AS s, id(b) AS d, type(r) AS t, r.since AS since, r.until AS until ORDER BY rid LIMIT $limit`,
        { ...params, lo, hi, from, limit: MAX_PAGE }, { timeoutMs: left() });
      for (const r of page) out.push(r);
      if (page.length < MAX_PAGE) break;
      from = page[page.length - 1]!.rid + 1;
    }
  }
  return out;
}

// Null when the source has no entities. Throws ProjectionMismatch when the rows read never matched the source's counts.
async function readSource(g: GraphHandle, where: string, params: Record<string, unknown>, left: Budget): Promise<Snapshot | null> {
  for (let attempt = 1; ; attempt++) {
    const nodes = await readNodes(g, left);
    const edges = nodes.length ? await readEdges(g, nodes.map((n) => n.nid), where, params, left) : [];
    const nodeCount = await count(g, "MATCH (n:Entity) RETURN count(n) AS c", {}, left);
    const edgeCount = await count(g, `MATCH (a:Entity)-[r]->(b:Entity) WHERE ${where} RETURN count(r) AS c`, params, left);
    const known = new Set(nodes.map((n) => n.nid));
    const dangling = edges.filter((e) => !known.has(e.s) || !known.has(e.d)).length;
    if (nodes.length === nodeCount && edges.length === edgeCount && dangling === 0) return nodes.length ? { nodes, edges } : null;
    if (attempt >= READ_ATTEMPTS) {
      throw new ProjectionMismatch(`${g.name}: read ${nodes.length} of ${nodeCount} nodes and ${edges.length} of ${edgeCount} edges ` +
        `(${dangling} with an unread endpoint) in ${attempt} attempts: the graph kept changing, or a read was truncated`);
    }
  }
}

// ---------- building ----------

const chunks = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, (i + 1) * n));

function groupBy<T>(xs: T[], key: (x: T) => string | undefined): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    if (k === undefined) continue;
    const list = m.get(k);
    if (list) list.push(x);
    else m.set(k, [x]);
  }
  return m;
}

// Returns null when the source graph has no typed entities (nothing to project; callers run on the source).
async function buildProjection(g: GraphHandle, kind: ProjectionKind, asOf: number | undefined, rels: readonly RelType[], left: Budget): Promise<GraphHandle | null> {
  const where = `${asOf === undefined ? currentEdge("r") : currentEdge("r", "asOf")}${rels.length ? " AND type(r) IN $rels" : ""}`;
  const snap = await readSource(g, where, { asOf, rels }, left);
  // Typeless nodes (no entity label) are not projected, nor their edges; everything else must land.
  const typed = snap?.nodes.filter((n) => typeOfLabels(n.labels) !== undefined).length ?? 0;
  if (!snap || !typed) return null;
  await sweepOnce();
  const proj = await openGraphByName(projectionName(g.name, kind));
  try {
    const pid = new Map<number, number>();
    for (const [type, rows] of groupBy(snap.nodes, (n) => typeOfLabels(n.labels))) {
      const labels = `Entity:${type}${SEARCHABLE_SET.has(type) ? `:${SEARCHABLE_LABEL}` : ""}`;
      for (const part of chunks(rows, MAX_PAGE)) {
        const out = await proj.query<{ nid: number; pid: number }>(
          `UNWIND $rows AS r CREATE (n:${labels} {id: r.id}) RETURN r.nid AS nid, id(n) AS pid`,
          { rows: part.map((n) => ({ nid: n.nid, id: n.id })) });
        for (const o of out) pid.set(o.nid, o.pid);
      }
    }
    for (const [type, rows] of groupBy(snap.edges, (e) => e.t)) {
      if (!IDENT.test(type)) throw new ProjectionMismatch(`${g.name}: cannot project relationship type ${JSON.stringify(type)}`);
      const mapped = rows.filter((e) => pid.has(e.s) && pid.has(e.d))
        .map((e) => ({ s: pid.get(e.s)!, d: pid.get(e.d)!, since: e.since, until: e.until }));
      for (const part of chunks(mapped, MAX_PAGE)) {
        await proj.query(
          `UNWIND $rows AS r MATCH (a) WHERE id(a) = r.s MATCH (b) WHERE id(b) = r.d
           CREATE (a)-[e:${type}]->(b) SET e.since = r.since, e.until = r.until`, { rows: part });
      }
    }
    const typedEdges = snap.edges.filter((e) => pid.has(e.s) && pid.has(e.d)).length;
    const [pn, pe] = [await count(proj, "MATCH (n) RETURN count(n) AS c", {}, left), await count(proj, "MATCH ()-[r]->() RETURN count(r) AS c", {}, left)];
    if (pn !== typed || pe !== typedEdges) {
      throw new ProjectionMismatch(`${proj.name}: holds ${pn} nodes and ${pe} edges, expected ${typed} and ${typedEdges}`);
    }
    return proj;
  } catch (e) {
    await proj.drop().catch(log(`could not drop half-built projection ${proj.name}`));
    throw e;
  }
}

// ---------- the cached current-edges projection ----------

interface Cached {
  handle: GraphHandle | null;
  writes: number;        // the in-process write counter when the build started
  stamp: string | null;  // the shared write stamp when the build started
  builtAt: number;
  users: number;
  retired: boolean;
  dropped: boolean;
}
const cache = new Map<string, Promise<Cached>>();

function dropIfUnused(c: Cached): Promise<void> {
  if (!c.retired || c.users > 0 || !c.handle || c.dropped) return Promise.resolve();
  c.dropped = true;
  return c.handle.drop().catch(log(`could not drop projection ${c.handle.name}`));
}

function retire(c: Cached): Promise<void> {
  c.retired = true;
  return dropIfUnused(c);
}

async function acquire(g: GraphHandle, left: Budget): Promise<Cached> {
  const stamp = await readStamp(g.name);
  const p = cache.get(g.name);
  if (p) {
    const c = await p.catch(() => undefined);
    if (c && !c.retired && c.writes === (writes.get(g.name) ?? 0) && c.stamp === stamp && Date.now() - c.builtAt < CACHE_TTL_MS) {
      c.users++;
      return c;
    }
    if (cache.get(g.name) === p) {
      cache.delete(g.name);
      if (c) void retire(c);
    }
  }
  let next = cache.get(g.name); // another caller may already be rebuilding
  if (!next) {
    const seen = writes.get(g.name) ?? 0;
    const building = buildProjection(g, "cur", undefined, [], left)
      .then((handle): Cached => ({ handle, writes: seen, stamp, builtAt: Date.now(), users: 0, retired: false, dropped: false }));
    next = building;
    cache.set(g.name, building);
    building.catch(() => { if (cache.get(g.name) === building) cache.delete(g.name); });
  }
  const c = await next;
  c.users++;
  return c;
}

function release(c: Cached): void {
  c.users--;
  void dropIfUnused(c);
}

// Dropping a graph (GraphHandle.drop) also drops its projections: forget the cache entry, the counter and the stamp.
onGraphDropped(async (name) => {
  if (isProjectionName(name)) return;
  const p = cache.get(name);
  cache.delete(name);
  writes.delete(name);
  p?.then((c) => { c.retired = true; c.dropped = true; }, () => {});
  try {
    await (await redis()).del(writeStampKey(name));
  } catch (e) {
    log(`could not delete the write stamp of ${name}`)(e);
  }
});

// Shutdown: drop every cached projection this process holds. One still in use is dropped when its user finishes.
export async function dropCachedProjections(): Promise<void> {
  const all = [...cache.values()];
  cache.clear();
  const drops: Array<Promise<void>> = [];
  for (const p of all) {
    const c = await p.catch(() => undefined);
    if (c) drops.push(retire(c));
  }
  await Promise.all(drops);
}

onClose(dropCachedProjections);

// ---------- entry point ----------

// Runs `fn` on a graph whose edges are exactly those valid now (asOf undefined: the cached projection) or at asOf
// (a per-call projection, skipped when every edge of `rels` was valid then). An empty source graph runs as is.
// `fn` gets the budget too: pass `left()` as the timeoutMs of its own reads.
export async function onEdgesValidAt<T>(
  g: GraphHandle, asOf: number | undefined, rels: readonly RelType[],
  fn: (h: GraphHandle, left: () => number) => Promise<T>, opts: ProjectionOpts = {},
): Promise<T> {
  const left = readBudget(opts.timeoutMs);
  if (asOf === undefined) {
    for (let attempt = 0; ; attempt++) {
      const c = await acquire(g, left);
      try {
        return await fn(c.handle ?? g, left);
      } catch (e) {
        // the projection vanished under us (swept or dropped elsewhere): rebuild once
        if (attempt === 0 && c.handle && /empty key/i.test((e as Error).message)) {
          void retire(c);
          continue;
        }
        throw e;
      } finally {
        release(c);
      }
    }
  }
  const stale = await count(g,
    `MATCH ()-[r]->() WHERE NOT (${currentEdge("r", "asOf")})${rels.length ? " AND type(r) IN $rels" : ""} RETURN count(r) AS c`, { asOf, rels }, left);
  if (!stale) return fn(g, left);
  const proj = await buildProjection(g, "asof", asOf, rels, left);
  if (!proj) return fn(g, left);
  try {
    return await fn(proj, left);
  } finally {
    // never let a failed drop hide the algorithm's own error; a later sweep collects the orphan
    await proj.drop().catch(log(`could not drop projection ${proj.name}`));
  }
}
