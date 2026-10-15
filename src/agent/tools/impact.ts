// impact_of: "what breaks if X breaks". Breadth-first over current edges, one query per hop: things that DEPEND_ON
// the frontier (reverse DEPENDS_ON) and things the frontier AFFECTS or BLOCKS. Betweenness of the start node is
// computed here, in memory, on that small impact subgraph (Brandes, undirected): it says how much of the impact flows
// through the start node, without copying the tenant graph for algo.betweenness.
import { z } from "zod";
import type { ToolContext } from "../tool.js";
import {
  Collector, EDGE, InputError, NODE, brief, byExactName, clamp, defineTool, edgeAt, edgeText, parseAsOf, requireNode, ro, round, typeOf,
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

// What an empty result means, said apart (the hackathon blog's "not in the graph" vs "no impact"):
// - not in your records: the name or id is not in this business's graph (requireNode refuses before anything runs);
// - not_mapped: it is in the graph, but no current DEPENDS_ON/AFFECTS/BLOCKS edge touches it either way, so its
//   dependencies were never recorded. An empty traversal then says nothing about the real world;
// - nothing_depends: its dependencies are recorded (it depends on something, or something depended on it), and
//   nothing current depends on it or is affected or blocked by it;
// - impact: the traversal found something.
export type ImpactStatus = "impact" | "nothing_depends" | "not_mapped";

export function impactNote(status: ImpactStatus, name: string): string | undefined {
  if (status === "not_mapped") {
    return `${name} is in your records, but no dependencies are recorded for it yet (no DEPENDS_ON, AFFECTS or BLOCKS link either way). That does not mean nothing depends on it: it is not mapped.`;
  }
  if (status === "nothing_depends") return `Nothing current depends on, or is affected or blocked by, ${name}. Its own links are recorded, so this is a real "nothing downstream".`;
  return undefined;
}

async function runImpact(args: { id?: string; query?: string; depth?: number; asOf?: string }, ctx: ToolContext) {
  const asOf = parseAsOf(args.asOf);
  const depth = clamp(args.depth, 3, 1, 4);
  // Resolve the name before any traversal: an unknown name is "not in your records", never an empty impact.
  if (!args.id?.trim() && !args.query?.trim()) throw new InputError("Pass the id (preferred) or the name of what fails.");
  const start = args.id?.trim() ? await requireNode(ctx, args.id.trim())
    : (await byExactName(ctx, args.query!)) ?? (await requireNode(ctx, args.query!.trim()));
  const found = new Map<string, Item>();
  let frontier = [start.id];
  let more = false;
  // One query per hop, new nodes only, first by name: a hub with 10,000+ dependents cannot overflow the result, and
  // the IMPACT_CAP kept are the same every time. Each node comes once, with one edge that pulls it in.
  for (let hop = 1; hop <= depth && frontier.length && found.size < IMPACT_CAP; hop++) {
    const k = IMPACT_CAP - found.size + 1;
    const branch = (pattern: string) =>
      `UNWIND $ids AS fid MATCH (f:Entity {id:fid}) WITH f MATCH ${pattern} WHERE ${edgeAt("r", asOf)} AND NOT x.id IN $seen
       WITH x, head(collect(${EDGE("r")})) AS e RETURN ${NODE("x")} AS x, e ORDER BY x.name, x.id LIMIT $k`;
    const rows = await ro<{ x: NodeRow; e: EdgeRow }>(ctx,
      `${branch("(x:Entity)-[r:DEPENDS_ON]->(f)")} UNION ALL ${branch("(f)-[r:AFFECTS|BLOCKS]->(x:Entity)")}`,
      { ids: frontier, asOf, seen: [start.id, ...found.keys()], k });
    const next: string[] = [];
    for (const r of rows.sort((a, b) => String(a.x.name).localeCompare(String(b.x.name)) || a.x.id.localeCompare(b.x.id))) {
      if (found.has(r.x.id)) continue;
      if (found.size >= IMPACT_CAP) {
        more = true;
        break;
      }
      found.set(r.x.id, { node: r.x, hop, e: r.e });
      next.push(r.x.id);
    }
    frontier = next;
  }

  const col = new Collector();
  col.node(start);
  const nodes = [start.id, ...found.keys()];
  // The impact subgraph: every current DEPENDS_ON/AFFECTS/BLOCKS edge among the nodes found (at most 61).
  const kept = (await ro<{ e: EdgeRow }>(ctx,
    `MATCH (a:Entity)-[r:DEPENDS_ON|AFFECTS|BLOCKS]->(b:Entity) WHERE a.id IN $ids AND b.id IN $ids AND ${edgeAt("r", asOf)}
     RETURN ${EDGE("r")} AS e LIMIT 1000`, { ids: nodes, asOf })).map((r) => r.e);
  const byHop = new Map<number, Array<Record<string, unknown>>>();
  for (const it of found.values()) {
    col.node(it.node);
    const list = byHop.get(it.hop) ?? [];
    list.push({ ...brief(it.node), because: edgeText(it.e) });
    byHop.set(it.hop, list);
  }
  for (const e of kept) col.edge(e);
  const score = nodes.length >= 3 ? betweennessOf(nodes, kept.map((e) => [e.from, e.to])).get(start.id)! : 0;
  const pairs = ((nodes.length - 1) * (nodes.length - 2)) / 2;
  let status: ImpactStatus = "impact";
  if (!found.size) {
    // Bind and use the edge (ID(r) >= 0): FalkorDB 6.0.2 collapses parallel edges nothing refers to under count().
    const [m] = await ro<{ c: number }>(ctx,
      `MATCH (s:Entity {id:$id}) OPTIONAL MATCH (s)-[r:DEPENDS_ON|AFFECTS|BLOCKS]-(:Entity) WHERE ID(r) >= 0 AND ${edgeAt("r", asOf)}
       RETURN count(r) AS c`, { id: start.id, asOf });
    status = (m?.c ?? 0) > 0 ? "nothing_depends" : "not_mapped";
  }
  return col.result(ctx, {
    id: start.id, type: typeOf(start), name: start.name ?? start.id, depth, status, total: found.size,
    impacted: [...byHop.entries()].map(([hop, items]) => ({ hop, items })),
    betweenness: { score: round(score, 3), normalized: pairs > 0 ? round(score / pairs, 3) : 0, subgraphNodes: nodes.length },
  }, found.size ? (more || found.size >= IMPACT_CAP ? `Stopped at ${IMPACT_CAP} impacted items (first by name at each hop); there are more.` : undefined)
    : impactNote(status, start.id));
}

export const impactOf = defineTool({
  name: "impact_of",
  description:
    "Answer 'what breaks if X fails, expires or goes down': what DEPENDS_ON X and X AFFECTS or BLOCKS, by hop (depth 1-4), each with its edge. A token fails with the System using it. status not_mapped = no dependencies recorded (never say nothing breaks); an unknown name: say you don't have it in the records. Example: {\"id\":\"system:ig-connector\",\"depth\":3}",
  input: {
    id: z.string().optional().describe("Id of what fails (preferred)"),
    query: z.string().optional().describe("Its exact name, when you lack the id"),
    depth: z.number().int().optional().describe("Hops to follow, 1 to 4, default 3"),
    asOf: z.string().optional().describe("ISO date"),
  },
  run: runImpact,
});
