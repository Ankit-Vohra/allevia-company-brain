// What onboarding writes about itself at the end (graph audit G17 and G12): the run as an Event, and the privacy scan as an
// Event, each with edges to the Business and numbers that measure it. Best effort by design (onboard.ts catches each call
// and reports a soft note): the business's knowledge is already written, these only make the run itself visible.
import type { GraphHandle } from "../graph/client.js";
import { ONTOLOGY_VERSION } from "../graph/schema.js";
import { upsertNode, writeBatch, type WriteStats } from "../graph/upsert.js";
import { entityId } from "../util/ids.js";
import { scanGraph, type ScanHit } from "../ingest/privacy.js";
import { graphSize, runRecordWrite } from "../ingest/run-record.js";

export interface RunStamp {
  slug: string;
  businessId: string;
  startedAt: string;      // ISO datetime the run began: makes each run's Event its own node
  day: string;            // YYYY-MM-DD, the Observations' date
  now: number;
}

const kindsOf = (hits: ScanHit[]): Record<string, number> => {
  const byKind: Record<string, number> = {};
  for (const h of hits) byKind[h.kind] = (byKind[h.kind] ?? 0) + 1;
  return byKind;
};

export interface PrivacyScanRecord { hits: number; byKind: Record<string, number>; where: string[]; event: string }

// The privacy scan (src/ingest/privacy.ts scanGraph) over the whole graph, recorded as an Event that AFFECTS the Business
// and a `privacy_scan_hits` Observation that MEASURES it. A hit never stops anything: the caller tells the owner in plain
// words. Only ids and prop names are kept, never the value (the scan's own samples are masked, and are dropped here too).
// A site served from a bare IP address has that address in every URL it has: the site's own address is not a personal detail.
export async function recordPrivacyScan(g: GraphHandle, run: RunStamp, opts: { ownIp?: boolean } = {}): Promise<PrivacyScanRecord> {
  const hits = (await scanGraph(g)).filter((h) => !(opts.ownIp && h.kind === "ipv4"));
  const byKind = kindsOf(hits);
  const event = entityId("Event", `privacy-scan ${run.slug} ${run.startedAt}`);
  await upsertNode(g, {
    type: "Event", id: event, name: `Privacy scan ${run.startedAt}`, asOf: run.day,
    summary: hits.length
      ? `The privacy scan after onboarding found ${hits.length} possible personal detail(s): ${Object.entries(byKind).map(([k, n]) => `${k} ${n}`).join(", ")}.`
      : "The privacy scan after onboarding found nothing.",
    props: { kind: "privacy-scan", at: run.startedAt, hits: hits.length, hitKinds: Object.entries(byKind).map(([k, n]) => `${k}:${n}`) },
  }, run.now);
  const s = await writeBatch(g, runRecordWrite({
    event, business: run.businessId, asOf: run.startedAt, day: run.day, note: "privacy scan after onboarding", numbers: { privacy_scan_hits: hits.length },
  }), run.now);
  failIf(s, "privacy scan record");
  return { hits: hits.length, byKind, where: hits.slice(0, 5).map((h) => `${h.id} .${h.prop} (${h.kind})`), event };
}

export interface OnboardRecordInput extends RunStamp {
  formDoc?: string;       // the form the owner filled in: the run was read from it
  url?: string;
  pages: number;
  seoScore?: number;
  model: string;
  durationMs: number;
  softErrors: number;
  merged?: number;        // duplicates the tidy pass merged
}

// The onboarding run as an Event: what was read, with which model and ontology, how long it took, and how big the graph
// came out. `Event -AFFECTS-> Business`, `Event -SOURCED_FROM-> form`; graph_nodes and merged_count are Observations that
// MEASURE the Business and are SOURCED_FROM the run, so the graph's size and cleanliness over time is a metric_trend.
export async function recordOnboardRun(g: GraphHandle, r: OnboardRecordInput): Promise<{ event: string; stats: WriteStats }> {
  const event = entityId("Event", `onboard ${r.slug} ${r.startedAt}`);
  await upsertNode(g, {
    type: "Event", id: event, name: `Onboarding run ${r.startedAt}`, asOf: r.day,
    summary: `Onboarding read ${r.pages} page${r.pages === 1 ? "" : "s"}${r.seoScore !== undefined ? `, website check ${r.seoScore}/100` : ""}.`,
    props: {
      kind: "onboard", at: r.startedAt, pages: r.pages, ...(r.seoScore !== undefined ? { seoScore: r.seoScore } : {}),
      model: r.model, ontologyVersion: ONTOLOGY_VERSION, durationMs: Math.max(0, Math.round(r.durationMs)), softErrors: r.softErrors,
      ...(r.url ? { url: r.url } : {}),
    },
  }, r.now);
  const stats = await writeBatch(g, runRecordWrite({
    event, business: r.businessId, asOf: r.startedAt, day: r.day, note: "onboarding run",
    ...(r.formDoc ? { form: r.formDoc } : {}),
    numbers: { graph_nodes: await graphSize(g), ...(r.merged !== undefined ? { merged_count: r.merged } : {}) },
  }), r.now);
  failIf(stats, "onboarding record");
  return { event, stats };
}

function failIf(s: WriteStats, what: string): void {
  if (s.errors.length) throw new Error(`${what}: ${s.errors.length} write(s) failed, first: ${s.errors[0]!.error}`);
}
