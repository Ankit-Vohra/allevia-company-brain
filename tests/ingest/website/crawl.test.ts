// The crawler against the synthetic fixture site on a local server (the only place private hosts are allowed, by an
// exact host:port opt-in): robots.txt, sitemap.xml, broken links, duplicate titles, missing alt text, binaries,
// SSRF refusals (including a redirect to a cloud metadata address), page fields and screenshots.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crawlSite, type CrawlResult } from "../../../src/ingest/sources/website/crawl.js";
import { BlockedUrlError, USER_AGENT } from "../../../src/ingest/sources/website/fetch.js";
import { startSite, type SiteServer } from "../../fixtures/website/server.js";

describe("crawlSite (fixture site)", () => {
  let site: SiteServer;
  let res: CrawlResult;
  let shots: string;
  const seen: string[] = [];
  const page = (path: string) => res.pages.find((p) => p.finalUrl === `${site.origin}${path}`);

  beforeAll(async () => {
    site = await startSite();
    shots = mkdtempSync(join(tmpdir(), "allevia-shots-"));
    res = await crawlSite(`${site.origin}/`, {
      allowHosts: [`127.0.0.1:${site.port}`], minDelayMs: 0, screenshotDir: shots, maxLinkChecks: 5, onPage: (p) => { seen.push(p.finalUrl); },
    });
  }, 90_000);
  afterAll(async () => {
    await site.close();
    rmSync(shots, { recursive: true, force: true });
  });

  it("reads robots.txt first and never requests what it disallows", () => {
    expect(site.requests[0]!.path).toBe("/robots.txt");
    expect(site.requests.some((r) => r.path.startsWith("/private/"))).toBe(false);
    expect(res.skipped.find((s) => s.url.endsWith("/private/secret"))?.reason).toMatch(/robots/);
  });

  it("finds pages through sitemap.xml that nothing links to, and only same-origin ones", () => {
    expect(page("/hidden-from-links")).toBeDefined();
    expect(res.sitemapUrls).toBeGreaterThan(0);
    expect(site.requests.some((r) => r.path === "/sitemap.xml")).toBe(true);
    expect(res.pages.every((p) => p.finalUrl.startsWith(site.origin))).toBe(true);
  });

  it("visits key pages first, reports each page as it goes, and sends the AlleviaBot user agent", () => {
    expect(res.pages[0]!.finalUrl).toBe(`${site.origin}/`);
    expect(seen).toEqual(res.pages.map((p) => p.finalUrl));
    const order = res.pages.map((p) => new URL(p.finalUrl).pathname);
    expect(order.indexOf("/about")).toBeLessThan(order.indexOf("/hidden-from-links"));
    expect(site.requests.every((r) => r.ua === USER_AGENT)).toBe(true);
  });

  it("records a broken internal link's status", () => {
    expect(res.linkStatus[`${site.origin}/missing`]).toBe(404);
  });

  it("captures titles (duplicates included), descriptions, headings and missing alt text", () => {
    expect(page("/services")!.title).toBe("Kestrel & Oak Studio");
    expect(page("/contact")!.title).toBe("Kestrel & Oak Studio");
    expect(page("/projects/harbour-house")!.h1).toHaveLength(2);
    expect(page("/projects/harbour-house")!.metaDescription).toBeUndefined();
    expect(page("/contact")!.h1).toHaveLength(0);
    expect(page("/contact")!.viewport).toBeUndefined();
    const imgs = page("/projects")!.images;
    expect(imgs.filter((i) => i.alt === null)).toHaveLength(2);
    expect(imgs.filter((i) => i.alt === "")).toHaveLength(1);
  });

  it("captures the home page in full: text, links, JSON-LD, Open Graph, logo, styles, timing", () => {
    const home = page("/")!;
    expect(home.status).toBe(200);
    expect(home.title).toMatch(/^Kestrel & Oak Studio \| Architects/);
    expect(home.text).toMatch(/Homes that feel like they were always there/);
    expect(home.text).not.toMatch(/Download our brochure/); // the footer is not main text
    expect(home.wordCount).toBeGreaterThan(150);
    expect(home.canonical).toBe(`${site.origin}/`);
    expect(home.jsonLdTypes).toEqual(expect.arrayContaining(["LocalBusiness", "PostalAddress"]));
    expect(home.og["og:title"]).toBe("Kestrel & Oak Studio");
    expect(home.lang).toBe("en-GB");
    expect(home.viewport).toMatch(/width=device-width/);
    expect(home.internalLinks).toEqual(expect.arrayContaining([`${site.origin}/about`, `${site.origin}/missing`]));
    expect(home.externalLinks).toEqual(expect.arrayContaining(["https://www.instagram.com/kestrel.oak/"]));
    expect(home.logo).toMatchObject({ kind: "img", inHeader: true, keyword: true });
    expect(home.logo!.src).toBe(`${site.origin}/logo.png`);
    expect(home.styles!.length).toBeGreaterThan(5);
    expect(home.styles!.some((s) => s.font?.includes("Cormorant Garamond"))).toBe(true);
    expect(home.timing.loadMs).toBeGreaterThanOrEqual(0);
  });

  it("skips binaries without fetching them", () => {
    expect(res.skipped.find((s) => s.url.endsWith("/brochure.pdf"))?.reason).toMatch(/binary/);
    expect(site.requests.some((r) => r.path === "/brochure.pdf")).toBe(false);
  });

  it("refuses a link that redirects to a private address", () => {
    expect(res.skipped.find((s) => s.url.endsWith("/redirect-private"))?.reason).toMatch(/refused/);
    expect(res.pages.some((p) => p.url.endsWith("/redirect-private"))).toBe(false);
  });

  it("writes desktop and mobile screenshots of the home page", () => {
    expect(existsSync(res.screenshots.desktop!)).toBe(true);
    expect(existsSync(res.screenshots.mobile!)).toBe(true);
  });

  it("refuses private, loopback and non-http start URLs unless a test opts in", async () => {
    await expect(crawlSite("http://10.0.0.1/")).rejects.toThrow(BlockedUrlError);
    await expect(crawlSite("file:///etc/passwd")).rejects.toThrow(BlockedUrlError);
    await expect(crawlSite(`${site.origin}/`)).rejects.toThrow(BlockedUrlError);
    await expect(crawlSite("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(BlockedUrlError);
  });

  it("stops at maxPages and keeps one request per minDelayMs", async () => {
    const before = site.requests.length;
    const t0 = Date.now();
    const small = await crawlSite(`${site.origin}/`, { allowHosts: [`127.0.0.1:${site.port}`], minDelayMs: 150, maxPages: 2, maxLinkChecks: 0 });
    expect(small.pages).toHaveLength(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150 * (small.requests - 1));
    expect(site.requests.length - before).toBeGreaterThanOrEqual(small.requests);
  }, 60_000);
});
