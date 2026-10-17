// Home: what a busy founder reads in five seconds. In order: a greeting and one status line ("3 things need you · Weekly
// signups up 18%"); the ask box; the living brain; "Needs your OK" as compact rows with OK and Look (the draft opens in a
// sheet); one row of small tiles (today's note, the goals, the credits); and a "Set up" chip row only while something is not set
// up. Everything else is one tap away: the office, the team and the tools have their own pages. The tiles are data
// (home-cards.tsx), so another area adds a tile without touching this layout. Words follow docs/owner-words.md.
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import BrainLive from "../components/BrainLive";
import { AskBox } from "../components/home/AskBox";
import { NeedsOk } from "../components/home/NeedsOk";
import { SetupChips } from "../components/home/SetupChips";
import { stakeOf } from "../components/insights-words";
import { APPROVALS_CHANGED } from "../components/TopBar";
import { usedShare } from "../lib/credits";
import { useOfficeClock } from "../lib/daylight";
import { fmtLongDate, fmtMoney, fmtNum, fmtPct } from "../lib/format";
import { homeStatus, planSummary, pulseWords, waitingList } from "../lib/home";
import { CREDITS_CHANGED } from "../lib/sse";
import { FIRST_DAY_QUESTIONS, SUGGESTIONS, TEAM_CHANGED } from "../lib/office-shared";
import { useMedia } from "../lib/useMedia";
import { useApp, useAsync } from "../state/app";
import { tilesInOrder, type HomeCtx } from "./home-cards";
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
  const wide = useMedia("(min-width: 900px)");

  // what changes under us: a decision here or on another page, a habit learned, credits spent
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const on = () => setTick((t) => t + 1);
    for (const e of [APPROVALS_CHANGED, TEAM_CHANGED, CREDITS_CHANGED]) window.addEventListener(e, on);
    return () => { for (const e of [APPROVALS_CHANGED, TEAM_CHANGED, CREDITS_CHANGED]) window.removeEventListener(e, on); };
  }, []);

  const approvals = useAsync(() => api.approvals(tenant.id), [tenant.id, tick]);
  const recs = useAsync(() => api.recommendations(tenant.id).catch(() => []), [tenant.id]);
  const standup = useAsync(() => api.standup(tenant.id).catch(() => null), [tenant.id]);
  const program = useAsync(() => api.program(tenant.id), [tenant.id, tick]);
  const goalSetup = useAsync(() => api.goalSetup(tenant.id).catch(() => []), [tenant.id, tick]);
  const connections = useAsync(() => api.connections(tenant.id).catch(() => null), [tenant.id]);
  const credits = useAsync(() => api.credits(tenant.id).catch(() => null), [tenant.id, tick]);

  const waiting = useMemo(() => waitingList(approvals.data, standup.data), [approvals.data, standup.data]);
  const stakes = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of recs.data ?? []) {
      if (!r.approvalId) continue;
      const s = stakeOf(r, fmtMoney);
      m.set(r.approvalId, s.small ? `${s.big} ${s.small}` : s.big);
    }
    return m;
  }, [recs.data]);
  const plan = program.data === undefined ? undefined : planSummary(program.data, fmtNum);
  const goalsToOk = (goalSetup.data ?? []).filter((g) => !g.confirmed).length;
  const pulse = pulseWords(program.data?.goals, (n) => fmtPct(n));

  const ctx: HomeCtx = {
    tenant,
    standup: standup.data,
    plan: { data: plan, loading: program.loading },
    goalsToOk,
    credits: { left: credits.data === undefined ? undefined : credits.data?.balance.left ?? null, used: credits.data ? usedShare(credits.data.balance) : 0 },
  };
  const suggestions = (SUGGESTIONS[tenant.id] ?? FIRST_DAY_QUESTIONS).slice(0, 2);
  const status = approvals.data === undefined && approvals.loading ? " " : homeStatus(waiting.length, pulse);

  return (
    <div className="hm">
      <header className="hm-head">
        <p className="hm-eyebrow">{tenant.name} · {fmtLongDate()}</p>
        <h1 className="hm-title">{greeting(clock.minutes)}</h1>
        <p className="hm-status" role="status">{status}</p>
      </header>

      <AskBox suggestions={suggestions} />

      <section className="hm-brain" aria-label="Your company brain">
        <BrainLive tenant={tenant.id} height={wide ? 260 : 190} />
      </section>

      <NeedsOk tenant={tenant} items={waiting} stakes={stakes} loading={approvals.loading} error={approvals.error} />

      <div className="hm-tiles">
        {tilesInOrder().map((t) => <div key={t.id} className={`hm-tile-slot${t.wide ? " is-wide" : ""}`}>{t.render(ctx)}</div>)}
      </div>

      <SetupChips tenantId={tenant.id} page={connections.data} goals={program.data?.goals ?? []} toOk={goalsToOk} />
    </div>
  );
}
