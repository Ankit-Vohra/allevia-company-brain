import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FIXES, buildVerdict, effortWords, pageWeight, type CheckupInput } from "../../src/checkup/fixes.js";
import { parseLhr } from "../../src/checkup/lighthouse.js";
import type { SeoReport, SeoResult } from "../../src/ingest/sources/website/seo.js";

const O = "https://shree.example";
const lhr = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/checkup/${name}`, import.meta.url), "utf8")) as unknown;
const seoFail = (page: string, check: SeoResult["check"], evidence = "x"): SeoResult =>
  ({ page: `${O}${page}`, check, ruleId: `rule:${check}`, pass: false, severity: "warning", evidence });
const report = (results: SeoResult[]): SeoReport => ({ results, score: 50, pageScores: {}, failing: [] });

const base = (over: Partial<CheckupInput> = {}): CheckupInput => ({
  site: { origin: O, homeOk: true, https: true, sitemapFound: true, aiCrawlersBlocked: [] },
  kind: "local",
  seo: report([]),
  lighthouse: [],
  conversion: [],
  ...over,
});

describe("buildVerdict", () => {
  it("puts a missing phone contact above tidy-ups, whatever their page count", () => {
    const v = buildVerdict(base({
      seo: report(["/a", "/b", "/c", "/d", "/e", "/f"].map((p) => seoFail(p, "missing-meta-description"))),
      conversion: [{ check: "contact-above-fold-mobile", pass: false, page: `${O}/`, evidence: "no button on the first screen" }],
    }));
    expect(v.top[0]!.key).toBe("contact-above-fold-mobile");
    const desc = v.all.find((f) => f.key === "descriptions")!;
    expect(desc.title).toBe("Write Google descriptions for 6 pages");
    expect(desc.pageCount).toBe(6);
  });

  it("groups title problems into one fix and keeps the technical detail for Show how", () => {
    const v = buildVerdict(base({ seo: report([seoFail("/", "missing-title", "the page has no <title>"), seoFail("/about", "duplicate-title"), seoFail("/blog/x", "title-too-long")]) }));
    const t = v.all.filter((f) => f.key === "titles");
    expect(t).toHaveLength(1);
    expect(t[0]!.pages[0]).toBe("/"); // home first
    expect(t[0]!.evidence.join(" ")).toContain("<title>");
  });

  it("turns a slow phone result into one speed fix with plain steps and the vitals as evidence", () => {
    const m = parseLhr(lhr("lhr-mobile-poor.json"), "mobile", `${O}/`);
    m.scores.performance = 41;
    const v = buildVerdict(base({ lighthouse: [m, parseLhr(lhr("lhr-desktop-poor.json"), "desktop", `${O}/`)] }));
    const s = v.all.find((f) => f.key === "mobile-speed")!;
    expect(s.impact).toBe(85);
    expect(s.what).toMatch(/^Ask your web person to /);
    expect(s.evidence.join(" ")).toMatch(/main content shows in \d+\.\d s/);
    expect(v.scores.mobileSpeed).toBe(41);
    expect(v.scores.desktopSpeed).toBeGreaterThan(0);
    // accessibility findings become their own plain fixes
    expect(v.all.map((f) => f.key)).toEqual(expect.arrayContaining(["contrast", "image-text"]));
  });

  it("does not raise a speed fix for a fast site and says what is good", () => {
    const m = parseLhr(lhr("lhr-desktop-poor.json"), "mobile", `${O}/`);
    m.scores.performance = 96;
    m.scores.accessibility = 95;
    const v = buildVerdict(base({ lighthouse: [m], conversion: [{ check: "proof", pass: true, page: `${O}/`, evidence: "" }] }));
    expect(v.all.find((f) => f.key === "mobile-speed")).toBeUndefined();
    expect(v.good.join(" ")).toMatch(/fast on phones \(96\/100\)/);
    expect(v.good.join(" ")).toMatch(/reviews/);
  });

  it("weighs the home page above a blog post, and ties go to the quicker fix", () => {
    expect(pageWeight(`${O}/`)).toBe(1);
    expect(pageWeight(`${O}/contact`)).toBe(0.8);
    expect(pageWeight(`${O}/blog/2019/some-post`)).toBe(0.5);
    const v = buildVerdict(base({ seo: report([seoFail("/blog/2019/a", "broken-internal-link"), seoFail("/", "missing-open-graph")]) }));
    expect(v.all.find((f) => f.key === "broken-links")!.impact).toBe(30);
    expect(v.all.find((f) => f.key === "share-preview")!.impact).toBe(30);
    expect(v.all[0]!.key).toBe("share-preview"); // 30 vs 30: one share preview (about 23 min) is quicker than broken links (30)
  });

  it("asks for opening hours only of a local business, and site-wide gaps appear", () => {
    const v = buildVerdict(base({ site: { origin: O, homeOk: true, https: false, sitemapFound: false, aiCrawlersBlocked: ["OAI-SearchBot"] } }));
    expect(v.all.map((f) => f.key)).toEqual(expect.arrayContaining(["https", "sitemap", "ai-crawlers"]));
    expect(v.top[0]!.key).toBe("https");
  });

  it("rates missing reviews lower when the site already shows awards or numbers", () => {
    const soft = buildVerdict(base({ conversion: [{ check: "proof", pass: false, base: 45, page: `${O}/`, evidence: "only awards" }] }));
    const none = buildVerdict(base({ conversion: [{ check: "proof", pass: false, page: `${O}/`, evidence: "nothing" }] }));
    expect(soft.all[0]!.impact).toBe(45);
    expect(none.all[0]!.impact).toBe(65);
  });

  it("speaks of sign-up for an online business, and keeps tiny fixes out of the top five", () => {
    const v = buildVerdict(base({ kind: "online", seo: report([seoFail("/", "missing-canonical")]),
      conversion: [{ check: "contact-above-fold-mobile", pass: false, page: `${O}/`, evidence: "no button" }] }));
    expect(v.top.map((f) => f.title)).toEqual(["Put a sign-up or 'get the app' button on the first screen on phones"]);
    expect(v.all.map((f) => f.key)).toContain("canonical");
  });

  it("keeps the top five to five", () => {
    const v = buildVerdict(base({ seo: report(["missing-title", "missing-meta-description", "missing-h1", "images-missing-alt", "missing-open-graph", "missing-canonical", "mixed-content"]
      .map((c) => seoFail("/", c as SeoResult["check"]))) }));
    expect(v.top).toHaveLength(5);
    expect(v.all.length).toBeGreaterThan(5);
  });
});

describe("owner words", () => {
  const JARGON = /\b(LCP|CLS|TBT|INP|JSON-?LD|canonical|schema|lighthouse|meta|H1|alt attribute|noindex|viewport|crawl|SEO)\b/i;
  it("no fix title uses technical words", () => {
    for (const f of FIXES) for (const n of [1, 3]) expect(f.title(n), f.key).not.toMatch(JARGON);
  });
  it("every fix says why in plain words", () => {
    for (const f of FIXES) expect(f.why, f.key).not.toMatch(/\b(LCP|CLS|TBT|JSON-?LD|lighthouse)\b/i);
  });
  it("effort reads as time", () => {
    expect(effortWords(10)).toBe("about 15 minutes");
    expect(effortWords(45)).toBe("about an hour");
    expect(effortWords(240)).toBe("half a day");
  });
});
