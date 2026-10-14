// Projections: throwaway graphs that hold only the edges valid "now" (or at asOf), so FalkorDB's algo.* procedures,
// which cannot filter on edge properties, see the right topology.
//
// SLIM, not GRAPH.COPY: copying a tenant rebuilds its vector and full-text indexes (about 5 s at 20k nodes / 60k
// edges, blocking the tenant). A projection is built from two reads (node ids + type labels; valid edges with their
// since/until) and written back in batches into a graph with no indexes, vectors or text. Each projected node keeps
// `id` and its type label, plus `Searchable` when its type is SEARCHABLE (so "Entity" can mean the searchable types).
//
// CACHE: the current-edges projection is kept per graph and reused until a write lands, or until CACHE_TTL_MS passes.
// Writes are counted IN PROCESS (noteGraphWrite, called by upsertNode/upsertEdge/closeEdge). That is enough for the
// server (one process). A write from another process (a CLI ingest) shows up when the TTL expires. Writes that
// bypass upsert must call noteGraphWrite themselves. asOf projections are built per call and dropped afterwards.
//
// Names: `<graph>__<cur|asof>_<created, base36 ms>_<rand>`. Tenant graphs never contain "__" (graphName forbids it).
// A sweep drops projections older than STALE_PROJECTION_MS, left behind by processes that died; the cache TTL is
// shorter, so a cached projection in use is never old enough to be swept.
import { randomBytes } from "node:crypto";
import { connect, onGraphDropped, openGraphByName, GraphHandle } from "./client.js";
import { SEARCHABLE, typeOfLabels, type RelType } from "./schema.js";
import { currentEdge } from "./read.js";

export type ProjectionKind = "cur" | "asof";
export const STALE_PROJECTION_MS = 10 * 60_000;
export const CACHE_TTL_MS = 5 * 60_000;
export const SEARCHABLE_LABEL = "Searchable";

const PROJECTION = /^allevia_\w+?__(?:cur|asof)_([0-9a-z]+)_[0-9a-f]{8}$/;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BATCH = 5000;
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

// ---------- write counter ----------

const writes = new Map<string, number>();

export function noteGraphWrite(graph: string): void {
  writes.set(graph, (writes.get(graph) ?? 0) + 1);
}

// ---------- building ----------

const chunks = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, (i + 1) * n));

function groupBy<T>(xs: T[], key: (x: T) => string | undefined): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    if (k !== undefined) m.set(k, [...(m.get(k) ?? []), x]);
  }
  return m;
}

// Returns null when the source graph has no entities (nothing to project; callers run on the source).
async function buildProjection(g: GraphHandle, kind: ProjectionKind, asOf: number | undefined, rels: readonly RelType[]): Promise<GraphHandle | null> {
  const nodes = await g.roQuery<{ nid: number; id: string; labels: string[] }>(
    "MATCH (n:Entity) RETURN id(n) AS nid, n.id AS id, labels(n) AS labels");
  if (!nodes.length) return null;
  const valid = asOf === undefined ? currentEdge("r") : currentEdge("r", "asOf");
  const edges = await g.roQuery<{ s: number; d: number; t: string; since: number | null; until: number | null }>(
    `MATCH (a:Entity)-[r]->(b:Entity) WHERE ${valid}${rels.length ? " AND type(r) IN $rels" : ""}
     RETURN id(a) AS s, id(b) AS d, type(r) AS t, r.since AS since, r.until AS until`, { asOf, rels });
  await sweepOnce();
  const proj = await openGraphByName(projectionName(g.name, kind));
  try {
    const pid = new Map<number, number>();
    for (const [type, rows] of groupBy(nodes, (n) => typeOfLabels(n.labels))) {
      const labels = `Entity:${type}${SEARCHABLE_SET.has(type) ? `:${SEARCHABLE_LABEL}` : ""}`;
      for (const part of chunks(rows, BATCH)) {
        const out = await proj.query<{ nid: number; pid: number }>(
          `UNWIND $rows AS r CREATE (n:${labels} {id: r.id}) RETURN r.nid AS nid, id(n) AS pid`,
          { rows: part.map((n) => ({ nid: n.nid, id: n.id })) });
        for (const o of out) pid.set(o.nid, o.pid);
      }
    }
    for (const [type, rows] of groupBy(edges, (e) => (IDENT.test(e.t) ? e.t : undefined))) {
      const mapped = rows.filter((e) => pid.has(e.s) && pid.has(e.d))
        .map((e) => ({ s: pid.get(e.s)!, d: pid.get(e.d)!, since: e.since, until: e.until }));
      for (const part of chunks(mapped, BATCH)) {
        await proj.query(
          `UNWIND $rows AS r MATCH (a) WHERE id(a) = r.s MATCH (b) WHERE id(b) = r.d
           CREATE (a)-[e:${type}]->(b) SET e.since = r.since, e.until = r.until`, { rows: part });
      }
    }
    return proj;
  } catch (e) {
    await proj.drop().catch(log(`could not drop half-built projection ${proj.name}`));
    throw e;
  }
}

// ---------- the cached current-edges projection ----------

interface Cached { handle: GraphHandle | null; writes: number; builtAt: number; users: number; retired: boolean }
const cache = new Map<string, Promise<Cached>>();

function dropIfUnused(c: Cached): void {
  if (c.retired && c.users === 0 && c.handle) void c.handle.drop().catch(log(`could not drop projection ${c.handle.name}`));
}

function retire(c: Cached): void {
  c.retired = true;
  dropIfUnused(c);
}

async function acquire(g: GraphHandle): Promise<Cached> {
  const p = cache.get(g.name);
  if (p) {
    const c = await p.catch(() => undefined);
    if (c && !c.retired && c.writes === (writes.get(g.name) ?? 0) && Date.now() - c.builtAt < CACHE_TTL_MS) {
      c.users++;
      return c;
    }
    if (cache.get(g.name) === p) {
      cache.delete(g.name);
      if (c) retire(c);
    }
  }
  let next = cache.get(g.name); // another caller may already be rebuilding
  if (!next) {
    const seen = writes.get(g.name) ?? 0;
    const building = buildProjection(g, "cur", undefined, [])
      .then((handle): Cached => ({ handle, writes: seen, builtAt: Date.now(), users: 0, retired: false }));
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
  dropIfUnused(c);
}

// Dropping a graph (GraphHandle.drop) also drops its projections; forget the cache entry and the counter.
onGraphDropped((name) => {
  const p = cache.get(name);
  cache.delete(name);
  writes.delete(name);
  p?.then((c) => { c.retired = true; }, () => {});
});

// Server shutdown: drop every cached projection this process holds (in-flight users finish first).
export async function dropCachedProjections(): Promise<void> {
  const all = [...cache.values()];
  cache.clear();
  for (const p of all) {
    const c = await p.catch(() => undefined);
    if (c) retire(c);
  }
}

// ---------- entry point ----------

// Runs `fn` on a graph whose edges are exactly those valid now (asOf undefined: the cached projection) or at asOf
// (a per-call projection, skipped when every edge of `rels` was valid then). An empty source graph runs as is.
export async function onEdgesValidAt<T>(g: GraphHandle, asOf: number | undefined, rels: readonly RelType[], fn: (h: GraphHandle) => Promise<T>): Promise<T> {
  if (asOf === undefined) {
    for (let attempt = 0; ; attempt++) {
      const c = await acquire(g);
      try {
        return await fn(c.handle ?? g);
      } catch (e) {
        // the projection vanished under us (swept or dropped elsewhere): rebuild once
        if (attempt === 0 && c.handle && /empty key/i.test((e as Error).message)) {
          retire(c);
          continue;
        }
        throw e;
      } finally {
        release(c);
      }
    }
  }
  const [row] = await g.roQuery<{ c: number }>(
    `MATCH ()-[r]->() WHERE NOT (${currentEdge("r", "asOf")})${rels.length ? " AND type(r) IN $rels" : ""} RETURN count(r) AS c`, { asOf, rels });
  if (!row?.c) return fn(g);
  const proj = await buildProjection(g, "asof", asOf, rels);
  if (!proj) return fn(g);
  try {
    return await fn(proj);
  } finally {
    // never let a failed drop hide the algorithm's own error; a later sweep collects the orphan
    await proj.drop().catch(log(`could not drop projection ${proj.name}`));
  }
}
