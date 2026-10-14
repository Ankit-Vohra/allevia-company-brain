// Graph algorithms over CURRENT edges (until IS NULL), or over the edges valid at `asOf` (time travel). FalkorDB 6.0's
// algo.* procedures take labels and relationship types but no edge-property filter, so validity is enforced like this:
// - shortestPaths, now: algo.SPpaths with costProp 'closedCost' / maxCost on the live graph. Closed edges carry
//   closedCost = 1e6 (set by upsert), missing cost counts as 0, so SPpaths prunes closed edges during the search and
//   still finds the shortest current path. Results are post-checked too.
// - shortestPaths with asOf, and pageRank / betweenness / components / communities: onEdgesValidAt(). If any edge
//   of the requested types is invalid at that time, the graph is GRAPH.COPY'd to a throwaway projection, the invalid
//   edges are removed from the COPY only, the algorithm runs there, and the copy is dropped. Exact, unlike asking
//   SPpaths for N candidates and filtering (31 short paths that start later can crowd out the one valid long path).
// Paths ignore edge direction (relDirection 'both'): "how is X connected to Y" does not care which way an arrow
// points. EdgeRefs keep the stored direction.
// Note: FalkorDB's labelPropagation is synchronous; on near-bipartite shapes (two triangles sharing an edge) labels
// oscillate and one tight-looking cluster can come back as two communities. Cliques and dense clusters settle.
import { projectionName, sweepProjections, type GraphHandle } from "./client.js";
import { CLOSED_EDGE_COST, isEntityType, isRelType, type EntityType, type RelType } from "./schema.js";
import { MissingEndpoint } from "./errors.js";
import { currentEdge, edgeValidAt, toPathResult, type PathResult, type RawPath } from "./read.js";

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
  return paths.slice(0, maxPaths).map(toPathResult);
}

let swept: Promise<unknown> | undefined;

// Runs `fn` on a graph in which every edge of `rels` (all types when empty) is valid: current when asOf is undefined,
// valid at asOf otherwise. Perf trade-off: once any edge is closed, every algorithm call copies the whole graph
// (milliseconds at hackathon size, not at 1M edges). Later: cache the projection per graph version, or keep it
// incrementally (closing an edge also deletes it from a standing `<graph>__current` copy).
async function onEdgesValidAt<T>(g: GraphHandle, asOf: number | undefined, rels: readonly RelType[], fn: (h: GraphHandle) => Promise<T>): Promise<T> {
  const invalid = asOf === undefined ? "r.until IS NOT NULL" : `NOT (${currentEdge("r", "asOf")})`;
  const [row] = await g.roQuery<{ c: number }>(
    `MATCH ()-[r]->() WHERE ${invalid}${rels.length ? " AND type(r) IN $rels" : ""} RETURN count(r) AS c`, { rels, asOf });
  if (!row?.c) return fn(g);
  // Once per process, before the first projection: drop orphans left by processes that died mid-call.
  await (swept ??= sweepProjections().catch((e) => console.error(`[graph] projection sweep failed: ${(e as Error).message}`)));
  const proj = await g.copyTo(projectionName(g.name, asOf === undefined ? "cur" : "asof"));
  try {
    await proj.query(`MATCH ()-[r]->() WHERE ${invalid} DELETE r`, { asOf });
    return await fn(proj);
  } finally {
    // Never let a failed drop hide the algorithm's own error; a later sweep collects the orphan.
    await proj.drop().catch((e) => console.error(`[graph] could not drop projection ${proj.name}: ${(e as Error).message}`));
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
  return onEdgesValidAt(g, undefined, rel ? [rel] : [], (h) => h.roQuery<{ id: string; score: number }>(
    `CALL algo.pageRank('${label}', ${rel ? `'${rel}'` : "null"}) YIELD node, score WITH node, score WHERE node.id IS NOT NULL
     RETURN node.id AS id, score ORDER BY score DESC, id`));
}

export async function betweenness(g: GraphHandle, labels: Array<EntityType | "Entity">, rels: RelType[]): Promise<Array<{ id: string; score: number }>> {
  checkLabels(labels);
  checkRels(rels);
  return onEdgesValidAt(g, undefined, rels, (h) => h.roQuery<{ id: string; score: number }>(
    `CALL algo.betweenness(${algoConfig(labels, rels)}) YIELD node, score WITH node, score WHERE node.id IS NOT NULL
     RETURN node.id AS id, score ORDER BY score DESC, id`, { labels, rels }));
}

export async function components(g: GraphHandle, labels: Array<EntityType | "Entity">, rels: RelType[]): Promise<Array<{ id: string; componentId: number }>> {
  checkLabels(labels);
  checkRels(rels);
  return onEdgesValidAt(g, undefined, rels, (h) => h.roQuery<{ id: string; componentId: number }>(
    `CALL algo.WCC(${algoConfig(labels, rels)}) YIELD node, componentId WITH node, componentId WHERE node.id IS NOT NULL
     RETURN node.id AS id, componentId ORDER BY componentId, id`, { labels, rels }));
}

export async function communities(g: GraphHandle, labels: Array<EntityType | "Entity">, rels: RelType[]): Promise<Array<{ id: string; communityId: number }>> {
  checkLabels(labels);
  checkRels(rels);
  return onEdgesValidAt(g, undefined, rels, (h) => h.roQuery<{ id: string; communityId: number }>(
    `CALL algo.labelPropagation(${algoConfig(labels, rels)}) YIELD node, communityId WITH node, communityId WHERE node.id IS NOT NULL
     RETURN node.id AS id, communityId ORDER BY communityId, id`, { labels, rels }));
}
