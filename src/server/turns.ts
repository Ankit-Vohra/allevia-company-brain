// Live turns: a question asked on the web runs on the server to the end, whether or not anyone is still watching.
// Owners close tabs; the team keeps working, saves the turn, and the thread shows the answer when they come back.
//
// - start() runs one turn (ask()) with its own AbortController, never the request's: a client that disconnects only
//   stops following. Only stop() (POST /api/:t/turns/:id/stop) or the turn-level cap (maxTurnMs, on top of the
//   orchestrator's per-agent timeouts) aborts it; ask() then saves it as stopped.
// - Every event is kept in order, so any number of followers can (re)attach from any index: the POST's own SSE stream
//   follows from 0, GET /api/:t/turns/:id/events?after=N pages from N.
// - A finished turn stays here for keepMs (and at most maxKept of them), so a follower that polls just after the end
//   still gets the tail; after that the stored Turn (its saved event log) answers instead.
// The turn id comes from ask()'s first event (`session`), which it emits before anything else.
import type { AgentEvent } from "../../shared/contracts.js";

export type LiveStatus = "running" | "done" | "failed" | "stopped";

// GET /api/:t/turns/live, and `running` on a thread
export interface LiveTurnDto { turnId: string; sessionId: string; question: string; startedAt: string; status: LiveStatus; agent?: string }

export interface LiveTurnsOpts {
  now?: () => number;       // the app's clock, for startedAt
  keepMs?: number;          // how long a finished turn's events stay here (default 10 min)
  maxKept?: number;         // finished turns kept at most (default 100)
  maxTurnMs?: number;       // a turn still running after this is stopped (default 20 min; 0 = no cap)
}

type Follower = () => void;

export class LiveTurn {
  turnId = "";
  sessionId = "";
  readonly events: AgentEvent[] = [];
  status: LiveStatus = "running";
  endedAt = 0;
  readonly done: Promise<void>;
  private readonly ctrl = new AbortController();
  private readonly followers = new Set<Follower>();
  private stopped = false;
  private finish!: () => void;

  constructor(readonly tenant: string, readonly question: string, readonly startedAt: number, readonly agent?: string) {
    this.done = new Promise<void>((r) => { this.finish = r; });
  }

  get signal(): AbortSignal { return this.ctrl.signal; }
  get running(): boolean { return this.status === "running"; }

  push(e: AgentEvent): void {
    if (!this.running) return;
    if (e.type === "session" && !this.turnId) { this.turnId = e.turnId; this.sessionId = e.sessionId; }
    this.events.push(e);
    for (const f of [...this.followers]) f();
  }

  stop(why: string): void {
    if (!this.running || this.ctrl.signal.aborted) return;
    this.stopped = true;
    this.ctrl.abort(new Error(why));
  }

  end(ok: boolean): void {
    if (!this.running) return;
    this.status = this.stopped || this.ctrl.signal.aborted ? "stopped" : ok ? "done" : "failed";
    this.endedAt = Date.now();
    for (const f of [...this.followers]) f();
    this.followers.clear();
    this.finish();
  }

  // Sends every event from `from` on, then each new one as it comes; resolves when the turn ends or `signal` aborts
  // (the follower went away; the turn goes on).
  follow(from: number, send: (e: AgentEvent) => void, signal: AbortSignal): Promise<void> {
    let i = Math.max(0, from);
    const flush = () => { while (i < this.events.length) send(this.events[i++]!); };
    flush();
    if (!this.running || signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const leave = () => { this.followers.delete(follower); signal.removeEventListener("abort", leave); resolve(); };
      const follower: Follower = () => { flush(); if (!this.running) leave(); };
      this.followers.add(follower);
      signal.addEventListener("abort", leave, { once: true });
    });
  }

  dto(): LiveTurnDto {
    return { turnId: this.turnId, sessionId: this.sessionId, question: this.question, startedAt: new Date(this.startedAt).toISOString(), status: this.status, ...(this.agent ? { agent: this.agent } : {}) };
  }
}

export class LiveTurns {
  private readonly turns = new Map<string, LiveTurn>(); // `${tenant}\n${turnId}`, in start order
  private readonly now: () => number;
  private readonly keepMs: number;
  private readonly maxKept: number;
  private readonly maxTurnMs: number;

  constructor(o: LiveTurnsOpts = {}) {
    this.now = o.now ?? (() => Date.now());
    this.keepMs = o.keepMs ?? 10 * 60_000;
    this.maxKept = o.maxKept ?? 100;
    this.maxTurnMs = o.maxTurnMs ?? 20 * 60_000;
  }

  // Runs `run` as a live turn. `run` must emit the `session` event first (ask() does, synchronously), so the turn is
  // findable by id as soon as start() returns. A run that throws ends the turn as failed (ask() itself never throws).
  start(tenant: string, question: string, run: (emit: (e: AgentEvent) => void, signal: AbortSignal) => Promise<{ ok: boolean }>, agent?: string): LiveTurn {
    this.prune();
    const t = new LiveTurn(tenant, question, this.now(), agent);
    const cap = this.maxTurnMs > 0 ? setTimeout(() => t.stop("the turn ran past its time limit"), this.maxTurnMs) : undefined;
    cap?.unref?.();
    const result = run((e) => {
      const first = !t.turnId;
      t.push(e);
      if (first && t.turnId) this.turns.set(key(tenant, t.turnId), t);
    }, t.signal);
    result.then((r) => t.end(r.ok), () => t.end(false)).finally(() => { if (cap) clearTimeout(cap); });
    return t;
  }

  get(tenant: string, turnId: string): LiveTurn | undefined {
    const t = this.turns.get(key(tenant, turnId));
    return t && !this.expired(t) ? t : undefined;
  }

  // The tenant's running turns, newest first.
  running(tenant: string): LiveTurn[] {
    return [...this.turns.values()].filter((t) => t.tenant === tenant && t.running).reverse();
  }

  runningInSession(tenant: string, sessionId: string): LiveTurn | undefined {
    return this.running(tenant).find((t) => t.sessionId === sessionId);
  }

  private expired(t: LiveTurn): boolean {
    return !t.running && Date.now() - t.endedAt > this.keepMs;
  }

  private prune(): void {
    const finished = [...this.turns.entries()].filter(([, t]) => !t.running);
    const over = finished.length - this.maxKept;
    finished.forEach(([k, t], i) => { if (i < over || this.expired(t)) this.turns.delete(k); });
  }
}

const key = (tenant: string, turnId: string): string => `${tenant}\n${turnId}`;
