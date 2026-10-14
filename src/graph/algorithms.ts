// Graph algorithms over CURRENT edges (until IS NULL). FalkorDB 6.0's algo.* procedures take labels and
// relationship types but no edge-property filter, so "current only" is enforced two ways:
// - shortestPaths: algo.SPpaths with costProp 'closedCost' / maxCost. Closed edges carry closedCost = 1e6 (set by
//   upsert), missing cost counts as 0, so SPpaths prunes closed edges during the search and still finds the shortest
//   current path. Results are post-checked too. Edges are walked in both directions (relDirection 'both') because
//   "how is X connected to Y" does not care which way an arrow points; EdgeRefs keep the stored direction.
//   With `asOf` (time travel) there is no static cost to use: we ask SPpaths for 10x the paths and keep those whose
//   edges were all valid at asOf. Best effort: if every one of those candidates crossed an edge invalid at asOf,
//   a longer valid path can be missed.
// - pageRank / betweenness / components / communities: if any closed edge of the requested types exists, the graph
//   is GRAPH.COPY'd to a throwaway `<graph>__cur_<rand>`, closed edges are removed from the COPY only, the algorithm
//   runs there, and the copy is dropped. With no closed edges the algorithm runs directly (read-only).
// Note: FalkorDB's labelPropagation is synchronous; on near-bipartite shapes (two triangles sharing an edge) labels
// oscillate and one tight-looking cluster can come back as two communities. Cliques and dense clusters settle.
import { randomBytes } from "node:crypto";
import type { GraphHandle } from "./client.js";
import { CLOSED_EDGE_COST, isEntityType, isRelType, type EntityType, type RelType } from "./schema.js";
import { MissingEndpoint } from "./errors.js";
import { edgeValidAt, toPathResult, type PathResult, type RawPath } from "./read.js";

export type { NodeRef, EdgeRef, PathResult } from "./read.js";
export { currentEdge } from "./read.js";

function checkLabels(labels: readonly string[]): void {
  for (const l of labels) if (l !== "Entity" && !isEntityType(l)) throw new Error(`unknown label ${JSON.stringify(l)}`);
}
function checkRels(rels: readonly string[]): void {
  for (const r of rels) if (!isRelType(r)) throw new Error(`unknown relationship type ${JSON.stringify(r)}`);
}

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
  const rows = await g.roQuery<{ path: RawPath }>(
    `MATCH (a:Entity {id:$from}), (b:Entity {id:$to}) CALL algo.SPpaths({${cfg.join(", ")}}) YIELD path RETURN path`,
    { from: fromId, to: toId, rels, maxLen: opts.maxLen ?? 6, pathCount: timeTravel ? Math.min(maxPaths * 10, 200) : maxPaths, maxCost: CLOSED_EDGE_COST - 1 });
  const paths = rows.map((r) => r.path).filter((p) => p.edges.every((e) => edgeValidAt(e.properties, opts.asOf)));
  if (!paths.length) {
    const found = await g.roQuery<{ id: string }>("MATCH (n:Entity) WHERE n.id IN $ids RETURN DISTINCT n.id AS id", { ids: [fromId, toId] });
    const missing = [fromId, toId].filter((id) => !found.some((f) => f.id === id));
    if (missing.length) throw new MissingEndpoint(missing, "shortestPaths");
  }
  return paths.slice(0, maxPaths).map(toPathResult);
}

// Runs `fn` on a graph whose edges of `rels` (all types when empty) are all current.
async function onCurrentEdges<T>(g: GraphHandle, rels: readonly RelType[], fn: (h: GraphHandle) => Promise<T>): Promise<T> {
  const [row] = await g.roQuery<{ c: number }>(
    `MATCH ()-[r]->() WHERE r.until IS NOT NULL${rels.length ? " AND type(r) IN $rels" : ""} RETURN count(r) AS c`, { rels });
  if (!row?.c) return fn(g);
  const proj = await g.copyTo(`${g.name}__cur_${randomBytes(4).toString("hex")}`);
  try {
    await proj.query("MATCH ()-[r]->() WHERE r.until IS NOT NULL DELETE r");
    return await fn(proj);
  } finally {
    await proj.drop();
  }
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
  return onCurrentEdges(g, rel ? [rel] : [], (h) => h.roQuery<{ id: string; score: number }>(
    `CALL algo.pageRank('${label}', ${rel ? `'${rel}'` : "null"}) YIELD node, score WITH node, score WHERE node.id IS NOT NULL
     RETURN node.id AS id, score ORDER BY score DESC, id`));
}

export async function betweenness(g: GraphHandle, labels: Array<EntityType | "Entity">, rels: RelType[]): Promise<Array<{ id: string; score: number }>> {
  checkLabels(labels);
  checkRels(rels);
  return onCurrentEdges(g, rels, (h) => h.roQuery<{ id: string; score: number }>(
    `CALL algo.betweenness(${algoConfig(labels, rels)}) YIELD node, score WITH node, score WHERE node.id IS NOT NULL
     RETURN node.id AS id, score ORDER BY score DESC, id`, { labels, rels }));
}

export async function components(g: GraphHandle, labels: Array<EntityType | "Entity">, rels: RelType[]): Promise<Array<{ id: string; componentId: number }>> {
  checkLabels(labels);
  checkRels(rels);
  return onCurrentEdges(g, rels, (h) => h.roQuery<{ id: string; componentId: number }>(
    `CALL algo.WCC(${algoConfig(labels, rels)}) YIELD node, componentId WITH node, componentId WHERE node.id IS NOT NULL
     RETURN node.id AS id, componentId ORDER BY componentId, id`, { labels, rels }));
}

export async function communities(g: GraphHandle, labels: Array<EntityType | "Entity">, rels: RelType[]): Promise<Array<{ id: string; communityId: number }>> {
  checkLabels(labels);
  checkRels(rels);
  return onCurrentEdges(g, rels, (h) => h.roQuery<{ id: string; communityId: number }>(
    `CALL algo.labelPropagation(${algoConfig(labels, rels)}) YIELD node, communityId WITH node, communityId WHERE node.id IS NOT NULL
     RETURN node.id AS id, communityId ORDER BY communityId, id`, { labels, rels }));
}
