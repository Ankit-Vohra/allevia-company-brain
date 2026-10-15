// Which pages a crawl visits and a model reads when the site is not an architecture studio's. On a Shopify garden
// centre, 37 of the 40 pages crawled were product listings and the café, visit and blog pages were never read, because
// "/pages/cafe" scored below "/collections/roses" (docs/onboarding-trials.md, 2026-10-15).
import { describe, it, expect } from "vitest";
import { keyPagePriority } from "../../../src/ingest/sources/website/urls.js";
import { selectKeyPages, type PageData } from "../../../src/ingest/sources/website/index.js";

const prio = (p: string) => keyPagePriority(new URL(`https://shop.example${p}`));

describe("keyPagePriority", () => {
  it("sees through the /pages/ wrapper that Shopify and Wix put around every content page", () => {
    expect(prio("/pages/about-us")).toBe(prio("/about-us"));
    expect(prio("/pages/contact")).toBe(prio("/contact"));
    expect(prio("/pages/about-us")).toBeGreaterThanOrEqual(85);
  });

  it("knows the pages local businesses put their story on: visit, café, treatments, new patients, opening hours", () => {
    for (const p of ["/visit-us", "/pages/cafe", "/opening-hours", "/find-us", "/new-patients", "/treatments", "/our-menu", "/meet-the-team", "/pages/nursery", "/reservations"]) {
      expect(prio(p), p).toBeGreaterThanOrEqual(60);
    }
  });

  it("ranks a section's own page above the pages inside it, and the pages inside a shop below the pages about the business", () => {
    expect(prio("/collections")).toBeGreaterThan(prio("/collections/roses"));
    expect(prio("/pages/cafe")).toBeGreaterThan(prio("/collections/roses"));
    expect(prio("/products/rose-gloriana")).toBeLessThan(prio("/pages/about-us"));
    expect(prio("/")).toBe(100);
    expect(prio("/projects/harbour-house")).toBeLessThan(prio("/projects"));    // unchanged
  });
});

const page = (path: string, words = 120): PageData => {
  const text = "A plain sentence about the business, long enough to count as a real page. ".repeat(Math.ceil(words / 12));
  return {
    url: `https://shop.example${path}`, finalUrl: `https://shop.example${path}`, redirects: [], status: 200, fetchedAt: "2026-10-15T09:00:00.000Z", bytes: 1,
    title: path, titleCount: 1, metaDescriptionCount: 0, h1: [], h2: [], text, wordCount: text.split(/\s+/).length,
    internalLinks: [], externalLinks: [], images: [], jsonLd: [], jsonLdTypes: [], jsonLdErrors: 0, og: {}, timing: { responseMs: 1, fetchMs: 1 }, mixedContent: [],
  };
};

describe("selectKeyPages across sections", () => {
  const pages = [
    page("/"), page("/pages/about-us"), page("/pages/contact"), page("/pages/cafe"), page("/blogs/news/spring-planting"),
    ...Array.from({ length: 30 }, (_, i) => page(`/collections/c${i}`)),
  ];

  it("does not let one section (a shop's collections) take every place", () => {
    const picked = selectKeyPages(pages, 8).map((p) => new URL(p.finalUrl).pathname);
    expect(picked).toEqual(expect.arrayContaining(["/", "/pages/about-us", "/pages/contact", "/pages/cafe", "/blogs/news/spring-planting"]));
    expect(picked.filter((p) => p.startsWith("/collections/")).length).toBeLessThanOrEqual(3);
    expect(picked).toHaveLength(8);
  });

  it("still fills the places when a site has nothing but one section", () => {
    const only = Array.from({ length: 10 }, (_, i) => page(`/docs/page-${i}`));
    expect(selectKeyPages(only, 6)).toHaveLength(6);
  });
});
