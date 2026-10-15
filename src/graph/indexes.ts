// Indexes every tenant graph needs (spec §5.1): range on Entity.id (every MERGE/MATCH goes through it), range on the
// Observation properties every number read filters by, full-text on Searchable name+summary and Chunk text, vectors
// (384-d e5-small, cosine) on searchable entities and chunks. Idempotent. ensureIndexes() with no `specs` is the whole
// schema: it also runs the label/property backfills and the Entity.id constraints (migrate.ts).
//
// An index is chosen per label in the query pattern, so a lookup that drops `Entity` from `(n:Entity:Task {id:$id})`
// is a label scan: write the base label in every id anchor (tests/graph/explain.test.ts holds every query to it).
//
// Chunks carry the Entity label too (one id lookup for everything), but their vector lives in `textEmbedding`, not
// `embedding`: FalkorDB indexes per (label, property), so a chunk vector in `embedding` would also land in the Entity
// vector index and crowd real entities out of top-k. Use vectorPropFor(type) instead of hard-coding the name.
import type { GraphHandle } from "./client.js";
import { SEARCHABLE_LABEL, type EntityType } from "./schema.js";
import { ensureConstraints, migrateBeforeIndexes } from "./migrate.js";

export const VECTOR_DIM = 384;
export const ENTITY_VECTOR_PROP = "embedding";
export const CHUNK_VECTOR_PROP = "textEmbedding";

export function vectorPropFor(type: EntityType): string {
  return type === "Chunk" ? CHUNK_VECTOR_PROP : ENTITY_VECTOR_PROP;
}

export type IndexType = "RANGE" | "FULLTEXT" | "VECTOR";
export interface IndexSpec { label: string; prop: string; type: IndexType }

// Observation reads: a series is (subject, metric) ordered by asOf; `metricKey` is the lowercase metric (write it with
// metricKeyOf, never compare toLower(o.metric): a function of the property is not indexable). `metric` keeps the exact
// spelling for the detectors that match whole names.
export const INDEXES: IndexSpec[] = [
  { label: "Entity", prop: "id", type: "RANGE" },
  { label: "Observation", prop: "metric", type: "RANGE" },
  { label: "Observation", prop: "metricKey", type: "RANGE" },
  { label: "Observation", prop: "subject", type: "RANGE" },
  { label: "Observation", prop: "asOf", type: "RANGE" },
  { label: SEARCHABLE_LABEL, prop: "name", type: "FULLTEXT" },
  { label: SEARCHABLE_LABEL, prop: "summary", type: "FULLTEXT" },
  { label: "Chunk", prop: "text", type: "FULLTEXT" },
  { label: SEARCHABLE_LABEL, prop: ENTITY_VECTOR_PROP, type: "VECTOR" },
  { label: "Chunk", prop: CHUNK_VECTOR_PROP, type: "VECTOR" },
];

// The first generation of search indexes, on every Entity. They also hold what search never returns (one node per
// Observation, Version, Turn…), which crowds real entities out of the ranking and costs memory in proportion to the
// readings. Callers that still query 'Entity' (the agent's search, the pipeline's neighbour lookup) need them until
// they query SEARCHABLE_LABEL instead; then set KEEP_LEGACY_ENTITY_SEARCH to false, and dropLegacyEntityIndexes()
// removes them from existing graphs.
export const LEGACY_ENTITY_INDEXES: IndexSpec[] = [
  { label: "Entity", prop: "name", type: "FULLTEXT" },
  { label: "Entity", prop: "summary", type: "FULLTEXT" },
  { label: "Entity", prop: ENTITY_VECTOR_PROP, type: "VECTOR" },
];
export const KEEP_LEGACY_ENTITY_SEARCH = true;

// What ensureIndexes() creates when it is not given a list.
export const wantedIndexes = (): IndexSpec[] => (KEEP_LEGACY_ENTITY_SEARCH ? [...INDEXES, ...LEGACY_ENTITY_INDEXES] : INDEXES);

// Node indexes currently on the graph, one row per (label, prop, type). A graph that does not exist yet has none.
export async function listIndexes(g: GraphHandle): Promise<IndexSpec[]> {
  let rows: Array<{ label: string; types: Record<string, string[]>; entitytype: string }>;
  try {
    rows = await g.roQuery("CALL db.indexes() YIELD label, types, entitytype RETURN label, types, entitytype");
  } catch (e) {
    if (/empty key/i.test((e as Error).message)) return [];
    throw e;
  }
  return rows.filter((r) => r.entitytype === "NODE").flatMap((r) =>
    Object.entries(r.types).flatMap(([prop, types]) => types.map((type) => ({ label: r.label, prop, type: type as IndexType }))));
}

const already = (e: unknown) => /already indexed|already exists/i.test(String((e as Error).message));

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export async function ensureIndexes(g: GraphHandle, specs?: IndexSpec[]): Promise<void> {
  // Whole schema: the data is brought up to date first (labels and keys the indexes cover), the indexes follow, and the
  // constraints last (UNIQUE needs the Entity.id index). With an explicit list only those indexes are made.
  if (!specs) await migrateBeforeIndexes(g);
  await createIndexes(g, specs ?? wantedIndexes());
  if (!specs) {
    if (!KEEP_LEGACY_ENTITY_SEARCH) await dropLegacyEntityIndexes(g);
    await ensureConstraints(g);
  }
}

async function createIndexes(g: GraphHandle, specs: IndexSpec[]): Promise<void> {
  // label and prop are interpolated into DDL, so they must be plain identifiers
  for (const s of specs) {
    if (!IDENT.test(s.label) || !IDENT.test(s.prop)) throw new Error(`index label/prop must be plain identifiers, got ${s.label}.${s.prop}`);
    if (!["RANGE", "FULLTEXT", "VECTOR"].includes(s.type)) throw new Error(`unknown index type ${s.type}`);
  }
  const have = new Set((await listIndexes(g)).map((i) => `${i.label}|${i.prop}|${i.type}`));
  const missing = specs.filter((s) => !have.has(`${s.label}|${s.prop}|${s.type}`));
  // One full-text statement per label covers all its missing props.
  const ftByLabel = new Map<string, string[]>();
  for (const s of missing.filter((m) => m.type === "FULLTEXT")) ftByLabel.set(s.label, [...(ftByLabel.get(s.label) ?? []), s.prop]);
  const stmts = [
    ...missing.filter((s) => s.type === "RANGE").map((s) => `CREATE INDEX FOR (n:${s.label}) ON (n.${s.prop})`),
    ...[...ftByLabel].map(([label, props]) => `CREATE FULLTEXT INDEX FOR (n:${label}) ON (${props.map((p) => `n.${p}`).join(", ")})`),
    ...missing.filter((s) => s.type === "VECTOR").map((s) =>
      `CREATE VECTOR INDEX FOR (n:${s.label}) ON (n.${s.prop}) OPTIONS {dimension:${VECTOR_DIM}, similarityFunction:'cosine'}`),
  ];
  for (const cypher of stmts) {
    try {
      await g.query(cypher);
    } catch (e) {
      if (!already(e)) throw e; // a concurrent ensureIndexes got there first
    }
  }
}

// Drops the Entity-wide search indexes (LEGACY_ENTITY_INDEXES) from a graph, once nothing queries them. Idempotent.
export async function dropLegacyEntityIndexes(g: GraphHandle): Promise<number> {
  const have = new Set((await listIndexes(g)).map((i) => `${i.label}|${i.prop}|${i.type}`));
  let dropped = 0;
  for (const s of LEGACY_ENTITY_INDEXES) {
    if (!have.has(`${s.label}|${s.prop}|${s.type}`)) continue;
    await g.query(`DROP ${s.type} INDEX FOR (n:${s.label}) ON (n.${s.prop})`);
    dropped++;
  }
  return dropped;
}
