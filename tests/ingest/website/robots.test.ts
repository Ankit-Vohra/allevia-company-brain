import { describe, it, expect } from "vitest";
import { parseRobots, parseSitemap } from "../../../src/ingest/sources/website/robots.js";

describe("parseRobots", () => {
  it("uses the AlleviaBot group when there is one, else *", () => {
    const r = parseRobots("User-agent: *\nDisallow: /\n\nUser-agent: AlleviaBot\nDisallow: /drafts/\n");
    expect(r.isAllowed("/about")).toBe(true);
    expect(r.isAllowed("/drafts/x")).toBe(false);
    const star = parseRobots("User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /private/\n");
    expect(star.isAllowed("/private/a")).toBe(false);
    expect(star.isAllowed("/public")).toBe(true);
  });
  it("longest match wins, Allow wins a tie, wildcards and $ work", () => {
    const r = parseRobots("User-agent: *\nDisallow: /private/\nAllow: /private/press-kit\nDisallow: /*.pdf$\nDisallow: /tmp\nAllow: /tmp\n");
    expect(r.isAllowed("/private/a")).toBe(false);
    expect(r.isAllowed("/private/press-kit/logo")).toBe(true);
    expect(r.isAllowed("/files/brochure.pdf")).toBe(false);
    expect(r.isAllowed("/files/brochure.pdf?x=1")).toBe(true);
    expect(r.isAllowed("/tmp/a")).toBe(true);
  });
  it("treats an empty Disallow as allow-all, reads Crawl-delay and sitemaps", () => {
    const r = parseRobots("Sitemap: https://e.com/sitemap.xml\nUser-agent: *\nDisallow:\nCrawl-delay: 2\n");
    expect(r.isAllowed("/anything")).toBe(true);
    expect(r.crawlDelayMs).toBe(2000);
    expect(r.sitemaps).toEqual(["https://e.com/sitemap.xml"]);
    expect(parseRobots("User-agent: *\nDisallow: /\n").disallowAll).toBe(true);
  });
  it("allows everything when no group applies", () => {
    expect(parseRobots("User-agent: OtherBot\nDisallow: /\n").isAllowed("/x")).toBe(true);
  });
});

describe("parseSitemap", () => {
  it("reads url sets and sitemap indexes, decoding entities", () => {
    expect(parseSitemap("<urlset><url><loc>https://e.com/a?x=1&amp;y=2</loc></url><url><loc> https://e.com/b </loc></url></urlset>").urls)
      .toEqual(["https://e.com/a?x=1&y=2", "https://e.com/b"]);
    expect(parseSitemap("<sitemapindex><sitemap><loc>https://e.com/s1.xml</loc></sitemap></sitemapindex>")).toEqual({ urls: [], sitemaps: ["https://e.com/s1.xml"] });
  });
});
