import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { closeEdge } from "../../src/graph/upsert.js";
import { decideApproval } from "../../src/actions/approvals.js";
import type { LlmRunner, StructuredInput } from "../../src/ingest/llm.js";
import { insightApprovalId, insightRecId, relatedGoals, runInsights } from "../../src/insights/recommend.js";
import { sameFigures } from "../../src/insights/polish.js";
import { seedInsights, SEED_NOW } from "../fixtures/insights-graph.js";
import { testGraph } from "../helpers/graph.js";
import { whenFree } from "../helpers/tools.js";

let g: GraphHandle;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  ({ g, cleanup } = await whenFree(async () => {
    const t = await testGraph();
    try {
      await seedInsights(t.g);
    } catch (e) {
      await t.cleanup().catch(() => undefined);
      throw e;
    }
    return t;
  }));
});
afterAll(async () => {
  await cleanup?.();
  await closeAll();
});

const count = async (q: string, p: Record<string, unknown> = {}) => (await g.roQuery<{ c: number }>(q, p))[0]?.c ?? 0;
const recs = () => count("MATCH (r:Recommendation) WHERE r.source = 'insights' RETURN count(r) AS c");
const cards = () => count("MATCH (:Recommendation {source:'insights'})-[:PROPOSES]->(a:Approval) RETURN count(a) AS c");

describe("runInsights", () => {
  it("turns every candidate into a Recommendation PRODUCED by the right agent, with evidence, cards and goals", async () => {
    const r = await runInsights("test", { graph: g, now: SEED_NOW });
    expect(r.errors).toEqual([]);
    expect(r.recommendations).toHaveLength(r.candidates.length);
    expect(await recs()).toBe(r.candidates.length);
    expect(await cards()).toBe(r.candidates.filter((c) => c.suggestedAction).length);
    expect(r.recommendations.every((x) => x.created)).toBe(true);

    const by = async (key: string) => (await g.roQuery<{ agent: string }>(
      "MATCH (a:Agent)-[:PRODUCED]->(r:Recommendation {key:$key}) RETURN a.id AS agent", { key }))[0]?.agent;
    expect(await by("seo.high_severity_fails:page:www.aamdani.ai/jobs")).toBe("agent:allevia-tech-lead");
    expect(await by("seo.low_ctr:query:jobs-in-raipur")).toBe("agent:allevia-data-analyst");
    expect(await by("content.hook_outliers:rule:hook-curiosity-gap")).toBe("agent:allevia-content-strategist");
    expect(await by("funnel.biggest_drop:audience:job-seekers:signup_funnel")).toBe("agent:allevia-data-analyst");
    expect(await by("ads.high_cpa:campaign:meta-employers")).toBe("agent:allevia-growth-marketer");
    expect(await by("knowledge.stale_tasks:all")).toBe("agent:allevia-librarian");

    const cpa = insightRecId("ads.high_cpa:campaign:meta-employers");
    const [rec] = await g.roQuery<{ p: Record<string, unknown>; ev: string[]; card: string; payload: string; cstatus: string }>(
      `MATCH (r:Recommendation {id:$id})-[:EVIDENCED_BY]->(e) WITH r, collect(e.id) AS ev
       MATCH (r)-[:PROPOSES]->(a:Approval) RETURN properties(r) AS p, ev, a.id AS card, a.payload AS payload, a.status AS cstatus`, { id: cpa });
    expect(rec!.p).toMatchObject({ status: "open", area: "ads", by: "growth-marketer", simulated: true, kind: "pause_ad", name: 'Pause "Employers: hire in 24h" (simulated): CPA ₹300 vs ₹150 median' });
    expect(JSON.parse(String(rec!.p.numbers))).toMatchObject({ cpa: 300, median_cpa: 150 });
    expect(rec!.p.summary).toBe(rec!.p.whyTemplate); // no model: the template is the text
    expect(rec!.ev).toEqual(["campaign:meta-employers"]);
    expect(rec!.card).toBe(insightApprovalId("ads.high_cpa:campaign:meta-employers"));
    expect(rec!.cstatus).toBe("pending");
    expect(JSON.parse(rec!.payload)).toMatchObject({ title: "Pause Employers: hire in 24h", campaignId: "campaign:meta-employers" });

    // ADVANCES: the funnel finding moves the signups goal, the hook finding the followers goal, SEO neither
    const goals = async (key: string) => (await g.roQuery<{ id: string }>(
      "MATCH (:Recommendation {key:$key})-[:ADVANCES]->(gl:Goal) RETURN gl.id AS id ORDER BY id", { key })).map((x) => x.id);
    expect(await goals("funnel.biggest_drop:audience:job-seekers:signup_funnel")).toEqual(["goal:signups-per-day"]);
    expect(await goals("content.hook_outliers:rule:hook-curiosity-gap")).toEqual(["goal:instagram-followers"]);
    expect(await goals("seo.not_indexed:site")).toEqual([]);
  });

  it("is idempotent: a second run updates in place and adds nothing", async () => {
    const before = { recs: await recs(), cards: await cards(), ev: await count("MATCH (:Recommendation {source:'insights'})-[e:EVIDENCED_BY]->() RETURN count(e) AS c") };
    const r = await runInsights("test", { graph: g, now: SEED_NOW + 60_000 });
    expect(r.recommendations.some((x) => x.created || x.approvalCreated)).toBe(false);
    expect({ recs: await recs(), cards: await cards(), ev: await count("MATCH (:Recommendation {source:'insights'})-[e:EVIDENCED_BY]->() RETURN count(e) AS c") }).toEqual(before);
    expect(r.resolved).toEqual([]);
  });

  it("never reopens a decided card; resolves a finding that stopped firing", async () => {
    const key = "ads.high_cpa:campaign:meta-employers";
    await decideApproval(g, { approvalId: insightApprovalId(key), decision: "reject", now: SEED_NOW + 120_000 }, { tenant: "test" });
    await closeEdge(g, "page:www.aamdani.ai/jobs", "FAILS", "rule:seo-meta-description", SEED_NOW + 120_000);
    const r = await runInsights("test", { graph: g, now: SEED_NOW + 180_000 });
    const cpa = r.recommendations.find((x) => x.key === key)!;
    expect(cpa).toMatchObject({ approvalId: insightApprovalId(key), approvalCreated: false });
    expect(await count("MATCH (r:Recommendation {key:$key}) WHERE r.status = 'dismissed' RETURN count(r) AS c", { key })).toBe(1);
    expect(await count("MATCH (:Recommendation {key:$key})-[:PROPOSES]->(a) RETURN count(a) AS c", { key })).toBe(1);
    const fixed = insightRecId("seo.high_severity_fails:page:www.aamdani.ai/jobs");
    expect(r.resolved).toEqual([fixed]);
    expect(await count("MATCH (r:Recommendation {id:$id})-[:HAD_VERSION]->(v) WHERE r.status = 'resolved' RETURN count(v) AS c", { id: fixed })).toBe(1);
  });
});

describe("optional model polish", () => {
  const runner = (text: (prompt: string) => string): LlmRunner & { calls: StructuredInput[] } => {
    const calls: StructuredInput[] = [];
    return { calls, structured: async (i) => { calls.push(i); return { text: text(i.prompt) }; } };
  };

  it("keeps a reworded why only when its figures match the template's, and calls nothing when off", async () => {
    expect(sameFigures("CPA ₹300 vs ₹150 median, 2× [[campaign:x]]", "This costs ₹300 a lead, twice the ₹150 median [[campaign:x]]")).toBe(true);
    expect(sameFigures("CPA ₹300 vs ₹150 median", "CPA ₹320 vs ₹150 median")).toBe(false);
    expect(sameFigures("See [[campaign:x]]", "See it")).toBe(false);

    const { g: g2, cleanup: c2 } = await testGraph();
    try {
      await seedInsights(g2);
      const off = runner(() => "x");
      await runInsights("test", { graph: g2, now: SEED_NOW, runner: off, only: ["ads.high_cpa"] });
      expect(off.calls).toHaveLength(0);

      const good = runner((p) => `In short: ${p}`);
      const r = await runInsights("test", { graph: g2, now: SEED_NOW + 1, llm: true, runner: good, only: ["funnel.biggest_drop"] });
      expect(good.calls).toHaveLength(1);
      expect(good.calls[0]!.model).toBe("haiku");
      expect(r.polished).toBe(1);
      const id = insightRecId("funnel.biggest_drop:audience:job-seekers:signup_funnel");
      const [p] = await g2.roQuery<{ s: string; t: string }>("MATCH (r:Recommendation {id:$id}) RETURN r.summary AS s, r.whyTemplate AS t", { id });
      expect(p!.s).toBe(`In short: ${p!.t}`);
      // the template did not move, so the polished text stays and the model is not asked again
      await runInsights("test", { graph: g2, now: SEED_NOW + 2, llm: true, runner: good, only: ["funnel.biggest_drop"] });
      expect(good.calls).toHaveLength(1);

      const liar = runner(() => "Half the seekers, 9,999 of them, dropped.");
      const r2 = await runInsights("test", { graph: g2, now: SEED_NOW + 3, llm: true, runner: liar, only: ["seo.not_indexed"] });
      expect(r2.polished).toBe(0);
      const [q] = await g2.roQuery<{ s: string; t: string }>("MATCH (r:Recommendation {key:'seo.not_indexed:site'}) RETURN r.summary AS s, r.whyTemplate AS t");
      expect(q!.s).toBe(q!.t);
    } finally {
      await c2();
    }
  });
});

describe("relatedGoals", () => {
  const goals = [{ id: "goal:a", name: "A", metricKey: "signups" }, { id: "goal:b", name: "B", metricKey: "followers" }, { id: "goal:c", name: "C", metricKey: "gsc_clicks" }];
  it("prefers a goal on one of the finding's metrics, then one in its area", () => {
    expect(relatedGoals({ area: "seo", metrics: ["gsc_clicks"] }, goals).map((x) => x.id)).toEqual(["goal:c"]);
    expect(relatedGoals({ area: "content", metrics: ["views"] }, goals).map((x) => x.id)).toEqual(["goal:b"]);
    expect(relatedGoals({ area: "knowledge", metrics: [] }, goals)).toEqual([]);
  });
});
