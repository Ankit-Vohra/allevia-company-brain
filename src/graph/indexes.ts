// Indexes every tenant graph needs (spec §5.1): range on Entity.id (every MERGE/MATCH goes through it), full-text on
// Entity name+summary and Chunk text, vectors (384-d e5-small, cosine) on entities and chunks. Idempotent.
//
// Chunks carry the Entity label too (one id lookup for everything), but their vector lives in `textEmbedding`, not
// `embedding`: FalkorDB indexes per (label, property), so a chunk vector in `embedding` would also land in the Entity
// vector index and crowd real entities out of top-k. Use vectorPropFor(type) instead of hard-coding the name.
import type { GraphHandle } from "./client.js";
import type { EntityType } from "./schema.js";

export const VECTOR_DIM = 384;
export const ENTITY_VECTOR_PROP = "embedding";
export const CHUNK_VECTOR_PROP = "textEmbedding";

export function vectorPropFor(type: EntityType): string {
  return type === "Chunk" ? CHUNK_VECTOR_PROP : ENTITY_VECTOR_PROP;
}

export type IndexType = "RANGE" | "FULLTEXT" | "VECTOR";
export interface IndexSpec { label: string; prop: string; type: IndexType }

export const INDEXES: IndexSpec[] = [
  { label: "Entity", prop: "id", type: "RANGE" },
  { label: "Entity", prop: "name", type: "FULLTEXT" },
  { label: "Entity", prop: "summary", type: "FULLTEXT" },
  { label: "Chunk", prop: "text", type: "FULLTEXT" },
  { label: "Entity", prop: ENTITY_VECTOR_PROP, type: "VECTOR" },
  { label: "Chunk", prop: CHUNK_VECTOR_PROP, type: "VECTOR" },
];

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

export async function ensureIndexes(g: GraphHandle, specs: IndexSpec[] = INDEXES): Promise<void> {
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
