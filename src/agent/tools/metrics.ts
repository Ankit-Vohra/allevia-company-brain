// metric_trend: a metric over time for one subject (or a summary per subject when none is given), with first, last,
// min, max, delta and percent change. Observations carry the numbers; their source documents come back as nodes and
// sources so every figure is citable. Simulated observations are flagged.
import { z } from "zod";
import type { ToolContext } from "../tool.js";
import {
  Collector, EDGE, InputError, NODE, brief, defineTool, requireNode, ro, round, sourceRows, type EdgeRow, type NodeRow,
} from "./common.js";
import { aggregate, aggregateFor, type Aggregate } from "./observations.js";

const MAX_POINTS = 60;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

interface Row { s: NodeRow; o: NodeRow; e: EdgeRow; value: number; unit: string | null; ws: string | null; at: string }
interface Point { date: string; value: number }

export function weekStart(date: string): string {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

export function stats(points: Point[]) {
  const values = points.map((p) => p.value);
  const first = values[0]!;
  const last = values.at(-1)!;
  return {
    points: points.length, from: points[0]!.date, to: points.at(-1)!.date, first, last,
    min: Math.min(...values), max: Math.max(...values), delta: round(last - first),
    pctChange: first !== 0 ? round(((last - first) / Math.abs(first)) * 100, 1) : null,
  };
}

function series(rows: Row[], groupBy: "day" | "week" | undefined, agg: Aggregate): Point[] {
  if (!groupBy) return rows.map((r) => ({ date: r.at.slice(0, 10), value: r.value }));
  const buckets = new Map<string, Row[]>();
  for (const r of rows) {
    const key = groupBy === "week" ? weekStart(r.at) : r.at.slice(0, 10);
    buckets.set(key, [...(buckets.get(key) ?? []), r]);
  }
  return [...buckets.entries()].map(([date, rs]) => ({ date, value: round(aggregate(agg, rs), 4) }));
}

async function runTrend(args: { metric: string; subject?: string; from?: string; to?: string; groupBy?: "day" | "week" }, ctx: ToolContext) {
  for (const d of [args.from, args.to]) if (d && !ISO_DATE.test(d)) throw new InputError(`Dates must be ISO like 2026-10-01, got ${JSON.stringify(d)}.`);
  const subject = args.subject ? await requireNode(ctx, args.subject) : null;
  // `to` is inclusive of the whole day: "2026-10-10T08:00Z" <= "2026-10-10~" because "~" sorts after "T".
  const p = { m: args.metric.trim().toLowerCase(), sid: subject?.id ?? null, from: args.from?.slice(0, 10) ?? null, to: args.to ? `${args.to.slice(0, 10)}~` : null };
  const rows = await ro<Row>(ctx,
    `MATCH (o:Observation)-[r:MEASURES]->(s:Entity) WHERE toLower(o.metric) = $m AND ($sid IS NULL OR s.id = $sid)
     WITH s, o, r, coalesce(o.windowEnd, o.asOf) AS at WHERE ($from IS NULL OR at >= $from) AND ($to IS NULL OR at <= $to)
     RETURN ${NODE("s")} AS s, ${NODE("o")} AS o, ${EDGE("r")} AS e, o.value AS value, o.unit AS unit, o.windowStart AS ws, at
     ORDER BY at, o.id LIMIT 2000`, p);
  if (!rows.length) {
    const avail = await ro<{ m: string }>(ctx,
      "MATCH (o:Observation)-[:MEASURES]->(s:Entity) WHERE $sid IS NULL OR s.id = $sid RETURN DISTINCT o.metric AS m ORDER BY m LIMIT 40", p);
    throw new InputError(`No ${JSON.stringify(args.metric)} observations${subject ? ` for ${subject.id}` : ""}${args.from || args.to ? " in that range" : ""}. Metrics available: ${avail.map((a) => a.m).join(", ") || "none"}.`);
  }

  const bySubject = new Map<string, Row[]>();
  for (const r of rows) bySubject.set(r.s.id, [...(bySubject.get(r.s.id) ?? []), r]);
  const unit = rows.find((r) => r.unit)?.unit ?? null;
  const agg = aggregateFor(args.metric, unit, rows);
  const simulated = rows.some((r) => r.o.simulated === true);
  const col = new Collector();
  const used: Row[] = [];
  const notes: string[] = [];
  let data: Record<string, unknown>;

  if (bySubject.size === 1) {
    const only = [...bySubject.values()][0]!;
    let pts = series(only, args.groupBy, agg);
    if (pts.length > MAX_POINTS) {
      notes.push(`Showing the latest ${MAX_POINTS} of ${pts.length} points; use groupBy "week" for the whole range.`);
      pts = pts.slice(-MAX_POINTS);
    }
    col.node(only[0]!.s);
    const bucket = (r: Row) => (args.groupBy === "week" ? weekStart(r.at) : r.at.slice(0, 10));
    used.push(...only.filter((r) => bucket(r) >= pts[0]!.date));
    data = { metric: args.metric, unit, subject: brief(only[0]!.s), ...(args.groupBy ? { groupBy: args.groupBy, aggregate: agg } : {}), series: pts, stats: stats(pts) };
  } else {
    const summaries = [...bySubject.values()].map((rs) => {
      const pts = series(rs, args.groupBy, agg);
      return { subject: rs[0]!.s, rows: rs, stats: stats(pts) };
    }).sort((a, b) => b.stats.last - a.stats.last).slice(0, 10);
    for (const s of summaries) {
      col.node(s.subject);
      used.push(...s.rows.slice(-3));
    }
    notes.push(`${bySubject.size} subjects have ${args.metric}; pass subject for one full series.`);
    data = { metric: args.metric, unit, bySubject: summaries.map((s) => ({ ...brief(s.subject), ...s.stats })) };
  }
  for (const r of used.slice(-MAX_POINTS * 2)) {
    col.node(r.o);
    col.edge(r.e);
  }
  // The observations' documents are evidence too: return them as nodes, not only as sources.
  for (const s of await sourceRows(ctx, used.map((r) => r.o.id))) col.ref({ id: s.id, label: "Document", name: s.title ?? s.id, ...(s.asOf ? { asOf: s.asOf } : {}) });
  if (simulated) notes.unshift("Includes simulated data.");
  return col.result(ctx, { ...data, ...(simulated ? { simulated: true } : {}) }, notes.join(" ") || undefined);
}

export const metricTrend = defineTool({
  name: "metric_trend",
  description:
    "A number over time from Observations: the series plus first/last/min/max/delta/pctChange, for one subject (or a per-subject summary if none given). groupBy day|week sums flows, keeps the latest snapshot, averages rates. Unknown metric names list what exists. Example: {\"metric\":\"signups\",\"subject\":\"business:aamdani\",\"from\":\"2026-10-01\",\"groupBy\":\"week\"}",
  input: {
    metric: z.string().min(1).describe("Metric name, e.g. signups, followers, views, clicks"),
    subject: z.string().optional().describe("Id of what is measured"),
    from: z.string().optional().describe("ISO date, inclusive"),
    to: z.string().optional().describe("ISO date, inclusive"),
    groupBy: z.enum(["day", "week"]).optional(),
  },
  run: runTrend,
});
