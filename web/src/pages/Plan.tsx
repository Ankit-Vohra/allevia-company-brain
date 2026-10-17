// Your plan and credits (product design §4.1, §4.2), owner-first: which plan you are on and what it costs, this month's
// Studio credits used and left, and one honest line on billing. The comparison of every plan, the list of what the
// credits were spent on and the fine print are behind one "Show how". Prices come from shared/plans.ts in the
// business's currency (US dollars, labelled, when we do not price in it yet); credits and answers are GET /api/:t/usage.
// Billing is not connected, so nothing here is an invoice: it is what the plan would include.
import { Link } from "react-router";
import { ALLEVIA_90, ANNUAL_DISCOUNT, CREDIT_RULES, PLANS, PLAN_BY_ID, isCurrency, yearlyMonthly, type Currency, type Plan } from "@shared/plans";
import { api } from "../api";
import { ShowDetails } from "../components/ShowDetails";
import { currentLocale, fmtDate, fmtMoney, fmtNum } from "../lib/format";
import { monthWeek, usdOnlyNote } from "../lib/plainwords";
import { useApp, useAsync } from "../state/app";
import type { Usage } from "../types-ext";
import "./owner-page.css";

const monthName = (month: string) => {
  try {
    return new Intl.DateTimeFormat(currentLocale(), { month: "long", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`));
  } catch {
    return month;
  }
};

function sourcesText(p: Plan): string {
  const s = p.allowances.sources;
  return s.kind === "all" ? "Every source you connect" : s.kind === "read_only" ? "Kept, read only" : `${s.max} sources (${s.names.join(", ")})`;
}

export default function PlanPage() {
  const { tenant } = useApp();
  const program = useAsync(() => api.program(tenant.id).catch(() => null), [tenant.id]);
  const usage = useAsync(() => api.usage(tenant.id), [tenant.id]);

  const cur: Currency = tenant.currency && isCurrency(tenant.currency.toUpperCase()) ? (tenant.currency.toUpperCase() as Currency) : "USD";
  const money = (m: Record<Currency, number>) => fmtMoney(m[cur], cur);
  const note = usdOnlyNote(tenant.currency);
  const plan = PLAN_BY_ID[ALLEVIA_90.includesPlan];

  return (
    <div className="owner-page">
      <header className="owner-head">
        <p className="owner-eyebrow">Your plan</p>
        <h1 className="owner-title">{plan.name}</h1>
        <p className="owner-lede">
          {money(plan.price.monthly)} a month. {program.data ? `Included while you’re in your growth plan (${monthWeek(program.data.day)}).` : "The plan most owners start on."}
        </p>
        {note && <p className="owner-quiet">{note}</p>}
      </header>

      <section className="owner-block" aria-labelledby="credits-h">
        <h2 id="credits-h" className="owner-h">Studio credits{usage.data ? ` for ${monthName(usage.data.month)}` : ""}</h2>
        {usage.data === undefined ? (
          usage.error ? <p className="notice notice-bad" role="alert">This month’s use did not load: {usage.error}</p> : <span className="skeleton owner-skel-line" aria-busy="true" />
        ) : (
          <Credits usage={usage.data} allowance={plan.allowances.studioCreditsPerMonth} />
        )}
      </section>

      <p className="owner-callout" role="note">Billing isn’t connected yet. This is what your plan would include.</p>

      <ShowDetails label="Show how" openLabel="Hide how">
        <section className="detail-block" aria-labelledby="d-plans">
          <h3 id="d-plans" className="detail-h">All the plans</h3>
          <div className="detail-table-wrap">
            <table className="detail-table plans-table">
              <thead>
                <tr><th scope="col"><span className="visually-hidden">Plan</span></th>{PLANS.map((p) => <th scope="col" key={p.id} className={p.id === plan.id ? "is-current" : ""}>{p.name}</th>)}</tr>
              </thead>
              <tbody>
                <tr><th scope="row">Who it’s for</th>{PLANS.map((p) => <td key={p.id}>{p.who}</td>)}</tr>
                <tr><th scope="row">Each month</th>{PLANS.map((p) => <td key={p.id} className="num">{p.fromPrice ? "from " : ""}{money(p.price.monthly)}{p.price.yearly ? <span className="detail-sub">or {money(yearlyMonthly(p.price.monthly))} a month paid yearly ({money(p.price.yearly)} a year, {Math.round(ANNUAL_DISCOUNT * 100)}% off)</span> : null}</td>)}</tr>
                <tr><th scope="row">Studio credits</th>{PLANS.map((p) => <td key={p.id} className="num">{fmtNum(p.allowances.studioCreditsPerMonth)}</td>)}</tr>
                <tr><th scope="row">Answers</th>{PLANS.map((p) => <td key={p.id} className="num">{fmtNum(p.allowances.answersPerMonth)}</td>)}</tr>
                <tr><th scope="row">What it reads</th>{PLANS.map((p) => <td key={p.id}>{sourcesText(p)}</td>)}</tr>
                <tr><th scope="row">People</th>{PLANS.map((p) => <td key={p.id} className="num">{p.allowances.seats === null ? "–" : fmtNum(p.allowances.seats)}</td>)}</tr>
                <tr><th scope="row">Time with us</th>{PLANS.map((p) => <td key={p.id}>{p.human ?? "None"}</td>)}</tr>
              </tbody>
            </table>
          </div>
          <p className="detail-note">Every plan has your whole team. Prices are before tax.</p>
        </section>

        <section className="detail-block" aria-labelledby="d-90">
          <h3 id="d-90" className="detail-h">The three-month growth plan</h3>
          <ul className="detail-bullets">
            <li>{money(ALLEVIA_90.upfront)} up front, or {ALLEVIA_90.instalments.count} payments of {money(ALLEVIA_90.instalments.each)}. It includes the {plan.name} plan.</li>
            <li>Your goals, a note from your team every month, and a review with a person from our team at the end of months 1 and 3.</li>
            <li>A full refund in the first {ALLEVIA_90.guarantees.refundDays} days. We’ll tell you at least {ALLEVIA_90.guarantees.renewalNoticeDays} days before it renews.</li>
            <li>After month 3 you move to {PLAN_BY_ID[ALLEVIA_90.afterProgram.defaultPlan].name}, or choose {ALLEVIA_90.afterProgram.alternatives.map((id) => PLAN_BY_ID[id].name).join(" or ")}.</li>
          </ul>
        </section>

        {usage.data && (
          <section className="detail-block" aria-labelledby="d-spent">
            <h3 id="d-spent" className="detail-h">What the credits were spent on</h3>
            {usage.data.credits.items.length ? (
              <ul className="detail-list">
                {usage.data.credits.items.map((i) => (
                  <li key={`${i.subject}-${i.date}`}><span className="detail-key">{fmtDate(i.date)}</span><span>{i.name}<span className="detail-sub"> · {fmtNum(i.credits)} {i.credits === 1 ? "credit" : "credits"}</span></span></li>
                ))}
              </ul>
            ) : (
              <p className="detail-note">Nothing yet this month. A credit is spent when you approve a photo post, never for a draft you turn down.</p>
            )}
            <p className="detail-note">A photo post is 1 credit, a carousel 2, a photo shoot 3 and a reel 4. Questions, notes and drafts of words are free.</p>
          </section>
        )}

        <section className="detail-block" aria-labelledby="d-rules">
          <h3 id="d-rules" className="detail-h">The fine print on credits</h3>
          <ul className="detail-bullets">
            <li>Credits you don’t use roll over for {CREDIT_RULES.rolloverMonths} month, up to one month’s worth.</li>
            <li>A job can borrow up to {Math.round(CREDIT_RULES.borrowFraction * 100)}% of next month’s credits, so a busy week doesn’t stop.</li>
            <li>Need more? {fmtNum(CREDIT_RULES.topUp.credits)} extra credits cost {money(CREDIT_RULES.topUp.price)}.</li>
            {usage.data && <li>Your team answered {fmtNum(usage.data.answers)} {usage.data.answers === 1 ? "question" : "questions"} this month. Your plan covers {fmtNum(plan.allowances.answersPerMonth)}.</li>}
          </ul>
        </section>

        <section className="detail-block" aria-labelledby="d-live">
          <h3 id="d-live" className="detail-h">Practice runs</h3>
          <p className="detail-note">
            {usage.data?.actionsLive
              ? "Approved actions are live: when you say OK, an issue is filed or a message is posted for real."
              : "Right now, when you say OK to something like a GitHub fix or a Discord post, your team does a practice run: it shows what it would have done and sends nothing. Your team switches this on when you’re ready."}
          </p>
          <p className="detail-note">Not sure what to do next? <Link to="/approvals">See what’s waiting for your OK</Link>.</p>
        </section>
      </ShowDetails>
    </div>
  );
}

function Credits({ usage, allowance }: { usage: Usage; allowance: number }) {
  const used = usage.credits.used;
  const left = Math.max(0, allowance - used);
  const share = allowance > 0 ? Math.min(1, used / allowance) : 0;
  return (
    <div className="owner-credits">
      <p className="owner-credits-line"><b className="num">{fmtNum(used)}</b> of <span className="num">{fmtNum(allowance)}</span> used</p>
      <span className="owner-bar" role="img" aria-label={`${fmtNum(used)} of ${fmtNum(allowance)} credits used.`}>
        <span style={{ width: `${used > 0 ? Math.max(2, share * 100) : 0}%` }} />
      </span>
      <p className="owner-card-why">
        {used > allowance
          ? "You’ve gone past this month’s credits. The extra comes out of next month’s."
          : `${fmtNum(left)} left. Credits you don’t use roll over to next month.`}
      </p>
    </div>
  );
}
