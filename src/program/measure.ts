// A goal's number, read from the Observations already in the graph (product design §3.3 "goals and baselines are
// locked", §9 item 5 "goals against real historical Observations"). Nothing here invents a value: a source either has
// a complete, recent reading for the goal's period or it has nothing.
//   daily_sum  one reading per day (windowStart = windowEnd) for each of the period's days, summed. Every day must be
//              there; a day counts only once its source reported it after the day was over (a snapshot taken at noon
//              holds half a day).
//   window     one reading whose window spans about the period (25-30 days for a month, 4-9 for a week), reported
//              after its window closed.
// Simulated and baseline Observations never count, and the newest complete period must have ended within
// MAX_AGE_DAYS of today.
import type { GraphHandle } from "../graph/client.js";
import { addDays, dayMs, dayOf, DAY_MS, shortDate } from "../insights/text.js";
import { PERIOD_DAYS, type GoalPeriod, type MetricSource } from "../onboard/templates.js";

type Read = Pick<GraphHandle, "roQuery">;

export const MAX_AGE_DAYS = 14;

export interface Reading {
  value: number;
  windowStart: string;
  windowEnd: string;
  asOf: string;             // the newest source date among the readings used
  src: string;              // the source Document of the readings (the newest one when they differ)
  conf: number | null;      // the weakest conf among them; null = all measured by a connector
  obsIds: string[];
  evidence: string;         // in words: what was added up, over which days
  source: MetricSource;
  subjectId: string;
}

interface Row { id: string; value: number | null; ws: string | null; we: string | null; asOf: string | null; src: string | null; conf: number | null }

async function rowsFor(g: Read, metric: string, subject: string): Promise<Row[]> {
  return g.roQuery<Row>(
    `MATCH (o:Observation)-[m:MEASURES]->(s:Entity {id:$subject})
     WHERE o.metric = $metric AND m.until IS NULL AND coalesce(o.baseline, false) = false AND coalesce(o.simulated, false) = false
     RETURN o.id AS id, o.value AS value, o.windowStart AS ws, o.windowEnd AS we, o.asOf AS asOf, o.src AS src, o.conf AS conf
     ORDER BY coalesce(o.windowEnd, o.asOf) DESC, id LIMIT 2000`, { metric, subject });
}

const span = (ws: string, we: string) => Math.round((dayMs(we) - dayMs(ws)) / DAY_MS);
const better = (a: Row, b: Row) => (a.conf ?? 1) > (b.conf ?? 1) || ((a.conf ?? 1) === (b.conf ?? 1) && (a.asOf ?? "") > (b.asOf ?? ""));
// Reported after the window closed (or the window ended before today when the source gave no date).
const complete = (r: Row, we: string, today: string) => we < today && (!dayOf(r.asOf) || dayOf(r.asOf)! > we);
const weakest = (rows: Row[]): number | null => rows.reduce<number | null>((m, r) => (r.conf === null || r.conf === undefined ? m : m === null ? r.conf : Math.min(m, r.conf)), null);
const newest = (rows: Row[]): Row => rows.reduce((a, b) => ((dayOf(b.asOf) ?? "") > (dayOf(a.asOf) ?? "") ? b : a));

function humanMetric(m: string): string {
  return m.replace(/_/g, " ");
}

export interface ReadOpts {
  businessId: string;
  period: GoalPeriod;
  today: string;            // the owner's local date; a period must have ended before it
  maxAgeDays?: number;
  until?: string;           // read the period ending on or before this day (default: the newest complete one)
}

export async function readSource(g: Read, source: MetricSource, o: ReadOpts): Promise<Reading | null> {
  const subjectId = source.subject === "business" ? o.businessId : source.subject;
  const days = PERIOD_DAYS[o.period];
  const oldest = addDays(o.today, -(o.maxAgeDays ?? MAX_AGE_DAYS) - 1);
  const rows = (await rowsFor(g, source.metric, subjectId)).filter((r) => typeof r.value === "number" && Number.isFinite(r.value));

  if (source.agg === "window") {
    const fits = rows.filter((r) => {
      const ws = dayOf(r.ws), we = dayOf(r.we);
      if (!ws || !we) return false;
      const s = span(ws, we);
      return s >= days - 3 && s <= days + 2 && complete(r, we, o.today) && we > oldest && (!o.until || we <= o.until);
    });
    if (!fits.length) return null;
    const latestEnd = fits.map((r) => dayOf(r.we)!).sort().at(-1)!;
    const pick = fits.filter((r) => dayOf(r.we) === latestEnd).reduce((a, b) => (better(b, a) ? b : a));
    const ws = dayOf(pick.ws)!;
    return {
      value: pick.value!, windowStart: ws, windowEnd: latestEnd, asOf: dayOf(pick.asOf) ?? latestEnd, src: pick.src ?? "", conf: pick.conf ?? null,
      obsIds: [pick.id], source, subjectId,
      evidence: `${humanMetric(source.metric)} reported for ${shortDate(ws)} to ${shortDate(latestEnd)}.`,
    };
  }

  // daily_sum: the best reading per complete day
  const byDay = new Map<string, Row>();
  for (const r of rows) {
    const ws = dayOf(r.ws), we = dayOf(r.we);
    if (!ws || !we || ws !== we || !complete(r, we, o.today)) continue;
    const have = byDay.get(we);
    if (!have || better(r, have)) byDay.set(we, r);
  }
  const ends = [...byDay.keys()].filter((d) => d > oldest && (!o.until || d <= o.until)).sort().reverse();
  for (const end of ends) {
    const want = Array.from({ length: days }, (_, i) => addDays(end, -i));
    if (!want.every((d) => byDay.has(d))) continue;
    const used = want.map((d) => byDay.get(d)!);
    const start = want.at(-1)!;
    const top = newest(used);
    return {
      value: used.reduce((s, r) => s + r.value!, 0), windowStart: start, windowEnd: end, asOf: dayOf(top.asOf) ?? end, src: top.src ?? "",
      conf: weakest(used), obsIds: used.map((r) => r.id).sort(), source, subjectId,
      evidence: `Sum of ${days} daily ${humanMetric(source.metric)} readings, ${shortDate(start)} to ${shortDate(end)}.`,
    };
  }
  return null;
}

// The first source with a reading, best first.
export async function readGoal(g: Read, sources: readonly MetricSource[], o: ReadOpts): Promise<Reading | null> {
  for (const s of sources) {
    const r = await readSource(g, s, o);
    if (r) return r;
  }
  return null;
}
