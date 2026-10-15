// Crawler behaviours found by onboarding businesses nobody had hand-tuned for (docs/onboarding-trials.md, 2026-10-15):
// - a link that redirects to a login page (a SaaS "/sites" that bounces to "/login?return_to=…") was read as a page;
// - a link that redirects to a path robots.txt disallows was requested and read;
// - blog and shop listing variants (?offset=, ?page=2, ?sort=) used up the page cap on copies of one list.
import { describe, it, expect, afterAll } from "vitest";
import { crawlSite } from "../../../src/ingest/sources/website/crawl.js";
import { isListingVariant } from "../../../src/ingest/sources/website/urls.js";
import { startSite, type SiteServer } from "../../fixtures/website/server.js";

const words = "Plenty of words here for a page that says something real. ".repeat(12);
const html = (title: string, body: string) => `<!doctype html><html lang="en"><head><title>${title}</title><meta name="description" content="${title} page"></head><body><h1>${title}</h1><p>${words}</p>${body}</body></html>`;

describe("isListingVariant", () => {
  it("recognises pagination, offset, sort and filter variants of a list, and nothing else", () => {
    const v = (p: string) => isListingVariant(new URL(`https://x.example${p}`));
    expect(v("/blog?offset=1434554469000")).toBe(true);
    expect(v("/blog?page=2")).toBe(true);
    expect(v("/blog/page/3")).toBe(true);
    expect(v("/shop?sort=price-asc&page=2")).toBe(true);
    expect(v("/collections/plants?filter.p.price=10&sort_by=price")).toBe(true);
    expect(v("/blog")).toBe(false);
    expect(v("/blog?page=1")).toBe(false);          // the first page is the list itself
    expect(v("/products?id=42")).toBe(false);       // a real page that happens to use a query
    expect(v("/about")).toBe(false);
  });
});

describe("crawlSite on sites with redirects and long lists", () => {
  const sites: SiteServer[] = [];
  afterAll(async () => {
    await Promise.all(sites.map((s) => s.close()));
  });
  const run = async (routes: Parameters<typeof startSite>[0]) => {
    const site = await startSite({
      "/sitemap.xml": (send) => send(200, { "content-type": "application/xml" }, `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>`),
      "/robots.txt": (send) => send(200, { "content-type": "text/plain" }, "User-agent: *\nDisallow: /private/\n"),
      ...routes,
    });
    sites.push(site);
    const crawl = await crawlSite(`${site.origin}/`, { allowHosts: [`127.0.0.1:${site.port}`], minDelayMs: 0, maxPages: 20, maxLinkChecks: 0 });
    return { site, crawl };
  };
  const ok = (send: (s: number, h: Record<string, string>, b?: string) => void, title: string, body = "") => send(200, { "content-type": "text/html" }, html(title, body));

  it("does not read a page that redirects to a login, and does not follow it there", async () => {
    const { site, crawl } = await run({
      "/": (send) => ok(send, "Home", `<a href="/members">Members</a><a href="/about">About</a>`),
      "/about": (send) => ok(send, "About"),
      "/members": (send) => send(302, { location: "/login?return_to=%2Fmembers" }),
      "/login": (send) => ok(send, "Sign in"),
    });
    expect(crawl.pages.map((p) => new URL(p.finalUrl).pathname).sort()).toEqual(["/", "/about"]);
    expect(site.requests.some((q) => q.path === "/login")).toBe(false);
    expect(crawl.skipped).toContainEqual({ url: `${site.origin}/members`, reason: expect.stringMatching(/login/i) });
  }, 60_000);

  it("does not request a page that redirects into a path robots.txt disallows", async () => {
    const { site, crawl } = await run({
      "/": (send) => ok(send, "Home", `<a href="/old-press">Press</a>`),
      "/old-press": (send) => send(301, { location: "/private/press-archive" }),
      "/private/press-archive": (send) => ok(send, "Private archive"),
    });
    expect(crawl.pages.map((p) => new URL(p.finalUrl).pathname)).toEqual(["/"]);
    expect(site.requests.some((q) => q.path === "/private/press-archive")).toBe(false);
    expect(crawl.skipped).toContainEqual({ url: `${site.origin}/old-press`, reason: expect.stringMatching(/robots/i) });
  }, 60_000);

  it("spends the page cap on pages, not on copies of one list", async () => {
    const { crawl } = await run({
      "/": (send) => ok(send, "Home", `<a href="/blog">Blog</a><a href="/blog?offset=111">Older</a><a href="/blog?page=2">Page 2</a><a href="/blog?sort=newest">Newest</a><a href="/blog/first-post">First</a>`),
      "/blog": (send) => ok(send, "Blog", `<a href="/blog?offset=222">Older</a><a href="/blog/page/2">2</a>`),
      "/blog/first-post": (send) => ok(send, "First post"),
    });
    expect(crawl.pages.map((p) => new URL(p.finalUrl).pathname + new URL(p.finalUrl).search).sort()).toEqual(["/", "/blog", "/blog/first-post"]);
    expect(crawl.skipped.filter((s) => /listing/i.test(s.reason)).length).toBeGreaterThanOrEqual(3);
  }, 60_000);
});
