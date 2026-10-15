// Seeds a throwaway tenant with the synthetic seedMini company (tests/fixtures/seed-graph.ts) for live smoke runs of
// `npm run cli -- ask`. The graph is the one the CLI opens for that tenant (graphName: allevia_<tenant>), dropped and
// rebuilt each time. seedMini stores stand-in vectors; when the local e5 model is present they are replaced with real
// ones, so vector search behaves as it does on an ingested tenant. The tenant is not added to the registry.
// Usage: npx tsx scripts/seed-demo.ts [tenant]   (default demo_seed; refuses names that are not demo_* or *_seed)
import { closeAll, graphName, listGraphs, openGraph } from "../src/graph/client.js";
import { typeOfLabels } from "../src/graph/schema.js";
import { localEmbedder } from "../src/agent/wiring.js";
import { seedMini } from "../tests/fixtures/seed-graph.js";

const tenant = process.argv[2] ?? "demo_seed";
if (!/^demo_|_seed$/.test(tenant)) throw new Error(`refusing to reseed "${tenant}": only throwaway tenants (demo_* or *_seed)`);

async function realVectors(g: Awaited<ReturnType<typeof openGraph>>): Promise<number> {
  if (!(await localEmbedder())) return 0;
  const { embedPassages, entityText } = await import("../src/ingest/embed.js");
  const ents = await g.roQuery<{ id: string; labels: string[]; name: string; summary: string | null }>(
    "MATCH (n:Entity) WHERE n.embedding IS NOT NULL RETURN n.id AS id, labels(n) AS labels, n.name AS name, n.summary AS summary");
  const chunks = await g.roQuery<{ id: string; text: string }>("MATCH (c:Chunk) WHERE c.textEmbedding IS NOT NULL RETURN c.id AS id, c.text AS text");
  const ev = await embedPassages(ents.map((e) => entityText({ name: e.name, type: typeOfLabels(e.labels) ?? "Document", ...(e.summary ? { summary: e.summary } : {}) })));
  const cv = await embedPassages(chunks.map((c) => c.text));
  await g.query("UNWIND $rows AS r MATCH (n:Entity {id: r.id}) SET n.embedding = vecf32(r.v)", { rows: ents.map((e, i) => ({ id: e.id, v: ev[i]! })) });
  await g.query("UNWIND $rows AS r MATCH (c:Chunk {id: r.id}) SET c.textEmbedding = vecf32(r.v)", { rows: chunks.map((c, i) => ({ id: c.id, v: cv[i]! })) });
  return ents.length + chunks.length;
}

try {
  const name = graphName(tenant);
  const g = await openGraph(tenant);
  if ((await listGraphs()).includes(name)) await g.drop();
  await seedMini(g);
  const [row] = await g.roQuery<{ n: number }>("MATCH (n:Entity) RETURN count(n) AS n");
  const vectors = await realVectors(g);
  console.log(`Seeded ${name}: ${row?.n ?? 0} nodes; ${vectors ? `${vectors} real e5 vectors` : "stand-in vectors (no local model)"}.`);
} finally {
  await closeAll();
}
