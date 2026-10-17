// One store for every run in this tab (live asks and replays), shared by the Office and Ask pages: a question asked in
// the office keeps running while you open it in Ask, and both views fold the same event list.
//
// A live turn runs on the server to the end even when this tab goes away (src/server/turns.ts). So:
// - a page that opens on a turn still working (a thread's `running`, or GET /turns/live) attaches to it: the events
//   so far, then new ones, by polling GET /turns/:id/events?after=N about once a second;
// - an ask stream that drops before the answer (a network blip) falls back to the same polling instead of failing;
// - Stop asks the server to stop the turn (POST /turns/:id/stop) and keeps following until its `final` arrives. In the
//   demo (mock) and the public replay there is no server turn, so Stop just ends the local stream.
import { useMemo, useSyncExternalStore } from "react";
import type { AgentEvent } from "@shared/contracts";
import { api, getMode, getPublicMode } from "../api";
import { ApiError, CREDITS_CHANGED } from "../lib/sse";
import type { LiveStatus, LiveTurn } from "../types-ext";
import { type RunView, deriveRun } from "./derive";

export interface RunRecord {
  key: string;
  tenant: string;
  question: string;
  sessionId?: string;
  /** A direct chat: the one person asked. Absent: the whole team. */
  target?: string;
  turnId?: string;
  events: AgentEvent[];
  status: "running" | "done" | "error" | "stopped";
  error?: string;
  kind: "live" | "replay" | "studio";
  startedAt: number;
  /** The owner pressed Stop: the server is winding the turn down; its `final` is on the way. */
  stopping?: boolean;
}

const POLL_MS = 1000;
const STOP_GRACE_MS = 20_000; // after Stop, how long to wait for the server's `final` before letting go of the turn
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) return resolve();
  const t = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
});

type Listener = () => void;

class RunStore {
  private runs = new Map<string, RunRecord>();
  private order: string[] = [];
  private listeners = new Set<Listener>();
  private controllers = new Map<string, AbortController>();
  private snapshot: { runs: Map<string, RunRecord>; order: string[]; version: number } = { runs: this.runs, order: [], version: 0 };
  /** Bumped when a run finishes, so thread lists refetch. */
  sessionsVersion = 0;
  private seq = 0;

  subscribe = (l: Listener) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  getSnapshot = () => this.snapshot;

  private emit() {
    this.snapshot = { runs: new Map(this.runs), order: [...this.order], version: this.snapshot.version + 1 };
    for (const l of this.listeners) l();
  }

  private put(r: RunRecord) {
    this.runs.set(r.key, r);
    if (!this.order.includes(r.key)) this.order.push(r.key);
    this.emit();
  }

  private patch(key: string, fn: (r: RunRecord) => RunRecord) {
    const r = this.runs.get(key);
    if (!r) return;
    this.runs.set(key, fn(r));
    this.emit();
  }

  private append(key: string, e: AgentEvent) {
    this.appendMany(key, [e]);
  }

  // One update for a batch of events (a re-attach can bring hundreds at once).
  private appendMany(key: string, list: AgentEvent[]) {
    if (!list.length) return;
    let askStop = false;
    this.patch(key, (r) => {
      const next: RunRecord = { ...r, events: [...r.events, ...list] };
      for (const e of list) {
        if (e.type === "session") {
          next.sessionId = e.sessionId; next.turnId = e.turnId;
          if (r.stopping && !r.turnId) askStop = true; // Stop was pressed before the turn had an id
        }
        if (e.type === "final") { next.status = r.stopping ? "stopped" : "done"; next.stopping = false; }
        if (e.type === "error" && !r.stopping) { next.status = "error"; next.error = e.message; }
      }
      return next;
    });
    if (askStop) this.stopOnServer(key);
    // an answer is charged on the server a moment after its `final`: the top bar's credits read again shortly
    if (list.some((e) => e.type === "final") && this.runs.get(key)?.kind === "live" && typeof window !== "undefined") {
      window.setTimeout(() => window.dispatchEvent(new Event(CREDITS_CHANGED)), 1500);
    }
  }

  /** A live turn the server can be asked about (not the demo, not the public replay). */
  private onServer(r: RunRecord | undefined): r is RunRecord & { turnId: string } {
    return !!r && r.kind === "live" && !!r.turnId && getMode() === "live" && !getPublicMode();
  }

  start(tenant: string, question: string, opts: { sessionId?: string; seekMs?: number; target?: string } = {}): string {
    const key = `run-${++this.seq}`;
    const ctrl = new AbortController();
    this.controllers.set(key, ctrl);
    this.put({ key, tenant, question, sessionId: opts.sessionId, ...(opts.target ? { target: opts.target } : {}), events: [], status: "running", kind: "live", startedAt: Date.now() - (opts.seekMs ?? 0) });
    let following = false;
    api
      .ask(tenant, { question, sessionId: opts.sessionId, ...(opts.target ? { target: opts.target } : {}) }, (e) => this.append(key, e), { signal: ctrl.signal, seekMs: opts.seekMs })
      .then(() => {
        const r = this.runs.get(key);
        if (!r || r.events.some((e) => e.type === "final")) return;
        // the stream ended before the answer: the turn may still be working on the server, so follow it there
        if (this.onServer(r)) { following = true; this.follow(key); return; }
        this.patch(key, (x) => (x.status === "running" ? { ...x, status: "error", error: x.error ?? "The stream ended before an answer." } : x));
      })
      .catch((err: unknown) => {
        if ((err as Error)?.name === "AbortError") return;
        if (this.onServer(this.runs.get(key))) { following = true; this.follow(key); return; }
        this.patch(key, (r) => ({ ...r, status: "error", error: (err as Error)?.message ?? "Something went wrong" }));
      })
      .finally(() => {
        if (this.controllers.get(key) === ctrl) this.controllers.delete(key);
        if (!following) this.sessionsVersion++;
        this.emit();
      });
    return key;
  }

  /** Follow a turn already working on the server (opened from another tab, or before this page loaded). Returns the
   *  run's key; a run this tab already has for that turn is reused. */
  attach(tenant: string, t: LiveTurn): string {
    for (const k of this.order) {
      const r = this.runs.get(k);
      if (!r || r.tenant !== tenant || r.kind !== "live" || r.turnId !== t.turnId) continue;
      if (r.status === "error") { this.patch(k, (x) => ({ ...x, status: "running", error: undefined })); this.follow(k); }
      return k;
    }
    const key = `attach-${++this.seq}`;
    this.put({
      key, tenant, question: t.question, sessionId: t.sessionId, turnId: t.turnId, ...(t.agent ? { target: t.agent } : {}), events: [], status: "running", kind: "live",
      startedAt: Date.parse(t.startedAt) || Date.now(),
    });
    this.follow(key);
    return key;
  }

  // Poll GET /turns/:id/events from the events this run already has, until the turn is done.
  private follow(key: string) {
    const r = this.runs.get(key);
    if (!this.onServer(r)) return;
    this.controllers.get(key)?.abort();
    const ctrl = new AbortController();
    this.controllers.set(key, ctrl);
    const { tenant, turnId } = r;
    let after = r.events.length;
    (async () => {
      let failures = 0;
      while (!ctrl.signal.aborted) {
        try {
          const page = await api.turnEvents(tenant, turnId, after, ctrl.signal);
          if (ctrl.signal.aborted) return;
          failures = 0;
          this.appendMany(key, page.events);
          after = page.next;
          if (page.done) { this.settle(key, page.status); break; }
          if (page.events.length >= 500) continue; // more waiting: ask again straight away
        } catch (err) {
          if (ctrl.signal.aborted) return;
          if (err instanceof ApiError && err.status === 404) {
            this.patch(key, (x) => ({ ...x, status: "error", stopping: false, error: "This turn is no longer on the server (it may have restarted)." }));
            break;
          }
          if (++failures > 30) {
            this.patch(key, (x) => ({ ...x, status: "error", stopping: false, error: "Lost touch with the server. The team may still be working: reload in a minute." }));
            break;
          }
        }
        await sleep(failures ? Math.min(5000, POLL_MS * (failures + 1)) : POLL_MS, ctrl.signal);
      }
      if (this.controllers.get(key) === ctrl) this.controllers.delete(key);
      this.sessionsVersion++;
      this.emit();
    })();
  }

  // The server says the turn ended: done, failed or stopped.
  private settle(key: string, status: LiveStatus) {
    this.patch(key, (r) => {
      if (status === "stopped") return { ...r, status: "stopped", stopping: false };
      if (r.status !== "running") return { ...r, stopping: false };
      const answered = r.events.some((e) => e.type === "final");
      return { ...r, stopping: false, status: answered ? "done" : "error", error: answered ? undefined : r.error ?? "The team could not finish this one." };
    });
  }

  private stopOnServer(key: string) {
    const r = this.runs.get(key);
    if (!this.onServer(r)) return;
    api.stopTurn(r.tenant, r.turnId).catch((err: unknown) => {
      // the server no longer has it running (it just finished, or restarted): stop following here
      if (err instanceof ApiError && err.status === 404) this.abortLocal(key);
      else this.patch(key, (x) => ({ ...x, stopping: false, error: (err as Error)?.message ?? "Could not stop the turn." }));
    });
    // the server sends `final` once the desks have stopped; if it never comes, let go of the turn anyway
    setTimeout(() => { if (this.runs.get(key)?.stopping) this.abortLocal(key); }, STOP_GRACE_MS);
  }

  private abortLocal(key: string) {
    this.controllers.get(key)?.abort();
    this.controllers.delete(key);
    this.patch(key, (r) => (r.status === "running" ? { ...r, status: "stopped", stopping: false } : { ...r, stopping: false }));
  }

  /** A Studio run: the photo goes up, the content desks' work streams back as the same AgentEvents, so the office shows
   *  Tara, Nisha and Dev at work (and the Content Studio room reacts to each new asset). */
  studio(tenant: string, photo: Blob, note: string): string {
    const key = `studio-${++this.seq}`;
    const ctrl = new AbortController();
    this.controllers.set(key, ctrl);
    this.put({ key, tenant, question: note.trim() ? `Studio: ${note.trim()}` : "Studio: a new photo", events: [], status: "running", kind: "studio", startedAt: Date.now() });
    api
      .studioIntake(tenant, photo, note, (e) => this.append(key, e), { signal: ctrl.signal })
      .then(() => {
        this.patch(key, (r) => (r.status === "running" ? { ...r, status: r.events.some((e) => e.type === "final") ? "done" : "error", error: r.error ?? "The stream ended before the card was ready." } : r));
      })
      .catch((err: unknown) => {
        if ((err as Error)?.name === "AbortError") return;
        this.patch(key, (r) => ({ ...r, status: "error", error: (err as Error)?.message ?? "Something went wrong" }));
      })
      .finally(() => { this.controllers.delete(key); this.emit(); });
    return key;
  }

  /** Replay a stored turn's event log with a gentle pace (or instantly), through the same renderer as a live run. */
  replay(tenant: string, turnId: string, question: string, events: AgentEvent[], opts: { paced: boolean; speed?: () => number }): string {
    const key = `replay-${turnId}-${++this.seq}`;
    this.put({ key, tenant, question, turnId, events: opts.paced ? [] : events, status: opts.paced ? "running" : "done", kind: "replay", startedAt: Date.now() });
    if (!opts.paced) return key;
    const ctrl = new AbortController();
    this.controllers.set(key, ctrl);
    const pace = (e: AgentEvent) =>
      e.type === "text" ? 45 : e.type === "tool_result" ? 650 : e.type === "finding" || e.type === "plan" ? 900 : e.type === "handoff" ? 500 : 280;
    (async () => {
      for (const e of events) {
        if (ctrl.signal.aborted) return;
        await new Promise((r) => setTimeout(r, pace(e) / (opts.speed?.() ?? 1)));
        if (ctrl.signal.aborted) return;
        this.append(key, e);
      }
      this.patch(key, (r) => ({ ...r, status: "done" }));
      this.controllers.delete(key);
    })();
    return key;
  }

  /** Stop a run. A live turn on the server is asked to stop there (closing the tab never stops it); the run keeps
   *  following until the server's `final`. Anything else (the demo, a replay, the public replay) ends locally. */
  stop(key: string) {
    const r = this.runs.get(key);
    if (!r || r.status !== "running" || r.stopping) return;
    const serverTurn = r.kind === "live" && getMode() === "live" && !getPublicMode();
    if (!serverTurn) return this.abortLocal(key);
    this.patch(key, (x) => ({ ...x, stopping: true }));
    if (r.turnId) this.stopOnServer(key); // else: as soon as the session event brings the turn id (appendMany)
  }

  get(key: string | undefined) { return key ? this.runs.get(key) : undefined; }

  latest(tenant: string, filter?: (r: RunRecord) => boolean): RunRecord | undefined {
    for (let i = this.order.length - 1; i >= 0; i--) {
      const r = this.runs.get(this.order[i]!);
      if (r && r.tenant === tenant && (!filter || filter(r))) return r;
    }
    return undefined;
  }
}

export const runStore = new RunStore();

export function useRunStore() {
  return useSyncExternalStore(runStore.subscribe, runStore.getSnapshot);
}

export function useRun(key: string | undefined): RunRecord | undefined {
  const snap = useRunStore();
  return key ? snap.runs.get(key) : undefined;
}

export function useRunView(record: RunRecord | undefined): RunView | undefined {
  const events = record?.events;
  return useMemo(() => (events ? deriveRun(events) : undefined), [events]);
}
