// Shared reading of numbers (Observation nodes) for the analytics tools: fetch observations for subjects, keep the
// latest per metric, match metric names by alias (ingestion names vary: views/plays, signups/conversions…), and
// aggregate a bucket the right way (flows with a window sum, snapshots take the latest, rates average). Also the
// channel lookup the content and playbook tools share.
import type { ToolContext } from "../tool.js";
import { EDGE, InputError, NODE, ro, type EdgeRow, type NodeRow } from "./common.js";

export interface ObsRow { s: string; o: NodeRow; e: EdgeRow; metric: string; value: number; unit: string | null; ws: string | null; we: string | null; at: string }

export const ALIASES = {
  views: ["views", "plays", "video_views", "reach", "impressions"],
  clicks: ["clicks", "gsc_clicks", "link_clicks"],
  impressions: ["impressions", "gsc_impressions"],
  ctr: ["ctr", "gsc_ctr"],
  position: ["position", "gsc_position", "avg_position"],
  sessions: ["sessions", "ga4_sessions"],
  spend: ["spend", "ad_spend", "cost", "amount_spent"],
  signups: ["signups", "conversions", "results", "leads"],
} as const;

// Newest first. `metrics` are matched case-insensitively; `from`/`to` are ISO dates on windowEnd (or asOf).
export async function observationsFor(ctx: ToolContext, subjects: string[], opts: { metrics?: string[]; from?: string | null; to?: string | null; limit?: number } = {}): Promise<ObsRow[]> {
  if (!subjects.length) return [];
  return ro<ObsRow>(ctx,
    `UNWIND $ids AS sid MATCH (o:Observation)-[r:MEASURES]->(:Entity {id:sid})
     WITH sid, o, r, coalesce(o.windowEnd, o.asOf) AS at
     WHERE ($metrics IS NULL OR toLower(o.metric) IN $metrics) AND ($from IS NULL OR at >= $from) AND ($to IS NULL OR at <= $to)
     RETURN sid AS s, ${NODE("o")} AS o, ${EDGE("r")} AS e, o.metric AS metric, o.value AS value, o.unit AS unit,
       o.windowStart AS ws, o.windowEnd AS we, at ORDER BY at DESC, o.id LIMIT $limit`,
    { ids: subjects, metrics: opts.metrics?.map((m) => m.toLowerCase()) ?? null, from: opts.from ?? null, to: opts.to ?? null, limit: opts.limit ?? 5000 });
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

const RATE = /ctr|rate|ratio|position|avg|average|mean|percent|pct|duration|watch|cpa|cpc|cpm|score|share_of/i;

export type Aggregate = "sum" | "mean" | "last";

// Rates average; observations with a window (daily signups, weekly clicks) are flows and sum; snapshots without a
// window start (followers, lifetime views) take the latest value.
export function aggregateFor(metric: string, unit: string | null, rows: Array<{ ws: string | null }>): Aggregate {
  if (RATE.test(metric) || /%|percent|ratio|position/i.test(unit ?? "")) return "mean";
  return rows.every((r) => r.ws !== null && r.ws !== undefined) ? "sum" : "last";
}

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
  const rows = await ro<{ c: NodeRow }>(ctx,
    `MATCH (c:Channel) WHERE c.id = $raw OR c.id = 'channel:' + $key OR toLower(c.name) = $key OR toLower(c.platform) = $key
     RETURN ${NODE("c")} AS c ORDER BY c.id LIMIT 1`, { raw: channel.trim(), key });
  if (rows[0]) return rows[0].c;
  const all = await ro<{ id: string }>(ctx, "MATCH (c:Channel) RETURN c.id AS id ORDER BY id LIMIT 30");
  throw new InputError(`No channel ${JSON.stringify(channel)}. Channels: ${all.map((a) => a.id).join(", ") || "none"}.`);
}
