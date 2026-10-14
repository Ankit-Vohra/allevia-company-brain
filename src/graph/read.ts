// Read-side helpers: temporal predicates ("current" or "as of t") and conversion of raw FalkorDB results (nodes,
// edges, paths) into the small refs the agent, API and UI pass around. Vectors never leave this layer.
import { isEntityType, type EntityType, type RelType } from "./schema.js";

export interface NodeRef { id: string; label: EntityType; name: string; asOf?: string; simulated?: boolean }
export interface EdgeRef { from: string; type: RelType; to: string; since?: number; until?: number | null }
export interface PathResult { nodes: NodeRef[]; edges: EdgeRef[]; length: number }

// Shapes falkordb@6.8 returns in compact mode.
export interface RawNode { id: number; labels: string[]; properties: Record<string, unknown> }
export interface RawEdge { id: number; relationshipType: string; sourceId: number; destinationId: number; properties: Record<string, unknown> }
export interface RawPath { nodes: RawNode[]; edges: RawEdge[] }

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HIDDEN_PROPS = new Set(["embedding", "textEmbedding", "closedCost"]);

// Cypher predicate for "this edge holds now" or, with a param name, "held at $param" (epoch ms):
//   currentEdge('r')         -> r.until IS NULL
//   currentEdge('r','asOf')  -> (r.since IS NULL OR r.since <= $asOf) AND (r.until IS NULL OR r.until > $asOf)
export function currentEdge(alias: string, asOfParam?: string): string {
  if (!IDENT.test(alias)) throw new Error(`bad alias ${JSON.stringify(alias)}`);
  if (asOfParam === undefined) return `${alias}.until IS NULL`;
  if (!IDENT.test(asOfParam)) throw new Error(`bad param name ${JSON.stringify(asOfParam)}`);
  return `(${alias}.since IS NULL OR ${alias}.since <= $${asOfParam}) AND (${alias}.until IS NULL OR ${alias}.until > $${asOfParam})`;
}

// The same rule in JS, for post-filtering edges already fetched.
export function edgeValidAt(props: Record<string, unknown>, asOf?: number): boolean {
  const since = typeof props.since === "number" ? props.since : null;
  const until = typeof props.until === "number" ? props.until : null;
  if (asOf === undefined) return until === null;
  return (since === null || since <= asOf) && (until === null || until > asOf);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function isRawNode(v: unknown): v is RawNode {
  return isObj(v) && typeof v.id === "number" && Array.isArray(v.labels) && isObj(v.properties);
}
export function isRawEdge(v: unknown): v is RawEdge {
  return isObj(v) && typeof v.relationshipType === "string" && typeof v.sourceId === "number" && isObj(v.properties);
}
export function isRawPath(v: unknown): v is RawPath {
  return isObj(v) && Array.isArray(v.nodes) && Array.isArray(v.edges) && v.nodes.every(isRawNode);
}

// `label` is the type label (the one that is not `Entity`).
export function toNodeRef(n: RawNode): NodeRef {
  const p = n.properties;
  const label = (n.labels.find((l) => l !== "Entity" && isEntityType(l)) ?? n.labels.find((l) => l !== "Entity") ?? "Entity") as EntityType;
  const ref: NodeRef = { id: String(p.id ?? `#${n.id}`), label, name: String(p.name ?? p.id ?? `#${n.id}`) };
  if (typeof p.asOf === "string") ref.asOf = p.asOf;
  if (typeof p.simulated === "boolean") ref.simulated = p.simulated;
  return ref;
}

// `ids` maps FalkorDB's internal node ids to entity ids (built from the nodes of the same result).
export function toEdgeRef(e: RawEdge, ids: Map<number, string>): EdgeRef {
  const p = e.properties;
  return {
    from: ids.get(e.sourceId) ?? `#${e.sourceId}`,
    type: e.relationshipType as RelType,
    to: ids.get(e.destinationId) ?? `#${e.destinationId}`,
    ...(typeof p.since === "number" ? { since: p.since } : {}),
    until: typeof p.until === "number" ? p.until : null,
  };
}

export function toPathResult(p: RawPath): PathResult {
  const nodes = p.nodes.map(toNodeRef);
  const ids = new Map(p.nodes.map((n, i) => [n.id, nodes[i]!.id]));
  return { nodes, edges: p.edges.map((e) => toEdgeRef(e, ids)), length: p.edges.length };
}

// Recursively shapes a result value for callers outside the graph layer: nodes -> NodeRef, paths -> PathResult,
// a bare edge -> {type, ...props} (its endpoints are only internal ids), vectors dropped.
export function shapeValue(v: unknown): unknown {
  if (isRawPath(v)) return toPathResult(v);
  if (isRawNode(v)) return toNodeRef(v);
  if (isRawEdge(v)) {
    const props = Object.fromEntries(Object.entries(v.properties).filter(([k]) => !HIDDEN_PROPS.has(k)));
    return { type: v.relationshipType, ...props };
  }
  if (Array.isArray(v)) return v.map(shapeValue);
  if (isObj(v)) return Object.fromEntries(Object.entries(v).filter(([k]) => !HIDDEN_PROPS.has(k)).map(([k, x]) => [k, shapeValue(x)]));
  return v;
}
