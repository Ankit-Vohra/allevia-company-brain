// Shared reading of numbers (Observation nodes) for the analytics tools: the newest observation per metric and window
// totals, both computed on the server (FalkorDB returns at most 10,000 rows); metric names matched by alias (ingestion
// names vary: views/plays, signups/conversions…); and a bucket aggregated the right way (flows with a window sum,
// snapshots take the latest, rates average). Also the channel lookup the content and playbook tools share.
import { AD_CONVERSION_METRICS, AD_SPEND_METRICS } from "../../insights/ad-cpa.js";
import type { ToolContext } from "../tool.js";
import { aggregateKind, type Aggregate } from "../../graph/observations.js";
import { EDGE, InputError, NODE, ro, type EdgeRow, type NodeRow } from "./common.js";

export interface ObsRow { s: string; o: NodeRow; e: EdgeRow; metric: string; value: number; unit: string | null; ws: string | null; we: string | null; at: string }

export const ALIASES = {
  views: ["views", "plays", "video_views", "reach", "impressions"],
  clicks: ["clicks", "gsc_clicks", "link_clicks"],
  impressions: ["impressions", "gsc_impressions"],
  ctr: ["ctr", "gsc_ctr"],
  position: ["position", "gsc_position", "avg_position"],
  sessions: ["sessions", "ga4_sessions"],
  spend: AD_SPEND_METRICS,
  signups: AD_CONVERSION_METRICS,
} as const;

const OBS_ROW = `{o: ${NODE("o")}, e: ${EDGE("r")}, metric: o.metric, value: o.value, unit: o.unit, ws: o.windowStart, we: o.windowEnd, at: at}`;
const METRICS_PER_SUBJECT = 20;

// The newest observation of each metric (case-insensitive) of each subject, chosen on the server: a dense daily series
// cannot push another subject's numbers out of the result. One row per subject comes back. `metrics` filters.
export async function latestFor(ctx: ToolContext, subjects: string[], metrics?: readonly string[]): Promise<ObsRow[]> {
  if (!subjects.length) return [];
  // Found through the Observation indexes (subject, and metricKey when asked for some metrics), then joined to the edge:
  // walking the subject's in-edges to filter them is a read of every reading it has ever had.
  const rows = await ro<{ s: string; xs: Array<Omit<ObsRow, "s">> }>(ctx,
    `UNWIND $ids AS sid MATCH (o:Observation {subject: sid}) ${metrics ? "WHERE o.metricKey IN $metrics" : ""}
     WITH sid, o MATCH (o)-[r:MEASURES]->(s:Entity {id:sid}) WHERE ID(r) >= 0
     WITH sid, o, r, coalesce(o.windowEnd, o.asOf) AS at
     WITH sid, o.metricKey AS key, o, r, at ORDER BY at DESC, o.id DESC
     WITH sid, key, head(collect(${OBS_ROW})) AS x ORDER BY x.at DESC, key, sid
     RETURN sid AS s, collect(x)[0..$per] AS xs`,
    { ids: subjects, ...(metrics ? { metrics: metrics.map((m) => m.toLowerCase()) } : {}), per: METRICS_PER_SUBJECT });
  return rows.flatMap((r) => r.xs.map((x) => ({ s: r.s, ...x })));
}

// One metric of one subject over a window, totalled on the server (a year of daily numbers for 200 campaigns is
// hundreds of thousands of rows). `newest` keeps the latest few observations, for nodes and provenance. A weekly roll-up
// (graph:compact) counts as the days it holds: its `sum` and `samples`, so a mean over a range that crosses it stays exact.
export interface ObsTotal {
  s: string; metric: string; unit: string | null; n: number; sum: number; last: number; windowed: boolean; simulated: boolean;
  newest: Array<{ o: NodeRow; e: EdgeRow }>;
}

export async function totalsFor(ctx: ToolContext, subjects: string[], opts: { metrics: readonly string[]; from?: string | null; to?: string | null; keep?: number }): Promise<ObsTotal[]> {
  if (!subjects.length) return [];
  return ro<ObsTotal>(ctx,
    `UNWIND $ids AS sid MATCH (o:Observation {subject: sid}) WHERE o.metricKey IN $metrics
     WITH sid, o MATCH (o)-[r:MEASURES]->(s:Entity {id:sid}) WHERE ID(r) >= 0
     WITH sid, o, r, coalesce(o.windowEnd, o.asOf) AS at
     WHERE ($from IS NULL OR at >= $from) AND ($to IS NULL OR at <= $to)
     WITH sid, o.metricKey AS metric, o, r, at ORDER BY at DESC, o.id DESC
     WITH sid, metric, sum(coalesce(o.samples, 1)) AS n, sum(coalesce(o.sum, o.value)) AS sum, collect({o: ${NODE("o")}, e: ${EDGE("r")}, v: o.value, unit: o.unit,
       ws: o.windowStart, sim: o.simulated}) AS xs
     RETURN sid AS s, metric, xs[0].unit AS unit, n, sum, xs[0].v AS last, all(x IN xs WHERE x.ws IS NOT NULL) AS windowed,
       any(x IN xs WHERE x.sim = true) AS simulated, [x IN xs[0..$keep] | {o: x.o, e: x.e}] AS newest`,
    { ids: subjects, metrics: opts.metrics.map((m) => m.toLowerCase()), from: opts.from ?? null, to: opts.to ?? null, keep: opts.keep ?? 2 });
}

// A window total the right way for its metric (see aggregateFor).
export function totalOf(t: ObsTotal): number {
  const kind = kindOf(t.metric, t.unit, t.windowed);
  return kind === "sum" ? t.sum : kind === "mean" ? t.sum / t.n : t.last;
}

// subject -> metric (lowercased) -> newest observation
export function latestByMetric(rows: ObsRow[]): Map<string, Map<string, ObsRow>> {
  const out = new Map<string, Map<string, ObsRow>>();
  for (const r of rows) {
    const m = out.get(r.s) ?? new Map<string, ObsRow>();
    if (!m.has(r.metric.toLowerCase())) m.set(r.metric.toLowerCase(), r);
    out.set(r.s, m);
  }
  return out;
}

export function pick<T>(byMetric: Map<string, T> | undefined, aliases: readonly string[]): T | undefined {
  for (const a of aliases) {
    const v = byMetric?.get(a);
    if (v !== undefined) return v;
  }
  return undefined;
}

export type { Aggregate };

// Rates average; observations with a window (daily signups, weekly clicks) are flows and sum; snapshots without a
// window start (followers, lifetime views) take the latest value (src/graph/observations.ts aggregateKind).
export function aggregateFor(metric: string, unit: string | null, rows: Array<{ ws: string | null }>): Aggregate {
  return kindOf(metric, unit, rows.every((r) => r.ws !== null && r.ws !== undefined));
}

const kindOf = aggregateKind;

// `rows` oldest first.
export function aggregate(kind: Aggregate, rows: Array<{ value: number }>): number {
  if (!rows.length) return 0;
  if (kind === "last") return rows.at(-1)!.value;
  const sum = rows.reduce((s, r) => s + r.value, 0);
  return kind === "sum" ? sum : sum / rows.length;
}

// "instagram", "Instagram", "channel:instagram" -> the Channel node.
export async function resolveChannel(ctx: ToolContext, channel: string): Promise<NodeRow> {
  const key = channel.trim().toLowerCase();
  // a rival's channel (public data) is never "your channel": it is read with the rest and left out here
  const rows = await ro<{ c: NodeRow; rival: boolean | null }>(ctx,
    `MATCH (c:Entity:Channel) WHERE c.id = $raw OR c.id = 'channel:' + $key OR toLower(c.name) = $key OR toLower(c.platform) = $key
     RETURN ${NODE("c")} AS c, c.rival AS rival ORDER BY c.id LIMIT 5`, { raw: channel.trim(), key });
  const own = rows.find((r) => !r.rival);
  if (own) return own.c;
  const all = await ro<{ id: string }>(ctx, "MATCH (c:Channel) WHERE c.rival IS NULL RETURN c.id AS id ORDER BY id LIMIT 30");
  throw new InputError(`No channel ${JSON.stringify(channel)}. Channels: ${all.map((a) => a.id).join(", ") || "none"}.`);
}
