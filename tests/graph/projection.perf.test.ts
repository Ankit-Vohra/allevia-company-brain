// Timing guard for C1: at ~5k nodes with 384-d vectors and full indexes, closing one edge must not make algorithms
// slow (GRAPH.COPY rebuilt the vector indexes: seconds per call). Prints the real numbers.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { closeAll, connect, type GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { closeEdge } from "../../src/graph/upsert.js";
import { pageRank, components, shortestPaths } from "../../src/graph/algorithms.js";
import { testGraph } from "../helpers/graph.js";

const N = 5000;
const vec = () => Array.from({ length: 384 }, () => Math.round(Math.random() * 1000) / 1000);
const idOf = (i: number) => (i % 5 === 0 ? `chunk:${i}` : `task:${i}`);

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t = performance.now();
  const r = await fn();
  return [r, performance.now() - t];
}

describe(`projection cost at ${N} nodes (integration, timing)`, () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await ensureIndexes(g);
    for (let i = 0; i < N; i += 500) {
      const rows = Array.from({ length: Math.min(500, N - i) }, (_, k) => ({ i: i + k, v: vec() }));
      await g.query(`UNWIND $rows AS r
        FOREACH (_ IN CASE WHEN r.i % 5 = 0 THEN [1] ELSE [] END | CREATE (:Entity:Chunk {id: 'chunk:' + toString(r.i), name: 'c', text: 'chunk text', textEmbedding: vecf32(r.v)}))
        FOREACH (_ IN CASE WHEN r.i % 5 <> 0 THEN [1] ELSE [] END | CREATE (:Entity:Task {id: 'task:' + toString(r.i), name: 'task', summary: 's', embedding: vecf32(r.v)}))`, { rows });
    }
    // a guaranteed task chain 1 -> 2 -> 3 -> 4 plus 3N random edges
    const rows = [[1, 2], [2, 3], [3, 4]].map(([s, d]) => ({ s: idOf(s!), d: idOf(d!) }));
    for (let k = 0; k < 3 * N; k++) {
      const s = Math.floor(Math.random() * N), d = Math.floor(Math.random() * N);
      if (s !== d) rows.push({ s: idOf(s), d: idOf(d) });
    }
    for (let i = 0; i < rows.length; i += 5000) {
      await g.query("UNWIND $rows AS r MATCH (a:Entity {id:r.s}), (b:Entity {id:r.d}) CREATE (a)-[:BLOCKS {since: 1, recordedAt: 1}]->(b)",
        { rows: rows.slice(i, i + 5000) });
    }
    expect(await closeEdge(g, "task:1", "BLOCKS", "task:2", 5)).toBeGreaterThan(0);
  }, 120_000);
  afterAll(async () => {
    await cleanup();
    expect((await (await connect()).list()).filter((n) => n.startsWith(`${g.name}__`))).toEqual([]);
    await closeAll();
  });

  it("pageRank after a closed edge stays well under a second, and the cached projection is reused", async () => {
    const [first, build] = await timed(() => pageRank(g, "Entity"));
    const [, cached] = await timed(() => pageRank(g, "Entity"));
    const [, wcc] = await timed(() => components(g, ["Task"], ["BLOCKS"]));
    const [paths, asOf] = await timed(() => shortestPaths(g, "task:1", "task:4", { asOf: 6, relTypes: ["BLOCKS"] }));
    console.log(`[perf ${N} nodes, ~${3 * N} edges] pageRank 1st (builds projection): ${build.toFixed(0)} ms; ` +
      `cached: ${cached.toFixed(0)} ms; components (cached): ${wcc.toFixed(0)} ms; asOf path (per-call projection): ${asOf.toFixed(0)} ms`);
    expect(first.length).toBe(N - N / 5); // tasks only: chunks are not searchable
    expect(paths.length).toBeGreaterThan(0);
    expect(build).toBeLessThan(1000);
    expect(cached).toBeLessThan(250);
    expect(asOf).toBeLessThan(1000);
  });
});
