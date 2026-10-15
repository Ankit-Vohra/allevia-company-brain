// Website onboarding (spec §10 Onboard, product design §2.1 "Reading your business"): paste a URL, watch the graph
// grow. onboard() checks the URL, ensures the tenant, then runs and streams the stages OnboardEvent defines, in order:
//   crawl (a `page` event per page) → brand → seo → understand → profile (country, currency, locale, time zone,
//   industry template) → playbooks → goals (Allevia 90 and its goals) → baseline (Day-0 baselines from real data, the
//   Day-0 checkpoint) → index (embeddings) → capabilities (the ladder) → done (counts).
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
import { entityId } from "../util/ids.js";
import { EXTRACTABLE_TYPES, type KnownEntity, type LlmRunner } from "../ingest/extract.js";
import { embedPassages, entityText } from "../ingest/embed.js";
import { loadPlaybooks } from "../ingest/sources/playbooks.js";
import type { GraphWrite } from "../ingest/types.js";
import {
  BlockedUrlError, brandWrite, buildBrandKit, channelsWrite, checkUrl, crawlSite, describeBrand, evaluateSeo,
  extractPages, findSocials, linksWrite, makeAsk, normalizeUrl, pageDocId, pageId, pageWrite, profileBusiness, profileWrite, redactPage,
  seoRulesWrite, seoWrite, understandingLinks, websiteChannelWrite, type BrandVoice, type Profile, type CrawlOptions, type CrawlResult, type PageData,
} from "../ingest/sources/website/index.js";
import type { BaselineResult } from "../program/program.js";
import { baselineStage, capabilitiesStage, goalsStage, profileStage, type GoalsResult, type ProfileResult, type ProgramStageCtx } from "./enroll.js";
import type { ResolvedRegion } from "./region.js";

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
  tenantOpts?: TenantOpts;
  maxUnderstandPages?: number;                         // default 12
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
  const fail = (stage: string, e: unknown) => {
    const m = `${stage}: ${msg(e)}`;
    errors.push(m);
    send({ type: "error", message: m });
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
  let siteProfile: Profile | undefined;   // what the website says the business is: its kind and industry pick the template
  let pages: PageData[] = [];
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
    result.pages = pages.length;
    await write("crawl", websiteChannelWrite(crawl.origin, businessId, asOf));
    await write("crawl", linksWrite(pages));
    if (!pages.length) fail("crawl", `no pages could be read from ${start}${crawl.skipped[0] ? ` (${crawl.skipped[0].reason})` : ""}`);
  } catch (e) {
    fail("crawl", e);
  }
  const home = pages.find((p) => p.status >= 200 && p.status < 300 && !p.error);
  const homeDoc = home ? pageDocId(home.finalUrl) : undefined;
  const ask = makeAsk(runner, { model, cacheDir: join(dataDir, "cache", "onboard") });

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
      log(`[onboard] brand: ${kit.palette.map((c) => `${c.hex} ${c.role}`).join(", ")}; fonts ${kit.fonts.map((f) => f.family).join(", ")}; logo ${kit.logo ? kit.logo.source : "none"}`);
    } catch (e) {
      fail("brand", e);
    }
  }

  // ---------- seo ----------
  stage("seo", pages.length ? `Checking ${pages.length} pages against the SEO rules` : "Skipped: no pages");
  if (pages.length && crawl) {
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
        business, runner, model, cacheDir: join(dataDir, "cache", "extract"), existing, websiteHost: domain!,
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
  }

  if (!stopped()) {
    try {
      result.capabilities = await capabilitiesStage(ctx);
    } catch (e) {
      fail("capabilities", e);
    }
  }
  if (deps.signal?.aborted) return result;

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
  const rows = await g.query<{ id: string; labels: string[]; name: string; aliases: string[] | null }>(
    "MATCH (n:Entity) WHERE any(l IN labels(n) WHERE l IN $types) RETURN n.id AS id, labels(n) AS labels, n.name AS name, n.aliases AS aliases LIMIT 5000",
    { types: [...EXTRACTABLE_TYPES] });
  const out = new Map<string, KnownEntity>();
  for (const r of rows) {
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
