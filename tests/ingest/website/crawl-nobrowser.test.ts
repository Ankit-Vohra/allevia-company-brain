// When Chromium cannot start (it crashed at launch in the supervised server, issue #36), the crawl reads each page from
// its HTML instead of returning empty pages that onboarding then called "almost no text".
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { crawlSite, type CrawlResult } from "../../../src/ingest/sources/website/crawl.js";
import { staticCapture } from "../../../src/ingest/sources/website/static.js";
import { selectKeyPages } from "../../../src/ingest/sources/website/understand.js";
import { whyUnreadable } from "../../../src/onboard/onboard.js";
import { startSite, type SiteServer } from "../../fixtures/website/server.js";

describe("crawlSite without a browser", () => {
  let site: SiteServer;
  let res: CrawlResult;
  const lines: string[] = [];
  let launches = 0;
  beforeAll(async () => {
    site = await startSite();
    res = await crawlSite(`${site.origin}/`, {
      allowHosts: [`127.0.0.1:${site.port}`], minDelayMs: 0, maxLinkChecks: 2, maxPages: 6, log: (l) => lines.push(l),
      launch: async () => { launches++; throw new Error("browserType.launch: Target page, context or browser has been closed\nBrowser logs:\n"); },
    });
  }, 60_000);
  afterAll(async () => { await site.close(); });

  it("still reads the pages, from their HTML, and says the browser would not start", () => {
    expect(res.pages.length).toBeGreaterThan(1);
    expect(res.pages.every((p) => !p.error)).toBe(true);
    expect(res.browserError).toMatch(/browser would not start/);
    expect(res.readWithoutBrowser).toBe(res.pages.filter((p) => p.status === 200).length);
    expect(selectKeyPages(res.pages, 1).length).toBe(1);
    expect(res.pages[0]!.text.split(/\s+/).length).toBeGreaterThan(20);
    expect(res.pages[0]!.internalLinks.length).toBeGreaterThan(0);
  });

  it("tries to start the browser once, not once per page", () => {
    expect(launches).toBe(1);
    expect(lines.some((l) => /would not start/.test(l))).toBe(true);
  });
});

describe("staticCapture", () => {
  const html = `<!doctype html><html lang="en-GB"><head><title>Prufrock &amp; Co</title><meta name="description" content="Coffee on Leather Lane">
    <meta property="og:title" content="P"><link rel="canonical" href="https://x.test/"><script type="application/ld+json">{"@type":"CafeOrCoffeeShop"}</script>
    <script>var secret = "no";</script><style>.a{}</style></head>
    <body><nav><a href="/menu">Menu</a></nav><main><h1>Hello</h1><p>We serve <b>great</b> coffee.</p><h2>Visit</h2><p>Open daily &mdash; 8 to 5.</p>
    <a href="/about">About</a><a href="https://other.test/x">Out</a><a href="#top">skip</a><img src="/a.jpg" alt="Cup" width="10" height="20"></main>
    <footer>Leather Lane, London</footer></body></html>`;
  const c = staticCapture(html, "https://x.test/");
  it("pulls the head fields, headings, links, images and JSON-LD", () => {
    expect(c.title).toBe("Prufrock & Co");
    expect(c.metaDescription).toBe("Coffee on Leather Lane");
    expect(c.lang).toBe("en-GB");
    expect(c.canonical).toBe("https://x.test/");
    expect(c.h1).toEqual(["Hello"]);
    expect(c.h2).toEqual(["Visit"]);
    expect(c.links.filter(Boolean)).toEqual(["https://x.test/menu", "https://x.test/about", "https://other.test/x"]);
    expect(c.images[0]).toMatchObject({ src: "https://x.test/a.jpg", alt: "Cup", width: 10 });
    expect(c.jsonLd).toHaveLength(1);
  });
  it("reads the words, not the scripts, styles or navigation, and keeps the footer apart", () => {
    expect(c.text).toContain("We serve great coffee.");
    expect(c.text).toContain("Open daily — 8 to 5.");
    expect(c.text).not.toMatch(/secret|\.a\{|Menu|Leather Lane, London/);
    expect(c.footer).toBe("Leather Lane, London");
  });
});

describe("whyUnreadable: pages our own reader failed on", () => {
  it("does not blame the site", () => {
    const p = { status: 200, error: "render failed: x", text: "", wordCount: 0 } as never;
    expect(whyUnreadable({ pages: [p], robots: { status: 200, disallowAll: false, sitemaps: [] } })).toMatch(/our side/);
  });
});
