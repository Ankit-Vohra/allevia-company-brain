// The librarian (spec §6.6): a post-ingest pass over the whole graph.
//
// 0. Merges (src/ingest/merge.ts): System, Channel and Product nodes that name the same thing become one (SAME_AS to the
//    canonical node, the registry's when there is one; edges moved, reversibly), and a credential is linked to the
//    connector it unlocks. First, so what follows (KNOWS_ABOUT from MENTIONS, rank) sees one node.
// 1. KNOWS_ABOUT (actor → entity), spec §5.5. An actor knows about what the documents it authored are about: the
//    entities each document MENTIONS and the ones SOURCED_FROM it (a registry file's agent, an ADR's decision). Each
//    authored document contributes commits × recency; DECIDED adds 2 × recency to the decision, OWNS adds 1 × recency to
//    what is owned. Recency halves every HALF_LIFE_DAYS and never drops below RECENCY_FLOOR (old knowledge fades, it is
//    not forgotten). Edges are written through upsertEdge (re-deriving is a no-op apart from fresher props) and marked
//    derivedBy: 'librarian'; one whose support is gone is closed, never deleted. Edges the librarian did not derive (agent
//    memory's KNOWS_ABOUT for Allevia's own staff) are never touched, and Allevia's reserved actors get none.
// 2. `rank` (PageRank over the SEARCHABLE types, current edges) and `community` (label propagation over MENTIONS,
//    LINKS_TO and LINKS_TO_PAGE: a site's own link structure groups its pages) as node props for the UI. These are raw
//    writes, so noteGraphWrite follows them. They need only the graph handle, so rankAndCommunities() is exported and
//    onboarding calls it for a business read from a website (src/onboard/onboard.ts), where no ingest ever runs.
// 3. Orphans: WCC singletons among searchable knowledge, where authorship and KNOWS_ABOUT do not count as links:
//    "knowledge nobody links to". Actors, the Business, the pipeline's own ingest Events and anything an Observation
//    measures or cites are left out.
// Contradicted functional facts (a Task's owner, a superseded Decision) are closed by upsertEdge's functional rule as
// the sources are written; the librarian adds no second mechanism for that.
import type { GraphHandle } from "../graph/client.js";
import { MAX_PAGE } from "../graph/client.js";
import { REL_TYPES, SEARCHABLE, type EntityType, type RelType } from "../graph/schema.js";
import { closeEdge, writeBatch, type EdgeInput } from "../graph/upsert.js";
import { communities, components, pageRank } from "../graph/algorithms.js";
import { noteGraphWrite } from "../graph/projection.js";
import { isoDate } from "../util/time.js";
import { typeFromId } from "../util/ids.js";
import { isReservedId } from "./actors.js";
import { mergeDuplicates, type MergeReport } from "./merge.js";

export const HALF_LIFE_DAYS = 30;
export const RECENCY_FLOOR = 0.1;
export const DECIDED_WEIGHT = 2;
export const OWNS_WEIGHT = 1;
const DAY = 86_400_000;
const ALGO_TIMEOUT_MS = 120_000;
const WRITE_PAGE = 500;
// What groups nodes into communities: what a document mentions, what it links to, and how a site's pages link to each other.
export const COMMUNITY_RELS: RelType[] = ["MENTIONS", "LINKS_TO", "LINKS_TO_PAGE"];

// What a piece of evidence of `amount` is worth at `now`, given its date.
export function knowsAboutWeight(amount: number, at: number, now: number): number {
  const age = Math.max(0, now - at) / DAY;
  return amount * Math.max(RECENCY_FLOOR, 0.5 ** (age / HALF_LIFE_DAYS));
}

export interface LibrarianOptions { now?: number; timeoutMs?: number; log?: (line: string) => void }

export interface LibrarianReport {
  merge: MergeReport;
  knowsAbout: { edges: number; created: number; closed: number; actors: number; errors: number };
  rank: { nodes: number };
  community: { nodes: number; communities: number };
  orphans: { count: number; byType: Record<string, number>; sample: string[] };
  ms: number;
}

const SEARCHABLE_SET = new Set<string>(SEARCHABLE);
// Who the KNOWS_ABOUT targets can be: searchable things other than documents (an author knowing their own document
// says nothing AUTHORED does not).
const knowable = (id: string): boolean => {
  const t = typeFromId(id);
  return !!t && SEARCHABLE_SET.has(t) && t !== "Document";
};
const ACTOR_TYPES = new Set<EntityType>(["Person", "Agent", "Team"]);
const NOT_ORPHANS = new Set<EntityType>([...ACTOR_TYPES, "Business"]);
const NOT_LINKS = new Set<RelType>(["AUTHORED", "KNOWS_ABOUT", "HAD_VERSION"]);
export const ORPHAN_RELS: RelType[] = REL_TYPES.filter((r) => !NOT_LINKS.has(r));
const isIngestEvent = (id: string) => id.startsWith("event:ingest-");
const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

interface Acc { weight: number; docs: Set<string>; commits: number; basis: Set<string>; since: number; top: { src: string; w: number } }

// ---------- 1. KNOWS_ABOUT ----------

async function deriveKnowsAbout(g: GraphHandle, now: number): Promise<Map<string, Acc>> {
  const acc = new Map<string, Acc>();
  const add = (actor: string, x: string, w: number, basis: string, since: number, doc?: string, commits = 0) => {
    if (actor === x || isReservedId(actor) || !knowable(x)) return;
    const k = `${actor}\u0000${x}`;
    let a = acc.get(k);
    if (!a) acc.set(k, a = { weight: 0, docs: new Set(), commits: 0, basis: new Set(), since, top: { src: "", w: -1 } });
    a.weight += w;
    a.basis.add(basis);
    a.commits += commits;
    a.since = Math.min(a.since, since);
    if (doc) {
      a.docs.add(doc);
      if (w > a.top.w || (w === a.top.w && doc < a.top.src)) a.top = { src: doc, w };
    }
  };

  // authored documents: one row per AUTHORED edge, with what the document is about
  for (let after = ""; ;) {
    const rows = await g.roQuery<{ k: string; actor: string; doc: string; commits: number | null; at: string | null; since: number | null; about: string[] }>(
      `MATCH (a:Entity)-[w:AUTHORED]->(d:Document) WHERE w.until IS NULL AND (a:Person OR a:Agent)
       WITH a, w, d, a.id + '|' + d.id AS k WHERE k > $after
       WITH a, w, d, k ORDER BY k LIMIT $lim
       OPTIONAL MATCH (d)-[m:MENTIONS]->(x:Entity) WHERE m.until IS NULL
       WITH a, w, d, k, collect(DISTINCT x.id) AS mentioned
       OPTIONAL MATCH (y:Entity)-[s:SOURCED_FROM]->(d) WHERE s.until IS NULL
       WITH a, w, d, k, mentioned, collect(DISTINCT y.id) AS sourced
       RETURN k, a.id AS actor, d.id AS doc, w.commits AS commits, w.at AS at, w.since AS since, mentioned + sourced AS about
       ORDER BY k`,
      { after, lim: MAX_PAGE });
    for (const r of rows) {
      const commits = typeof r.commits === "number" && r.commits > 0 ? r.commits : 1;
      const last = r.at ? Date.parse(r.at) : NaN;
      const at = Number.isFinite(last) ? last : r.since ?? now;
      const first = r.since ?? at;
      const w = knowsAboutWeight(commits, at, now);
      for (const x of new Set(r.about)) add(r.actor, x, w, "authored", first, r.doc, commits);
    }
    if (rows.length < MAX_PAGE) break;
    after = rows[rows.length - 1]!.k;
  }

  // decisions taken and things owned
  for (const [rel, amount, basis] of [["DECIDED", DECIDED_WEIGHT, "decided"], ["OWNS", OWNS_WEIGHT, "owns"]] as const) {
    const rows = await g.roQuery<{ actor: string; x: string; since: number | null }>(
      `MATCH (a:Entity)-[r:${rel}]->(x:Entity) WHERE r.until IS NULL AND (a:Person OR a:Agent) RETURN a.id AS actor, x.id AS x, r.since AS since`);
    for (const r of rows) {
      const since = r.since ?? now;
      add(r.actor, r.x, knowsAboutWeight(amount, since, now), basis, since);
    }
  }
  return acc;
}

async function writeKnowsAbout(g: GraphHandle, acc: Map<string, Acc>, now: number): Promise<LibrarianReport["knowsAbout"]> {
  const asOf = isoDate(now);
  const edges: EdgeInput[] = [];
  const actors = new Set<string>();
  for (const [k, a] of acc) {
    const [from, to] = k.split("\u0000") as [string, string];
    const weight = round(a.weight);
    if (weight <= 0) continue;
    actors.add(from);
    edges.push({
      from, type: "KNOWS_ABOUT", to, since: a.since, asOf, functional: false,
      ...(a.top.src ? { src: a.top.src } : {}),
      props: { weight, docs: a.docs.size, commits: a.commits, basis: [...a.basis].sort(), derivedBy: "librarian" },
    });
  }
  edges.sort((x, y) => (x.from + x.to < y.from + y.to ? -1 : 1));
  const stats = await writeBatch(g, { edges }, now);

  // close what the librarian derived earlier and no longer can
  const want = new Set(edges.map((e) => `${e.from}\u0000${e.to}`));
  const current = await g.roQuery<{ from: string; to: string }>(
    "MATCH (a:Entity)-[r:KNOWS_ABOUT]->(x:Entity) WHERE r.until IS NULL AND r.derivedBy = 'librarian' RETURN a.id AS from, x.id AS to");
  let closed = 0;
  for (const c of current) {
    if (!want.has(`${c.from}\u0000${c.to}`)) closed += await closeEdge(g, c.from, "KNOWS_ABOUT", c.to, now, "no longer supported by the sources");
  }
  return { edges: edges.length, created: stats.edgesCreated, closed, actors: actors.size, errors: stats.errors.length };
}

// ---------- 2. rank and community ----------

async function setProp(g: GraphHandle, prop: "rank" | "community", rows: Array<{ id: string; v: number }>): Promise<void> {
  for (let i = 0; i < rows.length; i += WRITE_PAGE) {
    await g.query(`UNWIND $rows AS r MATCH (n:Entity {id: r.id}) SET n.${prop} = r.v`, { rows: rows.slice(i, i + WRITE_PAGE) });
  }
}

export interface RankReport { rank: { nodes: number }; community: { nodes: number; communities: number } }

// PageRank and label-propagation communities over the current edges, stored as `rank` and `community` on each node (the
// Brain map and `important` read the stored values). Needs only the graph: no tenant config, no ingest.
export async function rankAndCommunities(g: GraphHandle, opts: { timeoutMs?: number; log?: (line: string) => void } = {}): Promise<RankReport> {
  const timeoutMs = opts.timeoutMs ?? ALGO_TIMEOUT_MS;
  const ranks = await pageRank(g, "Entity", undefined, { timeoutMs });
  await setProp(g, "rank", ranks.map((r) => ({ id: r.id, v: Number(r.score.toPrecision(6)) })));
  const comms = await communities(g, ["Entity"], COMMUNITY_RELS, { timeoutMs });
  await setProp(g, "community", comms.map((c) => ({ id: c.id, v: c.communityId })));
  await noteGraphWrite(g.name);
  const groups = new Set(comms.map((c) => c.communityId)).size;
  opts.log?.(`[librarian] rank on ${ranks.length} nodes; ${groups} communities`);
  return { rank: { nodes: ranks.length }, community: { nodes: comms.length, communities: groups } };
}

// ---------- entry point ----------

export async function runLibrarian(g: GraphHandle, opts: LibrarianOptions = {}): Promise<LibrarianReport> {
  const t0 = Date.now();
  const now = opts.now ?? Date.now();
  const timeoutMs = opts.timeoutMs ?? ALGO_TIMEOUT_MS;
  const log = opts.log ?? (() => {});

  const merge = await mergeDuplicates(g, now);
  log(`[librarian] merges: ${merge.merged} duplicate(s) in ${merge.groups} group(s), ${merge.edgesMoved} edge(s) moved, ${merge.credentialLinks} new credential link(s)` +
    `${merge.skipped.length ? `, ${merge.skipped.length} group(s) left alone` : ""}${merge.errors.length ? `, ${merge.errors.length} error(s): ${merge.errors[0]}` : ""}`);

  const knowsAbout = await writeKnowsAbout(g, await deriveKnowsAbout(g, now), now);
  log(`[librarian] KNOWS_ABOUT: ${knowsAbout.edges} edges from ${knowsAbout.actors} actors (${knowsAbout.created} new, ${knowsAbout.closed} closed)`);

  const { rank, community } = await rankAndCommunities(g, { timeoutMs, log });

  const comps = await components(g, ["Entity"], ORPHAN_RELS, { timeoutMs });
  const size = new Map<number, number>();
  for (const c of comps) size.set(c.componentId, (size.get(c.componentId) ?? 0) + 1);
  const singletons = comps.filter((c) => size.get(c.componentId) === 1).map((c) => c.id)
    .filter((id) => !isIngestEvent(id) && !NOT_ORPHANS.has(typeFromId(id)!));
  // Observations are not searchable, so the components above cannot see them: a snapshot whose numbers are in the
  // graph, or a thing that is measured, is in use, not an orphan.
  const used = new Set<string>();
  for (let i = 0; i < singletons.length; i += MAX_PAGE) {
    const rows = await g.roQuery<{ id: string }>(
      "MATCH (n:Entity)<-[r:SOURCED_FROM|MEASURES]-(:Observation) WHERE n.id IN $ids AND r.until IS NULL RETURN DISTINCT n.id AS id",
      { ids: singletons.slice(i, i + MAX_PAGE) });
    for (const r of rows) used.add(r.id);
  }
  const orphans = singletons.filter((id) => !used.has(id)).sort();
  const byType: Record<string, number> = {};
  for (const id of orphans) { const t = typeFromId(id) ?? "?"; byType[t] = (byType[t] ?? 0) + 1; }
  log(`[librarian] ${orphans.length} orphans`);

  return {
    merge,
    knowsAbout,
    rank,
    community,
    orphans: { count: orphans.length, byType, sample: orphans.slice(0, 25) },
    ms: Date.now() - t0,
  };
}
