// "Your plan", on Home: the three goals with a bar each, in the owner's words. In the first week a zero is not "going well": a
// goal with no reading says "We'll know after your first full week". The full plan (where you started, the monthly check-ins,
// how it is measured) is one tap away on "Your growth plan".
import { Link } from "react-router";
import type { ProgramScorecard } from "@shared/contracts";
import { fmtNum, fmtPct } from "../../lib/format";
import { planSummary } from "../../lib/home";
import type { GoalView } from "../../lib/plainwords";
import { CardSkeleton, HomeCard } from "./HomeCard";

export function PlanCard({ program, loading, error, toOk }: {
  program: ProgramScorecard | null | undefined; loading: boolean; error?: string;
  /** Goals the team suggested that the owner has not said OK to yet. */
  toOk: number;
}) {
  const plan = planSummary(program, fmtNum);
  return (
    <HomeCard id="plan" title="Your plan" to="/program" toLabel={plan ? "Your growth plan" : "See all"} busy={loading && program === undefined}>
      {program === undefined ? (
        error ? <p className="notice notice-bad" role="alert">Your plan did not load: {error}</p> : <CardSkeleton lines={3} />
      ) : !plan ? (
        <p className="hm-quiet">Your team will suggest three goals once it has read your website. You say OK, or change a number. That is the whole set-up.</p>
      ) : (
        <>
          <p className="hm-plan-when">{plan.when}</p>
          {toOk > 0 && <p className="hm-plan-ok"><Link to="/program">{toOk === 1 ? "One goal is" : `${toOk} goals are`} waiting for your OK</Link></p>}
          {plan.goals.length > 0 ? (
            <ul className="hm-goals">{plan.goals.map((g) => <Goal key={g.name} g={g} />)}</ul>
          ) : (
            <p className="hm-quiet">Your team will suggest two or three goals once it has had a first look at your business.</p>
          )}
          {plan.allWaiting && plan.goals.length > 0 && <p className="hm-quiet">We'll know how you are doing after your first full week.</p>}
        </>
      )}
    </HomeCard>
  );
}

function Goal({ g }: { g: GoalView }) {
  const tone = g.status?.tone ?? "none";
  return (
    <li className={`hm-goal tone-${tone}`}>
      <div className="hm-goal-top">
        <span className="hm-goal-title">{g.title}</span>
        {g.status && <span className="hm-goal-state"><span className="hm-dot" aria-hidden="true" />{g.status.word}</span>}
      </div>
      <span
        className={`hm-bar${g.progress === null ? " is-empty" : ""}`} role="img"
        aria-label={g.progress === null ? "We'll know after your first full week." : `${fmtPct(g.progress)} of the way to the goal.`}
      >
        {g.progress !== null && <span style={{ width: `${Math.max(3, g.progress * 100)}%` }} />}
      </span>
      <p className="hm-goal-line">{g.known && g.now !== null ? <><b className="num">{g.now}</b> now{g.start !== null ? <> · started at <span className="num">{g.start}</span></> : null}</> : g.why}</p>
    </li>
  );
}
