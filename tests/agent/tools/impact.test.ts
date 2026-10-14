import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { GraphHandle } from "../../../src/graph/client.js";
import { betweennessOf, impactOf } from "../../../src/agent/tools/impact.js";
import { call, ids, makeCtx, seededGraph } from "../../helpers/tools.js";

describe("impact_of (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeAll(async () => ({ g, cleanup } = await seededGraph()), 60_000);
  afterAll(async () => cleanup());

  it("betweenness: a star's centre carries every pair, leaves none", () => {
    const b = betweennessOf(["c", "a", "b", "d"], [["a", "c"], ["c", "b"], ["d", "c"]]);
    expect(b.get("c")).toBe(3);
    expect(b.get("a")).toBe(0);
  });

  it("follows reverse DEPENDS_ON and forward BLOCKS by hop, ignoring the closed legacy edge", async () => {
    const r = await call(impactOf, { id: "system:ig-connector" }, makeCtx(g));
    const hop = (h: number) => r.data.impacted.find((x: { hop: number }) => x.hop === h)?.items.map((i: { id: string }) => i.id).sort();
    expect(hop(1)).toEqual(["channel:instagram", "system:reel-publisher", "task:schedule-reels"]);
    expect(hop(2)).toEqual(["system:reel-scheduler"]);
    expect(r.data.total).toBe(4);
    const all = r.data.impacted.flatMap((x: { items: Array<{ id: string }> }) => x.items.map((i) => i.id));
    expect(all).not.toContain("system:legacy-poster");
    const sched = r.data.impacted[1].items[0];
    expect(sched.because).toBe("system:reel-scheduler -[DEPENDS_ON]-> system:reel-publisher");
    // 5 nodes; the connector sits on 5 of the 6 pairs
    expect(r.data.betweenness).toEqual({ score: 5, normalized: 0.833, subgraphNodes: 5 });
    expect(ids(r.nodes)).toEqual(expect.arrayContaining(["system:ig-connector", "system:reel-scheduler", "task:schedule-reels"]));
    expect(r.edges).toHaveLength(4);
    expect(ids(r.sources)).toContain("document:systems-notes");
  });

  it("starts from an event through AFFECTS, honours depth and asOf", async () => {
    const r = await call(impactOf, { id: "event:ig-api-outage", depth: 2 }, makeCtx(g));
    expect(r.data.impacted.map((x: { hop: number; items: unknown[] }) => [x.hop, x.items.length])).toEqual([[1, 1], [2, 3]]);
    const then = await call(impactOf, { id: "system:ig-connector", depth: 1, asOf: "2026-08-15" }, makeCtx(g));
    expect(then.data.impacted[0].items.map((i: { id: string }) => i.id)).toContain("system:legacy-poster");
    const leaf = await call(impactOf, { id: "system:reel-scheduler" }, makeCtx(g));
    expect(leaf.data.total).toBe(0);
    expect(leaf.note).toMatch(/Nothing current depends on/);
  });
});
