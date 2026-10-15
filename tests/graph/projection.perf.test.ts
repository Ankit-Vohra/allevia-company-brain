// Scale and timing guard. FalkorDB caps every result at RESULTSET_SIZE (10,000 rows on our servers) and drops the rest
// SILENTLY, so this graph is bigger than that in nodes, in edges and in per-node algorithm rows, and every count below
// is exact. It also guards C1: with 384-d vectors and full indexes, closing one edge must not make algorithms slow
// (GRAPH.COPY rebuilt the vector indexes: seconds per call). Seeded, so every run builds the same graph. Prints the real
// numbers.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { closeAll, connect, type GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { closeEdge } from "../../src/graph/upsert.js";
import { onEdgesValidAt } from "../../src/graph/projection.js";
import { pageRank, components, shortestPaths } from "../../src/graph/algorithms.js";
import { testGraph } from "../helpers/graph.js";

const N = 12_000;            // nodes: every 10th is a Chunk (not searchable), the rest are Tasks
const TASKS = N - N / 10;    // 10,800: more rows than one result can hold
const RANDOM = 3 * N;        // seeded random BLOCKS edges, valid from 1
const FUTURE = 500;          // seeded random BLOCKS edges valid from 10 on: current, but not at asOf 3 or 6
const idOf = (i: number) => (i % 10 === 0 ? `chunk:${i}` : `task:${i}`);

// mulberry32: a tiny seeded PRNG
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t = performance.now();
  const r = await fn();
  return [r, performance.now() - t];
}

describe(`projection past RESULTSET_SIZE: ${N} nodes, ~${RANDOM} edges (integration, timing)`, () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  let total = 0;  // edges in the source
  let closed = 0; // edges closed at 5
  let future = 0; // edges valid from 10
  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await ensureIndexes(g);
    const rand = rng(42);
    const vec = () => Array.from({ length: 384 }, () => Math.round(rand() * 1000) / 1000);
    for (let i = 0; i < N; i += 500) {
      const rows = Array.from({ length: Math.min(500, N - i) }, (_, k) => ({ i: i + k, v: vec() }));
      await g.query(`UNWIND $rows AS r
        FOREACH (_ IN CASE WHEN r.i % 10 = 0 THEN [1] ELSE [] END | CREATE (:Entity:Chunk {id: 'chunk:' + toString(r.i), name: 'c', text: 'chunk text', textEmbedding: vecf32(r.v)}))
        FOREACH (_ IN CASE WHEN r.i % 10 <> 0 THEN [1] ELSE [] END | CREATE (:Entity:Task {id: 'task:' + toString(r.i), name: 'task', summary: 's', embedding: vecf32(r.v)}))`, { rows });
    }
    // A guaranteed chain task:1 -> 2 -> 3 -> 4 (valid from 1, never closed), a shortcut task:1 -> 4 (closed at 5 below),
    // then the random edges.
    const rows = [[1, 2], [2, 3], [3, 4], [1, 4]].map(([s, d]) => ({ s: idOf(s!), d: idOf(d!), since: 1 }));
    const pair = (since: number) => {
      const s = Math.floor(rand() * N), d = Math.floor(rand() * N);
      if (s !== d) rows.push({ s: idOf(s), d: idOf(d), since });
      return s !== d;
    };
    for (let k = 0; k < RANDOM; k++) pair(1);
    for (let k = 0; k < FUTURE; k++) if (pair(10)) future++;
    for (let i = 0; i < rows.length; i += 5000) {
      await g.query("UNWIND $rows AS r MATCH (a:Entity {id:r.s}), (b:Entity {id:r.d}) CREATE (a)-[:BLOCKS {since: r.since, recordedAt: 1}]->(b)",
        { rows: rows.slice(i, i + 5000) });
    }
    total = rows.length;
    closed = await closeEdge(g, "task:1", "BLOCKS", "task:4", 5); // the shortcut, and any random copy of it
    expect(closed).toBeGreaterThan(0);
  }, 180_000);
  afterAll(async () => {
    await cleanup();
    expect((await (await connect()).list()).filter((n) => n.startsWith(`${g.name}__`))).toEqual([]);
    await closeAll();
  });

  const counts = async (h: GraphHandle) => ({
    nodes: (await h.roQuery<{ c: number }>("MATCH (n) RETURN count(n) AS c"))[0]!.c,
    edges: (await h.roQuery<{ c: number }>("MATCH ()-[r]->() RETURN count(r) AS c"))[0]!.c,
  });

  it("projects every node and every valid edge past RESULTSET_SIZE, exactly", async () => {
    expect(total).toBeGreaterThan(30_000);
    expect(await counts(g)).toEqual({ nodes: N, edges: total });
    const [cur, build] = await timed(() => onEdgesValidAt(g, undefined, [], async (h) => ({ name: h.name, ...(await counts(h)) })));
    expect(cur).toEqual({ name: expect.stringContaining("__cur_"), nodes: N, edges: total - closed });
    const [then, asOfBuild] = await timed(() => onEdgesValidAt(g, 6, [], async (h) => ({ name: h.name, ...(await counts(h)) })));
    expect(then).toEqual({ name: expect.stringContaining("__asof_"), nodes: N, edges: total - closed - future });
    console.log(`[perf ${N} nodes, ${total} edges] current projection build: ${build.toFixed(0)} ms; ` +
      `asOf projection build: ${asOfBuild.toFixed(0)} ms`);
  });

  it("returns a row for every task from the per-node algorithms (more than one result holds)", async () => {
    const ranks = await pageRank(g, "Entity"); // tasks only: chunks are not searchable
    expect(ranks).toHaveLength(TASKS);
    expect(new Set(ranks.map((r) => r.id)).size).toBe(TASKS);
    expect(ranks.every((r, i) => i === 0 || ranks[i - 1]!.score >= r.score)).toBe(true);
    const wcc = await components(g, ["Task"], ["BLOCKS"]);
    expect(wcc).toHaveLength(TASKS);
    expect(new Set(wcc.map((c) => c.id)).size).toBe(TASKS);
  });

  it("finds the path that held at asOf, through a per-call projection of the whole graph", async () => {
    // At 3 the shortcut held (1..5): it is the shortest path. At 6 it had closed, and the chain still holds.
    const at3 = await shortestPaths(g, "task:1", "task:4", { asOf: 3, relTypes: ["BLOCKS"], maxPaths: 10 });
    expect(at3[0]!.length).toBe(1);
    expect(at3.some((p) => p.length === 1 && p.edges[0]!.from === "task:1" && p.edges[0]!.until === 5)).toBe(true);
    const at6 = await shortestPaths(g, "task:1", "task:4", { asOf: 6, relTypes: ["BLOCKS"], maxPaths: 10 });
    expect(at6.length).toBeGreaterThan(0);
    expect(at6[0]!.length).toBeLessThanOrEqual(3);
    for (const p of at6) for (const e of p.edges) expect((e.since ?? 0) <= 6 && (e.until === null || e.until! > 6)).toBe(true);
    // and now (no asOf): closed edges are never on a path
    const now = await shortestPaths(g, "task:1", "task:4", { relTypes: ["BLOCKS"], maxPaths: 10 });
    expect(now.length).toBeGreaterThan(0);
    for (const p of now) for (const e of p.edges) expect(e.until).toBeNull();
  });

  it("stays fast after a closed edge, and reuses the cached projection", async () => {
    const [, build] = await timed(() => pageRank(g, "Entity")); // cached by the tests above unless the TTL ran out
    const [, cached] = await timed(() => pageRank(g, "Entity"));
    const [, wcc] = await timed(() => components(g, ["Task"], ["BLOCKS"]));
    const [paths, asOf] = await timed(() => shortestPaths(g, "task:1", "task:4", { asOf: 6, relTypes: ["BLOCKS"] }));
    console.log(`[perf ${N} nodes, ${total} edges] pageRank: ${build.toFixed(0)} ms; again (cached): ${cached.toFixed(0)} ms; ` +
      `components (cached): ${wcc.toFixed(0)} ms; asOf path (per-call projection): ${asOf.toFixed(0)} ms`);
    expect(paths.length).toBeGreaterThan(0);
    expect(cached).toBeLessThan(1000);
    expect(asOf).toBeLessThan(5000);
  });

  it("gives up with a timeout error when the budget is too small, and leaves no projection behind", async () => {
    await expect(pageRank(g, "Entity", undefined, { timeoutMs: 1 })).rejects.toThrow(/timed out/i);
    await expect(shortestPaths(g, "task:1", "task:4", { asOf: 6, timeoutMs: 1 })).rejects.toThrow(/timed out/i);
    expect((await (await connect()).list()).filter((n) => n.startsWith(`${g.name}__asof_`))).toEqual([]);
    await expect(components(g, ["Task"], [], { timeoutMs: 0 })).rejects.toThrow(/positive/);
  });
});
