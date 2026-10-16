// Node writes (spec §5.4). Nodes MERGE on `id`; re-asserting identical content is a no-op. When a TRACKED_PROPS value
// changes, the old state is copied into a `Version` node first: (n)-[:HAD_VERSION]->(:Entity:Version {props: JSON,
// since, until}). `stateSince` on the node marks when its current tracked state began (the next Version's `since`).
//
// Version time is SOURCE time wherever the source's date (asOf) is known, record time (the write's `now`) otherwise:
// - a node's stateSince = the asOf of the write that created it or last changed a tracked value, else that write's now;
// - a Version runs from the old state's stateSince to the asOf of the change (else now), never ending before it starts;
// - a backdated Version (an older source, below) runs from that source's asOf to the current state's asOf.
// A correction for the same date (an Observation re-read with a new value) is a zero-length Version; replaying an
// earlier same-date reading from another source, whose values that Version already records, changes nothing.
import { randomBytes } from "node:crypto";
import type { GraphHandle } from "./client.js";
import { SEARCH_INDEXED_TYPES, SEARCHABLE_LABEL, TRACKED_PROPS, metricKeyOf, typeOfLabels } from "./schema.js";
import { CHUNK_VECTOR_PROP, ENTITY_VECTOR_PROP, vectorPropFor } from "./indexes.js";
import { InvalidWrite } from "./errors.js";
import { defined, num, sameValue, validateNode, type NodeInput, type Prim } from "./validate.js";
import { noteGraphWrite } from "./projection.js";
import { approvalCreated } from "./approval-hook.js";
import { sha256 } from "../util/ids.js";

export interface NodeResult { created: boolean; versioned: boolean; updated: boolean }

const VECTOR_PROPS = [ENTITY_VECTOR_PROP, CHUNK_VECTOR_PROP];
const SEARCHABLE_TYPES = new Set<string>(SEARCH_INDEXED_TYPES);
// FalkorDB's UNIQUE constraint on Entity.id refuses the second node with an id (a concurrent create, or the same id
// under another type): the caller re-reads, finds the winner, and goes on as an update (or reports the type clash).
const uniqueViolation = (e: unknown): boolean => /unique constraint/i.test(String((e as Error).message));

async function readNode(g: GraphHandle, id: string): Promise<{ labels: string[]; props: Record<string, unknown> } | null> {
  const rows = await g.peek<{ labels: string[]; kv: Array<[string, unknown]> }>(
    "MATCH (n:Entity {id:$id}) RETURN labels(n) AS labels, [k IN keys(n) WHERE NOT k IN $skip | [k, n[k]]] AS kv LIMIT 1",
    { id, skip: VECTOR_PROPS });
  const r = rows[0];
  return r ? { labels: r.labels, props: Object.fromEntries(r.kv) } : null;
}

const MAX_ATTEMPTS = 5;

const dateMs = (v: unknown): number | undefined => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : undefined;
};

const absent = (v: unknown): boolean => v === null || v === undefined;

// Is this source's view of `keys` already on record? True when a Version from the same source and date holds these
// values: the Version written when this source was current, on an earlier run of the same ingest. Replaying such a
// source must not flip the node back to it.
async function alreadyRecorded(g: GraphHandle, n: NodeInput, content: Record<string, Prim>, keys: string[]): Promise<boolean> {
  const rows = await g.peek<{ props: string }>(
    "MATCH (:Entity {id:$id})-[:HAD_VERSION]->(v:Version) WHERE v.asOf = $asOf AND coalesce(v.src, '') = $src RETURN v.props AS props",
    { id: n.id, asOf: n.asOf ?? null, src: n.src ?? "" });
  return rows.some((v) => keys.every((k) => sameValue((JSON.parse(v.props) as Record<string, unknown>)[k], content[k])));
}

// The input describes the node as of an earlier date than its current state. Keep the current values; but
// - what the node does not have yet (an untracked prop it lacks, a missing summary) is new information: it is added;
// - if the older source's tracked values differ, its view is recorded as a Version bracketed by the two dates
//   (since = its asOf, until = the current asOf), marked backdated. Idempotent: the Version id hashes the older
//   source's tracked values, a Version already recording that source's view (same src, asOf and values) is enough,
//   and a filled prop is no longer absent. So re-running a historical ingest adds nothing.
// Returns null when `rev` moved under it (the caller re-reads and retries).
async function writeBackdated(
  g: GraphHandle, n: NodeInput, old: Record<string, unknown>, content: Record<string, Prim>, prov: Record<string, Prim>,
  since: number, until: number, now: number,
): Promise<NodeResult | null> {
  const tracked = TRACKED_PROPS[n.type] ?? [];
  const fill = Object.fromEntries(Object.entries(content).filter(([k, v]) => !tracked.includes(k) && absent(old[k]) && !absent(v)));
  let updated = false;
  if (Object.keys(fill).length) {
    const rows = await g.query<{ c: number }>(
      "MATCH (n:Entity {id:$id}) WHERE coalesce(n.rev, 0) = $rev SET n += $fill, n.rev = $rev + 1, n.updatedAt = $now RETURN count(n) AS c",
      { id: n.id, rev: num(old.rev) ?? 0, fill, now });
    if (!rows[0]?.c) return null;
    updated = true;
  }
  const differing = tracked.filter((k) => k in content && !sameValue(old[k], content[k]));
  if (!differing.length) return { created: false, versioned: false, updated };
  if (await alreadyRecorded(g, n, content, differing)) return { created: false, versioned: false, updated };
  const { rev: _rev, ...current } = old;
  const view = JSON.stringify({ ...current, ...content, ...prov });
  const key = sha256(JSON.stringify([differing.map((k) => [k, content[k]]), n.src ?? null])).slice(0, 8);
  const rows = await g.query<{ created: boolean }>(
    `MATCH (n:Entity {id:$id})
     MERGE (v:Entity:Version {id:$vid}) ON CREATE SET v += $version, v._mergeToken = $token
     WITH n, v, coalesce(v._mergeToken = $token, false) AS created SET v._mergeToken = null
     MERGE (n)-[h:HAD_VERSION]->(v) ON CREATE SET h += $hv
     RETURN created`,
    {
      id: n.id, vid: `version:${n.id}@${n.asOf}-${key}`, token: randomBytes(8).toString("hex"),
      version: defined({ name: "", of: n.id, props: view, changed: differing, since, until, src: n.src, asOf: n.asOf, backdated: true, createdAt: now, updatedAt: now }),
      hv: defined({ since: now, recordedAt: now, src: n.src, asOf: n.asOf }),
    });
  const created = rows[0]?.created === true;
  if (created) await noteGraphWrite(g.name);
  return { created: false, versioned: created, updated };
}

// Time: an input whose asOf is older than the node's asOf never overwrites the current state (writeBackdated).
// Concurrency: the create path is one MERGE that reports `created` only to the caller whose ON CREATE ran (a per-call
// token), and every update is a compare-and-set on `rev`, with the Version written in the same statement. A caller
// that loses a race re-reads and re-diffs, so two concurrent upserts never both report created and never version the
// same state twice. Entity.id carries UNIQUE and MANDATORY constraints (ensureIndexes), so a concurrent create of the
// same id, under the same type or another, makes the loser's MERGE fail with a unique-constraint error: it re-reads and
// finds the winner (an update) or the type clash (InvalidWrite). On a graph whose constraint is not operational yet,
// the type clash could still make two nodes (the id-prefix check makes that a caller bug).
export async function upsertNode(g: GraphHandle, n: NodeInput, now: number = Date.now()): Promise<NodeResult> {
  validateNode(n);
  // An Observation always carries metricKey, whoever writes it: reads compare it (and index it) instead of toLower(metric).
  const metric = n.type === "Observation" ? n.props?.metric : undefined;
  const props = typeof metric === "string" && n.props?.metricKey === undefined ? { ...n.props, metricKey: metricKeyOf(metric) } : n.props;
  const content = defined({ ...props, name: n.name, summary: n.summary });
  const prov = defined({ src: n.src, asOf: n.asOf, simulated: n.simulated });
  const vecProp = vectorPropFor(n.type);
  const inAsOf = dateMs(n.asOf);
  const stateSince = inAsOf ?? now; // source time where known (see the header)
  const base: Record<string, unknown> = { id: n.id, now, stateSince, props: { ...content, ...prov }, vec: n.embedding };

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const existing = await readNode(g, n.id);
    if (!existing) {
      let rows: Array<{ created: boolean }>;
      try {
        // The match stays on (Entity, type) so a node written before the Searchable label existed is still found
        // (ensureIndexes backfills those); the label is set on create, not matched.
        rows = await g.query<{ created: boolean }>(
          `MERGE (n:Entity:${n.type} {id:$id})
           ON CREATE SET n += $props, n.createdAt = $now, n.updatedAt = $now, n.stateSince = $stateSince, n.rev = 1, n._mergeToken = $token${n.embedding ? `, n.${vecProp} = vecf32($vec)` : ""}${SEARCHABLE_TYPES.has(n.type) ? `, n:${SEARCHABLE_LABEL}` : ""}
           WITH n, coalesce(n._mergeToken = $token, false) AS created SET n._mergeToken = null RETURN created`,
          { ...base, token: randomBytes(8).toString("hex") });
      } catch (e) {
        if (uniqueViolation(e)) continue; // lost a create race, or the id is taken by another type: re-read
        throw e;
      }
      if (rows[0]?.created) {
        await noteGraphWrite(g.name); // a new node changes what the algorithms see
        if (n.type === "Approval" && props?.status === "pending") approvalCreated(g.name); // a card is waiting: the Discord hub posts it now
        return { created: true, versioned: false, updated: false };
      }
      continue; // another writer created it between our read and MERGE: go round as an update
    }

    const have = typeOfLabels(existing.labels);
    if (have !== n.type) throw new InvalidWrite(`${n.id} already exists as ${have ?? existing.labels.join(":")}, not ${n.type}`);
    const old = existing.props;
    // An older source than the one behind the current state never overwrites it: it becomes a backdated Version.
    const curAsOf = dateMs(old.asOf);
    if (inAsOf !== undefined && curAsOf !== undefined && inAsOf < curAsOf) {
      const r = await writeBackdated(g, n, old, content, prov, inAsOf, curAsOf, now);
      if (r) return r;
      continue; // `rev` moved under us
    }
    const changed = Object.keys(content).filter((k) => !sameValue(old[k], content[k]));
    const provChanged = Object.keys(prov).some((k) => !sameValue(old[k], prov[k]));
    // A tracked value appearing for the first time is new information, not a change of state.
    const tracked = (TRACKED_PROPS[n.type] ?? []).filter((k) => changed.includes(k) && !absent(old[k]));
    if (!changed.length && !provChanged && !n.embedding) return { created: false, versioned: false, updated: false };
    // Same date, another source: if this source's values are already a Version (two same-day readings, replayed),
    // the later reading stays current.
    if (tracked.length && inAsOf !== undefined && inAsOf === curAsOf && n.src !== undefined && n.src !== old.src
        && await alreadyRecorded(g, n, content, tracked)) {
      return { created: false, versioned: false, updated: false };
    }

    const params: Record<string, unknown> = { ...base, rev: num(old.rev) ?? 0 };
    let cypher = "MATCH (n:Entity {id:$id}) WHERE coalesce(n.rev, 0) = $rev";
    if (tracked.length) {
      const snapshot = JSON.stringify(old);
      const vSince = num(old.stateSince) ?? num(old.updatedAt) ?? num(old.createdAt) ?? now;
      const nextSince = Math.max(vSince, stateSince); // the old state ends where the new one begins
      params.nextSince = nextSince;
      params.version = defined({
        id: `version:${n.id}@${now}-${sha256(snapshot).slice(0, 8)}`,
        name: "", // no display name: a Version must not surface as an entity-search hit (the old name is in `props`)
        of: n.id,
        props: snapshot,
        changed: tracked,
        since: vSince,
        until: nextSince,
        src: old.src as Prim | undefined,
        asOf: old.asOf as Prim | undefined,
        createdAt: now,
        updatedAt: now,
      });
      params.hv = defined({ since: now, recordedAt: now, src: n.src, asOf: n.asOf });
      // The id goes in the CREATE itself: FalkorDB Cloud checks the mandatory id constraint before any SET runs.
      params.vid = (params.version as { id: string }).id;
      cypher += " CREATE (n)-[h:HAD_VERSION]->(v:Entity:Version {id: $vid}) SET v += $version, h += $hv";
    }
    cypher += " SET n += $props, n.rev = $rev + 1";
    if (SEARCHABLE_TYPES.has(n.type)) cypher += `, n:${SEARCHABLE_LABEL}`; // heals a node written before the label existed
    if (changed.length) cypher += ", n.updatedAt = $now";
    if (tracked.length) cypher += ", n.stateSince = $nextSince";
    if (n.embedding) cypher += `, n.${vecProp} = vecf32($vec)`;
    const rows = await g.query<{ c: number }>(`${cypher} RETURN count(n) AS c`, params);
    if (rows[0]?.c) {
      if (tracked.length) await noteGraphWrite(g.name); // a Version node and a HAD_VERSION edge appeared
      return { created: false, versioned: tracked.length > 0, updated: changed.length > 0 };
    }
    // `rev` moved under us: someone else updated the node; re-read and re-diff against their state.
  }
  throw new Error(`upsertNode ${n.id}: still contended after ${MAX_ATTEMPTS} attempts`);
}
