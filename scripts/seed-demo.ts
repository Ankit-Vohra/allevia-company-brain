// Seeds a throwaway tenant with the synthetic seedMini company (tests/fixtures/seed-graph.ts) for live smoke runs of
// `npm run cli -- ask`. The graph is the one the CLI opens for that tenant (graphName: allevia_<tenant>), dropped and
// rebuilt each time. seedMini stores stand-in vectors; when the local e5 model is present they are replaced with real
// ones, so vector search behaves as it does on an ingested tenant. The tenant is added to the registry (allevia_meta)
// only with --register, so the web app lists it and `enroll` can start its program (the Docker quick start does this).
// Usage: npx tsx scripts/seed-demo.ts [tenant] [--register]   (default demo_seed; refuses names that are not demo_* or *_seed)
import { closeAll, graphName, listGraphs, openGraph } from "../src/graph/client.js";
import { typeOfLabels } from "../src/graph/schema.js";
import { ensureTenant } from "../src/graph/tenants.js";
import { localEmbedder } from "../src/agent/wiring.js";
import { seedMini } from "../tests/fixtures/seed-graph.js";

const args = process.argv.slice(2);
const register = args.includes("--register");
const tenant = args.find((a) => !a.startsWith("--")) ?? "demo_seed";
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
  if (register) {
    const display = tenant.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" "); // demo_seed -> Demo Seed
    await ensureTenant({ slug: tenant, name: display, domain: "demo.example", industry: "jobs platform (synthetic demo data)", city: "Raipur" });
    console.log(`Registered "${display}" (${tenant}) in the tenant registry.`);
  }
} finally {
  await closeAll();
}
