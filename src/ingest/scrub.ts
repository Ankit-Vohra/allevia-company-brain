// Maintenance: rewrite a built tenant graph through redact(), in place. Graph writes never delete (spec 5.4), so text that was
// stored before a source learned to redact stays on its nodes after the source is fixed and re-run: an upsert overwrites the
// props it carries, but the old state of a tracked node also lives in a Version's JSON, and a node no run touches again
// keeps what it had. `redactGraph` reads every string of every node and relationship (the walk scanGraph does, paged by
// internal id), runs it through redact(), and writes back only the props that changed.
//
// What it leaves alone, so it can run on any tenant, Studio assets included:
// - digests and content addresses (isDigestProp: hash, sha256, dhash, embedKey, a `storageKey` that is a sha256 + extension);
// - identity props (id, and the `src` / `of` ids that point at other nodes): rewriting one would orphan its edges. If one
//   is flagged, the scan still names it and it needs a hand;
// - vectors, numbers, booleans and every other value type.
// A Version's `props` is JSON: its strings are rewritten with the same rules and the JSON is written back in the same shape.
// The write is a plain `SET n += $patch` by internal id: no `rev`, `updatedAt` or Version is touched, because a privacy
// scrub is not a change of what the business's state was. (Embeddings are not recomputed.)
//
// Idempotent: redact(redact(x)) === redact(x), so a second run finds nothing to write.
import type { GraphHandle } from "../graph/client.js";
import { CHUNK_VECTOR_PROP, ENTITY_VECTOR_PROP } from "../graph/indexes.js";
import { isDigestProp, versionSnapshot } from "./privacy.js";
import { redact } from "./redact.js";

export interface ScrubReport {
  dryRun: boolean;
  nodes: number;                       // nodes with at least one rewritten prop
  relationships: number;               // relationships with at least one rewritten prop
  props: number;                       // property values rewritten (a Version's JSON counts once)
  byKind: Record<string, number>;      // what was found, by redaction kind (never the values)
}

// Props that name a node (or the node a fact came from): never rewritten.
const IDENTITY_PROPS = new Set(["id", "src", "of"]);

type Counts = Record<string, number>;

function scrubText(s: string, counts: Counts): string | undefined {
  const r = redact(s);
  if (r.text === s) return undefined;
  for (const [kind, n] of Object.entries(r.counts)) counts[kind] = (counts[kind] ?? 0) + n;
  return r.text;
}

// The value a prop should hold after the scrub, or undefined when it needs no change.
function scrubValue(prop: string, value: unknown, counts: Counts): unknown {
  if (IDENTITY_PROPS.has(prop) || isDigestProp(prop, value)) return undefined;
  const snapshot = versionSnapshot(prop, value);
  if (snapshot) {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(snapshot)) {
      const nv = scrubValue(k, v, counts);
      changed ||= nv !== undefined;
      out[k] = nv === undefined ? v : nv;
    }
    return changed ? JSON.stringify(out) : undefined;
  }
  if (typeof value === "string") return scrubText(value, counts);
  if (Array.isArray(value) && value.some((v) => typeof v === "string")) {
    let changed = false;
    const out = value.map((v) => {
      const t = typeof v === "string" ? scrubText(v, counts) : undefined;
      changed ||= t !== undefined;
      return t ?? v;
    });
    return changed ? out : undefined;
  }
  return undefined;
}

function patchOf(kv: Array<[string, unknown]>, counts: Counts): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [prop, value] of kv) {
    const nv = scrubValue(prop, value, counts);
    if (nv !== undefined) patch[prop] = nv;
  }
  return patch;
}

export async function redactGraph(g: GraphHandle, opts: { dryRun?: boolean; pageSize?: number } = {}): Promise<ScrubReport> {
  const page = opts.pageSize ?? 500;
  const dryRun = opts.dryRun === true;
  const vec = [ENTITY_VECTOR_PROP, CHUNK_VECTOR_PROP];
  const byKind: Counts = {};
  const report: ScrubReport = { dryRun, nodes: 0, relationships: 0, props: 0, byKind };

  // Internal-id cursor with `>=` (FalkorDB returns no rows for `id(n) > -1`), ORDER BY ending in the unique id: the same
  // paging as scanGraph. Writes do not move internal ids, so the cursor holds while pages are rewritten.
  for (let cursor = 0; ;) {
    const rows = await g.roQuery<{ iid: number; kv: Array<[string, unknown]> }>(
      "MATCH (n) WHERE id(n) >= $cursor WITH n ORDER BY id(n) LIMIT $lim RETURN id(n) AS iid, [k IN keys(n) WHERE NOT k IN $vec | [k, n[k]]] AS kv",
      { cursor, lim: page, vec });
    for (const r of rows) {
      const patch = patchOf(r.kv, byKind);
      const n = Object.keys(patch).length;
      if (!n) continue;
      report.nodes++;
      report.props += n;
      if (!dryRun) await g.query("MATCH (n) WHERE id(n) = $iid SET n += $patch", { iid: r.iid, patch });
    }
    if (rows.length < page) break;
    cursor = rows[rows.length - 1]!.iid + 1;
  }

  for (let cursor = 0; ;) {
    const rows = await g.roQuery<{ iid: number; kv: Array<[string, unknown]> }>(
      "MATCH (a)-[r]->(b) WHERE id(r) >= $cursor WITH r ORDER BY id(r) LIMIT $lim RETURN id(r) AS iid, [k IN keys(r) WHERE NOT k IN $vec | [k, r[k]]] AS kv",
      { cursor, lim: page, vec });
    for (const r of rows) {
      const patch = patchOf(r.kv, byKind);
      const n = Object.keys(patch).length;
      if (!n) continue;
      report.relationships++;
      report.props += n;
      if (!dryRun) await g.query("MATCH ()-[r]->() WHERE id(r) = $iid SET r += $patch", { iid: r.iid, patch });
    }
    if (rows.length < page) break;
    cursor = rows[rows.length - 1]!.iid + 1;
  }
  return report;
}
