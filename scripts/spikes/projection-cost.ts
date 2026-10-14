// Probe: what does "current edges only" cost once an edge is closed? Builds a synthetic tenant (N nodes, 3N edges,
// 384-d vectors on entities and chunks, standard indexes), closes one edge, then times pageRank and an asOf path.
// Usage: npx tsx scripts/spikes/projection-cost.ts [nodes=20000]. Touches only graph allevia_spike_projcost.
import { openGraphByName, closeAll, listGraphs } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { closeEdge } from "../../src/graph/upsert.js";
import { pageRank, components, shortestPaths } from "../../src/graph/algorithms.js";

const N = Number(process.argv[2] ?? 20000);
const g = await openGraphByName("allevia_spike_projcost");
const vec = () => Array.from({ length: 384 }, () => Math.round(Math.random() * 1000) / 1000);
const time = async <T>(label: string, fn: () => Promise<T>) => {
  const t = performance.now();
  const r = await fn();
  console.log(`${label.padEnd(44)} ${(performance.now() - t).toFixed(0).padStart(6)} ms`);
  return r;
};
try {
  await g.drop();
  await ensureIndexes(g);
  await time(`create ${N} nodes (+vectors)`, async () => {
    for (let i = 0; i < N; i += 500) {
      const rows = Array.from({ length: Math.min(500, N - i) }, (_, k) => ({ i: i + k, v: vec() }));
      await g.query(`UNWIND $rows AS r
        FOREACH (_ IN CASE WHEN r.i % 5 = 0 THEN [1] ELSE [] END | CREATE (:Entity:Chunk {id: 'chunk:' + toString(r.i), name: 'c' + toString(r.i), text: 'chunk text ' + toString(r.i), textEmbedding: vecf32(r.v)}))
        FOREACH (_ IN CASE WHEN r.i % 5 <> 0 THEN [1] ELSE [] END | CREATE (:Entity:Task {id: 'task:' + toString(r.i), name: 'task ' + toString(r.i), summary: 'summary', embedding: vecf32(r.v)}))`, { rows });
    }
  });
  const idOf = (i: number) => (i % 5 === 0 ? `chunk:${i}` : `task:${i}`);
  await time(`create ${3 * N} edges`, async () => {
    for (let i = 0; i < 3 * N; i += 5000) {
      const rows = Array.from({ length: Math.min(5000, 3 * N - i) }, () => {
        const s = Math.floor(Math.random() * N), d = Math.floor(Math.random() * N);
        return { s: idOf(s), d: idOf(d === s ? (d + 1) % N : d), t: Math.random() < 0.5 ? 1 : 2 };
      });
      await g.query(`UNWIND $rows AS r MATCH (a:Entity {id:r.s}), (b:Entity {id:r.d})
        FOREACH (_ IN CASE WHEN r.t = 1 THEN [1] ELSE [] END | CREATE (a)-[:BLOCKS {since: 1, recordedAt: 1}]->(b))
        FOREACH (_ IN CASE WHEN r.t = 2 THEN [1] ELSE [] END | CREATE (a)-[:MENTIONS {since: 1, recordedAt: 1}]->(b))`, { rows });
    }
  });
  const [e] = await g.query<{ s: string; d: string }>("MATCH (a:Task)-[:BLOCKS]->(b:Task) RETURN a.id AS s, b.id AS d LIMIT 1");
  await time("pageRank, no closed edge", () => pageRank(g, "Entity"));
  await closeEdge(g, e!.s, "BLOCKS", e!.d, 5);
  await time("pageRank('Entity') after a closed edge (1st)", () => pageRank(g, "Entity"));
  await time("pageRank('Entity') again (cached if any)", () => pageRank(g, "Entity"));
  await time("components(Task, BLOCKS)", () => components(g, ["Task"], ["BLOCKS"]));
  await time("shortestPaths asOf (uncached)", () => shortestPaths(g, "task:1", "task:2", { asOf: 6 }));
  await time("read during: count(Task)", () => g.roQuery("MATCH (n:Task) RETURN count(n) AS c"));
} finally {
  await g.drop();
  const left = (await listGraphs()).filter((n) => n.startsWith("allevia_spike"));
  if (left.length) console.log("left behind:", left);
  await closeAll();
}
