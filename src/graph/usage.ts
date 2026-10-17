// How full the database is. FalkorDB Cloud's free plan holds 100 MB and refuses writes when it is full (noeviction), so the number to watch
// is the server's used memory against its limit: INFO memory (`used_memory`, and `maxmemory` when the server has one) and, per graph,
// GRAPH.MEMORY USAGE (the graph's own share; the rest is Redis, indexes and the projections the algorithms cache). `db:usage` prints it
// and warns from 80 percent (src/cli/db-usage.ts). Read-only: nothing here writes.
import { connect } from "./client.js";

export const WARN_AT = 0.8;
export const CRITICAL_AT = 0.95;

type Db = Awaited<ReturnType<typeof connect>>;

/** `key:value` lines of an INFO section. */
export function parseInfo(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0 && !line.startsWith("#")) out[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return out;
}

const mb = (bytes: number): number => bytes / 1048576;

export interface MemoryInfo {
  usedMb: number;
  peakMb: number | null;
  /** The server's own limit (`maxmemory`) in MB, or null when it reports none. */
  maxMb: number | null;
  policy: string | null;
}

export function memoryInfo(infoMemory: string): MemoryInfo {
  const i = parseInfo(infoMemory);
  const used = Number(i.used_memory);
  if (!Number.isFinite(used)) throw new Error("the server's INFO memory had no used_memory");
  const max = Number(i.maxmemory);
  const peak = Number(i.used_memory_peak);
  return {
    usedMb: mb(used), peakMb: Number.isFinite(peak) ? mb(peak) : null, maxMb: Number.isFinite(max) && max > 0 ? mb(max) : null, policy: i.maxmemory_policy ?? null,
  };
}

export type Level = "ok" | "warning" | "critical" | "unknown";

export interface Assessment { limitMb: number | null; limitFrom: "flag" | "server" | "env" | null; percent: number | null; level: Level; roomMb: number | null }

/**
 * How full it is against a limit: the flag, else what the server reports, else ALLEVIA_DB_LIMIT_MB (Cloud's free plan may not report its
 * 100 MB). Warning from 80 percent, critical from 95 (writes fail at 100).
 */
export function assess(info: MemoryInfo, o: { flagMb?: number; envMb?: number } = {}): Assessment {
  const pick = o.flagMb !== undefined ? ([o.flagMb, "flag"] as const) : info.maxMb !== null ? ([info.maxMb, "server"] as const) : o.envMb !== undefined ? ([o.envMb, "env"] as const) : null;
  if (!pick) return { limitMb: null, limitFrom: null, percent: null, level: "unknown", roomMb: null };
  const [limitMb, limitFrom] = pick;
  if (!(limitMb > 0)) throw new Error(`the limit must be a number of MB above 0, got ${limitMb}`);
  const ratio = info.usedMb / limitMb;
  return { limitMb, limitFrom, percent: ratio * 100, level: ratio >= CRITICAL_AT ? "critical" : ratio >= WARN_AT ? "warning" : "ok", roomMb: Math.max(0, limitMb - info.usedMb) };
}

export interface GraphUsage { graph: string; mb: number | null; projection: boolean }

/** GRAPH.MEMORY USAGE's flat `key, value, …` reply as an object. */
export function parseGraphMemory(reply: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!Array.isArray(reply)) return out;
  for (let i = 0; i + 1 < reply.length; i += 2) {
    const v = Number(reply[i + 1]);
    if (typeof reply[i] === "string" && Number.isFinite(v)) out[reply[i] as string] = v;
  }
  return out;
}

export async function readMemory(db: Db): Promise<MemoryInfo> {
  return memoryInfo(String(await (await db.connection).info("memory")));
}

/** Every graph on the server with its own memory (null where the server would not say), biggest first; the cached projections are marked. */
export async function readGraphUsage(db: Db): Promise<GraphUsage[]> {
  const conn = await db.connection;
  const names = await db.list();
  const rows: GraphUsage[] = [];
  for (const graph of names) {
    let size: number | null = null;
    try {
      size = parseGraphMemory(await conn.sendCommand(["GRAPH.MEMORY", "USAGE", graph])).total_graph_sz_mb ?? null;
    } catch { /* an older server, or one that refuses the command: its share stays unknown */ }
    rows.push({ graph, mb: size, projection: graph.includes("__") });
  }
  return rows.sort((a, b) => (b.mb ?? -1) - (a.mb ?? -1) || a.graph.localeCompare(b.graph));
}
