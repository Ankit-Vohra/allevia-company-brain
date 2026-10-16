// The check-up as the graph remembers it (graph audit G4). The findings, what was fixed since last time and the score trend
// used to come from one place: the latest run Document's JSON, so a tenant had a snapshot and no history. They are read from
// the graph now, as traversals over what saveCheckup wrote:
//   - the latest findings are the open `Page|Channel -FAILS-> Rule` edges (`until IS NULL`); each edge carries the whole
//     finding (title, what, why, effort, impact, tier, evidence), so a fix is one group of edges;
//   - "fixed since last time" is the edges closed with the reason 'website check-up: fixed' by the latest run, for fixes with
//     no edge left open; "new since last time" is a fix whose open edges all began with the latest run;
//   - the score trend is the `checkup_*` Observations that MEASURE `channel:website`, one per metric per run.
// The report Document's JSON stays as the fallback for a run stored before the edges carried a finding (no `title` on them),
// which `checkupHistory` reports as `fromGraph: false`.
import type { GraphHandle } from "../graph/client.js";
import { channelId } from "../ingest/sources/channels.js";
import { FIX_BY_KEY, byImpact, pageWeight, topFixes, type Fix, type Tier, type Who } from "./fixes.js";
import { CHECKUP_METRICS, type CheckupMetric } from "./store.js";

type Read = Pick<GraphHandle, "roQuery">;

// The reason saveCheckup closes a FAILS edge with when a later run no longer finds the problem.
export const FIXED_REASON = "website check-up: fixed";

// The numbers an owner reads, in their words (the metric keys are never shown).
export const SCORE_WORDS: Partial<Record<CheckupMetric, string>> = {
  checkup_mobile_speed: "speed on phones", checkup_easy_to_use: "easy to use", checkup_google_basics: "Google basics",
};

export type Finding = Pick<Fix, "key" | "title" | "what" | "why" | "who" | "effort" | "minutes" | "impact" | "tier" | "pages" | "pageCount" | "evidence">;

interface OpenRow {
  rule: string; key: string | null; at: string; url: string | null; path: string | null; labels: string[];
  title: string | null; what: string | null; why: string | null; who: string | null; effort: string | null; minutes: number | null;
  count: number | null; impact: number | null; tier: string | null; items: string[] | null; evidence: string | null; since: number | null;
}

const TIERS = new Set<string>(["losing enquiries", "harder to find or trust", "tidy-up"]);

// The open findings, best first, or null when the open edges do not carry a whole finding (a run stored before they did).
export async function openFindings(g: Read): Promise<{ all: Finding[]; since: Map<string, number> } | null> {
  const rows = await g.roQuery<OpenRow>(
    `MATCH (x:Entity)-[e:FAILS]->(r:Entity:Rule) WHERE e.until IS NULL AND r.kind = 'website-check'
     RETURN r.id AS rule, r.issueType AS key, x.id AS at, x.url AS url, x.path AS path, labels(x) AS labels, e.title AS title, e.what AS what,
            e.why AS why, e.who AS who, e.effort AS effort, e.minutes AS minutes, e.pageCount AS count, e.impact AS impact, e.tier AS tier,
            e.evidenceItems AS items, e.evidence AS evidence, e.since AS since
     ORDER BY rule, at LIMIT 5000`);
  if (rows.some((r) => !r.key || typeof r.title !== "string" || typeof r.impact !== "number")) return null;
  const by = new Map<string, OpenRow[]>();
  for (const r of rows) by.set(r.key!, [...(by.get(r.key!) ?? []), r]);
  const since = new Map<string, number>();
  const all: Finding[] = [];
  for (const [key, rs] of by) {
    const first = rs[0]!;
    const pageRows = rs.filter((r) => r.labels.includes("Page"));
    const pages = pageRows
      .map((r) => ({ url: r.url ?? r.at, path: r.path ?? r.url ?? r.at }))
      .sort((a, b) => pageWeight(b.url) - pageWeight(a.url) || a.url.localeCompare(b.url));
    const items = Array.isArray(first.items) ? first.items : first.evidence ? first.evidence.split(" | ") : [];
    all.push({
      key, title: first.title!, what: first.what ?? "", why: first.why ?? "", who: (first.who === "you" ? "you" : "your web person") as Who,
      effort: first.effort ?? "", minutes: first.minutes ?? 0, impact: first.impact!, tier: (TIERS.has(first.tier ?? "") ? first.tier : "tidy-up") as Tier,
      pages: pages.map((p) => p.path).slice(0, 12), pageCount: Math.max(first.count ?? 0, pages.length), evidence: items,
    });
    since.set(key, Math.min(...rs.map((r) => r.since ?? Number.MAX_SAFE_INTEGER)));
  }
  return { all: all.sort(byImpact), since };
}

// Fixes whose edges a run closed as fixed (and none is open now), with their titles as they were when they failed.
export async function fixedSince(g: Read, sinceMs: number, stillOpen: Set<string>): Promise<Array<{ key: string; title: string }>> {
  const rows = await g.roQuery<{ rule: string; key: string | null; title: string | null; ruleTitle: string | null; at: string }>(
    `MATCH (x:Entity)-[e:FAILS]->(r:Entity:Rule) WHERE e.until IS NOT NULL AND e.closeReason = $reason AND e.until >= $since AND r.kind = 'website-check'
     RETURN r.id AS rule, r.issueType AS key, e.title AS title, r.title AS ruleTitle, x.id AS at ORDER BY rule, at LIMIT 5000`,
    { reason: FIXED_REASON, since: sinceMs });
  const out = new Map<string, { key: string; title: string }>();
  const counts = new Map<string, number>();
  for (const r of rows) if (r.key) counts.set(r.key, (counts.get(r.key) ?? 0) + 1);
  for (const r of rows) {
    if (!r.key || stillOpen.has(r.key) || out.has(r.key)) continue;
    out.set(r.key, { key: r.key, title: r.title ?? FIX_BY_KEY.get(r.key)?.title(counts.get(r.key) ?? 1) ?? r.ruleTitle ?? r.key });
  }
  return [...out.values()];
}

export interface TrendPoint { asOf: string; checkedOn: string; scores: Record<string, number> }

// One point per run: the owner-facing scores of the website channel, oldest first.
export async function scoreTrend(g: Read, runs = 12): Promise<TrendPoint[]> {
  const metrics = Object.keys(SCORE_WORDS);
  const rows = await g.roQuery<{ metric: string; value: number; asOf: string }>(
    `MATCH (o:Observation)-[m:MEASURES]->(c:Entity:Channel {id:$site}) WHERE m.until IS NULL AND o.metric IN $metrics
     RETURN o.metric AS metric, o.value AS value, o.asOf AS asOf ORDER BY asOf DESC, o.id LIMIT $cap`,
    { site: channelId("website"), metrics, cap: runs * metrics.length });
  const byRun = new Map<string, Record<string, number>>();
  for (const r of rows) {
    if (typeof r.value !== "number" || !r.asOf) continue;
    byRun.set(r.asOf, { ...(byRun.get(r.asOf) ?? {}), [SCORE_WORDS[r.metric as CheckupMetric]!]: r.value });
  }
  return [...byRun.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-runs).map(([asOf, scores]) => ({ asOf, checkedOn: asOf.slice(0, 10), scores }));
}

export interface CheckupHistory {
  fromGraph: boolean;          // false: the graph could not give the findings, use the report's own JSON
  all: Finding[];
  top: Finding[];
  fixed: string[];             // titles of what the latest run found fixed
  fresh: string[];             // titles of what the latest run found for the first time (only when there was an earlier run)
  trend: TrendPoint[];
}

/** What the latest check-up found and how it compares with the ones before, from the graph. `cur.fixKeys` is the report's own list, used to tell a quiet graph from an old one. */
export async function checkupHistory(g: Read, cur: { asOf: string; fixCount: number }, hasPrevious: boolean): Promise<CheckupHistory> {
  const trend = await scoreTrend(g);
  const open = await openFindings(g);
  // no open edge for a report that lists fixes: the edges are not this run's to explain (or are in the old shape), so the report speaks
  if (!open || (!open.all.length && cur.fixCount > 0)) return { fromGraph: false, all: [], top: [], fixed: [], fresh: [], trend };
  const runMs = Date.parse(cur.asOf);
  const openKeys = new Set(open.all.map((f) => f.key));
  const fixed = Number.isFinite(runMs) ? (await fixedSince(g, runMs, openKeys)).map((f) => f.title) : [];
  const isNew = (f: Finding) => (open.since.get(f.key) ?? 0) >= runMs;
  // an earlier run with nothing wrong has no "new since" to compare against: everything would be new
  const hadFixes = fixed.length > 0 || open.all.some((f) => !isNew(f));
  const fresh = hasPrevious && hadFixes && Number.isFinite(runMs) ? open.all.filter(isNew).map((f) => f.title) : [];
  return { fromGraph: true, all: open.all, top: topFixes(open.all), fixed, fresh, trend };
}
