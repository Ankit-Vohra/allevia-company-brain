// One conversation as the chat shows it: the stored turns (with their saved work logs), plus any run still going on this
// tab or on the server. The same turn can be both while it finishes, so a stored turn wins and its live twin lends its events.
import { useEffect, useMemo, useState } from "react";
import type { AgentEvent } from "@shared/contracts";
import { api } from "../../api";
import { type RunView, deriveRun } from "../../state/derive";
import { type RunRecord, runStore, useRunStore } from "../../state/runs";
import type { SessionDetail, TurnRecord } from "../../types-ext";
import { useAsync } from "../../state/app";
import { LOST_ANSWER, savedAnswer } from "../../lib/chat";

export interface TurnItem {
  key: string;
  turnId?: string;
  question: string;
  at?: string;
  events: AgentEvent[];
  status: RunRecord["status"];
  record?: TurnRecord;
  /** The person this turn was a direct chat with. */
  target?: string;
  replaying?: boolean;
  error?: string;
}

export interface Thread {
  detail: SessionDetail | undefined;
  loading: boolean;
  turns: TurnItem[];
  views: RunView[];
  running: boolean;
  liveRun: RunRecord | undefined;
  replay: (t: TurnItem, opts: { paced: boolean; speed: () => number }) => void;
}

export function useThread(tenantId: string, sessionId: string | undefined, pendingKey: string | undefined): Thread {
  const snap = useRunStore();
  const detail = useAsync(
    () => (sessionId ? api.session(tenantId, sessionId).catch(() => null) : Promise.resolve(null)),
    [tenantId, sessionId, runStore.sessionsVersion],
  );

  // useAsync keeps the last good data while the next thread loads: never show another thread's turns
  const d = detail.data && detail.data.id === sessionId ? detail.data : undefined;

  // each turn's saved work log, fetched once
  const [logs, setLogs] = useState<Record<string, AgentEvent[]>>({});
  useEffect(() => {
    let live = true;
    for (const t of d?.turns ?? []) {
      if (logs[t.id]) continue;
      api.replay(tenantId, t.id).then((ev) => { if (live) setLogs((m) => ({ ...m, [t.id]: ev })); }, () => { if (live) setLogs((m) => ({ ...m, [t.id]: [] })); });
    }
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d, tenantId]);
  useEffect(() => { setLogs({}); }, [tenantId, sessionId]);

  // a turn in this thread still working on the server (asked in another tab, or from Discord): follow it
  const runningTurn = d?.running;
  useEffect(() => {
    if (runningTurn?.status === "running") runStore.attach(tenantId, runningTurn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningTurn?.turnId, tenantId]);

  const [replays, setReplays] = useState<Record<string, string>>({});
  useEffect(() => { setReplays({}); }, [tenantId, sessionId]);

  const liveRuns = useMemo(() => {
    const out: RunRecord[] = [];
    for (const k of snap.order) {
      const r = snap.runs.get(k);
      if (!r || r.kind !== "live" || r.tenant !== tenantId) continue;
      if ((sessionId && r.sessionId === sessionId) || k === pendingKey) out.push(r);
    }
    return out;
  }, [snap, sessionId, pendingKey, tenantId]);

  const turns = useMemo<TurnItem[]>(() => {
    const stored = d?.turns ?? [];
    const out: TurnItem[] = stored.map((t) => {
      const rk = replays[t.id];
      const rp = rk ? snap.runs.get(rk) : undefined;
      const liveTwin = liveRuns.find((r) => r.turnId === t.id);
      // until its work log arrives (or when it has none: a seeded or older thread), the saved answer stands in for it
      const events = rp ? rp.events : liveTwin?.events ?? (logs[t.id]?.length ? logs[t.id]! : savedAnswer(t));
      // nothing to show at all, once the log was asked for: an error with Ask again, never an endless grey box
      const unreadable = !events.length && logs[t.id] !== undefined && !t.ended;
      const ended: RunRecord["status"] = t.ended === "stopped" || liveTwin?.status === "stopped" ? "stopped" : t.ended === "failed" || unreadable ? "error" : "done";
      return {
        key: t.id, turnId: t.id, question: t.question, at: t.at, record: t, ...(t.target ? { target: t.target } : {}),
        events,
        status: rp ? rp.status : ended,
        replaying: rp?.status === "running",
        ...(ended === "error" ? { error: unreadable ? "This answer could not be loaded." : t.error ?? "Something went wrong." } : {}),
      };
    });
    for (const r of liveRuns) {
      if (r.turnId && stored.some((t) => t.id === r.turnId)) continue;
      out.push({ key: r.key, turnId: r.turnId, question: r.question, events: r.events, status: r.status, error: r.error, ...(r.target ? { target: r.target } : {}) });
    }
    // a thread with a question and nothing after it (the run died with the server, before anything was saved): say so
    if (d && !out.length && !d.running) out.push({ key: `lost:${d.id}`, question: d.title, events: [], status: "error", error: LOST_ANSWER });
    return out;
  }, [d, logs, replays, liveRuns, snap]);

  const views = useMemo(() => turns.map((t) => deriveRun(t.events)), [turns]);
  const running = turns.some((t) => t.status === "running" && !t.replaying);
  const liveRun = [...liveRuns].reverse().find((r) => r.status === "running");

  const replay = (t: TurnItem, opts: { paced: boolean; speed: () => number }) => {
    if (!t.turnId) return;
    const events = logs[t.turnId]?.length ? logs[t.turnId]! : t.events;
    const key = runStore.replay(tenantId, t.turnId, t.question, events, opts);
    setReplays((m) => ({ ...m, [t.turnId!]: key }));
  };

  return { detail: d, loading: detail.loading, turns, views, running, liveRun, replay };
}
