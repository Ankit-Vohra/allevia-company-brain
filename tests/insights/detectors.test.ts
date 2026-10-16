import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GraphHandle } from "../../src/graph/client.js";
import { closeAll } from "../../src/graph/client.js";
import { addObservation } from "../../src/graph/upsert.js";
import { DETECTORS, runDetectors, type Candidate, type DetectorName } from "../../src/insights/detectors.js";
import { SEED_NOW } from "../fixtures/insights-graph.js";
import { graphFrom } from "../helpers/templates.js";
import { whenFree } from "../helpers/tools.js";

let g: GraphHandle;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  ({ g, cleanup } = await whenFree(() => graphFrom("insights")));
});

afterAll(async () => {
  await cleanup?.();
  await closeAll();
});

const opts = () => ({ now: SEED_NOW });
const run = (name: DetectorName): Promise<Candidate[]> => DETECTORS[name].run(g, opts());
const byKey = (cs: Candidate[], key: string): Candidate => {
  const c = cs.find((x) => x.key === key);
  if (!c) throw new Error(`no candidate ${key}; got ${cs.map((x) => x.key).join(", ")}`);
  return c;
};

describe("seo detectors", () => {
  it("pages failing high-severity rules, with their traffic and a GitHub issue to fix them", async () => {
    const cs = await run("seo.high_severity_fails");
    expect(cs.map((c) => c.key)).toEqual(["seo.high_severity_fails:page:www.aamdani.ai/jobs"]);
    const c = cs[0]!;
    expect(c.area).toBe("seo");
    expect(c.evidence).toEqual(expect.arrayContaining(["page:www.aamdani.ai/jobs", "rule:seo-meta-description"]));
    expect(c.evidence).not.toContain("rule:seo-h1"); // medium severity
    expect(c.numbers).toMatchObject({ failing: 1, impressions: 9000, clicks: 120 });
    expect(c.title).toBe("Fix 1 high-severity SEO issue on jobs page");
    expect(c.why).toContain("9,000 impressions");
    expect(c.suggestedAction).toMatchObject({ kind: "github_issue", payload: { targetId: "page:www.aamdani.ai/jobs" } });
    expect(c.suggestedAction!.payload.body).toContain("meta description");
  });

  it("queries and pages with impressions but CTR under 1%, in both metric spellings", async () => {
    const cs = await run("seo.low_ctr");
    expect(cs.map((c) => c.key)).toEqual(["seo.low_ctr:page:www.aamdani.ai", "seo.low_ctr:query:jobs-in-raipur"]);
    expect(byKey(cs, "seo.low_ctr:page:www.aamdani.ai").numbers).toMatchObject({ impressions: 5000, clicks: 20, ctr_pct: 0.4 });
    const q = byKey(cs, "seo.low_ctr:query:jobs-in-raipur");
    expect(q.numbers).toMatchObject({ impressions: 4000, clicks: 12, ctr_pct: 0.3, position: 18.4 });
    expect(q.title).toBe('"jobs in raipur": 4,000 impressions, 0.3% CTR');
    expect(q.suggestedAction?.payload.targetId).toBe("page:www.aamdani.ai/jobs"); // the page that ranks for it
    expect(q.evidence).toEqual(expect.arrayContaining(["query:jobs-in-raipur", "page:www.aamdani.ai/jobs"]));
  });

  it("pages that are not indexed", async () => {
    const cs = await run("seo.not_indexed");
    expect(cs).toHaveLength(1);
    expect(cs[0]!.evidence).toEqual(["page:www.aamdani.ai/employers"]);
    expect(cs[0]!.numbers).toMatchObject({ pages: 1 });
    expect(cs[0]!.why).toContain("employers page (Crawled - currently not indexed)");
  });

  it("sitemap errors and sitemap URLs Google has not indexed", async () => {
    const cs = await run("seo.sitemap");
    expect(cs.map((c) => c.key)).toEqual(["seo.sitemap:channel:website"]);
    expect(cs[0]!.numbers).toMatchObject({ submitted: 112, indexed: 40, not_indexed: 72, errors: 3 });
    expect(cs[0]!.title).toBe("Sitemap: 72 of 112 URLs not indexed, 3 errors");
    // Search Console's deprecated `indexed` field reads 0: unknown, not a finding.
    for (const [metric, value] of [["gsc_sitemap_submitted_urls", 42], ["gsc_sitemap_indexed_urls", 0]] as const) {
      await addObservation(g, { subject: "channel:google-search", metric, value, asOf: "2026-10-14", src: "document:gsc-sitemaps" }, SEED_NOW);
    }
    expect((await run("seo.sitemap")).map((c) => c.key)).toEqual(["seo.sitemap:channel:website"]);
  });
});

describe("content detectors", () => {
  it("hook formulas whose posts run at 2× the median or more", async () => {
    const cs = await run("content.hook_outliers");
    expect(cs.map((c) => c.key)).toEqual(["content.hook_outliers:rule:hook-curiosity-gap"]);
    const c = cs[0]!;
    expect(c.numbers).toMatchObject({ multiple: 4.75, posts: 2, median_views: 6000, best_views: 48000 });
    expect(c.evidence).toEqual(expect.arrayContaining(["rule:hook-curiosity-gap", "content:reel-salary-reveal", "content:reel-store-manager"]));
    expect(c.title).toBe('Use the "Curiosity gap hook" more: 4.8× the median reel');
    expect(c.suggestedAction).toMatchObject({ kind: "content_draft", payload: { format: "reel", channelId: "channel:instagram", targetId: "rule:hook-curiosity-gap" } });
  });

  it("single posts at 2× their format's median when no hook is on record", async () => {
    const cs = await run("content.post_outliers");
    expect(cs.map((c) => c.key)).toEqual(["content.post_outliers:content:short-first-salary"]);
    expect(cs[0]!.numbers).toMatchObject({ views: 2400, median_views: 600, multiple: 4 });
    expect(cs[0]!.suggestedAction?.kind).toBe("content_draft");
  });

  it("underperforming hooks and formats", async () => {
    const cs = await run("content.underperforming");
    expect(cs.map((c) => c.key).sort()).toEqual([
      "content.underperforming:format:channel:instagram:story", "content.underperforming:hook:rule:hook-listicle",
    ]);
    expect(byKey(cs, "content.underperforming:hook:rule:hook-listicle").numbers).toMatchObject({ multiple: 0.67, posts: 3 });
    const f = byKey(cs, "content.underperforming:format:channel:instagram:story");
    expect(f.numbers).toMatchObject({ median_views: 350, best_median_views: 6000, multiple: 0.06 });
    expect(f.title).toBe("Instagram stories get 0.06× the views of reels");
  });

  it("posting gaps per channel", async () => {
    const cs = await run("content.posting_gap");
    expect(cs.map((c) => c.key)).toEqual(["content.posting_gap:channel:instagram"]);
    expect(cs[0]!.numbers).toMatchObject({ days: 19 });
    expect(cs[0]!.title).toBe("No Instagram post in 19 days");
    expect(cs[0]!.suggestedAction).toMatchObject({ kind: "content_draft", payload: { channelId: "channel:instagram", format: "reel" } });
  });
});

describe("funnel detector", () => {
  it("finds the biggest drop-off step", async () => {
    const cs = await run("funnel.biggest_drop");
    expect(cs).toHaveLength(1);
    const c = cs[0]!;
    expect(c.key).toBe("funnel.biggest_drop:audience:job-seekers:signup_funnel");
    expect(c.numbers).toMatchObject({ from_users: 820, to_users: 410, drop_pct: 50, lost: 410, top_users: 1000, bottom_users: 300 });
    expect(c.title).toBe("Job seekers in Raipur sign-up: 50% drop from sign-up code verified to setup completed");
    expect(c.evidence).toHaveLength(3); // the audience and the two step observations
  });
});

describe("ads detectors (simulated)", () => {
  it("campaigns with CPA at 1.5× the account median or more, labelled simulated", async () => {
    const cs = await run("ads.high_cpa");
    expect(cs.map((c) => c.key)).toEqual(["ads.high_cpa:campaign:meta-employers"]);
    const c = cs[0]!;
    expect(c.simulated).toBe(true);
    expect(c.numbers).toMatchObject({ cpa: 300, median_cpa: 150, multiple: 2, spend: 3000, conversions: 10 });
    expect(c.title).toBe('Pause "Employers: hire in 24h" (simulated): CPA ₹300 vs ₹150 median');
    expect(c.suggestedAction).toMatchObject({ kind: "pause_ad", payload: { campaignId: "campaign:meta-employers" } });
  });

  it("week-on-week CTR drops", async () => {
    const cs = await run("ads.ctr_drop");
    expect(cs.map((c) => c.key)).toEqual(["ads.ctr_drop:campaign:meta-carousel"]);
    expect(cs[0]!.numbers).toMatchObject({ ctr_before_pct: 2, ctr_after_pct: 1, drop_pct: 50 });
    expect(cs[0]!.simulated).toBe(true);
  });
});

describe("knowledge detectors", () => {
  it("orphan documents", async () => {
    const cs = await run("knowledge.orphan_docs");
    expect(cs).toHaveLength(1);
    expect(cs[0]!.evidence.sort()).toEqual(["document:hook-playbook", "document:seo-checklist"]);
    expect(cs[0]!.numbers).toMatchObject({ docs: 2 });
  });

  it("stale pending tasks", async () => {
    const cs = await run("knowledge.stale_tasks");
    expect(cs).toHaveLength(1);
    expect(cs[0]!.evidence.sort()).toEqual(["task:fix-sitemap", "task:schedule-reels"]);
    expect(cs[0]!.numbers).toMatchObject({ tasks: 2, oldest_days: 75 });
    expect(cs[0]!.suggestedAction?.kind).toBe("discord_post");
  });

  it("decisions with no evidence (superseded ones excluded)", async () => {
    const cs = await run("knowledge.unevidenced_decisions");
    expect(cs).toHaveLength(1);
    expect(cs[0]!.evidence).toEqual(["decision:009-whatsapp-replies"]);
  });
});

describe("runDetectors", () => {
  it("runs every detector read-only, with unique keys and numbers that are all finite", async () => {
    const readOnly = { name: g.name, roQuery: g.roQuery.bind(g), query: () => { throw new Error("detectors must not write"); } } as unknown as GraphHandle;
    const r = await runDetectors(readOnly, opts());
    expect(r.errors).toEqual([]);
    expect(r.ran.sort()).toEqual(Object.keys(DETECTORS).sort());
    const keys = r.candidates.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(r.candidates.length).toBeGreaterThanOrEqual(15);
    for (const c of r.candidates) {
      expect(c.evidence.length).toBeGreaterThan(0);
      for (const v of Object.values(c.numbers)) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it("reports a failing detector without losing the others", async () => {
    const broken = { name: g.name, roQuery: async (q: string, p?: Record<string, unknown>) => {
      if (q.includes(":Campaign")) throw new Error("boom");
      return g.roQuery(q, p);
    } } as unknown as GraphHandle;
    const r = await runDetectors(broken, { ...opts(), only: ["ads.high_cpa", "seo.not_indexed"] });
    expect(r.errors.map((e) => e.detector)).toEqual(["ads.high_cpa"]);
    expect(r.ran).toEqual(["seo.not_indexed"]);
    expect(r.candidates).toHaveLength(1);
  });
});
