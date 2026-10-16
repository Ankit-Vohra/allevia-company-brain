// The website check-up, end to end: a polite crawl that also reads what a visitor sees on the home and key pages
// (conversion), the crawl's SEO checks, Lighthouse on the home page and up to three key pages at phone and desktop size,
// a robots.txt read for the AI search crawlers; then the ranked verdict (fixes.ts), and, when a graph is given, the
// readings and fixes stored with provenance (store.ts) and progress since the last run. Free: no paid API, no model call.
import type { GraphHandle } from "../graph/client.js";
import { closeEdge, writeBatch } from "../graph/upsert.js";
import {
  crawlSite, evaluateSeo, guardedFetch, keyPagePriority, parseRobots, sectionOf, type CrawlOptions, type CrawlResult, type PageData,
} from "../ingest/sources/website/index.js";
import type { GraphWrite } from "../ingest/types.js";
import { guessKind, judgePage, judgeSite, type BusinessKind, type ConversionFinding, type PageConversion } from "./conversion.js";
import { FIX_BY_KEY, buildVerdict, type CheckupVerdict } from "./fixes.js";
import { FIXED_REASON } from "./history.js";
import { runLighthouse, type LighthouseResult, type LighthouseRunner, type Strategy } from "./lighthouse.js";
import { keepPageNames } from "./pages.js";
import { redact } from "../ingest/privacy.js";
import { CHECKUP_METRICS, changeLines, checkupDocId, checkupRulesWrite, checkupWrite, readingLines, type CheckupRun, type Progress, type Reading } from "./store.js";

// Crawlers that fetch pages so an AI assistant can cite them in an answer (claude-seo's "search citability" group).
// Training-only crawlers (GPTBot, ClaudeBot, Google-Extended …) are the owner's choice and are not flagged.
export const AI_SEARCH_CRAWLERS = ["OAI-SearchBot", "Claude-SearchBot", "PerplexityBot", "ChatGPT-User", "Claude-User"];

export interface CheckupOptions {
  businessName?: string;
  kind?: BusinessKind;           // local or online; guessed from the site when absent
  maxPages?: number;             // crawl cap, default 25
  lighthousePages?: number;      // home plus key pages, default 4
  strategies?: Strategy[];       // default both
}

export interface CheckupDeps {
  crawl?: (url: string, o: CrawlOptions) => Promise<CrawlResult>;
  crawlOptions?: Partial<CrawlOptions>;
  lighthouse?: LighthouseRunner;
  lighthouseResolve?: (host: string) => Promise<string[]>;
  robotsText?: (origin: string) => Promise<string | null>;
  now?: () => number;
  log?: (line: string) => void;
}

const ok = (p: PageData) => p.status >= 200 && p.status < 300 && !p.error;

/** The pages Lighthouse opens: the home page, then the most telling key pages, one per section. */
export function lighthousePages(pages: PageData[], n: number): string[] {
  const good = pages.filter(ok);
  const home = good[0];
  if (!home) return [];
  const out = [home.finalUrl];
  const sections = new Set<string>([sectionOf(new URL(home.finalUrl))]);
  const ranked = good.slice(1).map((p) => ({ p, prio: keyPagePriority(new URL(p.finalUrl)) }))
    .filter((x) => x.prio >= 70).sort((a, b) => b.prio - a.prio || a.p.finalUrl.localeCompare(b.p.finalUrl));
  // the same page in another language (/about and /hi/about) is one page for a speed test
  const leaf = (u: string) => new URL(u).pathname.toLowerCase().split("/").filter(Boolean).pop() ?? "";
  const leaves = new Set<string>();
  for (const { p } of ranked) {
    if (out.length >= n) break;
    const sec = sectionOf(new URL(p.finalUrl)) || new URL(p.finalUrl).pathname;
    if (sections.has(sec) || leaves.has(leaf(p.finalUrl))) continue;
    sections.add(sec);
    leaves.add(leaf(p.finalUrl));
    out.push(p.finalUrl);
  }
  return out;
}

async function defaultRobots(origin: string, allowHosts: string[] = []): Promise<string | null> {
  try {
    const r = await guardedFetch(`${origin}/robots.txt`, { maxBytes: 512 * 1024, accept: "text/plain,*/*;q=0.5", allowHosts });
    return r.status >= 200 && r.status < 300 ? r.body.toString("utf8") : null;
  } catch {
    return null;
  }
}

export function blockedAiCrawlers(robots: string | null): string[] {
  if (!robots) return [];
  return AI_SEARCH_CRAWLERS.filter((bot) => !parseRobots(robots, bot.toLowerCase()).isAllowed("/"));
}

export interface CheckupResult extends CheckupRun { crawl: CrawlResult; conversion: ConversionFinding[] }

export async function runCheckup(url: string, opts: CheckupOptions = {}, deps: CheckupDeps = {}): Promise<CheckupResult> {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;
  const asOf = new Date(now()).toISOString().slice(0, 19) + "Z";
  const notes: string[] = [];
  const crawl = await (deps.crawl ?? crawlSite)(url, {
    maxPages: opts.maxPages ?? 25, brandPages: 4, maxLinkChecks: 10, maxCrawlMs: 4 * 60_000, ...deps.crawlOptions, conversion: true, log,
  });
  const pages = crawl.pages;
  const home = pages[0];
  const homeOk = !!home && ok(home);
  if (!pages.length) notes.push("We could not read the site, so only what was reachable was checked.");
  if (crawl.timedOut) notes.push(`The crawl stopped at its time limit after ${pages.length} pages.`);

  const seo = pages.length ? evaluateSeo(pages, crawl.linkStatus) : undefined;
  const conv: PageConversion[] = pages.filter((p) => p.conversion).map((p) => ({ url: p.finalUrl, ...p.conversion }));
  const jsonLd = pages.flatMap((p) => p.jsonLd);
  const types = [...new Set(pages.flatMap((p) => p.jsonLdTypes))];
  const ld = JSON.stringify(jsonLd);
  const kind = opts.kind ?? guessKind(conv, types);
  const conversion: ConversionFinding[] = [];
  conv.forEach((p, i) => conversion.push(...judgePage(p, { home: i === 0 && p.url === home?.finalUrl, businessName: opts.businessName })));
  if (home) {
    conversion.push(...judgeSite(conv, home.finalUrl, {
      kind, jsonLdTypes: types, jsonLdHasHours: /"openingHours/.test(ld), jsonLdHasAddress: /"address"/.test(ld), jsonLdHasRating: /"aggregateRating"/.test(ld),
      contactPageFound: pages.some((p) => ok(p) && /\/(contact|reach-us|get-in-touch|enquir|book)/i.test(new URL(p.finalUrl).pathname)),
    }));
  }
  if (!conv.length && pages.length) notes.push("We could not read what a visitor sees on the first screen, so the call-button and headline checks were skipped.");

  const lhPages = lighthousePages(pages, opts.lighthousePages ?? 4);
  const strategies = opts.strategies ?? ["mobile", "desktop"];
  const lighthouse: LighthouseResult[] = lhPages.length ? await runLighthouse(lhPages.flatMap((u) => strategies.map((strategy) => ({ url: u, strategy }))), {
    ...(deps.lighthouse ? { runner: deps.lighthouse } : {}), ...(deps.lighthouseResolve ? { resolve: deps.lighthouseResolve } : {}),
    ...(deps.crawlOptions?.allowHosts ? { allowHosts: deps.crawlOptions.allowHosts } : {}), log,
  }) : [];
  const lhFailed = lighthouse.filter((r) => r.error);
  if (lhFailed.length) notes.push(`The speed test failed on ${lhFailed.length} of ${lighthouse.length} runs (${lhFailed[0]!.error}).`);

  const robots = await (deps.robotsText ?? ((o) => defaultRobots(o, deps.crawlOptions?.allowHosts)))(crawl.origin);
  const verdict: CheckupVerdict = buildVerdict({
    site: {
      origin: crawl.origin, homeOk, https: crawl.origin.startsWith("https:"),
      sitemapFound: crawl.sitemapUrls > 0 || crawl.robots.sitemaps.length > 0, aiCrawlersBlocked: blockedAiCrawlers(robots),
    },
    kind, ...(seo ? { seo } : {}), lighthouse, conversion,
  });
  // a page is named by its title, as onboarding names it (never by its path: that renamed onboarding's Pages); redacted like any page text
  const pageTitles = Object.fromEntries(pages.flatMap((p) => { const t = p.title ? redact(p.title.trim()).text : ""; return t ? [[p.finalUrl, t]] : []; }));
  return {
    origin: crawl.origin, asOf, verdict, lighthouse, pagesChecked: pages.map((p) => p.finalUrl), pageTitles, conversionPages: conv.map((p) => p.url),
    notes, crawl, conversion,
  };
}

// ---------- the graph ----------

const TRANSIENT = /timed? ?out|ECONNRESET|LOADING|busy/i;

async function write(g: GraphHandle, w: GraphWrite, now: number): Promise<number> {
  const s = await writeBatch(g, w, now);
  let errors = s.errors;
  for (let attempt = 1; attempt <= 3 && errors.some((x) => TRANSIENT.test(x.error)); attempt++) {
    await new Promise((r) => setTimeout(r, 300 * attempt));
    const again = errors.filter((x) => TRANSIENT.test(x.error));
    const r = await writeBatch(g, {
      nodes: again.filter((x) => x.kind === "node").map((x) => x.item as GraphWrite["nodes"][number]),
      edges: again.filter((x) => x.kind === "edge").map((x) => x.item as GraphWrite["edges"][number]),
      observations: again.filter((x) => x.kind === "observation").map((x) => x.item as GraphWrite["observations"][number]),
    }, now);
    errors = [...errors.filter((x) => !TRANSIENT.test(x.error)), ...r.errors];
  }
  if (errors.length) throw new Error(`${errors.length} graph write(s) failed, first: ${errors[0]!.error}`);
  return s.edgesCreated;
}

export interface SavedCheckup { docId: string; progress: Progress; closed: number }

/**
 * Stores a run in the business's graph (its own graph: tenant isolation is the graph boundary) and says what changed.
 * A finding the run no longer has is closed, with the reason, on its FAILS edge: that is what "fixed since last time" reads.
 * A Page the graph already has keeps the name it has (onboarding's, the page's title), never the path.
 */
export async function saveCheckup(g: GraphHandle, run: CheckupRun, now: number = Date.now()): Promise<SavedCheckup> {
  await write(g, checkupRulesWrite(), now); // first: a graph that does not exist yet cannot be read
  const before = await previousCheckup(g, run.origin);
  const w = await keepPageNames(g, checkupWrite(run));
  // the findings open before this run, by fix: a fix that is gone gets its FAILS edges closed, so the record shows when it stopped failing
  const wanted = new Set(w.edges.filter((e) => e.type === "FAILS").map((e) => `${e.from}|${e.to}`));
  const current = await g.query<{ f: string; r: string; key: string | null; title: string | null }>(
    `MATCH (x:Entity)-[e:FAILS]->(r:Entity:Rule) WHERE e.until IS NULL AND r.kind = 'website-check'
     RETURN x.id AS f, r.id AS r, r.issueType AS key, e.title AS title ORDER BY f, r`);
  let closed = 0;
  for (const c of current) if (!wanted.has(`${c.f}|${c.r}`)) closed += await closeEdge(g, c.f, "FAILS", c.r, now, FIXED_REASON);
  await write(g, w, now);
  const docId = checkupDocId(new URL(run.origin).hostname, run.asOf);
  const cur = w.observations.filter((o) => o.subject === w.observations[0]?.subject).map((o) => ({ metric: o.metric, value: o.value, asOf: o.asOf }));
  if (!before) return { docId, progress: { lines: [], fixed: [], newFixes: [] }, closed };

  // what was open and is not now, and what is open now and was not (by fix, with the owner's title)
  const had = new Map<string, string>();
  const catalogTitle = (key: string, n: number) => FIX_BY_KEY.get(key)?.title(n) ?? key;
  const perKey = new Map<string, number>();
  for (const c of current) if (c.key) perKey.set(c.key, (perKey.get(c.key) ?? 0) + 1);
  for (const c of current) if (c.key && !had.has(c.key)) had.set(c.key, c.title ?? catalogTitle(c.key, perKey.get(c.key) ?? 1));
  const now_ = new Map(run.verdict.all.map((f) => [f.key, f.title]));
  const fixed = [...had].filter(([k]) => !now_.has(k)).map(([, t]) => t);
  const newFixes = [...now_].filter(([k]) => !had.has(k)).map(([, t]) => t);
  const p: Progress = {
    lines: [...readingLines(before.readings, cur), ...changeLines(fixed, had.size ? newFixes : [])],
    fixed, newFixes, previousAsOf: before.asOf,
  };
  return { docId, progress: p, closed };
}

export interface StoredCheckup { docId: string; asOf: string; url: string; fixTitles: string[]; top: unknown[]; good: string[]; notes: string[]; kind: string | null; readings: Reading[] }

type Read = Pick<GraphHandle, "roQuery">;

/** The latest stored check-ups (newest first), with their website readings. */
export async function storedCheckups(g: Read, limit = 2, url?: string): Promise<StoredCheckup[]> {
  const docs = await g.roQuery<{ id: string; asOf: string; url: string; fixTitles: string[] | null; top: string | null; good: string[] | null; notes: string[] | null; kind: string | null }>(
    `MATCH (d:Document) WHERE d.checkup = 'website' AND ($url IS NULL OR d.url = $url)
     RETURN d.id AS id, d.asOf AS asOf, d.url AS url, d.fixTitles AS fixTitles, d.top AS top, d.good AS good, d.notes AS notes, d.businessKind AS kind
     ORDER BY asOf DESC, id DESC LIMIT $limit`, { url: url ?? null, limit });
  if (!docs.length) return [];
  const rows = await g.roQuery<{ src: string; metric: string; value: number; asOf: string }>(
    `MATCH (o:Observation)-[m:MEASURES]->(c:Channel) WHERE m.until IS NULL AND o.src IN $docs AND o.metric IN $metrics
     RETURN o.src AS src, o.metric AS metric, o.value AS value, o.asOf AS asOf LIMIT 500`,
    { docs: docs.map((d) => d.id), metrics: Object.keys(CHECKUP_METRICS) });
  const parse = (s: string | null): unknown[] => {
    try {
      const v = s ? JSON.parse(s) : [];
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };
  return docs.map((d) => ({
    docId: d.id, asOf: d.asOf, url: d.url, fixTitles: d.fixTitles ?? [], top: parse(d.top), good: d.good ?? [], notes: d.notes ?? [], kind: d.kind,
    readings: rows.filter((r) => r.src === d.id && typeof r.value === "number").map((r) => ({ metric: r.metric, value: r.value, asOf: r.asOf })),
  }));
}

async function previousCheckup(g: GraphHandle, origin: string): Promise<StoredCheckup | undefined> {
  return (await storedCheckups(g, 1, origin))[0];
}
