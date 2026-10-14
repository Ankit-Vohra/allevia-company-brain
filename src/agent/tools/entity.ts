// Looking at one entity: get_entity (props, current neighbours by relationship, versions, latest numbers), neighbors
// (typed one- or two-hop expansion) and history (versions and closed relationships, oldest first). All three honour
// time: get_entity and neighbors take `asOf`; history shows every change.
import { z } from "zod";
import type { ToolContext } from "../tool.js";
import { REL_TYPES } from "../../graph/schema.js";
import { toIso } from "../../util/time.js";
import {
  BOOKKEEPING_TYPES, Collector, DEFAULT_ROWS, EDGE, MEMORY_RELS, NODE, brief, clamp, compactProps, defineTool, edgeAt,
  parseAsOf, requireNode, ro, typeOf, type Brief, type EdgeRow, type NodeRow,
} from "./common.js";

const GROUP_CAP = 10;
const asOfInput = z.string().optional().describe("ISO date: see the graph as it was then, e.g. 2026-10-01");

// Neighbour types hidden by default (counted instead). An entity of a bookkeeping type still sees its own kind.
function hiddenFor(type: string): string[] {
  return BOOKKEEPING_TYPES.includes(type as never) ? ["Version"].filter((t) => t !== type) : BOOKKEEPING_TYPES;
}

const PROPS = "[k IN keys(n) WHERE NOT k IN ['embedding', 'textEmbedding'] | [k, n[k]]] AS kv";

// ---------- get_entity ----------

interface ObsRow { o: NodeRow; e: EdgeRow; metric: string; value: number; unit: string | null; ws: string | null; we: string | null; at: string | null }

async function runGetEntity(args: { id: string; asOf?: string }, ctx: ToolContext) {
  const asOf = parseAsOf(args.asOf);
  const target = await requireNode(ctx, args.id);
  const type = typeOf(target);
  const p = { id: target.id, asOf, hidden: hiddenFor(type), asOfDate: asOf === undefined ? null : toIso(asOf) };
  const [[node], nbrs, hiddenRows, [vc], obs, [ver]] = await Promise.all([
    ro<{ kv: Array<[string, unknown]> }>(ctx, `MATCH (n:Entity {id:$id}) RETURN ${PROPS}`, p),
    ro<{ e: EdgeRow; m: NodeRow }>(ctx,
      `MATCH (n:Entity {id:$id})-[r]-(m:Entity) WHERE ${edgeAt("r", asOf)} AND type(r) <> 'HAD_VERSION'
       AND NOT any(l IN labels(m) WHERE l IN $hidden) RETURN ${EDGE("r")} AS e, ${NODE("m")} AS m ORDER BY type(r), m.name LIMIT 300`, p),
    ro<{ type: string; c: number }>(ctx,
      `MATCH (n:Entity {id:$id})-[r]-(m:Entity) WHERE ${edgeAt("r", asOf)} AND any(l IN labels(m) WHERE l IN $hidden)
       RETURN [l IN labels(m) WHERE l <> 'Entity'][0] AS type, count(DISTINCT m) AS c`, p),
    ro<{ c: number }>(ctx, "MATCH (:Entity {id:$id})-[:HAD_VERSION]->(v) RETURN count(v) AS c", p),
    ro<ObsRow>(ctx,
      `MATCH (o:Observation)-[r:MEASURES]->(:Entity {id:$id}) WITH o, r, coalesce(o.windowEnd, o.asOf) AS at
       WHERE $asOfDate IS NULL OR at <= $asOfDate
       RETURN ${NODE("o")} AS o, ${EDGE("r")} AS e, o.metric AS metric, o.value AS value, o.unit AS unit, o.windowStart AS ws, o.windowEnd AS we, at
       ORDER BY at DESC LIMIT 200`, p),
    asOf === undefined ? Promise.resolve([]) : ro<{ id: string; props: string }>(ctx,
      "MATCH (:Entity {id:$id})-[:HAD_VERSION]->(v:Version) WHERE v.since <= $asOf AND v.until > $asOf RETURN v.id AS id, v.props AS props ORDER BY v.until LIMIT 1", p),
  ]);

  const col = new Collector();
  col.node(target);
  let kv = node?.kv ?? [];
  let note: string | undefined;
  if (ver) {
    try {
      kv = Object.entries(JSON.parse(ver.props) as Record<string, unknown>);
      note = `Props are as they were on ${args.asOf} (from ${ver.id}).`;
    } catch { /* keep current props */ }
  }
  const props = compactProps(kv.filter(([k]) => k !== "id" && k !== "name"));

  const neighbors: Record<string, { count: number; items: Brief[] }> = {};
  for (const { e, m } of nbrs) {
    const key = `${e.from === target.id ? "out" : "in"}:${e.type}`;
    const group = (neighbors[key] ??= { count: 0, items: [] });
    group.count++;
    if (group.items.length < GROUP_CAP) {
      group.items.push(brief(m));
      col.node(m);
      col.edge(e);
    }
  }

  const latest = new Map<string, ObsRow>();
  for (const o of obs) if (!latest.has(o.metric) && latest.size < 10) latest.set(o.metric, o);
  const observations = [...latest.values()].map((o) => {
    col.node(o.o);
    col.edge(o.e);
    return {
      id: o.o.id, metric: o.metric, value: o.value, ...(o.unit ? { unit: o.unit } : {}),
      window: o.ws && o.we ? `${o.ws}..${o.we}` : o.at, ...(o.o.simulated ? { simulated: true } : {}),
    };
  });

  const hidden = Object.fromEntries(hiddenRows.filter((h) => h.type).map((h) => [h.type, h.c]));
  return col.result(ctx, {
    id: target.id, type, name: target.name ?? target.id, ...(args.asOf ? { asOf: args.asOf } : {}),
    props, neighbors, versions: vc?.c ?? 0, observations, ...(Object.keys(hidden).length ? { hiddenNeighbors: hidden } : {}),
  }, note);
}

export const getEntity = defineTool({
  name: "get_entity",
  description:
    "Everything about one node by id: its properties, current neighbours grouped by relationship (in:/out:), how many past versions it has, and its latest numbers (one per metric). Pass asOf to see relationships and properties as they were on a date. Example: {\"id\":\"task:fix-ig-token\",\"asOf\":\"2026-10-01\"}",
  input: { id: z.string().min(1).describe("Entity id, e.g. decision:007-pause-daily-stories"), asOf: asOfInput },
  run: runGetEntity,
});

// ---------- neighbors ----------

interface PathRow { ns: NodeRow[]; es: EdgeRow[] }

async function runNeighbors(args: { id: string; rels?: string[]; direction?: "out" | "in" | "both"; depth?: number; limit?: number; asOf?: string }, ctx: ToolContext) {
  const asOf = parseAsOf(args.asOf);
  const depth = clamp(args.depth, 1, 1, 2);
  const limit = clamp(args.limit, DEFAULT_ROWS, 1, 100);
  const start = await requireNode(ctx, args.id);
  const rels = args.rels?.length ? args.rels : null;
  const dir = args.direction ?? "both";
  const pat = dir === "out" ? `-[*1..${depth}]->` : dir === "in" ? `<-[*1..${depth}]-` : `-[*1..${depth}]-`;
  const rows = await ro<PathRow>(ctx,
    `MATCH p = (n:Entity {id:$id})${pat}(m:Entity)
     WHERE m.id <> $id AND ALL(r IN relationships(p) WHERE ${edgeAt("r", asOf)} AND ${rels ? "type(r) IN $rels" : "NOT type(r) IN $mem"})
       AND NONE(x IN nodes(p) WHERE any(l IN labels(x) WHERE l IN $hidden))
     RETURN [x IN nodes(p) | ${NODE("x")}] AS ns, [r IN relationships(p) | ${EDGE("r")}] AS es LIMIT 1000`,
    { id: start.id, asOf, rels: rels ?? [], mem: MEMORY_RELS, hidden: rels ? [] : hiddenFor(typeOf(start)) });

  // Shortest route to each neighbour wins.
  const best = new Map<string, PathRow>();
  for (const r of rows) {
    const m = r.ns.at(-1)!;
    const have = best.get(m.id);
    if (!have || r.es.length < have.es.length) best.set(m.id, r);
  }
  const ranked = [...best.values()].sort((a, b) => a.es.length - b.es.length || String(a.ns.at(-1)!.name).localeCompare(String(b.ns.at(-1)!.name)));
  const col = new Collector();
  col.node(start);
  const items = ranked.slice(0, limit).map((r) => {
    for (const n of r.ns) col.node(n);
    for (const e of r.es) col.edge(e);
    const m = r.ns.at(-1)!;
    const prev = r.ns.at(-2)!;
    const last = r.es.at(-1)!;
    return {
      ...brief(m), hop: r.es.length, rel: last.type, dir: last.from === prev.id ? "out" : "in",
      ...(r.ns.length > 2 ? { via: r.ns.slice(1, -1).map((x) => x.id) } : {}),
    };
  });
  const note = ranked.length > limit ? `Showing ${limit} of ${ranked.length} neighbours; filter with rels or raise limit.` : undefined;
  return col.result(ctx, { id: start.id, depth, direction: dir, neighbors: items, total: ranked.length }, note);
}

export const neighbors = defineTool({
  name: "neighbors",
  description:
    "Expand from one node: the nodes 1 or 2 hops away over current relationships, optionally only some relationship types and one direction (out = this node points at them). Returns {id, type, name, hop, rel, dir, via}. Example: {\"id\":\"system:ig-connector\",\"rels\":[\"DEPENDS_ON\"],\"direction\":\"in\",\"depth\":2}",
  input: {
    id: z.string().min(1),
    rels: z.array(z.enum(REL_TYPES)).optional().describe("Only these relationship types"),
    direction: z.enum(["out", "in", "both"]).optional().describe("Default both"),
    depth: z.number().int().optional().describe("1 (default) or 2"),
    limit: z.number().int().optional().describe("Default 25, max 100"),
    asOf: asOfInput,
  },
  run: runNeighbors,
});

// ---------- history ----------

interface Ev { ms: number; at: string; event: "created" | "changed" | "linked" | "unlinked"; [k: string]: unknown }

function pick(json: string | null | undefined, keys: string[]): Record<string, unknown> {
  try {
    const o = JSON.parse(json ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(keys.map((k) => [k, o[k] ?? null]));
  } catch {
    return {};
  }
}

async function runHistory(args: { id: string }, ctx: ToolContext) {
  const target = await requireNode(ctx, args.id);
  const p = { id: target.id };
  const [[node], versions, closed] = await Promise.all([
    ro<{ createdAt: number | null; kv: Array<[string, unknown]> }>(ctx, `MATCH (n:Entity {id:$id}) RETURN n.createdAt AS createdAt, ${PROPS}`, p),
    ro<{ v: NodeRow; e: EdgeRow; since: number; until: number; changed: string[] | null; props: string | null }>(ctx,
      `MATCH (:Entity {id:$id})-[h:HAD_VERSION]->(v:Version) RETURN ${NODE("v")} AS v, ${EDGE("h")} AS e, v.since AS since, v.until AS until,
       v.changed AS changed, v.props AS props ORDER BY v.until LIMIT 50`, p),
    ro<{ e: EdgeRow; m: NodeRow; reason: string | null }>(ctx,
      `MATCH (:Entity {id:$id})-[r]-(m:Entity) WHERE r.until IS NOT NULL AND type(r) <> 'HAD_VERSION'
       RETURN ${EDGE("r")} AS e, ${NODE("m")} AS m, r.closeReason AS reason ORDER BY r.until DESC LIMIT 50`, p),
  ]);
  const types = [...new Set(closed.map((c) => c.e.type))];
  // The current edges of a relationship that changed show who or what replaced the closed one.
  const successors = types.length ? await ro<{ e: EdgeRow; m: NodeRow }>(ctx,
    `MATCH (:Entity {id:$id})-[r]-(m:Entity) WHERE r.until IS NULL AND type(r) IN $types RETURN ${EDGE("r")} AS e, ${NODE("m")} AS m LIMIT 50`,
    { ...p, types }) : [];

  const col = new Collector();
  col.node(target);
  const events: Ev[] = [];
  const at = (ms: number) => ({ ms, at: toIso(ms) });
  if (typeof node?.createdAt === "number") events.push({ ...at(node.createdAt), event: "created" });
  const current = JSON.stringify(Object.fromEntries(node?.kv ?? []));
  versions.forEach((v, i) => {
    col.node(v.v);
    col.edge(v.e);
    const changed = v.changed ?? [];
    events.push({
      ...at(v.until), event: "changed", changed, before: pick(v.props, changed),
      after: pick(i + 1 < versions.length ? versions[i + 1]!.props : current, changed), version: v.v.id,
    });
  });
  const edgeEvent = (e: EdgeRow, m: NodeRow) => ({ rel: e.type, dir: e.from === target.id ? "out" : "in", other: brief(m) });
  for (const { e, m, reason } of closed) {
    col.node(m);
    col.edge(e);
    if (typeof e.since === "number") events.push({ ...at(e.since), event: "linked", ...edgeEvent(e, m) });
    events.push({ ...at(e.until!), event: "unlinked", ...edgeEvent(e, m), ...(reason ? { reason } : {}) });
  }
  for (const { e, m } of successors) {
    col.node(m);
    col.edge(e);
    if (typeof e.since === "number") events.push({ ...at(e.since), event: "linked", ...edgeEvent(e, m) });
  }
  events.sort((a, b) => a.ms - b.ms);
  const shown = events.slice(-50).map(({ ms: _ms, ...rest }) => rest);
  return col.result(ctx, {
    id: target.id, type: typeOf(target), name: target.name ?? target.id, versions: versions.length, closedRelationships: closed.length,
    events: shown,
  }, events.length > 50 ? `Showing the latest 50 of ${events.length} events.` : events.length <= 1 ? "No recorded changes." : undefined);
}

export const history = defineTool({
  name: "history",
  description:
    "How one node changed over time, oldest first: property changes (status, title… with before/after, from Versions) and relationships that ended (e.g. a reassigned owner) with what replaced them. Use for 'what changed', 'who owned it before', 'when did this close'. Example: {\"id\":\"task:fix-ig-token\"}",
  input: { id: z.string().min(1) },
  run: runHistory,
});

