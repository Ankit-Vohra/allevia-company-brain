// Plans, credits and prices: the single source of truth for the pricing page, the allowance meter and billing.
// Transcribed from the product design spec (docs/superpowers/specs/2026-10-15-allevia-product-design.md):
//   §4.1 plans and packaging rules, §4.2 Studio credits, §4.3 prices in four currencies (ex-VAT/GST),
//   §3.3 Allevia 90 (the improvement program and its guarantees).
// Pure data and types: no Node or DOM imports, so the backend and the web app can both read it. Amounts are whole
// units of the currency (449 is $449, not cents).

export const CURRENCIES = ["USD", "GBP", "AED", "AUD"] as const;
export type Currency = (typeof CURRENCIES)[number];
export type Money = Record<Currency, number>;

export const isCurrency = (s: string): s is Currency => (CURRENCIES as readonly string[]).includes(s);

export type PlanId = "essentials" | "growth" | "pro" | "pause";

// What a plan gates (§4.1: "we gate volume, sources, locations, seats and human time"; every plan has every agent in
// every department of shared/roster.ts).
export interface PlanAllowances {
  studioCreditsPerMonth: number;
  answersPerMonth: number;                       // fair use
  answerModelBudgetUsd?: number;                 // the hidden model budget behind the answers; never shown to the owner
  // 3 named sources, every source, or the sources kept read-only (Pause)
  sources: { kind: "limited"; max: number; names: string[] } | { kind: "all" } | { kind: "read_only" };
  locations: number | null;                      // null: not stated (Pause)
  seats: number | null;
}

export interface Plan {
  id: PlanId;
  name: string;
  isDefault?: boolean;                           // Growth
  graduatesOnly?: boolean;                       // Essentials: open only to Allevia 90 graduates at launch
  who: string;
  price: { monthly: Money; yearly?: Money };     // yearly: Growth only (2 months free)
  allowances: PlanAllowances;
  rhythm: string;
  human: string | null;
  extras: string[];
}

export const PLANS: readonly Plan[] = [
  {
    id: "essentials",
    name: "Essentials",
    graduatesOnly: true,
    who: "Program graduates on a budget",
    price: { monthly: { USD: 199, GBP: 149, AED: 729, AUD: 289 } },
    allowances: {
      studioCreditsPerMonth: 20, answersPerMonth: 100, answerModelBudgetUsd: 25,
      sources: { kind: "limited", max: 3, names: ["site", "instagram", "gbp"] }, locations: 1, seats: 2,
    },
    rhythm: "Daily brief, Monday pack, monthly report",
    human: "Quarterly async check",
    extras: [],
  },
  {
    id: "growth",
    name: "Growth",
    isDefault: true,
    who: "Single-location owners who want the whole team",
    price: {
      monthly: { USD: 449, GBP: 339, AED: 1649, AUD: 649 },
      yearly: { USD: 4490, GBP: 3390, AED: 16490, AUD: 6490 },
    },
    allowances: {
      studioCreditsPerMonth: 50, answersPerMonth: 300, answerModelBudgetUsd: 60,
      sources: { kind: "all" }, locations: 1, seats: 6,
    },
    rhythm: "The full operating rhythm (§3.2)",
    human: "Named Growth Partner, 30-min monthly async review",
    extras: ["WhatsApp delivery (Phase 2)"],
  },
  {
    id: "pro",
    name: "Pro",
    who: "Multi-location, regulated or done-with-you",
    price: { monthly: { USD: 999, GBP: 749, AED: 3669, AUD: 1449 } },
    allowances: {
      studioCreditsPerMonth: 120, answersPerMonth: 800, answerModelBudgetUsd: 150,
      sources: { kind: "all" }, locations: 3, seats: 20,
    },
    rhythm: "The full operating rhythm, per location",
    human: "Strategist 2 h/month plus a monthly call; 4-business-hour SLA",
    extras: ["Ads execution after approval (Phase 3)", "EU/UK data-residency addendum"],
  },
  {
    id: "pause",
    name: "Pause",
    who: "Seasonal businesses or a break",
    price: { monthly: { USD: 29, GBP: 22, AED: 109, AUD: 42 } },
    allowances: {
      studioCreditsPerMonth: 0, answersPerMonth: 10,
      sources: { kind: "read_only" }, locations: null, seats: null,
    },
    rhythm: "Weekly brief, review alerts",
    human: null,
    extras: [],
  },
];

export const PLAN_BY_ID: Readonly<Record<PlanId, Plan>> = Object.fromEntries(PLANS.map((p) => [p.id, p])) as Record<PlanId, Plan>;

// ---------- Allevia 90 (§3.3, §4.3) ----------

export interface Allevia90 {
  id: "allevia90";
  name: string;
  days: number;
  checkpointDays: readonly number[];             // Checkpoint{day} nodes
  reviewDays: readonly number[];                 // strategist reviews
  includesPlan: PlanId;                          // Growth-level allowances during the program
  upfront: Money;
  instalments: { count: number; each: Money };
  founding: { seats: number; upfront: Money; growthLockMonths: number; growthLocked: Money };
  guarantees: { refundDays: number; deliveryDay: number; renewalNoticeDays: number };
  afterProgram: { defaultPlan: PlanId; alternatives: readonly PlanId[] };
}

export const ALLEVIA_90: Allevia90 = {
  id: "allevia90",
  name: "Allevia 90",
  days: 90,
  checkpointDays: [0, 30, 60, 90],
  reviewDays: [0, 30, 90],
  includesPlan: "growth",
  upfront: { USD: 1490, GBP: 1129, AED: 5490, AUD: 2149 },
  instalments: { count: 3, each: { USD: 529, GBP: 399, AED: 1949, AUD: 769 } },
  // "Founding 20": the first 20 customers
  founding: {
    seats: 20,
    upfront: { USD: 990, GBP: 749, AED: 3649, AUD: 1429 },
    growthLockMonths: 12,
    growthLocked: { USD: 399, GBP: 299, AED: 1469, AUD: 579 },
  },
  // 14-day full refund; the day-30 delivery guarantee; the renewal notice goes out at least 14 days ahead
  guarantees: { refundDays: 14, deliveryDay: 30, renewalNoticeDays: 14 },
  afterProgram: { defaultPlan: "growth", alternatives: ["essentials", "pause"] },
};

// ---------- Studio credits (§4.2) ----------

// Credits per finished, approved output. Spent only on approval: a rejected draft costs the owner nothing.
export const CREDIT_COSTS = {
  static_post: 1,   // post, GBP post or story: 1 image, up to 3 variants, 2 free tweak rounds
  carousel: 2,      // up to 6 frames
  shoot: 3,         // project or product shoot: 4 angles from one phone photo
  reel: 4,          // up to 15 s, with script, cover and captions
  text: 0,          // answers, briefs, review replies, captions, emails, reports, analysis
} as const;
export type CreditOutput = keyof typeof CREDIT_COSTS;

export const CREDIT_RULES = {
  rolloverMonths: 1,         // unused credits roll over for 1 month, up to one month's allowance
  borrowFraction: 0.2,       // a task may borrow up to 20% of next month's credits
  topUp: { credits: 20, price: { USD: 59, GBP: 45, AED: 219, AUD: 85 } as Money },
} as const;
