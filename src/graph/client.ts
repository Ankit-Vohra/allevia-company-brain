// FalkorDB access. One client per URL (shared by every graph), one graph per tenant (`allevia_<slug>`).
// GraphHandle is the only door to a graph: `query` for writes, `roQuery` (GRAPH.RO_QUERY) for anything the agent
// asks, which the server itself refuses to run if it would write.
//
// Timeouts: `timeoutMs` becomes FalkorDB's per-query TIMEOUT, enforced server-side. FalkorDB 6.0 applies it to
// read-only queries only; write queries ignore it (verified in scripts/spikes/falkordb-graph-core.ts), so writes are
// never cut off half-way. roQuery defaults to DEFAULT_READ_TIMEOUT_MS.
//
// Params: the client inlines params as a `CYPHER k=v …` prefix. Lists and maps work (so `SET n += $props` works);
// map keys must be plain identifiers, numbers must be finite, and undefined values are dropped.
import { randomBytes } from "node:crypto";
import { FalkorDB, type Graph } from "falkordb";
import { loadConfig } from "../config.js";

export const DEFAULT_READ_TIMEOUT_MS = 15_000;

type Param = null | string | number | boolean | Param[] | { [k: string]: Param };
type Params = Record<string, Param>;
export interface QueryOpts { timeoutMs?: number }

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const GRAPH_NAME = /^[A-Za-z0-9_]+$/;

// Tenant slugs are lowercase words joined by single underscores. "__" is reserved: projection graphs are named
// `<graph>__<kind>_…`, and listGraphs/sweeps rely on no real graph containing it.
const TENANT_SLUG = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

export function graphName(tenant: string): string {
  if (!TENANT_SLUG.test(tenant)) throw new Error(`tenant slug must be lowercase words joined by single "_", got ${JSON.stringify(tenant)}`);
  return `allevia_${tenant}`;
}

function cleanParam(v: unknown, path: string): Param | undefined {
  if (v === undefined) return undefined;
  if (v === null || typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`param ${path} must be a finite number, got ${v}`);
    return v;
  }
  if (Array.isArray(v)) return v.map((x, i) => cleanParam(x, `${path}[${i}]`) ?? null);
  if (typeof v === "object") {
    const out: Record<string, Param> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (!IDENT.test(k)) throw new Error(`param key ${JSON.stringify(k)} in ${path} is not a plain identifier`);
      const c = cleanParam(x, `${path}.${k}`);
      if (c !== undefined) out[k] = c;
    }
    return out;
  }
  throw new Error(`param ${path} has unsupported type ${typeof v}`);
}

type FalkorQueryOptions = NonNullable<Parameters<Graph["query"]>[1]>;

function toOptions(params: Record<string, unknown> | undefined, timeoutMs: number | undefined): FalkorQueryOptions {
  const opts: { params?: Params; TIMEOUT?: number } = {};
  if (params && Object.keys(params).length) opts.params = cleanParam(params, "$") as Params;
  if (timeoutMs !== undefined) opts.TIMEOUT = Math.max(1, Math.round(timeoutMs));
  return opts;
}

export class GraphHandle {
  readonly name: string;
  readonly #g: Graph;
  readonly #db: FalkorDB | undefined;

  constructor(name: string, g: Graph, db?: FalkorDB) {
    this.name = name;
    this.#g = g;
    this.#db = db;
  }

  async query<T = Record<string, unknown>>(cypher: string, params?: Record<string, unknown>, opts?: QueryOpts): Promise<T[]> {
    const opt = toOptions(params, opts?.timeoutMs);
    const r = await this.#g.query<T>(cypher, opt);
    return r.data ?? [];
  }

  async roQuery<T = Record<string, unknown>>(cypher: string, params?: Record<string, unknown>, opts?: QueryOpts): Promise<T[]> {
    const opt = toOptions(params, opts?.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS);
    const r = await this.#g.roQuery<T>(cypher, opt);
    return r.data ?? [];
  }

  // Deletes the whole graph. Dropping a graph that does not exist (never written, or already dropped) is a no-op.
  async drop(): Promise<void> {
    try {
      await this.#g.delete();
    } catch (e) {
      if (/empty key|no such|not exist/i.test(String((e as Error).message))) return;
      throw e;
    }
  }

  // GRAPH.COPY into a new graph (used for throwaway projections, e.g. "current edges only" for algorithms).
  async copyTo(dest: string): Promise<GraphHandle> {
    if (!GRAPH_NAME.test(dest)) throw new Error(`bad graph name ${JSON.stringify(dest)}`);
    await this.#g.copy(dest);
    const db = this.#db ?? (await connect());
    return new GraphHandle(dest, db.selectGraph(dest), db);
  }
}

const pool = new Map<string, Promise<FalkorDB>>();

export async function connect(url?: string): Promise<FalkorDB> {
  const u = url ?? loadConfig().falkordbUrl;
  let p = pool.get(u);
  if (!p) {
    p = FalkorDB.connect({ url: u }).then((db) => {
      // Without a listener an 'error' event would crash the process; the client reconnects on its own.
      db.on("error", (err: Error) => console.error(`[falkordb] ${err.message}`));
      return db;
    });
    pool.set(u, p);
    p.catch(() => pool.delete(u));
  }
  return p;
}

export async function openGraphByName(name: string): Promise<GraphHandle> {
  if (!GRAPH_NAME.test(name)) throw new Error(`bad graph name ${JSON.stringify(name)}`);
  const db = await connect();
  return new GraphHandle(name, db.selectGraph(name), db);
}

export async function openGraph(tenant: string): Promise<GraphHandle> {
  return openGraphByName(graphName(tenant));
}

// Throwaway projections (see algorithms.ts) are named `<graph>__<kind>_<created, base36 ms>_<rand>` so a sweep can
// tell an orphan (its process died mid-call) from one a live call in another process is still using.
export type ProjectionKind = "cur" | "asof";
const PROJECTION = /^allevia_\w+?__(?:cur|asof)_([0-9a-z]+)_[0-9a-f]{8}$/;
export const STALE_PROJECTION_MS = 10 * 60_000;

export function projectionName(base: string, kind: ProjectionKind, at: number = Date.now()): string {
  return `${base}__${kind}_${at.toString(36)}_${randomBytes(4).toString("hex")}`;
}

export function isProjectionName(name: string): boolean {
  return PROJECTION.test(name);
}

// Drops projections older than maxAgeMs; returns their names. Young ones are left alone.
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
      console.error(`[graph] could not sweep projection ${name}: ${(e as Error).message}`);
    }
  }
  return dropped;
}

// Real graphs only: projections are an implementation detail of the algorithms.
export async function listGraphs(): Promise<string[]> {
  return (await (await connect()).list()).filter((n) => !isProjectionName(n));
}

export async function closeAll(): Promise<void> {
  const all = [...pool.values()];
  pool.clear();
  await Promise.allSettled(all.map(async (p) => (await p).close()));
}
