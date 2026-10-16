// The check-up as the graph remembers it (graph audit G4, G9): two runs on different days where the second fixes one finding,
// read back with real traversals. The findings shown come from the open FAILS edges, "fixed since last time" from the edge
// closed with its reason, the trend from the readings on the website channel; the report's JSON speaks only for a run stored
// before the edges carried a finding. A check-up never renames a Page onboarding named. RANKS_FOR.position is refreshed in
// place, so each run leaves a serp_position reading that MEASURES the Query.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GraphHandle } from "../../src/graph/client.js";
import { closeEdge, upsertNode, writeBatch } from "../../src/graph/upsert.js";
import { buildVerdict } from "../../src/checkup/fixes.js";
import { FIXED_REASON, checkupHistory, scoreTrend } from "../../src/checkup/history.js";
import { keepPageNames } from "../../src/checkup/pages.js";
import { keywordsWrite, queryId } from "../../src/checkup/dataforseo.js";
import { saveCheckup, storedCheckups } from "../../src/checkup/run.js";
import { checkupRulesWrite, checkupWrite, type CheckupRun } from "../../src/checkup/store.js";
import { latestCheckup, topFiveText } from "../../src/checkup/tenant.js";
import type { LighthouseResult } from "../../src/checkup/lighthouse.js";
import { metricTrend } from "../../src/agent/tools/metrics.js";
import { websiteCheckup } from "../../src/agent/tools/website.js";
import { testGraph } from "../helpers/graph.js";
import { call, makeCtx } from "../helpers/tools.js";

const O = "https://shree.example";
const HOME = `${O}/`;
const CONTACT = `${O}/contact`;
const lh = (perf: number): LighthouseResult => ({ url: HOME, strategy: "mobile", scores: { performance: perf, accessibility: 92, seo: 90 }, metrics: { lcpMs: 4100 }, issues: [] });

// day one: no call button on the home page or the contact page, and no clear offer; day two: the offer is fixed
const run = (asOf: string, perf: number, offer: boolean, titles?: Record<string, string>): CheckupRun => ({
  origin: O, asOf, lighthouse: [lh(perf)], pagesChecked: [HOME, CONTACT], conversionPages: [HOME, CONTACT], notes: [], ...(titles ? { pageTitles: titles } : {}),
  verdict: buildVerdict({
    site: { origin: O, homeOk: true, https: true, sitemapFound: true, aiCrawlersBlocked: [] }, kind: "local", lighthouse: [lh(perf)],
    conversion: [
      { check: "contact-above-fold-mobile", pass: false, page: HOME, evidence: "no button" },
      { check: "contact-above-fold-mobile", pass: false, page: CONTACT, evidence: "no button on the contact page | either" },
      { check: "clear-offer", pass: offer, page: HOME, evidence: "Welcome" },
    ],
  }),
});
const DAY1 = "2026-10-01T10:00:00Z";
const DAY2 = "2026-10-15T10:00:00Z";
const ms = (iso: string) => Date.parse(iso);

describe("the check-up in the graph", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  const q = <T>(cypher: string, params?: Record<string, unknown>) => g.roQuery<T>(cypher, params);

  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await upsertNode(g, { type: "Business", id: "business:shree", name: "Shree Interiors", props: { country: "IN" } }, ms("2026-09-30T00:00:00Z"));
    // what onboarding wrote earlier: the home and contact pages, named by their titles (G9)
    await writeBatch(g, { nodes: [
      { type: "Page", id: `page:shree.example`, name: "Shree Interiors | Interior design in Raipur", props: { url: HOME, path: "/" } },
      { type: "Page", id: `page:shree.example/contact`, name: "Contact Shree Interiors", props: { url: CONTACT, path: "/contact" } },
    ], edges: [], observations: [] }, ms("2026-09-30T00:00:00Z"));
    const s1 = await saveCheckup(g, run(DAY1, 41, false), ms(DAY1));
    expect(s1.progress.lines).toEqual([]);
    await saveCheckup(g, run(DAY2, 78, true, { [HOME]: "A different title", [CONTACT]: "Contact" }), ms(DAY2));
  });
  afterAll(async () => { await cleanup(); });

  it("G9: a check-up never renames a page onboarding named, and writes no Version when it meets it again", async () => {
    const pages = await q<{ id: string; name: string }>("MATCH (p:Page) RETURN p.id AS id, p.name AS name ORDER BY p.id");
    expect(pages).toEqual([
      { id: "page:shree.example", name: "Shree Interiors | Interior design in Raipur" },
      { id: "page:shree.example/contact", name: "Contact Shree Interiors" },
    ]);
    expect(await q("MATCH (:Page)-[:HAD_VERSION]->(v:Version) RETURN v.id AS id ORDER BY v.id")).toEqual([]);
  });

  it("G9: a page the graph has never seen is named by its title (the same rule as onboarding), else by its path", async () => {
    const w = checkupWrite(run("2026-10-20T10:00:00Z", 60, true, { [`${O}/new-page`]: "A new page | Shree" }));
    const extra = { ...w, nodes: [...w.nodes, { type: "Page" as const, id: "page:shree.example/untitled", name: "/untitled", props: { url: `${O}/untitled` } }] };
    const names = Object.fromEntries(extra.nodes.filter((n) => n.type === "Page").map((n) => [n.id, n.name]));
    expect(names["page:shree.example"]).toBe("/"); // home has no title in this run, and would be "/" ...
    const kept = await keepPageNames(g, extra);
    const keptNames = Object.fromEntries(kept.nodes.filter((n) => n.type === "Page").map((n) => [n.id, n.name]));
    expect(keptNames["page:shree.example"]).toBe("Shree Interiors | Interior design in Raipur"); // ... but the graph has a name: it keeps it
    expect(keptNames["page:shree.example/untitled"]).toBe("/untitled");
    // a title carried into the run names a page nobody has named yet
    const fresh = checkupWrite({ ...run(DAY2, 78, true, { [`${O}/pricing`]: "Pricing | Shree" }), lighthouse: [lh(78), { ...lh(70), url: `${O}/pricing` }] });
    expect(fresh.nodes.find((n) => n.id === "page:shree.example/pricing")!.name).toBe("Pricing | Shree");
  });

  it("G4: the second run closed the fixed finding's edge with its reason; the others stay open", async () => {
    const rows = await q<{ at: string; key: string; open: boolean; reason: string | null }>(
      `MATCH (x:Entity)-[e:FAILS]->(r:Rule {kind:'website-check'}) RETURN x.id AS at, r.issueType AS key, e.until IS NULL AS open, e.closeReason AS reason ORDER BY key, at`);
    expect(rows).toEqual([
      { at: "page:shree.example", key: "clear-offer", open: false, reason: FIXED_REASON },
      { at: "page:shree.example", key: "contact-above-fold-mobile", open: true, reason: null },
      { at: "page:shree.example/contact", key: "contact-above-fold-mobile", open: true, reason: null },
      { at: "page:shree.example", key: "mobile-speed", open: true, reason: null },
    ]);
    const [closed] = await q<{ until: number }>("MATCH (:Page)-[e:FAILS]->(:Rule {issueType:'clear-offer'}) RETURN e.until AS until");
    expect(closed!.until).toBe(ms(DAY2));
  });

  it("G4: the latest findings are the open edges, and the history says what was fixed since last time", async () => {
    const stored = await storedCheckups(g, 2);
    const h = await checkupHistory(g, { asOf: stored[0]!.asOf, fixCount: stored[0]!.fixTitles.length }, true);
    expect(h.fromGraph).toBe(true);
    expect(h.all.map((f) => f.key)).toEqual(["contact-above-fold-mobile", "mobile-speed"]); // the offer is fixed; the speed (78 of 100) is not yet
    expect(h.top[0]).toMatchObject({
      key: "contact-above-fold-mobile", title: "Put a call or WhatsApp button on the first screen on phones", effort: "about 30 minutes", who: "you",
      pages: ["/", "/contact"], pageCount: 2, tier: "losing enquiries",
    });
    expect(h.top[0]!.what).toMatch(/Call/);
    expect(h.top[0]!.evidence).toEqual(["no button", "no button on the contact page | either"]); // kept as separate items, even with a bar inside one
    expect(h.fixed).toEqual(["Say what you do in the first line of the home page"]);
    expect(h.fresh).toEqual([]);
  });

  it("G4: the score trend has one point per run, read from the readings on the website channel", async () => {
    const t = await scoreTrend(g);
    expect(t.map((p) => [p.checkedOn, p.scores["speed on phones"]])).toEqual([["2026-10-01", 41], ["2026-10-15", 78]]);
    expect(t[1]!.scores).toMatchObject({ "easy to use": 92, "Google basics": 90 });
    const r = await call(metricTrend, { metric: "checkup_mobile_speed", subject: "channel:website" }, makeCtx(g, { now: ms("2026-10-16T00:00:00Z") }));
    expect(r.data.series.map((p: { value: number }) => p.value)).toEqual([41, 78]);
  });

  it("the check-up page, the chat tool and Discord show the graph's findings", async () => {
    const last = (await latestCheckup(g))!;
    expect(last.top.map((f) => f.title)).toEqual(["Put a call or WhatsApp button on the first screen on phones", "Make the site faster on phones"]);
    expect(last.fixedSinceLast).toEqual(["Say what you do in the first line of the home page"]);
    expect(last.trend.map((t) => t.checkedOn)).toEqual(["2026-10-01", "2026-10-15"]);
    expect(topFiveText(last)).toContain("Fixed since last time: Say what you do in the first line of the home page.");
    const r = await call(websiteCheckup, { all: true }, makeCtx(g));
    expect(r.data.topFixes.map((f: { key: string }) => f.key)).toEqual(["contact-above-fold-mobile", "mobile-speed"]);
    expect(r.data.sinceLastCheckup).toEqual(expect.arrayContaining(["Your mobile speed went from 41 to 78.", "Fixed since the last check-up: Say what you do in the first line of the home page."]));
    expect(r.data.scoreTrend).toEqual([expect.objectContaining({ checkedOn: "2026-10-01", "speed on phones": 41 }), expect.objectContaining({ checkedOn: "2026-10-15", "speed on phones": 78 })]);
    expect(r.data.showHow.evidence["contact-above-fold-mobile"]).toEqual(["no button", "no button on the contact page | either"]);
  });

  it("the graph is the truth: close an edge and the finding is gone from every reader, whatever the report's JSON still says", async () => {
    const [doc] = await storedCheckups(g, 1);
    expect(JSON.stringify(doc!.top)).toContain("Put a call or WhatsApp button"); // the report still lists it
    expect(await closeEdge(g, "page:shree.example/contact", "FAILS", "rule:allevia-website-checkup-contact-above-fold-mobile", ms("2026-10-16T00:00:00Z"), "fixed by hand")).toBe(1);
    // one page still fails it: the finding stays, on one page
    const last = (await latestCheckup(g))!;
    expect(last.top).toHaveLength(2);
    const r = await call(websiteCheckup, {}, makeCtx(g));
    expect(r.data.topFixes[0]).toMatchObject({ key: "contact-above-fold-mobile", where: ["/"] });
    expect(await closeEdge(g, "page:shree.example", "FAILS", "rule:allevia-website-checkup-contact-above-fold-mobile", ms("2026-10-16T00:00:00Z"), "fixed by hand")).toBe(1);
    // every page fixed: only the speed is left, though the report's JSON still lists the button
    expect((await latestCheckup(g))!.top.map((f) => f.title)).toEqual(["Make the site faster on phones"]);
    expect((await call(websiteCheckup, {}, makeCtx(g))).data.topFixes.map((f: { key: string }) => f.key)).toEqual(["mobile-speed"]);
  });
});

describe("a check-up stored before its edges carried a finding", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await upsertNode(g, { type: "Business", id: "business:shree", name: "Shree Interiors" }, ms("2026-09-30T00:00:00Z"));
    await writeBatch(g, checkupRulesWrite(), ms(DAY1));
    // the old shape: the report Document and edges with evidence, impact and tier only
    const w = checkupWrite(run(DAY1, 41, false));
    const old = { ...w, edges: w.edges.map((e) => (e.type === "FAILS"
      ? { ...e, props: { evidence: e.props!.evidence!, impact: e.props!.impact!, tier: e.props!.tier!, severity: e.props!.severity! } } : e)) };
    expect((await writeBatch(g, old, ms(DAY1))).errors).toEqual([]);
  });
  afterAll(async () => { await cleanup(); });

  it("falls back to the report's own JSON, and says so", async () => {
    const [doc] = await storedCheckups(g, 1);
    const h = await checkupHistory(g, { asOf: doc!.asOf, fixCount: doc!.fixTitles.length }, false);
    expect(h.fromGraph).toBe(false);
    const last = (await latestCheckup(g))!;
    expect(last.top.map((f) => f.title)).toEqual(["Put a call or WhatsApp button on the first screen on phones", "Make the site faster on phones", "Say what you do in the first line of the home page"]);
    expect(last.fixedSinceLast).toEqual([]);
    const r = await call(websiteCheckup, {}, makeCtx(g));
    expect(r.data.topFixes).toHaveLength(3);
  });

  it("the next run (new shape) re-asserts the edges, and the graph answers from then on", async () => {
    await saveCheckup(g, run(DAY2, 78, true), ms(DAY2));
    const [doc] = await storedCheckups(g, 1);
    const h = await checkupHistory(g, { asOf: doc!.asOf, fixCount: doc!.fixTitles.length }, true);
    expect(h.fromGraph).toBe(true);
    expect(h.fixed).toEqual(["Say what you do in the first line of the home page"]);
  });
});

describe("G4: the ranking's history", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  const ranked = (position: number, extra: Array<{ keyword: string; position: number; url: string | null; volume: number | null }> = []) =>
    [{ keyword: "interior designer raipur", position, url: `${O}/`, volume: 880 }, ...extra];
  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await upsertNode(g, { type: "Business", id: "business:shree", name: "Shree Interiors" }, ms("2026-09-30T00:00:00Z"));
    // onboarding named the home page by its title
    await upsertNode(g, { type: "Page", id: "page:shree.example", name: "Shree Interiors | Interior design in Raipur", props: { url: HOME } }, ms("2026-09-30T00:00:00Z"));
    for (const [asOf, position] of [["2026-10-01T10:00:00Z", 7], ["2026-10-08T10:00:00Z", 5], ["2026-10-15T10:00:00Z", 3]] as const) {
      const w = await keepPageNames(g, keywordsWrite({ asOf, host: "shree.example", ranked: ranked(position) }));
      expect((await writeBatch(g, w, ms(asOf))).errors).toEqual([]);
    }
  });
  afterAll(async () => { await cleanup(); });

  it("the edge holds the current position (refreshed in place) and every run left a reading that MEASURES the Query", async () => {
    const [edge] = await q1<{ position: number }>("MATCH (:Page)-[r:RANKS_FOR]->(:Query) WHERE r.until IS NULL RETURN r.position AS position");
    expect(edge!.position).toBe(3);
    const hist = await q1<{ day: string; v: number; unit: string }>(
      `MATCH (o:Observation {metric:'serp_position'})-[m:MEASURES]->(qn:Query {id:$q}) WHERE m.until IS NULL RETURN o.asOf AS day, o.value AS v, o.unit AS unit ORDER BY day, o.id`,
      { q: queryId("interior designer raipur") });
    expect(hist).toEqual([{ day: "2026-10-01T10:00:00Z", v: 7, unit: "position" }, { day: "2026-10-08T10:00:00Z", v: 5, unit: "position" }, { day: "2026-10-15T10:00:00Z", v: 3, unit: "position" }]);
    // ... so metric_trend reads it like any other series
    const r = await call(metricTrend, { metric: "serp_position", subject: queryId("interior designer raipur") }, makeCtx(g, { now: ms("2026-10-16T00:00:00Z") }));
    expect(r.data.series.map((p: { value: number }) => p.value)).toEqual([7, 5, 3]);
    expect(r.data.stats).toMatchObject({ first: 7, last: 3 });
  });

  it("G9: ranking the home page again did not rename it", async () => {
    expect(await q1("MATCH (p:Page {id:'page:shree.example'}) RETURN p.name AS name")).toEqual([{ name: "Shree Interiors | Interior design in Raipur" }]);
    expect(await q1("MATCH (:Page)-[:HAD_VERSION]->(v:Version) RETURN v.id AS id ORDER BY v.id")).toEqual([]);
  });

  it("when two pages rank for one search, the reading is the better position", () => {
    const w = keywordsWrite({ asOf: "2026-10-16T10:00:00Z", host: "shree.example", ranked: [
      { keyword: "interior designer raipur", position: 9, url: `${O}/blog`, volume: 880 }, { keyword: "interior designer raipur", position: 4, url: `${O}/`, volume: 880 },
    ] });
    expect(w.observations.filter((o) => o.metric === "serp_position").map((o) => o.value)).toEqual([4]);
  });

  const q1 = <T>(cypher: string, params?: Record<string, unknown>) => g.roQuery<T>(cypher, params);
});
