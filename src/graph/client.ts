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

  // Deletes the whole graph, and its projections (`<name>__…`). Dropping a graph that does not exist (never written,
  // or already dropped) is a no-op.
  async drop(): Promise<void> {
    try {
      await this.#g.delete();
    } catch (e) {
      if (!/empty key|no such|not exist/i.test(String((e as Error).message))) throw e;
    }
    const db = this.#db ?? (await connect());
    for (const child of (await db.list()).filter((n) => n.startsWith(`${this.name}__`))) {
      await new GraphHandle(child, db.selectGraph(child), db).drop();
    }
    for (const fn of dropListeners) fn(this.name);
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

// Real graphs only. Projections (see projection.ts) are named `<graph>__…`, and no real graph contains "__".
export async function listGraphs(): Promise<string[]> {
  return (await (await connect()).list()).filter((n) => !n.includes("__"));
}

// Called with a graph's name after GraphHandle.drop(); projection.ts uses it to forget its cache.
const dropListeners: Array<(name: string) => void> = [];
export function onGraphDropped(fn: (name: string) => void): void {
  dropListeners.push(fn);
}

export async function closeAll(): Promise<void> {
  const all = [...pool.values()];
  pool.clear();
  await Promise.allSettled(all.map(async (p) => (await p).close()));
}
