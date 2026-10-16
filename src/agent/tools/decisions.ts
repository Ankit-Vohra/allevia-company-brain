// trace_decision: the "why" tool. A Decision, the evidence it was BASED_ON (with each piece's source documents), who
// DECIDED it, what it AFFECTS, and the SUPERSEDES chain both ways (what it replaced, what replaced it). Given a
// non-decision id, it traces the latest decision that AFFECTS that entity.
import { z } from "zod";
import type { ToolContext } from "../tool.js";
import {
  Collector, EDGE, InputError, NODE, brief, clip, defineTool, resolveTarget, ro, sourceRows, typeOf, type EdgeRow,
  type NodeRow,
} from "./common.js";

const LIST_CAP = 25;  // evidence and affected items listed (the totals are complete)
const CHAIN_CAP = 10;
const SOURCES_SHOWN = 3;

interface EvRow { e: EdgeRow; n: NodeRow; metric: string | null; value: number | null; unit: string | null; ws: string | null; we: string | null; text: string | null }
interface ChainRow { n: NodeRow; status: string | null; decidedAt: string | null; es: EdgeRow[] }

async function runTrace(args: { id?: string; query?: string }, ctx: ToolContext) {
  let { node, alternatives } = await resolveTarget(ctx, args, ["Decision"]);
  let note: string | undefined;
  if (typeOf(node) !== "Decision") {
    const rows = await ro<{ d: NodeRow }>(ctx,
      `MATCH (d:Decision)-[r:AFFECTS]->(:Entity {id:$id}) WHERE r.until IS NULL RETURN ${NODE("d")} AS d, d.decidedAt AS decidedAt ORDER BY decidedAt DESC, d.id LIMIT 5`, { id: node.id });
    if (!rows.length) throw new InputError(`${node.id} is a ${typeOf(node)}, not a Decision, and no decision affects it. Try search with types ["Decision"].`);
    note = `${node.id} is not a Decision; traced ${rows[0]!.d.id}, the latest decision that affects it.`;
    alternatives = rows.slice(1).map((r) => brief(r.d));
    node = rows[0]!.d;
  }
  const p = { id: node.id };
  const cur = "ALL(r IN relationships(p) WHERE r.until IS NULL)";
  const [[dec], evidence, deciders, affects, older, newer] = await Promise.all([
    ro<{ status: string | null; decidedAt: string | null; summary: string | null; evidenceTotal: number; affectsTotal: number }>(ctx,
      `MATCH (d:Entity {id:$id})
       OPTIONAL MATCH (d)-[b:BASED_ON]->(:Entity) WHERE b.until IS NULL WITH d, count(b) AS evidenceTotal
       OPTIONAL MATCH (d)-[a:AFFECTS]->(:Entity) WHERE a.until IS NULL
       WITH d, evidenceTotal, count(a) AS affectsTotal
       RETURN d.status AS status, d.decidedAt AS decidedAt, d.summary AS summary, evidenceTotal, affectsTotal`, p),
    ro<EvRow>(ctx,
      `MATCH (:Entity {id:$id})-[r:BASED_ON]->(ev:Entity) WHERE r.until IS NULL
       RETURN ${EDGE("r")} AS e, ${NODE("ev")} AS n, ev.metric AS metric, ev.value AS value, ev.unit AS unit, ev.windowStart AS ws,
       ev.windowEnd AS we, coalesce(ev.summary, ev.text) AS text ORDER BY ev.id LIMIT $cap`, { ...p, cap: LIST_CAP }),
    ro<{ e: EdgeRow; n: NodeRow; at: string | null }>(ctx,
      `MATCH (a:Entity)-[r:DECIDED]->(:Entity {id:$id}) WHERE r.until IS NULL RETURN ${EDGE("r")} AS e, ${NODE("a")} AS n, r.at AS at LIMIT 10`, p),
    ro<{ e: EdgeRow; n: NodeRow }>(ctx,
      `MATCH (:Entity {id:$id})-[r:AFFECTS]->(x:Entity) WHERE r.until IS NULL RETURN ${EDGE("r")} AS e, ${NODE("x")} AS n ORDER BY x.name, x.id LIMIT $cap`, { ...p, cap: LIST_CAP }),
    ro<ChainRow>(ctx,
      `MATCH p = (:Entity {id:$id})-[:SUPERSEDES*1..6]->(o:Entity) WHERE ${cur}
       RETURN ${NODE("o")} AS n, o.status AS status, o.decidedAt AS decidedAt, [r IN relationships(p) | ${EDGE("r")}] AS es, length(p) AS hops ORDER BY hops, o.id LIMIT $chain`, { ...p, chain: CHAIN_CAP }),
    ro<ChainRow>(ctx,
      `MATCH p = (nw:Entity)-[:SUPERSEDES*1..6]->(:Entity {id:$id}) WHERE ${cur}
       RETURN ${NODE("nw")} AS n, nw.status AS status, nw.decidedAt AS decidedAt, [r IN relationships(p) | ${EDGE("r")}] AS es, length(p) AS hops ORDER BY hops, nw.id LIMIT $chain`, { ...p, chain: CHAIN_CAP }),
  ]);

  const col = new Collector();
  col.node(node);
  const evSources = new Map<string, string[]>();
  for (const s of await sourceRows(ctx, evidence.map((e) => e.n.id))) {
    const list = evSources.get(s.of) ?? [];
    if (!list.includes(s.id)) evSources.set(s.of, [...list, s.id]);
  }
  const ev = evidence.map((r) => {
    col.node(r.n);
    col.edge(r.e);
    return {
      ...brief(r.n),
      ...(r.metric !== null && r.value !== null ? { metric: r.metric, value: r.value, ...(r.unit ? { unit: r.unit } : {}), window: r.ws ? `${r.ws}..${r.we}` : r.we } : {}),
      ...(r.n.simulated ? { simulated: true } : {}),
      ...(r.text ? { text: clip(r.text, 300) } : {}),
      sources: (evSources.get(r.n.id) ?? []).slice(0, SOURCES_SHOWN),
    };
  });
  const people = deciders.map((r) => {
    col.node(r.n);
    col.edge(r.e);
    return { ...brief(r.n), ...(r.at ? { at: r.at } : {}) };
  });
  const hit = affects.map((r) => {
    col.node(r.n);
    col.edge(r.e);
    return brief(r.n);
  });
  const chain = (rows: ChainRow[]) => rows.map((r) => {
    col.node(r.n);
    for (const e of r.es) col.edge(e);
    return { ...brief(r.n), ...(r.status ? { status: r.status } : {}), ...(r.decidedAt ? { decidedAt: r.decidedAt } : {}) };
  });
  const supersedes = chain(older);
  const supersededBy = chain(newer);
  const gaps = [
    ...(ev.length ? [] : ["No evidence is recorded for this decision (no BASED_ON)."]),
    ...(supersededBy.length ? [`Superseded by ${supersededBy[0]!.id}; it is not the current decision.`] : []),
  ];
  return col.result(ctx, {
    decision: { ...brief(node), status: dec?.status ?? null, decidedAt: dec?.decidedAt ?? null, ...(dec?.summary ? { summary: clip(dec.summary) } : {}) },
    current: supersededBy.length === 0,
    evidence: ev, ...((dec?.evidenceTotal ?? 0) > ev.length ? { evidenceTotal: dec!.evidenceTotal } : {}), decidedBy: people,
    affects: hit, ...((dec?.affectsTotal ?? 0) > hit.length ? { affectsTotal: dec!.affectsTotal } : {}), supersedes, supersededBy,
    ...(alternatives.length ? { alternatives } : {}),
  }, [note, ...gaps].filter(Boolean).join(" ") || undefined);
}

export const traceDecision = defineTool({
  name: "trace_decision",
  description:
    "Answer 'why did we…' (why we paused, stopped, chose or changed something): the Decision, its evidence (numbers and documents, each with sources), who decided, what it affects, what it replaced and what replaced it. Pass id, or query to find the decision; a non-decision id traces the latest decision affecting it. Example: {\"query\":\"pause daily stories\"}",
  input: {
    id: z.string().optional().describe("Decision id (or an entity a decision affects)"),
    query: z.string().optional().describe("Words to find the decision when you lack its id"),
  },
  run: runTrace,
});
