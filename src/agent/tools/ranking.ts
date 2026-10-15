// Whole-graph views: important (PageRank over a label and/or relationship type; a stored `rank` prop wins when the
// librarian has ranked most of that label) and topics (label-propagation communities over MENTIONS/LINKS_TO, or the
// stored `community` prop), each community named by its best-connected members.
import { z } from "zod";
import type { ToolContext } from "../tool.js";
import { ENTITY_TYPES, REL_TYPES, isEntityType, isRelType, type EntityType, type RelType } from "../../graph/schema.js";
import { communities, pageRank } from "../../graph/algorithms.js";
import {
  Collector, EDGE, InputError, NODE, SEARCH_TYPES, bounded, brief, clamp, defineTool, getNodes, ro, round, typeOf, type EdgeRow,
  type NodeRow,
} from "./common.js";

// ---------- important ----------

async function runImportant(args: { label?: EntityType; rel?: RelType; limit?: number }, ctx: ToolContext) {
  const limit = clamp(args.limit, 10, 1, 25);
  const label = args.label ?? "Entity";
  if (label !== "Entity" && !isEntityType(label)) throw new InputError(`Unknown label ${JSON.stringify(label)}.`); // it is interpolated below
  if (args.rel && !isRelType(args.rel)) throw new InputError(`Unknown relationship ${JSON.stringify(args.rel)}.`);
  const types = label === "Entity" ? SEARCH_TYPES : [label];
  let method: "stored" | "pagerank" = "pagerank";
  let ranked: Array<{ n: NodeRow; score: number }> = [];
  if (!args.rel) {
    const [cov] = await ro<{ total: number; ranked: number }>(ctx,
      `MATCH (n:${label}) WHERE any(l IN labels(n) WHERE l IN $types) RETURN count(n) AS total, count(n.rank) AS ranked`, { types });
    if (cov && cov.ranked > 0 && cov.ranked * 2 >= cov.total) {
      method = "stored";
      ranked = await ro<{ n: NodeRow; score: number }>(ctx,
        `MATCH (n:${label}) WHERE n.rank IS NOT NULL AND any(l IN labels(n) WHERE l IN $types)
         RETURN ${NODE("n")} AS n, n.rank AS score ORDER BY score DESC, n.id LIMIT $k`, { types, k: limit });
    }
  }
  if (method === "pagerank") {
    const scores = (await pageRank(bounded(ctx.graph), label, args.rel)).slice(0, 300);
    const nodes = await getNodes(ctx, scores.map((s) => s.id));
    ranked = scores.map((s) => ({ n: nodes.get(s.id)!, score: s.score }))
      .filter((r) => r.n && types.includes(typeOf(r.n) as EntityType)).slice(0, limit);
  }
  const col = new Collector();
  const items = ranked.map((r) => {
    col.node(r.n);
    return { ...brief(r.n), score: round(r.score, 4) };
  });
  const idList = items.map((i) => i.id);
  if (idList.length > 1) {
    const links = await ro<{ e: EdgeRow }>(ctx,
      `MATCH (a:Entity)-[r]->(b:Entity) WHERE a.id IN $ids AND b.id IN $ids AND r.until IS NULL ${args.rel ? "AND type(r) = $rel" : ""}
       RETURN ${EDGE("r")} AS e LIMIT 100`, { ids: idList, rel: args.rel ?? null });
    for (const l of links) col.edge(l.e);
  }
  return col.result(ctx, { label, rel: args.rel ?? null, method, items }, items.length ? undefined : "Nothing to rank for that label/relationship.");
}

export const important = defineTool({
  name: "important",
  description:
    "The most central nodes by PageRank over current relationships, optionally only one label (e.g. Page, Task, Content) and/or one relationship type (e.g. LINKS_TO, DEPENDS_ON). Use for 'what matters most', 'key pages', 'core systems'. Example: {\"label\":\"System\",\"rel\":\"DEPENDS_ON\",\"limit\":5}",
  input: {
    label: z.enum(ENTITY_TYPES).optional().describe("Node type to rank; default all business entities"),
    rel: z.enum(REL_TYPES).optional().describe("Only this relationship type"),
    limit: z.number().int().optional().describe("Default 10, max 25"),
  },
  run: runImportant,
});

// ---------- topics ----------

const TOPIC_RELS: RelType[] = ["MENTIONS", "LINKS_TO"];

const MEMBER_SAMPLE = 2_000; // members whose degree is read, spread over the biggest communities

async function runTopics(args: { limit?: number }, ctx: ToolContext) {
  const limit = clamp(args.limit, 8, 1, 20);
  // Stored communities are grouped on the server (a big tenant has more members than one result holds): their sizes
  // are exact, and each brings a sample of members whose degree names it.
  const stored = await ro<{ c: string | number; size: number; ids: string[] }>(ctx,
    `MATCH (n:Entity) WHERE n.community IS NOT NULL WITH n.community AS c, collect(n.id) AS ids
     RETURN c, size(ids) AS size, ids[0..$per] AS ids ORDER BY size DESC LIMIT $groups`,
    { per: Math.ceil(MEMBER_SAMPLE / (limit * 2)), groups: limit * 2 });
  const method = stored.length >= 2 ? "stored" : "label_propagation";
  let groups: Array<{ cid: string | number; size: number; ids: string[] }>;
  if (method === "stored") groups = stored.map((s) => ({ cid: s.c, size: s.size, ids: s.ids }));
  else {
    const byId = new Map<string | number, string[]>();
    for (const r of await communities(bounded(ctx.graph), [], TOPIC_RELS)) byId.set(r.communityId, [...(byId.get(r.communityId) ?? []), r.id]);
    groups = [...byId.entries()].map(([cid, ids]) => ({ cid, size: ids.length, ids })).sort((a, b) => b.size - a.size).slice(0, limit * 2);
  }
  const multi = groups.filter((x) => x.size >= 2);
  const per = Math.ceil(MEMBER_SAMPLE / Math.max(1, multi.length));
  const memberIds = multi.flatMap((x) => x.ids.slice(0, per));
  const degrees = memberIds.length ? await ro<{ n: NodeRow; deg: number }>(ctx,
    `UNWIND $ids AS id MATCH (n:Entity {id:id}) OPTIONAL MATCH (n)-[r:MENTIONS|LINKS_TO]-() WHERE r.until IS NULL
     RETURN ${NODE("n")} AS n, count(r) AS deg`, { ids: memberIds }) : [];
  const info = new Map(degrees.map((d) => [d.n.id, d]));

  const col = new Collector();
  const shown: string[] = [];
  const out = multi.map(({ cid, size, ids }) => {
    const members = ids.map((id) => info.get(id)).filter((d): d is { n: NodeRow; deg: number } => !!d && typeOf(d.n) !== "Chunk")
      .sort((a, b) => b.deg - a.deg || String(a.n.name).localeCompare(String(b.n.name)));
    const named = [...members.filter((m) => typeOf(m.n) !== "Document"), ...members.filter((m) => typeOf(m.n) === "Document")];
    return { cid, size, members, label: named.slice(0, 3).map((m) => m.n.name ?? m.n.id).join(", ") };
  }).filter((c) => c.members.length).sort((a, b) => b.size - a.size || a.label.localeCompare(b.label)).slice(0, limit).map((c, i) => {
    const top = c.members.slice(0, 6);
    for (const m of top) {
      col.node(m.n);
      shown.push(m.n.id);
    }
    return { topic: i + 1, label: c.label, size: c.size, members: top.map((m) => ({ ...brief(m.n), links: m.deg })) };
  });
  if (shown.length > 1) {
    const links = await ro<{ e: EdgeRow }>(ctx,
      `MATCH (a:Entity)-[r:MENTIONS|LINKS_TO]->(b:Entity) WHERE a.id IN $ids AND b.id IN $ids AND r.until IS NULL RETURN ${EDGE("r")} AS e LIMIT 200`,
      { ids: shown });
    for (const l of links) col.edge(l.e);
  }
  return col.result(ctx, { method, topics: out }, out.length ? undefined : "No topic clusters yet (documents need MENTIONS or LINKS_TO).");
}

export const topics = defineTool({
  name: "topics",
  description:
    "The main themes in the company's knowledge: clusters of documents and the things they mention or link (community detection), each labelled by its best-connected members, biggest first. Use for 'what do we mostly talk about', 'what areas exist'. Example: {\"limit\":5}",
  input: { limit: z.number().int().optional().describe("Topics to return, default 8, max 20") },
  run: runTopics,
});
