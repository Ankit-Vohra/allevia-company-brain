// Schema evolution for a tenant graph. Every step is idempotent and cheap once done, so ensureIndexes runs them all on
// every call (tenant creation, every ingest) and a graph written by older code converges without a separate migration
// command:
//   1. backfillSearchable  - nodes of a SEARCHABLE type get the `Searchable` label (the full-text and vector indexes live on it)
//   2. backfillMetricKey   - Observations get `metricKey`, the lowercase metric every metric read compares (and indexes)
//   3. ensureConstraints   - UNIQUE and MANDATORY on Entity.id, after merging any duplicate ids already in the graph
// The order matters: labels and properties are in place before the indexes that cover them are built, and duplicates
// are gone before the UNIQUE constraint is asked to hold (it would otherwise end FAILED and the graph go unprotected).
import { MAX_PAGE, type ConstraintInfo, type GraphHandle } from "./client.js";
import { SEARCHABLE, SEARCHABLE_LABEL, metricKeyOf } from "./schema.js";
import { noteGraphWrite } from "./projection.js";

const log = (msg: string) => console.error(`[graph] ${msg}`);

// Does this graph hold any Entity at all? (A graph that was never written does not exist as a key, and a fresh one has
// nothing to migrate.) Label counts are read from the label matrix, so this is cheap on any size.
async function hasEntities(g: GraphHandle): Promise<boolean> {
  try {
    return ((await g.roQuery<{ c: number }>("MATCH (n:Entity) RETURN count(n) AS c"))[0]?.c ?? 0) > 0;
  } catch (e) {
    if (/empty key/i.test(String((e as Error).message))) return false;
    throw e;
  }
}

// One statement per type, so each is a scan of that label only (not of the whole graph, which holds a node per reading).
export async function backfillSearchable(g: GraphHandle): Promise<number> {
  if (!(await hasEntities(g))) return 0;
  let labelled = 0;
  for (const type of SEARCHABLE) {
    const rows = await g.query<{ c: number }>(
      `MATCH (n:${type}) WHERE NOT n:${SEARCHABLE_LABEL} SET n:${SEARCHABLE_LABEL} RETURN count(n) AS c`);
    labelled += rows[0]?.c ?? 0;
  }
  return labelled;
}

// Lowercased in TypeScript (metricKeyOf), the same function writeObservation uses, so a key never depends on how the
// server lowercases. Paged: each page is one write of at most MAX_PAGE nodes.
export async function backfillMetricKey(g: GraphHandle): Promise<number> {
  if (!(await hasEntities(g))) return 0;
  let keyed = 0;
  for (let guard = 0; guard < 100_000; guard++) {
    const rows = await g.roQuery<{ id: string; m: string }>(
      "MATCH (o:Observation) WHERE o.metricKey IS NULL AND o.metric IS NOT NULL RETURN o.id AS id, o.metric AS m LIMIT $n", { n: MAX_PAGE });
    if (!rows.length) return keyed;
    const done = await g.query<{ c: number }>(
      "UNWIND $rows AS r MATCH (o:Entity {id:r.id}) SET o.metricKey = r.k RETURN count(o) AS c",
      { rows: rows.map((r) => ({ id: r.id, k: metricKeyOf(String(r.m)) })) });
    const c = done[0]?.c ?? 0;
    if (!c) throw new Error(`backfillMetricKey: ${rows.length} observations without a metricKey could not be updated`);
    keyed += c;
  }
  throw new Error("backfillMetricKey: did not converge");
}

// ---- constraints ---------------------------------------------------------------------------------------------------

export const ENTITY_ID_CONSTRAINTS: Array<Pick<ConstraintInfo, "type" | "label"> & { prop: string }> = [
  { type: "UNIQUE", label: "Entity", prop: "id" },
  { type: "MANDATORY", label: "Entity", prop: "id" },
];

export interface DuplicateGroup { id: string; count: number }
export interface ConstraintReport {
  // type -> final status; "skipped" when something in the data stops us creating it (see `problems`)
  status: Record<string, ConstraintInfo["status"] | "skipped">;
  merged: number;                 // duplicate nodes folded into the oldest node with their id
  problems: string[];             // what a person has to look at (also logged)
}

const REL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SKIP_PROPS = new Set(["id", "embedding", "textEmbedding"]); // an id is already equal; vectors cannot round-trip through properties()
const labelsOf = (labels: string[]): string => labels.filter((l) => l !== SEARCHABLE_LABEL).sort().join(":");

export async function findDuplicateIds(g: GraphHandle, limit = 1000): Promise<DuplicateGroup[]> {
  const rows = await g.roQuery<{ id: string; c: number }>(
    "MATCH (n:Entity) WHERE n.id IS NOT NULL WITH n.id AS id, count(n) AS c WHERE c > 1 RETURN id, c ORDER BY id LIMIT $limit", { limit });
  return rows.map((r) => ({ id: r.id, count: r.c }));
}

// Folds the nodes that share `id` into the oldest one (the lowest internal id): edges are copied onto it with their
// properties (an edge between two copies is dropped, it would be a loop), properties it lacks are filled from the
// others, and the extra nodes are deleted. Only when every copy has the same type label; a duplicate of two types is a
// bug in a writer, not something to guess about, so it throws and a person decides. Returns the nodes removed.
export async function mergeDuplicateNodes(g: GraphHandle, id: string): Promise<number> {
  const copies = await g.query<{ nid: number; labels: string[]; props: Record<string, unknown> }>(
    "MATCH (n:Entity {id:$id}) RETURN id(n) AS nid, labels(n) AS labels, properties(n) AS props ORDER BY nid", { id });
  if (copies.length < 2) return 0;
  const [keeper, ...extra] = copies as [typeof copies[number], ...typeof copies];
  const kinds = new Set(copies.map((c) => labelsOf(c.labels)));
  if (kinds.size > 1) throw new Error(`${id} exists as ${[...kinds].join(" and ")}: not merged (two types under one id)`);
  const fill: Record<string, unknown> = {};
  for (const c of extra) for (const [k, v] of Object.entries(c.props)) if (!SKIP_PROPS.has(k) && keeper.props[k] == null && fill[k] == null && v != null) fill[k] = v;
  if (Object.keys(fill).length) await g.query("MATCH (k) WHERE id(k) = $kid SET k += $fill", { kid: keeper.nid, fill });
  if (copies.some((c) => c.labels.includes(SEARCHABLE_LABEL)) && !keeper.labels.includes(SEARCHABLE_LABEL)) {
    await g.query(`MATCH (k) WHERE id(k) = $kid SET k:${SEARCHABLE_LABEL}`, { kid: keeper.nid });
  }
  const copyIds = copies.map((c) => c.nid);
  for (const dup of extra) {
    for (const dir of ["out", "in"] as const) {
      const edges = await g.query<{ t: string; x: number; p: Record<string, unknown> }>(
        dir === "out"
          ? "MATCH (d)-[r]->(x) WHERE id(d) = $did AND NOT id(x) IN $copies RETURN type(r) AS t, id(x) AS x, properties(r) AS p ORDER BY id(r)"
          : "MATCH (d)<-[r]-(x) WHERE id(d) = $did AND NOT id(x) IN $copies RETURN type(r) AS t, id(x) AS x, properties(r) AS p ORDER BY id(r)",
        { did: dup.nid, copies: copyIds });
      for (const t of new Set(edges.map((e) => e.t))) {
        if (!REL_NAME.test(t)) throw new Error(`relationship type ${JSON.stringify(t)} is not a plain identifier`);
        await g.query(
          `UNWIND $rows AS row MATCH (k) WHERE id(k) = $kid MATCH (x) WHERE id(x) = row.x ` +
          (dir === "out" ? `CREATE (k)-[r:${t}]->(x)` : `CREATE (x)-[r:${t}]->(k)`) + ` SET r += row.p`,
          { kid: keeper.nid, rows: edges.filter((e) => e.t === t).map((e) => ({ x: e.x, p: e.p })) });
      }
    }
    await g.query("MATCH (d) WHERE id(d) = $did DETACH DELETE d", { did: dup.nid });
  }
  await noteGraphWrite(g.name);
  return extra.length;
}

async function settle(g: GraphHandle, timeoutMs: number): Promise<ConstraintInfo[]> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const have = (await g.constraints()).filter((c) => c.label === "Entity" && c.props.length === 1 && c.props[0] === "id");
    if (!have.some((c) => c.status === "PENDING") || Date.now() > end) return have;
    await new Promise((r) => setTimeout(r, 25));
  }
}

const already = (e: unknown) => /already|exist/i.test(String((e as Error).message));

// UNIQUE and MANDATORY on Entity.id. FalkorDB builds a constraint in the background and marks it FAILED when the data
// already breaks it, so this repairs the data first (merging duplicate ids, reporting nodes without an id), drops a
// FAILED constraint left by an earlier attempt, creates what is missing, and waits for the result. Never throws on
// data problems: it logs them and returns them, so an ingest is not blocked by a graph that needs a person.
export async function ensureConstraints(g: GraphHandle, opts: { timeoutMs?: number } = {}): Promise<ConstraintReport> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const report: ConstraintReport = { status: {}, merged: 0, problems: [] };
  if (!(await hasEntities(g))) {
    // nothing to repair: create straight away (an empty graph is OPERATIONAL at once)
    for (const c of ENTITY_ID_CONSTRAINTS) {
      try { await g.createConstraint(c.type, c.label, c.prop); } catch (e) { if (!already(e)) throw e; }
    }
  } else {
    let have = await settle(g, timeoutMs);
    const status = (type: string) => have.find((c) => c.type === type)?.status;
    // a FAILED constraint stays listed and blocks a new one: clear it so the retry below is real
    for (const c of ENTITY_ID_CONSTRAINTS) if (status(c.type) === "FAILED") await g.dropConstraint(c.type, c.label, c.prop);
    have = have.filter((c) => c.status !== "FAILED");
    const need = (type: string) => !have.some((c) => c.type === type);

    if (need("UNIQUE")) {
      for (const d of await findDuplicateIds(g)) {
        try {
          report.merged += await mergeDuplicateNodes(g, d.id);
        } catch (e) {
          report.problems.push(`duplicate id ${d.id} (${d.count} nodes): ${(e as Error).message}`);
        }
      }
    }
    const missingId = need("MANDATORY")
      ? (await g.roQuery<{ c: number }>("MATCH (n:Entity) WHERE n.id IS NULL RETURN count(n) AS c"))[0]?.c ?? 0
      : 0;
    if (missingId) report.problems.push(`${missingId} Entity nodes have no id`);
    for (const c of ENTITY_ID_CONSTRAINTS) {
      if (!need(c.type)) continue;
      if (c.type === "UNIQUE" && report.problems.some((p) => p.startsWith("duplicate id"))) { report.status.UNIQUE = "skipped"; continue; }
      if (c.type === "MANDATORY" && missingId) { report.status.MANDATORY = "skipped"; continue; }
      try { await g.createConstraint(c.type, c.label, c.prop); } catch (e) { if (!already(e)) throw e; }
    }
  }
  const final = await settle(g, timeoutMs);
  for (const c of ENTITY_ID_CONSTRAINTS) {
    const f = final.find((x) => x.type === c.type);
    if (f) report.status[c.type] = f.status;
    if (f?.status === "FAILED") {
      report.problems.push(`${c.type} constraint on ${c.label}.${c.prop} failed to build`);
      await g.dropConstraint(c.type, c.label, c.prop).catch(() => undefined); // leave nothing FAILED behind: the next call retries
    } else if (f?.status === "PENDING") report.problems.push(`${c.type} constraint on ${c.label}.${c.prop} still building after ${timeoutMs} ms`);
  }
  for (const p of report.problems) log(`${g.name}: ${p}`);
  return report;
}

// Everything above, in order. ensureIndexes calls this around its index creation (see indexes.ts).
export async function migrateBeforeIndexes(g: GraphHandle): Promise<{ searchable: number; metricKeys: number }> {
  return { searchable: await backfillSearchable(g), metricKeys: await backfillMetricKey(g) };
}
