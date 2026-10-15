// The website crawler (spec §6.2, M5): Playwright Chromium, one site, polite.
// - robots.txt first (RFC 9309, see robots.ts), then the home page, then sitemap.xml, then same-site links, most
//   telling pages first (urls.ts keyPagePriority), so a page cap never drops "About".
// - At most one crawler request per second (robots, sitemaps, pages, link checks; Crawl-delay can only slow it),
//   at most maxPages pages, pageTimeoutMs per page, binaries, logins and carts left alone.
// - The browser never touches the network: every request it makes is answered from guardedFetch (fetch.ts), so the
//   SSRF rules, size caps and user agent hold for scripts, styles and images too. It may only GET; navigations away
//   from the page, iframes, media, websockets and beacons are refused. Images and fonts load only on the few brand
//   pages (home plus key pages) where colours, fonts, the logo and screenshots are read; other assets are cached for
//   the whole crawl and fetched at most six at a time (a browser's own per-host limit).
// - Home-page screenshots (desktop and mobile) go to screenshotDir (under data/, never committed).
// `launch`, `resolver` and `allowHosts` make it testable against a local static server.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { chromium, type Browser, type BrowserContext, type Route } from "playwright";
import { BlockedUrlError, Pacer, USER_AGENT, checkUrl, guardedFetch, type FetchOpts, type FetchResult, type Resolver } from "./fetch.js";
import { allowAll, disallowAll, parseRobots, parseSitemap, type Robots } from "./robots.js";
import { CAPTURE_SCRIPT, STYLE_SCRIPT, fromCapture, type Captured, type PageData, type StyleSample } from "./page.js";
import { isActionPath, isBinaryPath, keyPagePriority, normalizeUrl, toSiteUrl } from "./urls.js";
import { Semaphore } from "../../llm.js";

export interface CrawlOptions {
  maxPages?: number;          // default 40
  pageTimeoutMs?: number;     // default 20 s
  minDelayMs?: number;        // default 1000: at most one crawler request per second
  maxHtmlBytes?: number;      // default 3 MB
  maxAssetBytes?: number;     // default 6 MB per script/style/image
  maxLinkChecks?: number;     // default 10 internal links outside the crawl, checked with HEAD
  brandPages?: number;        // default 3: home plus key pages whose styles are sampled
  allowHosts?: string[];      // exact "host:port" pairs that may be private (tests only)
  resolver?: Resolver;
  userAgent?: string;
  screenshotDir?: string;
  onPage?: (p: PageData) => void | Promise<void>;
  launch?: () => Promise<Browser>;
  log?: (line: string) => void;
}

export interface CrawlResult {
  startUrl: string;
  origin: string;
  pages: PageData[];
  skipped: Array<{ url: string; reason: string }>;
  robots: { status: number | null; disallowAll: boolean; crawlDelayMs?: number; sitemaps: string[] };
  sitemapUrls: number;
  linkStatus: Record<string, number>;   // internal URL → final HTTP status (0 = unreachable), crawled or link-checked
  screenshots: { desktop?: string; mobile?: string };
  requests: number;                      // crawler requests (not counting the browser's assets)
  startedAt: string;
  finishedAt: string;
}

const DEFAULTS = {
  maxPages: 40, pageTimeoutMs: 20_000, minDelayMs: 1_000, maxHtmlBytes: 3 * 1024 * 1024, maxAssetBytes: 6 * 1024 * 1024,
  maxLinkChecks: 10, brandPages: 3,
};
const MAX_CRAWL_DELAY_MS = 10_000;
const MAX_SITEMAPS = 5;
const MAX_QUEUE = 2_000;
const MAX_ASSETS_PER_PAGE = 150;
const MAX_ASSET_CACHE_BYTES = 80 * 1024 * 1024;
const BROWSER_TYPES = new Set(["stylesheet", "script", "xhr", "fetch", "image", "font"]);
const DROP_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive", "set-cookie", "alt-svc"]);

const passHeaders = (h: Record<string, string>) => Object.fromEntries(Object.entries(h).filter(([k]) => !DROP_HEADERS.has(k)));
const pathOf = (url: string) => {
  const u = new URL(url);
  return u.pathname + u.search;
};
const isHtml = (r: FetchResult) => {
  const ct = (r.headers["content-type"] ?? "").toLowerCase();
  if (ct) return ct.includes("text/html") || ct.includes("application/xhtml+xml");
  return /^\s*(<!doctype html|<html)/i.test(r.body.subarray(0, 512).toString("utf8"));
};
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function emptyPage(url: string, r: FetchResult, error?: string): PageData {
  return {
    url, finalUrl: normalizeUrl(r.finalUrl) ?? r.finalUrl, redirects: r.redirects, status: r.status, contentType: r.headers["content-type"],
    fetchedAt: new Date().toISOString(), bytes: r.body.length, ...(r.truncated ? { truncated: true } : {}),
    titleCount: 0, metaDescriptionCount: 0, h1: [], h2: [], text: "", wordCount: 0, internalLinks: [], externalLinks: [], images: [],
    jsonLd: [], jsonLdTypes: [], jsonLdErrors: 0, og: {}, timing: { responseMs: r.responseMs, fetchMs: r.totalMs }, mixedContent: [],
    ...(r.headers["x-robots-tag"] ? { robotsMeta: r.headers["x-robots-tag"] } : {}), ...(error ? { error } : {}),
  };
}

export async function crawlSite(startUrl: string, opts: CrawlOptions = {}): Promise<CrawlResult> {
  const o = { ...DEFAULTS, ...opts };
  const allow = o.allowHosts ?? [];
  const ua = o.userAgent ?? USER_AGENT;
  const log = o.log ?? (() => {});
  const base: FetchOpts = { allowHosts: allow, resolver: o.resolver, userAgent: ua };
  const start = checkUrl(normalizeUrl(startUrl) ?? startUrl, allow).toString(); // throws BlockedUrlError
  const startedAt = new Date().toISOString();
  const pacer = new Pacer(o.minDelayMs);
  let requests = 0;
  const skipped: CrawlResult["skipped"] = [];
  const pages: PageData[] = [];
  const statusByUrl = new Map<string, number>();
  const screenshots: CrawlResult["screenshots"] = {};
  let sitemapCount = 0;
  let robotsInfo: CrawlResult["robots"] = { status: null, disallowAll: false, sitemaps: [] };

  const crawlerFetch = async (url: string, extra: FetchOpts = {}): Promise<FetchResult> => {
    await pacer.wait();
    requests++;
    return guardedFetch(url, { ...base, timeoutMs: o.pageTimeoutMs, maxBytes: o.maxHtmlBytes, ...extra });
  };

  const loadRobots = async (origin: string): Promise<Robots> => {
    let robots: Robots;
    let status: number | null = null;
    try {
      const r = await crawlerFetch(`${origin}/robots.txt`, { maxBytes: 512 * 1024, accept: "text/plain,*/*;q=0.5" });
      status = r.status;
      robots = r.status >= 200 && r.status < 300 ? parseRobots(r.body.toString("utf8"))
        : r.status >= 400 && r.status < 500 ? allowAll() : disallowAll();
    } catch (e) {
      if (e instanceof BlockedUrlError) throw e;
      robots = disallowAll(); // unreachable robots.txt: RFC 9309 says assume complete disallow
      log(`[crawl] robots.txt unreachable (${msg(e)}): nothing is crawled`);
    }
    if (robots.crawlDelayMs) pacer.slowTo(Math.min(robots.crawlDelayMs, MAX_CRAWL_DELAY_MS));
    robotsInfo = { status, disallowAll: robots.disallowAll, sitemaps: robots.sitemaps, ...(robots.crawlDelayMs ? { crawlDelayMs: robots.crawlDelayMs } : {}) };
    return robots;
  };

  let origin = new URL(start).origin;
  let robots = await loadRobots(origin);

  // ---------- browser ----------
  let browser: Browser | undefined;
  let ctx: BrowserContext | undefined;
  const docs = new Map<string, FetchResult>();
  let heavy = false;
  let assetCount = 0;
  const assets = new Map<string, Promise<FetchResult | null>>();
  let cachedBytes = 0;
  const assetSem = new Semaphore(6);
  const asset = (url: string): Promise<FetchResult | null> => {
    const hit = assets.get(url);
    if (hit) return hit;
    const p = assetSem.run(() => guardedFetch(url, { ...base, maxBytes: o.maxAssetBytes, timeoutMs: 15_000, accept: "*/*" }))
      .then((r) => (r.truncated ? null : r), () => null);
    if (cachedBytes < MAX_ASSET_CACHE_BYTES) {
      assets.set(url, p);
      void p.then((r) => { cachedBytes += r?.body.length ?? 0; });
    }
    return p;
  };
  const handleRoute = async (route: Route): Promise<void> => {
    try {
      const req = route.request();
      const url = req.url();
      if (req.isNavigationRequest()) {
        const d = req.frame().parentFrame() === null ? docs.get(url) : undefined;
        if (d) return await route.fulfill({ status: d.status, headers: passHeaders(d.headers), body: d.body });
        return await route.abort("blockedbyclient");
      }
      const type = req.resourceType();
      if (req.method() !== "GET" || !BROWSER_TYPES.has(type) || (!heavy && (type === "image" || type === "font"))
        || !/^https?:/i.test(url) || ++assetCount > MAX_ASSETS_PER_PAGE) {
        return await route.abort("blockedbyclient");
      }
      const r = await asset(url);
      if (!r) return await route.abort("failed");
      return await route.fulfill({ status: r.status, headers: passHeaders(r.headers), body: r.body });
    } catch {
      await route.abort("failed").catch(() => {});
    }
  };
  const newContext = async (mobile: boolean): Promise<BrowserContext> => {
    browser ??= await (o.launch ?? (() => chromium.launch({ headless: true })))();
    const c = await browser.newContext({
      userAgent: ua, locale: "en-US", serviceWorkers: "block", acceptDownloads: false, javaScriptEnabled: true,
      ...(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1366, height: 900 } }),
    });
    await c.route("**/*", handleRoute);
    return c;
  };

  const render = async (doc: FetchResult, brand: boolean, home: boolean, deadline: number) => {
    ctx ??= await newContext(false);
    docs.clear();
    docs.set(doc.finalUrl, doc);
    heavy = brand;
    assetCount = 0;
    const page = await ctx.newPage();
    const t0 = performance.now();
    const left = () => Math.max(1_000, deadline - Date.now());
    try {
      try {
        await page.goto(doc.finalUrl, { waitUntil: "domcontentloaded", timeout: left() });
      } catch (e) {
        if (!/timeout/i.test(msg(e))) throw e;
        log(`[crawl] ${doc.finalUrl} still loading at the deadline; reading what has rendered`);
      }
      await page.waitForLoadState("load", { timeout: left() }).catch(() => {});
      const loadMs = Math.round(performance.now() - t0);
      if (brand) await page.waitForLoadState("networkidle", { timeout: Math.min(2_500, left()) }).catch(() => {});
      if (home && o.screenshotDir) {
        mkdirSync(o.screenshotDir, { recursive: true });
        screenshots.desktop = join(o.screenshotDir, "home-desktop.png");
        await page.screenshot({ path: screenshots.desktop, timeout: left() }).catch((e) => { delete screenshots.desktop; log(`[crawl] desktop screenshot failed: ${msg(e)}`); });
      }
      const styles = brand ? ((await page.evaluate(STYLE_SCRIPT)) as StyleSample[]) : undefined;
      const cap = (await page.evaluate(CAPTURE_SCRIPT)) as Captured;
      return { cap, styles, loadMs };
    } finally {
      await page.close().catch(() => {});
    }
  };

  const mobileShot = async (doc: FetchResult): Promise<void> => {
    if (!o.screenshotDir) return;
    const m = await newContext(true);
    try {
      docs.clear();
      docs.set(doc.finalUrl, doc);
      heavy = true;
      assetCount = 0;
      const p = await m.newPage();
      await p.goto(doc.finalUrl, { waitUntil: "load", timeout: o.pageTimeoutMs });
      await p.waitForLoadState("networkidle", { timeout: 2_500 }).catch(() => {});
      const path = join(o.screenshotDir, "home-mobile.png");
      await p.screenshot({ path });
      screenshots.mobile = path;
    } catch (e) {
      log(`[crawl] mobile screenshot failed: ${msg(e)}`);
    } finally {
      await m.close().catch(() => {});
    }
  };

  // ---------- queue ----------
  interface Item { url: string; prio: number; depth: number; seq: number }
  const queue = new Map<string, Item>();
  const seen = new Set<string>();
  let seq = 0;
  const skip = (url: string, reason: string) => {
    if (skipped.length < 500) skipped.push({ url, reason });
  };
  const enqueue = (raw: string, depth: number): void => {
    const n = normalizeUrl(raw);
    const site = n ? toSiteUrl(n, origin) : null;
    if (!site || seen.has(site) || queue.size >= MAX_QUEUE) return;
    seen.add(site);
    const u = new URL(site);
    if (isBinaryPath(u.pathname)) return skip(site, "binary file");
    if (isActionPath(u)) return skip(site, "login, cart, search or admin path");
    if (!robots.isAllowed(pathOf(site))) return skip(site, "disallowed by robots.txt");
    queue.set(site, { url: site, prio: keyPagePriority(u), depth, seq: seq++ });
  };
  const next = (): Item | undefined => {
    let best: Item | undefined;
    for (const it of queue.values()) {
      if (!best || it.prio > best.prio || (it.prio === best.prio && (it.depth < best.depth || (it.depth === best.depth && it.seq < best.seq)))) best = it;
    }
    if (best) queue.delete(best.url);
    return best;
  };

  let brandCount = 0;
  const visit = async (it: Item, first: boolean): Promise<void> => {
    const deadline = Date.now() + o.pageTimeoutMs;
    let doc: FetchResult;
    try {
      doc = await crawlerFetch(it.url);
    } catch (e) {
      statusByUrl.set(it.url, 0);
      return skip(it.url, e instanceof BlockedUrlError ? `refused: ${e.message}` : `fetch failed: ${msg(e)}`);
    }
    const final = normalizeUrl(doc.finalUrl) ?? doc.finalUrl;
    if (first && new URL(final).origin !== origin) {
      // the address the owner typed redirects (apex to www, http to https, an old domain): crawl where it lands
      log(`[crawl] ${it.url} redirects to ${final}; crawling ${new URL(final).origin}`);
      origin = new URL(final).origin;
      robots = await loadRobots(origin);
      if (!robots.isAllowed(pathOf(final))) return skip(final, "disallowed by robots.txt");
    }
    const site = toSiteUrl(final, origin);
    if (!site) {
      statusByUrl.set(it.url, doc.status);
      return skip(it.url, `redirects off-site to ${final}`);
    }
    statusByUrl.set(it.url, doc.status);
    statusByUrl.set(site, doc.status);
    seen.add(site);
    if (pages.some((p) => p.finalUrl === site)) return skip(it.url, `redirects to ${site}, already crawled`);
    if (doc.status >= 200 && doc.status < 300 && !isHtml(doc)) return skip(site, `not an HTML page (${doc.headers["content-type"] ?? "no content type"})`);

    let page: PageData;
    if (doc.status < 200 || doc.status >= 300) {
      page = emptyPage(it.url, doc);
    } else {
      const brand = first || (brandCount < o.brandPages - 1 && it.prio >= 70);
      try {
        const { cap, styles, loadMs } = await render({ ...doc, finalUrl: site }, brand, first, deadline);
        if (brand && !first) brandCount++;
        const dom = fromCapture(cap, origin);
        const xrt = doc.headers["x-robots-tag"];
        page = {
          ...emptyPage(it.url, doc), ...dom, finalUrl: site,
          ...(xrt ? { robotsMeta: [dom.robotsMeta, xrt].filter(Boolean).join(", ") } : {}),
          timing: { responseMs: doc.responseMs, fetchMs: doc.totalMs, loadMs }, ...(styles ? { styles } : {}),
        };
        if (first) await mobileShot({ ...doc, finalUrl: site });
      } catch (e) {
        page = { ...emptyPage(it.url, doc, `render failed: ${msg(e)}`), finalUrl: site };
      }
    }
    pages.push(page);
    log(`[crawl] ${page.status} ${site}${page.title ? ` "${page.title}"` : ""}`);
    if (o.onPage) await o.onPage(page);
    if (/\bnofollow\b|\bnone\b/i.test(page.robotsMeta ?? "")) return;
    for (const l of page.internalLinks) enqueue(l, it.depth + 1);
  };

  try {
    if (!robots.isAllowed(pathOf(start))) {
      skip(start, "disallowed by robots.txt");
    } else {
      seen.add(start);
      await visit({ url: start, prio: 100, depth: 0, seq: seq++ }, true);
      if (pages.length) {
        // sitemaps: robots.txt's (same site only), else /sitemap.xml
        const sitemapQueue = [...new Set([...robots.sitemaps.map((s) => normalizeUrl(s)).filter((s): s is string => !!s && !!toSiteUrl(s, origin)), `${origin}/sitemap.xml`])];
        let fetched = 0;
        let found = 0;
        while (sitemapQueue.length && fetched < MAX_SITEMAPS) {
          const sm = sitemapQueue.shift()!;
          if (!robots.isAllowed(pathOf(sm))) continue;
          try {
            const r = await crawlerFetch(sm, { maxBytes: 5 * 1024 * 1024, accept: "application/xml,text/xml;q=0.9,*/*;q=0.5" });
            fetched++;
            if (r.status !== 200) continue;
            const gz = sm.endsWith(".gz") || /gzip/i.test(r.headers["content-type"] ?? "");
            const xml = gz ? gunzipSync(r.body, { maxOutputLength: 20 * 1024 * 1024 }).toString("utf8") : r.body.toString("utf8");
            const p = parseSitemap(xml);
            for (const u of p.urls) {
              found++;
              enqueue(u, 1);
            }
            for (const s of p.sitemaps) {
              const n = normalizeUrl(s);
              if (n && toSiteUrl(n, origin)) sitemapQueue.push(n);
            }
          } catch (e) {
            log(`[crawl] sitemap ${sm}: ${msg(e)}`);
          }
        }
        sitemapCount = found;
        for (let it = next(); it && pages.length < o.maxPages; it = next()) await visit(it, false);

        // internal links the crawl did not reach: a few HEAD checks, so broken links are found beyond the page cap
        const targets = [...new Set(pages.flatMap((p) => p.internalLinks))].filter((u) => !statusByUrl.has(u) && !skipped.some((s) => s.url === u));
        let checks = 0;
        for (const t of targets) {
          if (checks >= o.maxLinkChecks) break;
          const u = new URL(t);
          if (isBinaryPath(u.pathname) || isActionPath(u) || !robots.isAllowed(pathOf(t))) continue;
          checks++;
          try {
            let r = await crawlerFetch(t, { method: "HEAD" });
            if (r.status === 405 || r.status === 501) r = await crawlerFetch(t, { maxBytes: 64 * 1024 });
            statusByUrl.set(t, r.status);
          } catch (e) {
            statusByUrl.set(t, 0);
            if (e instanceof BlockedUrlError) skip(t, `refused: ${e.message}`);
          }
        }
      }
    }
  } finally {
    await browser?.close().catch(() => {});
  }

  return {
    startUrl: start, origin, pages, skipped, robots: robotsInfo, sitemapUrls: sitemapCount,
    linkStatus: Object.fromEntries(statusByUrl), screenshots, requests, startedAt, finishedAt: new Date().toISOString(),
  };
}

