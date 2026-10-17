// Plans, credits and prices: the single source of truth for the pricing page, the allowance meter and billing.
// The ladder is the founder's choice of 17 October 2026 (docs/pricing-research.md section 4, issue #45): Starter $99, Growth $249,
// Pro $499 and Scale from $999, with Pause kept; Essentials is retired. Every paid plan can be paid yearly at 30% off.
// Allevia 90 and the Studio credits are from the product design spec (docs/superpowers/specs/2026-10-15-allevia-product-design.md
// §3.3, §4.2). Pure data and types: no Node or DOM imports, so the backend and the web app can both read it. Amounts are whole
// units of the currency (249 is $249, not cents), before tax.

export const CURRENCIES = ["USD", "GBP", "AED", "AUD"] as const;
export type Currency = (typeof CURRENCIES)[number];
export type Money = Record<Currency, number>;

export const isCurrency = (s: string): s is Currency => (CURRENCIES as readonly string[]).includes(s);

export type PlanId = "starter" | "growth" | "pro" | "scale" | "pause";

// What a plan gates: credits, seats, locations and human time. Every plan has every agent in every department of
// shared/roster.ts, the company brain, every connection and every service: credits are one pool, and each service costs
// credits in line with what it costs us (CREDIT_PRICES), so any mix of use keeps the margin (the founder, 17 October 2026).
export interface PlanAllowances {
  creditsPerMonth: number;                       // one pool for questions, drafts, check-ups, pictures and video
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
  fromPrice?: boolean;                           // Scale: "from $999", quoted after a call
  who: string;
  /** monthly: paid each month. yearly: the year's total when paid yearly (30% off; see ANNUAL_DISCOUNT). */
  price: { monthly: Money; yearly?: Money };
  allowances: PlanAllowances;
  rhythm: string;
  human: string | null;
  extras: string[];
}

/** Paying for a year takes this much off every month (the founder, 17 October 2026). */
export const ANNUAL_DISCOUNT = 0.3;

const mapMoney = (m: Money, f: (n: number) => number): Money => ({ USD: f(m.USD), GBP: f(m.GBP), AED: f(m.AED), AUD: f(m.AUD) });

/** What a month costs when the year is paid up front: 30% off, rounded to a whole unit. */
export const yearlyMonthly = (monthly: Money): Money => mapMoney(monthly, (n) => Math.round(n * (1 - ANNUAL_DISCOUNT)));

/** The year's total, paid up front: twelve of the yearly monthly price. */
export const yearly = (monthly: Money): Money => mapMoney(yearlyMonthly(monthly), (n) => n * 12);

const paid = (monthly: Money) => ({ monthly, yearly: yearly(monthly) });

export const PLANS: readonly Plan[] = [
  {
    id: "starter",
    name: "Starter",
    who: "Owners who want their tools working together, with advice and follow-ups",
    price: paid({ USD: 99, GBP: 75, AED: 369, AUD: 145 }),
    allowances: {
      creditsPerMonth: 300, answerModelBudgetUsd: 30,
      sources: { kind: "all" }, locations: 1, seats: 2,
    },
    rhythm: "Today's note, the website check-up each month, the growth plan",
    human: "An optional 20-minute call to connect your tools",
    extras: [],
  },
  {
    id: "growth",
    name: "Growth",
    isDefault: true,
    who: "Owners who want the whole team busy every week",
    price: paid({ USD: 249, GBP: 189, AED: 919, AUD: 359 }),
    allowances: {
      creditsPerMonth: 800, answerModelBudgetUsd: 60,
      sources: { kind: "all" }, locations: 1, seats: 5,
    },
    rhythm: "Everything in Starter, plus a monthly report",
    human: "A 45-minute setup call",
    extras: ["WhatsApp delivery (Phase 2)"],
  },
  {
    id: "pro",
    name: "Pro",
    who: "More places, more content and a person on our side",
    price: paid({ USD: 499, GBP: 379, AED: 1839, AUD: 719 }),
    allowances: {
      creditsPerMonth: 2000, answerModelBudgetUsd: 110,
      sources: { kind: "all" }, locations: 3, seats: 15,
    },
    rhythm: "The full operating rhythm, per location",
    human: "A strategist 1 h a month plus a monthly call; a 4-business-hour response",
    extras: ["Ads execution after approval (Phase 3)", "EU/UK data-residency addendum"],
  },
  {
    id: "scale",
    name: "Scale",
    fromPrice: true,
    who: "Many locations, regulated work, or run it with us",
    price: paid({ USD: 999, GBP: 749, AED: 3669, AUD: 1449 }),
    allowances: {
      creditsPerMonth: 4000, answerModelBudgetUsd: 200,
      sources: { kind: "all" }, locations: 5, seats: 25,
    },
    rhythm: "The full operating rhythm, per location",
    human: "A named person; a strategist 2 h a month",
    extras: ["Quoted after a call"],
  },
  {
    id: "pause",
    name: "Pause",
    who: "Seasonal businesses or a break",
    price: { monthly: { USD: 29, GBP: 22, AED: 109, AUD: 42 } },
    allowances: {
      creditsPerMonth: 20,
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
    growthLocked: { USD: 199, GBP: 149, AED: 729, AUD: 289 },      // Growth at $199 for the first 20 (research 4.2; the founder to confirm, #45)
  },
  // 14-day full refund; the day-30 delivery guarantee; the renewal notice goes out at least 14 days ahead
  guarantees: { refundDays: 14, deliveryDay: 30, renewalNoticeDays: 14 },
  afterProgram: { defaultPlan: "growth", alternatives: ["starter", "pause"] },
};

// ---------- Credits: one pool, priced by what each service costs us ----------

// One credit is about $0.10 of what the work costs us to make (model, pictures, data), so the price list below keeps every
// plan's margin whatever the owner spends credits on. The owner's rule in plain words: you only spend credits on what you
// ask for or approve; what the team does on its own (Today's note, the stand-up, the monthly check-up) is free.
export type CreditService =
  | "question_quick" | "question_deep" | "draft_text" | "meeting_book" | "website_checkup" | "public_data"
  | "picture" | "carousel" | "photo_ad" | "product_shoot" | "video_short" | "todays_note" | "snapshot";

/** When a service is charged: when the answer arrives, when the owner says OK, when the owner runs it, or never. */
export type CreditCharge = "answered" | "approved" | "run" | "never";

export const CREDIT_PRICES: Readonly<Record<CreditService, { credits: number; label: string; charged: CreditCharge }>> = {
  question_quick: { credits: 1, label: "Quick question", charged: "answered" },
  question_deep: { credits: 5, label: "Deep question (the whole team looks into it)", charged: "answered" },
  draft_text: { credits: 1, label: "Email, reply or caption", charged: "approved" },
  meeting_book: { credits: 1, label: "Book a meeting", charged: "approved" },
  website_checkup: { credits: 10, label: "Website check-up", charged: "run" },
  public_data: { credits: 5, label: "Rivals and public data", charged: "run" },
  picture: { credits: 5, label: "Picture or post", charged: "approved" },
  carousel: { credits: 10, label: "Carousel (up to 6 frames)", charged: "approved" },
  photo_ad: { credits: 15, label: "Photo to premium ad", charged: "approved" },
  product_shoot: { credits: 15, label: "Product shoot (4 angles from one photo)", charged: "approved" },
  video_short: { credits: 40, label: "Short video (15 s)", charged: "approved" },
  todays_note: { credits: 0, label: "Today's note", charged: "never" },
  snapshot: { credits: 0, label: "Brain Snapshot", charged: "never" },
};

/** The Studio's outputs in the shared pool (kept for the Studio code that charges on approval). */
export const CREDIT_COSTS = {
  static_post: CREDIT_PRICES.picture.credits,        // post, GBP post or story: 1 image, up to 3 variants, 2 free tweak rounds
  carousel: CREDIT_PRICES.carousel.credits,          // up to 6 frames
  shoot: CREDIT_PRICES.product_shoot.credits,        // project or product shoot: 4 angles from one phone photo
  reel: CREDIT_PRICES.video_short.credits,           // up to 15 s, with script, cover and captions
  text: 0,                                           // the text itself is charged as draft_text when approved
} as const;
export type CreditOutput = keyof typeof CREDIT_COSTS;

/** Credits bought on top of a plan. They never expire while the business has a plan. */
export const CREDIT_PACKS: readonly { id: string; credits: number; price: Money }[] = [
  { id: "pack100", credits: 100, price: { USD: 29, GBP: 22, AED: 109, AUD: 42 } },
];

export const CREDIT_RULES = {
  rolloverMonths: 1,         // unused plan credits roll over for 1 month, up to one month's allowance
} as const;

/** A new sign-up starts with these, before choosing a plan. */
export const TRIAL = { credits: 100, days: 14 } as const;
