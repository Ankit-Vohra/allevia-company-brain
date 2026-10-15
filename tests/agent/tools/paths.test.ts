import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { GraphHandle } from "../../../src/graph/client.js";
import { findPaths, showPath } from "../../../src/agent/tools/paths.js";
import { call, ids, makeCtx, seededGraph } from "../../helpers/tools.js";

describe("find_paths, show_path (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeAll(async () => ({ g, cleanup } = await seededGraph()), 60_000);
  afterAll(async () => cleanup());

  it("find_paths: shortest current path first, nodes and edges in order", async () => {
    const r = await call(findPaths, { from: "person:founder", to: "system:ig-connector", maxPaths: 2 }, makeCtx(g));
    expect(r.data.paths.length).toBeGreaterThanOrEqual(1);
    expect(r.data.paths.length).toBeLessThanOrEqual(2);
    expect(r.data.paths[0]).toEqual({
      length: 2, nodes: ["person:founder", "channel:instagram", "system:ig-connector"],
      steps: ["person:founder -[KNOWS_ABOUT]-> channel:instagram", "channel:instagram -[DEPENDS_ON]-> system:ig-connector"],
    });
    expect(ids(r.nodes)).toEqual(expect.arrayContaining(["person:founder", "channel:instagram", "system:ig-connector"]));
    expect(r.edges).toEqual(expect.arrayContaining([expect.objectContaining({ from: "channel:instagram", type: "DEPENDS_ON", to: "system:ig-connector" })]));
    expect(ids(r.sources)).toContain("document:systems-notes");
  });

  it("find_paths: never through a closed edge, unless asOf says it was open then", async () => {
    const rels = ["OWNS", "BLOCKS"];
    const now = await call(findPaths, { from: "person:founder", to: "system:ig-connector", rels }, makeCtx(g));
    expect(now.data.paths).toEqual([]);
    expect(now.note).toMatch(/No current connection/);
    const then = await call(findPaths, { from: "person:founder", to: "system:ig-connector", rels, asOf: "2026-10-01" }, makeCtx(g));
    expect(then.data.paths[0].nodes).toEqual(["person:founder", "task:fix-ig-token", "task:schedule-reels", "system:ig-connector"]);
  });

  it("find_paths: unknown endpoint is an error with suggestions", async () => {
    const r = await call(findPaths, { from: "person:founder", to: "system:instagram" }, makeCtx(g));
    expect(r.data.error).toMatch(/No entity with id system:instagram/);
  });

  it("show_path: connects a 3-node chain by direct edges, in order", async () => {
    const r = await call(showPath, { ids: ["decision:007-pause-daily-stories", "channel:instagram", "system:ig-connector"] }, makeCtx(g));
    expect(r.data.ordered).toEqual(["decision:007-pause-daily-stories", "channel:instagram", "system:ig-connector"]);
    expect(ids(r.nodes)).toEqual(["decision:007-pause-daily-stories", "channel:instagram", "system:ig-connector"]);
    expect(r.edges.map((e: { from: string; type: string; to: string }) => `${e.from} ${e.type} ${e.to}`)).toEqual([
      "decision:007-pause-daily-stories AFFECTS channel:instagram", "channel:instagram DEPENDS_ON system:ig-connector",
    ]);
    expect(r.data.unconnected).toEqual([]);
    expect(r.data.missing).toEqual([]);
    expect(ids(r.sources)).toContain("document:adr-007");
  });

  it("show_path: fills gaps with a short path, reports unknown ids", async () => {
    const r = await call(showPath, { ids: ["decision:007-pause-daily-stories", "system:reel-publisher", "decision:nope"] }, makeCtx(g));
    expect(r.data.missing).toEqual(["decision:nope"]);
    expect(r.data.links[0]).toMatchObject({ from: "decision:007-pause-daily-stories", to: "system:reel-publisher" });
    expect(r.data.links[0].hops).toBeGreaterThan(1);
    expect(r.data.links[0].hops).toBeLessThanOrEqual(4);
    expect(r.data.ordered[0]).toBe("decision:007-pause-daily-stories");
    expect(r.data.ordered.at(-1)).toBe("system:reel-publisher");
    expect(r.edges).toHaveLength(r.data.links[0].hops);
    expect(r.note).toMatch(/Unknown ids: decision:nope/);
  });
});
