// The FalkorDB server settings the code is written for, in one place. docker-compose.yml passes them to the server as
// FALKORDB_ARGS (module load arguments, which survive a restart: GRAPH.CONFIG SET does not, and a limit set that way
// and lost when the server restarted after a crash is how the first production server ended up with none), and
// tests/graph/server-config.test.ts keeps the two in step. `db:check` compares a running server with them.
//
//   THREAD_COUNT          query threads (load time). Queries from every tenant share them, so the limits below are what keeps
//                         one runaway query from freezing everyone.
//   MAX_QUEUED_QUERIES    queue depth before the server refuses a query ("Max pending queries exceeded"); client.ts retries those.
//   TIMEOUT_DEFAULT       wall-clock limit (ms) of a query that sent no TIMEOUT of its own: every write (GraphHandle.query sends none; on
//                         6.0.2 a write past it fails with "Query timed out" and rolls back, verified) and any read that did not
//                         set one; reads from client.ts send DEFAULT_READ_TIMEOUT_MS.
//   TIMEOUT_MAX           the ceiling for any TIMEOUT a caller asks for: a larger one is refused outright ("cannot exceed
//                         TIMEOUT_MAX"), so it must cover the longest budget the code sends (the librarian's algorithm budget,
//                         120 s).
//   QUERY_MEM_CAPACITY    bytes one query may allocate (512 MiB).
//   CACHE_SIZE            distinct query texts whose plans stay cached (load time). The product sends about 1,100 shapes.
//   RESULTSET_SIZE        rows one result may hold; the rest are dropped without an error. Reads that grow with the graph
//                         page by MAX_PAGE (5,000) rows, well under it, or pack their rows into lists.
import type { FalkorDB } from "falkordb";

export const SERVER_CONFIG = {
  THREAD_COUNT: 4,
  MAX_QUEUED_QUERIES: 500,
  TIMEOUT_DEFAULT: 15_000,
  TIMEOUT_MAX: 120_000,
  QUERY_MEM_CAPACITY: 536_870_912,
  CACHE_SIZE: 256,
  RESULTSET_SIZE: 10_000,
} as const;

// The FALKORDB_ARGS string for docker-compose.yml.
export const falkordbArgs = (): string => Object.entries(SERVER_CONFIG).map(([k, v]) => `${k} ${v}`).join(" ");

export interface ConfigDrift { name: string; want: number; have: string | number | undefined }

// Settings of `have` (GRAPH.CONFIG GET *) that differ from SERVER_CONFIG.
export function configDrift(have: Record<string, string | number>): ConfigDrift[] {
  return Object.entries(SERVER_CONFIG)
    .filter(([k, v]) => Number(have[k]) !== v)
    .map(([k, v]) => ({ name: k, want: v, have: have[k] }));
}

export async function readServerConfig(db: FalkorDB): Promise<Record<string, string | number>> {
  const rows = (await db.configGet("*")) as Array<[string, string | number]>;
  return Object.fromEntries(rows.map(([k, v]) => [String(k), v]));
}
