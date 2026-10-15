import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { GraphHandle } from "../../../src/graph/client.js";
import { metricTrend, suggestMetrics, weekStart } from "../../../src/agent/tools/metrics.js";
import { aggregateFor } from "../../../src/agent/tools/observations.js";
import { call, ids, makeCtx, seededGraph } from "../../helpers/tools.js";

describe("metric_trend (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeAll(async () => ({ g, cleanup } = await seededGraph()), 60_000);
  afterAll(async () => cleanup());

  it("buckets and aggregates the right way", () => {
    expect(weekStart("2026-10-01")).toBe("2026-09-28");
    expect(weekStart("2026-10-05T10:00:00Z")).toBe("2026-10-05");
    expect(aggregateFor("signups", "count", [{ ws: "2026-10-01" }])).toBe("sum");
    expect(aggregateFor("followers", "count", [{ ws: null }])).toBe("last");
    expect(aggregateFor("ctr", null, [{ ws: "2026-10-01" }])).toBe("mean");
  });

  it("a series with first/last/min/max/delta/pct, observations and their documents as nodes", async () => {
    const r = await call(metricTrend, { metric: "followers", subject: "channel:instagram" }, makeCtx(g));
    expect(r.data.series.map((p: { value: number }) => p.value)).toEqual([1000, 1080, 1150, 1260, 1400]);
    expect(r.data.series[0].date).toBe("2026-09-07");
    expect(r.data.stats).toEqual({ points: 5, from: "2026-09-07", to: "2026-10-05", first: 1000, last: 1400, min: 1000, max: 1400, delta: 400, pctChange: 40 });
    expect(r.data.subject).toEqual({ id: "channel:instagram", type: "Channel", name: "Instagram" });
    expect(ids(r.nodes)).toEqual(expect.arrayContaining(["channel:instagram", "obs:followers:channel:instagram:2026-10-05", "document:ig-insights-oct"]));
    expect(r.nodes.find((n: { id: string }) => n.id === "document:ig-insights-oct")!.label).toBe("Document");
    expect(r.edges).toEqual(expect.arrayContaining([expect.objectContaining({ type: "MEASURES", to: "channel:instagram" })]));
    expect(ids(r.sources)).toContain("document:ig-insights-oct");
    expect(r.data.simulated).toBeUndefined();
  });

  it("from/to bound the range; groupBy week sums daily flows", async () => {
    const r = await call(metricTrend, { metric: "followers", subject: "channel:instagram", from: "2026-09-14", to: "2026-09-28" }, makeCtx(g));
    expect(r.data.stats).toMatchObject({ points: 3, first: 1080, last: 1260, delta: 180, pctChange: 16.7 });
    const dt = await call(metricTrend, { metric: "followers", subject: "channel:instagram", from: "2026-09-14T08:00:00Z", to: "2026-09-28T01:00:00Z" }, makeCtx(g));
    expect(dt.data.stats.points).toBe(3);
    const w = await call(metricTrend, { metric: "signups", subject: "business:aamdani", groupBy: "week" }, makeCtx(g));
    expect(w.data.series).toEqual([{ date: "2026-09-28", value: 26 }, { date: "2026-10-05", value: 69 }]);
    expect(w.data).toMatchObject({ groupBy: "week", aggregate: "sum" });
    expect(w.data.stats).toMatchObject({ delta: 43, pctChange: 165.4 });
  });

  it("without a subject: one summary per subject, simulated flagged", async () => {
    const r = await call(metricTrend, { metric: "signups" }, makeCtx(g));
    expect(r.data.bySubject.map((s: { id: string }) => s.id).sort()).toEqual(["business:aamdani", "campaign:meta-employers", "campaign:meta-retarget", "campaign:meta-seekers"]);
    expect(r.data.simulated).toBe(true);
    expect(r.note).toMatch(/simulated/);
    expect(r.note).toMatch(/4 subjects/);
  });

  it("an unknown metric lists the ones that exist", async () => {
    const r = await call(metricTrend, { metric: "revenue", subject: "channel:instagram" }, makeCtx(g));
    expect(r.data.error).toMatch(/No "revenue" observations for channel:instagram/);
    expect(r.data.error).toMatch(/followers, signups_from_reels/);
  });

  it("an unknown metric lists the names that share a word with it first", async () => {
    const r = await call(metricTrend, { metric: "reel", subject: "channel:instagram" }, makeCtx(g));
    expect(r.data.error).toMatch(/Metrics available \(closest first\): signups_from_reels, followers\./);
  });
});

// Eval 2026-10-15 (funnel-dropoff): the list was alphabetical and cut at 40, so on a tenant with 80+ metrics a question
// about "funnel" never saw signup_funnel_*, and the desk answered from a stale document instead.
describe("suggestMetrics", () => {
  const filler = Array.from({ length: 60 }, (_, i) => `a_metric_${String(i).padStart(2, "0")}`);
  const all = [...filler, "signup_funnel_activated", "signup_funnel_accounts_created", "signups", "gsc_clicks"];

  it("puts names that share a word (plural or not) first, then the rest alphabetically, and counts what was cut", () => {
    const s = suggestMetrics("funnel", all, 40);
    expect(s.shown.slice(0, 3)).toEqual(["signup_funnel_accounts_created", "signup_funnel_activated", "a_metric_00"]);
    expect(s.shown).toHaveLength(40);
    expect(s.more).toBe(24);
    expect(suggestMetrics("signups funnel", all).shown.slice(0, 3)).toEqual(["signup_funnel_accounts_created", "signup_funnel_activated", "signups"]);
    expect(suggestMetrics("search click", all).shown[0]).toBe("gsc_clicks");
  });

  it("is alphabetical when nothing is related, and short lists are not cut", () => {
    expect(suggestMetrics("revenue", ["b", "a"])).toEqual({ shown: ["a", "b"], related: 0, more: 0 });
  });
});
