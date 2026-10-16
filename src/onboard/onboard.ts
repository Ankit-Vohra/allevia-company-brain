// Website onboarding (spec §10 Onboard, product design §2.1 "Reading your business"): paste a URL, watch the graph
// grow. onboard() checks the URL, ensures the tenant, then runs and streams the stages OnboardEvent defines, in order:
//   crawl (a `page` event per page) → brand → seo → understand → profile (country, currency, locale, time zone,
//   industry template) → playbooks → goals (Allevia 90 and its goals) → baseline (Day-0 baselines from real data, the
//   Day-0 checkpoint) → index (embeddings) → capabilities (the ladder) → done (counts).
// Issue #24, so day one is clean and useful: the understand stage ends with the day-one facts (hours, address, prices,
// catalogue; src/ingest/sources/website/facts.ts), and the index stage with the tidy pass (src/ingest/tidy.ts:
// near-duplicates merged, other businesses retyped, first names retired, each undoable with db:unmerge).
// Without a website (`website: false`, or no URL) the website stages, playbooks and index are skipped: that is how a
// business already in the graph is enrolled in Allevia 90 (`npm run cli -- enroll <tenant>`), with no crawl and no model.
// Every write is followed by a `nodes` event with what it touched. A failing stage emits an `error` event and the
// run carries on with what it has; nothing written is rolled back. Re-running is idempotent: ids are deterministic,
// writes MERGE, extraction and the two LLM questions are cached under data/cache, a fact that stopped being true
// (an SEO check that now passes, a colour no longer on the site) is closed, not deleted.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CapabilityState, EdgeRef, NodeRef, OnboardEvent } from "../../shared/contracts.js";
import { loadConfig } from "../config.js";
import { openGraph, type GraphHandle } from "../graph/client.js";
import { SEARCHABLE, typeOfLabels, type EntityType } from "../graph/schema.js";
import { ensureTenant, type TenantOpts } from "../graph/tenants.js";
import { closeEdge, upsertNode, writeBatch, type NodeInput } from "../graph/upsert.js";
import { legacyCacheDir, tenantCacheDir } from "../util/cache.js";
import { entityId } from "../util/ids.js";
import { EXTRACTABLE_TYPES, type KnownEntity, type LlmRunner } from "../ingest/extract.js";
import { embedPassages, entityText } from "../ingest/embed.js";
import { loadPlaybooks } from "../ingest/sources/playbooks.js";
import type { GraphWrite } from "../ingest/types.js";
import {
  BlockedUrlError, brandWrite, buildBrandKit, channelsWrite, checkUrl, crawlSite, describeBrand, evaluateSeo,
  extractPages, findSocials, linksWrite, makeAsk, normalizeUrl, pageDocId, pageId, pageWrite, profileBusiness, profileWrite, redactPage, selectKeyPages,
  seoRulesWrite, seoWrite, understandingLinks, websiteChannelWrite, type BrandVoice, type Profile, type CrawlOptions, type CrawlResult, type PageData,
} from "../ingest/sources/website/index.js";
import type { BaselineResult } from "../program/program.js";
import { baselineStage, capabilitiesStage, goalsStage, profileStage, type GoalsResult, type ProfileResult, type ProgramStageCtx } from "./enroll.js";
import type { ResolvedRegion } from "./region.js";
import { fetchWebsiteBrandFiles, type BrandFetch } from "../brand/website.js";
import type { AssetStore } from "../studio/store.js";
import type { VisionRunner } from "../studio/vision.js";
import type { PublicDataPort } from "../publicdata/service.js";
import { enrichOwnListing, readBlockedSite } from "../publicdata/enrich.js";
import { factsWrite, readDayOneFacts } from "../ingest/sources/website/facts.js";
import type { Ask } from "../ingest/sources/website/ask.js";
import { tidyGraph } from "../ingest/tidy.js";
import { rankAndCommunities } from "../ingest/librarian.js";

export interface OnboardInput {
  name: string;
  slug: string;
  url?: string;              // the website; absent (or website: false) skips the website stages
  website?: boolean;         // false: enrol a business already in the graph, without a crawl
  domain?: string;           // when there is no URL to take it from
  instagram?: string;
  industry?: string;
  vertical?: string;         // the owner's pick of business type; picks the template like industry does
  country?: string;
  currency?: string;
  locale?: string;
  timeZone?: string;
}

export interface OnboardDeps {
  runner?: LlmRunner;                                  // AgentSdkRunner (subscription) in production, a fake in tests; only the website stages need it
  signal?: AbortSignal;                                // the client went away: stop between stages
  model?: string;                                      // default ALLEVIA_EXTRACT_MODEL (haiku)
  dataDir?: string;                                    // default config dataDir (gitignored data/)
  crawl?: (url: string, opts: CrawlOptions) => Promise<CrawlResult>;
  crawlOptions?: Omit<CrawlOptions, "onPage" | "screenshotDir">;
  embed?: (texts: string[]) => Promise<number[][]>;   // default local e5-small
  // The brand library: with this, onboarding also downloads the logo file and the brand's Google fonts (src/brand/website.ts).
  // Absent (tests, dry runs): the brand kit stays references only.
  brand?: { store: AssetStore; vision?: VisionRunner; fetch?: BrandFetch; googleFonts?: boolean };
  tenantOpts?: TenantOpts;
  // Public data (Apify, docs/apify-setup.md): when on, a site that turns our reader away is read through Apify instead,
  // and the business's Google Maps listing is read after the profile. Off or absent: neither happens. Budgeted.
  publicData?: PublicDataPort;
  maxUnderstandPages?: number;                         // default 12
  tidy?: boolean;                                      // default true: the tidy pass after the index (false: trials measure the graph before it)
  now?: () => number;
  log?: (line: string) => void;
}

export interface OnboardStats { nodesCreated: number; nodesUpdated: number; versions: number; edgesCreated: number; edgesClosed: number; observations: number; writeErrors: number }

export interface OnboardResult {
  tenant: string;
  ok: boolean;                 // reached done
  pages: number;
  seoScore?: number;
  counts: Record<string, number>;
  stats: OnboardStats;
  errors: string[];
  reportPath?: string;
  region?: ResolvedRegion;
  templateKey?: string;
  program?: GoalsResult;
  goals?: BaselineResult[];
  capabilities?: CapabilityState[];
}

const MAX_REFS = 400;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// FalkorDB refuses work when its queue is full ("Max pending queries exceeded", MAX_QUEUED_QUERIES) and connections
// can drop; every onboarding write is idempotent, so those are retried with a growing pause.
const TRANSIENT = /max pending queries|ECONNRESET|ECONNREFUSED|socket closed|connection is closed/i;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function retrying<T>(fn: () => Promise<T>, tries = 5): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries || !TRANSIENT.test(msg(e))) throw e;
      await sleep(300 * i);
    }
  }
}

// "example.com" → "https://example.com/"; refuses non-http(s) schemes and private hosts (unless a test allows one).
export function startUrl(raw: string, allowHosts: string[] = []): string {
  const t = raw.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t}`;
  const n = normalizeUrl(withScheme);
  if (!n) throw new BlockedUrlError(`not a website address: ${JSON.stringify(t.slice(0, 200))}`);
  return checkUrl(n, allowHosts).toString();
}

// Why a crawl found nothing to read, in the owner's words (never HTTP): shown after "We could not read <site>:".
export function whyUnreadable(c: Pick<CrawlResult, "pages" | "robots">): string {
  if (c.robots.disallowAll) return "its robots.txt asks robots not to read it. If you own the site, allow AlleviaBot and try again.";
  // a broken link on a site that otherwise answered is not why we could read nothing: blame a status only when no page answered
  const bad = c.pages.some((p) => p.status >= 200 && p.status < 300) ? undefined : c.pages.find((p) => p.status < 200 || p.status >= 300);
  if (bad?.status === 429) return "the site asked us to slow down. Try again in a few minutes.";
  if (bad && [401, 403, 406, 451].includes(bad.status)) return "the site would not let us in (it blocks automated visitors, or needs a login).";
  if (bad && [404, 410].includes(bad.status)) return "there is no page at that address.";
  if (bad && bad.status >= 500) return "the site is having trouble on its side. Try again later.";
  if (bad) return "the site did not give us its page.";
  if (c.pages.some((p) => p.error)) return "our reader could not open its pages on our side (not the site's fault). Try again in a minute.";
  if (c.pages.length) return "the page has almost no text we could read: it may need you to log in, or build everything with scripts.";
  return "we could not reach it.";
}

export async function onboard(input: OnboardInput, emit: (e: OnboardEvent) => void, deps: OnboardDeps): Promise<OnboardResult> {
  const cfg = deps.dataDir && deps.model ? undefined : loadConfig();
  const dataDir = deps.dataDir ?? cfg!.dataDir;
  const model = deps.model ?? cfg!.extractModel;
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});
  const errors: string[] = [];
  const stats: OnboardStats = { nodesCreated: 0, nodesUpdated: 0, versions: 0, edgesCreated: 0, edgesClosed: 0, observations: 0, writeErrors: 0 };
  const result: OnboardResult = { tenant: input.slug, ok: false, pages: 0, counts: {}, stats, errors };
  const send = (e: OnboardEvent) => {
    try {
      emit(e);
    } catch (err) {
      log(`[onboard] event listener threw: ${msg(err)}`);
    }
  };
  // A stage that could not finish. The run goes on and ends with `done` unless the stage is one nothing can go on without
  // (the input, the business itself): then it is the end, and says so. Otherwise the owner is told in plain words what is
  // missing, never the stage's own error text, and the set-up still finishes (the log and the run report keep the real one).
  const FATAL = new Set(["input", "tenant"]);
  const fail = (stage: string, e: unknown) => {
    const m = `${stage}: ${msg(e)}`;
    errors.push(m);
    if (FATAL.has(stage)) send({ type: "error", message: m });
    else send({ type: "error", message: softMessage(stage), soft: true });
  };

  // ---------- input and tenant ----------
  const website = input.website !== false && !!input.url?.trim();
  let start = "";
  try {
    if (!input.name?.trim()) throw new Error("the business needs a name");
    if (website) start = startUrl(input.url!, deps.crawlOptions?.allowHosts);
    else if (input.website !== false) throw new Error("a website address is needed (or website: false to enrol without one)");
    if (website && !deps.runner) throw new Error("reading a website needs a language model runner");
  } catch (e) {
    fail("input", e);
    return result;
  }
  const domain = website ? new URL(start).hostname : input.domain?.trim() || undefined;
  const name = input.name.trim();
  const runner = deps.runner!;
  const stopped = () => {
    if (!deps.signal?.aborted) return false;
    if (!errors.some((x) => x.startsWith("stopped:"))) fail("stopped", "the client went away");
    return true;
  };
  let g: GraphHandle;
  let businessId: string;
  try {
    const t = await retrying(() => ensureTenant({ slug: input.slug, name, ...(domain ? { domain } : {}), ...(input.industry ? { industry: input.industry } : {}) }, deps.tenantOpts));
    businessId = t.businessId;
    g = await openGraph(input.slug);
  } catch (e) {
    fail("tenant", e);
    return result;
  }

  const refs = (w: GraphWrite) => {
    const nodes: NodeRef[] = w.nodes.map((n) => ({ id: n.id, label: n.type, name: n.name, ...(n.asOf ? { asOf: n.asOf } : {}) }));
    const edges: EdgeRef[] = w.edges.map((e) => ({ from: e.from, type: e.type, to: e.to }));
    for (let i = 0; i < Math.max(nodes.length, edges.length); i += MAX_REFS) {
      send({ type: "nodes", nodes: nodes.slice(i, i + MAX_REFS), edges: edges.slice(i, i + MAX_REFS) });
    }
  };
  const write = async (stage: string, w: GraphWrite): Promise<void> => {
    if (!w.nodes.length && !w.edges.length && !w.observations.length) return;
    const s = await writeBatch(g, w, now());
    for (let attempt = 1; attempt <= 5 && s.errors.some((x) => TRANSIENT.test(x.error)); attempt++) {
      await sleep(300 * attempt);
      const again = s.errors.filter((x) => TRANSIENT.test(x.error));
      const r = await writeBatch(g, {
        nodes: again.filter((x) => x.kind === "node").map((x) => x.item as NodeInput),
        observations: again.filter((x) => x.kind === "observation").map((x) => x.item as GraphWrite["observations"][number]),
        edges: again.filter((x) => x.kind === "edge").map((x) => x.item as GraphWrite["edges"][number]),
      }, now());
      for (const k of ["nodesCreated", "nodesUpdated", "versions", "edgesCreated", "edgesClosed", "observations", "skippedWeaker"] as const) s[k] += r[k];
      s.errors = [...s.errors.filter((x) => !TRANSIENT.test(x.error)), ...r.errors];
    }
    stats.nodesCreated += s.nodesCreated;
    stats.nodesUpdated += s.nodesUpdated;
    stats.versions += s.versions;
    stats.edgesCreated += s.edgesCreated;
    stats.edgesClosed += s.edgesClosed;
    stats.observations += s.observations;
    stats.writeErrors += s.errors.length;
    if (s.errors.length) fail(stage, `${s.errors.length} graph write(s) failed, first: ${s.errors[0]!.error}`);
    refs(w);
  };
  const stage = (s: Extract<OnboardEvent, { type: "stage" }>["stage"], text: string) => {
    log(`[onboard] ${s}: ${text}`);
    send({ type: "stage", stage: s, text });
  };

  const asOf = new Date(now()).toISOString();
  const day = asOf.slice(0, 10);
  const formDoc = entityId("Document", `onboarding form ${input.slug}`);

  let crawl: CrawlResult | undefined;
  let crawlFailure: string | undefined;    // why crawlSite itself threw, if it did
  let siteProfile: Profile | undefined;  // what the website says the business is: its kind and industry pick the template
  let pages: PageData[] = [];
  let modelCheck: Ask | undefined;       // the cached model questions, for the tidy pass after the index
  if (website) {
  // ---------- crawl ----------
  stage("crawl", `Reading ${domain}`);
  try {
    await write("crawl", {
      nodes: [{ type: "Document", id: formDoc, name: `Onboarding form: ${name}`, asOf,
        summary: "What the owner entered when onboarding: the business name, its website and optional Instagram handle and industry.",
        props: { kind: "form", url: start, ...(input.instagram ? { instagram: input.instagram } : {}), ...(input.industry ? { industry: input.industry } : {}) } }],
      edges: [{ from: businessId, type: "SOURCED_FROM", to: formDoc, src: formDoc, asOf }],
      observations: [],
    });
    await write("crawl", websiteChannelWrite(undefined, businessId, asOf));
    crawl = await (deps.crawl ?? crawlSite)(start, {
      maxPages: 40, ...deps.crawlOptions, log,
      screenshotDir: join(dataDir, "onboard", input.slug, "screenshots"),
      onPage: async (raw) => {
        const p = redactPage(raw); // whatever crawls, nothing unfiltered reaches an event, the graph or a model (page.ts)
        send({ type: "page", url: p.finalUrl, title: p.title ?? new URL(p.finalUrl).pathname });
        try {
          await write("crawl", pageWrite(p));
        } catch (e) {
          fail("crawl", e); // one page failing to land does not stop the crawl
        }
      },
    });
    pages = crawl.pages.map(redactPage);
    if (crawl.browserError) log(`[onboard] ${crawl.browserError}; ${crawl.readWithoutBrowser ?? 0} page(s) read from their HTML`);
    result.pages = pages.length;
    await write("crawl", websiteChannelWrite(crawl.origin, businessId, asOf));
    await write("crawl", linksWrite(pages));
  } catch (e) {
    crawlFailure = msg(e);
    log(`[onboard] crawl failed: ${crawlFailure}`);
  }
  // A site that could not be read is not a business we can set up: say why, in plain words, and stop here rather than
  // write a plan and "Your team is ready" for a business the team knows nothing about.
  // Turned away (or nothing readable): read the public pages through the public-data reader instead, when it is on.
  let viaPublicData = false;
  if (!selectKeyPages(pages, 1).length && deps.publicData?.enabled && !stopped()) {
    stage("crawl", `Our reader was turned away from ${domain}; reading its public pages another way`);
    try {
      const r = await readBlockedSite(deps.publicData, { tenant: input.slug, url: start, ...(deps.signal ? { signal: deps.signal } : {}) });
      if ("pages" in r) {
        pages = r.pages.map(redactPage);
        for (const p of pages) {
          send({ type: "page", url: p.finalUrl, title: p.title ?? new URL(p.finalUrl).pathname });
          await write("crawl", pageWrite(p));
        }
        await write("crawl", websiteChannelWrite(new URL(start).origin, businessId, asOf));
        result.pages = pages.length;
        viaPublicData = true;
        log(`[onboard] crawl: ${pages.length} pages read through public data (about $${r.usd.toFixed(3)})`);
      } else log(`[onboard] crawl fallback: ${r.why}`);
    } catch (e) {
      log(`[onboard] crawl fallback failed: ${msg(e)}`);
    }
  }
  if (!selectKeyPages(pages, 1).length) {
    const m = `We could not read ${domain}: ${crawl ? whyUnreadable(crawl) : crawlFailure ?? "we could not reach it."}`;
    errors.push(m);
    send({ type: "error", message: m });
    return result;
  }
  const home = pages.find((p) => p.status >= 200 && p.status < 300 && !p.error);
  const homeDoc = home ? pageDocId(home.finalUrl) : undefined;
  const legacyOnboard = legacyCacheDir(dataDir, "onboard", input.slug);
  const ask = makeAsk(runner, { model, cacheDir: tenantCacheDir(dataDir, "onboard", input.slug), ...(legacyOnboard ? { legacyCacheDir: legacyOnboard } : {}) });
  modelCheck = ask;

  // ---------- brand ----------
  stage("brand", home ? "Reading colours, fonts, logo and tone" : "Skipped: no page to read");
  if (home && homeDoc) {
    try {
      const kit = buildBrandKit([home, ...pages.filter((p) => p !== home && p.styles)]);
      let voice: BrandVoice | undefined;
      try {
        voice = await describeBrand(ask, { business: name, homeText: home.text, palette: kit.palette, fonts: kit.fonts });
      } catch (e) {
        fail("brand", e);
      }
      const w = brandWrite({ ...kit, ...(voice ? { voice } : {}) }, { businessId, businessName: name, docId: homeDoc, asOf });
      await write("brand", w);
      // what an earlier run found and this one did not: closed, not deleted
      const current = new Set(w.nodes.map((n) => n.id));
      const kinds = new Set([...(kit.palette.length ? ["colour"] : []), ...(kit.fonts.length ? ["font"] : []), ...(kit.logo ? ["logo"] : [])]);
      const old = await retrying(() => g.query<{ id: string; kind: string }>(
        "MATCH (:Entity {id:$b})-[r:OWNS]->(a:BrandAsset {origin:'website'}) WHERE r.until IS NULL RETURN a.id AS id, a.kind AS kind", { b: businessId }));
      for (const a of old) if (kinds.has(a.kind) && !current.has(a.id)) stats.edgesClosed += await retrying(() => closeEdge(g, businessId, "OWNS", a.id, now(), "no longer on the website"));
      if (voice) {
        const rules = await retrying(() => g.query<{ id: string }>(
          "MATCH (b:Entity {id:$b}) WITH b MATCH (r:BrandRule {origin:'website'})-[x:APPLIES_TO]->(b) WHERE x.until IS NULL RETURN r.id AS id", { b: businessId }));
        for (const r of rules) if (!current.has(r.id)) stats.edgesClosed += await retrying(() => closeEdge(g, r.id, "APPLIES_TO", businessId, now(), "no longer how the website reads"));
      }
      if (deps.brand) {
        // files, not references: the logo and the brand fonts (a failure here is a note, never a failed onboarding)
        try {
          const files = await fetchWebsiteBrandFiles(g, home, kit, {
            tenant: input.slug, businessId, docId: homeDoc, store: deps.brand.store, now: now(), log,
            ...(deps.brand.vision ? { vision: deps.brand.vision } : {}), ...(deps.brand.fetch ? { fetch: deps.brand.fetch } : {}),
            ...(deps.brand.googleFonts !== undefined ? { googleFonts: deps.brand.googleFonts } : {}),
            ...(deps.crawlOptions?.allowHosts ? { allowHosts: deps.crawlOptions.allowHosts } : {}),
          });
          for (const n of files.notes) log(`[onboard] brand: ${n}`);
          log(`[onboard] brand files: logo ${files.logo}${files.needsBetter ? " (needs a better file)" : ""}; fonts ${files.fonts.length ? files.fonts.map((f) => `${f.family} ${f.weight}`).join(", ") : "none"}`);
        } catch (e) {
          fail("brand files", e);
        }
      }
      log(`[onboard] brand: ${kit.palette.map((c) => `${c.hex} ${c.role}`).join(", ")}; fonts ${kit.fonts.map((f) => f.family).join(", ")}; logo ${kit.logo ? kit.logo.source : "none"}`);
    } catch (e) {
      fail("brand", e);
    }
  }

  // ---------- seo ----------
  stage("seo", pages.length ? `Checking ${pages.length} pages against the SEO rules` : "Skipped: no pages");
  // (pages read through public data carry no timings, links or markup: the SEO checks would be about the reader, not the site)
  if (pages.length && crawl && !viaPublicData) {
    try {
      const report = evaluateSeo(pages, crawl.linkStatus);
      result.seoScore = report.score;
      await write("seo", seoRulesWrite());
      // a check whose outcome flipped since the last run: close the old edge first
      const prior = await retrying(() => g.query<{ p: string; t: string; r: string }>(
        "MATCH (p:Page)-[x:FAILS|PASSES]->(r:Rule) WHERE x.until IS NULL RETURN p.id AS p, type(x) AS t, r.id AS r"));
      const have = new Set(prior.map((x) => `${x.p}|${x.t}|${x.r}`));
      for (const r of report.results) {
        const from = pageId(r.page);
        const opposite = r.pass ? "FAILS" : "PASSES";
        if (have.has(`${from}|${opposite}|${r.ruleId}`)) stats.edgesClosed += await retrying(() => closeEdge(g, from, opposite, r.ruleId, now(), "re-checked"));
      }
      await write("seo", seoWrite(report, { host: new URL(crawl.origin).hostname, asOf, day, pages }));
      const scored: NodeInput[] = pages.map((p) => {
        const n = pageWrite(p).nodes[0]!;
        return { type: "Page", id: n.id, name: n.name, props: { seoScore: report.pageScores[p.finalUrl] ?? 100 } };
      });
      await write("seo", { nodes: scored, edges: [], observations: [] });
      log(`[onboard] seo: score ${report.score}; failing ${report.failing.slice(0, 5).map((f) => `${f.check} (${f.pages})`).join(", ")}`);
    } catch (e) {
      fail("seo", e);
    }
  }

  // ---------- understand ----------
  stage("understand", home ? "Reading what you offer, who you serve and what you have built" : "Skipped: no page to read");
  if (home && homeDoc) {
    try {
      const existing = await retrying(() => knownEntities(g));
      const business = { id: businessId, name, ...(input.industry ? { industry: input.industry } : {}) };
      await extractPages(pages, {
        business, runner, model, cacheDir: tenantCacheDir(dataDir, "extract", input.slug), ...(legacyCacheDir(dataDir, "extract", input.slug) ? { legacyCacheDir: legacyCacheDir(dataDir, "extract", input.slug)! } : {}), existing, websiteHost: domain!,
        maxPages: deps.maxUnderstandPages,
        onDoc: (d) => write("understand", d.write),
        onError: (p, m) => fail("understand", `${new URL(p.finalUrl).pathname}: ${m}`),
      });
    } catch (e) {
      fail("understand", e);
    }
    try {
      const profile = await profileBusiness(ask, { name, ...(input.industry ? { industry: input.industry } : {}) }, pages);
      siteProfile = profile;
      const docs = pages.filter((p) => p === home || /about|contact|story|studio/i.test(new URL(p.finalUrl).pathname)).slice(0, 3).map((p) => pageDocId(p.finalUrl));
      await write("understand", profileWrite(profile, { businessId, name, domain: domain!, docs, asOf }));
      const industry = input.industry ?? profile.industry;
      if (profile.city || (industry && !input.industry)) {
        await ensureTenant({ slug: input.slug, name, domain: domain!, ...(profile.city ? { city: profile.city } : {}), ...(industry ? { industry } : {}) }, deps.tenantOpts);
      }
    } catch (e) {
      fail("understand", e);
    }
    try {
      await write("understand", channelsWrite(findSocials(pages), { businessId, asOf, ...(input.instagram ? { instagram: input.instagram } : {}), formDoc }));
      const rows = await retrying(() => g.query<{ id: string; labels: string[]; format: string | null; doc: string }>(
        `MATCH (n:Entity)-[s:SOURCED_FROM]->(d:Document {kind:'webpage'}) WHERE (n:Product OR n:Audience OR n:Content) AND s.until IS NULL
         RETURN DISTINCT n.id AS id, labels(n) AS labels, n.format AS format, d.id AS doc ORDER BY id, doc`));
      const firstDoc = new Map<string, (typeof rows)[number]>();
      for (const r of rows) if (!firstDoc.has(r.id)) firstDoc.set(r.id, r);
      const links = understandingLinks([...firstDoc.values()].map((r) => ({ id: r.id, type: typeOfLabels(r.labels)!, format: r.format, doc: r.doc })), { businessId, asOf });
      await write("understand", { nodes: [], edges: links, observations: [] });
    } catch (e) {
      fail("understand", e);
    }
  }

  // ---------- the Google Maps listing (public data, optional) ----------
  if (deps.publicData?.enabled && !stopped()) {
    stage("understand", "Reading your Google Maps listing: address, hours and reviews");
    try {
      const r = await enrichOwnListing(g, deps.publicData, {
        tenant: input.slug, businessId, name, now: now(), ...(siteProfile?.city ? { city: siteProfile.city } : {}), ...(domain ? { domain } : {}),
        ...(deps.signal ? { signal: deps.signal } : {}),
      });
      if ("listing" in r) {
        stats.nodesCreated += r.nodes;
        log(`[onboard] listing: ${r.listing.name}, rated ${r.listing.rating ?? "?"} from ${r.listing.reviewCount ?? "?"} reviews; ${r.listing.reviews.length} reviews kept (about $${r.usd.toFixed(3)})`);
      } else log(`[onboard] listing: not read (${r.why})`);
    } catch (e) {
      log(`[onboard] listing: not read (${msg(e)})`);
    }
  }

  // ---------- day-one facts: hours, address, prices and catalogue, as typed props with their page ----------
  // (after the listing: what the Google Maps listing already says is not written again from the website)
  if (home && !stopped()) {
    try {
      const [listing] = await retrying(() => g.roQuery<{ h: unknown; a: unknown }>("MATCH (c:Entity {id:'channel:google-maps'}) RETURN c.hours AS h, c.address AS a"));
      const has = { hours: Array.isArray(listing?.h) && listing.h.length > 0, address: typeof listing?.a === "string" && !!listing.a };
      const facts = await readDayOneFacts(pages, { ask, business: name, listing: has });
      const products = (await retrying(() => g.roQuery<{ id: string; name: string | null; aliases: unknown; merged: string | null }>(
        "MATCH (p:Product) RETURN p.id AS id, p.name AS name, p.aliases AS aliases, p.mergedInto AS merged ORDER BY id LIMIT 5000")))
        .filter((p) => p.name && !p.merged)
        .map((p) => ({ id: p.id, name: p.name!, ...(Array.isArray(p.aliases) ? { aliases: p.aliases.filter((a): a is string => typeof a === "string") } : {}) }));
      const { write: w, written } = factsWrite(facts, { businessId, businessName: name, asOf, products, listing: has });
      await write("understand", w);
      log(`[onboard] facts: ${written.length ? written.slice(0, 12).join(", ") : "none stated"}${written.length > 12 ? ` and ${written.length - 12} more` : ""}` +
        `${has.hours || has.address ? " (what the Google Maps listing has is not written again)" : ""}`);
    } catch (e) {
      log(`[onboard] facts not read: ${msg(e)}`);
    }
  }

  } // website

  // ---------- profile, playbooks, goals, baseline, index, capabilities ----------
  const ctx: ProgramStageCtx = {
    g, slug: input.slug, name, businessId, now, write, stage, send, retry: retrying, ...(deps.tenantOpts ? { tenantOpts: deps.tenantOpts } : {}),
  };
  let profile: ProfileResult | undefined;
  if (!stopped()) {
    try {
      profile = await profileStage(ctx, {
        ...Object.fromEntries((["industry", "vertical", "country", "currency", "locale", "timeZone"] as const).filter((k) => input[k]).map((k) => [k, input[k]])),
        ...(domain ? { domain } : {}),
        ...(siteProfile?.kind ? { kind: siteProfile.kind } : {}),
        ...(siteProfile?.industry ? { siteIndustry: siteProfile.industry } : {}),
      });
      result.region = profile.region;
      result.templateKey = profile.template.key;
      log(`[onboard] profile: ${profile.region.country ?? "country unknown"} (${profile.region.from}); ${[profile.region.currency, profile.region.locale, profile.region.timeZone].filter(Boolean).join(", ")}; template ${profile.template.key}`);
    } catch (e) {
      fail("profile", e);
    }
  }

  if (website && !stopped()) {
    stage("playbooks", "Loading SEO, Instagram, ads and writing playbooks for your industry");
    try {
      const industry = input.industry ?? siteProfile?.industry; // the owner's word, else what the website says
      const pb = loadPlaybooks({ tenantSlug: input.slug, ...(industry ? { industry } : {}) });
      await write("playbooks", pb.write);
      for (const s of pb.skipped.slice(0, 5)) log(`[onboard] playbooks skipped ${s.ref}: ${s.reason}`);
    } catch (e) {
      fail("playbooks", e);
    }
  }

  let goals: GoalsResult | undefined;
  if (profile && !stopped()) {
    try {
      goals = await goalsStage(ctx, profile);
      result.program = goals;
    } catch (e) {
      fail("goals", e);
    }
  }
  if (profile && goals && !stopped()) {
    try {
      result.goals = await baselineStage(ctx, profile, goals);
    } catch (e) {
      fail("baseline", e);
    }
  }

  if (website && !stopped()) {
    stage("index", "Indexing for search (local embeddings)");
    try {
      const n = await embedMissing(g, deps.embed ?? embedPassages, now);
      log(`[onboard] index: ${n.entities} entities and ${n.chunks} chunks embedded`);
    } catch (e) {
      fail("index", e);
    }
    // the tidy pass (src/ingest/tidy.ts): near-duplicates merged, other businesses retyped, first names retired, each
    // undoable with db:unmerge; then the nodes it made (a Supplier, a Partner…) get their vectors too
    if (deps.tidy !== false && !stopped()) {
      try {
        const t = await tidyGraph(g, {
          owner: { id: businessId, name, ...(domain ? { domain } : {}) }, ...(modelCheck ? { ask: modelCheck } : {}),
          embed: deps.embed ?? embedPassages, now: now(), log,
        });
        if (t.touched.length) {
          const rows = await retrying(() => g.roQuery<{ id: string; labels: string[]; name: string | null }>(
            "UNWIND $ids AS id MATCH (n:Entity {id:id}) RETURN n.id AS id, labels(n) AS labels, n.name AS name", { ids: t.touched }));
          const nodes: NodeRef[] = rows.flatMap((r) => { const label = typeOfLabels(r.labels); return label ? [{ id: r.id, label, name: r.name ?? r.id }] : []; });
          for (let i = 0; i < nodes.length; i += MAX_REFS) send({ type: "nodes", nodes: nodes.slice(i, i + MAX_REFS), edges: [] });
          await embedMissing(g, deps.embed ?? embedPassages, now);
        }
        for (const e of t.errors.slice(0, 3)) log(`[onboard] tidy: ${e}`);
      } catch (e) {
        fail("index", `tidy: ${msg(e)}`);
      }
    }
  }

  if (!stopped()) {
    try {
      result.capabilities = await capabilitiesStage(ctx);
    } catch (e) {
      fail("capabilities", e);
    }
  }
  if (deps.signal?.aborted) return result;

  // ---------- this business's own skills (voice, what it sells, reels, ads), from what onboarding just wrote ----------
  if (!stopped()) {
    try {
      const { writeCompanySkills } = await import("../agent/skills/company.js");
      const s = await writeCompanySkills(g, { tenant: input.slug, now: now() });
      log(`[onboard] company skills: ${s.written.length} written, ${s.unchanged.length} unchanged`);
    } catch (e) {
      log(`[onboard] company skills not written: ${msg(e)}`);
    }
  }

  // ---------- the map: rank and groups, now that everything is written (the librarian's second step, graph only) ----------
  // A business read from a website never goes through ingest, so nothing else would store `rank` and `community`: the
  // Brain map would fall back to a rough ranking of whatever it loads. LINKS_TO_PAGE feeds the groups, so a site's own
  // link structure shows. Best effort: a failure is a soft note, never a failed onboarding.
  if (website && !stopped()) {
    try {
      const r = await rankAndCommunities(g, { timeoutMs: 60_000, log });
      log(`[onboard] map: ${r.rank.nodes} nodes ranked, ${r.community.communities} groups`);
    } catch (e) {
      fail("map", e);
    }
  }

  // ---------- done ----------
  try {
    result.counts = await retrying(() => countGraph(g));
  } catch (e) {
    fail("done", e);
  }
  result.counts.pagesCrawled = pages.length;
  if (result.seoScore !== undefined) result.counts.seoScore = result.seoScore;
  result.ok = true;
  try {
    const dir = join(dataDir, "runs", input.slug);
    mkdirSync(dir, { recursive: true });
    result.reportPath = join(dir, `${asOf.replace(/[:.]/g, "-")}-onboard.json`);
    writeFileSync(result.reportPath, JSON.stringify({
      url: start || undefined, startedAt: asOf, finishedAt: new Date(now()).toISOString(), model, ...result,
      crawl: crawl ? { origin: crawl.origin, requests: crawl.requests, skipped: crawl.skipped, robots: crawl.robots, sitemapUrls: crawl.sitemapUrls, screenshots: crawl.screenshots } : undefined,
    }, null, 1));
  } catch (e) {
    log(`[onboard] run report not written: ${msg(e)}`);
  }
  stage("done", `${website ? `${result.counts.pagesCrawled} pages read; ` : ""}${Object.entries(result.counts).filter(([k]) => /^[A-Z]/.test(k)).reduce((n, [, v]) => n + v, 0)} nodes in the graph`);
  send({ type: "done", tenant: input.slug, counts: result.counts });
  return result;
}

// Entities extraction may resolve to: the business and everything of an extractable type already in the graph.
async function knownEntities(g: GraphHandle): Promise<Map<string, KnownEntity>> {
  const rows = await g.query<{ id: string; labels: string[]; name: string; aliases: string[] | null; merged: string | null; retired: boolean | null }>(
    "MATCH (n:Entity) WHERE any(l IN labels(n) WHERE l IN $types) RETURN n.id AS id, labels(n) AS labels, n.name AS name, n.aliases AS aliases, n.mergedInto AS merged, n.retired AS retired LIMIT 5000",
    { types: [...EXTRACTABLE_TYPES] });
  const out = new Map<string, KnownEntity>();
  for (const r of rows) {
    // a node the tidy pass (or the librarian) merged or retired is not offered: its names are the canonical node's now
    if (r.merged || r.retired === true) continue;
    const type = typeOfLabels(r.labels);
    if (type && r.name) out.set(r.id, { id: r.id, type, name: r.name, ...(Array.isArray(r.aliases) ? { aliases: r.aliases } : {}) });
  }
  return out;
}

// Searchable entities and chunks without a vector get one (e5-small passages, local).
async function embedMissing(g: GraphHandle, embed: (texts: string[]) => Promise<number[][]>, now: () => number): Promise<{ entities: number; chunks: number }> {
  const ents = (await retrying(() => g.query<{ id: string; labels: string[]; name: string; summary: string | null }>(
    "MATCH (n:Entity) WHERE n.embedding IS NULL AND NOT n:Chunk AND NOT n:Version AND NOT n:Observation RETURN n.id AS id, labels(n) AS labels, n.name AS name, n.summary AS summary LIMIT 5000")))
    .map((r) => ({ ...r, type: typeOfLabels(r.labels) }))
    .filter((r): r is typeof r & { type: EntityType } => !!r.type && SEARCHABLE.includes(r.type) && !!r.name?.trim());
  const chunks = await retrying(() => g.query<{ id: string; name: string; text: string | null }>(
    "MATCH (c:Chunk) WHERE c.textEmbedding IS NULL RETURN c.id AS id, c.name AS name, c.text AS text LIMIT 5000"));
  const vecs = await embed([...ents.map((e) => entityText({ name: e.name, type: e.type, ...(e.summary ? { summary: e.summary } : {}) })), ...chunks.map((c) => c.text ?? c.name)]);
  const t = now();
  for (const [i, e] of ents.entries()) await retrying(() => upsertNode(g, { type: e.type, id: e.id, name: e.name, embedding: vecs[i]! }, t));
  for (const [i, c] of chunks.entries()) await retrying(() => upsertNode(g, { type: "Chunk", id: c.id, name: c.name, embedding: vecs[ents.length + i]! }, t));
  return { entities: ents.length, chunks: chunks.length };
}

// Current nodes by type, and current relationships in all ("edges") and by type ("rel:<TYPE>").
export async function countGraph(g: GraphHandle): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const r of await g.roQuery<{ labels: string[]; c: number }>("MATCH (n:Entity) RETURN labels(n) AS labels, count(n) AS c")) {
    const t = typeOfLabels(r.labels);
    if (t) out[t] = (out[t] ?? 0) + r.c;
  }
  let edges = 0;
  for (const r of await g.roQuery<{ t: string; c: number }>("MATCH ()-[x]->() WHERE x.until IS NULL RETURN type(x) AS t, count(x) AS c")) {
    out[`rel:${r.t}`] = r.c;
    edges += r.c;
  }
  out.edges = edges;
  return out;
}

// What the owner reads when one step of the set-up could not finish but the rest could (the raw reason stays in the log).
const SOFT: Record<string, string> = {
  crawl: "One page of your website could not be read, so it is left out.",
  brand: "We could not read your colours or fonts yet. Your team will use plain defaults until you add a logo.",
  "brand files": "We could not read one of your brand files.",
  seo: "The website check did not finish. Use \"Check my website\" in a minute.",
  understand: "We read most of your website but not all of it. Your team will learn the rest as you talk to it.",
  profile: "We could not write down your business details yet. Your team will ask you when it needs them.",
  playbooks: "The ready-made playbooks for your kind of business did not load. Your team works without them for now.",
  goals: "We could not suggest your goals yet. They will show on your growth plan once they are ready.",
  baseline: "We could not write down where you start yet. It will be filled in after your first full week.",
  index: "We could not finish filing what we read for search, so some answers may miss things until it is done again.",
  capabilities: "We could not check which of your accounts the team can see yet.",
  map: "We could not arrange the map of your business yet. Everything else works, and the map improves with your next update.",
  done: "The final tally did not finish. Nothing was lost.",
  stopped: "The set-up was stopped.",
};
export const softMessage = (stage: string): string => SOFT[stage] ?? "One step of the set-up did not finish. Your team can still work; ask us to redo it.";
