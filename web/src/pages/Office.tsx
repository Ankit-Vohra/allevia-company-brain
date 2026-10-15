// Home: the office. Ask the team something and watch it work: the plan on the whiteboard, files flying desk to desk,
// findings pinned, reviews stamped, and the answer written by the Chief of Staff.
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import type { AgentId } from "@shared/contracts";
import { AGENTS, DEPARTMENTS } from "@shared/roster";
import { api } from "../api";
import { AgentDrawer } from "../components/AgentDrawer";
import { AgentAvatar, agentDef, fmtMs } from "../components/bits";
import { Icon } from "../components/Icon";
import { WorkFeed } from "../components/WorkFeed";
import { OfficeCanvas } from "../office/OfficeCanvas";
import { fmtLongDate } from "../lib/format";
import { useMedia } from "../lib/useMedia";
import { useApp, useAsync } from "../state/app";
import { laneOf } from "../state/derive";
import { runStore, useRun, useRunStore, useRunView } from "../state/runs";
import "./office-page.css";

export const SUGGESTIONS: Record<string, string[]> = {
  aamdani: [
    "Why did we pause daily stories, and what should we post instead?",
    "Which pages are losing search clicks, and why?",
    "What is waiting on me this week?",
  ],
  "avs-atelier": ["Why don't we show up when people search 'architect in Raipur'?"],
};

/** For a business set up a moment ago: questions any owner can ask on day one. */
export const FIRST_DAY_QUESTIONS = [
  "What should we fix first on the website, and why?",
  "Who are our customers, and what do they need from us?",
];

export function OfficePage() {
  const { tenant, mode, effectiveTheme, reducedMotion, speed, setSpeed } = useApp();
  const snap = useRunStore();
  const [runKey, setRunKey] = useState<string | undefined>(() => runStore.latest(tenant.id)?.key);
  const record = useRun(runKey);
  const view = useRunView(record);
  const [question, setQuestion] = useState("");
  const [selected, setSelected] = useState<AgentId | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const compact = useMedia("(max-width: 760px)");
  const narrow = useMedia("(max-width: 860px)");
  const nav = useNavigate();
  const autoStarted = useRef(false);

  // follow the tenant: show its latest run, if any
  useEffect(() => { setRunKey(runStore.latest(tenant.id)?.key); }, [tenant.id]);

  // ?ask=…&seek=ms starts a run straight away (used for demos and screenshots)
  useEffect(() => {
    if (autoStarted.current) return;
    const p = new URLSearchParams(location.search);
    const q = p.get("ask");
    if (!q) return;
    autoStarted.current = true;
    setQuestion("");
    setRunKey(runStore.start(tenant.id, q, { seekMs: Number(p.get("seek") ?? 0) || undefined }));
  }, [tenant.id]);

  const running = record?.status === "running";
  useEffect(() => {
    if (!running || !record) return;
    const id = setInterval(() => setElapsed(Date.now() - record.startedAt), 250);
    return () => clearInterval(id);
  }, [running, record]);

  void snap;
  const sessions = useAsync(() => api.sessions(tenant.id), [tenant.id, runStore.sessionsVersion]);

  const ask = (q: string) => {
    const text = q.trim();
    if (!text || running) return;
    setRunKey(runStore.start(tenant.id, text));
    setQuestion("");
  };
  const onSubmit = (e: FormEvent) => { e.preventDefault(); ask(question); };

  const replayLatest = async () => {
    const s = sessions.data?.[0];
    if (!s) return;
    const detail = await api.session(tenant.id, s.id);
    const turn = detail.turns[detail.turns.length - 1];
    if (!turn) return;
    const events = await api.replay(tenant.id, turn.id);
    setRunKey(runStore.replay(tenant.id, turn.id, turn.question, events, { paced: true, speed: () => speed }));
  };

  const working = view?.activeAgents ?? [];
  const nodes = view?.nodes;
  const askHref = view?.sessionId && record?.kind === "live" ? `/ask/${view.sessionId}` : view?.sessionId ? `/ask/${view.sessionId}` : "/ask";
  const ticker = useMemo(() => {
    if (!view) return null;
    const a = working[working.length - 1];
    if (!a) return null;
    const lane = laneOf(view, a);
    const step = lane?.steps[lane.steps.length - 1];
    return { agent: a, tool: step && !step.done ? step.name : undefined, text: lane?.status ?? lane?.task ?? "" };
  }, [view, working]);

  const suggestions = SUGGESTIONS[tenant.id] ?? FIRST_DAY_QUESTIONS;
  const today = fmtLongDate();
  const statusLine = running
    ? `${working.length ? `${working.map((a) => agentDef(a)?.name).join(", ")} working` : "Starting"} · ${fmtMs(Math.max(0, elapsed))}`
    : record?.status === "done" && view?.final
      ? `Last request answered in ${fmtMs(view.final.ms)}`
      : `${AGENTS.length} staff in ${DEPARTMENTS.length} departments`;

  return (
    <div className="office-page">
      <section className="office-main" aria-labelledby="office-title">
        <div className="office-head">
          <div className="office-titles">
            <h1 id="office-title" className="office-title">{tenant.name}<span className="office-title-sub">’s office</span></h1>
            <p className="office-meta"><span>{today}</span><span aria-hidden="true">·</span><span className={running ? "is-live" : ""}>{statusLine}</span></p>
          </div>
          <div className="office-tools">
            {(mode === "mock" || record?.kind === "replay") && (
              <div className="seg" role="group" aria-label="Playback speed">
                {[1, 4].map((s) => (
                  <button key={s} type="button" className={`seg-btn${speed === s ? " is-on" : ""}`} aria-pressed={speed === s} onClick={() => setSpeed(s)}>{s}×</button>
                ))}
              </div>
            )}
            {running ? (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => runKey && runStore.stop(runKey)}><Icon name="stop" size={14} /> Stop</button>
            ) : (
              <button type="button" className="btn btn-ghost btn-sm" onClick={replayLatest} disabled={!sessions.data?.length}><Icon name="replay" size={14} /> Replay last request</button>
            )}
          </div>
        </div>

        <form className="ask-bar" onSubmit={onSubmit} role="search" aria-label="Ask your team">
          <label htmlFor="office-q" className="visually-hidden">Ask your team</label>
          <span className="ask-bar-icon" aria-hidden="true"><Icon name="ask" size={18} /></span>
          <input
            id="office-q"
            className="ask-input"
            placeholder="Ask your team…"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            autoComplete="off"
            disabled={running}
          />
          <button type="submit" className="btn btn-gold" disabled={!question.trim() || running}>
            {running ? "Working…" : "Ask"} <Icon name="send" size={16} />
          </button>
        </form>
        {!running && !record && narrow && (
          <div className="suggest" aria-label="Try one of these">
            {suggestions.map((s) => (
              <button key={s} type="button" className="suggest-chip" onClick={() => ask(s)}>{s}</button>
            ))}
          </div>
        )}

        <div className="office-stage">
          <OfficeCanvas
            view={view}
            events={record?.events}
            runKey={runKey}
            dark={effectiveTheme === "dark"}
            reducedMotion={reducedMotion}
            speed={speed}
            compact={compact}
            maxHeight={narrow ? 100000 : undefined}
            selected={selected}
            onSelect={setSelected}
          />
        </div>
        {compact && ticker && (
          <p className="ticker" aria-live="polite">
            <AgentAvatar id={ticker.agent} size={20} />
            <b>{agentDef(ticker.agent)?.name}</b>
            {ticker.tool && <code className="tool-name">{ticker.tool}</code>}
            <span>{ticker.text}</span>
          </p>
        )}
      </section>

      <aside className="office-log panel" aria-labelledby="log-title">
        <div className="panel-head">
          <h2 id="log-title" className="log-title">Work log</h2>
          {record && (
            <span className={`badge ${running ? "badge-gold" : record.status === "done" ? "badge-ok" : "badge-ink"}`}>
              {running ? "Live" : record.status === "done" ? (record.kind === "replay" ? "Replayed" : "Done") : record.status === "stopped" ? "Stopped" : "Error"}
            </span>
          )}
        </div>
        {record ? (
          <>
            <p className="log-question">{record.question}</p>
            <WorkFeed events={record.events} view={view} status={record.status} askHref={askHref} nodes={nodes} limit={narrow ? 6 : undefined} />
          </>
        ) : (
          <div className="roster">
            <p className="roster-intro">Your team is in. Ask a question and watch who picks it up, what they check, and how they hand it on.</p>
            {!narrow && (
              <div className="try">
                <h3 className="section-title">Try asking</h3>
                {suggestions.map((s) => (
                  <button key={s} type="button" className="try-q" onClick={() => ask(s)}>
                    <span>{s}</span>
                    <Icon name="send" size={14} />
                  </button>
                ))}
              </div>
            )}
            <ul className="roster-list">
              {DEPARTMENTS.map((d) => (
                <li key={d.id} className="roster-dept" style={{ ["--hue" as string]: d.hue }}>
                  <span className="roster-dept-name">{d.name}</span>
                  {AGENTS.filter((a) => a.department === d.id).map((a) => (
                    <button key={a.id} type="button" className="roster-agent" onClick={() => setSelected(a.id)}>
                      <AgentAvatar id={a.id} size={26} />
                      <span><b>{a.name}</b><span>{a.title}</span></span>
                    </button>
                  ))}
                </li>
              ))}
            </ul>
            {sessions.data && sessions.data.length > 0 && (
              <p className="roster-foot">
                Last thread: <Link to={`/ask/${sessions.data[0]!.id}`}>{sessions.data[0]!.title}</Link>
              </p>
            )}
          </div>
        )}
        {record && !running && (
          <div className="log-foot">
            <button type="button" className="btn btn-quiet btn-sm" onClick={() => { setRunKey(undefined); }}>Clear</button>
            {view?.sessionId && <button type="button" className="btn btn-ghost btn-sm" onClick={() => nav(askHref)}>Follow up in Ask</button>}
          </div>
        )}
      </aside>

      <AgentDrawer agentId={selected} onClose={() => setSelected(null)} view={view} />
    </div>
  );
}
