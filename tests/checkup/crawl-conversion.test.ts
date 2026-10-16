// The crawler with the check-up's conversion reading on: home and key pages are read at desktop and phone size, the
// pages that are not brand pages are not, and a crawl without the option reads nothing extra.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crawlSite, type CrawlResult } from "../../src/ingest/sources/website/crawl.js";
import { startSite, type SiteServer } from "../fixtures/website/server.js";

describe("crawlSite with conversion", () => {
  let site: SiteServer;
  let on: CrawlResult;
  let off: CrawlResult;
  beforeAll(async () => {
    site = await startSite();
    const base = { allowHosts: [`127.0.0.1:${site.port}`], minDelayMs: 0, maxLinkChecks: 0, maxPages: 6 };
    on = await crawlSite(`${site.origin}/`, { ...base, conversion: true, brandPages: 3 });
    off = await crawlSite(`${site.origin}/`, base);
  }, 120_000);
  afterAll(async () => { await site.close(); });

  it("reads the home page at both sizes", () => {
    const home = on.pages[0]!;
    expect(home.conversion?.desktop?.viewport.width).toBe(1366);
    expect(home.conversion?.mobile?.viewport.width).toBe(390);
    expect(Array.isArray(home.conversion?.mobile?.ctas)).toBe(true);
  });

  it("reads at most the brand pages", () => {
    expect(on.pages.filter((p) => p.conversion).length).toBeLessThanOrEqual(3);
    expect(on.pages.filter((p) => p.conversion).length).toBeGreaterThanOrEqual(1);
  });

  it("does nothing extra without the option", () => {
    expect(off.pages.some((p) => p.conversion)).toBe(false);
  });
});
