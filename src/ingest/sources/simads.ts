// Simulated ads (spec §6.2): a business with no connected ad accounts still needs ad data to reason about, so this
// generates a deterministic, seeded stand-in. The simulated things are flagged simulated:true so answers can say
// "simulated": the snapshot Document, every Campaign and every Observation. Audiences and the ad Channels are real
// (a segment of the business, a real platform), so they stay unflagged and carry no src from here; the Channels only
// get status "not_connected" and dataSimulated true.
// Each profile has campaigns with realistic daily spend (INR), impressions, clicks, conversions, CTR and CPA, weekly
// seasonality and noise. Each campaign reports its natural conversion metric (signups or leads) and, for every
// campaign alike, a unified `conversions` (the same number); cpa = spend / conversions. Two stories are planted for the detectors to find: exactly one campaign has a CPA about twice
// the median, and a different one has a CTR drop in the last 7 days. Nothing in the graph says which.
import type { EdgeInput, NodeInput, ObservationInput } from "../../graph/upsert.js";
import type { SourceResult } from "../types.js";
import { entityId, sha256 } from "../../util/ids.js";
import { channelId, channelNode, type ChannelKey } from "./channels.js";

export type AdsProfile = "jobs-platform" | "architecture-studio";

export interface SimAdsOptions {
  tenantSlug: string;
  seed: number;
  days: number;       // length of the window
  endDate: string;    // last day of the window, YYYY-MM-DD (UTC)
  profile: AdsProfile;
}

// mulberry32: a tiny seeded PRNG. Floats in [0, 1).
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One independent stream per campaign, so adding a campaign never reshuffles the others.
function streamFor(seed: number, key: string): () => number {
  let h = (2166136261 ^ (seed >>> 0)) >>> 0;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619) >>> 0;
  return mulberry32(h);
}

// ~N(0,1) from four uniforms (Irwin-Hall): no log/cos, so the output is identical on every platform.
const gauss = (r: () => number): number => (r() + r() + r() + r() - 2) * 1.7320508075688772;
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const round = (x: number, dp: number): number => Math.round(x * 10 ** dp) / 10 ** dp;

type Week = [number, number, number, number, number, number, number]; // multipliers, Sunday first (Date.getUTCDay)

interface CampaignSpec {
  name: string;
  channel: Extract<ChannelKey, "meta-ads" | "google-ads">;
  audience: string;
  objective: string;
  conv: "signups" | "leads";
  buy: "cpm" | "cpc";   // what `price` is: INR per 1000 impressions, or INR per click
  spend: number;        // base INR a day
  price: number;
  ctr: number;          // click-through rate, a fraction
  cvr: number;          // click -> conversion, a fraction
  spendWeek: Week;
  cvrWeek: Week;
  ctrDrop?: boolean;    // CTR falls by about a third over the last 7 days
}

const FLAT: Week = [1, 1, 1, 1, 1, 1, 1];

const PROFILES: Record<AdsProfile, CampaignSpec[]> = {
  "jobs-platform": [
    {
      name: "Seekers — Raipur reels boost", channel: "meta-ads", audience: "Job seekers", objective: "App signups from job seekers in Raipur",
      conv: "signups", buy: "cpm", spend: 800, price: 80, ctr: 0.015, cvr: 0.08,
      spendWeek: [0.92, 1.06, 1.1, 1.08, 1.04, 0.96, 0.84], cvrWeek: [0.9, 1.12, 1.08, 1.04, 1.0, 0.96, 0.88], ctrDrop: true,
    },
    {
      name: "Employers — lead form", channel: "meta-ads", audience: "Employers", objective: "Employer leads through an Instagram lead form",
      conv: "leads", buy: "cpm", spend: 1500, price: 130, ctr: 0.01, cvr: 0.11,
      spendWeek: [0.55, 1.12, 1.15, 1.12, 1.08, 0.98, 0.6], cvrWeek: [0.7, 1.1, 1.1, 1.05, 1.0, 0.95, 0.75],
    },
    {
      name: "Google Search — jobs near me", channel: "google-ads", audience: "Job seekers", objective: "Signups from \"jobs near me\" searches",
      conv: "signups", buy: "cpc", spend: 1100, price: 11, ctr: 0.07, cvr: 0.105,
      spendWeek: [0.85, 1.08, 1.1, 1.06, 1.04, 1.0, 0.88], cvrWeek: [0.92, 1.08, 1.06, 1.02, 1.0, 0.97, 0.9],
    },
    {
      name: "YouTube Shorts — brand", channel: "google-ads", audience: "Job seekers", objective: "Brand awareness among job seekers on YouTube Shorts",
      conv: "signups", buy: "cpm", spend: 900, price: 45, ctr: 0.0045, cvr: 0.043,
      spendWeek: [1.12, 0.96, 0.95, 0.97, 1.0, 1.02, 1.1], cvrWeek: [1.05, 0.98, 0.98, 0.99, 1, 1, 1.02],
    },
  ],
  "architecture-studio": [
    {
      name: "Homeowners — Instagram portfolio", channel: "meta-ads", audience: "Homeowners", objective: "Project enquiries from homeowners who view the portfolio",
      conv: "leads", buy: "cpm", spend: 1100, price: 120, ctr: 0.012, cvr: 0.06,
      spendWeek: [1.1, 0.98, 0.96, 0.97, 1.0, 1.0, 1.08], cvrWeek: [1.05, 1.0, 0.98, 0.98, 1, 1, 1.04], ctrDrop: true,
    },
    {
      name: "Google Search — architect near me", channel: "google-ads", audience: "Homeowners", objective: "Enquiries from \"architect near me\" searches",
      conv: "leads", buy: "cpc", spend: 900, price: 22, ctr: 0.055, cvr: 0.115,
      spendWeek: [0.8, 1.08, 1.1, 1.08, 1.05, 0.98, 0.9], cvrWeek: [0.9, 1.08, 1.05, 1.02, 1, 0.97, 0.92],
    },
    {
      name: "Interior refresh — carousel", channel: "meta-ads", audience: "Homeowners", objective: "Interior refresh enquiries from a carousel ad",
      conv: "leads", buy: "cpm", spend: 1000, price: 95, ctr: 0.007, cvr: 0.033,
      spendWeek: FLAT, cvrWeek: FLAT,
    },
  ],
};

const DAY_MS = 86_400_000;

function windowDates(endDate: string, days: number): string[] {
  const end = Date.parse(`${endDate}T00:00:00Z`);
  return Array.from({ length: days }, (_, i) => new Date(end - (days - 1 - i) * DAY_MS).toISOString().slice(0, 10));
}

function validate(o: SimAdsOptions): CampaignSpec[] {
  const specs = PROFILES[o.profile];
  if (!specs) throw new Error(`simulateAds: unknown profile ${JSON.stringify(o.profile)}`);
  if (!Number.isInteger(o.days) || o.days < 1 || o.days > 366) throw new Error(`simulateAds: days must be an integer from 1 to 366, got ${o.days}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.endDate) || new Date(`${o.endDate}T00:00:00Z`).toISOString().slice(0, 10) !== o.endDate) {
    throw new Error(`simulateAds: endDate must be a calendar date like 2026-10-14, got ${JSON.stringify(o.endDate)}`);
  }
  if (!Number.isFinite(o.seed)) throw new Error(`simulateAds: seed must be a finite number, got ${o.seed}`);
  return specs;
}

export function simulateAds(opts: SimAdsOptions): SourceResult {
  const specs = validate(opts);
  const seed = Math.trunc(opts.seed) >>> 0;
  const dates = windowDates(opts.endDate, opts.days);
  const docId = entityId("Document", `simulated ads ${opts.tenantSlug}`);
  const asOf = opts.endDate;
  const prov = { src: docId, asOf };

  const nodes: NodeInput[] = [];
  const edges: EdgeInput[] = [];
  const observations: ObservationInput[] = [];
  const sourced = (id: string) => edges.push({ from: id, type: "SOURCED_FROM", to: docId, ...prov });

  nodes.push({
    type: "Document", id: docId, name: `Simulated ads (${opts.tenantSlug})`, asOf, simulated: true,
    summary: "Synthetic ad performance for a business with no connected ad accounts. Not real data.",
    props: {
      kind: "snapshot", title: `Simulated ads (${opts.tenantSlug})`, generator: "allevia-simads@1", profile: opts.profile, seed, days: opts.days,
      endDate: opts.endDate, hash: sha256(JSON.stringify({ tenant: opts.tenantSlug, profile: opts.profile, seed, days: opts.days, endDate: opts.endDate })),
    },
  });

  const channels = [...new Set(specs.map((s) => s.channel))];
  for (const key of channels) {
    nodes.push(channelNode(key, { props: { status: "not_connected", dataSimulated: true } }));
    sourced(channelId(key));
  }
  for (const name of [...new Set(specs.map((s) => s.audience))]) {
    const id = entityId("Audience", name);
    nodes.push({ type: "Audience", id, name, ...prov });
    sourced(id);
  }

  for (const s of specs) {
    const campaign = entityId("Campaign", s.name);
    const platform = s.channel === "meta-ads" ? "Meta" : "Google";
    nodes.push({
      type: "Campaign", id: campaign, name: s.name, simulated: true, ...prov,
      summary: `Simulated ${platform} campaign: ${s.objective}. No ad account is connected; every figure is generated.`,
      props: { objective: s.objective, status: "active", platform: platform.toLowerCase(), conversionMetric: s.conv, dailyBudgetInr: s.spend },
    });
    sourced(campaign);
    edges.push({ from: campaign, type: "PUBLISHED_ON", to: channelId(s.channel), props: { simulated: true }, ...prov });
    edges.push({ from: campaign, type: "TARGETS", to: entityId("Audience", s.audience), props: { simulated: true }, ...prov });

    const rng = streamFor(seed, s.name);
    dates.forEach((date, i) => {
      const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
      // Fixed number of draws a day, whatever the branch, so a longer window extends rather than reshuffles.
      const zSpend = gauss(rng), zPrice = gauss(rng), zCtr = gauss(rng), zCvr = gauss(rng), uConv = rng();

      const spend = clamp(Math.round(s.spend * s.spendWeek[dow]! * (1 + 0.06 * zSpend)), 300, 2500);
      const price = s.price * (1 + 0.07 * zPrice);
      const k = opts.days - 1 - i; // days before the end of the window
      const fatigue = s.ctrDrop && k < 7 ? 1 - 0.4 * Math.min(1, (7 - k) / 3) : 1;
      const ctr = s.ctr * (1 + 0.05 * zCtr) * fatigue;
      const cvr = s.cvr * s.cvrWeek[dow]! * (1 + 0.08 * zCvr);

      const impF = s.buy === "cpm" ? (spend / price) * 1000 : spend / price / ctr;
      const impressions = Math.max(2, Math.round(impF));
      const clicks = clamp(Math.round(impressions * ctr), 1, impressions);
      const conversions = clamp(Math.floor(clicks * cvr + uConv), 1, clicks); // stochastic rounding keeps the mean unbiased

      const day = (metric: string, value: number, unit: string) =>
        observations.push({ subject: campaign, metric, value, unit, windowStart: date, windowEnd: date, asOf: date, src: docId, simulated: true });
      day("spend", spend, "INR");
      day("impressions", impressions, "count");
      day("clicks", clicks, "count");
      day(s.conv, conversions, "count");
      day("conversions", conversions, "count");
      day("ctr", round((clicks / impressions) * 100, 3), "%");
      day("cpa", round(spend / conversions, 2), "INR");
    });
  }

  return { source: "simads", docs: [], write: { nodes, edges, observations }, skipped: [], redactions: {} };
}
