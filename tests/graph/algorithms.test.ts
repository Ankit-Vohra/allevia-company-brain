import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { closeAll, connect, type GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { upsertNode, upsertEdge, closeEdge, writeBatch, addObservation, MissingEndpoint, type EdgeInput, type NodeInput } from "../../src/graph/upsert.js";
import { shortestPaths, pageRank, betweenness, components, communities } from "../../src/graph/algorithms.js";
import { testGraph } from "../helpers/graph.js";

const T0 = 1_760_000_000_000;

// Component A: founder -OWNS-> t1 -BLOCKS-> t2, founder -DECIDED-> d1 -AFFECTS-> t1, t2, founder -KNOWS_ABOUT-> t2
// (a 4-clique once direction is ignored: FalkorDB's synchronous label propagation only settles on such tight clusters)
// Component B: s1 -DEPENDS_ON-> s2
// A closed edge t2 -DEPENDS_ON-> s1 (valid T0..T0+100) would join them if history leaked into "now".
describe("algorithms (integration, 6-node fixture)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await ensureIndexes(g);
    const nodes = [
      { type: "Person", id: "person:founder", name: "Founder" }, { type: "Task", id: "task:t1", name: "T1" },
      { type: "Task", id: "task:t2", name: "T2" }, { type: "Decision", id: "decision:d1", name: "D1" },
      { type: "System", id: "system:s1", name: "S1" }, { type: "System", id: "system:s2", name: "S2" },
    ] as const;
    for (const n of nodes) await upsertNode(g, { ...n }, T0);
    const edges = [
      ["person:founder", "OWNS", "task:t1"], ["task:t1", "BLOCKS", "task:t2"], ["person:founder", "DECIDED", "decision:d1"],
      ["decision:d1", "AFFECTS", "task:t1"], ["decision:d1", "AFFECTS", "task:t2"], ["system:s1", "DEPENDS_ON", "system:s2"],
      ["task:t2", "DEPENDS_ON", "system:s1"], ["person:founder", "KNOWS_ABOUT", "task:t2"],
    ] as const;
    for (const [from, type, to] of edges) await upsertEdge(g, { from, type, to }, T0);
    expect(await closeEdge(g, "task:t2", "DEPENDS_ON", "system:s1", T0 + 100)).toBe(1);
    // a non-searchable node pointing at t1: "Entity" rankings must leave it out
    await addObservation(g, { subject: "task:t1", metric: "age_days", value: 3, asOf: "2026-10-14", src: "document:none" }, T0);
  });
  afterAll(async () => {
    await cleanup();
    expect((await (await connect()).list()).filter((n) => n.startsWith(`${g.name}__`))).toEqual([]);
    await closeAll();
  });

  it("finds shortest paths, ignoring edge direction", async () => {
    const direct = await shortestPaths(g, "person:founder", "task:t2");
    expect(direct[0]!.edges).toEqual([{ from: "person:founder", type: "KNOWS_ABOUT", to: "task:t2", since: T0, until: null }]);
    // shortest first; with room to spare, longer alternatives follow
    const work = ["OWNS", "BLOCKS", "DECIDED", "AFFECTS"] as const;
    const paths = await shortestPaths(g, "person:founder", "task:t2", { maxPaths: 5, relTypes: [...work] });
    expect(paths.map((p) => p.length)).toEqual([2, 2, 3, 3]);
    for (const p of paths) {
      expect(p.nodes[0]!.id).toBe("person:founder");
      expect(p.nodes.at(-1)!.id).toBe("task:t2");
      expect(p.edges).toHaveLength(p.length);
    }
    expect(paths.slice(0, 2).map((p) => p.nodes[1]!.id).sort()).toEqual(["decision:d1", "task:t1"]);
    expect(await shortestPaths(g, "person:founder", "task:t2", { maxPaths: 1, relTypes: [...work] })).toHaveLength(1);
    const viaDecision = paths.find((p) => p.length === 2 && p.nodes[1]!.id === "decision:d1")!;
    expect(viaDecision.edges).toEqual([
      { from: "person:founder", type: "DECIDED", to: "decision:d1", since: T0, until: null },
      { from: "decision:d1", type: "AFFECTS", to: "task:t2", since: T0, until: null },
    ]);
    expect(viaDecision.nodes[1]).toEqual({ id: "decision:d1", label: "Decision", name: "D1" });
    // reversed: same path, edge directions preserved
    const back = await shortestPaths(g, "task:t2", "person:founder", { relTypes: ["DECIDED", "AFFECTS"] });
    expect(back).toHaveLength(1);
    expect(back[0]!.nodes.map((n) => n.id)).toEqual(["task:t2", "decision:d1", "person:founder"]);
    expect(back[0]!.edges[0]).toMatchObject({ from: "decision:d1", type: "AFFECTS", to: "task:t2" });
  });

  it("never returns a path through a closed edge, but time travel can", async () => {
    expect(await shortestPaths(g, "person:founder", "system:s2")).toEqual([]);
    const then = await shortestPaths(g, "person:founder", "system:s2", { asOf: T0 + 50 });
    expect(then.length).toBeGreaterThan(0);
    expect(then[0]!.edges.map((e) => e.type)).toContain("DEPENDS_ON");
    expect(then[0]!.edges.find((e) => e.from === "task:t2")).toMatchObject({ to: "system:s1", until: T0 + 100 });
    // asOf paths come from a projection (ids + type labels only); names are filled back in from the tenant graph
    expect(then[0]!.nodes.find((n) => n.id === "system:s1")).toEqual({ id: "system:s1", label: "System", name: "S1" });
    expect(await shortestPaths(g, "person:founder", "system:s2", { asOf: T0 + 150 })).toEqual([]);
    expect(await shortestPaths(g, "person:founder", "system:s2", { asOf: T0 - 1 })).toEqual([]);
  });

  it("reports unknown endpoints", async () => {
    await expect(shortestPaths(g, "person:founder", "task:nope")).rejects.toBeInstanceOf(MissingEndpoint);
  });

  it("ranks by PageRank over current edges", async () => {
    const all = await pageRank(g, "Entity");
    expect(all.map((r) => r.id).sort()).toEqual(["decision:d1", "person:founder", "system:s1", "system:s2", "task:t1", "task:t2"]);
    expect(all[0]!.id).toBe("task:t2");
    const score = (id: string) => all.find((r) => r.id === id)!.score;
    expect(score("task:t2")).toBeGreaterThan(score("task:t1"));
    expect(score("task:t1")).toBeGreaterThan(score("person:founder"));
    const tasks = await pageRank(g, "Task", "BLOCKS");
    expect(tasks.map((r) => r.id)).toEqual(["task:t2", "task:t1"]);
  });

  it("splits into two components once the closed edge is ignored", async () => {
    const cs = await components(g, ["Person", "Task", "Decision", "System"], []);
    const byComp = new Map<number, string[]>();
    for (const c of cs) byComp.set(c.componentId, [...(byComp.get(c.componentId) ?? []), c.id]);
    const groups = [...byComp.values()].map((ids) => ids.sort()).sort((a, b) => b.length - a.length);
    expect(groups).toEqual([["decision:d1", "person:founder", "task:t1", "task:t2"], ["system:s1", "system:s2"]]);
  });

  it("puts the tightly linked cluster into one community", async () => {
    const cs = await communities(g, ["Person", "Task", "Decision"], ["OWNS", "BLOCKS", "DECIDED", "AFFECTS", "KNOWS_ABOUT"]);
    expect(cs).toHaveLength(4);
    expect(new Set(cs.map((c) => c.communityId)).size).toBe(1);
  });

  it("scores betweenness on current edges only", async () => {
    const bc = await betweenness(g, ["Person", "Task", "Decision", "System"], ["OWNS", "BLOCKS", "DECIDED", "AFFECTS", "DEPENDS_ON"]);
    const s = (id: string) => bc.find((r) => r.id === id)!.score;
    expect(s("task:t1")).toBeGreaterThan(0); // founder -> t1 -> t2
    expect(s("decision:d1")).toBeGreaterThan(0); // founder -> d1 -> t2
    expect(s("person:founder")).toBe(0);
    expect(s("task:t2")).toBe(0); // would be > 0 if the closed t2 -> s1 edge counted
    expect(s("system:s1")).toBe(0);
  });

  it("takes a timeoutMs on every algorithm", async () => {
    const t = { timeoutMs: 10_000 };
    expect((await shortestPaths(g, "person:founder", "task:t2", t))[0]!.length).toBe(1);
    expect(await shortestPaths(g, "person:founder", "system:s2", { ...t, asOf: T0 + 50 })).not.toEqual([]);
    expect(await pageRank(g, "Entity", undefined, t)).toHaveLength(6);
    expect(await betweenness(g, ["Task"], ["BLOCKS"], t)).toHaveLength(2);
    expect(await components(g, ["Task"], ["BLOCKS"], t)).toHaveLength(2);
    expect(await communities(g, ["Task"], ["BLOCKS"], t)).toHaveLength(2);
    for (const bad of [0, -5, Number.NaN]) {
      await expect(pageRank(g, "Entity", undefined, { timeoutMs: bad })).rejects.toThrow(/positive/);
      await expect(shortestPaths(g, "person:founder", "task:t2", { timeoutMs: bad })).rejects.toThrow(/positive/);
    }
  });

  it("keeps at most the one cached projection; dropping the graph takes it along", async () => {
    const kids = (await (await connect()).list()).filter((n) => n.startsWith(`${g.name}__`));
    expect(kids.filter((n) => !n.includes("__cur_"))).toEqual([]);
    expect(kids.length).toBeLessThanOrEqual(1);
  });
});

// Reviewer's case: the only path valid at asOf is a-b-c-d, while 31 shorter a-x-d paths only start later. A candidate
// budget (ask SPpaths for N paths, filter afterwards) fills up with the short paths and returns nothing.
describe("time-travel paths are exact (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await ensureIndexes(g);
    const xs = Array.from({ length: 31 }, (_, i) => `task:x${i}`);
    const nodes: NodeInput[] = ["task:a", "task:b", "task:c", "task:d", ...xs].map((id) => ({ type: "Task", id, name: id }));
    const edges: EdgeInput[] = [
      ...[["task:a", "task:b"], ["task:b", "task:c"], ["task:c", "task:d"]].map(([from, to]) => ({ from: from!, type: "BLOCKS" as const, to: to!, since: T0 })),
      ...xs.flatMap((x) => [{ from: "task:a", type: "BLOCKS" as const, to: x, since: T0 + 1000 }, { from: x, type: "BLOCKS" as const, to: "task:d", since: T0 + 1000 }]),
    ];
    // plus a 7-hop chain p0 -> … -> p7, longer than any path the tools may ask for
    const chain = Array.from({ length: 8 }, (_, i) => `task:p${i}`);
    nodes.push(...chain.map((id): NodeInput => ({ type: "Task", id, name: id })));
    edges.push(...chain.slice(1).map((to, i): EdgeInput => ({ from: chain[i]!, type: "BLOCKS", to, since: T0 })));
    const stats = await writeBatch(g, { nodes, edges }, T0 + 2000);
    expect(stats.errors).toEqual([]);
    expect(stats.edgesCreated).toBe(72);
  });
  afterAll(async () => {
    await cleanup();
    await closeAll();
  });

  it("finds the only path valid at asOf", async () => {
    const then = await shortestPaths(g, "task:a", "task:d", { asOf: T0 + 500 });
    expect(then).toHaveLength(1);
    expect(then[0]!.nodes.map((n) => n.id)).toEqual(["task:a", "task:b", "task:c", "task:d"]);
    const now = await shortestPaths(g, "task:a", "task:d");
    expect(now.map((p) => p.length)).toEqual([2, 2, 2]);
    expect(await shortestPaths(g, "task:a", "task:d", { asOf: T0 - 1 })).toEqual([]);
  });

  it("clamps maxLen to 1..6", async () => {
    expect(await shortestPaths(g, "task:p0", "task:p6", { maxLen: 50 })).toHaveLength(1); // 6 hops: allowed
    expect(await shortestPaths(g, "task:p0", "task:p7", { maxLen: 50 })).toEqual([]); // 7 hops: beyond the clamp
    expect(await shortestPaths(g, "task:a", "task:d", { maxLen: 0 })).toEqual([]); // clamped to 1, and a-d needs 2
    expect((await shortestPaths(g, "task:a", "task:b", { maxLen: 0 }))[0]!.length).toBe(1);
  });

  it("drops its asOf projection", async () => {
    expect((await (await connect()).list()).filter((n) => n.startsWith(`${g.name}__`))).toEqual([]);
  });
});
