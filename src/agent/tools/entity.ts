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

const GROUP_CAP = 10;    // items listed per relationship group (the count is always complete)
const ITEM_CAP = 80;     // neighbour items over all groups
const METRIC_CAP = 10;
const NEIGHBOR_CAP = 60;  // neighbours listed (each may bring a via node at depth 2)
const asOfInput = z.string().optional().describe("ISO date: see the graph as it was then, e.g. 2026-10-01");

// Neighbour types hidden by default (counted instead). An entity of a bookkeeping type still sees its own kind.
function hiddenFor(type: string): string[] {
  return BOOKKEEPING_TYPES.includes(type as never) ? ["Version"].filter((t) => t !== type) : BOOKKEEPING_TYPES;
}

const PROPS = "[k IN keys(n) WHERE NOT k IN ['embedding', 'textEmbedding'] | [k, n[k]]] AS kv";

// ---------- get_entity ----------

interface ObsRow { o: NodeRow; e: EdgeRow; metric: string; value: number; unit: string | null; ws: string | null; we: string | null; at: string | null }
interface GroupRow { dir: "in" | "out"; rel: string; c: number; items: Array<{ e: EdgeRow; m: NodeRow }> }

async function runGetEntity(args: { id: string; asOf?: string }, ctx: ToolContext) {
  const asOf = parseAsOf(args.asOf);
  const target = await requireNode(ctx, args.id);
  const type = typeOf(target);
  const p = { id: target.id, asOf, hidden: hiddenFor(type), asOfDate: asOf === undefined ? null : toIso(asOf) };
  // Grouped on the server: a hub with thousands of MENTIONS must not crowd OWNS out of a row limit, and counts are
  // complete. Observations: the newest per metric, chosen per metric (one dense daily series cannot hide the rest).
  const [[node], groups, hiddenRows, [vc], obs, [ver]] = await Promise.all([
    ro<{ kv: Array<[string, unknown]> }>(ctx, `MATCH (n:Entity {id:$id}) RETURN ${PROPS}`, p),
    ro<GroupRow>(ctx,
      `MATCH (n:Entity {id:$id})-[r]-(m:Entity) WHERE ${edgeAt("r", asOf)} AND type(r) <> 'HAD_VERSION'
       AND NOT any(l IN labels(m) WHERE l IN $hidden)
       WITH CASE WHEN startNode(r).id = $id THEN 'out' ELSE 'in' END AS dir, type(r) AS rel, r, m ORDER BY m.name, m.id
       WITH dir, rel, count(*) AS c, collect({e: ${EDGE("r")}, m: ${NODE("m")}})[0..$cap] AS items ORDER BY rel, dir LIMIT 100
       RETURN dir, rel, c, items`, { ...p, cap: GROUP_CAP }),
    ro<{ type: string; c: number }>(ctx,
      `MATCH (n:Entity {id:$id})-[r]-(m:Entity) WHERE ${edgeAt("r", asOf)} AND any(l IN labels(m) WHERE l IN $hidden)
       RETURN [l IN labels(m) WHERE NOT l IN ['Entity', 'Searchable']][0] AS type, count(DISTINCT m) AS c`, p),
    ro<{ c: number }>(ctx, "MATCH (:Entity {id:$id})-[e:HAD_VERSION]->(v) WHERE ID(e) >= 0 RETURN count(v) AS c", p),
    ro<ObsRow>(ctx,
      `MATCH (o:Observation {subject: $id})-[r:MEASURES]->(:Entity {id:$id}) WHERE ID(r) >= 0 WITH o, r, coalesce(o.windowEnd, o.asOf) AS at
       WHERE $asOfDate IS NULL OR at <= $asOfDate
       WITH o.metricKey AS key, collect({o: ${NODE("o")}, e: ${EDGE("r")}, metric: o.metric, value: o.value, unit: o.unit,
         ws: o.windowStart, we: o.windowEnd, at: at}) AS all
       WITH key, reduce(b = null, x IN all | CASE WHEN b IS NULL OR x.at > b.at OR (x.at = b.at AND x.o.id > b.o.id) THEN x ELSE b END) AS x
       RETURN x.o AS o, x.e AS e, x.metric AS metric, x.value AS value, x.unit AS unit, x.ws AS ws, x.we AS we, x.at AS at
       ORDER BY at DESC, metric, o.id LIMIT $metrics`, { ...p, metrics: METRIC_CAP }),
    asOf === undefined ? Promise.resolve([]) : ro<{ id: string; props: string }>(ctx,
      "MATCH (:Entity {id:$id})-[:HAD_VERSION]->(v:Version) WHERE v.since <= $asOf AND v.until > $asOf RETURN v.id AS id, v.props AS props ORDER BY v.until, v.id LIMIT 1", p),
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
  let listed = 0;
  for (const grp of groups) {
    const items = grp.items.slice(0, Math.max(0, ITEM_CAP - listed));
    listed += items.length;
    neighbors[`${grp.dir}:${grp.rel}`] = { count: grp.c, items: items.map(({ m }) => brief(m)) };
    for (const { e, m } of items) {
      col.node(m);
      col.edge(e);
    }
  }

  const observations = obs.map((o) => {
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
    "Everything about one node by id: its properties, current neighbours grouped by relationship (in:/out:, full count, first 10 listed), how many past versions it has, and its latest numbers (one per metric). Pass asOf to see relationships and properties as they were on a date. Example: {\"id\":\"task:fix-ig-token\",\"asOf\":\"2026-10-01\"}",
  input: { id: z.string().min(1).describe("Entity id, e.g. decision:007-pause-daily-stories"), asOf: asOfInput },
  run: runGetEntity,
});

// ---------- neighbors ----------

interface PathRow { ns: NodeRow[]; es: EdgeRow[] }

async function runNeighbors(args: { id: string; rels?: string[]; direction?: "out" | "in" | "both"; depth?: number; limit?: number; asOf?: string }, ctx: ToolContext) {
  const asOf = parseAsOf(args.asOf);
  const depth = clamp(args.depth, 1, 1, 2);
  const limit = clamp(args.limit, DEFAULT_ROWS, 1, NEIGHBOR_CAP);
  const start = await requireNode(ctx, args.id);
  const rels = args.rels?.length ? args.rels : null;
  const dir = args.direction ?? "both";
  const pat = dir === "out" ? `-[*1..${depth}]->` : dir === "in" ? `<-[*1..${depth}]-` : `-[*1..${depth}]-`;
  // On the server: the shortest route to each neighbour, neighbours by hop then name, and the exact total. One row
  // comes back, however many neighbours a hub has.
  const [res] = await ro<{ total: number; items: PathRow[] }>(ctx,
    `MATCH (n:Entity {id:$id}) WITH n
     MATCH p = (n)${pat}(m:Entity)
     WHERE m.id <> $id AND ALL(r IN relationships(p) WHERE ${edgeAt("r", asOf)} AND ${rels ? "type(r) IN $rels" : "NOT type(r) IN $mem"})
       AND NONE(x IN nodes(p) WHERE any(l IN labels(x) WHERE l IN $hidden))
     WITH m, collect(p) AS ps
     WITH m, reduce(b = head(ps), x IN ps | CASE WHEN length(x) < length(b) THEN x ELSE b END) AS p
     WITH m, p ORDER BY length(p), m.name, m.id
     WITH collect(p) AS ps
     RETURN size(ps) AS total, [p IN ps[0..$limit] | {ns: [x IN nodes(p) | ${NODE("x")}], es: [r IN relationships(p) | ${EDGE("r")}]}] AS items`,
    { id: start.id, asOf, rels: rels ?? [], mem: MEMORY_RELS, hidden: rels ? [] : hiddenFor(typeOf(start)), limit });
  const total = res?.total ?? 0;
  const col = new Collector();
  col.node(start);
  const items = (res?.items ?? []).map((r) => {
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
  const note = total > limit ? `Showing ${limit} of ${total} neighbours (nearest first, then by name); filter with rels or direction.` : undefined;
  return col.result(ctx, { id: start.id, depth, direction: dir, neighbors: items, total }, note);
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
    limit: z.number().int().optional().describe("Default 25, max 60"),
    asOf: asOfInput,
  },
  run: runNeighbors,
});

// ---------- history ----------

interface Ev { ms: number; at: string; event: "created" | "changed" | "linked" | "unlinked"; [k: string]: unknown }
interface Refs { nodes: NodeRow[]; edges: EdgeRow[] }
const EVENT_CAP = 50;

// The changed props of a Version's JSON, shortened like any props (a changed summary can be thousands of characters).
function pick(json: string | null | undefined, keys: string[]): Record<string, unknown> {
  try {
    const o = JSON.parse(json ?? "{}") as Record<string, unknown>;
    const short = compactProps(keys.slice(0, 10).map((k) => [k, o[k]]));
    return Object.fromEntries(keys.slice(0, 10).map((k) => [k, short[k] ?? null]));
  } catch {
    return {};
  }
}

async function runHistory(args: { id: string }, ctx: ToolContext) {
  const target = await requireNode(ctx, args.id);
  const p = { id: target.id };
  // The newest EVENT_CAP versions and closed relationships (oldest first once reversed), with full counts: the events
  // shown are the latest, and each change's `after` is the next version's props, or the current ones for the newest.
  const [[node], newest, closed, [counts]] = await Promise.all([
    ro<{ createdAt: number | null; kv: Array<[string, unknown]> }>(ctx, `MATCH (n:Entity {id:$id}) RETURN n.createdAt AS createdAt, ${PROPS}`, p),
    ro<{ v: NodeRow; e: EdgeRow; since: number; until: number; changed: string[] | null; props: string | null }>(ctx,
      `MATCH (:Entity {id:$id})-[h:HAD_VERSION]->(v:Version) RETURN ${NODE("v")} AS v, ${EDGE("h")} AS e, v.since AS since, v.until AS until,
       v.changed AS changed, v.props AS props ORDER BY until DESC, v.id LIMIT $cap`, { ...p, cap: EVENT_CAP }),
    ro<{ e: EdgeRow; m: NodeRow; reason: string | null }>(ctx,
      `MATCH (:Entity {id:$id})-[r]-(m:Entity) WHERE r.until IS NOT NULL AND type(r) <> 'HAD_VERSION'
       RETURN ${EDGE("r")} AS e, ${NODE("m")} AS m, r.closeReason AS reason ORDER BY r.until DESC, id(r) LIMIT $cap`, { ...p, cap: EVENT_CAP }),
    ro<{ versions: number; closed: number }>(ctx,
      `MATCH (n:Entity {id:$id}) OPTIONAL MATCH (n)-[hv:HAD_VERSION]->(v:Version) WHERE ID(hv) >= 0 WITH n, count(v) AS versions
       OPTIONAL MATCH (n)-[r]-(:Entity) WHERE r.until IS NOT NULL AND type(r) <> 'HAD_VERSION' RETURN versions, count(r) AS closed`, p),
  ]);
  const versions = [...newest].reverse();
  const types = [...new Set(closed.map((c) => c.e.type))];
  // The current edges of a relationship that changed show who or what replaced the closed one.
  const successors = types.length ? await ro<{ e: EdgeRow; m: NodeRow }>(ctx,
    `MATCH (:Entity {id:$id})-[r]-(m:Entity) WHERE r.until IS NULL AND type(r) IN $types
     RETURN ${EDGE("r")} AS e, ${NODE("m")} AS m ORDER BY r.since DESC, id(r) LIMIT $cap`,
    { ...p, types, cap: EVENT_CAP }) : [];

  // Each event keeps the node and edge it is about; only the events shown contribute them to the result.
  const col = new Collector();
  col.node(target);
  const events: Array<Ev & { refs: Refs }> = [];
  const at = (ms: number) => ({ ms, at: toIso(ms) });
  if (typeof node?.createdAt === "number") events.push({ ...at(node.createdAt), event: "created", refs: { nodes: [], edges: [] } });
  const current = JSON.stringify(Object.fromEntries(node?.kv ?? []));
  versions.forEach((v, i) => {
    const changed = v.changed ?? [];
    events.push({
      ...at(v.until), event: "changed", changed, before: pick(v.props, changed),
      after: pick(i + 1 < versions.length ? versions[i + 1]!.props : current, changed), version: v.v.id,
      refs: { nodes: [v.v], edges: [v.e] },
    });
  });
  const edgeEvent = (e: EdgeRow, m: NodeRow) => ({ rel: e.type, dir: e.from === target.id ? "out" : "in", other: brief(m), refs: { nodes: [m], edges: [e] } });
  for (const { e, m, reason } of closed) {
    if (typeof e.since === "number") events.push({ ...at(e.since), event: "linked", ...edgeEvent(e, m) });
    events.push({ ...at(e.until!), event: "unlinked", ...edgeEvent(e, m), ...(reason ? { reason } : {}) });
  }
  for (const { e, m } of successors) {
    if (typeof e.since === "number") events.push({ ...at(e.since), event: "linked", ...edgeEvent(e, m) });
  }
  events.sort((a, b) => a.ms - b.ms);
  const shown = events.slice(-EVENT_CAP).map(({ ms: _ms, refs, ...rest }) => {
    refs.nodes.forEach((n) => col.node(n));
    refs.edges.forEach((e) => col.edge(e));
    return rest;
  });
  return col.result(ctx, {
    id: target.id, type: typeOf(target), name: target.name ?? target.id, versions: counts?.versions ?? versions.length,
    closedRelationships: counts?.closed ?? closed.length,
    events: shown,
  }, events.length > EVENT_CAP ? `Showing the latest ${EVENT_CAP} of ${events.length} events.` : events.length <= 1 ? "No recorded changes." : undefined);
}

export const history = defineTool({
  name: "history",
  description:
    "How one node changed over time, oldest first: property changes (status, title… with before/after, from Versions) and relationships that ended (e.g. a reassigned owner) with what replaced them. Use for 'what changed', 'who owned it before', 'when did this close'. Example: {\"id\":\"task:fix-ig-token\"}",
  input: { id: z.string().min(1) },
  run: runHistory,
});

