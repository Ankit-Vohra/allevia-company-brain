// Plan and credits (docs/superpowers/specs/2026-10-17-credits-login-subscription-design.md §1), owner-first: credits left this
// month and when they reset, what used them (by service and by person), the plans with a Monthly / Yearly switch, "Switch to
// Growth", "Buy 100 credits", "Pause" and "Cancel" (which offers Pause first). Billing is in test mode, so the page says the
// change is made by hand within a day. The price list, the fine print and this month's entries are behind "Show how".
// GET /api/:t/credits for everyone who can open the business; GET /api/:t/subscription and the changes for the owner only
// (a teammate and the public demo see the page without the buttons).
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import { TEST_MODE_NOTE, type BillingCycle, type BillingResultDto } from "@shared/credits";
import { ALLEVIA_90, ANNUAL_DISCOUNT, CREDIT_PACKS, CREDIT_RULES, PLANS, PLAN_BY_ID, TRIAL, type PlanId } from "@shared/plans";
import { api, getPublicMode } from "../api";
import { creditsChanged, useCurrency } from "../components/Credits";
import { ShowDetails } from "../components/ShowDetails";
import { balanceWords, madeOfWords, packWords, pendingWords, planCards, planIntent, useLines, usedShare } from "../lib/credits";
import { fmtDate, fmtMoney, fmtNum } from "../lib/format";
import { ApiError } from "../lib/sse";
import { useApp, useAsync } from "../state/app";
import "./owner-page.css";
import "./plan.css";

const dayWords = (iso: string) => fmtDate(iso);

export default function PlanPage() {
  const { tenant } = useApp();
  const loc = useLocation();
  const cur = useCurrency();
  const money = (n: number) => fmtMoney(n, cur);
  const [tick, setTick] = useState(0);
  const credits = useAsync(() => api.credits(tenant.id), [tenant.id, tick]);
  const sub = useAsync(() => api.subscription(tenant.id).catch(() => null), [tenant.id, tick]);
  const intent = useMemo(() => planIntent(loc.search), [loc.search]);
  const [cycle, setCycle] = useState<BillingCycle>("monthly");
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const plansRef = useRef<HTMLElement>(null);

  useEffect(() => { if (sub.data?.cycle) setCycle(sub.data.cycle); }, [sub.data?.cycle]);
  useEffect(() => {
    if (intent.plan || intent.buy) plansRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [intent.plan, intent.buy, credits.data]);

  const demo = getPublicMode();
  const owner = !demo && !!sub.data;
  const b = credits.data?.balance;

  const act = async (key: string, fn: () => Promise<BillingResultDto>) => {
    setBusy(key);
    setResult(null);
    try {
      const r = await fn();
      setResult({ ok: true, text: r.message });
      setConfirmCancel(false);
      setTick((t) => t + 1);
      creditsChanged();
    } catch (e) {
      setResult({ ok: false, text: e instanceof ApiError && e.status === 403 ? "Only the business owner can change the plan." : (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  if (credits.error && !credits.data) {
    return <div className="owner-page"><p className="notice notice-bad" role="alert">Your credits did not load: {credits.error}</p></div>;
  }
  if (!b || !credits.data) {
    return <div className="owner-page" aria-busy="true"><span className="skeleton owner-skel-line" /><span className="skeleton owner-skel-line" /></div>;
  }

  const head = balanceWords(b, dayWords);
  const share = usedShare(b);
  const current = sub.data ? (sub.data.status === "paused" ? "pause" : sub.data.plan) : b.plan;
  const cards = planCards({
    cycle, currency: cur, current, currentCycle: sub.data?.cycle ?? "monthly", status: b.status, ...(sub.data ? { pending: sub.data.pending } : {}),
  }, (n, c) => fmtMoney(n, c));
  const waiting = sub.data ? pendingWords(sub.data.pending) : [];
  const uses = useLines(credits.data.byService);
  const people = credits.data.byPerson;
  const pause = PLAN_BY_ID.pause;
  const offPct = Math.round(ANNUAL_DISCOUNT * 100);

  return (
    <div className="owner-page plan-page">
      <header className="owner-head">
        <p className="owner-eyebrow">Plan and credits</p>
        <h1 className="owner-title">{head.title}</h1>
        <p className="owner-lede">{head.lede}</p>
        <span className="owner-bar plan-bar" role="img" aria-label={`${fmtNum(b.used)} credits used this month.`}>
          <span style={{ width: `${b.used > 0 ? Math.max(2, share * 100) : 0}%` }} />
        </span>
        <p className="owner-quiet">{fmtNum(b.used)} used this month{madeOfWords(b) ? ` · ${madeOfWords(b)}` : ""}</p>
      </header>

      {waiting.length > 0 && (
        <p className="owner-callout" role="status">
          You asked for: {waiting.join("; ")}. {TEST_MODE_NOTE}
        </p>
      )}
      {result && <p className={`notice ${result.ok ? "notice-ok" : "notice-bad"}`} role={result.ok ? "status" : "alert"}>{result.text}</p>}

      <section className="owner-block" aria-labelledby="used-h">
        <h2 id="used-h" className="owner-h">What used them</h2>
        {uses.length ? (
          <ul className="plan-uses">
            {uses.map((u) => <li key={u.key}><span>{u.label}</span><span className="plan-uses-detail">{u.detail}</span></li>)}
          </ul>
        ) : (
          <p className="owner-quiet">Nothing yet this month. You only spend credits on what you ask for or say OK to.</p>
        )}
        {people.length > 1 && (
          <p className="owner-quiet">By person: {people.map((p) => `${p.label} ${fmtNum(p.credits)}`).join(" · ")}</p>
        )}
      </section>

      <section className="owner-block" aria-labelledby="plans-h" ref={plansRef}>
        <div className="plan-plans-head">
          <h2 id="plans-h" className="owner-h">Plans</h2>
          <div className="plan-cycle" role="radiogroup" aria-label="How you pay">
            {(["monthly", "yearly"] as const).map((c) => (
              <button key={c} type="button" role="radio" aria-checked={cycle === c} className={`plan-cycle-btn${cycle === c ? " is-on" : ""}`} onClick={() => setCycle(c)}>
                {c === "monthly" ? "Monthly" : <>Yearly <span className="plan-cycle-off">{offPct}% off</span></>}
              </button>
            ))}
          </div>
        </div>
        <ul className="plan-cards">
          {cards.map((c) => (
            <li key={c.id} className={`plan-card${c.current ? " is-current" : ""}${intent.plan === c.id ? " is-asked" : ""}`}>
              <div className="plan-card-top">
                <h3 className="plan-card-name">{c.name}</h3>
                {c.current && <span className="plan-card-tag">Your plan</span>}
              </div>
              <p className="plan-card-price"><b>{c.price}</b> {c.per}</p>
              {c.note && <p className="plan-card-note">{c.note}</p>}
              <p className="plan-card-credits">{c.credits}</p>
              <p className="plan-card-who">{c.who}</p>
              {c.action && owner && (
                c.waiting
                  ? <p className="plan-card-note">Asked for. We'll switch you within a day.</p>
                  : <button type="button" className={`btn btn-sm ${intent.plan === c.id || (!intent.plan && c.id === "growth") ? "btn-gold" : "btn-ghost"}`} disabled={!!busy}
                    onClick={() => void act(`plan-${c.id}`, () => api.changePlan(tenant.id, c.id as PlanId, cycle))}>
                    {busy === `plan-${c.id}` ? "One moment" : c.action}
                  </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="owner-block plan-more" aria-label="More credits, pause or cancel">
        {owner ? (
          <>
            <div className={`plan-more-row${intent.buy ? " is-asked" : ""}`}>
              <div>
                <p className="plan-more-title">Need more this month?</p>
                <p className="owner-quiet">{CREDIT_PACKS[0]!.credits} extra credits. They don't run out while you have a plan.</p>
              </div>
              <button type="button" className={`btn btn-sm ${intent.buy ? "btn-gold" : "btn-ghost"}`} disabled={!!busy} onClick={() => void act("pack", () => api.buyPack(tenant.id, intent.buy ?? CREDIT_PACKS[0]!.id))}>
                {busy === "pack" ? "One moment" : packWords(cur, (n, c) => fmtMoney(n, c))}
              </button>
            </div>
            {current !== "pause" && b.status !== "cancelled" && (
              <div className="plan-more-row">
                <div>
                  <p className="plan-more-title">Taking a break?</p>
                  <p className="owner-quiet">Pause for {money(pause.price.monthly[cur])} a month. Your team keeps your company brain and you get {pause.allowances.creditsPerMonth} credits a month.</p>
                </div>
                <button type="button" className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => void act("pause", () => api.pausePlan(tenant.id))}>{busy === "pause" ? "One moment" : "Pause"}</button>
              </div>
            )}
            {b.status !== "cancelled" && (confirmCancel ? (
              <div className="plan-cancel" role="group" aria-label="Cancel your plan">
                <p className="plan-more-title">Before you cancel: you can pause instead.</p>
                <p className="owner-quiet">Pausing keeps your company brain, your drafts and what your team learned, for {money(pause.price.monthly[cur])} a month. Cancelling stops your plan; you keep this month's credits.</p>
                <div className="plan-cancel-actions">
                  {current !== "pause" && <button type="button" className="btn btn-gold btn-sm" disabled={!!busy} onClick={() => void act("pause", () => api.pausePlan(tenant.id))}>Pause instead</button>}
                  <button type="button" className="btn btn-ghost btn-sm plan-cancel-go" disabled={!!busy} onClick={() => void act("cancel", () => api.cancelPlan(tenant.id))}>{busy === "cancel" ? "One moment" : "Cancel my plan"}</button>
                  <button type="button" className="btn btn-quiet btn-sm" onClick={() => setConfirmCancel(false)}>Keep my plan</button>
                </div>
              </div>
            ) : (
              <button type="button" className="btn btn-quiet btn-sm plan-cancel-link" onClick={() => setConfirmCancel(true)}>Cancel my plan</button>
            ))}
          </>
        ) : (
          <p className="owner-quiet">{demo ? "This is the demo: nothing can be bought or changed here." : "Only the business owner can change the plan or buy credits."}</p>
        )}
      </section>

      <p className="owner-callout" role="note">{TEST_MODE_NOTE}</p>

      <ShowDetails label="Show how" openLabel="Hide how">
        <section className="detail-block" aria-labelledby="d-prices">
          <h3 id="d-prices" className="detail-h">What each thing costs</h3>
          <ul className="detail-list plan-prices">
            {credits.data.prices.map((p) => (
              <li key={p.service}><span className="detail-key">{p.credits ? `${fmtNum(p.credits)}` : "Free"}</span><span>{p.label}<span className="detail-sub">{p.charged === "answered" ? "When the answer arrives" : p.charged === "approved" ? "When you say OK" : p.charged === "run" ? "When you run it" : "Always free"}</span></span></li>
            ))}
          </ul>
          <p className="detail-note">What your team does on its own is free: Today's note, the stand-up and the monthly website check-up. An answer that fails, or a draft you say No to, costs nothing.</p>
        </section>

        <section className="detail-block" aria-labelledby="d-rules">
          <h3 id="d-rules" className="detail-h">The fine print</h3>
          <ul className="detail-bullets">
            <li>Credits from your plan that you don't use roll over for {CREDIT_RULES.rolloverMonths} month, up to one month's worth.</li>
            <li>Credits you buy don't run out while you have a plan.</li>
            <li>A new business starts with a free trial: {TRIAL.credits} credits for {TRIAL.days} days.</li>
            <li>If your credits run out halfway through something, it still finishes. That one goes on next month.</li>
            <li>Paying yearly takes {offPct}% off every month. Prices are before tax.</li>
          </ul>
        </section>

        {credits.data.entries.length > 0 && (
          <section className="detail-block" aria-labelledby="d-entries">
            <h3 id="d-entries" className="detail-h">This month, line by line</h3>
            <ul className="detail-list">
              {credits.data.entries.slice(0, 50).map((e) => (
                <li key={e.id}>
                  <span className="detail-key">{e.credits > 0 ? `+${fmtNum(e.credits)}` : fmtNum(e.credits)}</span>
                  <span>{e.label}{e.for ? `: ${e.for.name}` : ""}<span className="detail-sub">{fmtDate(e.at)} · {e.by}</span></span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="detail-block" aria-labelledby="d-plans">
          <h3 id="d-plans" className="detail-h">The plans side by side</h3>
          <div className="detail-table-wrap">
            <table className="detail-table plans-table">
              <thead>
                <tr><th scope="col"><span className="visually-hidden">Plan</span></th>{PLANS.map((p) => <th scope="col" key={p.id} className={p.id === current ? "is-current" : ""}>{p.name}</th>)}</tr>
              </thead>
              <tbody>
                <tr><th scope="row">Each month</th>{PLANS.map((p) => <td key={p.id} className="num">{p.fromPrice ? "from " : ""}{money(p.price.monthly[cur])}</td>)}</tr>
                <tr><th scope="row">Credits a month</th>{PLANS.map((p) => <td key={p.id} className="num">{fmtNum(p.allowances.creditsPerMonth)}</td>)}</tr>
                <tr><th scope="row">People</th>{PLANS.map((p) => <td key={p.id} className="num">{p.allowances.seats === null ? "–" : fmtNum(p.allowances.seats)}</td>)}</tr>
                <tr><th scope="row">Time with us</th>{PLANS.map((p) => <td key={p.id}>{p.human ?? "None"}</td>)}</tr>
              </tbody>
            </table>
          </div>
          <p className="detail-note">Every plan has your whole team.</p>
        </section>

        <section className="detail-block" aria-labelledby="d-90">
          <h3 id="d-90" className="detail-h">The three-month growth plan</h3>
          <p className="detail-note">{money(ALLEVIA_90.upfront[cur])} up front, or {ALLEVIA_90.instalments.count} payments of {money(ALLEVIA_90.instalments.each[cur])}. It includes the {PLAN_BY_ID[ALLEVIA_90.includesPlan].name} plan, a note from your team every month and a review with a person from our team. A full refund in the first {ALLEVIA_90.guarantees.refundDays} days.</p>
          <p className="detail-note">Not sure what to do next? <Link to="/approvals">See what's waiting for your OK</Link>.</p>
        </section>
      </ShowDetails>
    </div>
  );
}
