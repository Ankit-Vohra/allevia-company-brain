// The optional paid layer: DataForSEO (https://dataforseo.com) for what a free check-up cannot see: the searches a
// business could rank for and their monthly volume, where its site ranks today, which sites compete for the same
// searches, and how many sites link to it. Off unless DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD are in
// ~/.config/allevia/allevia.env; when off, every entry point says so in plain words and spends nothing.
//
// Money: each business has a monthly budget (default $1, DATAFORSEO_MONTHLY_BUDGET_USD). Before every call the cost is
// estimated from DataForSEO's per-task and per-row prices (the price model open-seo uses, MIT, see NOTICE.md); a call
// whose estimate would take the month over budget is not made. What a call actually cost (DataForSEO returns it) is
// recorded as an Observation on the business, so the month's spend is read from the graph and survives restarts.
//
// Secrets: the login and password are only ever put in the Authorization header. They are never logged, never stored,
// and an error message that came back with them in it is scrubbed.
import { loadConfig } from "../config.js";
import type { NodeInput, ObservationInput } from "../graph/upsert.js";
import type { GraphWrite } from "../ingest/types.js";
import { entityId } from "../util/ids.js";

export interface DfsCredentials { login: string; password: string }
export interface DfsConfig { credentials: DfsCredentials | null; monthlyBudgetUsd: number }

export const NOT_CONFIGURED =
  "Keyword research is off: it uses DataForSEO, a paid data service (about 1 to 3 US cents a search), and no account is set up. " +
  "To turn it on, add DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD to ~/.config/allevia/allevia.env. Each business then gets a $1 a month budget (DATAFORSEO_MONTHLY_BUDGET_USD to change it), and the cost is checked before every call. Everything else in the check-up is free.";

export function dfsConfig(env: NodeJS.ProcessEnv = process.env): DfsConfig {
  const c = loadConfig(env);
  return c.dataforseo;
}

// ---------- prices (USD, upper bounds; open-seo's pricing.ts, Sep 2026) ----------

export const PRICES = {
  labsTask: 0.012, labsRow: 0.00012,
  backlinksTask: 0.024, backlinksRow: 0.000036,
} as const;

export type DfsOp = "keyword_ideas" | "ranked_keywords" | "competitors" | "backlinks";

export function estimateUsd(op: DfsOp, rows: number): number {
  const r = Math.max(0, Math.round(rows));
  const usd = op === "backlinks" ? PRICES.backlinksTask + PRICES.backlinksRow * 1 : PRICES.labsTask + PRICES.labsRow * r;
  return Math.round(usd * 10_000) / 10_000;
}

// Google's location codes for the markets Allevia sells in; English results.
export const LOCATIONS: Record<string, { code: number; name: string }> = {
  IN: { code: 2356, name: "India" }, US: { code: 2840, name: "United States" }, GB: { code: 2826, name: "United Kingdom" },
  AE: { code: 2784, name: "United Arab Emirates" }, AU: { code: 2036, name: "Australia" }, CA: { code: 2124, name: "Canada" },
  SG: { code: 2702, name: "Singapore" }, IE: { code: 2372, name: "Ireland" }, NZ: { code: 2554, name: "New Zealand" },
};

// ---------- client ----------

export type DfsFetch = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal?: AbortSignal }) =>
  Promise<{ status: number; json(): Promise<unknown> }>;

export class DfsError extends Error { override name = "DfsError"; }
export class BudgetError extends Error { override name = "BudgetError"; }

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export class DataForSeo {
  private readonly auth: string;
  constructor(private readonly creds: DfsCredentials, private readonly opts: { fetch?: DfsFetch; base?: string; timeoutMs?: number } = {}) {
    this.auth = `Basic ${Buffer.from(`${creds.login}:${creds.password}`).toString("base64")}`;
  }
  private scrub(s: string): string {
    let out = s;
    for (const secret of [this.creds.login, this.creds.password, this.auth]) if (secret) out = out.split(secret).join("[redacted]");
    return out;
  }
  /** One live task. Returns the first result and what DataForSEO says it cost. */
  async post(path: string, task: Obj): Promise<{ result: Obj; costUsd: number }> {
    const f: DfsFetch = this.opts.fetch ?? ((url, init) => fetch(url, init));
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? 60_000);
    let body: unknown;
    try {
      const r = await f(`${this.opts.base ?? "https://api.dataforseo.com"}${path}`, {
        method: "POST", headers: { authorization: this.auth, "content-type": "application/json" }, body: JSON.stringify([task]), signal: ctl.signal,
      });
      body = await r.json().catch(() => null);
      if (r.status === 401 || r.status === 403) throw new DfsError("DataForSEO refused the login: check DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD.");
      if (r.status === 402) throw new DfsError("The DataForSEO account is out of credit.");
      if (r.status >= 400) throw new DfsError(`DataForSEO answered HTTP ${r.status}.`);
    } catch (e) {
      if (e instanceof DfsError) throw e;
      throw new DfsError(this.scrub(`Could not reach DataForSEO: ${e instanceof Error ? e.message : String(e)}`));
    } finally {
      clearTimeout(timer);
    }
    const t = isObj(body) && Array.isArray(body.tasks) && isObj(body.tasks[0]) ? body.tasks[0] : null;
    if (!t) throw new DfsError("DataForSEO sent an answer we could not read.");
    const code = num(t.status_code);
    if (code !== null && code !== 20000) throw new DfsError(this.scrub(`DataForSEO: ${str(t.status_message) ?? `status ${code}`}`));
    const result = Array.isArray(t.result) && isObj(t.result[0]) ? t.result[0] : {};
    return { result, costUsd: num(t.cost) ?? num((body as Obj).cost) ?? 0 };
  }
}

// ---------- the four questions ----------

export interface KeywordIdea { keyword: string; volume: number | null; cpcUsd: number | null; difficulty: number | null; intent: string | null }
export interface RankedKeyword { keyword: string; position: number; url: string | null; volume: number | null }
export interface Competitor { domain: string; sharedKeywords: number | null; avgPosition: number | null; traffic: number | null }
export interface Backlinks { backlinks: number | null; referringDomains: number | null; rank: number | null }

const items = (r: Obj): Obj[] => (Array.isArray(r.items) ? r.items.filter(isObj) : []);
const kwInfo = (o: Obj): Obj => (isObj(o.keyword_info) ? o.keyword_info : {});

export function parseIdeas(r: Obj): KeywordIdea[] {
  return items(r).map((it) => ({
    keyword: str(it.keyword) ?? "", volume: num(kwInfo(it).search_volume), cpcUsd: num(kwInfo(it).cpc),
    difficulty: isObj(it.keyword_properties) ? num(it.keyword_properties.keyword_difficulty) : null,
    intent: isObj(it.search_intent_info) ? str(it.search_intent_info.main_intent) : null,
  })).filter((k) => k.keyword);
}
export function parseRanked(r: Obj): RankedKeyword[] {
  return items(r).flatMap((it) => {
    const kd = isObj(it.keyword_data) ? it.keyword_data : {};
    const se = isObj(it.ranked_serp_element) && isObj(it.ranked_serp_element.serp_item) ? it.ranked_serp_element.serp_item : {};
    const keyword = str(kd.keyword);
    const position = num(se.rank_absolute) ?? num(se.rank_group);
    return keyword && position !== null ? [{ keyword, position, url: str(se.url), volume: num(kwInfo(kd).search_volume) }] : [];
  });
}
export function parseCompetitors(r: Obj, own: string): Competitor[] {
  const bare = (d: string) => d.toLowerCase().replace(/^www\./, "");
  return items(r).map((it) => {
    const m = isObj(it.full_domain_metrics) && isObj(it.full_domain_metrics.organic) ? it.full_domain_metrics.organic : {};
    return { domain: str(it.domain) ?? "", sharedKeywords: num(it.intersections), avgPosition: num(it.avg_position), traffic: num(m.etv) };
  }).filter((c) => c.domain && bare(c.domain) !== bare(own));
}
export function parseBacklinks(r: Obj): Backlinks {
  return { backlinks: num(r.backlinks), referringDomains: num(r.referring_domains), rank: num(r.rank) };
}

// ---------- budget ----------

export interface Ledger {
  spentThisMonth(now: number): Promise<number>;
  record(costUsd: number, op: DfsOp, now: number): Promise<void>;
}

/** An in-memory ledger (tests, and the CLI when no business graph is given). */
export function memoryLedger(start = 0): Ledger & { entries: Array<{ costUsd: number; op: DfsOp }> } {
  const entries: Array<{ costUsd: number; op: DfsOp; at: number }> = [];
  return {
    entries,
    async spentThisMonth(now) {
      const m = new Date(now).toISOString().slice(0, 7);
      return start + entries.filter((e) => new Date(e.at).toISOString().slice(0, 7) === m).reduce((s, e) => s + e.costUsd, 0);
    },
    async record(costUsd, op, now) { entries.push({ costUsd, op, at: now }); },
  };
}

type GraphRW = {
  roQuery<T>(q: string, p?: Record<string, unknown>): Promise<T[]>;
};
/** The business's own ledger in its graph: one Observation per paid call on the Business, metric dataforseo_spend_usd. */
export function graphLedger(g: GraphRW, businessId: string, write: (w: GraphWrite) => Promise<void>): Ledger {
  return {
    async spentThisMonth(now) {
      const month = new Date(now).toISOString().slice(0, 7);
      const [r] = await g.roQuery<{ s: number | null }>(
        `MATCH (o:Observation)-[m:MEASURES]->(b:Entity {id:$b}) WHERE ID(m) >= 0 AND o.metric = 'dataforseo_spend_usd' AND o.asOf STARTS WITH $month
         RETURN sum(o.value) AS s`, { b: businessId, month });
      return r?.s ?? 0;
    },
    async record(costUsd, op, now) {
      const asOf = new Date(now).toISOString();
      const doc = entityId("Document", `dataforseo spend ${asOf}`);
      await write({
        nodes: [{ type: "Document", id: doc, name: `DataForSEO call: ${op}, ${asOf.slice(0, 10)}`, asOf, props: { kind: "report", title: `DataForSEO ${op}`, costUsd } }],
        edges: [],
        observations: [{ subject: businessId, metric: "dataforseo_spend_usd", value: costUsd, unit: "USD", asOf, src: doc, evidence: `DataForSEO ${op} call` }],
      });
    },
  };
}

export interface PaidCall<T> { op: DfsOp; rows: number; run: () => Promise<{ value: T; costUsd: number }> }
export interface Spent<T> { value: T; costUsd: number; estimateUsd: number; spentThisMonthUsd: number; budgetUsd: number }

/** Estimates, checks the month's budget, makes the call, records what it cost. */
export async function withinBudget<T>(call: PaidCall<T>, ledger: Ledger, budgetUsd: number, now: number = Date.now()): Promise<Spent<T>> {
  const estimate = estimateUsd(call.op, call.rows);
  const spent = await ledger.spentThisMonth(now);
  if (spent + estimate > budgetUsd + 1e-9) {
    throw new BudgetError(`This would cost about $${estimate.toFixed(3)} and this month's keyword budget of $${budgetUsd.toFixed(2)} has $${Math.max(0, budgetUsd - spent).toFixed(3)} left, so I did not run it. Raise DATAFORSEO_MONTHLY_BUDGET_USD to allow more.`);
  }
  const r = await call.run();
  const cost = r.costUsd > 0 ? r.costUsd : estimate;
  await ledger.record(cost, call.op, now);
  return { value: r.value, costUsd: cost, estimateUsd: estimate, spentThisMonthUsd: spent + cost, budgetUsd };
}

export interface Market { locationCode: number; language: string }
export const marketFor = (country?: string | null): Market => ({ locationCode: LOCATIONS[(country ?? "IN").toUpperCase()]?.code ?? LOCATIONS.IN!.code, language: "en" });

export const keywordIdeasCall = (c: DataForSeo, seeds: string[], m: Market, limit = 30): PaidCall<KeywordIdea[]> => ({
  op: "keyword_ideas", rows: limit,
  run: async () => {
    const r = await c.post("/v3/dataforseo_labs/google/keyword_ideas/live", {
      keywords: seeds.slice(0, 20), location_code: m.locationCode, language_code: m.language, limit, include_serp_info: false, closely_variants: false,
    });
    return { value: parseIdeas(r.result), costUsd: r.costUsd };
  },
});
export const rankedKeywordsCall = (c: DataForSeo, domain: string, m: Market, limit = 50): PaidCall<RankedKeyword[]> => ({
  op: "ranked_keywords", rows: limit,
  run: async () => {
    const r = await c.post("/v3/dataforseo_labs/google/ranked_keywords/live", { target: domain, location_code: m.locationCode, language_code: m.language, limit });
    return { value: parseRanked(r.result), costUsd: r.costUsd };
  },
});
export const competitorsCall = (c: DataForSeo, domain: string, m: Market, limit = 10): PaidCall<Competitor[]> => ({
  op: "competitors", rows: limit,
  run: async () => {
    const r = await c.post("/v3/dataforseo_labs/google/competitors_domain/live", { target: domain, location_code: m.locationCode, language_code: m.language, limit, exclude_top_domains: true });
    return { value: parseCompetitors(r.result, domain), costUsd: r.costUsd };
  },
});
export const backlinksCall = (c: DataForSeo, domain: string): PaidCall<Backlinks> => ({
  op: "backlinks", rows: 1,
  run: async () => {
    const r = await c.post("/v3/backlinks/summary/live", { target: domain, include_subdomains: true, backlinks_status_type: "live", rank_scale: "one_hundred" });
    return { value: parseBacklinks(r.result), costUsd: r.costUsd };
  },
});

// ---------- the graph ----------

export const queryId = (keyword: string) => entityId("Query", keyword.toLowerCase());

/** Keyword ideas and rankings as Query nodes with their monthly volume, and RANKS_FOR from the ranking page. */
export function keywordsWrite(o: { ideas?: KeywordIdea[]; ranked?: RankedKeyword[]; asOf: string; host: string }): GraphWrite {
  const doc = entityId("Document", `dataforseo keywords ${o.host} ${o.asOf}`);
  const nodes: NodeInput[] = [{ type: "Document", id: doc, name: `Search keywords for ${o.host}, ${o.asOf.slice(0, 10)}`, asOf: o.asOf,
    props: { kind: "report", checkup: "keywords", title: `Keyword research, ${o.asOf.slice(0, 10)}`, source: "DataForSEO" } }];
  const observations: ObservationInput[] = [];
  const edges: GraphWrite["edges"] = [];
  const seen = new Set<string>();
  const q = (kw: string, volume: number | null) => {
    const id = queryId(kw);
    if (!seen.has(id)) {
      seen.add(id);
      nodes.push({ type: "Query", id, name: kw.slice(0, 200), props: { text: kw.slice(0, 200) }, src: doc, asOf: o.asOf });
      if (volume !== null) observations.push({ subject: id, metric: "search_volume_monthly", value: volume, asOf: o.asOf, src: doc, evidence: "DataForSEO Google search volume" });
    }
    return id;
  };
  for (const k of o.ideas ?? []) q(k.keyword, k.volume);
  for (const r of o.ranked ?? []) {
    const id = q(r.keyword, r.volume);
    if (r.url) {
      const pid = entityId("Page", r.url);
      nodes.push({ type: "Page", id: pid, name: new URL(r.url).pathname, props: { url: r.url } });
      edges.push({ from: pid, type: "RANKS_FOR", to: id, src: doc, asOf: o.asOf, props: { position: r.position } });
    }
  }
  return { nodes, edges, observations };
}
