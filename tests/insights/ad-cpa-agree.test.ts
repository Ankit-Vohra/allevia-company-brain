// The pause card (detectors.ts, ads.high_cpa) and the agents' ad_report tool both quote a campaign's cost per sign-up. They once
// disagreed on Blue Tokai's sample campaign "Meta: new roast launch": the card read the last 14 days (₹371 against a ₹208 median),
// the tool 30 days back from today (₹343.79 against ₹203.43), so the owner saw two figures for one campaign. Both now read the
// window in src/insights/ad-cpa.ts; this holds them to the same numbers, on the real sample campaigns of the coffee demo.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GraphHandle } from "../../src/graph/client.js";
import { closeAll } from "../../src/graph/client.js";
import { upsertNode, writeBatch, type ObservationInput } from "../../src/graph/upsert.js";
import { adReport } from "../../src/agent/tools/ads.js";
import { CAMPAIGNS, adDay, coffeeTimeline } from "../../src/demo/sample/coffee-model.js";
import { AD_WINDOW_DAYS, adWindow, cpaOf, medianCpa } from "../../src/insights/ad-cpa.js";
import { DETECTORS, type Candidate } from "../../src/insights/detectors.js";
import { testGraph } from "../helpers/graph.js";
import { call, makeCtx, whenFree } from "../helpers/tools.js";

const NOW = Date.parse("2026-10-17T06:00:00.000Z"); // Saturday morning in India: the last full day of the demo's numbers is Friday 16 Oct
const DAY = 86_400_000;
const HERO = "campaign:meta-new-roast-launch";
const SRC = "document:ads-export-sample";

let g: GraphHandle;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  ({ g, cleanup } = await whenFree(() => testGraph()));
  const t = coffeeTimeline(NOW);
  await upsertNode(g, { type: "Document", id: SRC, name: "Ad accounts export (sample numbers)", props: { kind: "snapshot", sample: true }, asOf: t.lastDay }, NOW);
  const observations: ObservationInput[] = [];
  for (const c of CAMPAIGNS) {
    const id = `campaign:${c.key}`;
    await upsertNode(g, { type: "Campaign", id, name: c.name, props: { status: "active", objective: c.objective, platform: c.platform, sample: true }, simulated: true, src: SRC, asOf: t.lastDay }, NOW);
    for (const day of t.days) {
      if (day < t.recentFrom) continue;
      const a = adDay(t, c, day);
      const base = { subject: id, windowStart: day, windowEnd: day, asOf: day, src: SRC, simulated: true };
      observations.push({ ...base, metric: "spend", value: a.spend, unit: "INR" }, { ...base, metric: "conversions", value: a.conversions, unit: "purchases" });
    }
  }
  const stats = await writeBatch(g, { observations }, NOW);
  expect(stats.errors).toEqual([]);
}, 120_000);

afterAll(async () => {
  await cleanup?.();
  await closeAll();
});

const cards = async (): Promise<Candidate[]> => DETECTORS["ads.high_cpa"].run(g, { now: NOW });
const report = async (args: Record<string, unknown> = {}, now = NOW) => (await call(adReport, args, makeCtx(g, { now }))).data;
type Row = { id: string; spend: number; signups: number; cpa: number; cpaVsMedian: number; flag?: string };
const row = (data: { campaigns: Row[] }, id: string): Row => {
  const r = data.campaigns.find((c) => c.id === id);
  if (!r) throw new Error(`ad_report has no ${id}`);
  return r;
};

describe("one definition of cost per sign-up (src/insights/ad-cpa.ts)", () => {
  it("the window is 30 days ending on the data's last day; a CPA needs spend and conversions; the median skips campaigns without one", () => {
    expect(AD_WINDOW_DAYS).toBe(30);
    expect(adWindow("2026-10-16")).toEqual({ from: "2026-09-17", to: "2026-10-16" });
    expect(adWindow("2026-10-16", 14)).toEqual({ from: "2026-10-03", to: "2026-10-16" });
    expect(cpaOf(300, 3)).toBe(100);
    expect([cpaOf(0, 5), cpaOf(300, 0), cpaOf(null, 5), cpaOf(300, undefined)]).toEqual([null, null, null, null]);
    expect(medianCpa([null, 300, 100, 200])).toBe(200);
    expect(medianCpa([null, null])).toBeNull();
  });
});

describe("the pause card and ad_report quote the same figures (Blue Tokai sample campaigns)", () => {
  it("the card for the new roast campaign says what the agents' tool says: CPA, median, spend, sign-ups and the window", async () => {
    const card = (await cards()).find((c) => c.key === `ads.high_cpa:${HERO}`);
    expect(card, "the new roast campaign is flagged").toBeDefined();
    const data = await report();
    const r = row(data, HERO);

    expect(card!.numbers).toMatchObject({ cpa: r.cpa, median_cpa: data.medianCpa, spend: r.spend, conversions: r.signups, multiple: r.cpaVsMedian });
    expect(r.flag).toBe("cpa_high");
    // the figures the demo video shows, over the whole sample window (28 days of numbers inside the 30-day window)
    expect(card!.numbers).toMatchObject({ cpa: 343.79, median_cpa: 203.43, spend: 728_137, conversions: 2_118, days: 28 });
    expect(data).toMatchObject({ days: 30, from: "2026-09-17", to: "2026-10-16" });
    expect(card!.title).toBe('Pause "Meta: new roast launch (sample campaign)" (simulated): CPA ₹344 vs ₹203 median');
    expect(card!.why).toContain("over 28 days to 16 Oct");
    expect(card!.suggestedAction!.payload.body).toContain("over 28 days to 16 Oct");
  });

  it("a campaign is flagged cpa_high by the tool exactly when the detector raises a card for it", async () => {
    const flagged = (await report()).campaigns.filter((c: Row) => c.flag === "cpa_high").map((c: Row) => `ads.high_cpa:${c.id}`).sort();
    expect((await cards()).map((c) => c.key).sort()).toEqual(flagged);
    expect(flagged).toEqual([`ads.high_cpa:${HERO}`]);
  });

  it("the window ends on the data's last day, not on today: stale numbers keep all their days in both", async () => {
    const later = NOW + 20 * DAY; // twenty days on, with no new numbers
    const data = await report({}, later);
    expect(data).toMatchObject({ from: "2026-09-17", to: "2026-10-16", medianCpa: 203.43 });
    expect(row(data, HERO)).toMatchObject({ spend: 728_137, signups: 2_118, cpa: 343.79 });
    const earlier = await report({ days: 14 }, later); // a shorter window is still counted back from the data's last day
    expect(earlier).toMatchObject({ days: 14, from: "2026-10-03", to: "2026-10-16" });
    expect(row(earlier, HERO).cpa).toBe(370.71); // the figure the card used to show
    expect(earlier.medianCpa).toBe(208.24);
  });

  it("a paused campaign still counts in the median, in the card and in the tool, and is not offered a pause", async () => {
    const google = `campaign:${CAMPAIGNS.find((c) => c.platform === "google")!.key}`;
    await upsertNode(g, { type: "Campaign", id: google, name: "Google Search: brand terms (sample campaign)", props: { status: "paused" } }, NOW + 1);
    const card = (await cards()).find((c) => c.key === `ads.high_cpa:${HERO}`);
    expect(card!.numbers.median_cpa).toBe((await report()).medianCpa);
    expect(card!.numbers.median_cpa).toBe(203.43);
    expect((await cards()).map((c) => c.evidence[0])).not.toContain(google);
  });
});
