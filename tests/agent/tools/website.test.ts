// The website check-up tools on a throwaway graph: nothing stored yet is said plainly; a stored check-up comes back as
// the verdict, the scores and the top fixes with progress since the run before; the AI visibility runs come back with
// the honest note; keyword_ideas is off without DataForSEO and stays inside the budget with it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GraphHandle } from "../../../src/graph/client.js";
import { upsertNode, writeBatch } from "../../../src/graph/upsert.js";
import { aiVisibility, keywordIdeas, websiteCheckup } from "../../../src/agent/tools/website.js";
import { buildVerdict } from "../../../src/checkup/fixes.js";
import { saveCheckup } from "../../../src/checkup/run.js";
import { aiVisibilityWrite, HONEST_NOTE } from "../../../src/checkup/ai-visibility.js";
import type { DfsFetch } from "../../../src/checkup/dataforseo.js";
import type { LighthouseResult } from "../../../src/checkup/lighthouse.js";
import { testGraph } from "../../helpers/graph.js";
import { call, makeCtx } from "../../helpers/tools.js";

const O = "https://shree.example";
const lh = (perf: number): LighthouseResult => ({ url: `${O}/`, strategy: "mobile", scores: { performance: perf, accessibility: 92, seo: 90 }, metrics: { lcpMs: 4100 }, issues: [] });
const checkupRun = (asOf: string, perf: number, offer: boolean) => ({
  origin: O, asOf, lighthouse: [lh(perf)], pagesChecked: [`${O}/`], conversionPages: [`${O}/`], notes: [],
  verdict: buildVerdict({
    site: { origin: O, homeOk: true, https: true, sitemapFound: true, aiCrawlersBlocked: [] }, kind: "local", lighthouse: [lh(perf)],
    conversion: [{ check: "contact-above-fold-mobile", pass: false, page: `${O}/`, evidence: "no button" }, { check: "clear-offer", pass: offer, page: `${O}/`, evidence: "Welcome" }],
  }),
});

describe("website tools", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await upsertNode(g, { type: "Business", id: "business:shree", name: "Shree Interiors", props: { country: "IN" } }, Date.now());
  });
  afterAll(async () => { await cleanup(); });

  it("says plainly when nothing has been checked yet", async () => {
    const r = await call(websiteCheckup, {}, makeCtx(g));
    expect(r.data.found).toBe(false);
    expect((await call(aiVisibility, {}, makeCtx(g))).data.found).toBe(false);
  });

  it("returns the latest check-up's top fixes in owner words, with progress and the report as the source", async () => {
    await saveCheckup(g, checkupRun("2026-10-01T10:00:00Z", 41, false), Date.parse("2026-10-01T10:00:00Z"));
    const second = await saveCheckup(g, checkupRun("2026-10-15T10:00:00Z", 78, true), Date.parse("2026-10-15T10:00:00Z"));
    const r = await call(websiteCheckup, { all: true }, makeCtx(g));
    expect(r.data.found).toBe(true);
    expect(r.data.verdict).toMatch(/losing enquiries/);
    expect(r.data.topFixes[0]).toMatchObject({ rank: 1, title: "Put a call or WhatsApp button on the first screen on phones", effort: "about 30 minutes", where: ["/"] });
    expect(r.data.scores["speed on phones"]).toBe(78);
    expect(r.data.sinceLastCheckup).toEqual(expect.arrayContaining(["Your mobile speed went from 41 to 78.", "Fixed since the last check-up: Say what you do in the first line of the home page."]));
    expect(r.data.showHow.evidence["contact-above-fold-mobile"]).toEqual(["no button"]);
    expect(r.nodes.map((n: { id: string }) => n.id)).toContain(second.docId);
  });

  it("returns AI visibility with the honest note", async () => {
    const run = {
      asOf: "2026-10-15T09:00:00Z", model: "sonnet", business: { name: "Shree Interiors", category: "interior designer", city: "Raipur" }, asked: 2, answered: 2, mentioned: 0, mentionPct: 0,
      answers: [0, 1].map((i) => ({ question: `q${i}`, answered: true, answer: "a", named: ["Studio Tara"], mentioned: false, cited: false, position: null, others: ["Studio Tara"] })),
    };
    await writeBatch(g, aiVisibilityWrite(run, "business:shree"), Date.now());
    const r = await call(aiVisibility, {}, makeCtx(g));
    expect(r.data).toMatchObject({ found: true, namedInPercentOfAnswers: 0, namedInstead: [{ name: "Studio Tara", answers: 2 }], honestNote: HONEST_NOTE });
  });

  it("keyword_ideas is off without DataForSEO and spends nothing", async () => {
    const r = await call(keywordIdeas, { seeds: ["interior designer raipur"] }, { ...makeCtx(g), website: { dfsConfig: { credentials: null, monthlyBudgetUsd: 1 } } } as never);
    expect(r.data.configured).toBe(false);
    expect(r.data.why).toMatch(/off/);
  });

  it("keyword_ideas asks within the budget and records the cost; over budget it does not call", async () => {
    let calls = 0;
    const fetch: DfsFetch = async () => {
      calls++;
      return { status: 200, json: async () => ({ tasks: [{ status_code: 20000, cost: 0.0144, result: [{ items: [{ keyword: "interior designer raipur", keyword_info: { search_volume: 880 } }] }] }] }) };
    };
    const ctx = (budget: number) => ({ ...makeCtx(g, { tenant: "shree" }), website: { dfsConfig: { credentials: { login: "l", password: "p" }, monthlyBudgetUsd: budget }, dfsFetch: fetch } }) as never;
    const r = await call(keywordIdeas, { seeds: ["interior designer raipur"] }, ctx(1));
    expect(r.data.ideas).toEqual([{ search: "interior designer raipur", monthlySearches: 880, difficulty: null, intent: null }]);
    expect(r.data.costUsd).toBeCloseTo(0.0144, 4);
    const over = await call(keywordIdeas, { seeds: ["x y"] }, ctx(0.02));
    expect(over.data.ran).toBe(false);
    expect(over.data.why).toMatch(/budget/);
    expect(calls).toBe(1);
  });
});
