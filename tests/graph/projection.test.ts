import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { closeAll, connect, listGraphs, openGraphByName, type GraphHandle } from "../../src/graph/client.js";
import { projectionName, isProjectionName, sweepProjections, onEdgesValidAt, noteGraphWrite } from "../../src/graph/projection.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { upsertNode, upsertEdge, closeEdge } from "../../src/graph/upsert.js";
import { components, pageRank } from "../../src/graph/algorithms.js";
import { testGraph } from "../helpers/graph.js";

const T0 = 1_760_000_000_000;
const rawList = async () => (await connect()).list();
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
    noteGraphWrite(g.name);
    expect((await components(g, ["Task"], [])).map((c) => c.id)).toContain("task:raw");
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
    expect(groups(await components(g, ["Task"], ["BLOCKS"]))).toEqual([["task:b", "task:c"], ["task:a"], ["task:raw"]]);
    expect(await children(g, "cur_")).toHaveLength(1);
  });

  it("returns nothing for a graph with no entities", async () => {
    const empty = await testGraph();
    await ensureIndexes(empty.g);
    expect(await pageRank(empty.g, "Entity")).toEqual([]);
    expect(await components(empty.g, ["Task"], [])).toEqual([]);
    await empty.cleanup();
  });
});
