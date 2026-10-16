// Replaces a demo graph's stand-in vectors with real local e5 ones when the model is present, so vector search behaves as
// it does on an ingested business. Returns how many vectors were written (0: no local model, the stand-ins stay).
import type { GraphHandle } from "../graph/client.js";
import { typeOfLabels } from "../graph/schema.js";

export async function realVectors(g: GraphHandle): Promise<number> {
  const { localEmbedder } = await import("../agent/wiring.js");
  if (!(await localEmbedder())) return 0;
  const { embedPassages, entityText } = await import("../ingest/embed.js");
  const ents = await g.roQuery<{ id: string; labels: string[]; name: string; summary: string | null }>(
    "MATCH (n:Entity) WHERE n.embedding IS NOT NULL RETURN n.id AS id, labels(n) AS labels, n.name AS name, n.summary AS summary");
  const chunks = await g.roQuery<{ id: string; text: string }>("MATCH (c:Chunk) WHERE c.textEmbedding IS NOT NULL RETURN c.id AS id, c.text AS text");
  const ev = await embedPassages(ents.map((e) => entityText({ name: e.name, type: typeOfLabels(e.labels) ?? "Document", ...(e.summary ? { summary: e.summary } : {}) })));
  const cv = await embedPassages(chunks.map((c) => c.text));
  await g.query("UNWIND $rows AS r MATCH (n:Entity {id: r.id}) SET n.embedding = vecf32(r.v)", { rows: ents.map((e, i) => ({ id: e.id, v: ev[i]! })) });
  await g.query("UNWIND $rows AS r MATCH (c:Entity:Chunk {id: r.id}) SET c.textEmbedding = vecf32(r.v)", { rows: chunks.map((c, i) => ({ id: c.id, v: cv[i]! })) });
  return ents.length + chunks.length;
}
