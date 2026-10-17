// Every SEO check, true and false, on synthetic PageData; the rule mapping (vendored open-seo ids vs local allevia
// rules), the score, and the graph write.
import { describe, it, expect } from "vitest";
import {
  ALLEVIA_SEO_PLAYBOOK, LOCAL_RULES, VENDORED_CHECKS, evaluateSeo, localRuleId, seoRuleId, seoRulesWrite, seoWrite, type CheckKey,
} from "../../../src/ingest/sources/website/seo.js";
import type { PageData } from "../../../src/ingest/sources/website/page.js";
import { loadAuditIssues } from "../../../src/ingest/sources/playbook-data.js";

const O = "https://www.kestrel.example";
const good = (path = "/about", over: Partial<PageData> = {}): PageData => ({
  url: `${O}${path}`, finalUrl: `${O}${path}`, redirects: [], status: 200, fetchedAt: "2026-10-15T09:00:00.000Z", bytes: 9000,
  title: `About ${path} | Kestrel & Oak`, titleCount: 1, metaDescription: `A page about ${path}.`, metaDescriptionCount: 1,
  canonical: `${O}${path}`, h1: ["About the studio"], h2: [], text: "words", wordCount: 400,
  internalLinks: [`${O}/`], externalLinks: [], images: [{ src: `${O}/a.jpg`, alt: "A room", width: 300, height: 200, naturalWidth: 300, naturalHeight: 200 }],
  jsonLd: [{ "@type": "Organization" }], jsonLdTypes: ["Organization"], jsonLdErrors: 0,
  og: { "og:title": "Kestrel", "og:description": "Architects", "og:image": `${O}/og.jpg` }, lang: "en-GB",
  viewport: "width=device-width, initial-scale=1", timing: { responseMs: 200, fetchMs: 250, loadMs: 900 }, mixedContent: [], ...over,
});

const results = (pages: PageData[], links: Record<string, number> = {}) => evaluateSeo(pages, links).results;
const one = (pages: PageData[], check: CheckKey, links: Record<string, number> = {}) =>
  results(pages, links).filter((r) => r.check === check && r.page === pages[0]!.finalUrl);

describe("evaluateSeo: a clean key page passes every check", () => {
  it("has a passing result for each applicable check", () => {
    const rs = results([good()]);
    expect(rs.filter((r) => !r.pass)).toEqual([]);
    const checks = new Set(rs.map((r) => r.check));
    for (const c of [...VENDORED_CHECKS, ...LOCAL_RULES.map((r) => r.key)]) expect(checks.has(c), c).toBe(true);
  });
});

describe("evaluateSeo: each check fails when it should (and only that check)", () => {
  const cases: Array<[CheckKey, () => PageData[], Record<string, number>?]> = [
    ["missing-title", () => [good("/about", { title: undefined, titleCount: 0 })]],
    ["duplicate-title", () => [good("/about", { title: "Kestrel & Oak" }), good("/services", { title: "Kestrel  &  oak " })]],
    ["title-too-long", () => [good("/about", { title: "Kestrel & Oak Studio | Architects and interior designers in Bristol and Bath" })]],
    ["missing-meta-description", () => [good("/about", { metaDescription: undefined, metaDescriptionCount: 0 })]],
    ["duplicate-meta-description", () => [good("/about", { metaDescription: "Same." }), good("/services", { metaDescription: "same." })]],
    ["missing-h1", () => [good("/about", { h1: [] })]],
    ["multiple-h1", () => [good("/about", { h1: ["One", "Two"] })]],
    ["images-missing-alt", () => [good("/about", { images: [{ src: `${O}/b.jpg`, alt: null, width: 10, height: 10, naturalWidth: 0, naturalHeight: 0 }] })]],
    ["missing-canonical", () => [good("/about", { canonical: undefined })]],
    ["noindex-page", () => [good("/about", { robotsMeta: "noindex, follow" })]],
    ["thin-content", () => [good("/about", { wordCount: 120 })]],
    ["broken-internal-link", () => [good("/about", { internalLinks: [`${O}/gone`, `${O}/`] })], { [`${O}/gone`]: 404, [`${O}/`]: 200 }],
    ["missing-structured-data", () => [good("/about", { jsonLd: [], jsonLdTypes: [] })]],
    ["missing-viewport", () => [good("/about", { viewport: undefined })]],
    ["slow-response", () => [good("/about", { timing: { responseMs: 2400, fetchMs: 2500 } })]],
    ["mixed-content", () => [good("/about", { mixedContent: ["http://cdn.kestrel.example/a.jpg"] })]],
    ["missing-open-graph", () => [good("/about", { og: { "og:title": "Kestrel" } })]],
    ["broken-page", () => [good("/about", { status: 404 })]],
    ["server-error", () => [good("/about", { status: 503 })]],
  ];
  for (const [check, pages, links] of cases) {
    it(check, () => {
      const ps = pages();
      const fails = results(ps, links).filter((r) => !r.pass && r.page === ps[0]!.finalUrl);
      expect(fails.map((r) => r.check)).toEqual([check]);
      expect(fails[0]!.evidence.length).toBeGreaterThan(5);
      expect(fails[0]!.ruleId).toBe(seoRuleId(check));
    });
  }

  it("evidence names what is wrong", () => {
    expect(one([good("/about", { title: "Kestrel & Oak" }), good("/services", { title: "Kestrel & Oak" })], "duplicate-title")[0]!.evidence).toMatch(/\/services/);
    expect(one([good("/about", { internalLinks: [`${O}/gone`] })], "broken-internal-link", { [`${O}/gone`]: 404 })[0]!.evidence).toMatch(/\/gone \(HTTP 404\)/);
    expect(one([good("/about", { h1: ["A", "B", "C"] })], "multiple-h1")[0]!.evidence).toMatch(/^3 <h1>/);
  });
});

describe("evaluateSeo: applicability", () => {
  it("only checks structured data on key pages and mixed content on https pages", () => {
    expect(one([good("/journal/2019/a-note", { jsonLd: [], jsonLdTypes: [] })], "missing-structured-data")).toEqual([]);
    const http = good("/about", { url: "http://kestrel.example/about", finalUrl: "http://kestrel.example/about", mixedContent: ["http://x/a.jpg"] });
    expect(one([http], "mixed-content")).toEqual([]);
  });
  it("judges a broken page only on its status, and skips pages that failed to render", () => {
    expect(results([good("/about", { status: 404 })]).map((r) => r.check)).toEqual(["broken-page"]);
    expect(results([good("/about", { error: "render failed: timeout" })])).toEqual([]);
  });
  it("ignores tracking pixels and a link status it does not know", () => {
    expect(one([good("/about", { images: [{ src: "p.gif", alt: null, width: 1, height: 1, naturalWidth: 1, naturalHeight: 1 }] })], "images-missing-alt")[0]!.pass).toBe(true);
    expect(one([good("/about", { internalLinks: [`${O}/unknown`] })], "broken-internal-link")[0]!.pass).toBe(true);
  });
});

describe("score and rules", () => {
  it("weights critical over warning over info, and ranks the failing checks by pages", () => {
    const allGood = evaluateSeo([good("/about"), good("/services")]);
    expect(allGood.score).toBe(100);
    const r = evaluateSeo([good("/about", { title: undefined, titleCount: 0, canonical: undefined }), good("/services", { canonical: undefined })]);
    expect(r.score).toBeLessThan(100);
    expect(r.failing[0]).toMatchObject({ check: "missing-canonical", pages: 2 });
    const critical = evaluateSeo([good("/about", { title: undefined, titleCount: 0 })]).score;
    const info = evaluateSeo([good("/about", { canonical: undefined })]).score;
    expect(critical).toBeLessThan(info);
    expect(r.pageScores[`${O}/services`]).toBeGreaterThan(r.pageScores[`${O}/about`]!);
  });

  it("maps vendored checks to the open-seo rule ids, with their severity, and the rest to allevia rules", () => {
    const issues = new Map(loadAuditIssues().data.issues.map((i) => [i.type, i.severity]));
    for (const c of VENDORED_CHECKS) {
      expect(issues.has(c), c).toBe(true);
      expect(seoRuleId(c)).toBe(`rule:seo-check-${c}`);
    }
    expect(seoRuleId("missing-canonical")).toBe(localRuleId("missing-canonical"));
    expect(localRuleId("missing-canonical")).toBe("rule:seo-check-allevia-missing-canonical");
    expect(evaluateSeo([good("/about", { title: undefined, titleCount: 0 })]).results.find((x) => x.check === "missing-title")!.severity).toBe(issues.get("missing-title"));
  });

  it("writes every rule a result points at, the local playbook, and FAILS/PASSES with evidence", () => {
    const rules = seoRulesWrite();
    const ids = new Set(rules.nodes.map((n) => n.id));
    const report = evaluateSeo([good("/about", { canonical: undefined }), good("/services")]);
    for (const r of report.results) expect(ids.has(r.ruleId), r.ruleId).toBe(true);
    expect(rules.nodes.find((n) => n.id === localRuleId("missing-viewport"))!.props).toMatchObject({ source: "allevia", kind: "seo-check" });
    expect(rules.edges).toContainEqual(expect.objectContaining({ from: ALLEVIA_SEO_PLAYBOOK, type: "INCLUDES", to: localRuleId("mixed-content") }));
    const w = seoWrite(report, { host: "www.kestrel.example", asOf: "2026-10-15T09:00:00.000Z", day: "2026-10-15", pages: [good("/about"), good("/services")] });
    const fail = w.edges.find((e) => e.type === "FAILS")!;
    expect(fail).toMatchObject({ from: "page:www.kestrel.example/about", to: localRuleId("missing-canonical"), props: { severity: "info" } });
    expect(String(fail.props!.evidence)).toMatch(/canonical/);
    expect(w.edges.filter((e) => e.type === "PASSES").length).toBe(report.results.filter((r) => r.pass).length);
    expect(w.observations[0]).toMatchObject({ subject: "channel:website", metric: "seo_site_score", value: report.score, asOf: "2026-10-15" });
    // each page's own score is a reading that MEASURES the Page (G26), after the site's
    const perPage = w.observations.filter((o) => o.metric === "seo_page_score");
    expect(perPage.map((o) => [o.subject, o.value, o.asOf])).toEqual([
      ["page:www.kestrel.example/about", report.pageScores[good("/about").finalUrl], "2026-10-15"],
      ["page:www.kestrel.example/services", report.pageScores[good("/services").finalUrl], "2026-10-15"],
    ]);
    expect(perPage[0]!.value).toBeLessThan(perPage[1]!.value); // /about lacks a canonical link
    expect(perPage.every((o) => o.src === w.nodes[0]!.id && o.unit === "/100")).toBe(true);
  });
});
