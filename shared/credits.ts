// Credits in the owner's words, and the shapes the API sends for them (GET /api/:t/credits, GET /api/:t/subscription). Pure:
// no Node or DOM imports, so the server (src/credits, src/billing) and the web app (/plan, the top bar's chip, the out-of-credits
// message) say the same thing. The numbers are in plans.ts; this file only words them and decides what an approval costs.
import { CREDIT_PACKS, CREDIT_PRICES, PLAN_BY_ID, type CreditService, type Currency, type Money, type PlanId } from "./plans.js";

export type BillingCycle = "monthly" | "yearly";
export type SubscriptionStatus = "trial" | "active" | "paused" | "cancelled";

// ---------- what a card costs when the owner says OK ----------

/** The Studio card fields that decide its price (studio/approve.ts StudioCard, structurally). */
export interface StudioPriceCard {
  variants: Array<{ id: string; premium?: boolean }>;
  recommended?: string;
  creative?: { kind: string; format?: string };
  extras?: Array<{ kind: string; from: string }>;
}

export interface Charge { service: CreditService; part: string }

/** What approving this Studio option spends: the picture (or the ad, the clip, the carousel), plus a clip made from it. */
export function studioCharges(card: StudioPriceCard, variantId?: string): Charge[] {
  const chosen = variantId ?? card.recommended ?? card.variants[0]?.id ?? "";
  const v = card.variants.find((x) => x.id === chosen);
  const kind = card.creative?.kind;
  const base: CreditService = kind === "clip" ? "video_short"
    : card.creative?.format === "carousel" ? "carousel"
    : v?.premium ? "photo_ad"
    : "picture";
  const out: Charge[] = [{ service: base, part: "" }];
  if ((card.extras ?? []).some((x) => x.kind === "clip" && x.from === chosen)) out.push({ service: "video_short", part: "clip" });
  return out;
}

/** What approving a card of this kind spends (a Studio card: studioCharges). Free kinds cost us nothing to carry out. */
export function approvalCharges(kind: string, studio?: StudioPriceCard | null, variantId?: string): Charge[] {
  if (studio && (kind === "content_draft" || kind === "publish_post")) return studioCharges(studio, variantId);
  if (kind === "calendar_event") return [{ service: "meeting_book", part: "" }];
  if (kind === "pause_ad" || kind === "connection_action") return [];
  return [{ service: "draft_text", part: "" }];
}

export const chargesTotal = (cs: readonly Charge[]): number => cs.reduce((s, c) => s + CREDIT_PRICES[c.service].credits, 0);

// ---------- words ----------

export const creditsWord = (n: number): string => `${Math.abs(n) === 1 ? "credit" : "credits"}`;
const num = (n: number): string => n.toLocaleString("en-US");

/** "Uses 5 credits when you say OK" (nothing for a free card). */
export function usesWords(credits: number): string | null {
  return credits > 0 ? `Uses ${num(credits)} ${creditsWord(credits)} when you say OK` : null;
}

/** The plan to suggest when credits run out: the next one up the ladder (Growth from a trial, Starter or Pause). */
export function nextPlanUp(plan: PlanId | null | undefined): PlanId | null {
  if (!plan || plan === "starter" || plan === "pause") return "growth";
  if (plan === "growth") return "pro";
  if (plan === "pro") return "scale";
  return null;
}

const PACK = CREDIT_PACKS[0]!;

export function moneyWords(m: Money, cur: Currency): string {
  const v = m[cur];
  const sign = cur === "USD" ? "$" : cur === "GBP" ? "£" : cur === "AUD" ? "A$" : "";
  return sign ? `${sign}${num(v)}` : `${num(v)} ${cur}`;
}

/** The sentence an owner sees when credits run out (the founder's words, 17 October 2026). */
export function outOfCreditsSentence(o: { plan?: PlanId | null; trial?: boolean; currency?: Currency } = {}): string {
  const next = nextPlanUp(o.trial ? null : o.plan);
  const buy = `Buy ${num(PACK.credits)} more for ${moneyWords(PACK.price, o.currency ?? "USD")}`;
  const used = o.trial ? "You've used your trial credits." : "You've used this month's credits.";
  return next ? `${used} ${buy} or move to ${PLAN_BY_ID[next].name}.` : `${used} ${buy}.`;
}

/** What comes with a 402 (out of credits): the sentence, and what the two buttons do. */
export interface OutOfCreditsInfo {
  left: number;
  needed: number;
  service: CreditService;
  packId: string;
  nextPlan: PlanId | null;
}

/** "212 credits left" for the top bar; "No credits left" at zero or below. */
export function leftWords(left: number): string {
  return left > 0 ? `${num(left)} ${creditsWord(left)} left` : "No credits left";
}

// ---------- what the API sends ----------

export interface BalanceDto {
  month: string;                 // "2026-10" (UTC months)
  plan: PlanId | null;           // null on a trial that has not chosen a plan, or after cancelling
  status: SubscriptionStatus;
  allowance: number;             // this month's plan credits
  rollover: number;              // unused plan credits carried from last month (they end with this month)
  packs: number;                 // bought credits, and any the Allevia team added: they never run out while there is a plan
  trial: number;                 // trial credits still to use (they end with the trial)
  owed: number;                  // credits last month went over by, taken from this month
  used: number;                  // spent this month
  left: number;                  // what is left now; below zero by at most one card or answer
  resetsAt: string;              // ISO date the month's credits reset (the first of next month, UTC)
  trialEndsAt?: string;
}

export interface CreditUseRow { key: string; label: string; credits: number; times: number }

export interface CreditEntryDto {
  id: string;
  at: string;                    // ISO
  service: string;
  label: string;                 // what it was, in plain words
  credits: number;               // + granted, - spent
  by: string;                    // who, in plain words
  for?: { id: string; name: string } | undefined;
}

export interface CreditsDto {
  balance: BalanceDto;
  byService: CreditUseRow[];     // this month's spending, most first
  byPerson: CreditUseRow[];
  entries: CreditEntryDto[];     // this month, newest first (at most 200)
  prices: Array<{ service: CreditService; label: string; credits: number; charged: string }>;
}

export interface SubscriptionDto {
  plan: PlanId | null;
  cycle: BillingCycle;
  status: SubscriptionStatus;
  startedAt?: string;
  renewsAt?: string;
  trialEndsAt?: string;
  provider: string;              // "test" until a payment provider is connected
  billing: "test-request" | "test-instant";
  pending: BillingRequestDto[];  // requests waiting for the Allevia team (test mode)
  implicit?: boolean;            // no subscription record yet: the business runs on the plan it has always had
}

export interface BillingRequestDto {
  id: string;
  kind: "change" | "pack" | "pause" | "cancel";
  plan?: PlanId;
  cycle?: BillingCycle;
  packId?: string;
  at: string;
  status: "pending" | "done" | "declined";
}

/** What POST change / packs / pause / cancel answer: what happened, in one sentence, and the request. */
export interface BillingResultDto {
  done: boolean;                 // applied now (test-instant), or recorded for the Allevia team (test-request)
  message: string;
  request: BillingRequestDto;
  subscription: SubscriptionDto;
}

/** Billing is in test mode: the page says so. */
export const TEST_MODE_NOTE = "Billing opens soon. We'll switch you by hand within a day.";
