// People questions: who_owns (current OWNS into a thing, earlier owners, owners inherited through PART_OF, team
// members, and what an owner owns) and who_knows (ranked by KNOWS_ABOUT weight, documents they authored that mention
// the topic, and ownership).
import { z } from "zod";
import type { ToolContext } from "../tool.js";
import type { EntityType } from "../../graph/schema.js";
import { toIso } from "../../util/time.js";
import {
  Collector, EDGE, InputError, NODE, SEARCH_TYPES, brief, clamp, defineTool, edgeAt, ftEntities, parseAsOf, requireNode,
  resolveTarget, ro, round, typeOf, type Brief, type EdgeRow, type NodeRow,
} from "./common.js";

const OWNER_TYPES = ["Person", "Agent", "Team", "Business"];
const ACTOR_TYPES = ["Person", "Agent", "Team"];
const iso = (ms: number | null) => (typeof ms === "number" ? toIso(ms).slice(0, 10) : null);

// ---------- who_owns ----------

interface Row { e: EdgeRow; n: NodeRow }

async function runWhoOwns(args: { id?: string; query?: string; asOf?: string }, ctx: ToolContext) {
  const asOf = parseAsOf(args.asOf);
  const { node, alternatives } = await resolveTarget(ctx, args);
  const type = typeOf(node);
  const p = { id: node.id, asOf };
  const [owners, previous, owns, inherited] = await Promise.all([
    ro<Row>(ctx, `MATCH (o:Entity)-[r:OWNS]->(:Entity {id:$id}) WHERE ${edgeAt("r", asOf)} RETURN ${EDGE("r")} AS e, ${NODE("o")} AS n ORDER BY r.since, id(r) LIMIT 10`, p),
    ro<Row>(ctx, `MATCH (o:Entity)-[r:OWNS]->(:Entity {id:$id}) WHERE r.until IS NOT NULL${asOf === undefined ? "" : " AND r.until <= $asOf"}
      RETURN ${EDGE("r")} AS e, ${NODE("o")} AS n ORDER BY r.until DESC, id(r) LIMIT 5`, p),
    OWNER_TYPES.includes(type)
      ? ro<Row & { status: string | null }>(ctx, `MATCH (:Entity {id:$id})-[r:OWNS]->(x:Entity) WHERE ${edgeAt("r", asOf)}
          RETURN ${EDGE("r")} AS e, ${NODE("x")} AS n, x.status AS status ORDER BY x.name, x.id LIMIT 26`, p)
      : Promise.resolve([]),
    ro<{ n: NodeRow; via: NodeRow; es: EdgeRow[] }>(ctx,
      `MATCH (s:Entity {id:$id}) WITH s
       MATCH p = (s)-[:PART_OF*1..3]->(parent:Entity)<-[:OWNS]-(o:Entity) WHERE ALL(x IN relationships(p) WHERE ${edgeAt("x", asOf)})
       RETURN ${NODE("o")} AS n, ${NODE("parent")} AS via, [x IN relationships(p) | ${EDGE("x")}] AS es ORDER BY length(p), parent.id, o.id LIMIT 5`, p),
  ]);

  const col = new Collector();
  col.node(node);
  const take = (r: Row) => {
    col.node(r.n);
    col.edge(r.e);
    return brief(r.n);
  };
  const current = owners.map((r) => ({ ...take(r), since: iso(r.e.since) }));
  const before = previous.map((r) => ({ ...take(r), from: iso(r.e.since), until: iso(r.e.until) }));
  const owned = owns.slice(0, 25).map((r) => ({ ...take(r), ...(r.status ? { status: r.status } : {}) }));
  const via = current.length ? [] : inherited.map((r) => {
    for (const e of r.es) col.edge(e);
    col.node(r.via);
    col.node(r.n);
    return { ...brief(r.n), via: brief(r.via) };
  });
  const teams = [...current, ...via].filter((o) => o.type === "Team").map((o) => o.id);
  const members: Record<string, Brief[]> = {};
  if (teams.length) {
    const rows = await ro<{ t: string; ms: Row[] }>(ctx,
      `UNWIND $teams AS t MATCH (team:Entity {id:t}) WITH t, team MATCH (m:Entity)-[r:MEMBER_OF]->(team) WHERE r.until IS NULL
       WITH t, m, r ORDER BY m.name, m.id WITH t, collect({e: ${EDGE("r")}, n: ${NODE("m")}})[0..10] AS ms RETURN t, ms`, { teams });
    for (const r of rows) members[r.t] = r.ms.map(take);
  }
  const note = current.length || via.length ? undefined
    : `No ${asOf === undefined ? "current owner" : `owner as of ${args.asOf}`} is recorded for ${node.id}.`;
  return col.result(ctx, {
    entity: brief(node), owners: current, previousOwners: before,
    ...(via.length ? { ownedVia: via } : {}), ...(Object.keys(members).length ? { teamMembers: members } : {}),
    ...(owned.length ? { owns: owned, ownsTotal: owns.length > 25 ? "25+" : owns.length } : {}),
    ...(alternatives.length ? { alternatives } : {}),
  }, note);
}

export const whoOwns = defineTool({
  name: "who_owns",
  description:
    "Who owns a task, system, channel, page… now (plus earlier owners, owners inherited via PART_OF, and team members). For a person, team or business it also lists what they own. asOf answers 'who owned it then'. Example: {\"id\":\"task:fix-ig-token\"} or {\"query\":\"instagram connector\"}",
  input: {
    id: z.string().optional(),
    query: z.string().optional().describe("Words to find the entity when you lack its id"),
    asOf: z.string().optional().describe("ISO date"),
  },
  run: runWhoOwns,
});

// ---------- who_knows ----------

interface Score { n: NodeRow; weight: number; docs: Map<string, { d: NodeRow; es: EdgeRow[] }>; documents: number; owns: boolean; score: number }
const DOCS_COUNTED = 5; // authored documents that add to the score
const DOCS_SHOWN = 3;   // listed (and returned as nodes) per person

async function runWhoKnows(args: { id?: string; query?: string; limit?: number }, ctx: ToolContext) {
  const limit = clamp(args.limit, 10, 1, 25);
  let topics: NodeRow[];
  if (args.id?.trim()) topics = [await requireNode(ctx, args.id.trim())];
  else if (args.query?.trim()) {
    const types = SEARCH_TYPES.filter((t: EntityType) => !ACTOR_TYPES.includes(t));
    topics = (await ftEntities(ctx, args.query, types, 3)).map((h) => h.n);
    if (!topics.length) throw new InputError(`No topic matches ${JSON.stringify(args.query)}. Try search first.`);
  } else throw new InputError("Pass a topic id (preferred) or a query.");
  const tids = topics.map((t) => t.id);
  const p = { tids, actors: ACTOR_TYPES, per: DOCS_COUNTED };
  const actor = "any(l IN labels(a) WHERE l IN $actors)";
  // Per (topic, author) on the server: a topic mentioned in thousands of documents must not push anyone out of a
  // 10,000-row result. Each author brings the count and their newest DOCS_COUNTED documents with the edges.
  const authoredBranch = (match: string, es: string, current = "au.until IS NULL") =>
    `UNWIND $tids AS tid MATCH (topic:Entity {id:tid}) WITH tid, topic MATCH ${match} WHERE ${actor} AND ${current}
     WITH DISTINCT tid, a, d, ${es} AS es ORDER BY d.asOf DESC, d.id
     WITH tid, a, count(d) AS docs, collect({d: ${NODE("d")}, es: es})[0..$per] AS top
     RETURN tid AS t, ${NODE("a")} AS n, docs, top ORDER BY docs DESC, n.id LIMIT 100`;
  const [knows, authored, owners] = await Promise.all([
    ro<Row & { t: string; w: number | null }>(ctx,
      `UNWIND $tids AS tid MATCH (topic:Entity {id:tid}) WITH tid, topic MATCH (a:Entity)-[r:KNOWS_ABOUT]->(topic) WHERE r.until IS NULL AND ${actor}
       RETURN tid AS t, ${EDGE("r")} AS e, ${NODE("a")} AS n, r.weight AS w ORDER BY coalesce(r.weight, 1) DESC, a.id LIMIT 300`, p),
    ro<{ t: string; n: NodeRow; docs: number; top: Array<{ d: NodeRow; es: EdgeRow[] }> }>(ctx,
      `${authoredBranch("(a:Entity)-[au:AUTHORED]->(d:Document)-[m:MENTIONS]->(topic)", `[${EDGE("au")}, ${EDGE("m")}]`, "au.until IS NULL AND m.until IS NULL")}
       UNION ALL
       ${authoredBranch("(a:Entity)-[au:AUTHORED]->(d:Document)-[:HAS_CHUNK]->(:Chunk)-[m:MENTIONS]->(topic)", `[${EDGE("au")}]`, "au.until IS NULL AND m.until IS NULL")}
       UNION ALL
       ${authoredBranch("(a:Entity)-[au:AUTHORED]->(topic) WITH tid, a, au, topic AS d", `[${EDGE("au")}]`)}`, p),
    ro<Row & { t: string }>(ctx,
      `UNWIND $tids AS tid MATCH (topic:Entity {id:tid}) WITH tid, topic MATCH (a:Entity)-[r:OWNS]->(topic) WHERE r.until IS NULL AND ${actor}
       RETURN tid AS t, ${EDGE("r")} AS e, ${NODE("a")} AS n ORDER BY a.id LIMIT 100`, p),
  ]);

  // A query's best-matching topic counts fully, the next ones less (1, 1/2, 1/3).
  const factor = new Map(tids.map((t, i) => [t, 1 / (i + 1)]));
  const people = new Map<string, Score>();
  const col = new Collector();
  for (const t of topics) col.node(t);
  const entry = (n: NodeRow) => {
    const s = people.get(n.id) ?? { n, weight: 0, docs: new Map(), documents: 0, owns: false, score: 0 };
    people.set(n.id, s);
    return s;
  };
  const edges = new Map<string, EdgeRow[]>();
  const keep = (id: string, es: EdgeRow[]) => edges.set(id, [...(edges.get(id) ?? []), ...es]);
  for (const r of knows) {
    const s = entry(r.n);
    const w = typeof r.w === "number" ? r.w : 1;
    s.weight += w;
    s.score += w * factor.get(r.t)!;
    keep(r.n.id, [r.e]);
  }
  // Up to DOCS_COUNTED documents count toward the score, each once, at the factor of the topic it was found for.
  for (const r of authored) {
    const s = entry(r.n);
    s.documents = Math.max(s.documents, r.docs);
    for (const { d, es } of r.top) {
      if (s.docs.has(d.id)) continue;
      if (s.docs.size < DOCS_COUNTED) s.score += factor.get(r.t)!;
      s.docs.set(d.id, { d, es });
    }
  }
  for (const r of owners) {
    const s = entry(r.n);
    if (!s.owns) s.score += factor.get(r.t)!;
    s.owns = true;
    keep(r.n.id, [r.e]);
  }
  const ranked = [...people.values()].sort((a, b) => b.score - a.score || String(a.n.name).localeCompare(String(b.n.name))).slice(0, limit);
  const out = ranked.map((s) => {
    col.node(s.n);
    for (const e of edges.get(s.n.id) ?? []) col.edge(e);
    const docs = [...s.docs.values()].sort((a, b) => a.d.id.localeCompare(b.d.id)).slice(0, DOCS_SHOWN);
    for (const { d, es } of docs) {
      col.node(d);
      es.forEach((e) => col.edge(e));
    }
    return {
      ...brief(s.n), score: round(s.score), knowsWeight: s.weight, docs: docs.map((x) => x.d.id),
      ...(s.documents > docs.length ? { documents: s.documents } : {}), owns: s.owns,
    };
  });
  return col.result(ctx, { topics: topics.map(brief), people: out }, out.length ? undefined : "Nobody is recorded as knowing about this yet.");
}

export const whoKnows = defineTool({
  name: "who_knows",
  description:
    "Who knows most about a topic (person, agent or team), ranked by KNOWS_ABOUT weight plus documents they wrote that mention it plus ownership. Pass a topic id, or a query (its top 3 matching entities count, best first). Example: {\"id\":\"channel:instagram\",\"limit\":5}",
  input: {
    id: z.string().optional().describe("Topic entity id"),
    query: z.string().optional().describe("Words to find the topic"),
    limit: z.number().int().optional().describe("Default 10, max 25"),
  },
  run: runWhoKnows,
});
