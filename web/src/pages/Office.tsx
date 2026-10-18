// Home: the office. Three things for the owner (how the week is going, what waits for their OK, one next step), and the
// pixel office as the hero: the team at its desks, or at coffee, the game room and the cafeteria, with the dogs carrying
// documents between desks while a request runs. The work log is out of sight: a quiet line at the bottom says who is
// doing what, and opens to the whole story. The business's own clock lights the office, from morning sun to evening lamps.
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import type { AgentId, LearnedRuleDto } from "@shared/contracts";
import { AGENTS } from "@shared/roster";
import { api } from "../api";
import { AgentDrawer } from "../components/AgentDrawer";
import { DiscordHomeCard } from "../components/DiscordCard";
import { AgentAvatar, agentDef, deptOf, fmtMs } from "../components/bits";
import { ClockChip } from "../components/ClockChip";
import { Icon } from "../components/Icon";
import { LearnedPathDialog } from "../components/Learning";
import { weekLine } from "../components/ProgramCard";
import { withoutSim } from "../components/insights-words";
import { chatPath } from "../lib/chat";
import { APPROVALS_CHANGED } from "../components/TopBar";
import { plainTitle, waitingGroups } from "../lib/home";
import { WorkFeed } from "../components/WorkFeed";
import { usePreviewFromUrl, useOfficeClock } from "../lib/daylight";
import { OfficeCanvas, type OfficeStandup, type ShelfBook } from "../office/OfficeCanvas";
import type { Standup } from "../types-ext";
import { fmtLongDate } from "../lib/format";
import { useMedia } from "../lib/useMedia";
import { plain } from "../lib/words";
import { useApp, useAsync } from "../state/app";
import { laneOf } from "../state/derive";
import { runStore, useRun, useRunStore, useRunView } from "../state/runs";
import "./office-page.css";

// (the suggestions and the team-changed event moved to lib/office-shared.ts so Home does not load this page's canvas)
import { FIRST_DAY_QUESTIONS, SUGGESTIONS, TEAM_CHANGED } from "../lib/office-shared";
export { FIRST_DAY_QUESTIONS, SUGGESTIONS, TEAM_CHANGED };

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

const NUMBER_WORDS = ["Nothing", "One thing", "Two things", "Three things"];

/** The stand-up as the office acts it out: who walks to the table, what each says, who gets a brief from The Chief. */
export function officeStandup(s: Standup): OfficeStandup {
  // a showcase business's stand-up comes back masked, without its attendees (18 Oct: the office was blank for Aamdani and AVS)
  const drafted = (s.items ?? []).filter((i) => i.status === "drafted" && i.approvalId);
  const n = drafted.length;
  return {
    id: s.id,
    attendees: s.attendees?.length ? s.attendees : ["chief-of-staff"],
    lines: [
      { agent: "chief-of-staff", text: n ? `Morning, team. ${NUMBER_WORDS[n] ?? `${n} things`} worth doing today.` : "Morning, team. Nothing worth the owner's time today." },
      ...drafted.map((i) => ({ agent: i.agent, text: `I'll draft ${lowerFirst(i.title)}.` })),
      ...(n ? [{ agent: "chief-of-staff" as AgentId, text: "Thanks. Drafts go to the owner for an OK." }] : []),
    ],
    handoffs: drafted.map((i) => i.agent).filter((a) => a !== "chief-of-staff"),
  };
}

const SEEN_KEY = "allevia:standup-seen";
function seenStandup(id: string): boolean {
  try { return localStorage.getItem(SEEN_KEY) === id; } catch { return false; }
}
function markStandupSeen(id: string): void {
  try { localStorage.setItem(SEEN_KEY, id); } catch { /* private mode: it plays again next time */ }
}

export function OfficePage() {
  const { tenant, mode, effectiveTheme, reducedMotion, speed, setSpeed } = useApp();
  const snap = useRunStore();
  const [runKey, setRunKey] = useState<string | undefined>(() => runStore.latest(tenant.id)?.key);
  const record = useRun(runKey);
  const view = useRunView(record);
  const [question, setQuestion] = useState("");
  // clicking someone in the office opens their chat; their profile is one tap away from there (?profile=<id> opens it here)
  const [selected, setSelected] = useState<AgentId | null>(() => (AGENTS.find((a) => a.id === new URLSearchParams(location.search).get("profile"))?.id ?? null));
  const [elapsed, setElapsed] = useState(0);
  const [askFocus, setAskFocus] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [openRule, setOpenRule] = useState<LearnedRuleDto | null>(null);
  const [petNote, setPetNote] = useState("");
  const compact = useMedia("(max-width: 760px)");
  const narrow = useMedia("(max-width: 900px)");
  const nav = useNavigate();
  const autoStarted = useRef(false);
  const clock = useOfficeClock(tenant.timeZone);
  usePreviewFromUrl();
  const [vh, setVh] = useState(() => (typeof window === "undefined" ? 900 : window.innerHeight));
  useEffect(() => {
    const on = () => setVh(window.innerHeight);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);

  // the plan, the ladder, the team's desks and what it learned; refreshed when another screen changes them
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const on = () => setTick((t) => t + 1);
    window.addEventListener(TEAM_CHANGED, on);
    return () => window.removeEventListener(TEAM_CHANGED, on);
  }, []);
  const [pendingTick, setPendingTick] = useState(0);
  useEffect(() => {
    const on = () => setPendingTick((t) => t + 1);
    window.addEventListener(APPROVALS_CHANGED, on);
    return () => window.removeEventListener(APPROVALS_CHANGED, on);
  }, []);
  const program = useAsync(() => api.program(tenant.id), [tenant.id, tick]);
  const team = useAsync(() => api.team(tenant.id).catch(() => []), [tenant.id, tick]);
  const learning = useAsync(() => api.learning(tenant.id).catch(() => null), [tenant.id, tick]);
  const recs = useAsync(() => api.recommendations(tenant.id).catch(() => []), [tenant.id]);
  const standup = useAsync(() => api.standup(tenant.id).catch(() => null), [tenant.id]);
  const stage = useMemo(() => (standup.data ? officeStandup(standup.data) : null), [standup.data]);
  // the stand-up plays by itself the first time this browser sees it; "Watch the stand-up" plays it again
  const [standupPlay, setStandupPlay] = useState(0);
  useEffect(() => {
    if (!stage || seenStandup(stage.id)) return;
    markStandupSeen(stage.id);
    setStandupPlay((n) => n + 1);
  }, [stage]);
  // the drafts waiting, repeats folded (the same count as the top bar)
  const waiting = useAsync(() => api.approvals(tenant.id).catch(() => null), [tenant.id, pendingTick]);
  const waitingRows = useMemo(() => waitingGroups(waiting.data ?? undefined, standup.data), [waiting.data, standup.data]);
  const firstTwo = waitingRows.slice(0, 2);

  const off = useMemo(() => new Set((team.data ?? []).filter((a) => !a.enabled).map((a) => a.id)), [team.data]);
  const books = useMemo<ShelfBook[]>(() => {
    const active = (learning.data?.rules ?? []).filter((r) => r.status === "active");
    return [...active].reverse().map((r) => ({ id: r.id, text: r.text, confidence: r.confidence, hue: (r.agents[0] && deptOf(r.agents[0])?.hue) || 60 }));
  }, [learning.data]);

  // follow the tenant: show its latest run, if any
  useEffect(() => {
    const latest = runStore.latest(tenant.id);
    setRunKey(latest?.key);
    setLogOpen(false);
    if (latest?.status === "running" || mode !== "live") return;
    let live = true;
    api.liveTurns(tenant.id).then((list) => {
      const t = list[0];
      if (!live || !t || runStore.latest(tenant.id, (r) => r.status === "running")) return;
      setRunKey(runStore.attach(tenant.id, t));
    }, () => {});
    return () => { live = false; };
  }, [tenant.id, mode]);

  // ?ask=…&seek=ms starts a run straight away (used for demos and screenshots)
  useEffect(() => {
    if (autoStarted.current) return;
    const q = new URLSearchParams(location.search).get("ask");
    if (!q) return;
    autoStarted.current = true;
    setQuestion("");
    setRunKey(runStore.start(tenant.id, q, { seekMs: Number(new URLSearchParams(location.search).get("seek") ?? 0) || undefined }));
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
    setAskFocus(false);
    setLogOpen(false);
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
  const askHref = view?.sessionId ? `/ask/${view.sessionId}` : "/ask";

  // the quiet line at the bottom while a request runs: "Miss Influencer is drafting ideas…"
  const tickerLine = useMemo(() => {
    if (!view || !record) return null;
    if (view.final) return { agent: "chief-of-staff" as AgentId, text: `The Chief has your answer · ${fmtMs(view.final.ms)}`, done: true };
    const a = working[working.length - 1];
    if (!a) return { agent: "chief-of-staff" as AgentId, text: "The Chief is reading your question…", done: false };
    const lane = laneOf(view, a);
    const status = plain(lane?.status ?? lane?.task ?? "").replace(/[.…]+$/, "").trim();
    const nm = agentDef(a)?.name ?? "";
    // "Miss Influencer is using: Instagram post craft" already starts with the name
    const text = !status ? `${nm} is on it…` : nm && status.startsWith(`${nm} is `) ? `${status}…` : /^\w+ing\b/i.test(status) ? `${nm} is ${lowerFirst(status)}…` : `${nm}: ${lowerFirst(status)}…`;
    return { agent: a, text, done: false };
  }, [view, record, working]);

  const suggestions = (SUGGESTIONS[tenant.id] ?? FIRST_DAY_QUESTIONS).slice(0, 2);
  // the next step: the best idea that has no draft waiting yet (the drafts are listed just above it)
  const nextIdea = useMemo(() => {
    const waitingIds = new Set(waitingRows.flatMap((g) => g.items.map((w) => w.approval.id)));
    return [...(recs.data ?? [])].filter((r) => r.status !== "dismissed" && !(r.approvalId && waitingIds.has(r.approvalId))).sort((a, b) => b.score - a.score)[0];
  }, [recs.data, waitingRows]);
  const showSuggest = askFocus && !question.trim() && !running && !narrow;
  const week = weekLine(program.data);

  const tickerEl = tickerLine && record ? (
    <div className={`run-ticker${logOpen ? " is-open" : ""}${tickerLine.done ? " is-done" : ""}`}>
      {logOpen && (
        <div className="run-log">
          <p className="run-log-q">{record.question}</p>
          <WorkFeed events={record.events} view={view} status={record.status} askHref={askHref} nodes={view?.nodes} limit={compact ? 6 : undefined} />
          {!running && (
            <div className="log-foot">
              <button type="button" className="btn btn-quiet btn-sm" onClick={() => { setRunKey(undefined); setLogOpen(false); }}>Clear</button>
              {view?.sessionId && <button type="button" className="btn btn-ghost btn-sm" onClick={() => nav(askHref)}>Read the full answer</button>}
            </div>
          )}
        </div>
      )}
      <div className="run-bar">
        <button type="button" className="run-line" aria-expanded={logOpen} onClick={() => setLogOpen((o) => !o)}>
          <AgentAvatar id={tickerLine.agent} size={22} ring={!tickerLine.done} />
          <span className="run-text" aria-live="polite">{tickerLine.text}</span>
          {running && <span className="run-time">{fmtMs(Math.max(0, elapsed))}</span>}
          <span className="run-open">{logOpen ? "Hide" : tickerLine.done ? "How it went" : "Show"}<Icon name="chevron" size={14} className="run-chev" /></span>
        </button>
        {running && (
          <button type="button" className="run-stop btn btn-quiet btn-sm" onClick={() => runKey && runStore.stop(runKey)} disabled={record?.stopping}>
            <Icon name="stop" size={13} /> {record?.stopping ? "Stopping…" : "Stop"}
          </button>
        )}
      </div>
      {tickerLine.done && !logOpen && view?.sessionId && (
        <Link className="run-read btn btn-gold btn-sm" to={askHref}>Read the answer</Link>
      )}
    </div>
  ) : null;

  return (
    <div className="office-page">
      <header className="office-head">
        <div className="office-titles">
          <h1 id="office-title" className="office-title">{tenant.name}<span className="office-title-sub">{/s$/i.test(tenant.name) ? "’" : "’s"} office</span></h1>
          <p className="office-meta">{fmtLongDate()}{off.size > 0 && <> · <Link to="/team" className="office-off-link">{off.size} {off.size === 1 ? "person is" : "people are"} switched off</Link></>}</p>
        </div>
        <div className="office-tools">
          {(mode === "mock" || record?.kind === "replay") && (
            <div className="seg" role="group" aria-label="Playback speed">
              {[1, 4].map((s) => (
                <button key={s} type="button" className={`seg-btn${speed === s ? " is-on" : ""}`} aria-pressed={speed === s} onClick={() => setSpeed(s)}>{s}×</button>
              ))}
            </div>
          )}
          <ClockChip />
        </div>
      </header>

      <div className="ask-wrap">
        <form className="ask-bar" onSubmit={onSubmit} role="search" aria-label="Ask your team">
          <label htmlFor="office-q" className="visually-hidden">Ask your team</label>
          <span className="ask-bar-icon" aria-hidden="true"><Icon name="ask" size={18} /></span>
          <input
            id="office-q"
            className="ask-input"
            placeholder="Ask your team anything…"
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
          {suggestions.map((s) => <button key={s} type="button" className="suggest-chip" onClick={() => ask(s)}>{s}</button>)}
        </div>
      )}

      <section className="office-stage" aria-label="The office">
        <OfficeCanvas
          view={view}
          events={record?.events}
          runKey={runKey}
          dark={effectiveTheme === "dark"}
          reducedMotion={reducedMotion}
          speed={speed}
          minutes={clock.minutes}
          compact={compact}
          maxHeight={narrow ? 100000 : Math.max(300, vh - 56 - 250)}
          selected={selected}
          onSelect={(id) => (id ? nav(chatPath(id)) : setSelected(null))}
          off={off}
          books={learning.data ? books : undefined}
          onBook={(id) => setOpenRule(learning.data?.rules.find((r) => r.id === id) ?? null)}
          onStatus={setPetNote}
          standup={stage}
          standupPlay={standupPlay}
        />
        <p className="visually-hidden" role="status" aria-live="polite">{petNote}</p>
        <div className="run-slot">{tickerEl}</div>

      </section>

      <div className="office-right">
        {/* one card: how the week is going, the two drafts to look at first, and one next step */}
        <section className="home office-card" aria-label="Today at a glance">
          {week && <p className="home-week">{week}</p>}
          <div className="home-row">
            {firstTwo.length > 0 ? (
              <ul className="home-standup-list" aria-label="Needs your OK">
                {firstTwo.map(({ lead: w, items }) => (
                  <li key={w.approval.id}>
                    <Link to={`/approvals#${encodeURIComponent(w.approval.id)}`} className="home-standup-item">
                      <AgentAvatar id={w.approval.by} size={22} />
                      <span className="home-standup-text">
                        <span className="home-standup-title">{plainTitle(w.approval.title)}{items.length > 1 && <span className="ap-repeat"> ×{items.length}</span>}</span>
                      </span>
                      <Icon name="chevron-right" size={14} />
                    </Link>
                  </li>
                ))}
              </ul>
            ) : waiting.data && !waiting.loading ? (
              <p className="home-calm">Nothing needs you right now.</p>
            ) : null}
            {waitingRows.length > firstTwo.length && <Link to="/approvals" className="home-ok office-all">See all<Icon name="chevron-right" size={15} /></Link>}
          </div>
          <div className="home-row">
            <p className="home-label">Next step</p>
            {nextIdea ? (
              <Link to="/insights" className="home-next">{withoutSim(nextIdea.title)}<Icon name="chevron-right" size={15} /></Link>
            ) : (
              <p className="home-calm">Ask your team below.</p>
            )}
          </div>
          <div className="office-card-foot">
            {standup.data && (
              <button type="button" className="btn btn-quiet btn-sm" onClick={() => setStandupPlay((n) => n + 1)} disabled={running}>Watch the stand-up</button>
            )}
            {!running && sessions.data?.length ? (
              <button type="button" className="btn btn-quiet btn-sm" onClick={replayLatest}><Icon name="replay" size={14} /> Replay the last request</button>
            ) : null}
          </div>
        </section>
        <DiscordHomeCard />
      </div>

      <AgentDrawer agentId={selected} onClose={() => setSelected(null)} view={view} />
      <LearnedPathDialog rule={openRule} onClose={() => setOpenRule(null)} onRetired={() => setTick((t) => t + 1)} />
    </div>
  );
}
