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
import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright";
import { BlockedUrlError, Pacer, RedirectRefusedError, USER_AGENT, checkUrl, guardedFetch, type FetchOpts, type FetchResult, type Resolver } from "./fetch.js";
import { allowAll, disallowAll, parseRobots, parseSitemap, type Robots } from "./robots.js";
import { CONVERSION_SCRIPT, redactCapture, type ConversionCapture } from "../../../checkup/conversion.js";
import { CAPTURE_SCRIPT, STYLE_SCRIPT, fromCapture, type Captured, type PageData, type StyleSample } from "./page.js";
import { isActionPath, isBinaryPath, isListingVariant, keyPagePriority, normalizeUrl, sectionOf, toSiteUrl } from "./urls.js";
import { Semaphore } from "../../llm.js";

export interface CrawlOptions {
  maxPages?: number;          // default 40
  pageTimeoutMs?: number;     // default 20 s
  minDelayMs?: number;        // default 1000: at most one crawler request per second
  maxHtmlBytes?: number;      // default 3 MB
  maxAssetBytes?: number;     // default 6 MB per script/style/image
  maxLinkChecks?: number;     // default 10 internal links outside the crawl, checked with HEAD
  maxCrawlMs?: number;        // default 5 minutes for the whole crawl: after that no new page is taken
  brandPages?: number;        // default 3: home plus key pages whose styles are sampled
  allowHosts?: string[];      // exact "host:port" pairs that may be private (tests only)
  resolver?: Resolver;
  userAgent?: string;
  screenshotDir?: string;
  // the website check-up: on the home and key pages (the brand pages), also read what a visitor ready to buy sees
  // (src/checkup/conversion.ts), at desktop size and at phone size
  conversion?: boolean;
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
  timedOut?: boolean;                    // the crawl used its whole time budget (maxCrawlMs) and stopped taking new pages
  startedAt: string;
  finishedAt: string;
}

const DEFAULTS = {
  maxPages: 40, pageTimeoutMs: 20_000, minDelayMs: 1_000, maxHtmlBytes: 3 * 1024 * 1024, maxAssetBytes: 6 * 1024 * 1024,
  maxLinkChecks: 10, brandPages: 3, maxCrawlMs: 5 * 60_000,
};
const MAX_CRAWL_DELAY_MS = 10_000;
const MAX_SITEMAPS = 5;
const MAX_QUEUE = 2_000;
// Per page and per resource type: a page with hundreds of images must not crowd out its stylesheets.
const ASSET_CAPS: Record<string, number> = { stylesheet: 40, script: 150, font: 30, image: 80, xhr: 60, fetch: 60 };
const MAX_ASSET_CACHE_BYTES = 80 * 1024 * 1024;
// Request headers a page's own scripts set that change what the server answers (Next.js RSC fetches answer HTML
// without them, and the app then hard-reloads). Nothing that identifies a user is forwarded.
const FORWARD_HEADERS = ["accept", "rsc", "next-router-state-tree", "next-url", "x-requested-with"];
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
  const crawlStart = Date.now();
  let timedOut = false;
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
  let assetCounts = new Map<string, Set<string>>();
  let tally = new Map<string, number>(); // per page: "served:script", "refused:media", "failed:stylesheet: <reason>"
  const note = (k: string) => tally.set(k, (tally.get(k) ?? 0) + 1);
  const assetErrors = new Map<string, string>();
  const assets = new Map<string, Promise<FetchResult | null>>();
  let cachedBytes = 0;
  // Two pools: what the page needs to render (styles, scripts, fonts, data) never waits behind large images.
  const criticalSem = new Semaphore(6);
  const imageSem = new Semaphore(4);
  const asset = (url: string, type: string, headers: Record<string, string>): Promise<FetchResult | null> => {
    const key = Object.keys(headers).length ? `${url}\n${JSON.stringify(headers)}` : url;
    const hit = assets.get(key);
    if (hit) return hit;
    const p = (type === "image" ? imageSem : criticalSem).run(() => guardedFetch(url, { ...base, maxBytes: o.maxAssetBytes, timeoutMs: 15_000, accept: "*/*", headers }))
      .then((r) => {
        if (r.truncated) assetErrors.set(url, `over ${o.maxAssetBytes} bytes`);
        return r.truncated ? null : r;
      }, (e: unknown) => {
        assetErrors.set(url, msg(e));
        return null;
      });
    if (cachedBytes < MAX_ASSET_CACHE_BYTES) {
      assets.set(key, p);
      void p.then((r) => { cachedBytes += r?.body.length ?? 0; });
    }
    return p;
  };
  const handleRoute = async (route: Route): Promise<void> => {
    try {
      const req = route.request();
      const url = req.url();
      if (req.isNavigationRequest()) {
        const main = req.frame().parentFrame() === null;
        const d = main ? docs.get(url) : undefined;
        if (d) {
          docs.delete(url); // served once per page view: a reload, or a loop of them, is refused
          return await route.fulfill({ status: d.status, headers: passHeaders(d.headers), body: d.body });
        }
        note("refused:navigation");
        // 204 No Content cancels a main-frame navigation and leaves the page as it is (an abort would replace it with
        // the browser's error page); frames are simply blocked
        return main ? await route.fulfill({ status: 204, body: "" }) : await route.abort("blockedbyclient");
      }
      const type = req.resourceType();
      const h = req.headers();
      // a framework prefetching other routes (Next.js router, speculation rules) is page-like traffic the pacer never
      // sees, and nothing the current page needs
      const prefetch = !!h["next-router-prefetch"] || /prefetch|prerender/i.test(`${h["purpose"] ?? ""} ${h["sec-purpose"] ?? ""}`);
      const refuse = req.method() !== "GET" ? req.method()
        : !BROWSER_TYPES.has(type) || (!heavy && (type === "image" || type === "font")) || !/^https?:/i.test(url) ? type
        : prefetch ? "prefetch" : undefined;
      if (refuse) {
        note(`refused:${refuse}`);
        return await route.abort("blockedbyclient");
      }
      // capped by distinct URLs: a script asked for twice (preload, then the tag) is one script
      const seenOfType = assetCounts.get(type) ?? new Set<string>();
      assetCounts.set(type, seenOfType);
      if (!seenOfType.has(url) && seenOfType.size >= (ASSET_CAPS[type] ?? 0)) {
        note(`capped:${type}`);
        return await route.abort("blockedbyclient");
      }
      seenOfType.add(url);
      const fwd = type === "xhr" || type === "fetch" ? Object.fromEntries(FORWARD_HEADERS.flatMap((k) => (h[k] ? [[k, h[k]!]] : []))) : {};
      const r = await asset(url, type, fwd);
      if (!r) {
        note(`failed:${type}${type === "stylesheet" || type === "script" ? ` ${assetErrors.get(url) ?? ""}` : ""}`);
        return await route.abort("failed");
      }
      note(`served:${type}`);
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

  // A page whose script never lets go (a busy loop) can hang the browser's own calls, which have no timeout of their
  // own: give each browser job a hard limit, and when it passes drop the whole context (and with it the stuck page).
  const hardLimit = async <T,>(job: Promise<T>, why: string): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const stuck = ctx;
        ctx = undefined;
        void stuck?.close().catch(() => {});
        reject(new Error(`${why} within ${Math.round((o.pageTimeoutMs + 12_000) / 1000)} s`));
      }, o.pageTimeoutMs + 12_000);
    });
    job.catch(() => {}); // a job that fails after the limit is not an unhandled rejection
    try {
      return await Promise.race([job, limit]);
    } finally {
      clearTimeout(timer);
    }
  };

  const render = async (doc: FetchResult, brand: boolean, home: boolean, deadline: number) => {
    ctx ??= await newContext(false);
    docs.clear();
    docs.set(doc.finalUrl, doc);
    heavy = brand;
    assetCounts = new Map();
    tally = new Map();
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
      const unloaded = brand ? await stylesReady(page, Math.min(4_000, left())) : 0;
      if (home && o.screenshotDir) {
        mkdirSync(o.screenshotDir, { recursive: true });
        screenshots.desktop = join(o.screenshotDir, "home-desktop.png");
        await page.screenshot({ path: screenshots.desktop, timeout: left() }).catch((e) => { delete screenshots.desktop; log(`[crawl] desktop screenshot failed: ${msg(e)}`); });
      }
      // computed styles of a page whose stylesheets never arrived are the browser's defaults, not the brand's
      if (unloaded) log(`[crawl] ${doc.finalUrl}: ${unloaded} stylesheet(s) did not load; its styles are not sampled`);
      const styles = brand && !unloaded ? ((await page.evaluate(STYLE_SCRIPT)) as StyleSample[]) : undefined;
      const cap = (await page.evaluate(CAPTURE_SCRIPT)) as Captured;
      const conv = brand && o.conversion ? await readConversion(page, log) : undefined;
      return { cap, styles, loadMs, conv };
    } finally {
      log(`[crawl] assets for ${doc.finalUrl}: ${[...tally].sort().map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`);
      await page.close().catch(() => {});
    }
  };

  const mobileShot = async (doc: FetchResult, shot = true): Promise<ConversionCapture | undefined> => {
    const wantShot = shot && !!o.screenshotDir;
    if (!wantShot && !o.conversion) return undefined;
    const m = await newContext(true);
    try {
      docs.clear();
      docs.set(doc.finalUrl, doc);
      heavy = true;
      assetCounts = new Map();
      tally = new Map();
      const p = await m.newPage();
      await p.goto(doc.finalUrl, { waitUntil: "load", timeout: o.pageTimeoutMs });
      await p.waitForLoadState("networkidle", { timeout: 2_500 }).catch(() => {});
      const unloaded = await stylesReady(p, 4_000);
      if (unloaded) log(`[crawl] mobile view: ${unloaded} stylesheet(s) did not load`);
      if (wantShot) {
        const path = join(o.screenshotDir!, "home-mobile.png");
        await p.screenshot({ path });
        screenshots.mobile = path;
      }
      const conv = o.conversion ? await readConversion(p, log) : undefined;
      log(`[crawl] assets for the mobile view: ${[...tally].sort().map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`);
      return conv;
    } catch (e) {
      log(`[crawl] mobile view failed: ${msg(e)}`);
      return undefined;
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
    if (isListingVariant(u)) return skip(site, "listing variant: another page, sort or filter of a list already read");
    if (!robots.isAllowed(pathOf(site))) return skip(site, "disallowed by robots.txt");
    queue.set(site, { url: site, prio: keyPagePriority(u), depth, seq: seq++ });
  };
  // A catalogue or a blog can have hundreds of pages that all say the same kind of thing. Once a section has used its
  // share of the page cap, pages from other sections go first; its own pages only fill what is left.
  const sectionCap = Math.max(8, Math.ceil(o.maxPages * 0.3));
  const sectionCount = new Map<string, number>();
  const overCap = (it: Item): boolean => {
    const sec = sectionOf(new URL(it.url));
    return !!sec && (sectionCount.get(sec) ?? 0) >= sectionCap;
  };
  const next = (): Item | undefined => {
    let best: Item | undefined;
    let bestOver = false;
    for (const it of queue.values()) {
      const over = overCap(it);
      const wins = !best || (bestOver && !over) || (bestOver === over && (it.prio > best.prio || (it.prio === best.prio && (it.depth < best.depth || (it.depth === best.depth && it.seq < best.seq)))));
      if (wins) {
        best = it;
        bestOver = over;
      }
    }
    if (best) queue.delete(best.url);
    return best;
  };

  let brandCount = 0;
  const visit = async (it: Item, first: boolean): Promise<void> => {
    const deadline = Date.now() + o.pageTimeoutMs;
    let doc: FetchResult;
    // Every redirect hop is judged before it is followed: a link that bounces to a login page, off the site or into a
    // path robots.txt disallows is never requested. (The start URL may move origin: apex to www, http to https.)
    const hopCheck = (n: URL): string | undefined => {
      const to = toSiteUrl(normalizeUrl(n.toString()) ?? n.toString(), origin);
      if (!to) return `redirects off-site to ${n.origin}`;
      const t = new URL(to);
      if (isActionPath(t)) return `redirects to a login, cart or admin page (${t.pathname})`;
      if (!robots.isAllowed(pathOf(to))) return `redirects to ${t.pathname}, which robots.txt disallows`;
      return undefined;
    };
    try {
      doc = await crawlerFetch(it.url, first ? {} : { hopCheck });
    } catch (e) {
      statusByUrl.set(it.url, 0);
      if (e instanceof RedirectRefusedError) return skip(it.url, e.message);
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
        const { cap, styles, loadMs, conv } = await hardLimit(render({ ...doc, finalUrl: site }, brand, first, deadline), "the page never finished");
        if (brand && !first) brandCount++;
        const dom = fromCapture(cap, origin);
        const xrt = doc.headers["x-robots-tag"];
        page = {
          ...emptyPage(it.url, doc), ...dom, finalUrl: site,
          ...(xrt ? { robotsMeta: [dom.robotsMeta, xrt].filter(Boolean).join(", ") } : {}),
          timing: { responseMs: doc.responseMs, fetchMs: doc.totalMs, loadMs }, ...(styles ? { styles } : {}),
        };
        if (first || (brand && o.conversion)) {
          const mobile = await hardLimit(mobileShot({ ...doc, finalUrl: site }, first), "the mobile view never finished").catch((e) => {
            log(`[crawl] mobile view: ${msg(e)}`);
            return undefined;
          });
          if (conv || mobile) page.conversion = { ...(conv ? { desktop: conv } : {}), ...(mobile ? { mobile } : {}) };
        }
      } catch (e) {
        page = { ...emptyPage(it.url, doc, `render failed: ${msg(e)}`), finalUrl: site };
      }
    }
    pages.push(page);
    const sec = sectionOf(new URL(site));
    if (sec) sectionCount.set(sec, (sectionCount.get(sec) ?? 0) + 1);
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
        for (let it = next(); it && pages.length < o.maxPages; it = next()) {
          if (Date.now() - crawlStart > o.maxCrawlMs) {
            timedOut = true;
            log(`[crawl] stopped after ${Math.round(o.maxCrawlMs / 1000)} s with ${pages.length} pages: the time budget is used`);
            break;
          }
          await visit(it, false);
        }

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
    linkStatus: Object.fromEntries(statusByUrl), screenshots, requests, ...(timedOut ? { timedOut } : {}), startedAt, finishedAt: new Date().toISOString(),
  };
}

// Waits (up to timeoutMs) until every stylesheet <link> on the page has loaded and web fonts are ready; returns how
// many stylesheets still have not loaded.
const READY_SCRIPT = (timeoutMs: number) => String.raw`(async () => {
  const pending = () => [...document.querySelectorAll("link[rel~='stylesheet' i]")].filter((l) => !l.disabled && !l.sheet).length;
  const end = Date.now() + ${Math.max(0, Math.round(timeoutMs))};
  while (pending() && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  await Promise.race([document.fonts ? document.fonts.ready : null, new Promise((r) => setTimeout(r, Math.max(0, Math.min(2000, end - Date.now()))))]);
  return pending();
})()`;

async function stylesReady(page: Page, timeoutMs: number): Promise<number> {
  try {
    return Number(await page.evaluate(READY_SCRIPT(timeoutMs))) || 0;
  } catch {
    return 0;
  }
}

// The conversion reading (src/checkup/conversion.ts) of the page as it is rendered now; its prose redacted. A page
// whose script throws gives nothing rather than a guess.
async function readConversion(page: Page, log: (line: string) => void): Promise<ConversionCapture | undefined> {
  try {
    return redactCapture((await page.evaluate(CONVERSION_SCRIPT)) as ConversionCapture);
  } catch (e) {
    log(`[crawl] conversion reading failed: ${msg(e)}`);
    return undefined;
  }
}
