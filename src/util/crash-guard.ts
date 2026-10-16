// The last line of defence for the long-running processes (the Discord bot, the hub bot, the server), issue #28. A
// FalkorDB restart must never take them down: an outage error that escapes every handler (an unawaited promise, an
// 'error' event from a half-connected client) is logged in one line and the process carries on, and the graph client
// reconnects by itself. Any other uncaught exception still stops the process (its state can't be trusted), and the
// supervisor (scripts/ops/run-bot.sh, run-server.sh) starts it again. A promise nobody awaited that rejects for another
// reason is logged with its stack and the process carries on: nothing was left half-done by it.
import { isDbUnavailable } from "../graph/waking.js";

export interface CrashGuardOpts {
  log?: (line: string) => void;
  exit?: (code: number) => void;
}

const describe = (e: unknown): string => (e instanceof Error ? e.stack ?? e.message : String(e));
const short = (e: unknown): string => (e instanceof Error ? e.message || String((e as { code?: unknown }).code ?? e.name) : String(e));

let installed: (() => void) | undefined;

// What the guard does with an error nobody caught (tests call these directly).
export function crashGuardHandlers(o: CrashGuardOpts = {}): { onRejection: (reason: unknown) => void; onException: (e: unknown) => void } {
  const log = o.log ?? ((l: string) => console.error(l));
  const exit = o.exit ?? ((code: number) => process.exit(code));
  const onRejection = (reason: unknown) => {
    if (isDbUnavailable(reason)) log(`[guard] the database is restarting (${short(reason)}); carrying on`);
    else log(`[guard] a background task failed and nobody was waiting for it: ${describe(reason)}`);
  };
  const onException = (e: unknown) => {
    if (isDbUnavailable(e)) {
      log(`[guard] the database is restarting (${short(e)}); carrying on`);
      return;
    }
    log(`[guard] stopping after an unexpected error: ${describe(e)}`);
    exit(1);
  };
  return { onRejection, onException };
}

// Installs the handlers once per process; returns a function that removes them.
export function installCrashGuard(o: CrashGuardOpts = {}): () => void {
  if (installed) return installed;
  const { onRejection, onException } = crashGuardHandlers(o);
  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onException);
  installed = () => {
    process.off("unhandledRejection", onRejection);
    process.off("uncaughtException", onException);
    installed = undefined;
  };
  return installed;
}
