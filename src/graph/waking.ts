// FalkorDB restarting (issue #28): while the database is down or loading its data back into memory, every query fails with
// connection refused, LOADING, or a reset socket. None of that is a bug in the query, and none of it may take the bot or the
// server down. This file says which errors are "the database is not there yet", and retries them with a growing, jittered
// pause for a bounded wait. After that the caller gets DatabaseWakingUp, whose message is the sentence an owner sees.
//
// Two kinds, because a write must never run twice:
//   never ran   connection refused, LOADING, the client is closed or offline, a connect timeout. The server never
//               took the query, so reads and writes are both sent again.
//   maybe ran   the socket closed or reset after the query was sent. A read is sent again; a write is not (it may have
//               happened), it fails at once with DatabaseWakingUp and the owner tries again.
export const WAKING_UP_MESSAGE = "Your team's memory is waking up, try again in a minute.";

// How long a query waits for the database to come back before it gives up with DatabaseWakingUp (ALLEVIA_DB_WAKE_WAIT_MS).
export const DEFAULT_WAKE_WAIT_MS = 20_000;
const MAX_PAUSE_MS = 4_000;

export class DatabaseWakingUp extends Error {
  override name = "DatabaseWakingUp";
  constructor(cause?: unknown) {
    super(WAKING_UP_MESSAGE, cause === undefined ? undefined : { cause });
  }
}

export type DbOutage = "never_ran" | "maybe_ran";

const NEVER_RAN = /\bLOADING\b|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|client is closed|ClientClosedError|ClientOfflineError|client is offline|ConnectionTimeoutError|Connection timeout|MASTERDOWN|TRYAGAIN/i;
const MAYBE_RAN = /ECONNRESET|EPIPE|ETIMEDOUT|Socket closed unexpectedly|SocketClosedUnexpectedlyError|SocketTimeoutError|Connection is closed|socket hang up/i;

function texts(e: unknown, depth = 0): string[] {
  if (depth > 4 || e === null || e === undefined) return [];
  if (typeof e !== "object") return [String(e)];
  const o = e as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown; errors?: unknown };
  const own = [o.name, o.message, o.code].filter((x): x is string => typeof x === "string");
  // Node reports a refused connection to every address of a host as an AggregateError whose own message is empty.
  const inner = Array.isArray(o.errors) ? o.errors.flatMap((x) => texts(x, depth + 1)) : [];
  return [...own, ...inner, ...texts(o.cause, depth + 1)];
}

// Which outage an error is, or null when it is something else (a bad query, a timeout, a refusal by the safety check).
export function dbOutage(e: unknown): DbOutage | null {
  if (e instanceof DatabaseWakingUp) return "never_ran";
  const t = texts(e).join(" ");
  if (NEVER_RAN.test(t)) return "never_ran";
  if (MAYBE_RAN.test(t)) return "maybe_ran";
  return null;
}

// Anything an owner should hear as "waking up": our own DatabaseWakingUp, or a raw outage error that got past a retry.
export const isDbUnavailable = (e: unknown): boolean => dbOutage(e) !== null;

export interface WakeOpts {
  waitMs?: number;                          // default ALLEVIA_DB_WAKE_WAIT_MS, else DEFAULT_WAKE_WAIT_MS
  write?: boolean;                          // a write is not sent again once it may have run
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export function wakeWaitMs(): number {
  const n = Number(process.env.ALLEVIA_DB_WAKE_WAIT_MS);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_WAKE_WAIT_MS;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Runs `fn`, sending it again while the database is restarting, for at most `waitMs`.
export async function untilAwake<T>(fn: () => Promise<T>, o: WakeOpts = {}): Promise<T> {
  const waitMs = o.waitMs ?? wakeWaitMs();
  const sleep = o.sleep ?? realSleep;
  const now = o.now ?? Date.now;
  const start = now();
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const kind = dbOutage(e);
      if (!kind) throw e;
      if (e instanceof DatabaseWakingUp) throw e;
      if (kind === "maybe_ran" && o.write) throw new DatabaseWakingUp(e);
      const pause = Math.min(MAX_PAUSE_MS, 250 * 2 ** attempt) * (0.5 + Math.random() / 2);
      if (now() - start + pause > waitMs) throw new DatabaseWakingUp(e);
      await sleep(pause);
    }
  }
}
