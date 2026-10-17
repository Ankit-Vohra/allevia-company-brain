// The credit ledger's arithmetic, pure (no graph, no clock): which bucket an entry is in, what a month adds up to, what
// carries into the next month, and what is left. src/credits/index.ts reads and writes the entries; this decides the numbers.
//
// Every grant and spend is one CreditEntry with a whole number of credits (positive for a grant, negative for a spend) and the
// UTC month it belongs to. A month's balance is its own entries only: when a month opens, what carries over from the month
// before is written as entries of the new month (rollover, packs, trial, owed). So reading a balance is one indexed read of
// one month.
//
// Buckets, and the order credits are used in (the ones that end soonest first, so the owner never loses credits they could
// have used): rollover (ends with this month) -> trial (ends with the trial) -> plan (unused ones roll over) -> packs
// (never end while there is a plan).
//   plan      the month's plan credits ("plan"; a mid-month upgrade adds a top-up; a trial that starts on a month opened on
//             the default plan takes it back with a negative "plan" entry)
//   rollover  last month's unused plan credits, at most one month's allowance, for one month (CREDIT_RULES)
//   trial     the trial's credits ("trial", carried as "trial_carry"); what is unused when the trial ends is gone
//   packs     bought ("pack"), carried ("pack_carry"), or added by the Allevia team ("grant")
//   owed      what the month before went over by (at most one card or answer), taken first
import { CREDIT_PRICES, CREDIT_RULES, type CreditService } from "../../shared/plans.js";

export type GrantService = "plan" | "rollover" | "trial" | "trial_carry" | "pack" | "pack_carry" | "grant" | "owed";
export type EntryService = GrantService | CreditService;

export interface EntryRow {
  key: string;
  service: string;
  credits: number;
  at: number;
  by?: string | null;
}

export interface MonthTotals {
  plan: number;
  rollover: number;
  trial: number;           // granted or carried this month (before any of it ended)
  packs: number;
  owed: number;            // positive: what last month went over by
  used: number;            // positive: spent this month
  usedBeforeTrialEnd: number;
}

const SPEND = new Set<string>(Object.keys(CREDIT_PRICES));
export const isSpendService = (s: string): s is CreditService => SPEND.has(s);

export function totals(rows: readonly EntryRow[], trialEndsAt?: number): MonthTotals {
  const t: MonthTotals = { plan: 0, rollover: 0, trial: 0, packs: 0, owed: 0, used: 0, usedBeforeTrialEnd: 0 };
  for (const r of rows) {
    const c = Math.trunc(Number(r.credits) || 0);
    switch (r.service) {
      case "plan": t.plan += c; break;
      case "rollover": t.rollover += c; break;
      case "trial": case "trial_carry": t.trial += c; break;
      case "pack": case "pack_carry": case "grant": t.packs += c; break;
      case "owed": t.owed -= c; break;
      default:
        if (c >= 0) { t.packs += c; break; } // an unknown grant never expires
        t.used -= c;
        if (trialEndsAt === undefined || r.at < trialEndsAt) t.usedBeforeTrialEnd -= c;
    }
  }
  return t;
}

export interface MonthState {
  allowance: number;       // plan credits granted this month
  rollover: number;
  trial: number;           // trial credits that count (what was used of them, once the trial has ended)
  packs: number;
  owed: number;
  used: number;
  left: number;
  // what is left in each bucket, after this month's use
  remaining: { rollover: number; trial: number; plan: number; packs: number; over: number };
}

/** The month as it stands. `trialEnded`: the trial is over, so its unused credits no longer count. */
export function monthState(t: MonthTotals, o: { trialEnded?: boolean } = {}): MonthState {
  const plan = Math.max(0, t.plan);
  // what the trial had given by the time it ended: the use until then, after the rollover
  const trial = o.trialEnded ? Math.min(t.trial, Math.max(0, t.owed + t.usedBeforeTrialEnd - t.rollover)) : t.trial;
  let u = t.owed + t.used;
  const take = (have: number): number => { const x = Math.min(u, Math.max(0, have)); u -= x; return x; };
  const fromRollover = take(t.rollover);
  const fromTrial = take(trial);
  const fromPlan = take(plan);
  const fromPacks = take(t.packs);
  const remaining = {
    rollover: t.rollover - fromRollover, trial: trial - fromTrial, plan: plan - fromPlan, packs: t.packs - fromPacks, over: u,
  };
  return {
    allowance: plan, rollover: t.rollover, trial, packs: t.packs, owed: t.owed, used: t.used,
    left: remaining.rollover + remaining.trial + remaining.plan + remaining.packs - remaining.over, remaining,
  };
}

export interface Carry { rollover: number; packs: number; trial: number; owed: number }

/**
 * What the next month starts with from this one: unused plan credits (at most the next month's allowance, and only
 * from the plan: a rollover does not roll again), unused packs, the trial's unused credits while it still runs, and what
 * this month went over by.
 */
export function carryOver(s: MonthState, o: { nextAllowance: number; trialRuns: boolean; gap?: boolean }): Carry {
  const roll = CREDIT_RULES.rolloverMonths > 0 && !o.gap ? Math.min(Math.max(0, s.remaining.plan), Math.max(0, o.nextAllowance)) : 0;
  return { rollover: roll, packs: Math.max(0, s.remaining.packs), trial: o.trialRuns ? Math.max(0, s.remaining.trial) : 0, owed: Math.max(0, s.remaining.over) };
}

// ---------- months (UTC calendar months, like the Studio's asOf dates and GET /usage) ----------

export const monthOf = (ms: number): string => new Date(ms).toISOString().slice(0, 7);

export function monthStart(month: string): number {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return Date.UTC(y, m - 1, 1);
}

export function nextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return monthOf(Date.UTC(y, m, 1));
}

export function prevMonth(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return monthOf(Date.UTC(y, m - 2, 1));
}

/** Months from `a` (exclusive) to `b` (inclusive), oldest first; [] when b is not after a. */
export function monthsAfter(a: string, b: string, max = 24): string[] {
  const out: string[] = [];
  for (let m = nextMonth(a); m <= b && out.length < max; m = nextMonth(m)) out.push(m);
  return out;
}

/** What a credit check needs: the price for work charged when it is run; one credit for an answer or an OK (its price is
 *  known only at the end, or the card was already made), so the balance goes below zero by at most that one. */
export function neededFor(service: CreditService): number {
  const p = CREDIT_PRICES[service];
  if (p.credits <= 0) return 0;
  return p.charged === "run" ? p.credits : 1;
}
