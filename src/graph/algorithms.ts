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
// Note: FalkorDB's labelPropagation is synchronous; on near-bipartite shapes (two triangles sharing an edge) labels
// oscillate and one tight-looking cluster can come back as two communities. Cliques and dense clusters settle.
import type { GraphHandle } from "./client.js";
import { CLOSED_EDGE_COST, isEntityType, isRelType, type EntityType, type RelType } from "./schema.js";
import { MissingEndpoint } from "./errors.js";
import { edgeValidAt, toPathResult, type PathResult, type RawPath } from "./read.js";
import { onEdgesValidAt, SEARCHABLE_LABEL } from "./projection.js";

export type { NodeRef, EdgeRef, PathResult } from "./read.js";
export { currentEdge } from "./read.js";

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
  opts: { relTypes?: RelType[]; maxPaths?: number; asOf?: number; maxLen?: number } = {},
): Promise<PathResult[]> {
  const rels = opts.relTypes ?? [];
  checkRels(rels);
  const maxPaths = Math.max(1, Math.min(opts.maxPaths ?? 3, 50));
  const timeTravel = opts.asOf !== undefined;
  const cfg = ["sourceNode: a", "targetNode: b", "relDirection: 'both'", "maxLen: $maxLen", "pathCount: $pathCount"];
  if (rels.length) cfg.push("relTypes: $rels");
  if (!timeTravel) cfg.push("costProp: 'closedCost'", "maxCost: $maxCost");
  const run = (h: GraphHandle) => h.roQuery<{ path: RawPath }>(
    `MATCH (a:Entity {id:$from}), (b:Entity {id:$to}) CALL algo.SPpaths({${cfg.join(", ")}}) YIELD path RETURN path`,
    { from: fromId, to: toId, rels, maxLen: opts.maxLen ?? 6, pathCount: maxPaths, maxCost: CLOSED_EDGE_COST - 1 });
  const rows = timeTravel ? await onEdgesValidAt(g, opts.asOf, rels, run) : await run(g);
  const paths = rows.map((r) => r.path).filter((p) => p.edges.every((e) => edgeValidAt(e.properties, opts.asOf)));
  if (!paths.length) {
    const found = await g.roQuery<{ id: string }>("MATCH (n:Entity) WHERE n.id IN $ids RETURN DISTINCT n.id AS id", { ids: [fromId, toId] });
    const missing = [fromId, toId].filter((id) => !found.some((f) => f.id === id));
    if (missing.length) throw new MissingEndpoint(missing, "shortestPaths");
  }
  const out = paths.slice(0, maxPaths).map(toPathResult);
  return timeTravel ? hydrate(g, out) : out;
}

// Paths from a projection know only ids and type labels; fill names, asOf and simulated from the source graph.
async function hydrate(g: GraphHandle, paths: PathResult[]): Promise<PathResult[]> {
  const ids = [...new Set(paths.flatMap((p) => p.nodes.map((n) => n.id)))];
  if (!ids.length) return paths;
  const rows = await g.roQuery<{ id: string; name: string | null; asOf: string | null; simulated: boolean | null }>(
    "MATCH (n:Entity) WHERE n.id IN $ids RETURN n.id AS id, n.name AS name, n.asOf AS asOf, n.simulated AS simulated", { ids });
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

export async function pageRank(g: GraphHandle, label: EntityType | "Entity", rel?: RelType): Promise<Array<{ id: string; score: number }>> {
  checkLabels([label]);
  if (rel) checkRels([rel]);
  return onEdgesValidAt(g, undefined, rel ? [rel] : [], (h) => h.roQuery<{ id: string; score: number }>(
    `CALL algo.pageRank('${projLabel(label)}', ${rel ? `'${rel}'` : "null"}) YIELD node, score WITH node, score WHERE node.id IS NOT NULL
     RETURN node.id AS id, score ORDER BY score DESC, id`));
}

export async function betweenness(g: GraphHandle, labels: Array<EntityType | "Entity">, rels: RelType[]): Promise<Array<{ id: string; score: number }>> {
  checkLabels(labels);
  checkRels(rels);
  return onEdgesValidAt(g, undefined, rels, (h) => h.roQuery<{ id: string; score: number }>(
    `CALL algo.betweenness(${algoConfig(labels, rels)}) YIELD node, score WITH node, score WHERE node.id IS NOT NULL
     RETURN node.id AS id, score ORDER BY score DESC, id`, { labels: labels.map(projLabel), rels }));
}

export async function components(g: GraphHandle, labels: Array<EntityType | "Entity">, rels: RelType[]): Promise<Array<{ id: string; componentId: number }>> {
  checkLabels(labels);
  checkRels(rels);
  return onEdgesValidAt(g, undefined, rels, (h) => h.roQuery<{ id: string; componentId: number }>(
    `CALL algo.WCC(${algoConfig(labels, rels)}) YIELD node, componentId WITH node, componentId WHERE node.id IS NOT NULL
     RETURN node.id AS id, componentId ORDER BY componentId, id`, { labels: labels.map(projLabel), rels }));
}

export async function communities(g: GraphHandle, labels: Array<EntityType | "Entity">, rels: RelType[]): Promise<Array<{ id: string; communityId: number }>> {
  checkLabels(labels);
  checkRels(rels);
  return onEdgesValidAt(g, undefined, rels, (h) => h.roQuery<{ id: string; communityId: number }>(
    `CALL algo.labelPropagation(${algoConfig(labels, rels)}) YIELD node, communityId WITH node, communityId WHERE node.id IS NOT NULL
     RETURN node.id AS id, communityId ORDER BY communityId, id`, { labels: labels.map(projLabel), rels }));
}
