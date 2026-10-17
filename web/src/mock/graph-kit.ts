// Helpers to declare a mock tenant graph compactly and to cut tool-result-sized pieces out of it.
import type { EdgeRef, NodeRef, SourceRef } from "@shared/contracts";
import type { GraphData, GraphNode, NodeDetail, VersionRecord } from "../types-ext";
import type { BrainMapDto } from "../lib/brain-map";

export interface MockNode extends GraphNode {
  summary?: string;
  props?: Record<string, unknown>;
  src?: string[];               // Document ids this node was sourced from
  versions?: VersionRecord[];
}

export interface MockGraph {
  nodes: Map<string, MockNode>;
  edges: EdgeRef[];
}

type NodeSpec = readonly [id: string, label: string, name: string, extra?: Partial<MockNode>];
type EdgeSpec = [from: string, type: string, to: string, since?: string];

export function buildGraph(nodeSpecs: NodeSpec[], edgeSpecs: EdgeSpec[]): MockGraph {
  const nodes = new Map<string, MockNode>();
  for (const [id, label, name, extra] of nodeSpecs) nodes.set(id, { id, label, name, ...extra });
  const edges: EdgeRef[] = [];
  for (const [from, type, to, since] of edgeSpecs) {
    if (!nodes.has(from) || !nodes.has(to)) {
      if (import.meta.env.DEV) console.warn(`[mock] edge ${from} -${type}-> ${to} references a missing node`);
      continue;
    }
    edges.push({ from, type, to, since: since ? Date.parse(since) : undefined, until: null });
  }
  // rank ~ normalised degree, a stand-in for PageRank in the mock
  const deg = new Map<string, number>();
  for (const e of edges) {
    deg.set(e.from, (deg.get(e.from) ?? 0) + 1);
    deg.set(e.to, (deg.get(e.to) ?? 0) + 1);
  }
  const max = Math.max(1, ...deg.values());
  for (const n of nodes.values()) {
    n.rank ??= Math.round(((deg.get(n.id) ?? 0) / max) * 100) / 100;
    n.community ??= COMMUNITY[n.label] ?? 0;
  }
  return { nodes, edges };
}

const COMMUNITY: Record<string, number> = {
  Business: 0, Person: 0, Team: 0, Agent: 0,
  Decision: 1, Document: 1, Memory: 1, Turn: 1, Session: 1,
  Channel: 2, Content: 2, Campaign: 2,
  Audience: 3, Need: 3, Product: 3, Feature: 3,
  Rule: 4, BrandRule: 4, BrandAsset: 4, Playbook: 4,
  Observation: 5, Metric: 5,
  Page: 6, Query: 6, Event: 6,
  Task: 7, System: 7, Recommendation: 7, Approval: 7, Action: 7, Finding: 7,
};

export function refOf(g: MockGraph, id: string): NodeRef {
  const n = g.nodes.get(id);
  if (!n) return { id, label: id.split(":")[0] ?? "Entity", name: id };
  const r: NodeRef = { id: n.id, label: n.label, name: n.name };
  if (n.asOf) r.asOf = n.asOf;
  if (n.simulated) r.simulated = true;
  return r;
}

export const refs = (g: MockGraph, ids: string[]) => ids.map((id) => refOf(g, id));

/** Edges whose both ends are in `ids`. */
export function edgesAmong(g: MockGraph, ids: string[]): EdgeRef[] {
  const set = new Set(ids);
  return g.edges.filter((e) => set.has(e.from) && set.has(e.to));
}

export function sourcesOf(g: MockGraph, ids: string[]): SourceRef[] {
  const out = new Map<string, SourceRef>();
  for (const id of ids) {
    const n = g.nodes.get(id);
    for (const s of n?.src ?? []) {
      const d = g.nodes.get(s);
      if (d) out.set(d.id, { id: d.id, title: d.name, asOf: d.asOf });
    }
    if (n?.label === "Document") out.set(n.id, { id: n.id, title: n.name, asOf: n.asOf });
  }
  return [...out.values()];
}

/** A tool_result-shaped slice: the nodes, the edges among them, and their sources. */
export function slice(g: MockGraph, ids: string[]) {
  return { nodes: refs(g, ids), edges: edgesAmong(g, ids), sources: sourcesOf(g, ids) };
}

export function graphData(g: MockGraph, ids?: string[]): GraphData {
  const pick = ids ? ids.map((id) => g.nodes.get(id)).filter((n): n is MockNode => !!n) : [...g.nodes.values()];
  const set = new Set(pick.map((n) => n.id));
  return {
    nodes: pick.map(({ id, label, name, asOf, simulated, rank, community, summary }) => ({ id, label, name, asOf, simulated, rank, community, summary })),
    edges: g.edges.filter((e) => set.has(e.from) && set.has(e.to)),
  };
}

/** The Brain map, shaped like GET /api/:t/graph/map: the top `limit` by rank, links as index triples, the whole graph's size.
 *  The mock has no record of when each thing was learned, so its own date stands in (and the order is by importance). */
export function mapOf(g: MockGraph, limit = 400): BrainMapDto {
  const all = [...g.nodes.values()].filter((n) => !["Version", "Chunk", "Observation", "Turn", "Session"].includes(n.label));
  const top = all.sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0) || a.id.localeCompare(b.id)).slice(0, Math.max(1, limit));
  const index = new Map(top.map((n, i) => [n.id, i]));
  const types: string[] = [];
  const links: Array<[number, number, number]> = [];
  for (const e of g.edges) {
    const a = index.get(e.from), b = index.get(e.to);
    if (a === undefined || b === undefined || a === b) continue;
    if (!types.includes(e.type)) types.push(e.type);
    links.push([a, b, types.indexOf(e.type)]);
  }
  const counts: Record<string, number> = {};
  for (const n of g.nodes.values()) counts[n.label] = (counts[n.label] ?? 0) + 1;
  const learned = (n: MockNode) => (n.asOf ? Date.parse(n.asOf) : undefined);
  return {
    nodes: top.map((n) => ({
      id: n.id, label: n.label, name: n.name, rank: n.rank ?? 0, ...(n.community !== undefined ? { community: n.community } : {}),
      ...(n.asOf ? { asOf: n.asOf } : {}), ...(n.simulated ? { simulated: true } : {}), ...(learned(n) ? { learnedAt: learned(n) } : {}),
    })),
    types, links, counts,
    totals: { things: Object.entries(counts).reduce((s, [l, c]) => (l === "Version" || l === "Chunk" ? s : s + c), 0), links: g.edges.length },
    capped: all.length > top.length,
  };
}

export function neighborhood(g: MockGraph, focus: string, depth = 1, limit = 60): GraphData {
  const seen = new Set<string>([focus]);
  let frontier = [focus];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const e of g.edges) {
      for (const f of frontier) {
        const other = e.from === f ? e.to : e.to === f ? e.from : null;
        if (other && !seen.has(other) && seen.size < limit) { seen.add(other); next.push(other); }
      }
    }
    frontier = next;
  }
  return graphData(g, [...seen]);
}

export function nodeDetail(g: MockGraph, id: string): NodeDetail | null {
  const n = g.nodes.get(id);
  if (!n) return null;
  const neighbors: NodeDetail["neighbors"] = [];
  for (const e of g.edges) {
    if (e.from === id) neighbors.push({ edge: e, node: refOf(g, e.to), direction: "out" });
    else if (e.to === id) neighbors.push({ edge: e, node: refOf(g, e.from), direction: "in" });
  }
  const { summary, props, versions } = n;
  return {
    node: { id: n.id, label: n.label, name: n.name, asOf: n.asOf, simulated: n.simulated, rank: n.rank, community: n.community, summary },
    props: { ...(props ?? {}), ...(n.asOf ? { asOf: n.asOf } : {}), ...(n.simulated ? { simulated: true } : {}) },
    neighbors,
    versions: versions ?? [],
    sources: sourcesOf(g, [id]),
  };
}

export function searchGraph(g: MockGraph, q: string, limit = 12) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const hits: { node: NodeRef; score: number; snippet?: string }[] = [];
  for (const n of g.nodes.values()) {
    const hay = `${n.name} ${n.summary ?? ""} ${n.id}`.toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (n.name.toLowerCase().includes(t)) score += 3;
      else if (hay.includes(t)) score += 1;
    }
    if (score > 0) hits.push({ node: refOf(g, n.id), score: score + (n.rank ?? 0), snippet: n.summary });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
