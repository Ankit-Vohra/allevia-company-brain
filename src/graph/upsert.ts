// Temporal writes (spec §5.4). Nothing here ever deletes: the graph remembers what was true and when.
// - Nodes MERGE on `id`. Re-asserting identical content is a no-op. When a TRACKED_PROPS value changes, the old
//   state is copied into a `Version` node first: (n)-[:HAD_VERSION]->(:Entity:Version {props: JSON, since, until}).
//   `stateSince` on the node marks when its current tracked state began (the next Version's `since`).
// - Edges carry valid time (since/until) and record time (recordedAt/retiredAt). A current edge has `until` null.
//   Re-asserting a current fact refreshes its provenance in place; re-asserting a closed fact opens a new edge.
//   Functional relationships (schema FUNCTIONAL_RELS) close the slot's previous edge when a new one arrives.
// - Numbers are Observation nodes with a deterministic id, linked MEASURES -> subject and SOURCED_FROM -> document.
// Concurrency: each node create, node update (+ its Version) and edge write (+ its functional hand-over) is one
// atomic statement; see upsertNode/upsertEdge. addObservation is three idempotent statements (node, MEASURES,
// SOURCED_FROM), not one, and writeBatch is item by item.
// A read plus one write per item: plenty for hackathon-sized ingests; UNWIND batching can come later behind writeBatch.
import { randomBytes } from "node:crypto";
import type { GraphHandle } from "./client.js";
import {
  CLOSED_EDGE_COST, EDGE_META_PROPS, NODE_META_PROPS, TRACKED_PROPS, functionalRule, isAllowed, isEntityType, isRelType,
  typeOfLabels, type EntityType, type FunctionalRule, type RelType,
} from "./schema.js";
import { CHUNK_VECTOR_PROP, ENTITY_VECTOR_PROP, VECTOR_DIM, vectorPropFor } from "./indexes.js";
import { DisallowedRelationship, InvalidWrite, MissingEndpoint } from "./errors.js";
import { sha256, typeFromId } from "../util/ids.js";

export { DisallowedRelationship, InvalidWrite, MissingEndpoint };

export type Prim = string | number | boolean | null | string[] | number[];

export interface NodeInput {
  type: EntityType;
  id: string;
  name: string;
  summary?: string;
  props?: Record<string, Prim>;
  src?: string;
  asOf?: string;
  simulated?: boolean;
  embedding?: number[];
}

export interface EdgeInput {
  from: string;
  type: RelType;
  to: string;
  props?: Record<string, Prim>;
  since?: number;
  src?: string;
  asOf?: string;
  conf?: number;
  // undefined: use FUNCTIONAL_RELS; true: the source is the slot (one current <type> edge out of `from` to nodes of
  // the target's type); false: never close anything.
  functional?: boolean;
}

export interface ObservationInput {
  subject: string;
  metric: string;
  value: number;
  unit?: string;
  windowStart?: string;
  windowEnd?: string;
  asOf: string;
  src: string;
  simulated?: boolean;
  evidence?: string;      // the source's own words for the number (LLM extraction keeps its quote here)
}

export interface NodeResult { created: boolean; versioned: boolean; updated: boolean }

export interface WriteStats {
  nodesCreated: number;
  nodesUpdated: number;
  versions: number;
  edgesCreated: number;
  edgesClosed: number;
  observations: number;
  errors: Array<{ kind: "node" | "edge" | "observation"; item: NodeInput | EdgeInput | ObservationInput; error: string }>;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NODE_RESERVED = new Set<string>(NODE_META_PROPS);
const EDGE_RESERVED = new Set<string>(EDGE_META_PROPS);
const VECTOR_PROPS = [ENTITY_VECTOR_PROP, CHUNK_VECTOR_PROP];

// ---------- validation ----------

function isPrim(v: unknown): v is Prim {
  if (v === null || typeof v === "string" || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (Array.isArray(v)) return v.every((x) => typeof x === "string") || v.every((x) => typeof x === "number" && Number.isFinite(x));
  return false;
}

function checkProps(props: Record<string, unknown> | undefined, reserved: Set<string>, where: string): void {
  for (const [k, v] of Object.entries(props ?? {})) {
    if (!IDENT.test(k)) throw new InvalidWrite(`${where}: prop key ${JSON.stringify(k)} is not a plain identifier`);
    if (reserved.has(k)) throw new InvalidWrite(`${where}: prop ${k} is reserved (set it through the input field)`);
    if (v !== undefined && !isPrim(v)) throw new InvalidWrite(`${where}: prop ${k} must be a primitive or a list of strings/numbers`);
  }
}

const nonEmpty = (s: unknown): s is string => typeof s === "string" && s.trim() !== "" && s === s.trim();

function validateNode(n: NodeInput): void {
  if (!isEntityType(n.type)) throw new InvalidWrite(`unknown entity type ${JSON.stringify(n.type)}`);
  if (!nonEmpty(n.id)) throw new InvalidWrite(`node id must be a non-empty trimmed string, got ${JSON.stringify(n.id)}`);
  const idType = typeFromId(n.id);
  if (idType !== n.type) {
    throw new InvalidWrite(`${n.id}: id prefix says ${idType ?? "no known type"}, not ${n.type} (build ids with entityId/observationId)`);
  }
  if (typeof n.name !== "string" || n.name.trim() === "") throw new InvalidWrite(`${n.id}: name must be a non-empty string`);
  checkProps(n.props, NODE_RESERVED, n.id);
  if (n.embedding && (n.embedding.length !== VECTOR_DIM || !n.embedding.every(Number.isFinite))) {
    throw new InvalidWrite(`${n.id}: embedding must be ${VECTOR_DIM} finite numbers, got ${n.embedding.length}`);
  }
}

function validateEdge(e: EdgeInput): void {
  if (!isRelType(e.type)) throw new InvalidWrite(`unknown relationship type ${JSON.stringify(e.type)}`);
  if (!nonEmpty(e.from) || !nonEmpty(e.to)) throw new InvalidWrite(`edge ${e.type} needs non-empty from/to ids`);
  if (e.from === e.to) throw new InvalidWrite(`${e.from} cannot ${e.type} itself`);
  if (e.conf !== undefined && !(Number.isFinite(e.conf) && e.conf >= 0 && e.conf <= 1)) throw new InvalidWrite(`conf must be in [0,1], got ${e.conf}`);
  if (e.since !== undefined && !Number.isFinite(e.since)) throw new InvalidWrite(`since must be epoch ms, got ${e.since}`);
  checkProps(e.props, EDGE_RESERVED, `${e.from}-[:${e.type}]->${e.to}`);
}

// Values as FalkorDB returns them: doubles may come back rounded, so compare numbers with a relative tolerance.
function sameValue(a: unknown, b: unknown): boolean {
  const x = a ?? null;
  const y = b ?? null;
  if (x === null || y === null) return x === y;
  if (typeof x === "number" && typeof y === "number") return x === y || Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y));
  if (Array.isArray(x) && Array.isArray(y)) return x.length === y.length && x.every((v, i) => sameValue(v, y[i]));
  return x === y;
}

const defined = (o: Record<string, unknown>): Record<string, Prim> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Record<string, Prim>;

const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

// ---------- nodes ----------

async function readNode(g: GraphHandle, id: string): Promise<{ labels: string[]; props: Record<string, unknown> } | null> {
  const rows = await g.query<{ labels: string[]; kv: Array<[string, unknown]> }>(
    "MATCH (n:Entity {id:$id}) RETURN labels(n) AS labels, [k IN keys(n) WHERE NOT k IN $skip | [k, n[k]]] AS kv LIMIT 1",
    { id, skip: VECTOR_PROPS });
  const r = rows[0];
  return r ? { labels: r.labels, props: Object.fromEntries(r.kv) } : null;
}

const MAX_ATTEMPTS = 5;

// Concurrency: the create path is one MERGE that reports `created` only to the caller whose ON CREATE ran (a per-call
// token), and every update is a compare-and-set on `rev`, with the Version written in the same statement. A caller
// that loses a race re-reads and re-diffs, so two concurrent upserts never both report created and never version the
// same state twice. What remains: nodes are matched by id with the type checked on read, so a concurrent create of
// the same id under a different type could still make two nodes (the id-prefix check makes that a caller bug).
export async function upsertNode(g: GraphHandle, n: NodeInput, now: number = Date.now()): Promise<NodeResult> {
  validateNode(n);
  const content = defined({ ...n.props, name: n.name, summary: n.summary });
  const prov = defined({ src: n.src, asOf: n.asOf, simulated: n.simulated });
  const vecProp = vectorPropFor(n.type);
  const base: Record<string, unknown> = { id: n.id, now, props: { ...content, ...prov }, vec: n.embedding };

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const existing = await readNode(g, n.id);
    if (!existing) {
      const rows = await g.query<{ created: boolean }>(
        `MERGE (n:Entity:${n.type} {id:$id})
         ON CREATE SET n += $props, n.createdAt = $now, n.updatedAt = $now, n.stateSince = $now, n.rev = 1, n._mergeToken = $token${n.embedding ? `, n.${vecProp} = vecf32($vec)` : ""}
         WITH n, coalesce(n._mergeToken = $token, false) AS created SET n._mergeToken = null RETURN created`,
        { ...base, token: randomBytes(8).toString("hex") });
      if (rows[0]?.created) return { created: true, versioned: false, updated: false };
      continue; // another writer created it between our read and MERGE: go round as an update
    }

    const have = typeOfLabels(existing.labels);
    if (have !== n.type) throw new InvalidWrite(`${n.id} already exists as ${have ?? existing.labels.join(":")}, not ${n.type}`);
    const old = existing.props;
    const changed = Object.keys(content).filter((k) => !sameValue(old[k], content[k]));
    const provChanged = Object.keys(prov).some((k) => !sameValue(old[k], prov[k]));
    // A tracked value appearing for the first time is new information, not a change of state.
    const tracked = (TRACKED_PROPS[n.type] ?? []).filter((k) => changed.includes(k) && old[k] !== null && old[k] !== undefined);
    if (!changed.length && !provChanged && !n.embedding) return { created: false, versioned: false, updated: false };

    const params: Record<string, unknown> = { ...base, rev: num(old.rev) ?? 0 };
    let cypher = "MATCH (n:Entity {id:$id}) WHERE coalesce(n.rev, 0) = $rev";
    if (tracked.length) {
      const snapshot = JSON.stringify(old);
      params.version = defined({
        id: `version:${n.id}@${now}-${sha256(snapshot).slice(0, 8)}`,
        name: "", // no display name: a Version must not surface as an entity-search hit (the old name is in `props`)
        of: n.id,
        props: snapshot,
        changed: tracked,
        since: num(old.stateSince) ?? num(old.updatedAt) ?? num(old.createdAt) ?? now,
        until: now,
        src: old.src as Prim | undefined,
        asOf: old.asOf as Prim | undefined,
        createdAt: now,
        updatedAt: now,
      });
      params.hv = defined({ since: now, recordedAt: now, src: n.src, asOf: n.asOf });
      cypher += " CREATE (n)-[h:HAD_VERSION]->(v:Entity:Version) SET v += $version, h += $hv";
    }
    cypher += " SET n += $props, n.rev = $rev + 1";
    if (changed.length) cypher += ", n.updatedAt = $now";
    if (tracked.length) cypher += ", n.stateSince = $now";
    if (n.embedding) cypher += `, n.${vecProp} = vecf32($vec)`;
    const rows = await g.query<{ c: number }>(`${cypher} RETURN count(n) AS c`, params);
    if (rows[0]?.c) return { created: false, versioned: tracked.length > 0, updated: changed.length > 0 };
    // `rev` moved under us: someone else updated the node; re-read and re-diff against their state.
  }
  throw new Error(`upsertNode ${n.id}: still contended after ${MAX_ATTEMPTS} attempts`);
}

// ---------- edges ----------

const CLOSE_SET = (v: string, reason: string) =>
  `SET ${v}.until = CASE WHEN ${v}.since > $end THEN ${v}.since ELSE $end END, ${v}.retiredAt = $now, ${v}.closedCost = $cost, ${v}.closeReason = ${reason}`;

// One statement per edge, so a functional hand-over is all-or-nothing: the slot's previous edge is closed only when
// (and in the same statement as) the new edge is created. Re-asserting a current fact refreshes its provenance,
// closes duplicate current copies of it, and leaves the slot alone. The endpoint/type check is a separate read
// before it; nodes are never deleted, so that read cannot go stale in a way that matters.
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
  let cypher = `MATCH (a:Entity {id:$from}), (b:Entity {id:$to})
    OPTIONAL MATCH (a)-[c:${T}]->(b) WHERE c.until IS NULL
    WITH a, b, c ORDER BY c.recordedAt
    WITH a, b, collect(c) AS cur
    FOREACH (x IN cur[0..1] | SET x += $props)
    FOREACH (x IN cur[1..] | ${CLOSE_SET("x", "'duplicate current edge'")})
    FOREACH (_ IN CASE WHEN size(cur) = 0 THEN [1] ELSE [] END |
      CREATE (a)-[r:${T}]->(b) SET r += $props, r.since = $since, r.recordedAt = $now)
    WITH a, b, size(cur) = 0 AS created, CASE WHEN size(cur) > 1 THEN size(cur) - 1 ELSE 0 END AS dupes`;
  if (rule) {
    cypher += rule.key === "to"
      ? ` OPTIONAL MATCH (x:Entity)-[o:${T}]->(b) WHERE created AND o.until IS NULL AND x <> a${rule.fromType ? ` AND x:${rule.fromType}` : ""}`
      : ` OPTIONAL MATCH (a)-[o:${T}]->(y:Entity) WHERE created AND o.until IS NULL AND y <> b${rule.toType ? ` AND y:${rule.toType}` : ""}`;
    cypher += ` WITH created, dupes, collect(o) AS olds FOREACH (o IN olds | ${CLOSE_SET("o", "$reason")}) RETURN created, dupes, size(olds) AS closed`;
  } else {
    cypher += " RETURN created, dupes, 0 AS closed";
  }
  const since = e.since ?? now;
  const rows = await g.query<{ created: boolean; dupes: number; closed: number }>(cypher, {
    from: e.from, to: e.to, now, since, end: since, cost: CLOSED_EDGE_COST,
    props: defined({ ...e.props, src: e.src, asOf: e.asOf, conf: e.conf }),
    reason: `replaced by ${e.from} -[:${e.type}]-> ${e.to}`,
  });
  const r = rows[0];
  if (!r) throw new MissingEndpoint([e.from, e.to], "endpoint vanished during upsertEdge");
  return { created: r.created, closed: r.closed + r.dupes };
}

// Ends the current (from)-[type]->(to) fact: sets until + retiredAt (and the SPpaths cost). Returns how many edges it
// closed (0 when there was no current edge). Never deletes.
export async function closeEdge(g: GraphHandle, from: string, type: RelType, to: string, now: number = Date.now(), reason?: string): Promise<number> {
  if (!isRelType(type)) throw new InvalidWrite(`unknown relationship type ${JSON.stringify(type)}`);
  const rows = await g.query<{ c: number }>(
    `MATCH (:Entity {id:$from})-[r:${type}]->(:Entity {id:$to}) WHERE r.until IS NULL ${CLOSE_SET("r", "$reason")} RETURN count(r) AS c`,
    { from, to, end: now, now, cost: CLOSED_EDGE_COST, reason: reason ?? null });
  return rows[0]?.c ?? 0;
}

// ---------- observations ----------

export function observationId(o: Pick<ObservationInput, "metric" | "subject" | "windowEnd" | "asOf">): string {
  return `obs:${o.metric}:${o.subject}:${o.windowEnd ?? o.asOf}`;
}

async function writeObservation(g: GraphHandle, o: ObservationInput, now: number): Promise<NodeResult & { id: string }> {
  for (const k of ["subject", "metric", "asOf", "src"] as const) {
    if (!nonEmpty(o[k])) throw new InvalidWrite(`observation ${k} must be a non-empty string`);
  }
  if (!Number.isFinite(o.value)) throw new InvalidWrite(`observation value must be a finite number, got ${o.value}`);
  const id = observationId(o);
  const subj = await g.query<{ name: string | null }>("MATCH (s:Entity {id:$id}) RETURN s.name AS name LIMIT 1", { id: o.subject });
  if (!subj.length) throw new MissingEndpoint([o.subject], `subject of ${id}`);
  const res = await upsertNode(g, {
    type: "Observation", id,
    name: `${o.metric} of ${subj[0]!.name ?? o.subject} (${o.windowEnd ?? o.asOf})`,
    props: defined({
      metric: o.metric, value: o.value, unit: o.unit, windowStart: o.windowStart, windowEnd: o.windowEnd, subject: o.subject,
      evidence: o.evidence,
    }),
    src: o.src, asOf: o.asOf, simulated: o.simulated,
  }, now);
  await upsertEdge(g, { from: id, type: "MEASURES", to: o.subject, src: o.src, asOf: o.asOf }, now);
  // The source document may be ingested later; the `src` prop already records it, the edge follows when it exists.
  const doc = await g.query<{ c: number }>("MATCH (d:Entity:Document {id:$id}) RETURN count(d) AS c", { id: o.src });
  if ((doc[0]?.c ?? 0) > 0) await upsertEdge(g, { from: id, type: "SOURCED_FROM", to: o.src, asOf: o.asOf }, now);
  return { id, ...res };
}

// Returns the observation id: obs:<metric>:<subject>:<windowEnd|asOf>. Re-adding it with a different value updates
// the value and keeps the earlier reading as a Version (a number corrected by a later source).
export async function addObservation(g: GraphHandle, o: ObservationInput, now: number = Date.now()): Promise<string> {
  return (await writeObservation(g, o, now)).id;
}

// ---------- batches ----------

// Nodes first, then observations (they only need their subject node), then edges, so an edge can point at an
// observation from the same batch (an extracted Decision BASED_ON a number). A bad item is recorded in `errors` and the
// batch carries on. Observation MEASURES/SOURCED_FROM edges are not counted in edgesCreated.
export async function writeBatch(
  g: GraphHandle,
  w: { nodes?: NodeInput[]; edges?: EdgeInput[]; observations?: ObservationInput[] },
  now: number = Date.now(),
): Promise<WriteStats> {
  const s: WriteStats = { nodesCreated: 0, nodesUpdated: 0, versions: 0, edgesCreated: 0, edgesClosed: 0, observations: 0, errors: [] };
  const msg = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  for (const n of w.nodes ?? []) {
    try {
      const r = await upsertNode(g, n, now);
      if (r.created) s.nodesCreated++;
      else if (r.updated) s.nodesUpdated++;
      if (r.versioned) s.versions++;
    } catch (e) {
      s.errors.push({ kind: "node", item: n, error: msg(e) });
    }
  }
  for (const o of w.observations ?? []) {
    try {
      const r = await writeObservation(g, o, now);
      s.observations++;
      if (r.versioned) s.versions++;
    } catch (e) {
      s.errors.push({ kind: "observation", item: o, error: msg(e) });
    }
  }
  for (const e of w.edges ?? []) {
    try {
      const r = await upsertEdge(g, e, now);
      if (r.created) s.edgesCreated++;
      s.edgesClosed += r.closed;
    } catch (err) {
      s.errors.push({ kind: "edge", item: e, error: msg(err) });
    }
  }
  return s;
}
