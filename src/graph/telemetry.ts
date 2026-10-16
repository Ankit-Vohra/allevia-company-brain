// FalkorDB's own telemetry streams (issue #29). The module keeps statistics about each graph in an ordinary Redis stream
// named `telemetry{<graph>}`, in the same keyspace as our data, and writes them into every dump. On 2026-10-15 the
// shared server went into three restart loops because the saved dump failed to load: "Stream listpack integrity check
// failed" on one of these keys. Nothing of ours reads them, so the server clears them away every few minutes, which keeps
// that kind of key out of the dump (the module writes a new one when it next has something to say).
//
// Only a key named exactly `telemetry{<something>}` whose type is `stream` is ever removed; data, graphs and the write
// stamps are untouched. A managed server that allows graph commands only (FalkorDB Cloud answers NOPERM to SCAN) cannot be
// swept, and does not need to be: that is noticed once, without a word in the log, and the sweep stops asking.
import type { FalkorDB } from "falkordb";
import { connect } from "./client.js";

export const TELEMETRY_MATCH = "telemetry{*}";
export const isTelemetryKey = (key: string): boolean => /^telemetry\{[^{}]+\}$/.test(key);

// The three plain Redis commands the sweep needs, so a test can stand in for the server.
export interface KeyAccess {
  scan(cursor: string, match: string, count: number): Promise<{ cursor: string; keys: string[] }>;
  type(key: string): Promise<string>;
  unlink(keys: string[]): Promise<number>;
}

export async function redisKeys(db?: FalkorDB): Promise<KeyAccess> {
  const r = await (db ?? (await connect())).connection;
  return {
    scan: async (cursor, match, count) => {
      const out = await r.scan(cursor, { MATCH: match, COUNT: count });
      return { cursor: String(out.cursor), keys: out.keys.map(String) };
    },
    type: async (key) => String(await r.type(key)),
    unlink: async (keys) => Number(await r.unlink(keys)),
  };
}

// A server that will not run plain Redis commands for this user (an ACL, a managed offering): not an error, a fact about it.
export const refusesPlainKeys = (e: unknown): boolean => /NOPERM|unknown command|no permissions to run/i.test(String((e as Error)?.message ?? e));

export interface TelemetrySweep {
  /** The streams that were removed. */
  removed: string[];
  /** True when the server refused plain commands: nothing was looked at, and asking again would get the same answer. */
  refused: boolean;
}

// The telemetry streams on the server, without removing anything.
export async function telemetryStreams(keys: KeyAccess): Promise<string[]> {
  const found = new Set<string>();
  let cursor = "0";
  do {
    const page = await keys.scan(cursor, TELEMETRY_MATCH, 100);
    cursor = page.cursor;
    for (const k of page.keys) if (isTelemetryKey(k)) found.add(k);
  } while (cursor !== "0");
  const streams: string[] = [];
  for (const k of [...found].sort()) if ((await keys.type(k)) === "stream") streams.push(k);
  return streams;
}

// Removes every telemetry stream. A refusal comes back as `refused`; any other failure (the server is down) throws.
export async function sweepTelemetry(keys: KeyAccess, opts: { dryRun?: boolean } = {}): Promise<TelemetrySweep> {
  try {
    const streams = await telemetryStreams(keys);
    if (!opts.dryRun) for (const k of streams) await keys.unlink([k]);
    return { removed: streams, refused: false };
  } catch (e) {
    if (refusesPlainKeys(e)) return { removed: [], refused: true };
    throw e;
  }
}

export const telemetrySweepOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(off|0|false|no)$/i.test(env.ALLEVIA_TELEMETRY_SWEEP ?? "");

export interface TelemetryScheduleDeps {
  keys?: () => Promise<KeyAccess>;
  log?: (line: string) => void;
}

// Every 10 minutes (first sweep a minute after start), inside the server. It stops by itself once the server has shown it
// refuses plain commands. ALLEVIA_TELEMETRY_SWEEP=off switches it off. Returns the stop function.
export function startTelemetrySweep(d: TelemetryScheduleDeps = {}, o: { everyMs?: number; firstDelayMs?: number } = {}): () => void {
  let running = false;
  let stopped = false;
  const stop = () => { stopped = true; clearTimeout(first); clearInterval(every); };
  const tick = () => {
    if (running || stopped) return;
    running = true;
    (async () => {
      const r = await sweepTelemetry(await (d.keys ?? redisKeys)());
      if (r.refused) stop();
      else if (r.removed.length) d.log?.(`[graph] removed ${r.removed.length} FalkorDB telemetry stream${r.removed.length === 1 ? "" : "s"}`);
    })()
      .catch((e) => d.log?.(`[graph] telemetry sweep: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => { running = false; });
  };
  const first = setTimeout(tick, o.firstDelayMs ?? 60_000);
  const every = setInterval(tick, o.everyMs ?? 10 * 60_000);
  first.unref();
  every.unref();
  return stop;
}
