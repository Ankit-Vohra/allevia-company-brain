// The coffee demo's sample numbers, as pure functions of a day: orders by channel and payment method, the checkout funnel,
// refunds, website visits, Instagram reach, ad spend and results, and the error log. SAMPLE NUMBERS: nothing here is any real
// business's data. The seed (coffee.ts) writes them into the graph and the sample Shopify connection (connections.ts) answers
// from the same functions, so the two always agree.
//
// The story they tell (docs/demo-bluetokai.md):
//   - a new checkout release on Monday changes the payment step; from that day UPI payments time out far more often;
//   - the share of payment attempts that become orders falls, so online-store orders fall about 18%, while card orders hold,
//     website visits hold, and quick-commerce, subscriptions and wholesale hold (so it is the payment step, not demand);
//   - a Meta campaign for a new roast keeps spending at the same rate while its purchases fall: money wasted;
//   - the red herring: Instagram reach dipped about a quarter nine days BEFORE the release, and orders did not move then.
// Deterministic: every number is a function of the timeline and the day, through a small seeded generator.
import { addDays } from "../../insights/text.js";

export const DAY = 86_400_000;
const IST_MS = 5.5 * 3_600_000;

/** The calendar day in India (the business's own time zone) of an instant. */
export const istDay = (ms: number): string => new Date(ms + IST_MS).toISOString().slice(0, 10);
/** 0 Sunday … 6 Saturday, of a YYYY-MM-DD day. */
export const weekday = (day: string): number => new Date(`${day}T00:00:00Z`).getUTCDay();
const between = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
};

export interface CoffeeTimeline {
  now: number;              // when the seed ran (epoch ms)
  today: string;            // the business's today (IST), not complete yet
  lastDay: string;          // the last complete day: every series ends here
  releaseDay: string;       // the Monday the new checkout went out
  reachDipDay: string;      // the red herring: Instagram reach dipped from this day, nine days before the release
  firstDay: string;         // the first day of the eight weeks
  recentFrom: string;       // the detail series (funnel, payment mix, ads, errors) start here: the last four weeks
  days: string[];           // firstDay..lastDay
  weeks: Array<{ from: string; to: string }>; // seven-day windows ending on lastDay, oldest first
}

/**
 * The timeline for a seed run at `now`. The release is the latest Monday with at least three complete days after it (itself
 * included), so on a Wednesday to Sunday it is this week's Monday; on a Monday or Tuesday it is the Monday before.
 */
export function coffeeTimeline(now: number, weeks = 8): CoffeeTimeline {
  if (!Number.isFinite(now)) throw new Error("coffeeTimeline: now must be a time");
  if (!Number.isInteger(weeks) || weeks < 3 || weeks > 26) throw new Error("coffeeTimeline: weeks must be 3 to 26");
  const today = istDay(now);
  const lastDay = addDays(today, -1);
  let releaseDay = addDays(lastDay, -2);
  while (weekday(releaseDay) !== 1) releaseDay = addDays(releaseDay, -1);
  const firstDay = addDays(lastDay, -(weeks * 7 - 1));
  const out: CoffeeTimeline = {
    now, today, lastDay, releaseDay, reachDipDay: addDays(releaseDay, -9), firstDay, recentFrom: addDays(lastDay, -27),
    days: between(firstDay, lastDay), weeks: [],
  };
  for (let w = weeks - 1; w >= 0; w--) out.weeks.push({ from: addDays(lastDay, -(w * 7 + 6)), to: addDays(lastDay, -w * 7) });
  return out;
}

// A small deterministic generator per (series, day), so any one day can be regenerated on its own (the Shopify sample asks
// for single days) and adding a series never reshuffles another.
function rngFor(key: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619) >>> 0;
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const noise = (key: string, spread: number): number => 1 + (rngFor(key)() * 2 - 1) * spread;

// ---------- the online store, day by day ----------

export const PAYMENT_MIX = { upi: 0.62, card: 0.3, other: 0.08 } as const;   // share of payment attempts by method
export const SUCCESS = { upiBefore: 0.88, upiAfter: 0.59, card: 0.87, other: 0.85 } as const;
export const RETRY_WITH_CARD = 0.08;  // after the release, this share of failed UPI payers tries again with a card and gets through
export const AOV_INR = { online: 780, subscriptions: 650, quickCommerce: 520, wholesale: 14_000 } as const;

export interface StoreDay {
  day: string;
  released: boolean;          // on or after the release
  sessions: number;           // website visits (analytics)
  cartViewed: number;
  checkoutStarted: number;
  paymentAttempted: number;
  upiAttempts: number;
  upiFailed: number;
  upiFailurePct: number;
  ordersUpi: number;
  ordersCard: number;
  ordersOther: number;
  online: number;             // online-store orders
  subscriptions: number;      // subscription renewals
  quickCommerce: number;      // orders through the quick-commerce apps
  wholesale: number;          // wholesale orders (cafés and offices)
  total: number;
  revenueInr: number;
  refunds: number;            // refunds issued on the online store
  abandonedCheckouts: number; // started a checkout and did not finish
  checkoutCompletionPct: number;
}

const r0 = (x: number): number => Math.max(0, Math.round(x));
const r1 = (x: number): number => Math.round(x * 10) / 10;

export function storeDay(t: Pick<CoffeeTimeline, "releaseDay" | "firstDay">, day: string): StoreDay {
  const dow = weekday(day);
  const weekend = dow === 0 || dow === 6;
  const released = day >= t.releaseDay;
  // a slow climb over the eight weeks (about 0.3% a week), so the past is not flat
  const weeksIn = Math.max(0, Math.round((Date.parse(day) - Date.parse(t.firstDay)) / (7 * DAY)));
  const trend = 1 + 0.003 * weeksIn;
  const n = (series: string, spread = 0.04) => noise(`${series}|${day}`, spread);

  const sessions = r0(9_200 * (weekend ? 1.1 : 1) * trend * n("sessions", 0.05));
  const cartViewed = r0(700 * (weekend ? 1.08 : 1) * trend * n("cart"));
  const checkoutStarted = r0(cartViewed * 0.8 * n("started", 0.02));
  const paymentAttempted = r0(checkoutStarted * 0.82 * n("attempted", 0.02));
  const upiAttempts = r0(paymentAttempted * PAYMENT_MIX.upi);
  const cardAttempts = r0(paymentAttempted * PAYMENT_MIX.card);
  const otherAttempts = paymentAttempted - upiAttempts - cardAttempts;
  const upiSuccess = (released ? SUCCESS.upiAfter : SUCCESS.upiBefore) * n("upi-ok", 0.015);
  const ordersUpi = r0(upiAttempts * upiSuccess);
  const upiFailed = upiAttempts - ordersUpi;
  const retries = released ? r0(upiFailed * RETRY_WITH_CARD) : 0;
  const ordersCard = r0(cardAttempts * SUCCESS.card * n("card-ok", 0.015)) + retries;
  const ordersOther = r0(otherAttempts * SUCCESS.other * n("other-ok", 0.02));
  const online = ordersUpi + ordersCard + ordersOther;

  const subscriptions = r0(70 * trend * n("subs", 0.05));
  const quickCommerce = r0(180 * (weekend ? 1.15 : 1) * trend * n("quick", 0.05));
  const wholesale = r0((weekend ? 3 : 11) * n("wholesale", 0.15));
  const total = online + subscriptions + quickCommerce + wholesale;
  const revenueInr = r0(online * AOV_INR.online + subscriptions * AOV_INR.subscriptions + quickCommerce * AOV_INR.quickCommerce + wholesale * AOV_INR.wholesale);
  // refunds: about 1.5% of online orders; after the release, money taken for orders that never went through comes back too
  const refunds = r0(online * 0.015 * n("refunds", 0.2) + (released ? upiFailed * 0.06 : 0));
  return {
    day, released, sessions, cartViewed, checkoutStarted, paymentAttempted, upiAttempts, upiFailed,
    upiFailurePct: upiAttempts ? r1((upiFailed / upiAttempts) * 100) : 0,
    ordersUpi, ordersCard, ordersOther, online, subscriptions, quickCommerce, wholesale, total, revenueInr, refunds,
    abandonedCheckouts: Math.max(0, checkoutStarted - online),
    checkoutCompletionPct: checkoutStarted ? r1((online / checkoutStarted) * 100) : 0,
  };
}

// ---------- Instagram reach (the red herring) ----------

export interface ReachDay { day: string; reach: number; referredSessions: number }

export function reachDay(t: Pick<CoffeeTimeline, "reachDipDay">, day: string): ReachDay {
  const dipped = day >= t.reachDipDay;
  const dow = weekday(day);
  const base = 42_000 * (dow === 0 || dow === 6 ? 1.12 : 1) * (dipped ? 0.76 : 1);
  return {
    day,
    reach: r0(base * noise(`reach|${day}`, 0.06)),
    // visits to the website from Instagram: they dip with reach, and they are a small share of all visits
    referredSessions: r0((dipped ? 470 : 610) * noise(`ig-sessions|${day}`, 0.07)),
  };
}

// ---------- ads (sample campaigns) ----------

export interface CampaignSpec {
  key: string;
  name: string;
  platform: "meta" | "google";
  objective: string;
  spend: number;            // INR a day
  impressions: number;
  clicks: number;
  conversions: number;      // purchases a day before the release
  upiShare: number;         // how many of its buyers pay with UPI (the campaign that sends mobile shoppers is hit hardest)
  promotesNewRoast?: boolean;
}

export const CAMPAIGNS: readonly CampaignSpec[] = [
  { key: "meta-new-roast-launch", name: "Meta: new roast launch (sample campaign)", platform: "meta", objective: "Purchases of the new roast from Instagram and Facebook",
    spend: 26_000, impressions: 520_000, clicks: 5_200, conversions: 80, upiShare: 0.9, promotesNewRoast: true },
  { key: "google-search-brand", name: "Google Search: brand terms (sample campaign)", platform: "google", objective: "Purchases from searches for the brand",
    spend: 9_000, impressions: 60_000, clicks: 4_800, conversions: 60, upiShare: 0.55 },
  { key: "meta-subscription-retargeting", name: "Meta: subscription retargeting (sample campaign)", platform: "meta", objective: "Subscriptions from past buyers",
    spend: 6_000, impressions: 140_000, clicks: 1_700, conversions: 30, upiShare: 0.3 },
];

export interface AdDay { spend: number; impressions: number; clicks: number; conversions: number }

export function adDay(t: Pick<CoffeeTimeline, "releaseDay">, c: CampaignSpec, day: string): AdDay {
  const released = day >= t.releaseDay;
  // the payment step loses the same share of UPI payers whichever ad brought them
  const kept = released ? c.upiShare * (SUCCESS.upiAfter / SUCCESS.upiBefore) + (1 - c.upiShare) : 1;
  const n = (s: string, spread: number) => noise(`${c.key}|${s}|${day}`, spread);
  return {
    spend: r0(c.spend * n("spend", 0.04)),
    impressions: r0(c.impressions * n("impr", 0.05)),
    clicks: r0(c.clicks * n("clicks", 0.05)),
    conversions: r0(c.conversions * kept * n("conv", 0.06)),
  };
}

// ---------- the error log ----------

export interface IssueDay { events: number; users: number }

/** The new UPI timeout error: nothing before the release; after it, one event per failed attempt beyond the usual failures, plus retries. */
export function upiIssueDay(t: Pick<CoffeeTimeline, "releaseDay" | "firstDay">, day: string): IssueDay {
  if (day < t.releaseDay) return { events: 0, users: 0 };
  const s = storeDay(t, day);
  const extra = Math.max(0, s.upiFailed - r0(s.upiAttempts * (1 - SUCCESS.upiBefore)));
  return { users: extra, events: r0(extra * 2.3 * noise(`upi-issue|${day}`, 0.05)) };
}

/** An old, unrelated error (a product image that sometimes fails to load): steady, before and after. */
export const oldIssueDay = (day: string): IssueDay => ({ events: r0(22 * noise(`img-issue|${day}`, 0.2)), users: r0(15 * noise(`img-users|${day}`, 0.2)) });

// ---------- products, cities and wholesale accounts (weekly) ----------

/** How the week's units split across products: the first weights are the bestsellers. Sums to 1 over `n` products. */
export function productShares(n: number): number[] {
  const raw = Array.from({ length: n }, (_, i) => 1 / (i + 1.6));
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map((x) => x / sum);
}

export const CITIES: ReadonlyArray<{ key: string; name: string; share: number }> = [
  { key: "bengaluru", name: "Bengaluru", share: 0.24 },
  { key: "delhi-ncr", name: "Delhi NCR", share: 0.22 },
  { key: "mumbai", name: "Mumbai", share: 0.18 },
  { key: "pune", name: "Pune", share: 0.1 },
  { key: "hyderabad", name: "Hyderabad", share: 0.1 },
  { key: "other-cities", name: "other cities", share: 0.16 },
];

/** Wholesale accounts: made-up cafés and offices (no real business), with the kilograms a week each buys. */
export const WHOLESALE_ACCOUNTS: ReadonlyArray<{ key: string; name: string; kind: "café" | "office"; city: string; kgPerWeek: number }> = [
  { key: "lantern-lane-cafe", name: "Lantern Lane Café (sample account)", kind: "café", city: "Bengaluru", kgPerWeek: 14 },
  { key: "copperleaf-coworking", name: "Copperleaf Coworking (sample account)", kind: "office", city: "Pune", kgPerWeek: 9 },
  { key: "blue-door-bakehouse", name: "Blue Door Bakehouse (sample account)", kind: "café", city: "Mumbai", kgPerWeek: 11 },
  { key: "meridian-tech-park", name: "Meridian Tech Park pantry (sample account)", kind: "office", city: "Hyderabad", kgPerWeek: 18 },
];

export interface WeekTotals { from: string; to: string; online: number; units: number; byCity: Record<string, number> }

/** A seven-day window's online-store orders, the units sold across all channels but wholesale, and online orders by city. */
export function weekTotals(t: Pick<CoffeeTimeline, "releaseDay" | "firstDay">, w: { from: string; to: string }): WeekTotals {
  let online = 0, units = 0;
  for (const d of between(w.from, w.to)) {
    const s = storeDay(t, d);
    online += s.online;
    units += r0((s.online + s.subscriptions + s.quickCommerce) * 1.4); // about 1.4 bags an order
  }
  const byCity: Record<string, number> = {};
  for (const c of CITIES) byCity[c.key] = r0(online * c.share * noise(`city|${c.key}|${w.to}`, 0.03));
  return { from: w.from, to: w.to, online, units, byCity };
}

/** The sums the hero answer quotes: online orders on the release day and after, against the same days a week earlier. */
export function heroNumbers(t: CoffeeTimeline): { after: number; before: number; dropPct: number; days: number; spendAfter: number; purchasesAfter: number; purchasesBefore: number } {
  const after = between(t.releaseDay, t.lastDay);
  const before = after.map((d) => addDays(d, -7));
  const sum = (ds: string[]) => ds.reduce((a, d) => a + storeDay(t, d).online, 0);
  const a = sum(after), b = sum(before);
  const roast = CAMPAIGNS.find((c) => c.promotesNewRoast)!;
  return {
    after: a, before: b, dropPct: b ? Math.round((1 - a / b) * 1000) / 10 : 0, days: after.length,
    spendAfter: after.reduce((s, d) => s + adDay(t, roast, d).spend, 0),
    purchasesAfter: after.reduce((s, d) => s + adDay(t, roast, d).conversions, 0),
    purchasesBefore: before.reduce((s, d) => s + adDay(t, roast, d).conversions, 0),
  };
}
