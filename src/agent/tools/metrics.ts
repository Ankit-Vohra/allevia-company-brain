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
const SERIES_CAP = 5_000;      // newest observations read for one subject
const SUMMARY_SUBJECTS = 10;
const SUMMARY_POINTS = 500;    // newest observations read per subject in a summary
const DOC_NODES = 20;
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

// For an unknown metric name: the metrics that share a word with it first (most shared words first; "clicks" ~ "click"),
// then the rest alphabetically, cut at `limit`. A tenant can have 80+ metrics, and an alphabetical list cut at 40 hid
// every signup_funnel_* metric from a desk that asked for "funnel" (eval 2026-10-15).
const stem = (w: string): string => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w);
const words = (s: string): string[] => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3).map(stem);

export function suggestMetrics(asked: string, available: string[], limit = 40): { shown: string[]; related: number; more: number } {
  const want = new Set(words(asked));
  const score = (m: string): number => new Set(words(m).filter((w) => want.has(w))).size;
  const ranked = [...new Set(available)].map((m) => ({ m, s: score(m) })).sort((a, b) => b.s - a.s || a.m.localeCompare(b.m));
  const shown = ranked.slice(0, limit);
  return { shown: shown.map((x) => x.m), related: shown.filter((x) => x.s > 0).length, more: Math.max(0, ranked.length - limit) };
}

// Per subject, the newest `per` observations of the metric in range, oldest first, plus how many there are.
async function seriesFor(ctx: ToolContext, p: Record<string, unknown>, sids: string[], per: number): Promise<Array<{ n: number; rows: Row[] }>> {
  const res = await ro<{ n: number; rows: Row[] }>(ctx,
    // The series is found through the Observation indexes (subject, metricKey), then joined to its edge: the subject of a
    // dense daily series has an in-edge per reading, and walking them all to filter by metric is what this avoids.
    `UNWIND $sids AS sid MATCH (o:Observation {subject: sid}) WHERE o.metricKey = $m
     WITH sid, o MATCH (o)-[r:MEASURES]->(s:Entity {id:sid}) WHERE ID(r) >= 0
     WITH s, o, r, coalesce(o.windowEnd, o.asOf) AS at WHERE ($from IS NULL OR at >= $from) AND ($to IS NULL OR at <= $to)
     WITH s, o, r, at ORDER BY at DESC, o.id DESC
     WITH s, count(o) AS n, collect({s: ${NODE("s")}, o: ${NODE("o")}, e: ${EDGE("r")}, value: o.value, unit: o.unit, ws: o.windowStart, at: at})[0..$per] AS rows
     RETURN n, rows`, { ...p, sids, per });
  return res.map((r) => ({ n: r.n, rows: [...r.rows].reverse() }));
}

async function runTrend(args: { metric: string; subject?: string; from?: string; to?: string; groupBy?: "day" | "week" }, ctx: ToolContext) {
  for (const d of [args.from, args.to]) if (d && !ISO_DATE.test(d)) throw new InputError(`Dates must be ISO like 2026-10-01, got ${JSON.stringify(d)}.`);
  const subject = args.subject ? await requireNode(ctx, args.subject) : null;
  // `to` is inclusive of the whole day: "2026-10-10T08:00Z" <= "2026-10-10~" because "~" sorts after "T".
  const p = { m: args.metric.trim().toLowerCase(), sid: subject?.id ?? null, from: args.from?.slice(0, 10) ?? null, to: args.to ? `${args.to.slice(0, 10)}~` : null };
  // Without a subject: every subject's latest value, ranked on the server (subjects x days can pass 10,000 rows), then
  // the top SUMMARY_SUBJECTS read in full.
  const [ranked] = subject ? [null] : await ro<{ subjects: number; top: string[] }>(ctx,
    `MATCH (o:Observation)-[r:MEASURES]->(s:Entity) WHERE o.metricKey = $m AND ID(r) >= 0
     WITH s, o, coalesce(o.windowEnd, o.asOf) AS at WHERE ($from IS NULL OR at >= $from) AND ($to IS NULL OR at <= $to)
     WITH s, o, at ORDER BY at DESC, o.id DESC
     WITH s, head(collect(o.value)) AS last ORDER BY last DESC, s.id
     WITH collect(s.id) AS ids RETURN size(ids) AS subjects, ids[0..$k] AS top`, { ...p, k: SUMMARY_SUBJECTS });
  const sids = subject ? [subject.id] : ranked?.top ?? [];
  const read = sids.length ? await seriesFor(ctx, p, sids, subject ? SERIES_CAP : SUMMARY_POINTS) : [];
  const rows = read.flatMap((x) => x.rows);
  if (!rows.length) {
    const avail = await ro<{ m: string }>(ctx,
      `${p.sid ? "MATCH (o:Observation {subject: $sid})" : "MATCH (o:Observation)"} RETURN DISTINCT o.metric AS m ORDER BY m LIMIT 1000`, p);
    const hint = suggestMetrics(args.metric, avail.map((a) => a.m).filter((m): m is string => typeof m === "string"));
    throw new InputError(`No ${JSON.stringify(args.metric)} observations${subject ? ` for ${subject.id}` : ""}${args.from || args.to ? " in that range" : ""}. ` +
      `Metrics available${hint.related ? " (closest first)" : ""}: ${hint.shown.join(", ") || "none"}${hint.more ? `, and ${hint.more} more` : ""}.`);
  }
  const cut = read.filter((x) => x.n > x.rows.length).length;

  const bySubject = new Map<string, Row[]>(read.filter((x) => x.rows.length).map((x) => [x.rows[0]!.s.id, x.rows]));
  const unit = rows.find((r) => r.unit)?.unit ?? null;
  const agg = aggregateFor(args.metric, unit, rows);
  const simulated = rows.some((r) => r.o.simulated === true);
  const col = new Collector();
  const used: Row[] = [];
  const notes: string[] = [];
  let data: Record<string, unknown>;

  if (subject) {
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
    }).sort((a, b) => b.stats.last - a.stats.last || a.subject.id.localeCompare(b.subject.id));
    for (const s of summaries) {
      col.node(s.subject);
      used.push(...s.rows.slice(-3));
    }
    notes.push(`${ranked?.subjects ?? bySubject.size} subjects have ${args.metric}${(ranked?.subjects ?? 0) > summaries.length ? `; the ${summaries.length} with the highest latest value are shown` : ""}; pass subject for one full series.`);
    data = { metric: args.metric, unit, bySubject: summaries.map((s) => ({ ...brief(s.subject), ...s.stats })) };
  }
  // The newest MAX_POINTS observations behind the figures come back as nodes, the rest as provenance; their documents
  // are evidence too, so up to DOC_NODES of them are returned as nodes, not only as sources.
  const shownObs = used.slice(-MAX_POINTS);
  for (const r of shownObs) {
    col.node(r.o);
    col.edge(r.e);
  }
  col.provenance(used.slice(0, -MAX_POINTS).map((r) => r.o.id));
  const docs = new Map((await sourceRows(ctx, shownObs.map((r) => r.o.id))).map((s) => [s.id, s]));
  for (const s of [...docs.values()].slice(0, DOC_NODES)) col.ref({ id: s.id, label: "Document", name: s.title ?? s.id, ...(s.asOf ? { asOf: s.asOf } : {}) });
  if (cut) notes.push(subject ? `Read the newest ${SERIES_CAP.toLocaleString("en-US")} of ${read[0]!.n.toLocaleString("en-US")} observations; narrow with from/to.`
    : `Summaries use each subject's newest ${SUMMARY_POINTS} observations.`);
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
