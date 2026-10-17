// Your growth plan (docs/owner-words.md): for a founder who is not a marketer. The top says where you are ("Month 1 ·
// week 2"), then your three goals, each a plain sentence with where you started, where you are now and a simple bar, then two
// figures: what your team has learned from your edits and when the next monthly check-in is. When the team has only just suggested
// the goals, each has an OK button and a way to change the number: one tap, nothing to configure. Everything technical
// (the check-in notes, the drafts-approved curve, the numbers behind each goal, what the team can see, how it is
// measured) is behind one "Show how". Every number is GET /api/:t/program's; the words are the web app's own.
import { Link } from "react-router";
import type { AgentId, CapabilityState, ProgramScorecard } from "@shared/contracts";
import { api } from "../api";
import { AgentAvatar } from "../components/bits";
import { CapabilityLadder } from "../components/Capabilities";
import { CheckWebsite } from "../components/CheckWebsite";
import { FirstPassCurve } from "../components/FirstPassCurve";
import { Reveal } from "../components/Reveal";
import { SuggestedRow } from "../components/SuggestedGoal";
import { Timeline } from "../components/ProgramCard";
import { ShowDetails } from "../components/ShowDetails";
import { fmtDate, fmtNum, fmtPct } from "../lib/format";
import { checkInNote, goalView, monthWeek, nextCheckIn, type GoalView } from "../lib/plainwords";
import { useApp, useAsync } from "../state/app";
import type { GoalSetup } from "../types-ext";
import "./owner-page.css";

export default function ProgramPage() {
  const { tenant } = useApp();
  const program = useAsync(() => api.program(tenant.id), [tenant.id]);
  const caps = useAsync(() => api.capabilities(tenant.id).catch(() => [] as CapabilityState[]), [tenant.id]);
  const setup = useAsync(() => api.goalSetup(tenant.id).catch(() => [] as GoalSetup[]), [tenant.id]);

  return (
    <div className="owner-page">
      {program.data === undefined ? (
        program.error ? (
          <p className="notice notice-bad" role="alert">Your growth plan did not load: {program.error}</p>
        ) : (
          <div className="owner-skel" aria-busy="true"><span className="skeleton" /><span className="skeleton" /><span className="skeleton" /></div>
        )
      ) : program.data === null ? (
        <NotStarted name={tenant.name} />
      ) : (
        <Started
          p={program.data}
          caps={caps.data}
          suggested={(setup.data ?? []).filter((s) => !s.confirmed).slice(0, 3)}
          onSet={() => { setup.reload(); program.reload(); }}
        />
      )}
    </div>
  );
}

function Started({ p, caps, suggested, onSet }: { p: ProgramScorecard; caps?: CapabilityState[]; suggested: GoalSetup[]; onSet: () => void }) {
  const { tenant } = useApp();
  const done = p.status === "graduated" || p.day >= 90;
  const next = nextCheckIn(p.checkpoints);
  const lastRule = p.learnedRules.recent[0];
  // a goal still waiting for the owner's OK is shown once, in the suggestion card, not twice
  const waiting = new Set(suggested.map((s) => s.id));
  const top = p.goals.slice(0, 3).filter((g) => !waiting.has(g.id)).map((g) => ({ g, v: goalView(g, p.day, (n) => fmtNum(n)) }));
  return (
    <>
      <header className="owner-head">
        <p className="owner-eyebrow">Your growth plan</p>
        <h1 className="owner-title">{monthWeek(p.day)}</h1>
        <p className="owner-quiet">{done ? "Done" : "3 months"} · {fmtDate(p.startDate)} to {fmtDate(p.endDate)}</p>
        <span className="owner-track" aria-hidden="true"><span style={{ width: `${(Math.min(90, Math.max(0, p.day)) / 90) * 100}%` }} /></span>
      </header>

      {suggested.length > 0 && <Suggested items={suggested} onSet={onSet} />}

      {(top.length > 0 || suggested.length === 0) && (
        <section className="owner-block" aria-labelledby="goals-h">
          <h2 id="goals-h" className="owner-h">Your goals</h2>
          {top.length ? (
            <ul className="owner-cards">{top.map(({ g, v }) => <GoalCard key={g.id} v={v} aimed={g.aimed?.sentence ?? null} ownerId={g.owner?.id} />)}</ul>
          ) : (
            <p className="owner-quiet">Your team suggests 3 goals after a first look.</p>
          )}
        </section>
      )}

      {/* "Check my website" up where it can be found, not at the bottom of a folded section (audit #39); on Discord it is /checkup */}
      <section className="owner-block" aria-label="Your website">
        <CheckWebsite tenantId={tenant.id} />
      </section>

      <section className="owner-facts" aria-label="What your team learned, and what comes next">
        {/* an empty "0" tile says nothing: it shows once the team has learned something */}
        {p.learnedRules.active > 0 && (
          <Link to="/team" className="owner-fact" title={lastRule ? `Latest: “${lastRule.text}”` : undefined}>
            <span className="owner-fact-label">Learned from your edits</span>
            <span className="owner-fact-value num">{p.learnedRules.active}</span>
          </Link>
        )}
        <div className="owner-fact">
          <span className="owner-fact-label">Next check-in</span>
          <span className="owner-fact-value is-text">{next ? fmtDate(next.dueDate) : "All done"}</span>
        </div>
      </section>

      <ShowDetails label="Show how" openLabel="Hide how">
        <HowDetails p={p} caps={caps} />
      </ShowDetails>
    </>
  );
}

// `aimed`: what the team has pointed at this goal, in one plain line ("2 approved drafts and 1 fix are aimed at ..."); null when
// nothing is. A goal that needs a push says why on the card; one going well keeps its why behind "More".
function GoalCard({ v, aimed, ownerId }: { v: GoalView; aimed: string | null; ownerId?: AgentId }) {
  const whyOnCard = !v.known || (!!v.status && v.status.tone !== "ok");
  return (
    <li className={`owner-card${v.status ? ` tone-${v.status.tone}` : ""}`}>
      <div className="owner-card-top">
        <h3 className="owner-card-title">{v.title}</h3>
        {v.status && <span className="owner-state"><span className="owner-dot" aria-hidden="true" />{v.status.word}</span>}
      </div>
      {v.known && (
        <dl className="owner-pair">
          <div><dt>Started</dt><dd className="num">{v.start ?? "–"}</dd></div>
          <div><dt>Now</dt><dd className="num">{v.now}</dd></div>
          {v.owner && <div className="owner-pair-who">{ownerId && <AgentAvatar id={ownerId} size={18} />}<span>{v.owner}</span></div>}
        </dl>
      )}
      {whyOnCard && v.why && <p className="owner-card-why">{v.why}</p>}
      <span
        className={`owner-bar${v.progress === null ? " is-empty" : ""}`}
        role="img"
        aria-label={v.progress === null ? "No progress to show yet." : `${fmtPct(v.progress)} of the way to the goal.`}
      >
        {v.progress !== null && <span style={{ width: `${Math.max(2, v.progress * 100)}%` }} />}
      </span>
      {((!whyOnCard && v.why) || aimed) && (
        <Reveal label="More">
          {!whyOnCard && <p className="owner-card-why">{v.why}</p>}
          {aimed && <p className="owner-card-owner">{aimed}</p>}
        </Reveal>
      )}
    </li>
  );
}

// "Your team suggests these goals": OK, or change the number. One tap per goal.
function Suggested({ items, onSet }: { items: GoalSetup[]; onSet: () => void }) {
  const { tenant } = useApp();
  return (
    <section className="owner-block owner-suggest" aria-labelledby="suggest-h">
      <h2 id="suggest-h" className="owner-h">Say OK to your goals</h2>
      <ul className="owner-suggest-list">
        {items.map((s) => <SuggestedRow key={s.id} s={s} tenantId={tenant.id} onSet={onSet} />)}
      </ul>
    </section>
  );
}

const CHECK_IN_NAME: Record<number, string> = { 0: "Plan set up", 30: "Monthly check-in 1", 60: "Monthly check-in 2", 90: "Final check-in" };

function HowDetails({ p, caps }: { p: ProgramScorecard; caps?: CapabilityState[] }) {
  const fp = p.firstPass;
  const d = p.deliverables;
  const ladder = caps?.length ? caps : p.capabilities.items;
  const fmt = (n: number) => fmtNum(n);
  return (
    <>
      <section className="detail-block" aria-labelledby="d-checkins">
        <h3 id="d-checkins" className="detail-h">Monthly check-ins</h3>
        <Timeline day={p.day} checkpoints={p.checkpoints} />
        <ol className="detail-notes">
          {p.checkpoints.map((c) => (
            <li key={c.day}>
              <p className="detail-note-head"><b>{CHECK_IN_NAME[c.day]}</b><span>{c.status === "done" ? (c.at ? fmtDate(c.at) : "Done") : fmtDate(c.dueDate)}</span></p>
              <p>{checkInNote(c, p, fmt)}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="detail-block" aria-labelledby="d-drafts">
        <h3 id="d-drafts" className="detail-h">Drafts you approved as they were</h3>
        <p className="detail-note">
          {fp.decided30d
            ? `${fmtNum(fp.firstPass30d)} of ${fmtNum(fp.decided30d)} drafts in the last 30 days needed no changes from you. As your team learns, we aim for about 3 in 10 by the end of month 1, and 6 in 10 by the end of month 3.`
            : "Once you approve or change a draft, this line starts. As your team learns, we aim for about 3 in 10 approved as they were by the end of month 1, and 6 in 10 by the end of month 3."}
        </p>
        <FirstPassCurve series={fp.series} startDate={p.startDate} day={p.day} />
      </section>

      <section className="detail-block" aria-labelledby="d-goals">
        <h3 id="d-goals" className="detail-h">Each goal in numbers</h3>
        <div className="detail-table-wrap">
          <table className="detail-table">
            <thead><tr><th scope="col">Goal</th><th scope="col">Started</th><th scope="col">Now</th><th scope="col">Goal</th><th scope="col">Looked after by</th></tr></thead>
            <tbody>
              {p.goals.map((g) => (
                <tr key={g.id}>
                  <th scope="row">{g.name}<span className="detail-sub">{g.period === "week" ? "per week" : "per month"}{g.unit ? `, ${g.unit}` : ""}</span></th>
                  <td className="num">{g.baseline === null ? "Not measured" : fmtNum(g.baseline)}</td>
                  <td className="num">{g.current === null ? "No reading yet" : fmtNum(g.current)}</td>
                  <td className="num">{g.target === null ? "–" : fmtNum(g.target)}{g.targetBasis === "template" ? <span className="detail-sub">typical for businesses like yours</span> : null}</td>
                  <td>{g.owner ? <span className="detail-owner"><AgentAvatar id={g.owner.id} size={18} /> {g.owner.name}</span> : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {p.learnedRules.recent.length > 0 && (
        <section className="detail-block" aria-labelledby="d-rules">
          <h3 id="d-rules" className="detail-h">Things your team learned from your edits</h3>
          <ul className="detail-list">
            {p.learnedRules.recent.map((r) => (
              <li key={r.id}><span className="detail-key">{r.learnedAt ? fmtDate(r.learnedAt) : ""}</span><span>{r.text}</span></li>
            ))}
          </ul>
          <p className="detail-note">{p.learnedRules.learnedSinceStart} so far{p.learnedRules.retired ? `, ${p.learnedRules.retired} switched off` : ""}. <Link to="/team">See them all in Your team</Link>.</p>
        </section>
      )}

      <section className="detail-block" aria-labelledby="d-see">
        <h3 id="d-see" className="detail-h">What your team can see</h3>
        <p className="detail-note">Hover or tap a source to see how to give your team a better view of it.</p>
        <CapabilityLadder caps={ladder} />
      </section>

      <section className="detail-block" aria-labelledby="d-made">
        <h3 id="d-made" className="detail-h">Posts, emails and fixes your team made</h3>
        <dl className="detail-stats">
          <div><dt>You approved</dt><dd className="num">{fmtNum(d.approvedSinceStart)}</dd></div>
          <div><dt>You changed first</dt><dd className="num">{fmtNum(d.editedSinceStart)}</dd></div>
          <div><dt>You said no to</dt><dd className="num">{fmtNum(d.rejectedSinceStart)}</dd></div>
          <div><dt>Waiting for your OK</dt><dd className="num">{d.pending > 0 ? <Link to="/approvals">{fmtNum(d.pending)}</Link> : "0"}</dd></div>
        </dl>
      </section>

      <section className="detail-block" aria-labelledby="d-how">
        <h3 id="d-how" className="detail-h">How we measure it</h3>
        <ul className="detail-bullets">
          <li>“Where you started” is the numbers your team could see on the day your plan began. Where there were none, we say so.</li>
          <li>A goal with no starting number begins from what is typical for businesses like yours, until your first real reading.</li>
          <li>“A week” is the last 7 full days, and “a month” is the last 28. Dates follow your business’s time zone{p.timeZone ? ` (${p.timeZone})` : ""}.</li>
          <li>Each month the team writes you a short note, and a person from our team goes through it with you at the end of months 1 and 3.</li>
        </ul>
      </section>
    </>
  );
}

function NotStarted({ name }: { name: string }) {
  return (
    <>
      <header className="owner-head">
        <p className="owner-eyebrow">Your growth plan</p>
        <h1 className="owner-title">Not started yet</h1>
        <p className="owner-quiet">{name} · 3 goals · a check-in each month</p>
      </header>
      <section className="owner-block">
        <p><Link to="/plan" className="btn btn-ghost">See your plan</Link></p>
      </section>
    </>
  );
}
