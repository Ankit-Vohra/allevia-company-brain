// FalkorDB access. One client per URL (shared by every graph), one graph per tenant (`allevia_<slug>`).
// GraphHandle is the only door to a graph: `query` for writes, `roQuery` (GRAPH.RO_QUERY) for anything the agent
// asks, which the server itself refuses to run if it would write.
//
// Timeouts: `timeoutMs` becomes FalkorDB's per-query TIMEOUT, enforced server-side. FalkorDB 6.0 applies it to
// read-only queries only; write queries ignore it (verified in scripts/spikes/falkordb-graph-core.ts), so writes are
// never cut off half-way. roQuery defaults to DEFAULT_READ_TIMEOUT_MS. A call made of several reads (a projection
// build, an algorithm) spends one budget across all of them: see `readBudget`.
//
// Result size: FalkorDB caps every result at RESULTSET_SIZE rows (10,000 on our servers) and drops the rest
// SILENTLY. A read whose row count grows with the graph must page (MAX_PAGE rows at a time, keyed on an ordered
// column) or pack its rows into lists; projection.ts, algorithms.ts and tenants.ts do.
//
// Busy server: FalkorDB refuses a query outright when MAX_QUEUED_QUERIES (25 here) are already waiting ("Max pending
// queries exceeded"). Such a query never ran, so it is sent again after a short, growing, jittered pause: a read within
// its own timeout (the time spent waiting comes off the TIMEOUT it is sent with; a read the server never admits in
// time fails as timed out), a write for up to WRITE_QUEUE_WAIT_MS.
//
// Params: the client inlines params as a `CYPHER k=v …` prefix. Lists and maps work (so `SET n += $props` works);
// map keys must be plain identifiers, numbers must be finite (subnormals are sent as 0), and undefined values are
// dropped.
//
// Crash shapes: FalkorDB 6.0.2 panics, restarts and drops every unsaved write when it sorts rows that tie, or a NaN.
// A query whose text has either shape is refused with UnsafeQuery before it is sent (safety.ts; the evidence is in
// docs/notes/falkordb-nan-crash.md). `unchecked` skips the check, for crash experiments on a throwaway server only:
// tests/graph/cypher-sources.test.ts fails if anything in src/ uses it.
import { FalkorDB, type Graph } from "falkordb";
import { loadConfig } from "../config.js";
import { assertSafeQuery } from "./safety.js";

export const DEFAULT_READ_TIMEOUT_MS = 15_000;
// Rows per page for reads that page: well under RESULTSET_SIZE (10,000), so a page is never truncated.
export const MAX_PAGE = 5000;
export const WRITE_QUEUE_WAIT_MS = 30_000;
const BUSY = /max pending queries exceeded/i;

type Param = null | string | number | boolean | Param[] | { [k: string]: Param };
type Params = Record<string, Param>;
export interface QueryOpts { timeoutMs?: number; unchecked?: boolean }

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MIN_NORMAL = 2.2250738585072014e-308; // the smallest double the server's parser accepts
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
    // The server's parser refuses a subnormal double ("Float overflow '5e-324'"), and a decaying weight can reach one.
    return Math.abs(v) < MIN_NORMAL ? 0 : v;
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

// Sends `run(msLeft)` until the server admits it (see "Busy server" above), for at most `windowMs`.
async function admitted<T>(windowMs: number, run: (msLeft: number) => Promise<T>): Promise<T> {
  const start = Date.now();
  for (let attempt = 0; ; attempt++) {
    try {
      return await run(windowMs - (Date.now() - start));
    } catch (e) {
      const pause = Math.min(200, 5 * 2 ** attempt) * (0.5 + Math.random() / 2);
      if (!BUSY.test(String((e as Error).message)) || Date.now() - start + pause >= windowMs) throw e;
      await new Promise((r) => setTimeout(r, pause));
    }
  }
}

function toOptions(params: Record<string, unknown> | undefined): { params?: Params } {
  return params && Object.keys(params).length ? { params: cleanParam(params, "$") as Params } : {};
}

const withTimeout = (o: { params?: Params }, timeoutMs: number | undefined): FalkorQueryOptions =>
  (timeoutMs === undefined ? o : { ...o, TIMEOUT: Math.max(1, Math.round(timeoutMs)) }) as FalkorQueryOptions;

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
    if (!opts?.unchecked) assertSafeQuery(cypher);
    const opt = withTimeout(toOptions(params), opts?.timeoutMs);
    const r = await admitted(WRITE_QUEUE_WAIT_MS, () => this.#g.query<T>(cypher, opt));
    return r.data ?? [];
  }

  async roQuery<T = Record<string, unknown>>(cypher: string, params?: Record<string, unknown>, opts?: QueryOpts): Promise<T[]> {
    if (!opts?.unchecked) assertSafeQuery(cypher);
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
    const o = toOptions(params);
    try {
      const r = await admitted(timeoutMs, (left) => this.#g.roQuery<T>(cypher, withTimeout(o, left)));
      return r.data ?? [];
    } catch (e) {
      if (BUSY.test(String((e as Error).message))) throw new Error(`Query timed out: the server stayed busy for ${timeoutMs} ms`);
      throw e;
    }
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
    for (const fn of dropListeners) await fn(this.name);
  }
}

// One time budget spent across several reads: each call returns the milliseconds left (pass it as timeoutMs), and
// throws once the budget is gone. Writes are not cut off (FalkorDB ignores TIMEOUT on writes).
export function readBudget(timeoutMs: number = DEFAULT_READ_TIMEOUT_MS): () => number {
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) throw new Error(`timeoutMs must be a positive number, got ${timeoutMs}`);
  const end = Date.now() + timeoutMs;
  return () => {
    const left = end - Date.now();
    if (left <= 0) throw new Error(`Query timed out: the ${timeoutMs} ms budget is spent`);
    return left;
  };
}

const pool = new Map<string, Promise<FalkorDB>>();
let defaultUrl: string | undefined; // read the config (and its env file) once per process

export async function connect(url?: string): Promise<FalkorDB> {
  const u = url ?? (defaultUrl ??= loadConfig().falkordbUrl);
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

// Called (and awaited) with a graph's name after GraphHandle.drop(); projection.ts uses it to forget its cache and
// the graph's write stamp.
const dropListeners: Array<(name: string) => void | Promise<void>> = [];
export function onGraphDropped(fn: (name: string) => void | Promise<void>): void {
  dropListeners.push(fn);
}

// Run (and awaited) by closeAll before the connections close: projection.ts drops the projections it cached.
const closeHooks: Array<() => Promise<void>> = [];
export function onClose(fn: () => Promise<void>): void {
  closeHooks.push(fn);
}

export async function closeAll(): Promise<void> {
  for (const fn of closeHooks) {
    try {
      await fn();
    } catch (e) {
      console.error(`[graph] close hook failed: ${(e as Error).message}`);
    }
  }
  const all = [...pool.values()];
  pool.clear();
  await Promise.allSettled(all.map(async (p) => (await p).close()));
}
