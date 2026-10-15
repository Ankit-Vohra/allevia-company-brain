// "Your growth plan": three goals in plain words, each with where you started and where we'll get you, and where the
// business is in its first three months. A short summary first; how it is measured and what the team can see sit behind
// "See the full plan". Every number is the API's (GET /api/:t/program); a starting point the graph did not have is said
// plainly ("We'll know after your first full week"), never shown as zero.
import { useState } from "react";
import { Link } from "react-router";
import type { CapabilityState, GoalState, ProgramGoal, ProgramScorecard } from "@shared/contracts";
import { fmtDate, fmtNum, fmtPct } from "../lib/format";
import { monthWeek } from "../lib/plainwords";
import { AgentAvatar } from "./bits";
import { CapabilityLadder } from "./Capabilities";
import { FirstPassCurve } from "./FirstPassCurve";
import { NumbersUpload } from "./NumbersUpload";
import { Reveal } from "./Reveal";
export { Timeline } from "./Timeline";
import "./program.css";

const STATUS: Record<GoalState, { text: string; tone: "ok" | "warn" | "bad" | "none" }> = {
  achieved: { text: "Done", tone: "ok" },
  on_track: { text: "Going well", tone: "ok" },
  at_risk: { text: "Needs a push", tone: "warn" },
  off_track: { text: "Behind", tone: "bad" },
  no_data: { text: "We'll know after your first full week", tone: "none" },
};

const per = (g: ProgramGoal) => (g.period === "week" ? "a week" : "a month");

/** The one line for Home: how a goal has moved since the business started with Allevia. */
export function weekLine(p: ProgramScorecard | null | undefined): string {
  if (!p) return "Your team is getting to know the business. Ask it anything while it does.";
  const g = p.goals.find((x) => x.current !== null && x.baseline !== null && x.baseline > 0);
  if (!g) return "We'll know how this week went after your first full week.";
  const change = (g.current! - g.baseline!) / g.baseline!;
  const word = Math.abs(change) < 0.005 ? "level with" : change > 0 ? `up ${fmtPct(Math.abs(change))} on` : `down ${fmtPct(Math.abs(change))} on`;
  return `${g.name}: ${fmtNum(g.current!)} ${per(g)}, ${word} where you started.`;
}

interface Props {
  program: ProgramScorecard | null | undefined;
  caps?: CapabilityState[];
  loading?: boolean;
  error?: string;
  /** The business's id and what to do once numbers were added (reload the plan): together they turn on "Add your numbers". */
  tenantId?: string;
  onNumbersAdded?: () => void;
}

export function ProgramCard({ program, caps, loading, error, tenantId, onNumbersAdded }: Props) {
  const [adding, setAdding] = useState(false);
  if (program === undefined) {
    return (
      <section className="plan is-loading" aria-busy={loading ? "true" : undefined} aria-label="Your growth plan">
        {error ? <p className="notice notice-bad" role="alert">Your growth plan did not load: {error}</p> : <span className="skeleton plan-skel" />}
      </section>
    );
  }
  if (program === null) {
    return (
      <section className="plan is-off" aria-labelledby="plan-title">
        <h2 id="plan-title" className="plan-title">Your growth plan</h2>
        <p className="plan-sub">Your team will propose three goals once it has read your website and the accounts you connect. You say OK or change a number, and that is the whole set-up.</p>
        {caps && caps.length > 0 && <Reveal label="What your team can see"><CapabilityLadder caps={caps} /></Reveal>}
      </section>
    );
  }

  const p = program;
  const ladder = caps?.length ? caps : p.capabilities.items;
  const next = p.checkpoints.find((c) => c.status !== "done" && c.day > 0);
  const fp = p.firstPass;
  return (
    <section className="plan" aria-labelledby="plan-title">
      <header className="plan-head">
        <h2 id="plan-title" className="plan-title">Your growth plan</h2>
        <p className="plan-when">{monthWeek(p.day)}</p>
      </header>
      <Journey day={p.day} />
      {p.goals.length ? (
        <ul className="goals">{p.goals.slice(0, 3).map((g) => <GoalRow key={g.id} g={g} />)}</ul>
      ) : (
        <p className="plan-empty">No goals yet. Your team proposes three, and you say OK.</p>
      )}
      {tenantId && p.goals.length > 0 && (adding ? (
        <NumbersUpload tenantId={tenantId} onDone={() => onNumbersAdded?.()} onClose={() => setAdding(false)} />
      ) : (
        <button type="button" className="btn btn-quiet btn-sm plan-add" onClick={() => setAdding(true)}>
          {p.goals.some((g) => g.status === "no_data") ? "Add your numbers to know today" : "Add your latest numbers"}
        </button>
      ))}
      <Reveal label="See the full plan" className="plan-more">
        <div className="plan-detail">
          <dl className="plan-facts">
            <div>
              <dt>Drafts you approved as they were</dt>
              <dd>{fp.rate === null ? "We'll know once you've decided a few" : <><b className="num">{fmtPct(fp.rate)}</b> <span className="muted">({fp.firstPass30d} of {fp.decided30d}, last month)</span></>}</dd>
            </div>
            <div>
              <dt>Things your team learned from your edits</dt>
              <dd><Link to="/team"><b className="num">{p.learnedRules.active}</b></Link></dd>
            </div>
            {next && (
              <div>
                <dt>Next monthly check-in</dt>
                <dd>{fmtDate(next.dueDate)}</dd>
              </div>
            )}
            <div>
              <dt>Posts, emails and fixes your team made</dt>
              <dd><b className="num">{p.deliverables.approvedSinceStart}</b> approved since you started{p.deliverables.pending > 0 && <> · <Link to="/approvals">{p.deliverables.pending} waiting for your OK</Link></>}</dd>
            </div>
          </dl>
          <div>
            <h3 className="plan-h">How your drafts are going</h3>
            <FirstPassCurve series={fp.series} startDate={p.startDate} day={p.day} />
          </div>
          <div>
            <h3 className="plan-h">What your team can see</h3>
            <CapabilityLadder caps={ladder} />
          </div>
        </div>
      </Reveal>
    </section>
  );
}

/** Three months as one line, with a tick for each monthly check-in and a gold dot for now. */
function Journey({ day }: { day: number }) {
  const pct = (d: number) => `${(Math.max(0, Math.min(90, d)) / 90) * 100}%`;
  return (
    <div className="journey" role="img" aria-label={`${monthWeek(day)} of your first three months. Monthly check-ins at the end of each month.`}>
      <span className="journey-track" aria-hidden="true"><span className="journey-fill" style={{ width: pct(day) }} /></span>
      {[30, 60].map((d) => <span key={d} className={`journey-tick${day >= d ? " is-past" : ""}`} style={{ left: pct(d) }} aria-hidden="true" />)}
      <span className="journey-now" style={{ left: pct(day) }} aria-hidden="true" />
    </div>
  );
}

function GoalRow({ g }: { g: ProgramGoal }) {
  const s = STATUS[g.status];
  const known = g.baseline !== null && g.target !== null;
  const progress = g.progress === null ? null : Math.max(0, Math.min(1, g.progress));
  const unit = g.unit ? ` ${g.unit}` : "";
  return (
    <li className={`goal tone-${s.tone}`}>
      <div className="goal-head">
        <span className="goal-name">{g.name}</span>
        <span className={`goal-state tone-${s.tone}`}>{s.text}</span>
      </div>
      <div className={`goal-bar${known && progress !== null ? "" : " is-unknown"}`} role="img" aria-label={known && progress !== null ? `${fmtPct(progress)} of the way to your goal.` : "We'll know after your first full week."}>
        {known && progress !== null && <span className="goal-fill" style={{ width: `${Math.max(3, progress * 100)}%` }} />}
      </div>
      <p className="goal-meta">
        {g.current !== null ? <span><b className="num">{fmtNum(g.current)}</b>{unit} {per(g)}</span> : <span>Not measured yet</span>}
        {g.target !== null && <span>Goal <b className="num">{fmtNum(g.target)}</b></span>}
        {g.owner && <span className="goal-owner"><AgentAvatar id={g.owner.id} size={16} /> {g.owner.name}</span>}
      </p>
    </li>
  );
}
