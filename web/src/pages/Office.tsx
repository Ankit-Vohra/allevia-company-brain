// Home: the office. Ask the team something and watch it work: the plan on the whiteboard, files flying desk to desk,
// findings pinned, reviews stamped, and the answer written by the Chief of Staff. Beside it, the business's 90 days
// (goals against day 0, the first-pass curve, what the team can see) and Meera's morning brief. Desks switched off in
// Team settings sit dimmed, and every rule the team learned from the owner's edits is a book on Sara's shelf.
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import type { AgentId, LearnedRuleDto } from "@shared/contracts";
import { AGENTS, DEPARTMENTS } from "@shared/roster";
import { api } from "../api";
import { AgentDrawer } from "../components/AgentDrawer";
import { BriefPanel } from "../components/BriefPanel";
import { AgentAvatar, agentDef, deptOf, fmtMs } from "../components/bits";
import { Icon } from "../components/Icon";
import { LearnedPathDialog } from "../components/Learning";
import { ProgramCard } from "../components/ProgramCard";
import { WorkFeed } from "../components/WorkFeed";
import { OfficeCanvas, type ShelfBook } from "../office/OfficeCanvas";
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

/** Fired by Team settings and Approvals when desks or learned rules change, so the office redraws them. */
export const TEAM_CHANGED = "allevia:team-changed";

type Tab = "p90" | "brief" | "log";

export function OfficePage() {
  const { tenant, mode, effectiveTheme, reducedMotion, speed, setSpeed } = useApp();
  const snap = useRunStore();
  const [runKey, setRunKey] = useState<string | undefined>(() => runStore.latest(tenant.id)?.key);
  const record = useRun(runKey);
  const view = useRunView(record);
  const [question, setQuestion] = useState("");
  const [selected, setSelected] = useState<AgentId | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [tab, setTab] = useState<Tab>(() => (record ? "log" : "p90"));
  const [askFocus, setAskFocus] = useState(false);
  const [openRule, setOpenRule] = useState<LearnedRuleDto | null>(null);
  const compact = useMedia("(max-width: 760px)");
  const narrow = useMedia("(max-width: 860px)");
  const nav = useNavigate();
  const autoStarted = useRef(false);

  // the 90 days, the ladder, the team's desks and what it learned; refreshed when another screen changes them
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const on = () => setTick((t) => t + 1);
    window.addEventListener(TEAM_CHANGED, on);
    return () => window.removeEventListener(TEAM_CHANGED, on);
  }, []);
  const program = useAsync(() => api.program(tenant.id), [tenant.id, tick]);
  const caps = useAsync(() => api.capabilities(tenant.id).catch(() => []), [tenant.id]);
  const team = useAsync(() => api.team(tenant.id).catch(() => []), [tenant.id, tick]);
  const learning = useAsync(() => api.learning(tenant.id).catch(() => null), [tenant.id, tick]);

  const off = useMemo(() => new Set((team.data ?? []).filter((a) => !a.enabled).map((a) => a.id)), [team.data]);
  const books = useMemo<ShelfBook[]>(() => {
    const active = (learning.data?.rules ?? []).filter((r) => r.status === "active");
    return [...active].reverse().map((r) => ({ id: r.id, text: r.text, confidence: r.confidence, hue: (r.agents[0] && deptOf(r.agents[0])?.hue) || 60 }));
  }, [learning.data]);

  // follow the tenant: show its latest run, if any; else a turn still working on the server (asked in a tab that has
  // since closed, or from another one), which the office then follows live
  useEffect(() => {
    const latest = runStore.latest(tenant.id);
    setRunKey(latest?.key);
    setTab(latest ? "log" : "p90");
    if (latest?.status === "running" || mode !== "live") return;
    let live = true;
    api.liveTurns(tenant.id).then((list) => {
      const t = list[0];
      if (!live || !t || runStore.latest(tenant.id, (r) => r.status === "running")) return;
      setRunKey(runStore.attach(tenant.id, t));
      setTab("log");
    }, () => {});
    return () => { live = false; };
  }, [tenant.id, mode]);

  // ?ask=…&seek=ms starts a run straight away (used for demos and screenshots); ?tab=brief opens the brief
  useEffect(() => {
    if (autoStarted.current) return;
    const p = new URLSearchParams(location.search);
    if (p.get("tab") === "brief") setTab("brief");
    const q = p.get("ask");
    if (!q) return;
    autoStarted.current = true;
    setQuestion("");
    setRunKey(runStore.start(tenant.id, q, { seekMs: Number(p.get("seek") ?? 0) || undefined }));
    setTab("log");
  }, [tenant.id]);

  const running = record?.status === "running";
  useEffect(() => {
    if (!running || !record) return;
    const tick = () => setElapsed(Date.now() - record.startedAt);
    tick(); // a re-attached turn started before this page: show its real age at once
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [running, record]);

  void snap;
  const sessions = useAsync(() => api.sessions(tenant.id), [tenant.id, runStore.sessionsVersion]);

  const ask = (q: string) => {
    const text = q.trim();
    if (!text || running) return;
    setRunKey(runStore.start(tenant.id, text));
    setQuestion("");
    setTab("log");
    setAskFocus(false);
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
    setTab("log");
  };

  const working = view?.activeAgents ?? [];
  const nodes = view?.nodes;
  const askHref = view?.sessionId ? `/ask/${view.sessionId}` : "/ask";
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
  const offCount = off.size;
  const statusLine = running
    ? `${working.length ? `${working.map((a) => agentDef(a)?.name).join(", ")} working` : "Starting"} · ${fmtMs(Math.max(0, elapsed))}`
    : record?.status === "done" && view?.final
      ? `Last request answered in ${fmtMs(view.final.ms)}`
      : `${AGENTS.length} staff in ${DEPARTMENTS.length} departments`;
  const showSuggest = askFocus && !question.trim() && !running && !narrow;
  const activeTab: Tab = tab === "log" && !record ? "p90" : tab;

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "p90", label: "90 days" },
    { id: "brief", label: "Morning brief" },
    ...(record ? [{ id: "log" as const, label: "Work log" }] : []),
  ];

  return (
    <div className="office-page">
      <section className="office-main" aria-labelledby="office-title">
        <div className="office-head">
          <div className="office-titles">
            <h1 id="office-title" className="office-title">{tenant.name}<span className="office-title-sub">’s office</span></h1>
            <p className="office-meta"><span>{today}</span><span aria-hidden="true">·</span><span className={running ? "is-live" : ""}>{statusLine}</span>
              {offCount > 0 && !running && <><span aria-hidden="true">·</span><Link to="/team" className="office-off-link">{offCount} {offCount === 1 ? "desk" : "desks"} switched off</Link></>}
            </p>
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
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => runKey && runStore.stop(runKey)} disabled={record?.stopping}>
                <Icon name="stop" size={14} /> {record?.stopping ? "Stopping…" : "Stop"}
              </button>
            ) : (
              <button type="button" className="btn btn-ghost btn-sm" onClick={replayLatest} disabled={!sessions.data?.length}><Icon name="replay" size={14} /> Replay last request</button>
            )}
          </div>
        </div>

        <div className="ask-wrap">
          <form className="ask-bar" onSubmit={onSubmit} role="search" aria-label="Ask your team">
            <label htmlFor="office-q" className="visually-hidden">Ask your team</label>
            <span className="ask-bar-icon" aria-hidden="true"><Icon name="ask" size={18} /></span>
            <input
              id="office-q"
              className="ask-input"
              placeholder="Ask your team…"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onFocus={() => setAskFocus(true)}
              onBlur={() => setTimeout(() => setAskFocus(false), 150)}
              onKeyDown={(e) => { if (e.key === "Escape") setAskFocus(false); }}
              autoComplete="off"
              disabled={running}
            />
            <button type="submit" className="btn btn-gold" disabled={!question.trim() || running}>
              {running ? "Working…" : "Ask"} <Icon name="send" size={16} />
            </button>
          </form>
          {showSuggest && (
            <ul className="ask-suggest" aria-label="Try asking">
              <li className="ask-suggest-head">Try asking</li>
              {suggestions.map((s) => (
                <li key={s}>
                  <button type="button" className="ask-suggest-q" onMouseDown={(e) => e.preventDefault()} onClick={() => ask(s)}>
                    <span>{s}</span><Icon name="send" size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
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
            off={off}
            books={learning.data ? books : undefined}
            onBook={(id) => setOpenRule(learning.data?.rules.find((r) => r.id === id) ?? null)}
          />
        </div>
        {compact && ticker && (
          <p className="ticker" aria-live="polite">
            <AgentAvatar id={ticker.agent} size={20} />
            <b>{agentDef(ticker.agent)?.name}</b>
            {ticker.tool && <code className="tool-name">{ticker.tool}()</code>}
            <span>{ticker.text}</span>
          </p>
        )}
      </section>

      <aside className="office-log panel" aria-label="Your 90 days, the morning brief and the work log">
        <div className="panel-head office-tabs" role="tablist" aria-label="Side panel">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`otab-${t.id}`}
              aria-selected={activeTab === t.id}
              aria-controls={`opane-${t.id}`}
              className={`office-tab${activeTab === t.id ? " is-on" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {t.id === "log" && record && <span className={`tab-dot${running ? " is-live" : record.status === "done" ? " is-done" : ""}`} aria-hidden="true" />}
            </button>
          ))}
        </div>

        {activeTab === "p90" && (
          <div className="office-pane" role="tabpanel" id="opane-p90" aria-labelledby="otab-p90">
            <ProgramCard program={program.data} caps={caps.data} loading={program.loading} error={program.error} />
            <button type="button" className="pane-next" onClick={() => setTab("brief")}>
              <AgentAvatar id="chief-of-staff" size={22} /> <span>Read Meera’s morning brief</span> <Icon name="chevron-right" size={14} />
            </button>
          </div>
        )}
        {activeTab === "brief" && (
          <div className="office-pane" role="tabpanel" id="opane-brief" aria-labelledby="otab-brief">
            <BriefPanel tenantId={tenant.id} onRan={() => program.reload()} />
          </div>
        )}
        {activeTab === "log" && record && (
          <div className="office-pane is-log" role="tabpanel" id="opane-log" aria-labelledby="otab-log">
            <div className="log-status">
              <p className="log-question">{record.question}</p>
              <span className={`badge ${running ? "badge-gold" : record.status === "done" ? "badge-ok" : "badge-ink"}`}>
                {running ? "Live" : record.status === "done" ? (record.kind === "replay" ? "Replayed" : "Done") : record.status === "stopped" ? "Stopped" : "Error"}
              </span>
            </div>
            <WorkFeed events={record.events} view={view} status={record.status} askHref={askHref} nodes={nodes} limit={narrow ? 6 : undefined} />
            {!running && (
              <div className="log-foot">
                <button type="button" className="btn btn-quiet btn-sm" onClick={() => { setRunKey(undefined); setTab("p90"); }}>Clear</button>
                {view?.sessionId && <button type="button" className="btn btn-ghost btn-sm" onClick={() => nav(askHref)}>Follow up in Ask</button>}
              </div>
            )}
          </div>
        )}
      </aside>

      <AgentDrawer agentId={selected} onClose={() => setSelected(null)} view={view} />
      <LearnedPathDialog rule={openRule} onClose={() => setOpenRule(null)} onRetired={() => setTick((t) => t + 1)} />
    </div>
  );
}
