// "Your 90 days · Day N" (product design §3.3, §8 Home): where the business is in Allevia 90, the first-pass curve, the
// rules the team has learned, each goal against its Day-0 baseline and target, and what the team can see (the
// capability ladder). Every number is the API's (GET /api/:t/program); a baseline the graph did not have is shown as
// unknown, never as zero.
import { Link } from "react-router";
import type { CapabilityState, GoalState, ProgramCheckpoint, ProgramGoal, ProgramScorecard } from "@shared/contracts";
import { fmtDate, fmtNum, fmtPct } from "../lib/format";
import { AgentAvatar } from "./bits";
import { CapabilityLadder } from "./Capabilities";
import { FirstPassCurve } from "./FirstPassCurve";
import { Icon, type IconName } from "./Icon";
import "./program.css";

const STATUS: Record<GoalState, { text: string; cls: string; icon: IconName; tone: string }> = {
  achieved: { text: "Achieved", cls: "badge-ok", icon: "check", tone: "ok" },
  on_track: { text: "On track", cls: "badge-ok", icon: "check", tone: "ok" },
  at_risk: { text: "At risk", cls: "badge-warn", icon: "warn", tone: "warn" },
  off_track: { text: "Off track", cls: "badge-bad", icon: "warn", tone: "bad" },
  no_data: { text: "No reading yet", cls: "badge-ink", icon: "clock", tone: "none" },
};

const CHECKPOINT_NAME: Record<ProgramCheckpoint["day"], string> = { 0: "Set-up", 30: "Review", 60: "Tune", 90: "Graduation" };

type CapLike = Pick<CapabilityState, "key" | "name" | "accessMode" | "status"> & Partial<CapabilityState>;

interface Props {
  program: ProgramScorecard | null | undefined;
  caps?: CapabilityState[];
  loading?: boolean;
  error?: string;
}

export function ProgramCard({ program, caps, loading, error }: Props) {
  if (program === undefined) {
    return (
      <section className="p90 is-loading" aria-busy={loading ? "true" : undefined} aria-label="Your 90 days">
        {error ? <p className="notice notice-bad" role="alert">The 90-day scorecard did not load: {error}</p> : <span className="skeleton p90-skel" />}
      </section>
    );
  }
  if (program === null) return <NotEnrolled caps={caps} />;

  const p = program;
  // the ladder with its upgrade hints when /capabilities answered, else the scorecard's own copy without them
  const ladder: CapLike[] = caps?.length ? caps : p.capabilities.items;
  const next = p.checkpoints.find((c) => c.status !== "done");
  const fp = p.firstPass;
  return (
    <section className="p90" aria-labelledby="p90-title">
      <header className="p90-head">
        <div className="p90-head-row">
          <p className="p90-eyebrow">Allevia 90</p>
          <span className={`badge ${p.status === "graduated" ? "badge-ok" : "badge-gold"}`}>{p.status === "graduated" ? "Graduated" : "In progress"}</span>
        </div>
        <h2 id="p90-title" className="p90-title">Your 90 days <span className="p90-day">· Day <span className="num">{p.day}</span></span></h2>
        <p className="p90-sub">
          {p.daysLeft > 0 ? <><span className="num">{p.daysLeft}</span> days left</> : "Program complete"} · {fmtDate(p.startDate)} to {fmtDate(p.endDate)}
        </p>
        <Timeline day={p.day} checkpoints={p.checkpoints} />
      </header>

      <div className="p90-stats">
        <div className="p90-stat">
          <p className="p90-stat-label">First-pass approvals</p>
          <p className="p90-stat-value num">{fp.rate === null ? "–" : fmtPct(fp.rate)}</p>
          <p className="p90-stat-note">{fp.decided30d ? <><span className="num">{fp.firstPass30d}</span> of <span className="num">{fp.decided30d}</span> drafts approved without an edit, last 30 days</> : "Approved without an edit, once you decide a draft"}</p>
        </div>
        <Link to="/team" className="p90-stat p90-stat-link">
          <p className="p90-stat-label">Rules learned</p>
          <p className="p90-stat-value num">{p.learnedRules.active}</p>
          <p className="p90-stat-note">
            {p.learnedRules.learnedSinceStart ? <>from your edits{p.learnedRules.retired ? <>, <span className="num">{p.learnedRules.retired}</span> retired</> : null}</> : "Your edits teach the team"}
            <Icon name="chevron-right" size={13} />
          </p>
        </Link>
      </div>

      <div className="p90-section">
        <h3 className="p90-h">First-pass curve <span className="p90-h-note">target: 30% by day 30, 60% by day 90</span></h3>
        <FirstPassCurve series={fp.series} startDate={p.startDate} day={p.day} />
      </div>

      <div className="p90-section">
        <h3 className="p90-h">Goals against day 0</h3>
        {p.goals.length ? (
          <ul className="goals">{p.goals.map((g) => <GoalRow key={g.id} g={g} day={p.day} />)}</ul>
        ) : (
          <p className="p90-empty">No goals set yet. The team proposes two or three at set-up, measured from day 0.</p>
        )}
      </div>

      <div className="p90-section">
        <h3 className="p90-h">What your team can see <span className="p90-h-note">hover or tap a source to see how to improve it</span></h3>
        <CapabilityLadder caps={ladder} />
      </div>

      <footer className="p90-foot">
        {next && <p><Icon name="clock" size={14} /> Next: day {next.day} {CHECKPOINT_NAME[next.day].toLowerCase()}, {fmtDate(next.dueDate)}</p>}
        <p>
          <span className="num">{p.deliverables.approvedSinceStart}</span> approved since day 0
          {p.deliverables.pending > 0 && <> · <Link to="/approvals"><span className="num">{p.deliverables.pending}</span> waiting on you</Link></>}
        </p>
      </footer>
    </section>
  );
}

function NotEnrolled({ caps }: { caps?: CapabilityState[] }) {
  return (
    <section className="p90 is-off" aria-labelledby="p90-title">
      <header className="p90-head">
        <p className="p90-eyebrow">Allevia 90</p>
        <h2 id="p90-title" className="p90-title">Not in the 90-day program yet</h2>
        <p className="p90-sub">Allevia 90 locks a day-0 baseline for two or three goals, then tracks them, the first-pass rate and the rules your team learns, with reviews at day 30 and day 90.</p>
      </header>
      {caps && caps.length > 0 && (
        <div className="p90-section">
          <h3 className="p90-h">What your team can see <span className="p90-h-note">hover or tap a source to see how to improve it</span></h3>
          <CapabilityLadder caps={caps} />
        </div>
      )}
      <footer className="p90-foot"><p><Link to="/program">What the 90 days include</Link></p></footer>
    </section>
  );
}

function Timeline({ day, checkpoints }: { day: number; checkpoints: ProgramCheckpoint[] }) {
  const pct = (d: number) => `${(Math.max(0, Math.min(90, d)) / 90) * 100}%`;
  return (
    <div className="p90-line" role="img" aria-label={`Day ${day} of 90. Checkpoints: ${checkpoints.map((c) => `day ${c.day} ${c.status}`).join(", ")}.`}>
      <span className="p90-track" aria-hidden="true"><span className="p90-fill" style={{ width: pct(day) }} /></span>
      <span className="p90-today" style={{ left: pct(day) }} aria-hidden="true" />
      {checkpoints.map((c) => (
        <span key={c.day} className={`p90-cp is-${c.status}${c.day === 0 ? " is-start" : c.day === 90 ? " is-end" : ""}`} style={{ left: pct(c.day) }} aria-hidden="true">
          <span className="p90-cp-dot" />
          <span className="p90-cp-label">{c.day === 0 ? "Day 0" : c.day}<span> {CHECKPOINT_NAME[c.day]}</span></span>
        </span>
      ))}
    </div>
  );
}

function per(g: ProgramGoal) {
  return g.period === "week" ? "a week" : "in 28 days";
}

function GoalRow({ g, day }: { g: ProgramGoal; day: number }) {
  const s = STATUS[g.status];
  const known = g.baseline !== null && g.target !== null;
  const progress = g.progress === null ? null : Math.max(0, Math.min(1, g.progress));
  const unit = g.unit ? ` ${g.unit}` : "";
  return (
    <li className={`goal tone-${s.tone}`}>
      <div className="goal-head">
        <span className="goal-name">{g.name}</span>
        <span className={`badge ${s.cls}`}><Icon name={s.icon} size={12} /> {s.text}</span>
      </div>
      <p className="goal-now">
        {g.current !== null ? <><b className="num">{fmtNum(g.current)}</b>{unit} {per(g)}</> : <span className="muted">No reading since day 0</span>}
        {g.owner && <span className="goal-owner"><AgentAvatar id={g.owner.id} size={18} /> {g.owner.name}</span>}
      </p>
      <div
        className={`goal-bar${known ? "" : " is-unknown"}`}
        role="img"
        aria-label={known && progress !== null ? `${fmtPct(progress)} of the way from the day-0 baseline to the target.` : "Progress unknown: no day-0 baseline."}
      >
        {known && progress !== null && <span className="goal-fill" style={{ width: `${progress * 100}%` }} />}
        {known && <span className="goal-expected" style={{ left: `${(Math.min(90, day) / 90) * 100}%` }} title="Where it would be on a straight line to the target" />}
      </div>
      <p className="goal-meta">
        {g.baseline !== null ? (
          <span>Day 0 <b className="num">{fmtNum(g.baseline)}</b>{g.baselineConf === "reported" ? " (reported)" : ""}</span>
        ) : (
          <span className="goal-unknown" title="There was no data for this on day 0. The target is the industry starting point until the first reading.">Baseline unknown</span>
        )}
        <span aria-hidden="true">→</span>
        <span>Target <b className="num">{g.target === null ? "–" : fmtNum(g.target)}</b>{g.targetBasis === "template" ? " (starting point)" : ""}</span>
        {g.dueAt && <span className="goal-due">by {fmtDate(g.dueAt)}</span>}
      </p>
    </li>
  );
}
