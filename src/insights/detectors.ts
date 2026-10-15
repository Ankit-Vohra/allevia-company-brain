// Insight detectors (spec §9): deterministic, read-only Cypher with fixed thresholds. Each returns candidate findings
// with the ids of the nodes that justify them and the numbers behind them, so every figure an owner reads comes from
// the graph, never from a model. recommend.ts turns candidates into Recommendations and Approval cards.
//
// Metric names differ by source (seedMini's `views`/`ctr`, the ops ingest's `reel_views`/`gsc_ctr_pct`…), so each
// detector reads every spelling it knows. Only current MEASURES/FAILS/USES_RULE/PUBLISHED_ON edges count, and Day-0
// baseline Observations ({baseline:true}) are never read as the latest value.
//
// Props read that the crawler (M5) is expected to write on a Page: indexed (false), noindex (true), indexStatus or
// coverageState ("…not indexed", "Excluded…"), statusCode (>= 400).
import type { ActionKind } from "../../shared/contracts.js";
import type { GraphHandle } from "../graph/client.js";
import { typeOfLabels, type EntityType } from "../graph/schema.js";
import { DAY_MS, addDays, cap1, clip, dayMs, dayOf, fmt, humanise, list, median, money, pageLabel, pct, plural, round, shortDate, times } from "./text.js";

export type Area = "seo" | "content" | "funnel" | "ads" | "knowledge" | "tech";

// What the executor needs. title/body/target are what the approval card shows; the rest are ids for the executor.
export interface ActionPayload {
  title: string;
  body: string;
  target?: string;
  targetId?: string;
  [k: string]: unknown;
}
export interface SuggestedAction { kind: ActionKind; payload: ActionPayload }

export interface Candidate {
  key: string;                       // stable: `<detector>:<subject>`; the same finding next run has the same key
  detector: DetectorName;
  area: Area;
  agent: string;                     // roster id of the agent that owns the finding
  title: string;
  why: string;                       // template text; every number in it is in `numbers`
  impact?: string;
  evidence: string[];                // node ids
  numbers: Record<string, number>;
  metrics?: string[];                // metric keys involved (recommend.ts matches Goals on them)
  simulated?: boolean;
  score: number;                     // 0..1, for ranking
  confidence: number;                // 0..1
  suggestedAction?: SuggestedAction;
}

export interface DetectorOpts {
  now: number;
  staleDays?: number;        // a pending task untouched this long is stale (default 14)
  gapDays?: number;          // a channel with no post this long has a posting gap (default 7)
  minImpressions?: number;   // CTR checks need at least this many impressions (default 100)
  newErrorsMin?: number;     // this many new app errors in a period is a pile-up on its own (default 10)
  crashFreeMin?: number;     // sessions without a crash, in percent, below which the app is flagged (default 99.5)
  minSessions?: number;      // crash and release checks need at least this many sessions behind them (default 30)
  reviewWaitDays?: number;   // an app update waiting for Apple's review this long is flagged (default 3)
  releaseDropPoints?: number; // crash-free sessions falling this many percentage points after a build is flagged (default 2)
}

type Read = Pick<GraphHandle, "roQuery">;
export interface Detector { area: Area; run(g: Read, opts: DetectorOpts): Promise<Candidate[]> }

const READ_MS = 20_000;
const ro = <T>(g: Read, cypher: string, params: Record<string, unknown> = {}): Promise<T[]> => g.roQuery<T>(cypher, params, { timeoutMs: READ_MS });

// ---------- shared loaders ----------

interface Latest {
  id: string; labels: string[]; name: string | null; metric: string; value: number; unit: string | null; obsId: string;
  at: string | null; simulated: boolean | null;
  path: string | null; format: string | null; platform: string | null; publishedAt: string | null; status: string | null;
}

const LABEL_OK = /^[A-Z][A-Za-z]+$/;

// The latest current Observation per (subject, metric) for these metrics, optionally only on subjects of these types.
async function latestObs(g: Read, metrics: string[], types?: EntityType[]): Promise<Latest[]> {
  const labels = (types ?? []).filter((t) => LABEL_OK.test(t));
  const typeFilter = labels.length ? ` AND (${labels.map((t) => `s:${t}`).join(" OR ")})` : "";
  return ro<Latest>(g,
    `MATCH (o:Observation)-[m:MEASURES]->(s:Entity)
     WHERE o.metric IN $metrics AND m.until IS NULL AND coalesce(o.baseline, false) = false${typeFilter}
     WITH s, o ORDER BY coalesce(o.windowEnd, o.asOf) DESC, o.id DESC
     WITH s, o.metric AS metric, collect(o)[0] AS o
     RETURN s.id AS id, labels(s) AS labels, s.name AS name, metric, o.value AS value, o.unit AS unit, o.id AS obsId,
            coalesce(o.windowEnd, o.asOf) AS at, o.simulated AS simulated, s.path AS path, s.format AS format,
            s.platform AS platform, s.publishedAt AS publishedAt, s.status AS status
     LIMIT 5000`, { metrics });
}

// subject id -> metric -> latest row
function bySubject(rows: Latest[]): Map<string, Map<string, Latest>> {
  const out = new Map<string, Map<string, Latest>>();
  for (const r of rows) {
    if (typeof r.value !== "number" || !Number.isFinite(r.value)) continue;
    let m = out.get(r.id);
    if (!m) out.set(r.id, (m = new Map()));
    m.set(r.metric, r);
  }
  return out;
}

const first = (m: Map<string, Latest> | undefined, keys: readonly string[]): Latest | undefined => {
  for (const k of keys) {
    const r = m?.get(k);
    if (r) return r;
  }
  return undefined;
};

const typeOf = (labels: string[]): string => typeOfLabels(labels) ?? "Entity"; // not labels.find: Searchable can come before the type
const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];
const cap = (x: number, hi = 1): number => Math.max(0, Math.min(hi, x));

// ---------- SEO ----------

const CLICKS = ["gsc_clicks", "clicks", "search_clicks"];
const IMPRESSIONS = ["gsc_impressions", "impressions", "search_impressions"];
const CTR = ["gsc_ctr_pct", "ctr"];
const POSITION = ["gsc_position", "position"];

const seoHighSeverityFails: Detector = {
  area: "seo",
  async run(g) {
    const rows = await ro<{ page: string; name: string | null; path: string | null; url: string | null; rules: Array<{ id: string; name: string | null; fix: string | null; evidence: string | null }> }>(g,
      `MATCH (p:Page)-[f:FAILS]->(r:Entity)
       WHERE f.until IS NULL AND (r:Rule OR r:BrandRule) AND toLower(coalesce(r.severity, '')) IN ['high', 'critical']
       WITH p, r, f ORDER BY r.id
       RETURN p.id AS page, p.name AS name, p.path AS path, p.url AS url,
              collect({id: r.id, name: r.name, fix: coalesce(r.howToFix, r.text), evidence: f.evidence}) AS rules
       ORDER BY size(rules) DESC, page LIMIT 200`);
    if (!rows.length) return [];
    const traffic = bySubject(await latestObs(g, [...CLICKS, ...IMPRESSIONS], ["Page"]));
    const out = rows.map((r): Candidate => {
      const label = pageLabel({ id: r.page, path: r.path, name: r.name });
      const t = traffic.get(r.page);
      const clicks = first(t, CLICKS), impr = first(t, IMPRESSIONS);
      const n = r.rules.length;
      const numbers: Record<string, number> = { failing: n };
      if (impr) numbers.impressions = impr.value;
      if (clicks) numbers.clicks = clicks.value;
      const names = r.rules.map((x) => x.name ?? x.id);
      const trafficLine = impr ? ` It had ${fmt(impr.value)} impressions${clicks ? ` and ${fmt(clicks.value)} clicks` : ""} in its last Search Console window.` : "";
      const body = [
        cap1(`${label} fails ${plural(n, "high-severity SEO check")}.`), "",
        ...r.rules.map((x) => `- [ ] ${x.name ?? x.id}${x.evidence ? ` (found: ${x.evidence})` : ""}${x.fix ? `\n      Fix: ${x.fix}` : ""}`),
        "", `Page: ${r.url ?? label}`, `Evidence: ${[r.page, ...r.rules.map((x) => x.id)].join(", ")}`,
      ].join("\n");
      return {
        key: `seo.high_severity_fails:${r.page}`, detector: "seo.high_severity_fails", area: "seo", agent: "tech-lead",
        title: `Fix ${plural(n, "high-severity SEO issue")} on ${label}`,
        why: cap1(`${label} fails ${plural(n, "high-severity check")}: ${list(names)}.${trafficLine}`),
        impact: "High-severity fails hold a page back in search; fixing them is the cheapest SEO win.",
        evidence: uniq([r.page, ...r.rules.map((x) => x.id), ...(impr ? [impr.obsId] : []), ...(clicks ? [clicks.obsId] : [])]),
        numbers, metrics: impr ? [impr.metric] : [],
        score: round(0.5 + cap((impr?.value ?? 0) / 20000, 0.4)), confidence: 0.85,
        suggestedAction: {
          kind: "github_issue",
          payload: { title: n === 1 ? `SEO: ${label} fails "${names[0]}"` : `SEO: ${label} fails ${n} high-severity checks`, body, target: r.url ?? label, targetId: r.page },
        },
      };
    });
    return out.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key)).slice(0, 5);
  },
};

const seoLowCtr: Detector = {
  area: "seo",
  async run(g, opts) {
    const minImpr = opts.minImpressions ?? 100;
    const subjects = bySubject(await latestObs(g, [...CLICKS, ...IMPRESSIONS, ...CTR, ...POSITION], ["Page", "Query"]));
    const found: Array<{ id: string; row: Latest; impr: Latest; clicks?: Latest; ctr: number; pos?: Latest; ctrObs?: Latest }> = [];
    for (const [id, m] of subjects) {
      const impr = first(m, IMPRESSIONS);
      if (!impr || impr.value < minImpr) continue;
      const clicks = first(m, CLICKS);
      const ctrObs = first(m, CTR);
      const ctr = clicks ? clicks.value / impr.value : ctrObs ? (ctrObs.metric.endsWith("_pct") ? ctrObs.value / 100 : ctrObs.value) : NaN;
      if (!(ctr < 0.01)) continue;
      found.push({ id, row: impr, impr, clicks, ctr, pos: first(m, POSITION), ...(clicks ? {} : { ctrObs }) });
    }
    if (!found.length) return [];
    const queries = found.filter((f) => typeOf(f.row.labels) === "Query").map((f) => f.id);
    const ranks = new Map<string, { page: string; path: string | null; url: string | null }>();
    if (queries.length) {
      const rows = await ro<{ q: string; page: string; path: string | null; url: string | null }>(g,
        `MATCH (p:Page)-[r:RANKS_FOR]->(q:Entity:Query) WHERE q.id IN $ids AND r.until IS NULL
         RETURN q.id AS q, p.id AS page, p.path AS path, p.url AS url ORDER BY q, coalesce(r.position, 1000), page`, { ids: queries });
      for (const r of rows) if (!ranks.has(r.q)) ranks.set(r.q, r);
    }
    return found
      .sort((a, b) => b.impr.value - a.impr.value || a.id.localeCompare(b.id))
      .slice(0, 5)
      .map((f): Candidate => {
        const isQuery = typeOf(f.row.labels) === "Query";
        const label = isQuery ? `"${f.row.name ?? f.id}"` : pageLabel({ id: f.id, path: f.row.path, name: f.row.name });
        const ctrPct = round(f.ctr * 100, 2);
        const numbers: Record<string, number> = { impressions: f.impr.value, ctr_pct: ctrPct };
        if (f.clicks) numbers.clicks = f.clicks.value;
        if (f.pos) numbers.position = f.pos.value;
        const page = isQuery ? ranks.get(f.id) : { page: f.id, path: f.row.path, url: null };
        const pageText = page ? pageLabel({ id: page.page, path: page.path }) : undefined;
        const posText = f.pos ? `, average position ${fmt(f.pos.value, 1)}` : "";
        const why = cap1(`${label} was shown ${fmt(f.impr.value)} times${f.clicks ? ` and clicked ${fmt(f.clicks.value)} times` : ""}: ${pct(f.ctr)} CTR${posText}. Under 1% usually means the title and description do not match what people searched for.`);
        const body = [
          cap1(`${label}: ${fmt(f.impr.value)} impressions${f.clicks ? `, ${fmt(f.clicks.value)} clicks` : ""}, ${pct(f.ctr)} CTR${posText}.`), "",
          `- [ ] Rewrite the title of ${pageText ?? "the ranking page"} to answer ${isQuery ? label : "the main query"} directly`,
          "- [ ] Write a meta description with the city and a concrete reason to click",
          "- [ ] Check again in two weeks", "",
          `Evidence: ${uniq([f.id, f.impr.obsId, ...(f.clicks ? [f.clicks.obsId] : []), ...(page && page.page !== f.id ? [page.page] : [])]).join(", ")}`,
        ].join("\n");
        return {
          key: `seo.low_ctr:${f.id}`, detector: "seo.low_ctr", area: "seo", agent: "data-analyst",
          title: cap1(`${label}: ${fmt(f.impr.value)} impressions, ${pct(f.ctr)} CTR`),
          why, impact: "Better titles turn impressions you already have into clicks, with no new ranking needed.",
          evidence: uniq([f.id, f.impr.obsId, ...(f.clicks ? [f.clicks.obsId] : []), ...(f.ctrObs ? [f.ctrObs.obsId] : []), ...(page && page.page !== f.id ? [page.page] : [])]),
          numbers, metrics: uniq([f.impr.metric, ...(f.clicks ? [f.clicks.metric] : [])]),
          score: round(0.4 + cap(f.impr.value / 20000, 0.4)), confidence: 0.8,
          suggestedAction: {
            kind: "github_issue",
            payload: { title: `SEO: rewrite the title and description of ${pageText ?? label}`, body, target: page?.url ?? pageText ?? label, ...(page ? { targetId: page.page } : { targetId: f.id }) },
          },
        };
      });
  },
};

const seoNotIndexed: Detector = {
  area: "seo",
  async run(g) {
    const rows = await ro<{ id: string; name: string | null; path: string | null; url: string | null; status: string | null; code: number | null; noindex: boolean | null }>(g,
      `MATCH (p:Page)
       WITH p, toLower(coalesce(p.indexStatus, p.coverageState, '')) AS st
       WHERE p.indexed = false OR p.noindex = true OR st CONTAINS 'not indexed' OR st STARTS WITH 'excluded' OR coalesce(p.statusCode, 200) >= 400
       RETURN p.id AS id, p.name AS name, p.path AS path, p.url AS url, coalesce(p.indexStatus, p.coverageState) AS status,
              p.statusCode AS code, p.noindex AS noindex
       ORDER BY id LIMIT 200`);
    if (!rows.length) return [];
    const reason = (r: (typeof rows)[number]) =>
      r.status ?? (r.code && r.code >= 400 ? `returns ${r.code}` : r.noindex ? "marked noindex" : "not indexed");
    const lines = rows.map((r) => `${pageLabel({ id: r.id, path: r.path, name: r.name })} (${reason(r)})`);
    const n = rows.length;
    return [{
      key: "seo.not_indexed:site", detector: "seo.not_indexed", area: "seo", agent: "tech-lead",
      title: `${plural(n, "page")} not in Google's index`,
      why: `${plural(n, "page")} cannot be found in search: ${list(lines)}.`,
      impact: "A page that is not indexed gets no search traffic at all.",
      evidence: rows.slice(0, 20).map((r) => r.id), numbers: { pages: n },
      score: round(0.5 + cap(0.05 * n, 0.3)), confidence: 0.8,
      suggestedAction: {
        kind: "github_issue",
        payload: {
          title: `SEO: get ${plural(n, "page")} indexed`,
          body: [`${plural(n, "page")} not indexed:`, "", ...lines.slice(0, 30).map((l) => `- [ ] ${l}`), "",
            "Check for noindex tags, canonical tags pointing elsewhere, thin content and broken status codes; then request indexing in Search Console."].join("\n"),
          target: "Search Console", targetId: rows[0]!.id,
        },
      },
    }];
  },
};

const seoSitemap: Detector = {
  area: "seo",
  async run(g) {
    const subjects = bySubject(await latestObs(g, ["gsc_sitemap_submitted_urls", "gsc_sitemap_indexed_urls", "gsc_sitemap_errors", "sitemap_errors"], ["Channel", "System", "Page"]));
    const out: Candidate[] = [];
    for (const [id, m] of subjects) {
      const sub = m.get("gsc_sitemap_submitted_urls"), idx = m.get("gsc_sitemap_indexed_urls");
      const err = first(m, ["gsc_sitemap_errors", "sitemap_errors"]);
      const errors = err?.value ?? 0;
      // Search Console's API reports a sitemap's `indexed` count as 0 since Google deprecated the field, so 0 means
      // "unknown", not "none indexed".
      const known = !!idx && idx.value > 0;
      const gap = sub && known && sub.value >= 10 && idx!.value / sub.value < 0.8 ? sub.value - idx!.value : 0;
      if (errors <= 0 && gap <= 0) continue;
      const row = (sub ?? idx ?? err)!;
      const numbers: Record<string, number> = {};
      if (sub) numbers.submitted = sub.value;
      if (idx) numbers.indexed = idx.value;
      if (sub && idx && known) numbers.not_indexed = Math.max(0, sub.value - idx.value);
      if (err) numbers.errors = errors;
      const parts = [
        ...(gap > 0 ? [`${fmt(gap)} of ${fmt(sub!.value)} URLs not indexed`] : []),
        ...(errors > 0 ? [plural(errors, "error")] : []),
      ];
      const evidence = uniq([id, ...[sub, idx, err].filter((x): x is Latest => !!x).map((x) => x.obsId)]);
      out.push({
        key: `seo.sitemap:${id}`, detector: "seo.sitemap", area: "seo", agent: "tech-lead",
        title: `Sitemap: ${parts.join(", ")}`,
        why: `${row.name ?? id}'s sitemap ${sub ? `lists ${fmt(sub.value)} URLs; Google has indexed ${known ? fmt(idx!.value) : "an unknown number"}`: "has problems"}${errors > 0 ? `, and it reports ${plural(errors, "error")}` : ""}.`,
        impact: "URLs Google cannot read from the sitemap are found late or not at all.",
        evidence, numbers, metrics: [...m.keys()],
        score: round(0.4 + (sub && sub.value ? 0.4 * cap(gap / sub.value) : 0) + (errors > 0 ? 0.1 : 0)), confidence: 0.8,
        suggestedAction: {
          kind: "github_issue",
          payload: {
            title: `SEO: fix the sitemap (${parts.join(", ")})`,
            body: [`Sitemap for ${row.name ?? id}: ${parts.join(", ")}.`, "",
              "- [ ] Regenerate the sitemap from live, indexable pages only (no 404s, no redirects, no noindex)",
              "- [ ] Resubmit it in Search Console and read the errors it reports", "", `Evidence: ${evidence.join(", ")}`].join("\n"),
            target: "Search Console sitemaps", targetId: id,
          },
        },
      });
    }
    return out;
  },
};

// ---------- content ----------

const VIEW_METRICS = ["views", "reel_views", "plays", "reel_plays", "yt_views"];
const MIN_GROUP = 3;

interface Post { id: string; name: string; format: string; metric: string; views: number; obsId: string; publishedAt: string | null; channel?: { id: string; name: string } }
interface Hook { id: string; name: string; text: string | null; template: string | null; example: string | null }

const formatPlural = (f: string): string => (f.endsWith("y") ? `${f.slice(0, -1)}ies` : f.endsWith("s") ? f : `${f}s`);

async function loadPosts(g: Read): Promise<{ posts: Post[]; hooks: Map<string, Hook[]>; groupMedian: Map<string, number> }> {
  const subjects = bySubject(await latestObs(g, VIEW_METRICS, ["Content"]));
  const chans = await ro<{ c: string; id: string; name: string | null }>(g,
    "MATCH (c:Content)-[p:PUBLISHED_ON]->(ch:Channel) WHERE p.until IS NULL RETURN c.id AS c, ch.id AS id, ch.name AS name ORDER BY c, id");
  const channelOf = new Map<string, { id: string; name: string }>();
  for (const r of chans) if (!channelOf.has(r.c)) channelOf.set(r.c, { id: r.id, name: r.name ?? r.id });
  const posts: Post[] = [];
  for (const [id, m] of subjects) {
    const v = first(m, VIEW_METRICS);
    if (!v || (v.status && v.status === "draft")) continue;
    posts.push({ id, name: v.name ?? id, format: v.format ?? "post", metric: v.metric, views: v.value, obsId: v.obsId, publishedAt: v.publishedAt, channel: channelOf.get(id) });
  }
  posts.sort((a, b) => b.views - a.views || a.id.localeCompare(b.id)); // stable evidence order from run to run
  const hookRows = await ro<{ c: string; id: string; name: string | null; text: string | null; template: string | null; example: string | null }>(g,
    `MATCH (c:Content)-[u:USES_RULE]->(r:Rule) WHERE u.until IS NULL AND r.kind = 'hook'
     RETURN c.id AS c, r.id AS id, r.name AS name, r.text AS text, r.template AS template, r.example AS example ORDER BY c, id`);
  const hooks = new Map<string, Hook[]>();
  for (const r of hookRows) hooks.set(r.c, [...(hooks.get(r.c) ?? []), { id: r.id, name: r.name ?? r.id, text: r.text, template: r.template, example: r.example }]);
  const groups = new Map<string, number[]>();
  for (const p of posts) groups.set(`${p.format}|${p.metric}`, [...(groups.get(`${p.format}|${p.metric}`) ?? []), p.views]);
  const groupMedian = new Map<string, number>();
  for (const [k, vs] of groups) {
    const md = median(vs);
    if (vs.length >= MIN_GROUP && md && md > 0) groupMedian.set(k, md);
  }
  return { posts, hooks, groupMedian };
}

const multipleOf = (p: Post, gm: Map<string, number>): number | undefined => {
  const md = gm.get(`${p.format}|${p.metric}`);
  return md ? p.views / md : undefined;
};

interface HookStat { hook: Hook; posts: Post[]; multiples: number[]; multiple: number }

function hookStats(d: Awaited<ReturnType<typeof loadPosts>>): HookStat[] {
  const by = new Map<string, HookStat>();
  for (const p of d.posts) {
    const m = multipleOf(p, d.groupMedian);
    if (m === undefined) continue;
    for (const h of d.hooks.get(p.id) ?? []) {
      const s = by.get(h.id) ?? { hook: h, posts: [], multiples: [], multiple: 0 };
      s.posts.push(p);
      s.multiples.push(m);
      by.set(h.id, s);
    }
  }
  for (const s of by.values()) s.multiple = median(s.multiples) ?? 0;
  return [...by.values()];
}

const contentHookOutliers: Detector = {
  area: "content",
  async run(g) {
    const d = await loadPosts(g);
    return hookStats(d)
      .filter((s) => s.multiple >= 2)
      .sort((a, b) => b.multiple - a.multiple || a.hook.id.localeCompare(b.hook.id))
      .map((s): Candidate => {
        const best = s.posts.reduce((a, b) => (b.views > a.views ? b : a));
        const md = d.groupMedian.get(`${best.format}|${best.metric}`)!;
        const channel = best.channel;
        const brief = [
          `Format: ${best.format}${channel ? ` for ${channel.name}` : ""}.`,
          `Hook: ${s.hook.name}.${s.hook.text ? ` ${s.hook.text}` : ""}`,
          ...(s.hook.template ? [`Template: ${s.hook.template}`] : []),
          ...(s.hook.example ? [`Example: ${s.hook.example}`] : []),
          `Why: posts with this hook ran at ${times(s.multiple)} the median ${best.format} (best: "${clip(best.name, 60)}", ${fmt(best.views)} views).`,
        ].join("\n");
        return {
          key: `content.hook_outliers:${s.hook.id}`, detector: "content.hook_outliers", area: "content", agent: "content-strategist",
          title: `Use the "${s.hook.name}" more: ${times(s.multiple)} the median ${best.format}`,
          why: `${plural(s.posts.length, best.format, formatPlural(best.format))} with the ${s.hook.name} ran at ${times(s.multiple)} the median of ${fmt(md)} views; the best, "${clip(best.name, 60)}", reached ${fmt(best.views)}.`,
          impact: "Reusing a hook that already works for this audience is the surest way to lift reach.",
          evidence: uniq([s.hook.id, ...s.posts.map((p) => p.id), best.obsId]),
          numbers: { multiple: round(s.multiple), posts: s.posts.length, median_views: md, best_views: best.views },
          metrics: uniq(s.posts.map((p) => p.metric)),
          score: round(cap(0.4 + 0.1 * s.multiple, 0.9)), confidence: 0.75,
          suggestedAction: {
            kind: "content_draft",
            payload: {
              title: `${humanise(best.format)} draft: ${s.hook.name}`, body: brief, format: best.format, target: channel?.name,
              targetId: s.hook.id, hookRuleId: s.hook.id, ...(channel ? { channelId: channel.id } : {}),
            },
          },
        };
      });
  },
};

const contentPostOutliers: Detector = {
  area: "content",
  async run(g) {
    const d = await loadPosts(g);
    return d.posts
      .map((p) => ({ p, m: multipleOf(p, d.groupMedian) }))
      .filter((x): x is { p: Post; m: number } => x.m !== undefined && x.m >= 2 && !(d.hooks.get(x.p.id)?.length))
      .sort((a, b) => b.m - a.m || a.p.id.localeCompare(b.p.id))
      .slice(0, 3)
      .map(({ p, m }): Candidate => {
        const md = d.groupMedian.get(`${p.format}|${p.metric}`)!;
        return {
          key: `content.post_outliers:${p.id}`, detector: "content.post_outliers", area: "content", agent: "content-strategist",
          title: `"${clip(p.name, 50)}" did ${times(m)} the median ${p.format}`,
          why: `"${clip(p.name, 80)}" reached ${fmt(p.views)} views against a median of ${fmt(md)} for ${formatPlural(p.format)}${p.channel ? ` on ${p.channel.name}` : ""}. Its hook is not on record yet, so make another in the same shape and note the hook.`,
          impact: "A post at twice the median is a pattern worth repeating.",
          evidence: uniq([p.id, p.obsId]), numbers: { views: p.views, median_views: md, multiple: round(m) }, metrics: [p.metric],
          score: round(cap(0.35 + 0.05 * m, 0.7)), confidence: 0.6,
          suggestedAction: {
            kind: "content_draft",
            payload: {
              title: `${humanise(p.format)} draft: another "${clip(p.name, 50)}"`,
              body: `Format: ${p.format}${p.channel ? ` for ${p.channel.name}` : ""}.\nModel: "${p.name}" (${fmt(p.views)} views, ${times(m)} the median).\nKeep its opening line, length and subject; change the example.`,
              format: p.format, target: p.channel?.name, targetId: p.id, ...(p.channel ? { channelId: p.channel.id } : {}),
            },
          },
        };
      });
  },
};

const contentUnderperforming: Detector = {
  area: "content",
  async run(g) {
    const d = await loadPosts(g);
    const out: Candidate[] = [];
    for (const s of hookStats(d)) {
      if (s.posts.length < 2 || s.multiple > 0.7) continue;
      const fmtName = s.posts[0]!.format;
      out.push({
        key: `content.underperforming:hook:${s.hook.id}`, detector: "content.underperforming", area: "content", agent: "content-strategist",
        title: `The "${s.hook.name}" runs at ${times(s.multiple)} the median ${fmtName}`,
        why: `${plural(s.posts.length, fmtName, formatPlural(fmtName))} used the ${s.hook.name}; they ran at ${times(s.multiple)} the median. Use it less, or test a new opening.`,
        impact: "Dropping a hook that underperforms frees slots for ones that work.",
        evidence: uniq([s.hook.id, ...s.posts.map((p) => p.id)]),
        numbers: { multiple: round(s.multiple), posts: s.posts.length }, metrics: uniq(s.posts.map((p) => p.metric)),
        score: 0.35, confidence: 0.6,
      });
    }
    // Formats on the same channel, measured by the same metric: a format whose median is half the best one's or less.
    const groups = new Map<string, Map<string, Post[]>>();
    for (const p of d.posts) {
      if (!p.channel) continue;
      const k = `${p.channel.id}|${p.metric}`;
      const byFormat = groups.get(k) ?? new Map<string, Post[]>();
      byFormat.set(p.format, [...(byFormat.get(p.format) ?? []), p]);
      groups.set(k, byFormat);
    }
    for (const byFormat of groups.values()) {
      const meds = [...byFormat].filter(([, ps]) => ps.length >= 2).sort((a, b) => a[0].localeCompare(b[0]))
        .map(([f, ps]) => ({ f, ps, md: median(ps.map((p) => p.views)) ?? 0 }));
      if (meds.length < 2) continue;
      const best = meds.reduce((a, b) => (b.md > a.md ? b : a));
      if (best.md <= 0) continue;
      for (const m of meds) {
        if (m === best || m.md / best.md > 0.5) continue;
        const ch = m.ps[0]!.channel!;
        const mult = m.md / best.md;
        out.push({
          key: `content.underperforming:format:${ch.id}:${m.f}`, detector: "content.underperforming", area: "content", agent: "content-strategist",
          title: `${ch.name} ${formatPlural(m.f)} get ${fmt(round(mult), 2)}× the views of ${formatPlural(best.f)}`,
          why: `On ${ch.name}, ${plural(m.ps.length, m.f, formatPlural(m.f))} had a median of ${fmt(m.md)} views; ${plural(best.ps.length, best.f, formatPlural(best.f))} had ${fmt(best.md)}. Put the time into ${formatPlural(best.f)}.`,
          impact: "Shifting effort to the format that works multiplies reach for the same hours.",
          evidence: uniq([ch.id, ...m.ps.slice(0, 5).map((p) => p.id), ...best.ps.slice(0, 3).map((p) => p.id)]),
          numbers: { median_views: m.md, best_median_views: best.md, multiple: round(mult), posts: m.ps.length }, metrics: [m.ps[0]!.metric],
          score: 0.4, confidence: 0.65,
        });
      }
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
  },
};

const contentPostingGap: Detector = {
  area: "content",
  async run(g, opts) {
    const gapDays = opts.gapDays ?? 7;
    const rows = await ro<{ id: string; name: string | null; dates: string[]; formats: string[] }>(g,
      `MATCH (c:Content)-[p:PUBLISHED_ON]->(ch:Channel)
       WHERE p.until IS NULL AND c.publishedAt IS NOT NULL AND coalesce(c.status, 'published') <> 'draft'
       RETURN ch.id AS id, ch.name AS name, collect(c.publishedAt) AS dates, collect(coalesce(c.format, 'post')) AS formats
       ORDER BY id`);
    const today = dayOf(opts.now)!;
    const out: Candidate[] = [];
    for (const r of rows) {
      const days = r.dates.map((d) => dayOf(d)).filter((d): d is string => !!d && d <= today).sort();
      if (days.length < 3) continue;
      const last = days[days.length - 1]!;
      const gap = Math.floor((dayMs(today) - dayMs(last)) / DAY_MS);
      if (gap < gapDays) continue;
      const counts = new Map<string, number>();
      for (const f of r.formats) counts.set(f, (counts.get(f) ?? 0) + 1);
      const format = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
      const name = r.name ?? r.id;
      out.push({
        key: `content.posting_gap:${r.id}`, detector: "content.posting_gap", area: "content", agent: "content-strategist",
        title: `No ${name} post in ${gap} days`,
        why: `The last ${name} post went out on ${shortDate(last)}, ${gap} days ago; ${plural(days.length, "post")} are on record for it.`,
        impact: "Reach decays when a channel goes quiet; one post restarts it.",
        evidence: [r.id], numbers: { days: gap, posts: days.length },
        score: round(cap(0.4 + gap / 60, 0.85)), confidence: 0.9,
        suggestedAction: {
          kind: "content_draft",
          payload: {
            title: `${humanise(format)} for ${name} to end a ${gap}-day gap`,
            body: `${name} has been quiet since ${shortDate(last)} (${gap} days). Draft one ${format} this week in the format that has worked best here.`,
            format, channelId: r.id, target: name, targetId: r.id,
          },
        },
      });
    }
    return out;
  },
};

// ---------- funnel ----------

const STEP_ORDER = ["accounts_created", "otp_requested", "otp_verified", "setup_completed", "activated"];

const funnelBiggestDrop: Detector = {
  area: "funnel",
  async run(g) {
    const rows = await ro<Latest>(g,
      `MATCH (o:Observation)-[m:MEASURES]->(s:Entity)
       WHERE o.metric CONTAINS '_funnel_' AND m.until IS NULL AND coalesce(o.baseline, false) = false
       WITH s, o ORDER BY coalesce(o.windowEnd, o.asOf) DESC, o.id DESC
       WITH s, o.metric AS metric, collect(o)[0] AS o
       RETURN s.id AS id, labels(s) AS labels, s.name AS name, metric, o.value AS value, o.unit AS unit, o.id AS obsId,
              coalesce(o.windowEnd, o.asOf) AS at, o.simulated AS simulated
       LIMIT 2000`);
    const funnels = new Map<string, Latest[]>();
    for (const r of rows) {
      if (typeof r.value !== "number") continue;
      const i = r.metric.lastIndexOf("_funnel_");
      const k = `${r.id}|${r.metric.slice(0, i + "_funnel".length)}`;
      funnels.set(k, [...(funnels.get(k) ?? []), r]);
    }
    const out: Candidate[] = [];
    for (const [k, all] of funnels) {
      const latest = all.reduce((a, b) => ((b.at ?? "") > (a.at ?? "") ? b : a)).at;
      const steps = all.filter((r) => r.at === latest);
      if (steps.length < 2) continue;
      const prefix = k.slice(k.indexOf("|") + 1);
      const step = (r: Latest) => r.metric.slice(prefix.length + 1);
      const known = steps.every((r) => STEP_ORDER.includes(step(r)));
      steps.sort((a, b) => (known ? STEP_ORDER.indexOf(step(a)) - STEP_ORDER.indexOf(step(b)) : b.value - a.value || a.metric.localeCompare(b.metric)));
      let best: { i: number; drop: number } | undefined;
      for (let i = 0; i + 1 < steps.length; i++) {
        const a = steps[i]!.value, b = steps[i + 1]!.value;
        if (a <= 0) continue;
        const drop = 1 - b / a;
        if (!best || drop > best.drop) best = { i, drop };
      }
      if (!best || best.drop < 0.2) continue;
      const from = steps[best.i]!, to = steps[best.i + 1]!;
      const top = steps[0]!, bottom = steps[steps.length - 1]!;
      const subj = from.name ?? from.id;
      // "seeker_signup_funnel" on the Seekers audience reads "signup funnel", not "Seekers seeker signup funnel".
      const parts = prefix.split("_");
      const lead = subj.toLowerCase().split(/\s+/)[0] ?? "";
      if (parts.length > 2 && (lead === parts[0] || lead === `${parts[0]}s`)) parts.shift();
      const fn = humanise(parts.join("_")).toLowerCase();
      const lower = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s);
      const fromL = lower(humanise(step(from))), toL = lower(humanise(step(to)));
      const dropPct = round(best.drop * 100, 1);
      out.push({
        key: `funnel.biggest_drop:${from.id}:${prefix}`, detector: "funnel.biggest_drop", area: "funnel", agent: "data-analyst",
        title: `${subj} ${fn}: ${fmt(dropPct)}% drop from ${fromL} to ${toL}`,
        why: `${subj}: of ${fmt(from.value)} at "${fromL}", ${fmt(to.value)} reached "${toL}". ${fmt(dropPct)}% dropped there, the biggest loss in the funnel. End to end, ${fmt(bottom.value)} of ${fmt(top.value)} made it (${pct(top.value ? bottom.value / top.value : 0)}).`,
        impact: "Fixing the leakiest step lifts every number after it.",
        evidence: uniq([from.id, from.obsId, to.obsId]),
        numbers: { from_users: from.value, to_users: to.value, drop_pct: dropPct, lost: from.value - to.value, top_users: top.value, bottom_users: bottom.value, steps: steps.length },
        metrics: [from.metric, to.metric, prefix],
        score: round(0.5 + 0.4 * best.drop), confidence: 0.8,
        suggestedAction: {
          kind: "github_issue",
          payload: {
            title: `Funnel: ${fmt(dropPct)}% drop at ${toL} (${subj})`,
            body: [`${subj}, window ending ${latest ?? "?"}:`, "", ...steps.map((s) => `- ${humanise(step(s))}: ${fmt(s.value)}`), "",
              `The biggest drop is ${fromL} -> ${toL} (${fmt(dropPct)}%, ${fmt(from.value - to.value)} lost).`,
              "- [ ] Watch five session recordings at this step", "- [ ] List what the screen asks for that people may not have", "- [ ] Ship one fix and re-measure"].join("\n"),
            target: "product", targetId: from.id,
          },
        },
      });
    }
    return out.sort((a, b) => (b.numbers.lost ?? 0) - (a.numbers.lost ?? 0)).slice(0, 3);
  },
};

// ---------- ads (simulated: every campaign the simulator writes is flagged, and so is every finding about one) ----------

interface AdRow { id: string; name: string | null; status: string | null; simulated: boolean | null; channel: string | null; metric: string; value: number; day: string | null; unit: string | null }

async function loadAds(g: Read): Promise<{ rows: AdRow[]; last?: string }> {
  const rows = await ro<AdRow>(g,
    `MATCH (c:Campaign)<-[m:MEASURES]-(o:Observation)
     WHERE m.until IS NULL AND o.metric IN ['spend', 'conversions', 'signups', 'leads', 'impressions', 'clicks']
     OPTIONAL MATCH (c)-[p:PUBLISHED_ON]->(ch:Channel) WHERE p.until IS NULL
     RETURN c.id AS id, c.name AS name, c.status AS status, c.simulated AS simulated, ch.name AS channel, o.metric AS metric,
            o.value AS value, coalesce(o.windowEnd, o.asOf) AS day, o.unit AS unit
     LIMIT 9000`);
  const days = rows.map((r) => dayOf(r.day)).filter((d): d is string => !!d).sort();
  return { rows, last: days[days.length - 1] };
}

function sums(rows: AdRow[], from: string, to: string): Map<string, { name: string; status: string | null; simulated: boolean; channel: string | null; unit: string | null; m: Record<string, number>; days: Set<string> }> {
  const out = new Map<string, { name: string; status: string | null; simulated: boolean; channel: string | null; unit: string | null; m: Record<string, number>; days: Set<string> }>();
  for (const r of rows) {
    const d = dayOf(r.day);
    if (!d || d < from || d > to || typeof r.value !== "number") continue;
    const c = out.get(r.id) ?? { name: r.name ?? r.id, status: r.status, simulated: r.simulated === true, channel: r.channel, unit: null, m: {}, days: new Set<string>() };
    c.m[r.metric] = (c.m[r.metric] ?? 0) + r.value;
    if (r.metric === "spend" && r.unit) c.unit = r.unit;
    c.days.add(d);
    out.set(r.id, c);
  }
  return out;
}

const conversionsOf = (m: Record<string, number>): number | undefined => m.conversions ?? m.signups ?? m.leads;
const sim = (on: boolean) => (on ? " (simulated)" : "");

const adsHighCpa: Detector = {
  area: "ads",
  async run(g) {
    const { rows, last } = await loadAds(g);
    if (!last) return [];
    const from = addDays(last, -13);
    const camps = [...sums(rows, from, last)]
      .filter(([, c]) => !/^(paused|ended|archived)$/i.test(c.status ?? ""))
      .map(([id, c]) => ({ id, ...c, conv: conversionsOf(c.m) ?? 0, spend: c.m.spend ?? 0 }))
      .filter((c) => c.spend > 0 && c.conv > 0)
      .map((c) => ({ ...c, cpa: c.spend / c.conv }));
    if (camps.length < 3) return [];
    const md = median(camps.map((c) => c.cpa))!;
    return camps
      .filter((c) => c.cpa >= 1.5 * md)
      .sort((a, b) => b.cpa - a.cpa || a.id.localeCompare(b.id))
      .map((c): Candidate => {
        const multiple = c.cpa / md;
        const label = `"${c.name}"${sim(c.simulated)}`;
        const days = c.days.size;
        return {
          key: `ads.high_cpa:${c.id}`, detector: "ads.high_cpa", area: "ads", agent: "growth-marketer",
          title: `Pause ${label}: CPA ${money(round(c.cpa, 0), c.unit)} vs ${money(round(md, 0), c.unit)} median`,
          why: `${label} spent ${money(c.spend, c.unit)} for ${fmt(c.conv)} conversions over ${plural(days, "day")}: ${money(round(c.cpa, 0), c.unit)} each, ${times(multiple)} the account median of ${money(round(md, 0), c.unit)}.${c.simulated ? " These ad numbers are simulated: no ad account is connected." : ""}`,
          impact: `Moving this budget to campaigns at the median would buy about ${fmt(Math.max(0, Math.round(c.spend / md - c.conv)))} more conversions for the same spend.`,
          evidence: [c.id], simulated: c.simulated,
          numbers: { cpa: round(c.cpa), median_cpa: round(md), multiple: round(multiple), spend: c.spend, conversions: c.conv, days },
          metrics: ["cpa", "spend", "conversions"],
          score: round(cap(0.45 + 0.1 * (multiple - 1), 0.85) * (c.simulated ? 0.8 : 1)), confidence: c.simulated ? 0.6 : 0.75,
          suggestedAction: {
            kind: "pause_ad",
            payload: {
              title: `Pause ${c.name}`, campaignId: c.id, targetId: c.id, simulated: c.simulated,
              target: `${c.channel ?? "Ads"} · ${c.name}${sim(c.simulated)}`,
              body: `CPA ${money(round(c.cpa, 0), c.unit)} vs ${money(round(md, 0), c.unit)} account median over ${plural(days, "day")} (${times(multiple)}).${c.simulated ? " Simulated campaign: pausing changes Allevia's simulated data only." : ""}`,
            },
          },
        };
      });
  },
};

const adsCtrDrop: Detector = {
  area: "ads",
  async run(g) {
    const { rows, last } = await loadAds(g);
    if (!last) return [];
    const after = sums(rows, addDays(last, -6), last);
    const before = sums(rows, addDays(last, -13), addDays(last, -7));
    const out: Candidate[] = [];
    for (const [id, a] of after) {
      const b = before.get(id);
      if (!b || a.days.size < 3 || b.days.size < 3 || /^(paused|ended|archived)$/i.test(a.status ?? "")) continue;
      const ctrA = (a.m.clicks ?? 0) / (a.m.impressions ?? 0), ctrB = (b.m.clicks ?? 0) / (b.m.impressions ?? 0);
      if (!(Number.isFinite(ctrA) && Number.isFinite(ctrB) && ctrB > 0)) continue;
      const drop = 1 - ctrA / ctrB;
      if (drop < 0.25) continue;
      const label = `"${a.name}"${sim(a.simulated)}`;
      out.push({
        key: `ads.ctr_drop:${id}`, detector: "ads.ctr_drop", area: "ads", agent: "growth-marketer",
        title: `${label} CTR fell ${fmt(round(drop * 100, 0))}% week on week`,
        why: `${label} CTR went from ${pct(ctrB, 2)} to ${pct(ctrA, 2)} in the last 7 days: the audience has seen the creative too often.${a.simulated ? " These ad numbers are simulated: no ad account is connected." : ""}`,
        impact: "A fresh creative usually restores CTR and brings CPA back down.",
        evidence: [id], simulated: a.simulated,
        numbers: { ctr_before_pct: round(ctrB * 100, 2), ctr_after_pct: round(ctrA * 100, 2), drop_pct: round(drop * 100, 1) },
        metrics: ["ctr", "clicks", "impressions"],
        score: round((0.4 + 0.3 * cap(drop)) * (a.simulated ? 0.8 : 1)), confidence: a.simulated ? 0.55 : 0.7,
        suggestedAction: {
          kind: "content_draft",
          payload: {
            title: `New creative for ${a.name}`, format: "ad", targetId: id, target: `${a.channel ?? "Ads"} · ${a.name}${sim(a.simulated)}`,
            body: `CTR fell from ${pct(ctrB, 2)} to ${pct(ctrA, 2)} week on week. Draft a new opening image and first line; keep the offer and the audience.`,
          },
        },
      });
    }
    return out.sort((a, b) => (b.numbers.drop_pct ?? 0) - (a.numbers.drop_pct ?? 0));
  },
};

// ---------- knowledge ----------

const knowledgeOrphanDocs: Detector = {
  area: "knowledge",
  async run(g) {
    // Links made by Allevia itself (a recommendation citing the doc, a brief mentioning it, a turn touching it) do not
    // count: otherwise flagging an orphan would stop it being one.
    const rows = await ro<{ id: string; name: string | null; kind: string | null }>(g,
      `MATCH (d:Document) WHERE coalesce(d.kind, '') <> 'brief'
       OPTIONAL MATCH (d)-[r]-(x:Entity)
       WHERE r.until IS NULL AND NOT type(r) IN ['HAS_CHUNK', 'AUTHORED', 'HAD_VERSION', 'EVIDENCED_BY', 'TOUCHED', 'CITED']
         AND NOT (x:Recommendation OR x:Approval OR x:Action OR x:Turn OR x:Finding OR x:Session OR x:Version)
         AND NOT (x:Document AND x.kind = 'brief')
       WITH d, count(x) AS links WHERE links = 0
       RETURN d.id AS id, d.name AS name, d.kind AS kind ORDER BY id LIMIT 500`);
    if (!rows.length) return [];
    const n = rows.length;
    return [{
      key: "knowledge.orphan_docs:all", detector: "knowledge.orphan_docs", area: "knowledge", agent: "librarian",
      title: `${plural(n, "document")} nothing links to`,
      why: `${plural(n, "document")} ${n === 1 ? "links to nothing, mentions nothing and is" : "link to nothing, mention nothing and are"} cited by nothing: ${list(rows.map((r) => `"${clip(r.name ?? r.id, 40)}"`))}. Link them or retire them so answers do not miss them.`,
      evidence: rows.slice(0, 20).map((r) => r.id), numbers: { docs: n }, score: 0.2, confidence: 0.9,
    }];
  },
};

const OPEN_STATUSES = ["open", "pending", "todo", "in_progress", "blocked", "waiting"];

const knowledgeStaleTasks: Detector = {
  area: "knowledge",
  async run(g, opts) {
    const staleDays = opts.staleDays ?? 14;
    const cutoff = opts.now - staleDays * DAY_MS;
    const rows = await ro<{ id: string; name: string | null; status: string; since: number }>(g,
      `MATCH (t:Task) WHERE toLower(coalesce(t.status, '')) IN $open AND coalesce(t.stateSince, t.updatedAt, t.createdAt) < $cutoff
       RETURN t.id AS id, t.name AS name, t.status AS status, coalesce(t.stateSince, t.updatedAt, t.createdAt) AS since
       ORDER BY since, id LIMIT 500`, { open: OPEN_STATUSES, cutoff });
    if (!rows.length) return [];
    const n = rows.length;
    const age = (r: (typeof rows)[number]) => Math.floor((opts.now - r.since) / DAY_MS);
    const oldest = rows[0]!;
    const lines = rows.slice(0, 10).map((r) => `- ${r.name ?? r.id} (${age(r)} days, ${r.status})`);
    return [{
      key: "knowledge.stale_tasks:all", detector: "knowledge.stale_tasks", area: "knowledge", agent: "librarian",
      title: `${plural(n, "open item")} untouched for ${staleDays}+ days`,
      why: `${plural(n, "open item")} ${n === 1 ? "has" : "have"} not changed in ${staleDays} days or more; the oldest, "${clip(oldest.name ?? oldest.id, 60)}", has waited ${age(oldest)} days. Close, reassign or drop them.`,
      evidence: rows.slice(0, 20).map((r) => r.id), numbers: { tasks: n, oldest_days: age(oldest), stale_days: staleDays },
      score: round(0.3 + cap(n / 30, 0.3)), confidence: 0.9,
      suggestedAction: {
        kind: "discord_post",
        payload: { title: `${plural(n, "open item")} need an owner's call`, body: [`Untouched for ${staleDays}+ days:`, ...lines].join("\n"), target: "team channel", targetId: oldest.id },
      },
    }];
  },
};

const knowledgeUnevidencedDecisions: Detector = {
  area: "knowledge",
  async run(g) {
    const rows = await ro<{ id: string; name: string | null; decidedAt: string | null }>(g,
      `MATCH (d:Decision) WHERE NOT toLower(coalesce(d.status, '')) IN ['superseded', 'rejected', 'deprecated', 'retired']
       OPTIONAL MATCH (d)-[b:BASED_ON]->(x:Entity) WHERE b.until IS NULL
       WITH d, count(x) AS ev WHERE ev = 0
       OPTIONAL MATCH (d)<-[s:SUPERSEDES]-(:Decision) WHERE s.until IS NULL
       WITH d, count(s) AS sup WHERE sup = 0
       RETURN d.id AS id, d.name AS name, d.decidedAt AS decidedAt ORDER BY coalesce(d.decidedAt, '') DESC, id LIMIT 500`);
    if (!rows.length) return [];
    const n = rows.length;
    return [{
      key: "knowledge.unevidenced_decisions:all", detector: "knowledge.unevidenced_decisions", area: "knowledge", agent: "librarian",
      title: `${plural(n, "decision")} with no evidence on record`,
      why: `${plural(n, "decision")} ${n === 1 ? "cites" : "cite"} no number, report or note: ${list(rows.map((r) => `"${clip(r.name ?? r.id, 50)}"`))}. Add what they were based on, so "why did we" has an answer.`,
      evidence: rows.slice(0, 20).map((r) => r.id), numbers: { decisions: n }, score: 0.25, confidence: 0.85,
    }];
  },
};


// ---------- tech: on call (Zoya) and releases (Imran) ----------
//
// Written for an owner who is not an engineer: titles and reasons say "app errors", "crashed", "froze" and "waiting for
// Apple's review", never Sentry, ANR or crash-free. The evidence ids (Observations and Events from the ops snapshot)
// are how the desks, and the "Show how we got this" panel, back every figure.

const NEW_ERRORS_MIN = 10;
const SPIKE_FACTOR = 2;
const SPIKE_FLOOR = 5;
const CRASH_FREE_MIN = 99.5;
const MIN_SESSIONS = 30;
const REVIEW_WAIT_DAYS = 3;
const RELEASE_DROP = 2;
const PLAY_CRASH_LIMIT = 1.09;   // Play's "bad behaviour" lines, used only when the snapshot did not carry them
const PLAY_ANR_LIMIT = 0.47;
const NEAR_LIMIT = 0.8;          // within 80% of a limit is "close to it"

interface ObsRow { id: string; subject: string; value: number; at: string | null; from: string | null; simulated: boolean | null }

// Current Observations of one metric on subjects of one type, newest window first, then the id (so ties are stable).
async function obsSeries(g: Read, metric: string, label: EntityType, limit = 60): Promise<ObsRow[]> {
  if (!LABEL_OK.test(label)) return [];
  return ro<ObsRow>(g,
    `MATCH (o:Observation)-[m:MEASURES]->(s:${label}) WHERE o.metric = $metric AND m.until IS NULL AND coalesce(o.baseline, false) = false
     RETURN o.id AS id, s.id AS subject, o.value AS value, coalesce(o.windowEnd, o.asOf) AS at, o.windowStart AS from, o.simulated AS simulated
     ORDER BY at DESC, id DESC LIMIT $limit`, { metric, limit });
}

interface IssueRow { id: string; name: string | null; level: string | null; unhandled: boolean | null; isNew: boolean | null; unresolved: boolean | null; firstSeen: string | null; lastSeen: string | null; app: string }

// Every Sentry issue Event in the graph, with the Channel it AFFECTS.
async function sentryIssues(g: Read): Promise<IssueRow[]> {
  return ro<IssueRow>(g,
    `MATCH (e:Event)-[a:AFFECTS]->(c:Entity) WHERE e.kind = 'sentry_issue' AND a.until IS NULL
     RETURN e.id AS id, e.name AS name, e.level AS level, e.unhandled AS unhandled, e.isNew AS isNew, e.unresolved AS unresolved,
            e.firstSeen AS firstSeen, e.lastSeen AS lastSeen, c.id AS app
     ORDER BY id LIMIT 500`);
}

const num = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n);
const windowDays = (from: string | null, to: string | null): number | null => {
  const a = dayOf(from), b = dayOf(to);
  return a && b ? Math.round((dayMs(b) - dayMs(a)) / DAY_MS) + 1 : null;
};
const issueLine = (i: IssueRow, events?: number, users?: number): string =>
  `${clip(i.name ?? i.id, 90)}${num(events) ? ` (${plural(events, "time")}${num(users) ? `, ${plural(users, "person", "people")}` : ""})` : ""}`;

const techSentryNewIssues: Detector = {
  area: "tech",
  async run(g, opts) {
    const series = await obsSeries(g, "sentry_new_issues", "Channel");
    const latest = series[0];
    if (!latest || !num(latest.value)) return [];
    const prev = series.find((r) => r.subject === latest.subject && r.at !== latest.at && num(r.value));
    const min = opts.newErrorsMin ?? NEW_ERRORS_MIN;
    const n = latest.value;
    const spike = !!prev && prev.value >= 1 && n >= SPIKE_FLOOR && n >= SPIKE_FACTOR * prev.value;
    if (n < min && !spike) return [];
    const days = windowDays(latest.from, latest.at);
    const issues = (await sentryIssues(g)).filter((i) => i.app === latest.subject && i.isNew);
    const events = await ro<{ id: string; metric: string; value: number }>(g,
      `MATCH (o:Observation)-[m:MEASURES]->(e:Entity:Event) WHERE o.metric IN ['sentry_issue_events', 'sentry_issue_users'] AND m.until IS NULL AND e.id IN $ids
       WITH e, o.metric AS metric, o ORDER BY coalesce(o.windowEnd, o.asOf) DESC, o.id DESC
       RETURN e.id AS id, metric, collect(o.value)[0] AS value ORDER BY id, metric`, { ids: issues.map((i) => i.id) });
    const ev = (id: string, metric: string) => events.find((x) => x.id === id && x.metric === metric)?.value;
    const ranked = issues.slice().sort((a, b) => (ev(b.id, "sentry_issue_users") ?? 0) - (ev(a.id, "sentry_issue_users") ?? 0)
      || (ev(b.id, "sentry_issue_events") ?? 0) - (ev(a.id, "sentry_issue_events") ?? 0) || a.id.localeCompare(b.id));
    const crashing = issues.filter((i) => i.level === "fatal").length;
    const top = ranked[0];
    const span = days ? ` in the last ${plural(days, "day")}` : "";
    const numbers: Record<string, number> = { new_errors: n, ...(days ? { period_days: days } : {}), ...(prev ? { previous_period: prev.value } : {}), ...(crashing ? { crashed_the_app: crashing } : {}) };
    return [{
      key: `tech.sentry_new_issues:${latest.subject}`, detector: "tech.sentry_new_issues", area: "tech", agent: "oncall-engineer",
      title: `${plural(n, "new app error")}${span}`,
      why: `${plural(n, "new kind")} of error ${n === 1 ? "has" : "have"} shown up in the app${days ? ` over ${plural(days, "day")} to ${shortDate(dayOf(latest.at) ?? "")}` : ""}${prev ? `; the period before had ${fmt(prev.value)}` : ""}.`
        + `${crashing ? ` ${plural(crashing, "of the ones we can see")} crashed the app outright.` : ""}`
        + `${top ? ` The one reaching most people: "${issueLine(top, ev(top.id, "sentry_issue_events"), ev(top.id, "sentry_issue_users"))}".` : ""}`,
      impact: "Errors that nobody has looked at tend to turn into bad reviews and uninstalls.",
      evidence: uniq([latest.id, ...(prev ? [prev.id] : []), ...ranked.slice(0, 8).map((i) => i.id)]), numbers, metrics: ["sentry_new_issues"],
      ...(latest.simulated ? { simulated: true } : {}),
      score: round(0.5 + cap(0.01 * n, 0.25) + (spike ? 0.1 : 0)), confidence: 0.75,
      suggestedAction: {
        kind: "github_issue",
        payload: {
          title: `App: look at ${plural(n, "new error")}${span}`,
          body: [`${plural(n, "new error")} first seen${span}${prev ? ` (the period before: ${fmt(prev.value)})` : ""}.`, "",
            ...ranked.slice(0, 10).map((i) => `- [ ] ${issueLine(i, ev(i.id, "sentry_issue_events"), ev(i.id, "sentry_issue_users"))}${i.level === "fatal" ? " (crashed the app)" : ""}`), "",
            "Open each in Sentry, assign an owner, and mark the noise as ignored so the real ones stand out.", "", `Evidence: ${latest.id}`].join("\n"),
          target: "Sentry", targetId: latest.subject,
        },
      },
    }];
  },
};

const techSentryHotIssue: Detector = {
  area: "tech",
  async run(g) {
    const users = await obsSeries(g, "sentry_issue_users", "Event", 300);
    const hits = await obsSeries(g, "sentry_issue_events", "Event", 300);
    if (!users.length && !hits.length) return [];
    const latestOf = (rows: ObsRow[]) => { const m = new Map<string, ObsRow>(); for (const r of rows) if (!m.has(r.subject)) m.set(r.subject, r); return m; };
    const U = latestOf(users), E = latestOf(hits);
    const issues = (await sentryIssues(g)).filter((i) => i.unresolved || i.isNew);
    const appUsers = new Map((await obsSeries(g, "app_users", "Channel", 20)).map((r) => [r.subject, r] as const).reverse());
    const out: Candidate[] = [];
    for (const i of issues) {
      const u = U.get(i.id), e = E.get(i.id);
      const nu = u?.value ?? 0, ne = e?.value ?? 0;
      const all = appUsers.get(i.app);
      const serious = i.level === "fatal" || i.unhandled === true;
      const big = nu >= 5 || ne >= 50 || (nu >= 2 && !!all && num(all.value) && nu * 10 >= all.value);
      if (!serious || !big) continue;
      const days = windowDays((u ?? e)?.from ?? null, (u ?? e)?.at ?? null);
      const numbers: Record<string, number> = { people: nu, times: ne, ...(days ? { period_days: days } : {}), ...(all && num(all.value) ? { people_using_the_app: all.value } : {}) };
      out.push({
        key: `tech.sentry_hot_issue:${i.id}`, detector: "tech.sentry_hot_issue", area: "tech", agent: "oncall-engineer",
        title: `An app error is hitting ${plural(nu, "person", "people")}: "${clip(i.name ?? i.id, 70)}"`,
        why: `"${clip(i.name ?? i.id, 90)}" ${i.level === "fatal" ? "crashed the app" : "failed"} ${plural(ne, "time")} for ${plural(nu, "person", "people")}${days ? ` in ${plural(days, "day")}` : ""}${all && num(all.value) ? `, out of ${fmt(all.value)} who used the app` : ""}.${i.firstSeen ? ` First seen ${shortDate(i.firstSeen)}.` : ""}`,
        impact: "A problem that keeps repeating for the same people is the one they remember.",
        evidence: uniq([i.id, ...(u ? [u.id] : []), ...(e ? [e.id] : []), ...(all ? [all.id] : [])]), numbers, metrics: ["sentry_issue_events", "sentry_issue_users"],
        ...((u ?? e)?.simulated ? { simulated: true } : {}),
        score: round(0.55 + cap(0.02 * nu, 0.2) + (i.level === "fatal" ? 0.1 : 0)), confidence: 0.8,
        suggestedAction: {
          kind: "github_issue",
          payload: {
            title: `App: fix "${clip(i.name ?? i.id, 70)}"`,
            body: [`${issueLine(i, ne, nu)}${days ? ` over ${plural(days, "day")}` : ""}.`, i.firstSeen ? `First seen ${shortDate(i.firstSeen)}${i.lastSeen ? `, last seen ${shortDate(i.lastSeen)}` : ""}.` : "", "",
              "- [ ] Reproduce it from the Sentry event", "- [ ] Fix and ship, then watch the count fall", "", `Evidence: ${i.id}`].filter((l) => l !== "").join("\n"),
            target: "Sentry", targetId: i.id,
          },
        },
      });
    }
    return out.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key)).slice(0, 3);
  },
};

const techCrashFreeLow: Detector = {
  area: "tech",
  async run(g, opts) {
    const rate = (await obsSeries(g, "crash_free_sessions_pct", "Channel", 20))[0];
    if (!rate) return [];
    const sessions = (await obsSeries(g, "app_sessions", "Channel", 20)).find((r) => r.subject === rate.subject);
    const usersPct = (await obsSeries(g, "crash_free_users_pct", "Channel", 20)).find((r) => r.subject === rate.subject);
    const min = opts.crashFreeMin ?? CRASH_FREE_MIN;
    const enough = opts.minSessions ?? MIN_SESSIONS;
    if (!num(rate.value) || rate.value >= min || !sessions || !num(sessions.value) || sessions.value < enough) return [];
    const days = windowDays(rate.from, rate.at);
    const crashed = round(100 - rate.value, 1);
    const hit = usersPct && num(usersPct.value) ? round(100 - usersPct.value, 0) : undefined;
    const numbers: Record<string, number> = { sessions_without_a_crash_pct: rate.value, sessions_that_crashed_pct: crashed, sessions: sessions.value, aim_pct: min, ...(hit !== undefined ? { people_who_hit_a_crash_pct: hit } : {}) };
    return [{
      key: `tech.crash_free_low:${rate.subject}`, detector: "tech.crash_free_low", area: "tech", agent: "oncall-engineer",
      title: `The app crashed in ${fmt(crashed)}% of sessions${days ? ` over ${plural(days, "day")}` : ""}`,
      why: `${fmt(rate.value, 2)}% of ${fmt(sessions.value)} sessions ran without a crash${days ? ` in ${plural(days, "day")} to ${shortDate(dayOf(rate.at) ?? "")}` : ""}; we aim for ${fmt(min)}% or better.${hit !== undefined ? ` About ${fmt(hit)}% of the people who used the app hit a crash.` : ""}`,
      impact: "A crash loses the person in the middle of what they were doing; many do not come back.",
      evidence: uniq([rate.id, sessions.id, ...(usersPct ? [usersPct.id] : [])]), numbers, metrics: ["crash_free_sessions_pct"],
      ...(rate.simulated ? { simulated: true } : {}),
      score: round(0.5 + cap((min - rate.value) / 10, 0.35)), confidence: sessions.value >= 200 ? 0.85 : 0.65,
    }];
  },
};

const techPlayVitals: Detector = {
  area: "tech",
  async run(g) {
    const out: Candidate[] = [];
    for (const [what, rateMetric, limitMetric, fallback, say] of [
      ["crash", "user_perceived_crash_rate_pct", "user_perceived_crash_rate_threshold_pct", PLAY_CRASH_LIMIT, { noun: "had the app crash", kind: "crashes" }],
      ["anr", "user_perceived_anr_rate_pct", "user_perceived_anr_rate_threshold_pct", PLAY_ANR_LIMIT, { noun: "had the app freeze", kind: "freezes" }],
    ] as const) {
      const rate = (await obsSeries(g, rateMetric, "Channel", 10))[0];
      if (!rate || !num(rate.value)) continue;
      const limit = (await obsSeries(g, limitMetric, "Channel", 10)).find((r) => r.subject === rate.subject && num(r.value))?.value ?? fallback;
      if (rate.value < NEAR_LIMIT * limit) continue;
      const over = rate.value >= limit;
      const days = windowDays(rate.from, rate.at);
      out.push({
        key: `tech.play_vitals:${rate.subject}:${what}`, detector: "tech.play_vitals", area: "tech", agent: "oncall-engineer",
        title: `Google Play: ${fmt(rate.value)}% of people ${say.noun}, ${over ? "over" : "close to"} Google's ${fmt(limit)}% limit`,
        why: `${fmt(rate.value)}% of Android users ${say.noun}${days ? ` in the ${plural(days, "day")} to ${shortDate(dayOf(rate.at) ?? "")}` : ""}. Google marks an app as behaving badly above ${fmt(limit)}%${over ? ", and this is above it" : ", and this is close"}.`,
        impact: over ? "Past the limit, Google can show the app to fewer people in the Play Store." : "Crossing the limit can make Google show the app to fewer people.",
        evidence: uniq([rate.id, rate.subject]), numbers: { rate_pct: rate.value, limit_pct: limit, ...(days ? { period_days: days } : {}) }, metrics: [rateMetric],
        ...(rate.simulated ? { simulated: true } : {}),
        score: round(over ? 0.75 + cap((rate.value - limit) / limit / 2, 0.2) : 0.5 + cap((rate.value / limit - NEAR_LIMIT) * 1.5, 0.2)), confidence: 0.85,
        suggestedAction: {
          kind: "github_issue",
          payload: {
            title: `Android: bring ${say.kind} under ${fmt(limit)}% (now ${fmt(rate.value)}%)`,
            body: [`${fmt(rate.value)}% of Android users ${say.noun}; Google's limit is ${fmt(limit)}%.`, "",
              `- [ ] Open Play Console > Android vitals and read the top ${say.kind} clusters`, "- [ ] Ship a fix for the biggest cluster", "", `Evidence: ${rate.id}`].join("\n"),
            target: "Google Play Console", targetId: rate.subject,
          },
        },
      });
    }
    return out;
  },
};

const REVIEW_STATE: Array<[RegExp, string]> = [
  [/UNRESOLVED/i, "held up by a question from Apple"], [/IN_REVIEW/i, "being reviewed now"], [/WAITING/i, "still waiting in line"],
];

const techAppReviewWaiting: Detector = {
  area: "tech",
  async run(g, opts) {
    const days = (await obsSeries(g, "app_review_days_waiting", "Channel", 10))[0];
    const min = opts.reviewWaitDays ?? REVIEW_WAIT_DAYS;
    if (!days || !num(days.value) || days.value < min) return [];
    const [ch] = await ro<{ version: string | null; state: string | null; sent: string | null }>(g,
      "MATCH (c:Entity:Channel {id:$id}) RETURN c.latestVersion AS version, c.latestVersionState AS state, c.reviewSubmittedAt AS sent", { id: days.subject });
    const [ev] = ch?.version ? await ro<{ id: string }>(g, "MATCH (e:Event {kind:'release', platform:'ios', version:$v}) RETURN e.id AS id ORDER BY id LIMIT 1", { v: ch.version }) : [];
    const waited = Math.floor(days.value);
    const what = ch?.version ? `iPhone app update ${ch.version}` : "iPhone app update";
    const state = REVIEW_STATE.find(([re]) => re.test(ch?.state ?? ""))?.[1] ?? "still not approved";
    return [{
      key: `tech.app_review_waiting:${days.subject}`, detector: "tech.app_review_waiting", area: "tech", agent: "qa-release",
      title: `The ${what} has waited ${plural(waited, "day")} for Apple's review`,
      why: `The ${what} was sent to Apple${ch?.sent ? ` on ${shortDate(ch.sent)}` : ""} and is ${state}: ${plural(waited, "day")} so far. Most reviews finish within a couple of days.`,
      impact: "Until Apple approves it, iPhone users keep the old version and anything it fixes stays unfixed.",
      evidence: uniq([days.id, days.subject, ...(ev ? [ev.id] : [])]), numbers: { days_waiting: days.value, limit_days: min }, metrics: ["app_review_days_waiting"],
      ...(days.simulated ? { simulated: true } : {}),
      score: round(0.5 + cap(0.04 * (days.value - min), 0.3)), confidence: 0.85,
    }];
  },
};

const techReleaseHealth: Detector = {
  area: "tech",
  async run(g, opts) {
    const [build] = await ro<{ id: string; name: string | null; at: string }>(g,
      `MATCH (e:Event)-[a:AFFECTS]->(:Entity) WHERE e.kind IN ['build', 'release'] AND a.until IS NULL AND coalesce(e.expired, false) = false
       WITH e, coalesce(e.releasedAt, e.uploadedAt) AS at WHERE at IS NOT NULL
       RETURN DISTINCT e.id AS id, e.name AS name, at ORDER BY at DESC, id DESC LIMIT 1`);
    if (!build) return [];
    const R = dayOf(build.at);
    if (!R) return [];
    const pcts = await obsSeries(g, "crash_free_sessions_daily_pct", "Channel", 120);
    const sess = await obsSeries(g, "app_sessions_daily", "Channel", 120);
    const app = pcts[0]?.subject;
    const sessionsOn = new Map(sess.filter((r) => r.subject === app).map((r) => [r.at, r] as const));
    const days = pcts.filter((r) => r.subject === app && num(r.value) && r.at && sessionsOn.has(r.at)).map((r) => ({ day: dayOf(r.at)!, pct: r.value, n: sessionsOn.get(r.at)!.value, id: r.id }));
    const from = addDays(R, -7);
    const before = days.filter((d) => d.day >= from && d.day < R), after = days.filter((d) => d.day >= R);
    const total = (xs: typeof days) => xs.reduce((a, d) => a + d.n, 0);
    const mean = (xs: typeof days) => xs.reduce((a, d) => a + d.pct * d.n, 0) / total(xs);
    const enough = opts.minSessions ?? MIN_SESSIONS;
    const drop = opts.releaseDropPoints ?? RELEASE_DROP;
    const measured = after.length >= 2 && total(after) >= enough && total(before) >= enough * 2;
    const b = measured ? round(mean(before), 1) : undefined, a = measured ? round(mean(after), 1) : undefined;
    const fell = b !== undefined && a !== undefined && b - a >= drop;
    const newer = (await sentryIssues(g)).filter((i) => i.isNew && i.firstSeen && i.firstSeen >= R && i.app === app);
    const manyNew = newer.length >= 3;
    if (!fell && !manyNew) return [];
    const parts = [
      ...(fell ? [`sessions without a crash fell from ${fmt(b!)}% to ${fmt(a!)}%`] : []),
      ...(manyNew ? [`${plural(newer.length, "new app error")} appeared`] : []),
    ];
    const numbers: Record<string, number> = { ...(fell ? { before_pct: b!, after_pct: a!, sessions_after: total(after) } : {}), ...(manyNew ? { new_errors_since: newer.length } : {}) };
    return [{
      key: `tech.release_health:${build.id}`, detector: "tech.release_health", area: "tech", agent: "qa-release",
      title: `Since the app build of ${shortDate(R)}: ${parts.join(" and ")}`,
      why: `The newest build went up on ${shortDate(R)}. Since then ${parts.join(", and ")}${fell ? ` (the 7 days before it: ${fmt(b!)}%; since: ${fmt(a!)}% across ${fmt(total(after))} sessions)` : ""}.`,
      impact: "A release that makes the app worse is cheapest to fix, or to roll back, in the first few days.",
      evidence: uniq([build.id, ...(fell ? after.slice(-5).map((d) => d.id) : []), ...(manyNew ? newer.slice(0, 5).map((i) => i.id) : [])]), numbers, metrics: ["crash_free_sessions_daily_pct"],
      score: round(0.55 + (fell ? cap((b! - a!) / 20, 0.25) : 0) + (manyNew ? cap(0.02 * newer.length, 0.1) : 0)), confidence: fell ? 0.7 : 0.6,
      suggestedAction: {
        kind: "github_issue",
        payload: {
          title: `Release check: ${parts.join(" and ")} since the build of ${shortDate(R)}`,
          body: [`Build ${build.name ?? build.id} (${R}).`, ...parts.map((p) => `- ${p}`), "",
            "- [ ] Compare the new errors with the changes in this build", "- [ ] Decide: fix forward, or roll back", "", `Evidence: ${build.id}`].join("\n"),
          target: "Release", targetId: build.id,
        },
      },
    }];
  },
};

// ---------- registry ----------

export const DETECTORS = {
  "seo.high_severity_fails": seoHighSeverityFails,
  "seo.low_ctr": seoLowCtr,
  "seo.not_indexed": seoNotIndexed,
  "seo.sitemap": seoSitemap,
  "content.hook_outliers": contentHookOutliers,
  "content.post_outliers": contentPostOutliers,
  "content.underperforming": contentUnderperforming,
  "content.posting_gap": contentPostingGap,
  "funnel.biggest_drop": funnelBiggestDrop,
  "ads.high_cpa": adsHighCpa,
  "ads.ctr_drop": adsCtrDrop,
  "knowledge.orphan_docs": knowledgeOrphanDocs,
  "knowledge.stale_tasks": knowledgeStaleTasks,
  "knowledge.unevidenced_decisions": knowledgeUnevidencedDecisions,
  "tech.sentry_new_issues": techSentryNewIssues,
  "tech.sentry_hot_issue": techSentryHotIssue,
  "tech.crash_free_low": techCrashFreeLow,
  "tech.play_vitals": techPlayVitals,
  "tech.app_review_waiting": techAppReviewWaiting,
  "tech.release_health": techReleaseHealth,
} satisfies Record<string, Detector>;

export type DetectorName = keyof typeof DETECTORS;
export const DETECTOR_NAMES = Object.keys(DETECTORS) as DetectorName[];

export interface DetectorRun { candidates: Candidate[]; ran: DetectorName[]; errors: Array<{ detector: DetectorName; error: string }> }

// Every detector (or `only` these), one after another so a busy shared server is not flooded. A detector that fails is
// reported in `errors`; the others still run.
export async function runDetectors(g: Read, opts: DetectorOpts & { only?: DetectorName[] }): Promise<DetectorRun> {
  const out: DetectorRun = { candidates: [], ran: [], errors: [] };
  for (const name of opts.only ?? DETECTOR_NAMES) {
    try {
      out.candidates.push(...(await DETECTORS[name].run(g, opts)));
      out.ran.push(name);
    } catch (e) {
      out.errors.push({ detector: name, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
