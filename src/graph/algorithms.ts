// Graph algorithms over CURRENT edges (until IS NULL), or over the edges valid at `asOf` (time travel). FalkorDB 6.0's
// algo.* procedures take labels and relationship types but no edge-property filter, so validity is enforced like this:
// - shortestPaths, now: algo.SPpaths with costProp 'closedCost' / maxCost on the live graph. Closed edges carry
//   closedCost = 1e6 (set by upsert), missing cost counts as 0, so SPpaths prunes closed edges during the search and
//   still finds the shortest current path. Results are post-checked too.
// - pageRank / betweenness / components / communities run on the cached slim projection of current edges, and
//   shortestPaths with asOf on a per-call projection of the edges valid then (projection.ts). Exact, unlike asking
//   SPpaths for N candidates and filtering (31 short paths that start later can crowd out the one valid long path).
// The label "Entity" means every SEARCHABLE type (projected nodes carry a `Searchable` label): Chunks, Versions,
// Observations, Turns… would otherwise dominate rankings and components.
// Paths ignore edge direction (relDirection 'both'): "how is X connected to Y" does not care which way an arrow
// points. EdgeRefs keep the stored direction.
// Result size: the per-node algorithms return a row per node, more than FalkorDB's RESULTSET_SIZE (10,000 rows, the
// rest dropped silently) on a big tenant. They run once and pack their rows into lists of MAX_PAGE per result row.
// Time: every function takes `timeoutMs` (default DEFAULT_READ_TIMEOUT_MS, 15 s): one budget for the whole call,
// projection reads included. Running out throws a "timed out" error.
// Staleness: while the graph is being written too fast for a consistent read (a busy ingest), the per-node algorithms
// run on the last good projection and their result carries `stale: true` (see projection.ts).
// Note: FalkorDB's labelPropagation is synchronous; on near-bipartite shapes (two triangles sharing an edge) labels
// oscillate and one tight-looking cluster can come back as two communities. Cliques and dense clusters settle.
import { MAX_PAGE, readBudget, type GraphHandle } from "./client.js";
import { CLOSED_EDGE_COST, isEntityType, isRelType, type EntityType, type RelType } from "./schema.js";
import { MissingEndpoint } from "./errors.js";
import { edgeValidAt, toPathResult, type PathResult, type RawPath } from "./read.js";
import { onEdgesValidAt, SEARCHABLE_LABEL, type ProjectionInfo } from "./projection.js";

export type { NodeRef, EdgeRef, PathResult } from "./read.js";
export { currentEdge } from "./read.js";

export interface AlgoOpts { timeoutMs?: number }
// A result list; `stale: true` when it was computed on the last good projection, not on the graph as it is now.
export type AlgoRows<T> = T[] & { stale?: true };

function rowsOf<T>(rows: T[], info: ProjectionInfo): AlgoRows<T> {
  return info.stale ? Object.assign(rows, { stale: true as const }) : rows;
}

function checkLabels(labels: readonly string[]): void {
  for (const l of labels) if (l !== "Entity" && !isEntityType(l)) throw new Error(`unknown label ${JSON.stringify(l)}`);
}
function checkRels(rels: readonly string[]): void {
  for (const r of rels) if (!isRelType(r)) throw new Error(`unknown relationship type ${JSON.stringify(r)}`);
}

// Projection label for an algorithm's node filter: "Entity" -> the SEARCHABLE types.
const projLabel = (l: EntityType | "Entity"): string => (l === "Entity" ? SEARCHABLE_LABEL : l);

export async function shortestPaths(
  g: GraphHandle,
  fromId: string,
  toId: string,
  opts: { relTypes?: RelType[]; maxPaths?: number; asOf?: number; maxLen?: number; timeoutMs?: number } = {},
): Promise<PathResult[]> {
  const rels = opts.relTypes ?? [];
  checkRels(rels);
  const left = readBudget(opts.timeoutMs);
  const maxPaths = Math.max(1, Math.min(opts.maxPaths ?? 3, 50));
  // Paths longer than 6 hops explain nothing, and SPpaths' cost grows with maxLen.
  const maxLen = Math.max(1, Math.min(Math.floor(opts.maxLen ?? 6), 6));
  const timeTravel = opts.asOf !== undefined;
  const cfg = ["sourceNode: a", "targetNode: b", "relDirection: 'both'", "maxLen: $maxLen", "pathCount: $pathCount"];
  if (rels.length) cfg.push("relTypes: $rels");
  if (!timeTravel) cfg.push("costProp: 'closedCost'", "maxCost: $maxCost");
  const run = (h: GraphHandle) => h.roQuery<{ path: RawPath }>(
    `MATCH (a:Entity {id:$from}), (b:Entity {id:$to}) CALL algo.SPpaths({${cfg.join(", ")}}) YIELD path RETURN path`,
    { from: fromId, to: toId, rels, maxLen, pathCount: maxPaths, maxCost: CLOSED_EDGE_COST - 1 }, { timeoutMs: left() });
  const rows = timeTravel ? await onEdgesValidAt(g, opts.asOf, rels, run, { timeoutMs: left() }) : await run(g);
  const paths = rows.map((r) => r.path).filter((p) => p.edges.every((e) => edgeValidAt(e.properties, opts.asOf)));
  if (!paths.length) {
    const found = await g.roQuery<{ id: string }>("MATCH (n:Entity) WHERE n.id IN $ids RETURN DISTINCT n.id AS id",
      { ids: [fromId, toId] }, { timeoutMs: left() });
    const missing = [fromId, toId].filter((id) => !found.some((f) => f.id === id));
    if (missing.length) throw new MissingEndpoint(missing, "shortestPaths");
  }
  const out = paths.slice(0, maxPaths).map(toPathResult);
  return timeTravel ? hydrate(g, out, left) : out;
}

// Paths from a projection know only ids and type labels; fill names, asOf and simulated from the source graph.
async function hydrate(g: GraphHandle, paths: PathResult[], left: () => number): Promise<PathResult[]> {
  const ids = [...new Set(paths.flatMap((p) => p.nodes.map((n) => n.id)))];
  if (!ids.length) return paths;
  const rows = await g.roQuery<{ id: string; name: string | null; asOf: string | null; simulated: boolean | null }>(
    "MATCH (n:Entity) WHERE n.id IN $ids RETURN n.id AS id, n.name AS name, n.asOf AS asOf, n.simulated AS simulated", { ids }, { timeoutMs: left() });
  const by = new Map(rows.map((r) => [r.id, r]));
  for (const n of paths.flatMap((p) => p.nodes)) {
    const r = by.get(n.id);
    if (!r) continue;
    if (r.name) n.name = r.name;
    if (typeof r.asOf === "string") n.asOf = r.asOf;
    if (typeof r.simulated === "boolean") n.simulated = r.simulated;
  }
  return paths;
}

function algoConfig(labels: readonly string[], rels: readonly string[]): string {
  const parts: string[] = [];
  if (labels.length) parts.push("nodeLabels: $labels");
  if (rels.length) parts.push("relationshipTypes: $rels");
  return `{${parts.join(", ")}}`;
}

// The rows whose value is a finite number. An algorithm can score a node NaN or ±Infinity (0 / 0 on one with no edges);
// such a score ranks nothing, a NaN in the JS sort makes its comparator inconsistent, and the client refuses to write a
// non-finite number (the librarian's `rank` write would abort the whole run), so those nodes are left out.
export function finiteRows(rows: Array<[string, number]>): Array<[string, number]> {
  return rows.filter(([, v]) => typeof v === "number" && Number.isFinite(v));
}

// `params` with its `rels` and `labels` cut to what the projection has; null when it has none of a requested kind.
async function presentIn(h: GraphHandle, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown> | null> {
  const out = { ...params };
  for (const [key, proc, col] of [["rels", "db.relationshipTypes", "relationshipType"], ["labels", "db.labels", "label"]] as const) {
    const asked = params[key];
    if (!Array.isArray(asked) || !asked.length) continue;
    const have = new Set((await h.roQuery<Record<string, string>>(`CALL ${proc}() YIELD ${col} RETURN ${col} AS v`, {}, { timeoutMs })).map((r) => r.v));
    const keep = (asked as string[]).filter((x) => have.has(x));
    if (!keep.length) return null;
    out[key] = keep;
  }
  return out;
}

// Runs a per-node algorithm once and returns every [id, value] row it yields (projected nodes without an id are
// skipped), packed MAX_PAGE to a result row so no row is lost to RESULTSET_SIZE. Sorted by `order`.
async function perNode(
  h: GraphHandle, call: string, col: string, params: Record<string, unknown>, timeoutMs: number,
  order: (a: [string, number], b: [string, number]) => number,
): Promise<Array<[string, number]>> {
  // The projection holds only the relationship types and labels the business really has, and an algorithm that is
  // handed one that is missing fails ("unknown relationship-type LINKS_TO") instead of finding nothing. A business with
  // no MENTIONS or LINKS_TO edges is a graph with nothing to group, not an error: ask only for what is there.
  const present = await presentIn(h, params, timeoutMs);
  if (!present) return [];
  params = present;
  const rows = await h.roQuery<{ part: Array<[string, number]> }>(
    `${call} YIELD node, ${col} WITH node.id AS id, ${col} AS v WHERE id IS NOT NULL
     WITH collect([id, v]) AS xs UNWIND range(0, size(xs) - 1, $page) AS i RETURN xs[i..i + $page] AS part`,
    { ...params, page: MAX_PAGE }, { timeoutMs });
  return finiteRows(rows.flatMap((r) => r.part)).sort(order);
}

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const scoreDesc = (a: [string, number], b: [string, number]): number => b[1] - a[1] || byId(a[0], b[0]);
const groupAsc = (a: [string, number], b: [string, number]): number => a[1] - b[1] || byId(a[0], b[0]);

export async function pageRank(g: GraphHandle, label: EntityType | "Entity", rel?: RelType, opts: AlgoOpts = {}): Promise<AlgoRows<{ id: string; score: number }>> {
  checkLabels([label]);
  if (rel) checkRels([rel]);
  return onEdgesValidAt(g, undefined, rel ? [rel] : [], async (h, left, info) => rowsOf(
    (await perNode(h, `CALL algo.pageRank('${projLabel(label)}', ${rel ? `'${rel}'` : "null"})`, "score", { rels: rel ? [rel] : [], labels: [projLabel(label)] }, left(), scoreDesc))
      .map(([id, score]) => ({ id, score })), info), opts);
}

export async function betweenness(g: GraphHandle, labels: Array<EntityType | "Entity">, rels: RelType[], opts: AlgoOpts = {}): Promise<AlgoRows<{ id: string; score: number }>> {
  checkLabels(labels);
  checkRels(rels);
  return onEdgesValidAt(g, undefined, rels, async (h, left, info) => rowsOf(
    (await perNode(h, `CALL algo.betweenness(${algoConfig(labels, rels)})`, "score", { labels: labels.map(projLabel), rels }, left(), scoreDesc))
      .map(([id, score]) => ({ id, score })), info), opts);
}

export async function components(g: GraphHandle, labels: Array<EntityType | "Entity">, rels: RelType[], opts: AlgoOpts = {}): Promise<AlgoRows<{ id: string; componentId: number }>> {
  checkLabels(labels);
  checkRels(rels);
  return onEdgesValidAt(g, undefined, rels, async (h, left, info) => rowsOf(
    (await perNode(h, `CALL algo.WCC(${algoConfig(labels, rels)})`, "componentId", { labels: labels.map(projLabel), rels }, left(), groupAsc))
      .map(([id, componentId]) => ({ id, componentId })), info), opts);
}

export async function communities(g: GraphHandle, labels: Array<EntityType | "Entity">, rels: RelType[], opts: AlgoOpts = {}): Promise<AlgoRows<{ id: string; communityId: number }>> {
  checkLabels(labels);
  checkRels(rels);
  return onEdgesValidAt(g, undefined, rels, async (h, left, info) => rowsOf(
    (await perNode(h, `CALL algo.labelPropagation(${algoConfig(labels, rels)})`, "communityId", { labels: labels.map(projLabel), rels }, left(), groupAsc))
      .map(([id, communityId]) => ({ id, communityId })), info), opts);
}
