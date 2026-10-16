// Home: where a founder works from. An ask box at the top that starts a chat with the team, then a short list of cards, each
// one tap from its full page: what is waiting for your OK (with the real content and Approve, Change, No thanks right there),
// today's note, your plan, your tools, and your team. The pixel office keeps its own page (/office). Phone first: one calm
// column in that order; on a wide screen the work is on the left and the context on the right. The cards are data
// (home-cards.tsx), so another area adds a card without touching this layout. Words follow docs/owner-words.md.
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { weekLine } from "../components/ProgramCard";
import { AskBox } from "../components/home/AskBox";
import { APPROVALS_CHANGED } from "../components/TopBar";
import { useOfficeClock } from "../lib/daylight";
import { fmtLongDate } from "../lib/format";
import { waitingList, whoIsWorking } from "../lib/home";
import { FIRST_DAY_QUESTIONS, SUGGESTIONS, TEAM_CHANGED } from "../lib/office-shared";
import { useApp, useAsync } from "../state/app";
import { runStore, useRunStore } from "../state/runs";
import { cardsIn, type HomeCtx } from "./home-cards";
import "../components/home/home.css";

const greeting = (minutes: number) => (minutes < 12 * 60 ? "Good morning" : minutes < 17 * 60 ? "Good afternoon" : "Good evening");

/** Remounted per business, so one business's drafts and plan never show under another's name. */
export default function HomePage() {
  const { tenant } = useApp();
  return <HomeBody key={tenant.id} />;
}

function HomeBody() {
  const { tenant } = useApp();
  const clock = useOfficeClock(tenant.timeZone);
  const snap = useRunStore();

  // what changes under us: a decision here or on another page, a habit learned, a thread that finishes
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const on = () => setTick((t) => t + 1);
    window.addEventListener(APPROVALS_CHANGED, on);
    window.addEventListener(TEAM_CHANGED, on);
    return () => { window.removeEventListener(APPROVALS_CHANGED, on); window.removeEventListener(TEAM_CHANGED, on); };
  }, []);

  const approvals = useAsync(() => api.approvals(tenant.id), [tenant.id, tick]);
  const standup = useAsync(() => api.standup(tenant.id).catch(() => null), [tenant.id]);
  const program = useAsync(() => api.program(tenant.id), [tenant.id, tick]);
  const goalSetup = useAsync(() => api.goalSetup(tenant.id).catch(() => []), [tenant.id, tick]);
  const connections = useAsync(() => api.connections(tenant.id).catch(() => null), [tenant.id]);
  const team = useAsync(() => api.team(tenant.id).catch(() => []), [tenant.id, tick]);
  const sessions = useAsync(() => api.sessions(tenant.id).catch(() => []), [tenant.id, runStore.sessionsVersion]);

  const waiting = useMemo(() => waitingList(approvals.data, standup.data), [approvals.data, standup.data]);
  const working = useMemo(
    () => whoIsWorking(snap.order.flatMap((k) => { const r = snap.runs.get(k); return r ? [r] : []; }), sessions.data, tenant.id),
    [snap, sessions.data, tenant.id],
  );

  const ctx: HomeCtx = {
    tenant,
    waiting,
    approvals: { loading: approvals.loading, error: approvals.error },
    standup: standup.data,
    program: { data: program.data, loading: program.loading, error: program.error },
    goalsToOk: (goalSetup.data ?? []).filter((g) => !g.confirmed).length,
    connections: { data: connections.data, loading: connections.loading },
    team: { data: team.data, loading: team.loading },
    working,
    changed: () => { approvals.reload(); program.reload(); },
    learned: () => window.dispatchEvent(new Event(TEAM_CHANGED)),
  };
  const suggestions = (SUGGESTIONS[tenant.id] ?? FIRST_DAY_QUESTIONS).slice(0, 2);

  return (
    <div className="hm">
      <header className="hm-head">
        <p className="hm-eyebrow">{greeting(clock.minutes)} · {fmtLongDate()}</p>
        <h1 className="hm-title">{tenant.name}</h1>
        <p className="hm-lede">{program.data === undefined && program.loading ? " " : weekLine(program.data)}</p>
      </header>

      <AskBox suggestions={suggestions} />

      <div className="hm-grid">
        <div className="hm-col" data-column="main">
          {cardsIn("main").map((c) => <div key={c.id} className="hm-slot">{c.render(ctx)}</div>)}
        </div>
        <div className="hm-col" data-column="side">
          {cardsIn("side").map((c) => <div key={c.id} className="hm-slot">{c.render(ctx)}</div>)}
        </div>
      </div>
    </div>
  );
}
