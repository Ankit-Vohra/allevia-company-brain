// Edge writes (spec §5.4). Edges carry valid time (since/until) and record time (recordedAt/retiredAt); a current
// edge has `until` null. Re-asserting a known fact refreshes its provenance in place; a fact that ended opens a new
// edge only when the source is newer than the ending. Functional relationships (schema FUNCTIONAL_RELS) keep at most
// one holder of a slot at any moment. Nothing is ever deleted.
import type { GraphHandle } from "./client.js";
import { CLOSED_EDGE_COST, functionalRule, isAllowed, isRelType, typeOfLabels, type FunctionalRule, type RelType } from "./schema.js";
import { DisallowedRelationship, InvalidWrite, MissingEndpoint } from "./errors.js";
import { defined, validateEdge, type EdgeInput } from "./validate.js";
import { noteGraphWrite } from "./projection.js";

// Ends edge `v` at $end (never before its own since). retiredAt is when we first learned it ended (record time);
// retiredAsOfMs is the date of the source that ended it ($endedAsOf: its asOf, else the write's now). Shortening an
// edge that had already ended keeps both.
const CLOSE_SET = (v: string, reason: string) =>
  `SET ${v}.until = CASE WHEN ${v}.since > $end THEN ${v}.since ELSE $end END, ${v}.retiredAt = coalesce(${v}.retiredAt, $now), ` +
  `${v}.retiredAsOfMs = coalesce(${v}.retiredAsOfMs, $endedAsOf), ${v}.closedCost = $cost, ${v}.closeReason = ${reason}`;

// Source date in epoch ms (stored on the edge as `asOfMs` next to `asOf`, so statements can compare source dates).
const asOfMillis = (asOf: string | undefined): number | undefined => {
  const t = asOf === undefined ? NaN : Date.parse(asOf);
  return Number.isFinite(t) ? t : undefined;
};

// One statement per edge, so every decision below is all-or-nothing against the state it read. The endpoint/type
// check is a separate read before it; nodes are never deleted, so that read cannot go stale in a way that matters.
//
// Is it a fact we already have? Same (from, type, to), first match wins:
//  1. an edge (open or closed) with the same `since`: a replay. Re-running an ingest never adds edges.
//  2. the current edge.
//  3. a closed edge whose [since, until) contains the new since.
//  4. a closed edge that ended after the incoming asOf, when the new edge would be open: the source predates the
//     ending and does not reopen the fact. "Ended" is `until` (valid time) or the date of the source that ended it
//     (retiredAsOfMs; retiredAt, record time, on edges closed before it existed). The source's date rather than
//     retiredAt, so a historical ingest, read in order long after the fact, can still see an owner come back.
// A match is a re-assert: its src/asOf/props/conf are replaced when the incoming fact is stronger (missing conf = 1),
// or equally strong and not older (asOf >= the stored asOf; an undated side counts as not older). Duplicate current
// copies get closed. The slot is left alone.
//
// Otherwise a new edge [since, cap) is created. The fact's own later edges, and for a functional slot every other
// holder, bound it: cap = the earliest since among them that is after the new since. A slot edge whose [since, until)
// contains the new since (open or already closed) is shortened to end there, and if it had already ended the new edge
// ends where it did. So at any moment a functional slot has at most one holder, in whatever order the facts arrive.
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
  // Slot edges that still matter: the ones not over by the new since (this fact's own edges included).
  const slot = !rule ? "WITH a, b, cur, closed, [] AS slot"
    : rule.key === "to"
      ? `OPTIONAL MATCH (x:Entity)-[o:${T}]->(b) WHERE (o.until IS NULL OR o.until > $since)${rule.fromType ? ` AND x:${rule.fromType}` : ""}
         WITH a, b, cur, closed, collect(o) AS slot`
      : `OPTIONAL MATCH (a)-[o:${T}]->(y:Entity) WHERE (o.until IS NULL OR o.until > $since)${rule.toType ? ` AND y:${rule.toType}` : ""}
         WITH a, b, cur, closed, collect(o) AS slot`;
  const stronger = "($c > coalesce(y.conf, 1) OR ($c = coalesce(y.conf, 1) AND ($asOfMs IS NULL OR y.asOfMs IS NULL OR $asOfMs >= y.asOfMs)))";
  const cypher = `MATCH (a:Entity {id:$from}), (b:Entity {id:$to})
    OPTIONAL MATCH (a)-[c:${T}]->(b) WHERE c.until IS NULL
    WITH a, b, c ORDER BY c.recordedAt
    WITH a, b, collect(c) AS cur
    OPTIONAL MATCH (a)-[h:${T}]->(b) WHERE h.until IS NOT NULL
    WITH a, b, cur, h ORDER BY h.until DESC, h.recordedAt DESC
    WITH a, b, cur, collect(h) AS closed
    ${slot}
    WITH a, b, cur, slot,
         [x IN cur + closed WHERE x.since = $since] + cur + [x IN closed WHERE coalesce(x.since, 0) <= $since AND x.until > $since] AS known,
         [x IN closed WHERE $asOfMs IS NOT NULL AND (x.until > $asOfMs OR coalesce(x.retiredAsOfMs, x.retiredAt, 0) > $asOfMs)] AS stale,
         [x IN closed WHERE coalesce(x.since, 0) > $since] AS later,
         [o IN slot WHERE coalesce(o.since, 0) <= $since AND (o.until IS NULL OR o.until > $since)] AS covering,
         [o IN slot WHERE coalesce(o.since, 0) > $since] AS newer
    WITH a, b, cur, known, stale, covering,
         reduce(m = null, v IN [o IN later + newer | o.since] + [o IN covering WHERE o.until IS NOT NULL | o.until] |
           CASE WHEN m IS NULL OR v < m THEN v ELSE m END) AS cap
    WITH a, b, cur, covering, cap,
         CASE WHEN size(known) > 0 THEN known[0..1] WHEN cap IS NULL THEN stale[0..1] ELSE [] END AS hit
    WITH a, b, cur, covering, cap, hit, size(hit) = 0 AS created,
         [x IN [y IN hit WHERE y.until IS NULL] + cur | id(x)][0] AS keep
    WITH a, b, covering, cap, hit, created, [y IN cur WHERE id(y) <> keep] AS dupes
    FOREACH (x IN [y IN hit WHERE ${stronger}] | SET x += $props, x.conf = $conf)
    FOREACH (x IN dupes | ${CLOSE_SET("x", "'duplicate current edge'")})
    FOREACH (_ IN CASE WHEN created THEN [1] ELSE [] END |
      CREATE (a)-[r:${T}]->(b) SET r += $props, r.conf = $conf, r.since = $since, r.recordedAt = $now, r.until = cap,
        r.retiredAt = CASE WHEN cap IS NULL THEN null ELSE $now END,
        r.retiredAsOfMs = CASE WHEN cap IS NULL THEN null ELSE $endedAsOf END,
        r.closedCost = CASE WHEN cap IS NULL THEN null ELSE $cost END,
        r.closeReason = CASE WHEN cap IS NULL THEN null ELSE 'arrived before a later holder' END)
    FOREACH (o IN CASE WHEN created THEN covering ELSE [] END | ${CLOSE_SET("o", "$reason")})
    RETURN created, size(dupes) AS dupes, CASE WHEN created THEN size(covering) ELSE 0 END AS closed`;
  const since = e.since ?? now;
  const asOfMs = asOfMillis(e.asOf);
  const rows = await g.query<{ created: boolean; dupes: number; closed: number }>(cypher, {
    from: e.from, to: e.to, now, since, end: since, cost: CLOSED_EDGE_COST, asOfMs: asOfMs ?? null, endedAsOf: asOfMs ?? now,
    props: defined({ ...e.props, src: e.src, asOf: e.asOf, asOfMs }), conf: e.conf ?? null, c: e.conf ?? 1,
    reason: `replaced by ${e.from} -[:${e.type}]-> ${e.to}`,
  });
  const r = rows[0];
  if (!r) throw new MissingEndpoint([e.from, e.to], "endpoint vanished during upsertEdge");
  if (r.created || r.closed + r.dupes > 0) await noteGraphWrite(g.name);
  return { created: r.created, closed: r.closed + r.dupes };
}

// Ends the current (from)-[type]->(to) fact: sets until + retiredAt (and the SPpaths cost). Returns how many edges it
// closed (0 when there was no current edge). Never deletes.
export async function closeEdge(g: GraphHandle, from: string, type: RelType, to: string, now: number = Date.now(), reason?: string): Promise<number> {
  if (!isRelType(type)) throw new InvalidWrite(`unknown relationship type ${JSON.stringify(type)}`);
  const rows = await g.query<{ c: number }>(
    `MATCH (:Entity {id:$from})-[r:${type}]->(:Entity {id:$to}) WHERE r.until IS NULL ${CLOSE_SET("r", "$reason")} RETURN count(r) AS c`,
    { from, to, end: now, now, endedAsOf: now, cost: CLOSED_EDGE_COST, reason: reason ?? null });
  const closed = rows[0]?.c ?? 0;
  if (closed) await noteGraphWrite(g.name);
  return closed;
}
