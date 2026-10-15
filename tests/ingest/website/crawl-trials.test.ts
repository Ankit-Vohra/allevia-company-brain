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
  const run = (routes: Parameters<typeof startSite>[0]) => runWith({}, routes);
  const runWith = async (opts: Partial<Parameters<typeof crawlSite>[1]>, routes: Parameters<typeof startSite>[0]) => {
    const site = await startSite({
      "/sitemap.xml": (send) => send(200, { "content-type": "application/xml" }, `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>`),
      "/robots.txt": (send) => send(200, { "content-type": "text/plain" }, "User-agent: *\nDisallow: /private/\n"),
      ...routes,
    });
    sites.push(site);
    const crawl = await crawlSite(`${site.origin}/`, { allowHosts: [`127.0.0.1:${site.port}`], minDelayMs: 0, maxPages: 40, maxLinkChecks: 0, ...opts });
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

  it("leaves room for the rest of the site when one section (a shop's catalogue) has far more pages than the cap", async () => {
    const range = Array.from({ length: 25 }, (_, i) => `/range/item-${i}`);
    const routes: Parameters<typeof startSite>[0] = {
      "/": (send) => ok(send, "Home", [...range, "/stories/our-farm", "/stories/the-team", "/stories/visiting"].map((p) => `<a href="${p}">${p}</a>`).join("")),
    };
    for (const p of [...range, "/stories/our-farm", "/stories/the-team", "/stories/visiting"]) routes[p] = (send) => ok(send, p);
    const site = await startSite({
      "/sitemap.xml": (send) => send(200, { "content-type": "application/xml" }, `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>`),
      ...routes,
    });
    sites.push(site);
    const crawl = await crawlSite(`${site.origin}/`, { allowHosts: [`127.0.0.1:${site.port}`], minDelayMs: 0, maxPages: 12, maxLinkChecks: 0 });
    const paths = crawl.pages.map((p) => new URL(p.finalUrl).pathname);
    expect(paths).toHaveLength(12);
    expect(paths).toEqual(expect.arrayContaining(["/stories/our-farm", "/stories/the-team", "/stories/visiting"]));
    expect(paths.filter((p) => p.startsWith("/range/")).length).toBeLessThanOrEqual(8);
  }, 60_000);

  it("gives up on a page whose script never lets go, keeps what it has, and carries on with the rest", async () => {
    const { crawl } = await runWith({ pageTimeoutMs: 2_000 }, {
      "/": (send) => ok(send, "Home", `<a href="/stuck">Stuck</a><a href="/about">About</a>`),
      "/stuck": (send) => send(200, { "content-type": "text/html" }, html("Stuck", `<script>while (true) {}</script>`)),
      "/about": (send) => ok(send, "About"),
    });
    const by = Object.fromEntries(crawl.pages.map((p) => [new URL(p.finalUrl).pathname, p]));
    expect(by["/about"]!.error).toBeUndefined();
    expect(by["/stuck"]!.error).toMatch(/render failed/);
  }, 60_000);

  it("stops taking new pages when the whole crawl has used its time, and says so", async () => {
    const links = Array.from({ length: 30 }, (_, i) => `/p${i}`);
    const routes: Parameters<typeof startSite>[0] = { "/": (send) => ok(send, "Home", links.map((p) => `<a href="${p}">${p}</a>`).join("")) };
    for (const p of links) routes[p] = (send) => ok(send, p);
    const t0 = Date.now();
    const { crawl } = await runWith({ maxCrawlMs: 2_500, minDelayMs: 300 }, routes);
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(crawl.pages.length).toBeGreaterThanOrEqual(2);
    expect(crawl.pages.length).toBeLessThan(31);
    expect(crawl.timedOut).toBe(true);
  }, 60_000);
});
