// Node writes (spec §5.4). Nodes MERGE on `id`; re-asserting identical content is a no-op. When a TRACKED_PROPS value
// changes, the old state is copied into a `Version` node first: (n)-[:HAD_VERSION]->(:Entity:Version {props: JSON,
// since, until}). `stateSince` on the node marks when its current tracked state began (the next Version's `since`).
import { randomBytes } from "node:crypto";
import type { GraphHandle } from "./client.js";
import { TRACKED_PROPS, typeOfLabels } from "./schema.js";
import { CHUNK_VECTOR_PROP, ENTITY_VECTOR_PROP, vectorPropFor } from "./indexes.js";
import { InvalidWrite } from "./errors.js";
import { defined, num, sameValue, validateNode, type NodeInput, type Prim } from "./validate.js";
import { sha256 } from "../util/ids.js";

export interface NodeResult { created: boolean; versioned: boolean; updated: boolean }

const VECTOR_PROPS = [ENTITY_VECTOR_PROP, CHUNK_VECTOR_PROP];

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
