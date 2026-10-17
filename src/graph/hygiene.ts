// `graph:hygiene <tenant>` (src/cli/hygiene.ts): how a business graph is growing and what could be tidied, as a report. It never
// writes or deletes anything: phase 2 (roll-ups and the archive, docs/product-plan-after-hackathon.md §9) acts on it later.
//   - things by kind, business knowledge apart from general know-how (the shared playbooks' copy, and stubs; src/graph/reference.ts);
//   - closed facts (edges whose `until` is set) and Versions that ended more than 180 days ago: what the archive would take;
//   - Chunks of superseded documents: a Document something SUPERSEDES (or marked superseded / archived), and Chunks no current
//     HAS_CHUNK holds any more (the text of an older version of a document);
//   - readings (Observations) older than 90 days: what the daily-to-weekly roll-up would fold;
//   - cold things: untouched for 180 days, with at most one link, and a low PageRank (stored by the librarian; under 5% of the
//     top one, or none stored), never the Business itself: a review list, not a delete list.
// Every read is GRAPH.RO_QUERY and counts on the server.
import type { GraphHandle } from "./client.js";
import { referenceFilter, referenceParams } from "./reference.js";

const DAY = 86_400_000;
export const HYGIENE = { closedDays: 180, coldDays: 180, readingDays: 90, coldMaxDegree: 1, lowRankShare: 0.05, examples: 15 } as const;
const PLUMBING = ["Version", "Chunk", "Observation", "Turn", "Session"];
const READ = { timeoutMs: 60_000 };

export interface HygieneReport {
  graph: string;
  at: string;
  business: Record<string, number>;     // things by kind, business knowledge
  general: Record<string, number>;      // general know-how still copied in (stubs counted in `stubs`)
  stubs: number;
  edges: { current: number; closed: number; closedOld: number };
  versions: { total: number; old: number };
  chunks: { total: number; superseded: number; unheld: number };
  readings: { total: number; old: number };
  cold: { count: number; rankStored: boolean; examples: Array<{ id: string; type: string; name: string; degree: number; lastTouched: string | null }> };
}

const one = async (g: GraphHandle, q: string, p: Record<string, unknown> = {}): Promise<number> =>
  (await g.roQuery<{ c: number }>(q, p, READ))[0]?.c ?? 0;

export async function graphHygiene(g: GraphHandle, now: number = Date.now()): Promise<HygieneReport> {
  const ref = referenceParams();
  const oldClosed = now - HYGIENE.closedDays * DAY;
  const coldBefore = now - HYGIENE.coldDays * DAY;
  const readingBefore = new Date(now - HYGIENE.readingDays * DAY).toISOString().slice(0, 10);
  const kinds = async (where: string): Promise<Record<string, number>> => {
    const rows = await g.roQuery<{ k: string | null; c: number }>(
      `MATCH (n:Entity) WHERE ${where} WITH [l IN labels(n) WHERE NOT l IN ['Entity', 'Searchable']][0] AS k RETURN k, count(*) AS c ORDER BY c DESC, k`,
      ref, READ);
    return Object.fromEntries(rows.filter((r) => r.k).map((r) => [r.k!, r.c]));
  };
  const [business, general, stubs] = await Promise.all([
    kinds(`NOT ${referenceFilter("n")}`),
    kinds(`${referenceFilter("n")} AND n.refStub IS NULL`),
    one(g, "MATCH (n:Entity) WHERE n.refStub = true RETURN count(n) AS c"),
  ]);
  const [current, closed, closedOld] = await Promise.all([
    one(g, "MATCH ()-[r]->() WHERE ID(r) >= 0 AND r.until IS NULL RETURN count(r) AS c"),
    one(g, "MATCH ()-[r]->() WHERE ID(r) >= 0 AND r.until IS NOT NULL RETURN count(r) AS c"),
    one(g, "MATCH ()-[r]->() WHERE ID(r) >= 0 AND r.until IS NOT NULL AND r.until < $before RETURN count(r) AS c", { before: oldClosed }),
  ]);
  const [vTotal, vOld] = await Promise.all([
    one(g, "MATCH (v:Version) RETURN count(v) AS c"),
    one(g, "MATCH (v:Version) WHERE v.until IS NOT NULL AND v.until < $before RETURN count(v) AS c", { before: oldClosed }),
  ]);
  const [cTotal, cSuperseded, cUnheld] = await Promise.all([
    one(g, "MATCH (c:Chunk) RETURN count(c) AS c"),
    one(g,
      `MATCH (d:Document)-[h:HAS_CHUNK]->(c:Chunk) OPTIONAL MATCH (:Document)-[sp:SUPERSEDES]->(d)
       WITH d, c, count(h) AS held, count(sp) AS successors WHERE successors > 0 OR toLower(coalesce(d.status, '')) IN ['superseded', 'archived', 'retired']
       RETURN count(DISTINCT c) AS c`),
    one(g,
      `MATCH (c:Chunk) OPTIONAL MATCH (:Document)-[h:HAS_CHUNK]->(c) WHERE h.until IS NULL
       WITH c, count(h) AS held WHERE held = 0 RETURN count(c) AS c`),
  ]);
  const [rTotal, rOld] = await Promise.all([
    one(g, "MATCH (o:Observation) RETURN count(o) AS c"),
    one(g, "MATCH (o:Observation) WHERE o.asOf IS NOT NULL AND o.asOf < $before RETURN count(o) AS c", { before: readingBefore }),
  ]);
  const top = (await g.roQuery<{ m: number | null }>("MATCH (n:Entity) WHERE n.rank IS NOT NULL RETURN max(n.rank) AS m", {}, READ))[0]?.m ?? null;
  const rankStored = typeof top === "number" && top > 0;
  const coldWhere =
    `NOT any(l IN labels(n) WHERE l IN $plumbing) AND NOT n:Business AND NOT ${referenceFilter("n")}
     AND coalesce(n.updatedAt, n.createdAt, 0) < $before AND coalesce(n.rank, 0) <= $low`;
  const coldParams = { ...ref, plumbing: PLUMBING, before: coldBefore, low: rankStored ? top! * HYGIENE.lowRankShare : 0, maxDeg: HYGIENE.coldMaxDegree };
  const [coldCount] = await g.roQuery<{ c: number }>(
    `MATCH (n:Entity) WHERE ${coldWhere} OPTIONAL MATCH (n)-[r]-() WITH n, count(r) AS deg WHERE deg <= $maxDeg RETURN count(n) AS c`, coldParams, READ);
  const examples = await g.roQuery<{ id: string; labels: string[]; name: string | null; deg: number; at: number | null }>(
    `MATCH (n:Entity) WHERE ${coldWhere} OPTIONAL MATCH (n)-[r]-() WITH n, count(r) AS deg WHERE deg <= $maxDeg
     RETURN n.id AS id, labels(n) AS labels, n.name AS name, deg, coalesce(n.updatedAt, n.createdAt) AS at ORDER BY at, id LIMIT $limit`,
    { ...coldParams, limit: HYGIENE.examples }, READ);
  return {
    graph: g.name, at: new Date(now).toISOString(), business, general, stubs,
    edges: { current, closed, closedOld }, versions: { total: vTotal, old: vOld },
    chunks: { total: cTotal, superseded: cSuperseded, unheld: cUnheld }, readings: { total: rTotal, old: rOld },
    cold: {
      count: coldCount?.c ?? 0, rankStored,
      examples: examples.map((e) => ({
        id: e.id, type: e.labels.find((l) => l !== "Entity" && l !== "Searchable") ?? "Entity", name: e.name ?? e.id, degree: e.deg,
        lastTouched: typeof e.at === "number" ? new Date(e.at).toISOString().slice(0, 10) : null,
      })),
    },
  };
}

const n = (x: number): string => x.toLocaleString("en-US");
const sum = (o: Record<string, number>): number => Object.values(o).reduce((s, x) => s + x, 0);
const list = (o: Record<string, number>, max = 12): string => {
  const e = Object.entries(o).sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
  return `${e.slice(0, max).map(([k, v]) => `${k} ${n(v)}`).join(", ")}${e.length > max ? `, … ${e.length - max} more kinds` : ""}` || "none";
};

export function formatHygiene(slug: string, r: HygieneReport): string {
  return [
    `${slug} (${r.graph}), ${r.at.slice(0, 10)}: a report only, nothing is changed`,
    `  business knowledge: ${n(sum(r.business))} things (${list(r.business)})`,
    `  general know-how still copied in: ${n(sum(r.general))}${sum(r.general) ? ` (${list(r.general)}); graph:reference-split moves it out` : ""}; stubs of shared rules: ${n(r.stubs)}`,
    `  links: ${n(r.edges.current)} current, ${n(r.edges.closed)} closed facts (${n(r.edges.closedOld)} closed over ${HYGIENE.closedDays} days ago)`,
    `  versions: ${n(r.versions.total)} (${n(r.versions.old)} ended over ${HYGIENE.closedDays} days ago)`,
    `  passages (chunks): ${n(r.chunks.total)}; of superseded documents ${n(r.chunks.superseded)}; no longer held by their document ${n(r.chunks.unheld)}`,
    `  readings: ${n(r.readings.total)} (${n(r.readings.old)} older than ${HYGIENE.readingDays} days: what a weekly roll-up would fold)`,
    `  cold things (untouched ${HYGIENE.coldDays} days, at most ${HYGIENE.coldMaxDegree} link, ${r.cold.rankStored ? "low PageRank" : "no PageRank stored yet"}): ${n(r.cold.count)}`,
    ...r.cold.examples.map((e) => `    ${e.id} (${e.type}) "${e.name}": ${e.degree} link${e.degree === 1 ? "" : "s"}, last touched ${e.lastTouched ?? "never"}`),
  ].join("\n");
}
