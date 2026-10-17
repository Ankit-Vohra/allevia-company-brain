// The Plan and credits page, the top bar's chip and the out-of-credits message, as words and numbers with no React and no DOM,
// so they are tested as they are (tests/web/credits.test.ts). The numbers come from shared/plans.ts; the owner's sentence from
// shared/credits.ts. Words follow docs/owner-words.md: plain, one idea a line, the details behind "Show how".
import {
  leftWords, nextPlanUp, type BalanceDto, type BillingCycle, type CreditsDto, type SubscriptionDto,
} from "../../../shared/credits.js";
import { ANNUAL_DISCOUNT, CREDIT_PACKS, PLANS, PLAN_BY_ID, yearlyMonthly, type Currency, type Plan, type PlanId } from "../../../shared/plans.js";

/** The 402 sentence (shared/credits.ts outOfCreditsSentence), whichever plan it names. */
export function isOutOfCreditsSentence(s: string | undefined | null): boolean {
  return !!s && /^You've used (?:this month's|your trial) credits\. Buy \d+ more for /.test(s);
}

/** "212 credits left", for the chip. */
export const chipWords = (b: Pick<BalanceDto, "left">): string => leftWords(b.left);

/** How full the month is, 0 to 1, for the bar: used against everything the month had. */
export function usedShare(b: BalanceDto): number {
  const had = b.allowance + b.rollover + b.packs + b.trial - b.owed;
  if (had <= 0) return b.used > 0 ? 1 : 0;
  return Math.max(0, Math.min(1, b.used / had));
}

/** The page's heading and the one line under it. `date` formats an ISO date the owner's way ("1 Nov"). */
export function balanceWords(b: BalanceDto, date: (iso: string) => string): { title: string; lede: string } {
  const title = b.left > 0 ? leftWords(b.left) : b.left === 0 ? "No credits left" : `${Math.abs(b.left)} credits over`;
  if (b.status === "trial") {
    return { title, lede: b.trialEndsAt ? `Your free trial. It ends on ${date(b.trialEndsAt)}.` : "Your free trial." };
  }
  if (b.status === "cancelled") return { title, lede: "Your plan is cancelled. Pick a plan below to carry on." };
  const plan = b.plan ? PLAN_BY_ID[b.plan].name : "Your";
  const lead = b.status === "paused" ? "Your plan is paused." : `Your ${plan} plan.`;
  return { title, lede: `${lead} Credits reset on ${date(b.resetsAt)}.` };
}

/** What the month had, in one short line: "800 from your plan · 120 carried over · 100 bought". */
export function madeOfWords(b: BalanceDto): string {
  const parts = [
    b.allowance > 0 ? `${b.allowance.toLocaleString("en-US")} from your plan` : "",
    b.trial > 0 ? `${b.trial.toLocaleString("en-US")} from your trial` : "",
    b.rollover > 0 ? `${b.rollover.toLocaleString("en-US")} carried over` : "",
    b.packs > 0 ? `${b.packs.toLocaleString("en-US")} bought` : "",
    b.owed > 0 ? `${b.owed.toLocaleString("en-US")} owed from last month` : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

/** The plan to suggest when credits run out: the next one up (Growth from a trial). */
export const suggestedPlan = (b: Pick<BalanceDto, "plan" | "status">): PlanId | null => nextPlanUp(b.status === "trial" ? null : b.plan);

export interface PlanCardView {
  id: PlanId;
  name: string;
  price: string;           // "$249"
  per: string;             // "a month" / "a month, paid yearly"
  note: string | null;     // "$2,988 a year, 30% off" / "From $999: we talk first"
  credits: string;         // "800 credits a month"
  who: string;
  current: boolean;
  action: string | null;   // "Switch to Growth"; null on the current plan
  waiting: boolean;        // a request for this plan is waiting for the Allevia team
}

const money = (n: number, cur: Currency, fmt: (n: number, cur: Currency) => string) => fmt(n, cur);

/**
 * The plan cards for the Monthly / Yearly switch. Pause is not a card: it has its own button. The current plan is the one
 * the business is on in the cycle it pays (an implicit plan counts as monthly).
 */
export function planCards(
  o: { cycle: BillingCycle; currency: Currency; current: PlanId | null; currentCycle: BillingCycle; status: BalanceDto["status"]; pending?: SubscriptionDto["pending"] },
  fmt: (n: number, cur: Currency) => string,
): PlanCardView[] {
  return PLANS.filter((p: Plan) => p.id !== "pause").map((p: Plan) => {
    const yearly = o.cycle === "yearly" && !!p.price.yearly;
    const monthly = yearly ? yearlyMonthly(p.price.monthly)[o.currency] : p.price.monthly[o.currency];
    const current = o.status !== "trial" && o.status !== "cancelled" && o.current === p.id && (o.currentCycle === o.cycle);
    const note = p.fromPrice ? "We talk first, then quote." : yearly ? `${money(p.price.yearly![o.currency], o.currency, fmt)} a year, ${Math.round(ANNUAL_DISCOUNT * 100)}% off` : null;
    return {
      id: p.id, name: p.name, price: `${p.fromPrice ? "From " : ""}${money(monthly, o.currency, fmt)}`, per: yearly ? "a month, paid yearly" : "a month",
      note, credits: `${p.allowances.creditsPerMonth.toLocaleString("en-US")} credits a month`, who: p.who, current,
      action: current ? null : o.current === p.id && o.status === "active" ? `Pay ${o.cycle}` : `Switch to ${p.name}`,
      waiting: !!o.pending?.some((r) => r.kind === "change" && r.plan === p.id && (r.cycle ?? "monthly") === o.cycle),
    };
  });
}

/** "Buy 100 credits for $29". */
export function packWords(cur: Currency, fmt: (n: number, cur: Currency) => string): string {
  const p = CREDIT_PACKS[0]!;
  return `Buy ${p.credits} credits for ${fmt(p.price[cur], cur)}`;
}

/** The out-of-credits buttons on Discord link here: /plan?buy=pack100 or /plan?plan=growth. */
export function planIntent(search: string): { buy?: string; plan?: PlanId } {
  const q = new URLSearchParams(search);
  const buy = q.get("buy");
  const plan = q.get("plan");
  return {
    ...(buy && CREDIT_PACKS.some((p) => p.id === buy) ? { buy } : {}),
    ...(plan && plan in PLAN_BY_ID ? { plan: plan as PlanId } : {}),
  };
}

/** "Waiting: move to Pro, paid yearly" lines for requests the Allevia team has not done yet (test mode). */
export function pendingWords(pending: SubscriptionDto["pending"]): string[] {
  return pending.map((r) =>
    r.kind === "pack" ? `${CREDIT_PACKS.find((p) => p.id === r.packId)?.credits ?? 100} more credits`
      : r.kind === "pause" ? "Pause your plan"
      : r.kind === "cancel" ? "Cancel your plan"
      : `Move to ${r.plan ? PLAN_BY_ID[r.plan].name : "a new plan"}${r.cycle === "yearly" ? ", paid yearly" : ""}`);
}

/** The month's use, most first, at most `n` rows: "Deep question · 3 times · 15 credits". */
export function useLines(rows: CreditsDto["byService"], n = 5): Array<{ key: string; label: string; detail: string }> {
  return rows.slice(0, n).map((r) => ({
    key: r.key, label: r.label.replace(/\s*\(.*\)$/, ""),
    detail: `${r.times === 1 ? "once" : `${r.times} times`} · ${r.credits.toLocaleString("en-US")} ${r.credits === 1 ? "credit" : "credits"}`,
  }));
}
