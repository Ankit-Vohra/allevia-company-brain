// Ask: a thread with the team. Each turn shows who worked on it (a timeline and per-desk lanes), the answer with its
// sources, and the graph on the right lighting the path the answer walked, in gold. Stored turns replay through the same
// view, so "how did we get here" is always one click away.
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import type { AgentEvent, NodeRef } from "@shared/contracts";
import { api } from "../api";
import { AgentAvatar, ChecksBadges, agentDef, fmtAgo, fmtDate, fmtMs } from "../components/bits";
import { Icon, type IconName } from "../components/Icon";
import { Markdown } from "../components/Markdown";
import { RunTimeline } from "../components/RunTimeline";
import { WorkLanes } from "../components/WorkLanes";
import { labelOfId, nameOfId } from "../lib/labels";
import { useMedia } from "../lib/useMedia";
import { useApp, useAsync } from "../state/app";
import { type RunView, deriveRun, laneOf } from "../state/derive";
import { type RunRecord, runStore, useRunStore } from "../state/runs";
import type { SessionSummary, TurnRecord } from "../types-ext";
import { SUGGESTIONS } from "./Office";
import "./ask.css";

const GraphView = lazy(() => import("../components/GraphView"));

interface TurnItem {
  key: string;
  turnId?: string;
  question: string;
  at?: string;
  events: AgentEvent[];
  status: RunRecord["status"];
  record?: TurnRecord;
  replaying?: boolean;
  error?: string;
}

const CHANNEL_ICON: Record<SessionSummary["channel"], IconName> = { web: "globe", discord: "chat", cli: "menu" };

export default function AskPage() {
  const { sessionId } = useParams();
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const { tenant, effectiveTheme, reducedMotion, speed } = useApp();
  const snap = useRunStore();
  const narrow = useMedia("(max-width: 1080px)");
  const phone = useMedia("(max-width: 760px)");

  const sessions = useAsync(() => api.sessions(tenant.id), [tenant.id, runStore.sessionsVersion]);
  const detail = useAsync(
    () => (sessionId ? api.session(tenant.id, sessionId).catch(() => null) : Promise.resolve(null)),
    [tenant.id, sessionId, runStore.sessionsVersion],
  );

  // stored event logs, one per turn, fetched once
  const [logs, setLogs] = useState<Record<string, AgentEvent[]>>({});
  useEffect(() => {
    const turns = detail.data?.turns ?? [];
    let live = true;
    for (const t of turns) {
      if (logs[t.id]) continue;
      api.replay(tenant.id, t.id).then((ev) => { if (live) setLogs((m) => ({ ...m, [t.id]: ev })); }, () => {});
    }
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.data, tenant.id]);

  // a run started on /ask before it has a thread id; once the session event arrives we move to /ask/:id
  const [pendingKey, setPendingKey] = useState<string | undefined>();
  const pending = pendingKey ? snap.runs.get(pendingKey) : undefined;
  useEffect(() => {
    if (pending?.sessionId && pending.sessionId !== sessionId) nav(`/ask/${pending.sessionId}`, { replace: true });
  }, [pending?.sessionId, sessionId, nav]);

  // replays of stored turns, keyed by turn id
  const [replays, setReplays] = useState<Record<string, string>>({});

  // live runs for this thread (asked here or in the office)
  const liveRuns = useMemo(() => {
    const out: RunRecord[] = [];
    for (const k of snap.order) {
      const r = snap.runs.get(k);
      if (!r || r.kind !== "live" || r.tenant !== tenant.id) continue;
      if ((sessionId && r.sessionId === sessionId) || k === pendingKey) out.push(r);
    }
    return out;
  }, [snap, sessionId, pendingKey, tenant.id]);

  const turns = useMemo<TurnItem[]>(() => {
    const stored = detail.data?.turns ?? [];
    const out: TurnItem[] = stored.map((t) => {
      const rk = replays[t.id];
      const rp = rk ? snap.runs.get(rk) : undefined;
      const liveTwin = liveRuns.find((r) => r.turnId === t.id);
      return {
        key: t.id, turnId: t.id, question: t.question, at: t.at, record: t,
        events: rp ? rp.events : liveTwin?.events ?? logs[t.id] ?? [],
        status: rp ? rp.status : "done",
        replaying: rp?.status === "running",
      };
    });
    for (const r of liveRuns) {
      if (r.turnId && stored.some((t) => t.id === r.turnId)) continue;
      out.push({ key: r.key, turnId: r.turnId, question: r.question, events: r.events, status: r.status, error: r.error });
    }
    return out;
  }, [detail.data, logs, replays, liveRuns, snap]);

  const views = useMemo(() => turns.map((t) => deriveRun(t.events)), [turns]);
  const running = turns.some((t) => t.status === "running" && !t.replaying);

  // which turn the graph shows: the newest, unless one was picked
  const [picked, setPicked] = useState<string | undefined>();
  useEffect(() => { setPicked(undefined); }, [sessionId]);
  const lastKey = turns[turns.length - 1]?.key;
  const graphTurnKey = picked && turns.some((t) => t.key === picked) ? picked : lastKey;
  const graphIdx = turns.findIndex((t) => t.key === graphTurnKey);
  const graphView: RunView | undefined = graphIdx >= 0 ? views[graphIdx] : undefined;

  const [focus, setFocus] = useState<string | undefined>();
  const [highlight, setHighlight] = useState<string[] | undefined>();
  const [paneTab, setPaneTab] = useState<"thread" | "graph">("thread");
  const [threadsOpen, setThreadsOpen] = useState(false);
  useEffect(() => { setFocus(undefined); setHighlight(undefined); }, [graphTurnKey]);

  const onCite = useCallback((key: string) => (id: string) => {
    setPicked(key);
    setHighlight(undefined);
    setFocus(id);
    if (phone) setPaneTab("graph");
  }, [phone]);
  const onNodes = useCallback((key: string) => (ids: string[]) => {
    setPicked(key);
    setFocus(undefined);
    setHighlight(ids);
    if (phone) setPaneTab("graph");
  }, [phone]);

  // composer
  const [text, setText] = useState(() => params.get("q") ?? "");
  const ask = (q: string) => {
    const question = q.trim();
    if (!question || running) return;
    const key = runStore.start(tenant.id, question, { sessionId });
    if (!sessionId) setPendingKey(key);
    setText("");
    setPicked(undefined);
  };
  const onSubmit = (e: FormEvent) => { e.preventDefault(); ask(text); };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); ask(text); }
  };

  // ?ask=…&seek=ms starts a run straight away (demos, screenshots)
  const autoStarted = useRef(false);
  useEffect(() => {
    const q = params.get("ask");
    if (!q || autoStarted.current) return;
    autoStarted.current = true;
    const key = runStore.start(tenant.id, q, { sessionId, seekMs: Number(params.get("seek") ?? 0) || undefined });
    if (!sessionId) setPendingKey(key);
    const next = new URLSearchParams(params);
    next.delete("ask"); next.delete("seek");
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // reset when the business changes
  const firstTenant = useRef(tenant.id);
  useEffect(() => {
    if (firstTenant.current === tenant.id) return;
    firstTenant.current = tenant.id;
    setPendingKey(undefined);
    setReplays({});
    setLogs({});
    if (sessionId) nav("/ask", { replace: true });
  }, [tenant.id, sessionId, nav]);

  const replay = (t: TurnItem) => {
    if (!t.turnId) return;
    const events = logs[t.turnId] ?? t.events;
    const key = runStore.replay(tenant.id, t.turnId, t.question, events, { paced: !reducedMotion, speed: () => Math.max(speed, 2) });
    setReplays((m) => ({ ...m, [t.turnId!]: key }));
    setPicked(t.key);
  };

  // keep the newest work in view while a run streams
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastView = views[views.length - 1];
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stick.current || !running) return;
    el.scrollTo({ top: el.scrollHeight, behavior: reducedMotion ? "auto" : "smooth" });
  }, [lastView?.count, running, reducedMotion]);

  const title = detail.data?.title ?? pending?.question ?? (sessionId && detail.loading ? "" : "New thread");
  const notFound = sessionId && !detail.loading && detail.data === null && !liveRuns.length;
  const suggestions = SUGGESTIONS[tenant.id] ?? [];

  const threadList = (
    <ThreadList
      sessions={sessions.data}
      loading={sessions.loading && !sessions.data}
      activeId={sessionId}
      onPick={() => setThreadsOpen(false)}
    />
  );

  const graphPane = (
    <GraphPane
      view={graphView}
      turnLabel={graphIdx >= 0 && turns.length > 1 ? `Turn ${graphIdx + 1} of ${turns.length}` : undefined}
      focus={focus}
      highlight={highlight}
      onFocus={(id) => { setHighlight(undefined); setFocus(id); }}
      onClear={() => { setFocus(undefined); setHighlight(undefined); }}
      dark={effectiveTheme === "dark"}
      reducedMotion={reducedMotion}
    />
  );

  return (
    <div className={`ask-page${phone ? ` show-${paneTab}` : ""}`}>
      {!narrow && <aside className="ask-rail" aria-label="Threads">{threadList}</aside>}

      <section className="ask-main" aria-labelledby="ask-title">
        <header className="ask-head">
          {narrow && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setThreadsOpen(true)} aria-haspopup="dialog">
              <Icon name="menu" size={15} /> Threads
            </button>
          )}
          <h1 id="ask-title" className="ask-title">{title || <span className="skeleton" style={{ display: "inline-block", width: 220, height: 22 }} />}</h1>
          {phone && (
            <div className="seg ask-tabs" role="tablist" aria-label="Show">
              <button type="button" role="tab" aria-selected={paneTab === "thread"} className={`seg-btn${paneTab === "thread" ? " is-on" : ""}`} onClick={() => setPaneTab("thread")}>Thread</button>
              <button type="button" role="tab" aria-selected={paneTab === "graph"} className={`seg-btn${paneTab === "graph" ? " is-on" : ""}`} onClick={() => setPaneTab("graph")}>Graph</button>
            </div>
          )}
          {sessionId && !phone && (
            <Link to="/ask" className="btn btn-ghost btn-sm ask-new"><Icon name="plus" size={14} /> New thread</Link>
          )}
        </header>

        <div className="ask-scroll" ref={scrollRef} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
          {notFound ? (
            <div className="ask-empty">
              <h2 className="ask-empty-title">This thread isn't in {tenant.name}'s records.</h2>
              <p className="muted">It may belong to another business. Pick one from the list, or start a new thread.</p>
              <Link to="/ask" className="btn btn-ghost btn-sm" style={{ marginTop: 12 }}>Start a new thread</Link>
            </div>
          ) : turns.length === 0 && !detail.loading ? (
            <div className="ask-empty">
              <h2 className="ask-empty-title">Ask {tenant.name}'s team anything about the business.</h2>
              <p className="muted">Meera plans who does what, each desk checks the graph and files a finding, reviewers check the numbers, and you get one answer with its sources.</p>
              {suggestions.length > 0 && (
                <ul className="ask-suggest" aria-label="Try one of these">
                  {suggestions.map((s) => (
                    <li key={s}><button type="button" className="try-q" onClick={() => ask(s)}><span>{s}</span><Icon name="send" size={14} /></button></li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <ol className="turns">
              {turns.map((t, i) => (
                <TurnBlock
                  key={t.key}
                  turn={t}
                  view={views[i]!}
                  latest={i === turns.length - 1}
                  inGraph={t.key === graphTurnKey && turns.length > 1}
                  activeCite={t.key === graphTurnKey ? focus : undefined}
                  onCite={onCite(t.key)}
                  onNodes={onNodes(t.key)}
                  onReplay={() => replay(t)}
                  onShowGraph={() => { setPicked(t.key); if (phone) setPaneTab("graph"); }}
                  onRetry={() => ask(t.question)}
                />
              ))}
              {detail.loading && !turns.length && <li className="turn"><span className="skeleton" style={{ display: "block", height: 180 }} /></li>}
            </ol>
          )}
        </div>

        <form className="composer" onSubmit={onSubmit} aria-label="Ask your team">
          <label htmlFor="ask-q" className="visually-hidden">Your question</label>
          <textarea
            id="ask-q"
            className="composer-input"
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            placeholder={sessionId ? "Ask a follow-up…" : `Ask ${tenant.name}'s team…`}
            disabled={running}
          />
          <button type="submit" className="btn btn-gold" disabled={!text.trim() || running}>
            {running ? "Working…" : "Ask"} <Icon name="send" size={16} />
          </button>
        </form>
      </section>

      <aside className="ask-graph" aria-label="Graph of this answer">{graphPane}</aside>

      {narrow && (
        <SideSheet open={threadsOpen} onClose={() => setThreadsOpen(false)} title="Threads">{threadList}</SideSheet>
      )}
    </div>
  );
}

function ThreadList({ sessions, loading, activeId, onPick }: { sessions?: SessionSummary[]; loading: boolean; activeId?: string; onPick: () => void }) {
  return (
    <div className="threads">
      <div className="threads-head">
        <h2 className="threads-title">Threads</h2>
        <Link to="/ask" className="btn btn-ghost btn-sm" onClick={onPick}><Icon name="plus" size={14} /> New</Link>
      </div>
      {loading ? (
        <div className="threads-skel">{[0, 1, 2].map((i) => <span key={i} className="skeleton" />)}</div>
      ) : !sessions?.length ? (
        <p className="threads-empty">No threads yet. Questions you ask here, in Discord or from the command line all land in this list.</p>
      ) : (
        <ul className="thread-list">
          {sessions.map((s) => (
            <li key={s.id}>
              <Link to={`/ask/${s.id}`} className={`thread${s.id === activeId ? " is-active" : ""}`} aria-current={s.id === activeId ? "page" : undefined} onClick={onPick}>
                <span className="thread-title">{s.title}</span>
                <span className="thread-meta">
                  <Icon name={CHANNEL_ICON[s.channel] ?? "globe"} size={12} />
                  {fmtAgo(s.lastAt)} · {s.turns} {s.turns === 1 ? "turn" : "turns"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TurnBlock({ turn, view, latest, inGraph, activeCite, onCite, onNodes, onReplay, onShowGraph, onRetry }: {
  turn: TurnItem; view: RunView; latest: boolean; inGraph: boolean; activeCite?: string;
  onCite: (id: string) => void; onNodes: (ids: string[]) => void; onReplay: () => void; onShowGraph: () => void; onRetry: () => void;
}) {
  const live = turn.status === "running";
  const done = !!view.final;
  // the lanes are open while the team works; once answered they fold away (the timeline stays) unless opened
  const [open, setOpen] = useState<boolean | undefined>(undefined);
  const lanesOpen = open ?? (live || (!done && view.count > 0));
  const laneRef = useRef<HTMLDivElement>(null);
  const jump = (key: string) => {
    setOpen(true);
    requestAnimationFrame(() => document.getElementById(`lane-${key.replace(/[^a-z0-9-]/gi, "-")}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  };
  const agents = view.final?.agents ?? [...new Set(view.laneOrder.map((k) => view.lanes[k]!.agent))];
  const loadingLog = !turn.events.length && !live;

  return (
    <li className={`turn${live ? " is-live" : ""}${inGraph ? " is-in-graph" : ""}`}>
      <header className="turn-q">
        <p className="turn-question">{turn.question}</p>
        <p className="turn-meta">
          {turn.at && <span>{fmtDate(turn.at, true)}</span>}
          {agents.length > 0 && (
            <span className="turn-team" aria-label={`Worked on by ${agents.map((a) => agentDef(a)?.name).join(", ")}`}>
              {agents.map((a) => <AgentAvatar key={a} id={a} size={18} />)}
            </span>
          )}
          {view.final && <span>{agents.length} staff · {fmtMs(view.final.ms)}</span>}
          {live && <span className="turn-live"><span className="pulse" aria-hidden="true" /> {turn.replaying ? "Replaying" : "Working"}</span>}
        </p>
      </header>

      {loadingLog ? (
        <span className="skeleton" style={{ display: "block", height: 120 }} />
      ) : (
        <>
          <RunTimeline view={view} running={live} onPick={jump} />

          <div className="turn-log" ref={laneRef}>
            <button type="button" className="log-toggle" aria-expanded={lanesOpen} onClick={() => setOpen(!lanesOpen)}>
              <Icon name="chevron-right" size={14} className="log-chevron" />
              {lanesOpen ? "Hide each desk's work" : `Show each desk's work: ${Object.keys(view.findings).length} findings, ${view.laneOrder.reduce((n, k) => n + view.lanes[k]!.steps.length, 0)} tool calls`}
            </button>
            {lanesOpen && <WorkLanes view={view} nodes={view.nodes} onCite={onCite} onNodes={onNodes} activeCite={activeCite} />}
          </div>

          {(view.answerStarted || view.final) && (
            <div className={`answer${view.final ? "" : " is-streaming"}`}>
              <div className="answer-by">
                <AgentAvatar id="chief-of-staff" size={26} ring={!view.final} />
                <span><b>Meera</b> · Chief of Staff</span>
              </div>
              <Markdown text={view.answer} nodes={view.nodes} onCite={onCite} activeId={activeCite} className="answer-md" />
              {view.final && (
                <>
                  <ChecksBadges checks={view.final.checks} />
                  {view.proposals.length > 0 && (
                    <ul className="proposals">
                      {view.proposals.map((p) => (
                        <li key={p.approvalId} className="proposal">
                          <Icon name={p.kind === "github_issue" ? "github" : p.kind === "content_draft" ? "pen" : p.kind === "pause_ad" ? "pause" : "chat"} size={16} />
                          <span><b>Waiting for your approval:</b> {p.title}</span>
                          <Link to={`/approvals#${encodeURIComponent(p.approvalId)}`} className="btn btn-sm btn-ghost">Review <Icon name="chevron-right" size={14} /></Link>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="answer-actions">
                    {turn.turnId && <button type="button" className="btn btn-quiet btn-sm" onClick={onReplay}><Icon name="replay" size={14} /> Replay the work</button>}
                    {!inGraph && view.path && <button type="button" className="btn btn-quiet btn-sm" onClick={onShowGraph}><Icon name="brain" size={14} /> Show this path</button>}
                    {view.path && <span className="answer-path-note">{view.path.nodes.length} steps lit on the graph</span>}
                  </div>
                </>
              )}
            </div>
          )}
          {(turn.status === "error" || turn.status === "stopped") && (
            <div className="turn-error" role="alert">
              <Icon name="warn" size={16} />
              <span>{turn.status === "stopped" ? "Stopped before the answer was written." : turn.error ?? view.error ?? "Something went wrong."}</span>
              {latest && <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>Ask again</button>}
            </div>
          )}
        </>
      )}
    </li>
  );
}

function GraphPane({ view, turnLabel, focus, highlight, onFocus, onClear, dark, reducedMotion }: {
  view?: RunView; turnLabel?: string; focus?: string; highlight?: string[]; onFocus: (id: string) => void; onClear: () => void; dark: boolean; reducedMotion: boolean;
}) {
  const nodes = useMemo(() => (view ? view.nodeOrder.map((id) => view.nodes[id]!) : []), [view]);
  const edges = view?.edges ?? [];
  const pathIds = view?.path?.nodes.map((n) => n.id) ?? [];
  const { tenant } = useApp();
  const focusNode = useAsync(() => (focus ? api.node(tenant.id, focus).catch(() => null) : Promise.resolve(null)), [focus, tenant.id]);
  // while a run is live: the nodes each working desk read in its latest step, ringed in gold on the graph
  const reading = useMemo(() => {
    if (!view || view.final || view.path) return { ids: [] as string[], who: [] as string[] };
    const ids = new Set<string>();
    const who: string[] = [];
    for (const a of view.activeAgents) {
      const lane = laneOf(view, a);
      const step = [...(lane?.steps ?? [])].reverse().find((st) => st.done && st.nodes.length);
      if (!step) continue;
      step.nodes.forEach((n) => ids.add(n.id));
      who.push(agentDef(a)?.name ?? a);
    }
    if (!ids.size) {
      // the working desks have not read anything yet: show the last thing anyone read
      const last = Object.values(view.lanes).flatMap((l) => l.steps).filter((st) => st.done && st.nodes.length).sort((x, y) => y.at - x.at)[0];
      if (last) { last.nodes.forEach((n) => ids.add(n.id)); who.push(agentDef(last.agent)?.name ?? last.agent); }
    }
    return { ids: [...ids], who };
  }, [view]);

  return (
    <div className="graph-pane">
      <div className="graph-pane-head">
        <div>
          <h2 className="graph-pane-title">{view?.path ? "The path behind the answer" : view && nodes.length ? "What the team is reading" : "The graph"}</h2>
          <p className="graph-pane-meta">
            {view && nodes.length ? <>{nodes.length} nodes · {edges.length} links{view.path ? <> · <span className="gold-text">{view.path.nodes.length} on the path</span></> : reading.who.length ? <> · <span className="gold-text">ringed: what {reading.who.join(" and ")} read last</span></> : null}</> : "Lights up as your team works"}
            {turnLabel && <> · {turnLabel}</>}
          </p>
        </div>
        {(focus || highlight) && <button type="button" className="btn btn-quiet btn-sm" onClick={onClear}>Show all</button>}
      </div>
      <div className="graph-pane-canvas">
        {nodes.length ? (
          <Suspense fallback={<div className="skeleton" style={{ height: "100%" }} />}>
            <GraphView
              nodes={nodes}
              edges={edges}
              path={view?.path}
              focusId={focus}
              highlightIds={highlight}
              citedIds={view?.final?.citations}
              dark={dark}
              reducedMotion={reducedMotion}
              onNodeClick={onFocus}
              followGrowth={!view?.path}
              activeIds={reading.ids}
              ariaLabel={`Knowledge graph: ${nodes.length} nodes the team read.${pathIds.length ? ` The answer's path: ${view!.path!.nodes.map((n) => n.name).join(", then ")}.` : ""}`}
            />
          </Suspense>
        ) : (
          <div className="graph-idle" aria-hidden="true">
            <svg viewBox="0 0 120 80" width="160" height="107"><g fill="none" stroke="currentColor" strokeWidth="1"><path d="M20 60 L50 30 L80 45 L100 20" /><path d="M50 30 L60 65 L80 45" /></g><g fill="currentColor"><circle cx="20" cy="60" r="3.5" /><circle cx="50" cy="30" r="4.5" /><circle cx="80" cy="45" r="3.5" /><circle cx="100" cy="20" r="3" /><circle cx="60" cy="65" r="3" /></g></svg>
          </div>
        )}
      </div>
      {view?.path && !focus && (
        <ol className="path-list" aria-label="The answer's path">
          {view.path.nodes.map((n, i) => (
            <li key={n.id}>
              <button type="button" onClick={() => onFocus(n.id)} title={n.name}><span className="path-i">{i + 1}</span><span className="path-name">{n.name}</span></button>
            </li>
          ))}
        </ol>
      )}
      {focus && <NodeCard id={focus} node={view?.nodes[focus]} detail={focusNode.data ?? undefined} loading={focusNode.loading} />}
    </div>
  );
}

function NodeCard({ id, node, detail, loading }: { id: string; node?: NodeRef; detail?: { node: { summary?: string; asOf?: string; label: string; name: string }; sources: { id: string; title: string }[] }; loading: boolean }) {
  const label = detail?.node.label ?? node?.label ?? labelOfId(id);
  const name = detail?.node.name ?? node?.name ?? nameOfId(id);
  return (
    <div className="node-card" aria-live="polite">
      <p className="node-card-label">{label}{(detail?.node.asOf ?? node?.asOf) ? ` · as of ${fmtDate(detail?.node.asOf ?? node?.asOf)}` : ""}</p>
      <p className="node-card-name">{name}</p>
      {loading && !detail ? <span className="skeleton" style={{ display: "block", height: 14, width: "70%" }} /> : detail?.node.summary ? <p className="node-card-sum">{detail.node.summary}</p> : null}
      {detail?.sources.length ? <p className="node-card-src">Source: {detail.sources.map((s) => s.title).join("; ")}</p> : null}
      <Link to={`/brain?node=${encodeURIComponent(id)}`} className="node-card-link">Open in Brain <Icon name="chevron-right" size={13} /></Link>
    </div>
  );
}

function SideSheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="drawer sheet-left" aria-label={title} onClose={onClose} onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      <div className="sheet-body">
        <button type="button" className="btn btn-quiet btn-icon sheet-close" onClick={onClose} aria-label="Close threads"><Icon name="close" /></button>
        {children}
      </div>
    </dialog>
  );
}
