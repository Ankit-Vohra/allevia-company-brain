import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { GraphHandle } from "../../../src/graph/client.js";
import { contentPerformance } from "../../../src/agent/tools/content.js";
import { seoReport } from "../../../src/agent/tools/seo.js";
import { adReport } from "../../../src/agent/tools/ads.js";
import { TouchedSet } from "../../../src/agent/tool.js";
import { call, ids, makeCtx, seededGraph } from "../../helpers/tools.js";

describe("content_performance, seo_report, ad_report (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeAll(async () => ({ g, cleanup } = await seededGraph()), 60_000);
  afterAll(async () => cleanup());

  it("content_performance: outlier multiple vs median views, hook and audience, latest snapshot", async () => {
    const r = await call(contentPerformance, { channel: "instagram", days: 60 }, makeCtx(g));
    expect(r.data).toMatchObject({ channel: "channel:instagram", viewMetric: "views", medianViews: 7500, considered: 4 });
    const top = r.data.items[0];
    expect(top).toMatchObject({
      id: "content:reel-salary-reveal", views: 48000, multiple: 6.4, publishedAt: "2026-09-05",
      hook: { id: "rule:hook-curiosity-gap", type: "Rule", name: "Curiosity gap hook" },
      audiences: [{ id: "audience:job-seekers", type: "Audience", name: "Job seekers in Raipur" }],
    });
    expect(top.metrics).toMatchObject({ views: 48000, shares: 900, saves: 1500, avg_watch_s: 11.2, skip_rate: 0.31 });
    expect(r.data.items.map((i: { id: string }) => i.id)).not.toContain("content:reel-old-hiring");
    expect(r.data.byHook).toEqual([
      { id: "rule:hook-curiosity-gap", type: "Rule", name: "Curiosity gap hook", items: 2, medianMultiple: 3.8 },
      { id: "rule:hook-listicle", type: "Rule", name: "Numbered list hook", items: 2, medianMultiple: 0.67 },
    ]);
    const types = new Set(r.edges.map((e: { type: string }) => e.type));
    for (const t of ["USES_RULE", "TARGETS", "MEASURES"]) expect(types.has(t)).toBe(true);
    expect(ids(r.nodes)).toEqual(expect.arrayContaining(["channel:instagram", "content:reel-salary-reveal", "obs:views:content:reel-salary-reveal:2026-10-10"]));
    expect(ids(r.sources)).toContain("document:ig-insights-oct");
    const all = await call(contentPerformance, {}, makeCtx(g));
    expect(all.data).toMatchObject({ medianViews: 6000, considered: 5 });
    expect(all.data.items[0].multiple).toBe(8);
  });

  it("seo_report: worst page first, with failed rules, numbers, low CTR and queries", async () => {
    const r = await call(seoReport, {}, makeCtx(g));
    expect(r.data.pages.map((p: { id: string }) => p.id)).toEqual(["page:www.aamdani.ai/jobs", "page:www.aamdani.ai", "page:www.aamdani.ai/blog/delivery-salary"]);
    const jobs = r.data.pages[0];
    expect(jobs.problems.map((p: { id: string; severity: string }) => [p.id, p.severity])).toEqual([["rule:seo-meta-description", "high"], ["rule:seo-h1", "medium"]]);
    expect(jobs.problems[0]).toMatchObject({ evidence: "no meta description", howToFix: expect.stringMatching(/meta description/) });
    expect(jobs.metrics).toEqual({ clicks: 120, impressions: 9000, ctrPct: 1.33, position: 14.2, sessions: 300 });
    expect(jobs.queries).toEqual([{ id: "query:jobs-in-raipur", text: "jobs in raipur", position: 12 }]);
    expect(jobs.url).toBe("https://www.aamdani.ai/jobs");
    expect(r.data.pages[1]).toMatchObject({ lowCtr: true, problems: [], metrics: { ctrPct: 0.4 } });
    expect(r.data.pages[2].metrics.ctrPct).toBe(2.67);
    expect(r.data.summary).toMatchObject({ pages: 3, pagesWithIssues: 3, failsBySeverity: { high: 1, medium: 2 }, lowCtrPages: 1 });
    expect(r.data.summary.topRules[0]).toMatchObject({ id: "rule:seo-h1", pages: 2 });
    const types = new Set(r.edges.map((e: { type: string }) => e.type));
    for (const t of ["FAILS", "RANKS_FOR", "MEASURES"]) expect(types.has(t)).toBe(true);
    expect(ids(r.sources)).toEqual(expect.arrayContaining(["document:gsc-oct", "document:seo-checklist"]));
    expect((await call(seoReport, { limit: 1 }, makeCtx(g))).data.pages).toHaveLength(1);
  });

  it("ad_report: totals, CPA vs median, and always the simulated note", async () => {
    const r = await call(adReport, {}, makeCtx(g));
    expect(r.note).toBe("Ad data is simulated");
    const by = Object.fromEntries(r.data.campaigns.map((c: { id: string }) => [c.id, c]));
    expect(by["campaign:meta-employers"]).toMatchObject({ spend: 3000, signups: 10, cpa: 300, cpaVsMedian: 2, flag: "cpa_high", ctrPct: 1, channel: "channel:meta-ads", simulated: true });
    expect(by["campaign:meta-seekers"]).toMatchObject({ spend: 2000, signups: 40, cpa: 50, flag: "cpa_low" });
    expect(by["campaign:meta-retarget"]).toMatchObject({ cpa: 150, cpaVsMedian: 1 });
    expect(by["campaign:meta-retarget"].flag).toBeUndefined();
    expect(r.data).toMatchObject({ medianCpa: 150, totals: { spend: 6500, signups: 60, cpa: 108.33, currency: "INR" }, simulated: true });
    expect(r.nodes.filter((n: { simulated?: boolean }) => n.simulated).length).toBeGreaterThan(3);
    expect(ids(r.nodes)).toContain("channel:meta-ads");
    expect(ids(r.sources)).toContain("document:meta-ads-sim");
    const touched = new TouchedSet();
    touched.add(r);
    expect(touched.anySimulated()).toBe(true);
    expect(touched.numbers().has("108.33")).toBe(true);
    // the window ends on the data's last day (13 Oct here, two days before the pinned clock), not on today
    expect(r.data).toMatchObject({ days: 30, from: "2026-09-14", to: "2026-10-13" });
    const recent = await call(adReport, { days: 2 }, makeCtx(g));
    expect(recent.data).toMatchObject({ from: "2026-10-12", to: "2026-10-13" });
    expect(recent.data.campaigns.find((c: { id: string }) => c.id === "campaign:meta-employers")).toMatchObject({ spend: 2000, signups: 7, cpa: 285.71 });
  });
});
