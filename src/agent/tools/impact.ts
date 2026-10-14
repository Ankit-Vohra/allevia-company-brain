// impact_of: "what breaks if X breaks". Breadth-first over current edges, one query per hop: things that DEPEND_ON
// the frontier (reverse DEPENDS_ON) and things the frontier AFFECTS or BLOCKS. Betweenness of the start node is
// computed here, in memory, on that small impact subgraph (Brandes, undirected): it says how much of the impact flows
// through the start node, without copying the tenant graph for algo.betweenness.
import { z } from "zod";
import type { ToolContext } from "../tool.js";
import {
  Collector, EDGE, NODE, brief, clamp, defineTool, edgeAt, edgeText, parseAsOf, requireNode, ro, round, typeOf,
  type EdgeRow, type NodeRow,
} from "./common.js";

const IMPACT_CAP = 60;

// Brandes betweenness on an undirected, unweighted graph. Each unordered pair counts once.
export function betweennessOf(nodes: string[], edges: Array<[string, string]>): Map<string, number> {
  const adj = new Map(nodes.map((n) => [n, new Set<string>()]));
  for (const [a, b] of edges) {
    if (a === b || !adj.has(a) || !adj.has(b)) continue;
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  }
  const cb = new Map(nodes.map((n) => [n, 0]));
  for (const s of nodes) {
    const stack: string[] = [];
    const pred = new Map(nodes.map((n) => [n, [] as string[]]));
    const sigma = new Map(nodes.map((n) => [n, n === s ? 1 : 0]));
    const dist = new Map(nodes.map((n) => [n, n === s ? 0 : -1]));
    const queue = [s];
    while (queue.length) {
      const v = queue.shift()!;
      stack.push(v);
      for (const w of adj.get(v)!) {
        if (dist.get(w)! < 0) {
          queue.push(w);
          dist.set(w, dist.get(v)! + 1);
        }
        if (dist.get(w) === dist.get(v)! + 1) {
          sigma.set(w, sigma.get(w)! + sigma.get(v)!);
          pred.get(w)!.push(v);
        }
      }
    }
    const delta = new Map(nodes.map((n) => [n, 0]));
    while (stack.length) {
      const w = stack.pop()!;
      for (const v of pred.get(w)!) delta.set(v, delta.get(v)! + (sigma.get(v)! / sigma.get(w)!) * (1 + delta.get(w)!));
      if (w !== s) cb.set(w, cb.get(w)! + delta.get(w)!);
    }
  }
  for (const n of nodes) cb.set(n, cb.get(n)! / 2);
  return cb;
}

interface Item { node: NodeRow; hop: number; e: EdgeRow }

async function runImpact(args: { id: string; depth?: number; asOf?: string }, ctx: ToolContext) {
  const asOf = parseAsOf(args.asOf);
  const depth = clamp(args.depth, 3, 1, 4);
  const start = await requireNode(ctx, args.id);
  const found = new Map<string, Item>();
  const edges: EdgeRow[] = [];
  const visited = new Set([start.id]);
  let frontier = [start.id];
  for (let hop = 1; hop <= depth && frontier.length && found.size < IMPACT_CAP; hop++) {
    const rows = await ro<{ x: NodeRow; e: EdgeRow }>(ctx,
      `UNWIND $ids AS fid MATCH (x:Entity)-[r:DEPENDS_ON]->(:Entity {id:fid}) WHERE ${edgeAt("r", asOf)} RETURN ${NODE("x")} AS x, ${EDGE("r")} AS e
       UNION ALL
       UNWIND $ids AS fid MATCH (:Entity {id:fid})-[r:AFFECTS|BLOCKS]->(x:Entity) WHERE ${edgeAt("r", asOf)} RETURN ${NODE("x")} AS x, ${EDGE("r")} AS e`,
      { ids: frontier, asOf });
    const next: string[] = [];
    for (const r of rows.sort((a, b) => String(a.x.name).localeCompare(String(b.x.name)))) {
      edges.push(r.e);
      if (visited.has(r.x.id) || found.size >= IMPACT_CAP) continue;
      visited.add(r.x.id);
      found.set(r.x.id, { node: r.x, hop, e: r.e });
      next.push(r.x.id);
    }
    frontier = next;
  }

  const col = new Collector();
  col.node(start);
  const inSet = new Set([start.id, ...found.keys()]);
  const kept = edges.filter((e) => inSet.has(e.from) && inSet.has(e.to));
  const byHop = new Map<number, Array<Record<string, unknown>>>();
  for (const it of found.values()) {
    col.node(it.node);
    const list = byHop.get(it.hop) ?? [];
    list.push({ ...brief(it.node), because: edgeText(it.e) });
    byHop.set(it.hop, list);
  }
  for (const e of kept) col.edge(e);
  const nodes = [...inSet];
  const score = nodes.length >= 3 ? betweennessOf(nodes, kept.map((e) => [e.from, e.to])).get(start.id)! : 0;
  const pairs = ((nodes.length - 1) * (nodes.length - 2)) / 2;
  return col.result(ctx, {
    id: start.id, type: typeOf(start), name: start.name ?? start.id, depth, total: found.size,
    impacted: [...byHop.entries()].map(([hop, items]) => ({ hop, items })),
    betweenness: { score: round(score, 3), normalized: pairs > 0 ? round(score / pairs, 3) : 0, subgraphNodes: nodes.length },
  }, found.size ? (found.size >= IMPACT_CAP ? `Stopped at ${IMPACT_CAP} impacted items.` : undefined) : `Nothing current depends on, or is affected or blocked by, ${start.id}.`);
}

export const impactOf = defineTool({
  name: "impact_of",
  description:
    "What breaks or changes if this node fails or changes: things that DEPEND_ON it and things it AFFECTS or BLOCKS, followed up to depth hops (current edges), listed by hop with the edge that pulls each in; plus how central the node is in that impact subgraph (betweenness). Example: {\"id\":\"system:ig-connector\",\"depth\":3}",
  input: {
    id: z.string().min(1),
    depth: z.number().int().optional().describe("Hops to follow, 1 to 4, default 3"),
    asOf: z.string().optional().describe("ISO date"),
  },
  run: runImpact,
});
