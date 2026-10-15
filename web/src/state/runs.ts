// One store for every run in this tab (live asks and replays), shared by the Office and Ask pages: a question asked in
// the office keeps running while you open it in Ask, and both views fold the same event list.
import { useMemo, useSyncExternalStore } from "react";
import type { AgentEvent } from "@shared/contracts";
import { api } from "../api";
import { type RunView, deriveRun } from "./derive";

export interface RunRecord {
  key: string;
  tenant: string;
  question: string;
  sessionId?: string;
  turnId?: string;
  events: AgentEvent[];
  status: "running" | "done" | "error" | "stopped";
  error?: string;
  kind: "live" | "replay" | "studio";
  startedAt: number;
}

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
    this.patch(key, (r) => {
      const next: RunRecord = { ...r, events: [...r.events, e] };
      if (e.type === "session") { next.sessionId = e.sessionId; next.turnId = e.turnId; }
      if (e.type === "final") next.status = "done";
      if (e.type === "error") { next.status = "error"; next.error = e.message; }
      return next;
    });
  }

  start(tenant: string, question: string, opts: { sessionId?: string; seekMs?: number } = {}): string {
    const key = `run-${++this.seq}`;
    const ctrl = new AbortController();
    this.controllers.set(key, ctrl);
    this.put({ key, tenant, question, sessionId: opts.sessionId, events: [], status: "running", kind: "live", startedAt: Date.now() - (opts.seekMs ?? 0) });
    api
      .ask(tenant, { question, sessionId: opts.sessionId }, (e) => this.append(key, e), { signal: ctrl.signal, seekMs: opts.seekMs })
      .then(() => {
        this.patch(key, (r) => (r.status === "running" ? { ...r, status: r.events.some((e) => e.type === "final") ? "done" : "error", error: r.error ?? "The stream ended before an answer." } : r));
      })
      .catch((err: unknown) => {
        if ((err as Error)?.name === "AbortError") return;
        this.patch(key, (r) => ({ ...r, status: "error", error: (err as Error)?.message ?? "Something went wrong" }));
      })
      .finally(() => {
        this.controllers.delete(key);
        this.sessionsVersion++;
        this.emit();
      });
    return key;
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

  stop(key: string) {
    this.controllers.get(key)?.abort();
    this.controllers.delete(key);
    this.patch(key, (r) => (r.status === "running" ? { ...r, status: "stopped" } : r));
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
