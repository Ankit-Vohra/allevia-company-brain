// Ctrl-C during a long command (ask): the first one aborts `signal`, so every agent run is stopped and its SDK
// subprocess closed, and the command finishes cleanly (the turn is saved as failed); a second one quits at once.
export interface Interruptible { signal: AbortSignal; dispose(): void }

interface Proc {
  on(event: "SIGINT", listener: () => void): unknown;
  off(event: "SIGINT", listener: () => void): unknown;
  exit(code: number): unknown;
}

export function interruptible(proc: Proc = process, say: (msg: string) => void = (m) => console.error(m)): Interruptible {
  const stop = new AbortController();
  const onSigint = () => {
    if (stop.signal.aborted) { proc.exit(130); return; }
    say("\nStopping the agents (Ctrl-C again to quit now)…");
    stop.abort(new Error("stopped from the keyboard"));
  };
  proc.on("SIGINT", onSigint);
  return { signal: stop.signal, dispose: () => { proc.off("SIGINT", onSigint); } };
}
