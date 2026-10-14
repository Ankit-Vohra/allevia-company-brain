// Edge writes (spec §5.4). Edges carry valid time (since/until) and record time (recordedAt/retiredAt); a current
// edge has `until` null. Re-asserting a current fact refreshes its provenance in place; re-asserting a closed fact
// opens a new edge. Functional relationships (schema FUNCTIONAL_RELS) close the slot's previous edge when a new one
// arrives. Nothing is ever deleted.
import type { GraphHandle } from "./client.js";
import { CLOSED_EDGE_COST, functionalRule, isAllowed, isRelType, typeOfLabels, type FunctionalRule, type RelType } from "./schema.js";
import { DisallowedRelationship, InvalidWrite, MissingEndpoint } from "./errors.js";
import { defined, validateEdge, type EdgeInput } from "./validate.js";
import { noteGraphWrite } from "./projection.js";

const CLOSE_SET = (v: string, reason: string) =>
  `SET ${v}.until = CASE WHEN ${v}.since > $end THEN ${v}.since ELSE $end END, ${v}.retiredAt = $now, ${v}.closedCost = $cost, ${v}.closeReason = ${reason}`;

// One statement per edge, so a functional hand-over is all-or-nothing: the slot's previous edge is closed only when
// (and in the same statement as) the new edge is created. The endpoint/type check is a separate read before it;
// nodes are never deleted, so that read cannot go stale in a way that matters.
// - Late arrivals: only slot edges with since <= the new since are closed (until = the new since). If the slot holds
//   a NEWER edge, the new one is created already closed (until = that holder's since): an older source arriving
//   late never displaces the current holder.
// - Re-asserting a current fact keeps the stronger one (missing conf = 1, deterministic): its src/asOf/props/conf
//   are replaced only when the incoming conf >= the stored conf. Duplicate current copies get closed. The slot is
//   left alone.
export async function upsertEdge(g: GraphHandle, e: EdgeInput, now: number = Date.now()): Promise<{ created: boolean; closed: number }> {
  validateEdge(e);
  const ends = await g.query<{ id: string; labels: string[] | null }>(
    "UNWIND $ids AS id OPTIONAL MATCH (n:Entity {id:id}) RETURN id, labels(n) AS labels", { ids: [e.from, e.to] });
  const labels = new Map<string, string[]>();
  for (const r of ends) if (r.labels && !labels.has(r.id)) labels.set(r.id, r.labels);
  const missing = [e.from, e.to].filter((id) => !labels.has(id));
  if (missing.length) throw new MissingEndpoint(missing, `${e.from} -[:${e.type}]-> ${e.to}`);
  const fromType = typeOfLabels(labels.get(e.from)!);
  const toType = typeOfLabels(labels.get(e.to)!);
  if (!fromType || !toType) throw new InvalidWrite(`${e.from} or ${e.to} has no entity type label`);
  if (!isAllowed(fromType, e.type, toType)) throw new DisallowedRelationship(fromType, e.type, toType);

  const rule: FunctionalRule | undefined = e.functional === false ? undefined
    : e.functional === true ? { rel: e.type, toType, key: "from", why: "caller marked functional" }
    : functionalRule(e.type, fromType, toType);
  const T = e.type;
  const slot = !rule ? "WITH a, b, cur, [] AS others"
    : rule.key === "to"
      ? `OPTIONAL MATCH (x:Entity)-[o:${T}]->(b) WHERE o.until IS NULL AND x <> a${rule.fromType ? ` AND x:${rule.fromType}` : ""}
         WITH a, b, cur, collect(o) AS others`
      : `OPTIONAL MATCH (a)-[o:${T}]->(y:Entity) WHERE o.until IS NULL AND y <> b${rule.toType ? ` AND y:${rule.toType}` : ""}
         WITH a, b, cur, collect(o) AS others`;
  const cypher = `MATCH (a:Entity {id:$from}), (b:Entity {id:$to})
    OPTIONAL MATCH (a)-[c:${T}]->(b) WHERE c.until IS NULL
    WITH a, b, c ORDER BY c.recordedAt
    WITH a, b, collect(c) AS cur
    ${slot}
    WITH a, b, cur, size(cur) = 0 AS created,
         [o IN others WHERE coalesce(o.since, 0) <= $since] AS older,
         [o IN others WHERE coalesce(o.since, 0) > $since] AS newer
    WITH a, b, cur, created, older,
         reduce(m = null, o IN newer | CASE WHEN m IS NULL OR o.since < m THEN o.since ELSE m END) AS cap
    FOREACH (x IN [y IN cur[0..1] WHERE $c >= coalesce(y.conf, 1)] | SET x += $props, x.conf = $conf)
    FOREACH (x IN cur[1..] | ${CLOSE_SET("x", "'duplicate current edge'")})
    FOREACH (_ IN CASE WHEN created THEN [1] ELSE [] END |
      CREATE (a)-[r:${T}]->(b) SET r += $props, r.conf = $conf, r.since = $since, r.recordedAt = $now, r.until = cap,
        r.retiredAt = CASE WHEN cap IS NULL THEN null ELSE $now END,
        r.closedCost = CASE WHEN cap IS NULL THEN null ELSE $cost END,
        r.closeReason = CASE WHEN cap IS NULL THEN null ELSE 'arrived after a newer holder' END)
    FOREACH (o IN CASE WHEN created THEN older ELSE [] END | ${CLOSE_SET("o", "$reason")})
    RETURN created, CASE WHEN size(cur) > 1 THEN size(cur) - 1 ELSE 0 END AS dupes,
           CASE WHEN created THEN size(older) ELSE 0 END AS closed`;
  const since = e.since ?? now;
  const rows = await g.query<{ created: boolean; dupes: number; closed: number }>(cypher, {
    from: e.from, to: e.to, now, since, end: since, cost: CLOSED_EDGE_COST,
    props: defined({ ...e.props, src: e.src, asOf: e.asOf }), conf: e.conf ?? null, c: e.conf ?? 1,
    reason: `replaced by ${e.from} -[:${e.type}]-> ${e.to}`,
  });
  const r = rows[0];
  if (!r) throw new MissingEndpoint([e.from, e.to], "endpoint vanished during upsertEdge");
  if (r.created || r.closed + r.dupes > 0) noteGraphWrite(g.name);
  return { created: r.created, closed: r.closed + r.dupes };
}

// Ends the current (from)-[type]->(to) fact: sets until + retiredAt (and the SPpaths cost). Returns how many edges it
// closed (0 when there was no current edge). Never deletes.
export async function closeEdge(g: GraphHandle, from: string, type: RelType, to: string, now: number = Date.now(), reason?: string): Promise<number> {
  if (!isRelType(type)) throw new InvalidWrite(`unknown relationship type ${JSON.stringify(type)}`);
  const rows = await g.query<{ c: number }>(
    `MATCH (:Entity {id:$from})-[r:${type}]->(:Entity {id:$to}) WHERE r.until IS NULL ${CLOSE_SET("r", "$reason")} RETURN count(r) AS c`,
    { from, to, end: now, now, cost: CLOSED_EDGE_COST, reason: reason ?? null });
  const closed = rows[0]?.c ?? 0;
  if (closed) noteGraphWrite(g.name);
  return closed;
}
