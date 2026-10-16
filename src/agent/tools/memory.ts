// Episodic memory, read and write. recall: what earlier threads said about some entities (the last 5 Turns that
// touched or cited them, Memories about them, the owner's standing preferences, open Recommendations evidenced by
// them and their pending Approvals). remember: keep something the owner said as a Memory ABOUT entities, STATED by
// the asker, sourced to this turn.
import { z } from "zod";
import type { ToolContext } from "../tool.js";
import { VECTOR_DIM } from "../../graph/indexes.js";
import { upsertEdge, upsertNode } from "../../graph/upsert.js";
import { DisallowedRelationship } from "../../graph/errors.js";
import { isoDate } from "../../util/time.js";
import {
  Collector, EDGE, InputError, NODE, SEARCH_TYPES, brief, clip, defineTool, ftEntities, ftTerms, getNodes, isoOrNull, nextId,
  refuseIfReadOnly, refuseIfStopped, ro, serial, type EdgeRow, type NodeRow,
} from "./common.js";

// ---------- recall ----------

interface TurnRow { t: NodeRow; question: string | null; answer: string | null; at: number | string | null; agents: string[] | null; session: string | null; hit: string[]; es: EdgeRow[] }
interface MemRow { m: NodeRow; kind: string | null; text: string | null; at: number | string | null; about: string[]; es: EdgeRow[]; by: string[] }
interface RecRow { rec: NodeRow; status: string | null; why: string | null; area: string | null; confidence: number | null; evidence: string[]; es: EdgeRow[] }

const toMs = (v: number | string | null): number => (typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) || 0 : 0);
const TURN_CITED = 12; // entities returned per earlier turn, from what it cited
const NOT_SUPERSEDED = "OPTIONAL MATCH (newer:Memory)-[s:SUPERSEDES]->(m) WHERE s.until IS NULL";

// Earlier questions that mean the same as this text, by vector (the Turn's own embedding, saved with it): "have we been asked
// something like this". Only close ones: the e5 vectors of unrelated questions still sit fairly near each other, so a cap on
// the cosine distance keeps it to the same question in other words. No embedder, or none saved yet: none.
export const SIMILAR_TURN_DISTANCE = 0.12;
const SIMILAR_TURNS = 3;
async function similarTurns(ctx: ToolContext, text: string): Promise<string[]> {
  if (!ctx.embedQuery) return [];
  try {
    const v = await ctx.embedQuery(text);
    if (v.length !== VECTOR_DIM) return [];
    const hits = await ro<{ id: string }>(ctx,
      `CALL db.idx.vector.queryNodes('Searchable', 'embedding', $k, vecf32($v)) YIELD node, score
       WITH node, score WHERE node:Turn AND score <= $cap AND coalesce(node.status, 'ok') = 'ok'
       RETURN node.id AS id ORDER BY score ASC, node.id LIMIT $limit`, { v, k: 100, cap: SIMILAR_TURN_DISTANCE, limit: SIMILAR_TURNS });
    return hits.map((h) => h.id);
  } catch {
    return []; // by meaning is an extra: the words still find earlier turns
  }
}

async function runRecall(args: { ids?: string[]; query?: string }, ctx: ToolContext) {
  const given = [...new Set((args.ids ?? []).map((s) => s.trim()).filter(Boolean))].slice(0, 20);
  if (!given.length && !args.query?.trim()) throw new InputError("Pass the ids you are working with (preferred) or a query.");
  const found = await getNodes(ctx, given);
  const unknown = given.filter((id) => !found.has(id));
  const targets = [...found.values()];
  let queryTurns: string[] = [];
  if (args.query?.trim()) {
    const [ents, turnHits, similar] = await Promise.all([ftEntities(ctx, args.query, SEARCH_TYPES, 5), ftEntities(ctx, args.query, ["Turn"], 5), similarTurns(ctx, args.query)]);
    for (const h of ents) if (!targets.some((t) => t.id === h.n.id)) targets.push(h.n);
    queryTurns = [...new Set([...turnHits.map((h) => h.n.id), ...similar])];
  }
  const ids = targets.map((t) => t.id);
  const turnCols = `${NODE("t")} AS t, t.question AS question, t.answer AS answer, t.at AS at, t.agents AS agents, s.id AS session`;
  const [byEntity, byQuery, memories, prefs, recs, [pending]] = await Promise.all([
    ro<TurnRow>(ctx,
      `MATCH (t:Turn)-[r:TOUCHED|CITED]->(x:Entity) WHERE x.id IN $ids
       WITH t, collect(DISTINCT x.id) AS hit, collect(${EDGE("r")}) AS es
       OPTIONAL MATCH (t)-[:IN_SESSION]->(s:Entity)
       RETURN ${turnCols}, hit, es ORDER BY at DESC, t.id LIMIT 5`, { ids }),
    ro<TurnRow>(ctx,
      `UNWIND $tids AS tid MATCH (t:Entity {id:tid}) OPTIONAL MATCH (t)-[:IN_SESSION]->(s:Entity) RETURN ${turnCols}, [] AS hit, [] AS es`, { tids: queryTurns }),
    ro<MemRow>(ctx,
      `MATCH (m:Memory)-[r:ABOUT]->(x:Entity) WHERE x.id IN $ids AND r.until IS NULL
       WITH m, collect(DISTINCT x.id) AS about, collect(${EDGE("r")}) AS es
       ${NOT_SUPERSEDED} WITH m, about, es, count(newer) AS superseded WHERE superseded = 0
       OPTIONAL MATCH (who:Entity)-[:STATED]->(m)
       WITH m, about, es, collect(DISTINCT who.id) AS by
       RETURN ${NODE("m")} AS m, m.kind AS kind, m.text AS text, m.at AS at, about, es, by ORDER BY at DESC, m.id LIMIT 10`, { ids }),
    ro<MemRow>(ctx,
      `MATCH (m:Memory) WHERE m.kind = 'preference' ${NOT_SUPERSEDED} WITH m, count(newer) AS superseded WHERE superseded = 0
       RETURN ${NODE("m")} AS m, m.kind AS kind, m.text AS text, m.at AS at, [] AS about, [] AS es, [] AS by ORDER BY at DESC, m.id LIMIT 5`),
    ro<RecRow>(ctx,
      `MATCH (rec:Recommendation)-[r:EVIDENCED_BY]->(x:Entity) WHERE x.id IN $ids AND r.until IS NULL
       WITH rec, collect(DISTINCT x.id) AS evidence, collect(${EDGE("r")}) AS es
       RETURN ${NODE("rec")} AS rec, rec.status AS status, rec.summary AS why, rec.area AS area, rec.confidence AS confidence, evidence, es,
       rec.updatedAt AS updatedAt ORDER BY updatedAt DESC, rec.id LIMIT 20`, { ids }),
    ro<{ c: number }>(ctx, "MATCH (a:Approval) WHERE a.status = 'pending' RETURN count(a) AS c"),
  ]);
  const approvals = recs.length ? await ro<{ rid: string; a: NodeRow; e: EdgeRow; status: string | null; kind: string | null }>(ctx,
    `UNWIND $rids AS rid MATCH (rec:Entity {id:rid}) WITH rid, rec MATCH (rec)-[p:PROPOSES]->(a:Approval) RETURN rid, ${NODE("a")} AS a, ${EDGE("p")} AS e, a.status AS status, a.kind AS kind LIMIT 40`,
    { rids: recs.map((r) => r.rec.id) }) : [];

  const col = new Collector();
  for (const t of targets) col.node(t);
  const seen = new Set<string>();
  const picked = [...byEntity, ...byQuery].filter((t) => !seen.has(t.t.id) && seen.add(t.t.id))
    .sort((a, b) => toMs(b.at) - toMs(a.at)).slice(0, 5);
  // What each earlier turn cited (CITED edges exist only for citations verified when it was saved), so an answer that
  // repeats one of them cites a node this call returned, not an id copied from the old answer's text.
  const citedRows = picked.length ? await ro<{ tid: string; cs: Array<{ y: NodeRow; e: EdgeRow }> }>(ctx,
    `UNWIND $tids AS tid MATCH (t:Entity {id:tid})-[c:CITED]->(y:Entity) WHERE c.until IS NULL
     WITH tid, y, c ORDER BY tid, y.id
     WITH tid, collect({y: ${NODE("y")}, e: ${EDGE("c")}})[0..$k] AS cs RETURN tid, cs`, { tids: picked.map((t) => t.t.id), k: TURN_CITED }) : [];
  const citedBy = new Map(citedRows.map((r) => [r.tid, r.cs]));
  const turns = picked.map((t) => {
    col.node(t.t);
    for (const e of t.es) col.edge(e);
    const cs = citedBy.get(t.t.id) ?? [];
    for (const c of cs) { col.node(c.y); col.edge(c.e); }
    return {
      id: t.t.id, question: t.question ?? t.t.name, answer: clip(t.answer, 300) ?? null, at: isoOrNull(t.at),
      ...(t.session ? { session: t.session } : {}), ...(t.agents?.length ? { agents: t.agents } : {}), ...(t.hit.length ? { touched: t.hit } : {}),
      ...(cs.length ? { cited: cs.map((c) => c.y.id) } : {}),
    };
  });
  const mem = (m: MemRow) => {
    col.node(m.m);
    for (const e of m.es) col.edge(e);
    return {
      id: m.m.id, kind: m.kind, text: clip(m.text ?? m.m.name, 300), at: isoOrNull(m.at),
      ...(m.about.length ? { about: m.about } : {}), ...(m.by.length ? { statedBy: m.by } : {}),
    };
  };
  const open = recs.filter((r) => r.status === "open").map((r) => {
    col.node(r.rec);
    for (const e of r.es) col.edge(e);
    const mine = approvals.filter((a) => a.rid === r.rec.id);
    for (const a of mine) {
      col.node(a.a);
      col.edge(a.e);
    }
    return {
      ...brief(r.rec), ...(r.why ? { why: clip(r.why, 300) } : {}), ...(r.area ? { area: r.area } : {}),
      ...(r.confidence !== null ? { confidence: r.confidence } : {}), evidence: r.evidence,
      approvals: mine.map((a) => ({ id: a.a.id, status: a.status, kind: a.kind })),
    };
  });
  const pendingApprovals = approvals.filter((a) => a.status === "pending").map((a) => {
    col.node(a.a);
    col.edge(a.e);
    return { id: a.a.id, name: a.a.name, kind: a.kind, recommendation: a.rid };
  });
  const data = {
    about: targets.map(brief), ...(unknown.length ? { unknown } : {}),
    turns, memories: memories.map(mem), preferences: prefs.map(mem), openRecommendations: open, pendingApprovals,
    pendingApprovalsTotal: pending?.c ?? 0,
  };
  const empty = !turns.length && !memories.length && !open.length && !pendingApprovals.length;
  return col.result(ctx, data, [unknown.length ? `Unknown ids: ${unknown.join(", ")}.` : "", empty ? "Nothing earlier on these." : ""].filter(Boolean).join(" ") || undefined);
}

export const recall = defineTool({
  name: "recall",
  description:
    "What we already know from earlier threads about some entities: the last 5 questions that touched them (with the start of each answer), memories the owner asked to keep, standing preferences, open recommendations and pending approvals. Use before answering about something discussed before. Example: {\"ids\":[\"decision:007-pause-daily-stories\"]}",
  input: {
    ids: z.array(z.string()).optional().describe("Entity ids you are working with"),
    query: z.string().optional().describe("Words, when you have no ids yet"),
  },
  run: runRecall,
});

// ---------- remember ----------

// Memory words that carry its subject: lowercase, no filler, a rough stem ("stories" and "story" are one thing).
const subjectWords = (text: string): Set<string> => new Set(ftTerms(text, 30).map((w) => (w.length > 4 ? w.replace(/(?:ies|es|s|ing|ed)$/u, "") : w)));

// Does a new note say something different about the same thing as an old one? The same subject is two or more shared words that
// are at least half of the shorter note ("Stories stay paused until Diwali" / "Stories resume after Diwali"); the same words
// again, or two notes about different things on one entity ("no emojis" / "prices in rupees"), are not a change.
export function changesTheSame(newText: string, oldText: string): boolean {
  const flat = (t: string): string => t.toLowerCase().replace(/\s+/g, " ").trim();
  if (flat(newText) === flat(oldText)) return false;
  const a = subjectWords(newText), b = subjectWords(oldText);
  const shared = [...a].filter((w) => b.has(w)).length;
  return shared >= 2 && shared * 2 >= Math.min(a.size, b.size);
}

// Active notes of the same kind about any of these entities (none already replaced by a newer one) that the new text changes.
async function sameSubjectNotes(ctx: ToolContext, n: { kind: string; text: string; about: string[] }): Promise<Array<{ id: string; text: string }>> {
  const rows = await ro<{ id: string; text: string | null }>(ctx,
    `MATCH (x:Entity) WHERE x.id IN $about WITH x MATCH (m:Memory)-[r:ABOUT]->(x) WHERE r.until IS NULL AND m.kind = $kind AND coalesce(m.status, 'active') <> 'retired'
     WITH DISTINCT m ${NOT_SUPERSEDED} WITH m, count(newer) AS superseded WHERE superseded = 0
     RETURN m.id AS id, coalesce(m.text, m.summary, m.name) AS text ORDER BY id LIMIT 30`, { about: n.about, kind: n.kind });
  return rows.filter((r) => r.text && changesTheSame(n.text, r.text)).map((r) => ({ id: r.id, text: r.text! }));
}

async function runRemember(args: { text: string; kind: "preference" | "fact" | "instruction"; about: string[] }, ctx: ToolContext) {
  refuseIfReadOnly(ctx, "remember");
  const text = args.text.trim();
  if (!text) throw new InputError("text is empty.");
  const about = [...new Set(args.about.map((s) => s.trim()).filter(Boolean))].slice(0, 10);
  const found = await getNodes(ctx, about);
  const linked = about.filter((id) => found.has(id));
  const skipped = about.filter((id) => !found.has(id));
  if (!linked.length) throw new InputError(`None of the about ids exist (${about.join(", ") || "none given"}). Pass ids returned by a tool, e.g. the business or a channel.`);
  const embedding = ctx.embedQuery ? await ctx.embedQuery(text).catch(() => undefined) : undefined;
  const src = ctx.turnId; // already `turn:<date>-<id>`
  const asOf = isoDate(ctx.now);

  const { id, stated, replaced } = await serial(ctx.graph.name, async () => {
    refuseIfStopped(ctx, "remember");
    const id = await nextId(ctx, `memory:${ctx.turnId}-`);
    // What this replaces, found before the new note exists: an active note of the same kind about the same thing.
    const earlier = await sameSubjectNotes(ctx, { kind: args.kind, text, about: linked });
    await upsertNode(ctx.graph, {
      type: "Memory", id, name: clip(text, 80)!, summary: clip(text, 400), props: { kind: args.kind, text: text.slice(0, 2000), at: ctx.now },
      src, asOf, ...(embedding?.length === VECTOR_DIM ? { embedding } : {}),
    }, ctx.now);
    for (const to of linked) await upsertEdge(ctx.graph, { from: id, type: "ABOUT", to, src, asOf }, ctx.now);
    // A changed preference or fact does not leave two active: the new note SUPERSEDES the old (recall and the brief skip it from now on).
    const replaced: string[] = [];
    for (const old of earlier) {
      try {
        await upsertEdge(ctx.graph, { from: id, type: "SUPERSEDES", to: old.id, src, asOf }, ctx.now);
        replaced.push(old.id);
      } catch (e) {
        if (!(e instanceof DisallowedRelationship) && !/missing endpoint/i.test(String((e as Error).message))) throw e;
      }
    }
    let stated = false;
    try {
      await upsertEdge(ctx.graph, { from: ctx.asker, type: "STATED", to: id, src, asOf }, ctx.now);
      stated = true;
    } catch (e) {
      if (!(e instanceof DisallowedRelationship) && !/missing endpoint/i.test(String((e as Error).message))) throw e;
    }
    return { id, stated, replaced };
  });

  const nodes = await getNodes(ctx, [id, ...linked, ...replaced, ...(stated ? [ctx.asker] : [])]);
  const col = new Collector();
  for (const n of [id, ...linked, ...replaced, ...(stated ? [ctx.asker] : [])]) col.node(nodes.get(n));
  for (const to of linked) col.edge({ from: id, type: "ABOUT", to, since: ctx.now, until: null });
  for (const to of replaced) col.edge({ from: id, type: "SUPERSEDES", to, since: ctx.now, until: null });
  if (stated) col.edge({ from: ctx.asker, type: "STATED", to: id, since: ctx.now, until: null });
  return col.result(ctx, {
    id, kind: args.kind, text: clip(text, 300), about: linked, ...(skipped.length ? { skipped } : {}), statedBy: stated ? ctx.asker : null,
    ...(replaced.length ? { replaces: replaced } : {}),
  }, `Saved ${id}.${replaced.length ? ` It replaces the earlier note${replaced.length === 1 ? "" : "s"} ${replaced.join(", ")}.` : ""}${skipped.length ? ` Unknown ids skipped: ${skipped.join(", ")}.` : ""}`);
}

export const remember = defineTool({
  name: "remember",
  description:
    "Save something the owner said to keep (a preference, a fact, or a standing instruction) as a Memory linked to the entities it is about, so later threads recall it. Only when the owner asks you to remember or states a lasting preference. Example: {\"text\":\"Stories stay paused until Diwali\",\"kind\":\"fact\",\"about\":[\"decision:007-pause-daily-stories\"]}",
  input: {
    text: z.string().min(1).describe("What to keep, in the owner's words"),
    kind: z.enum(["preference", "fact", "instruction"]),
    about: z.array(z.string()).describe("Ids of the entities it is about (at least one must exist)"),
  },
  writes: true,
  run: runRemember,
});
