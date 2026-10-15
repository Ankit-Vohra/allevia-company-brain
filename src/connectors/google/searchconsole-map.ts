// Search Analytics rows into Observations, using the metric names the rest of Allevia already reads (ops-map/search.ts, the
// SEO detectors, the Search clicks goal): gsc_clicks, gsc_impressions, gsc_ctr_pct (a percent), gsc_position.
//   by date   one reading per day on the Google Search channel (windowStart = windowEnd). Google sends no row for a day with
//             no impressions, and that day really had none, so the days between the first and last date are written as zero
//             clicks and zero impressions (no click-through rate or position for them): a goal needs every day of its period.
//   by page   one 28-day reading per page, only for pages the graph already has (the crawl made them); the rest are counted.
//   by query  one 28-day reading per top search, on a Query node; a search that carries an email address, a phone number or
//             anything else the privacy filter would redact is dropped, not stored.
// Pure: it reads nothing and writes nothing.
import { findSensitive } from "../../ingest/redact.js";
import { entityId } from "../../util/ids.js";
import type { NodeInput, ObservationInput } from "../../graph/upsert.js";
import type { AnalyticsRow } from "./client.js";

export interface MapInput {
  daily: readonly AnalyticsRow[];
  pages: readonly AnalyticsRow[];
  queries: readonly AnalyticsRow[];
  startDate: string;                       // the daily window, first and last day
  endDate: string;
  windowStart: string;                     // the 28-day window the page and query readings cover (ends on endDate)
  pullDate: string;
  docId: string;
  channelId: string;
  knownPages: ReadonlySet<string>;         // Page ids the graph has
}

export interface MapOutput {
  nodes: NodeInput[];
  observations: ObservationInput[];
  stats: { days: number; zeroDays: number; pages: number; skippedPages: number; queries: number; skippedQueries: number };
}

const DAY = 86_400_000;
const addDay = (d: string): string => new Date(Date.parse(`${d}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
const round = (n: number, d: number): number => Math.round(n * 10 ** d) / 10 ** d;
const MAX_QUERY_CHARS = 100;

export function mapSearchAnalytics(i: MapInput): MapOutput {
  const nodes: NodeInput[] = [];
  const observations: ObservationInput[] = [];
  const base = { asOf: i.pullDate, src: i.docId };
  const metrics = (subject: string, r: AnalyticsRow, w: { windowStart: string; windowEnd: string }): ObservationInput[] => [
    { subject, metric: "gsc_clicks", value: r.clicks, unit: "count", ...w, ...base },
    { subject, metric: "gsc_impressions", value: r.impressions, unit: "count", ...w, ...base },
    { subject, metric: "gsc_ctr_pct", value: round(r.ctr * 100, 2), ...w, ...base },
    { subject, metric: "gsc_position", value: round(r.position, 1), unit: "position", ...w, ...base },
  ];

  // days
  const byDate = new Map<string, AnalyticsRow>();
  for (const r of i.daily) if (/^\d{4}-\d{2}-\d{2}$/.test(r.keys[0] ?? "")) byDate.set(r.keys[0]!, r);
  let days = 0, zeroDays = 0;
  for (let d = i.startDate; d <= i.endDate; d = addDay(d)) {
    const r = byDate.get(d);
    const w = { windowStart: d, windowEnd: d };
    days++;
    if (r) observations.push(...metrics(i.channelId, r, w));
    else {
      zeroDays++;
      observations.push({ subject: i.channelId, metric: "gsc_clicks", value: 0, unit: "count", ...w, ...base }, { subject: i.channelId, metric: "gsc_impressions", value: 0, unit: "count", ...w, ...base });
    }
  }

  // pages
  const window = { windowStart: i.windowStart, windowEnd: i.endDate };
  let pages = 0, skippedPages = 0;
  for (const r of i.pages) {
    const url = r.keys[0];
    const id = url ? entityId("Page", url) : "";
    if (!id || !i.knownPages.has(id)) { skippedPages++; continue; }
    pages++;
    observations.push(...metrics(id, r, window));
  }

  // queries
  let queries = 0, skippedQueries = 0;
  const seen = new Set<string>();
  for (const r of i.queries) {
    const text = (r.keys[0] ?? "").trim();
    if (!text || text.length > MAX_QUERY_CHARS || findSensitive(text).length) { skippedQueries++; continue; }
    const id = entityId("Query", text);
    if (seen.has(id)) { skippedQueries++; continue; }
    seen.add(id);
    queries++;
    nodes.push({ type: "Query", id, name: text, props: { text } });
    observations.push(...metrics(id, r, window));
  }
  return { nodes, observations, stats: { days, zeroDays, pages, skippedPages, queries, skippedQueries } };
}
