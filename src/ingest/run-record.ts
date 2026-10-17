// Run records (graph audit G17). A run of onboarding or ingest is a node in the business's own graph, with edges: the Event
// AFFECTS the Business, and the numbers the run measured about the graph itself (how big it is, how many nodes nothing links
// to, how many duplicates were merged, how many personal details the privacy scan found) are Observations that MEASURE the
// Business and are SOURCED_FROM the Event. So "is the graph getting cleaner" is a metric_trend over `orphan_count` and
// "which run measured this" is one hop. The Event node itself is written by the caller (its props differ per kind of run).
//
// Day granularity, like every other Observation: two runs on the same day update the day's reading and keep the earlier
// one as a Version, they never add a second point.
import type { GraphHandle } from "../graph/client.js";
import { observationId, type EdgeInput, type ObservationInput } from "../graph/upsert.js";
import type { GraphWrite } from "./types.js";

// The graph-hygiene series: metric key -> what it counts (owner-facing wording lives in the screens, not here).
export const HYGIENE_METRICS = {
  orphan_count: "knowledge nothing links to",
  merged_count: "duplicates merged in the run",
  graph_nodes: "things the business's graph knows about (readings, versions and run records left out)",
  privacy_scan_hits: "personal details the privacy scan found",
} as const;
export type HygieneMetric = keyof typeof HYGIENE_METRICS;

export interface RunRecordInput {
  event: string;               // the Event node id the caller writes
  business: string;            // the Business node id
  asOf: string;                // the run's date: ISO date or datetime
  day: string;                 // the run's day, YYYY-MM-DD: the Observations' asOf
  form?: string;               // a Document the run read from (onboarding: the form the owner filled in)
  numbers?: Partial<Record<HygieneMetric, number>>;
  note?: string;               // the Observations' evidence: what kind of run measured them
}

// What a run adds beside its Event: Event -AFFECTS-> Business, Event -SOURCED_FROM-> the form it read, and the numbers.
export function runRecordWrite(r: RunRecordInput): GraphWrite {
  const edges: EdgeInput[] = [
    { from: r.event, type: "AFFECTS", to: r.business, src: r.event, asOf: r.asOf },
    ...(r.form ? [{ from: r.event, type: "SOURCED_FROM" as const, to: r.form, src: r.form, asOf: r.asOf }] : []),
  ];
  const observations: ObservationInput[] = [];
  for (const [metric, value] of Object.entries(r.numbers ?? {}) as Array<[HygieneMetric, number | undefined]>) {
    if (value === undefined || !Number.isFinite(value)) continue;
    const o: ObservationInput = { subject: r.business, metric, value, unit: "count", asOf: r.day, src: r.event, ...(r.note ? { evidence: r.note } : {}) };
    observations.push(o);
    // the reading points at the run that measured it (writeObservation links only a Document source)
    edges.push({ from: observationId(o), type: "SOURCED_FROM", to: r.event, src: r.event, asOf: r.day });
  }
  return { nodes: [], edges, observations };
}

// How many things the business's graph knows about: every entity except the readings, the version stubs and the run records
// themselves (those grow with every run and would make "bigger" mean "measured more often").
export async function graphSize(g: GraphHandle): Promise<number> {
  const [r] = await g.roQuery<{ c: number }>("MATCH (n:Entity) WHERE NOT n:Observation AND NOT n:Version AND NOT n:Event RETURN count(n) AS c");
  return r?.c ?? 0;
}
