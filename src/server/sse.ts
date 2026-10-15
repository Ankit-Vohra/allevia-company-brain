// Server-sent events for POST endpoints (ask, onboard). Each event is framed as `event: <type>\ndata: <json>\n\n`, in the
// order it was produced: sends are queued, so a producer that emits synchronously (ask() does) never reorders or
// blocks on a slow reader. The run's AbortSignal fires when the client goes away (the request's signal, or the
// response stream being cancelled): onboarding stops then, while an ask only stops following its turn, which runs on
// to the end on the server (turns.ts). A comment line (`: ping`) every heartbeatMs keeps proxies from closing a quiet
// stream while agents think.
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";

export type Send<E extends { type: string }> = (e: E) => void;

export interface SseOpts { heartbeatMs: number; log: (line: string) => void }

export function sse<E extends { type: string }>(
  c: Context, opts: SseOpts, run: (send: Send<E>, signal: AbortSignal) => Promise<void>,
): Response {
  const ctrl = new AbortController();
  const stop = () => { if (!ctrl.signal.aborted) ctrl.abort(new Error("client disconnected")); };
  const reqSignal = c.req.raw.signal;
  if (reqSignal.aborted) stop();
  else reqSignal.addEventListener("abort", stop, { once: true });
  c.header("X-Accel-Buffering", "no");
  return streamSSE(c, async (stream) => {
    stream.onAbort(stop);
    let chain: Promise<unknown> = Promise.resolve();
    const send: Send<E> = (e) => {
      if (ctrl.signal.aborted) return;
      const data = JSON.stringify(e);
      chain = chain.then(() => stream.writeSSE({ event: e.type, data })).catch(stop);
    };
    const beat = opts.heartbeatMs > 0
      ? setInterval(() => { chain = chain.then(() => stream.write(": ping\n\n")).catch(stop); }, opts.heartbeatMs)
      : undefined;
    try {
      await run(send, ctrl.signal);
    } catch (e) {
      opts.log(`[sse] ${c.req.path}: ${e instanceof Error ? e.message : String(e)}`);
      send({ type: "error", message: "Something went wrong on the server; the run stopped." } as unknown as E);
    } finally {
      if (beat) clearInterval(beat);
      reqSignal.removeEventListener("abort", stop);
      await chain;
    }
  });
}
