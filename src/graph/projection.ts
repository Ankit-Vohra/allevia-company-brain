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
// stays linear in the number of edges. Internal ids are safe cursors because nothing ever deletes from a tenant graph
// (upserts only add and close; FalkorDB reuses the ids of DELETED entities only): an entity created during a read gets
// a fresh, higher id, so it is either read or caught by the checks below, never mistaken for another.
//
// CONSISTENT READS: a read is several queries, and writes can land between them. It is accepted only when the rows
// read match count() on the source AND the graph's write mark (in-process counter + shared stamp, below) is the same
// before and after it, so writes that cancel out in the counts (one edge closed, another opened) are caught too. (A
// write is marked just after it commits, so one committing at the very end of a read can slip past; its mark then
// makes the next use rebuild.) Otherwise it is retried with growing, jittered pauses until half the call's budget is spent (the rest is kept for
// the build and the algorithm), then ProjectionMismatch. The finished projection must hold exactly the rows read. An
// algorithm never runs on a partial graph. When the current-edges projection cannot settle (a busy ingest), the call
// runs on the last good cached one instead, if it is still young, and says so (`stale: true`).
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
// DEFAULT_READ_TIMEOUT_MS); settling a read may use up to SETTLE_SHARE of it. A cached build started by one caller
// runs on that caller's budget.
//
// Names: `<graph>__<cur|asof>_<created, base36 ms>_<rand>`. Tenant graphs never contain "__" (graphName forbids it).
// A sweep drops projections older than STALE_PROJECTION_MS, left behind by processes that died; the cache TTL is
// shorter, and a stale fallback is only used while younger than FALLBACK_MAX_AGE_MS, so a cached projection in use is
// never old enough to be swept.
import { randomBytes } from "node:crypto";
import {
  connect, onClose, onGraphDropped, openGraphByName, readBudget, GraphHandle, DEFAULT_READ_TIMEOUT_MS, MAX_PAGE,
} from "./client.js";
import { SEARCHABLE, typeOfLabels, type RelType } from "./schema.js";
import { currentEdge } from "./read.js";
import { ProjectionMismatch } from "./errors.js";

export type ProjectionKind = "cur" | "asof";
export interface ProjectionOpts { timeoutMs?: number }
// stale: the source kept changing while it was read, so the call ran on the last good (older) projection.
export interface ProjectionInfo { stale: boolean }
export const STALE_PROJECTION_MS = 10 * 60_000;
export const CACHE_TTL_MS = 5 * 60_000;
export const WRITE_STAMP_TTL_MS = 24 * 60 * 60_000;
export const SEARCHABLE_LABEL = "Searchable";

const PROJECTION = /^allevia_\w+?__(?:cur|asof)_([0-9a-z]+)_[0-9a-f]{8}$/;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NODE_WINDOW = 2000; // source nodes per edge-read window
const SETTLE_SHARE = 0.5;  // share of a call's budget that retries of an inconsistent read may use
const BACKOFF_MS = 20;     // first pause between read attempts; doubles, jittered, up to BACKOFF_MAX_MS
const BACKOFF_MAX_MS = 500;
const FALLBACK_MAX_AGE_MS = STALE_PROJECTION_MS - 60_000; // a fallback must not be old enough to be swept mid-use
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

// The graph's write mark: changes with every noteGraphWrite, in this process or another.
interface WriteMark { writes: number; stamp: string | null }
const writeMark = async (graph: string): Promise<WriteMark> => ({ writes: writes.get(graph) ?? 0, stamp: await readStamp(graph) });
const sameMark = (a: WriteMark, b: WriteMark): boolean => a.writes === b.writes && a.stamp === b.stamp;

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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// One consistent read of the source (see CONSISTENT READS), with the write mark it reflects; `snap` is null when the
// source has no entities. Throws ProjectionMismatch when no read settled before `settleBy`. The reads themselves stop
// at `settleBy` too (their server-side timeout), so a slow or busy server never eats the share kept for the rest.
async function readSource(
  g: GraphHandle, where: string, params: Record<string, unknown>, left: Budget, settleBy: number,
): Promise<{ snap: Snapshot | null; mark: WriteMark }> {
  const unsettled = (attempt: number, why: string) =>
    new ProjectionMismatch(`${g.name}: timed out before a consistent read (${attempt} attempts, until half the budget): ${why}`);
  const until: Budget = () => {
    const ms = Math.min(left(), settleBy - Date.now());
    if (ms < 1) throw unsettled(0, "no time left to read");
    return ms;
  };
  for (let attempt = 1; ; attempt++) {
    let nodes: NodeRow[], edges: EdgeRow[], nodeCount: number, edgeCount: number, before: WriteMark, after: WriteMark;
    try {
      before = await writeMark(g.name);
      nodes = await readNodes(g, until);
      edges = nodes.length ? await readEdges(g, nodes.map((n) => n.nid), where, params, until) : [];
      nodeCount = await count(g, "MATCH (n:Entity) RETURN count(n) AS c", {}, until);
      edgeCount = await count(g, `MATCH (a:Entity)-[r]->(b:Entity) WHERE ${where} RETURN count(r) AS c`, params, until);
      after = await writeMark(g.name);
    } catch (e) {
      if (e instanceof ProjectionMismatch || /timed out/i.test((e as Error).message)) throw unsettled(attempt, "the read did not finish in time");
      throw e;
    }
    const known = new Set(nodes.map((n) => n.nid));
    const dangling = edges.filter((e) => !known.has(e.s) || !known.has(e.d)).length;
    const quiet = sameMark(before, after);
    if (quiet && nodes.length === nodeCount && edges.length === edgeCount && dangling === 0) {
      return { snap: nodes.length ? { nodes, edges } : null, mark: before };
    }
    const pause = Math.min(BACKOFF_MAX_MS, BACKOFF_MS * 2 ** (attempt - 1)) * (0.5 + Math.random() / 2);
    if (Date.now() + pause >= settleBy) {
      throw unsettled(attempt, `last read ${nodes.length} of ${nodeCount} nodes and ${edges.length} of ${edgeCount} edges ` +
        `(${dangling} with an unread endpoint), ${quiet ? "no write" : "a write"} during it: the graph kept changing, or a read was truncated`);
    }
    await sleep(pause);
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

// `handle` is null when the source graph has no typed entities (nothing to project; callers run on the source).
async function buildProjection(
  g: GraphHandle, kind: ProjectionKind, asOf: number | undefined, rels: readonly RelType[], left: Budget, settleBy: number,
): Promise<{ handle: GraphHandle | null; mark: WriteMark }> {
  const where = `${asOf === undefined ? currentEdge("r") : currentEdge("r", "asOf")}${rels.length ? " AND type(r) IN $rels" : ""}`;
  const { snap, mark } = await readSource(g, where, { asOf, rels }, left, settleBy);
  // Typeless nodes (no entity label) are not projected, nor their edges; everything else must land.
  const typed = snap?.nodes.filter((n) => typeOfLabels(n.labels) !== undefined).length ?? 0;
  if (!snap || !typed) return { handle: null, mark };
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
    return { handle: proj, mark };
  } catch (e) {
    await proj.drop().catch(log(`could not drop half-built projection ${proj.name}`));
    throw e;
  }
}

// ---------- the cached current-edges projection ----------

interface Cached {
  handle: GraphHandle | null;
  mark: WriteMark;  // the source's write mark its read reflects
  builtAt: number;
  users: number;
  retired: boolean; // replaced or forgotten: dropped once its last user is done
  dropped: boolean;
}
const current = new Map<string, Cached>();            // the last good projection of each graph
const building = new Map<string, Promise<Cached>>();  // the rebuild in flight, shared by every caller that needs it

function dropIfUnused(c: Cached): Promise<void> {
  if (!c.retired || c.users > 0 || !c.handle || c.dropped) return Promise.resolve();
  c.dropped = true;
  return c.handle.drop().catch(log(`could not drop projection ${c.handle.name}`));
}

function retire(c: Cached): Promise<void> {
  c.retired = true;
  return dropIfUnused(c);
}

function forget(graph: string, c: Cached): Promise<void> {
  if (current.get(graph) === c) current.delete(graph);
  return retire(c);
}

const fresh = (c: Cached, mark: WriteMark): boolean => !c.retired && sameMark(c.mark, mark) && Date.now() - c.builtAt < CACHE_TTL_MS;
const usableFallback = (c: Cached | undefined): c is Cached =>
  c !== undefined && !c.retired && c.handle !== null && Date.now() - c.builtAt < FALLBACK_MAX_AGE_MS;

async function acquire(g: GraphHandle, left: Budget, settleBy: number): Promise<{ c: Cached; stale: boolean }> {
  const last = current.get(g.name);
  if (last && fresh(last, await writeMark(g.name))) {
    last.users++;
    return { c: last, stale: false };
  }
  let next = building.get(g.name); // another caller may already be rebuilding
  if (!next) {
    const build: Promise<Cached> = buildProjection(g, "cur", undefined, [], left, settleBy)
      .then(({ handle, mark }) => {
        const c: Cached = { handle, mark, builtAt: Date.now(), users: 0, retired: false, dropped: false };
        if (building.get(g.name) === build) { // still wanted: the graph was not dropped, nor the cache cleared
          const prev = current.get(g.name);
          current.set(g.name, c);
          if (prev) void retire(prev);
        } else {
          c.retired = true; // its callers use it, then it is dropped
        }
        return c;
      })
      .finally(() => { if (building.get(g.name) === build) building.delete(g.name); });
    building.set(g.name, build);
    next = build;
  }
  try {
    const c = await next;
    c.users++;
    return { c, stale: false };
  } catch (e) {
    // The source kept changing: run on the last good projection rather than fail, and say so.
    const fallback = current.get(g.name);
    if (e instanceof ProjectionMismatch && usableFallback(fallback)) {
      fallback.users++;
      return { c: fallback, stale: true };
    }
    throw e;
  }
}

function release(c: Cached): void {
  c.users--;
  void dropIfUnused(c);
}

// Dropping a graph (GraphHandle.drop) also drops its projections: forget the cache entries, the counter and the stamp.
onGraphDropped(async (name) => {
  if (isProjectionName(name)) return;
  const c = current.get(name);
  current.delete(name);
  building.delete(name);
  writes.delete(name);
  if (c) {
    c.retired = true;
    c.dropped = true;
  }
  try {
    await (await redis()).del(writeStampKey(name));
  } catch (e) {
    log(`could not delete the write stamp of ${name}`)(e);
  }
});

// Shutdown: drop every cached projection this process holds. One still in use is dropped when its user finishes.
export async function dropCachedProjections(): Promise<void> {
  const done = [...current.values()];
  const pending = [...building.values()];
  current.clear();
  building.clear();
  await Promise.all([...done.map(retire), ...pending.map((p) => p.then(retire, () => {}))]);
}

onClose(dropCachedProjections);

// ---------- entry point ----------

// Runs `fn` on a graph whose edges are exactly those valid now (asOf undefined: the cached projection) or at asOf
// (a per-call projection, skipped when every edge of `rels` was valid then). An empty source graph runs as is.
// `fn` gets the budget too (pass `left()` as the timeoutMs of its own reads), and `info.stale` when it runs on the last
// good projection because the source would not hold still (current edges only; an asOf call throws instead).
export async function onEdgesValidAt<T>(
  g: GraphHandle, asOf: number | undefined, rels: readonly RelType[],
  fn: (h: GraphHandle, left: () => number, info: ProjectionInfo) => Promise<T>, opts: ProjectionOpts = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
  const left = readBudget(timeoutMs);
  const settleBy = Date.now() + timeoutMs * SETTLE_SHARE;
  if (asOf === undefined) {
    for (let attempt = 0; ; attempt++) {
      const { c, stale } = await acquire(g, left, settleBy);
      try {
        return await fn(c.handle ?? g, left, { stale });
      } catch (e) {
        // the projection vanished under us (swept or dropped elsewhere): rebuild once
        if (attempt === 0 && c.handle && /empty key|deleted or replaced/i.test((e as Error).message)) {
          void forget(g.name, c);
          continue;
        }
        throw e;
      } finally {
        release(c);
      }
    }
  }
  const notValid = await count(g,
    `MATCH ()-[r]->() WHERE NOT (${currentEdge("r", "asOf")})${rels.length ? " AND type(r) IN $rels" : ""} RETURN count(r) AS c`, { asOf, rels }, left);
  if (!notValid) return fn(g, left, { stale: false });
  const { handle: proj } = await buildProjection(g, "asof", asOf, rels, left, settleBy);
  if (!proj) return fn(g, left, { stale: false });
  try {
    return await fn(proj, left, { stale: false });
  } finally {
    // never let a failed drop hide the algorithm's own error; a later sweep collects the orphan
    await proj.drop().catch(log(`could not drop projection ${proj.name}`));
  }
}
