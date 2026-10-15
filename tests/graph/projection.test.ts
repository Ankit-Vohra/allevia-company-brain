import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { closeAll, connect, listGraphs, openGraphByName, MAX_PAGE, type GraphHandle } from "../../src/graph/client.js";
import {
  projectionName, isProjectionName, sweepProjections, onEdgesValidAt, noteGraphWrite, writeStampKey,
} from "../../src/graph/projection.js";
import { ProjectionMismatch } from "../../src/graph/errors.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { upsertNode, upsertEdge, closeEdge } from "../../src/graph/upsert.js";
import { components, pageRank } from "../../src/graph/algorithms.js";
import { testGraph } from "../helpers/graph.js";

const T0 = 1_760_000_000_000;
const rawList = async () => (await connect()).list();
const redis = async () => (await connect()).connection;
const stampOf = async (name: string) => (await redis()).get(writeStampKey(name));
const children = async (g: GraphHandle, kind = "") => (await rawList()).filter((n) => n.startsWith(`${g.name}__${kind}`));
const groups = (cs: Array<{ id: string; componentId: number }>) => {
  const m = new Map<number, string[]>();
  for (const c of cs) m.set(c.componentId, [...(m.get(c.componentId) ?? []), c.id]);
  return [...m.values()].map((ids) => ids.sort()).sort((a, b) => b.length - a.length || a[0]!.localeCompare(b[0]!));
};

describe("projections (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    for (const id of ["task:a", "task:b", "task:c"]) await upsertNode(g, { type: "Task", id, name: id }, T0);
    await upsertEdge(g, { from: "task:a", type: "BLOCKS", to: "task:b" }, T0);
  });
  afterAll(async () => {
    await cleanup();
    expect(await children(g)).toEqual([]); // dropping a graph takes its projections along
    expect(await stampOf(g.name)).toBeNull(); // and its write stamp
    await closeAll();
  });

  it("names projections, hides them from listGraphs and sweeps only stale ones", async () => {
    const fresh = projectionName(g.name, "cur");
    expect(fresh.startsWith(`${g.name}__cur_`) && isProjectionName(fresh)).toBe(true);
    expect(isProjectionName(projectionName(g.name, "asof"))).toBe(true);
    expect(isProjectionName(g.name)).toBe(false);
    const stale = projectionName(g.name, "asof", Date.now() - 60 * 60_000);
    for (const name of [fresh, stale]) await (await openGraphByName(name)).query("CREATE (:X)");
    expect(await rawList()).toEqual(expect.arrayContaining([fresh, stale]));
    const listed = await listGraphs();
    expect(listed).not.toContain(fresh);
    expect(listed).not.toContain(stale);
    const dropped = await sweepProjections();
    expect(dropped).toContain(stale);
    expect(dropped).not.toContain(fresh); // could belong to a live algorithm call in another process
    expect(await rawList()).not.toContain(stale);
    await (await openGraphByName(fresh)).drop();
  });

  it("caches the current projection and rebuilds it after a write", async () => {
    expect(groups(await components(g, ["Task"], ["BLOCKS"]))).toEqual([["task:a", "task:b"], ["task:c"]]);
    const first = await children(g, "cur_");
    expect(first).toHaveLength(1);
    await pageRank(g, "Task", "BLOCKS");
    expect(await children(g, "cur_")).toEqual(first); // reused, not rebuilt
    await upsertEdge(g, { from: "task:b", type: "BLOCKS", to: "task:c" }, T0 + 1);
    expect(groups(await components(g, ["Task"], ["BLOCKS"]))).toEqual([["task:a", "task:b", "task:c"]]);
    const second = await children(g, "cur_");
    expect(second).toHaveLength(1); // the superseded one was dropped once nobody used it
    expect(second).not.toEqual(first);
  });

  it("sees writes that bypass upsert only after noteGraphWrite", async () => {
    await g.query("CREATE (:Entity:Task {id:'task:raw', name:'raw'})");
    expect((await components(g, ["Task"], [])).map((c) => c.id)).not.toContain("task:raw");
    await noteGraphWrite(g.name);
    expect((await components(g, ["Task"], [])).map((c) => c.id)).toContain("task:raw");
  });

  it("sees a write stamped by another process on its next use (no TTL wait)", async () => {
    await components(g, ["Task"], []); // cached
    const cached = await children(g, "cur_");
    expect(cached).toHaveLength(1);
    // Another process (a CLI ingest) writes and stamps the graph: this process's counter does not move.
    await g.query("CREATE (:Entity:Task {id:'task:other-process', name:'x'})");
    expect(await stampOf(g.name)).not.toBeNull();
    await (await redis()).set(writeStampKey(g.name), "written-by-another-process");
    expect((await components(g, ["Task"], [])).map((c) => c.id)).toContain("task:other-process");
    expect(await children(g, "cur_")).not.toEqual(cached);
  });

  it("drops a per-call asOf projection even when the algorithm throws", async () => {
    expect(await closeEdge(g, "task:a", "BLOCKS", "task:b", T0 + 100)).toBe(1);
    await expect(onEdgesValidAt(g, T0 + 200, [], async (h) => {
      expect(h.name).toContain("__asof_");
      expect(await h.roQuery("MATCH ()-[r]->() RETURN count(r) AS c")).toEqual([{ c: 1 }]); // only b -> c held then
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(await children(g, "asof_")).toEqual([]);
  });

  it("keeps the cached projection when an algorithm throws", async () => {
    await expect(onEdgesValidAt(g, undefined, [], async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await children(g, "cur_")).toHaveLength(1);
  });

  it("rebuilds when the cached projection vanished under it (swept or dropped elsewhere)", async () => {
    const [cached] = await children(g, "cur_");
    await (await openGraphByName(cached!)).drop();
    expect(groups(await components(g, ["Task"], ["BLOCKS"]))).toEqual([["task:b", "task:c"], ["task:a"], ["task:other-process"], ["task:raw"]]);
    expect(await children(g, "cur_")).toHaveLength(1);
  });

  it("throws ProjectionMismatch instead of running on a truncated read", async () => {
    // A handle whose edge pages lose their last row, the way FalkorDB drops rows past RESULTSET_SIZE.
    const truncating = new Proxy(g, {
      get(t, k) {
        if (k === "roQuery") {
          return async (cypher: string, params?: Record<string, unknown>, opts?: { timeoutMs?: number }) => {
            const rows = await t.roQuery(cypher, params, opts);
            return /ORDER BY rid/.test(cypher) ? rows.slice(0, -1) : rows;
          };
        }
        const v = Reflect.get(t, k, t);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    await expect(onEdgesValidAt(truncating, T0 + 200, [], async () => "ran")).rejects.toBeInstanceOf(ProjectionMismatch);
    expect(await children(g, "asof_")).toEqual([]);
  });

  it("projects a graph bigger than one page, exactly", async () => {
    const big = await testGraph();
    try {
      const n = MAX_PAGE * 2 + 7; // a ring: n nodes, n edges, three pages of each
      await big.g.query("UNWIND range(0, $n - 1) AS i CREATE (:Entity:Task {id: 'task:' + toString(i), name: 't', i: i})", { n });
      await big.g.query("MATCH (a:Task) MATCH (b:Task) WHERE b.i = (a.i + 1) % $n CREATE (a)-[:BLOCKS {since: 1}]->(b)", { n });
      const seen = await onEdgesValidAt(big.g, undefined, [], async (h) => ({
        nodes: (await h.roQuery<{ c: number }>("MATCH (x) RETURN count(x) AS c"))[0]!.c,
        edges: (await h.roQuery<{ c: number }>("MATCH ()-[r]->() RETURN count(r) AS c"))[0]!.c,
      }));
      expect(seen).toEqual({ nodes: n, edges: n });
      const ring = await components(big.g, ["Task"], ["BLOCKS"]);
      expect(ring).toHaveLength(n); // every node reported
      expect(new Set(ring.map((c) => c.componentId)).size).toBe(1); // and every edge was there to join them
    } finally {
      await big.cleanup();
    }
  });

  it("returns nothing for a graph with no entities", async () => {
    const empty = await testGraph();
    await ensureIndexes(empty.g);
    expect(await pageRank(empty.g, "Entity")).toEqual([]);
    expect(await components(empty.g, ["Task"], [])).toEqual([]);
    await empty.cleanup();
  });
});

describe("closeAll (integration)", () => {
  it("drops the projections this process cached", async () => {
    const { g } = await testGraph();
    for (const id of ["task:a", "task:b"]) await upsertNode(g, { type: "Task", id, name: id }, T0);
    await upsertEdge(g, { from: "task:a", type: "BLOCKS", to: "task:b" }, T0);
    await pageRank(g, "Task");
    expect(await children(g, "cur_")).toHaveLength(1);
    await closeAll();
    expect(await children(g, "cur_")).toEqual([]); // reconnects
    await (await openGraphByName(g.name)).drop(); // the old handle's connection is closed
    expect(await stampOf(g.name)).toBeNull();
    await closeAll();
  });
});
