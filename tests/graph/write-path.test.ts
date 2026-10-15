// The write path asks the server as little as it can, and never asks the writer for what a read can answer: one
// read before an observation (it was three, and each edge write read its ends again), pre-reads on GRAPH.RO_QUERY.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { addObservation, upsertEdge, upsertNode } from "../../src/graph/upsert.js";
import { testGraph } from "../helpers/graph.js";

describe("round trips of a write (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await ensureIndexes(g);
    await upsertNode(g, { type: "Business", id: "business:b", name: "B" });
    await upsertNode(g, { type: "Document", id: "document:snap", name: "Snapshot" });
  });
  afterAll(async () => {
    await cleanup();
    await closeAll();
  });

  // [writer statements, read statements] sent while `run` executes
  async function count(run: () => Promise<unknown>): Promise<{ writes: number; reads: number }> {
    const w = vi.spyOn(g, "query");
    const r = vi.spyOn(g, "roQuery");
    try {
      await run();
      return { writes: w.mock.calls.length, reads: r.mock.calls.length };
    } finally {
      w.mockRestore();
      r.mockRestore();
    }
  }
  const obs = (value: number) => ({ subject: "business:b", metric: "signups", value, asOf: "2026-10-01", src: "document:snap" });

  it("sends one read and the three writes of a new observation (node, MEASURES, SOURCED_FROM), not nine statements", async () => {
    const n = await count(() => addObservation(g, obs(5)));
    expect(n.reads).toBe(2);  // what is known about the subject, node and source (1); the node's stored state (1)
    expect(n.writes).toBe(3);
  });

  it("sends the two edge writes and two reads for a replay that changes nothing", async () => {
    const n = await count(() => addObservation(g, obs(5)));
    expect(n).toEqual({ reads: 2, writes: 2 });
  });

  it("reads an edge's ends on the read path, or not at all when the caller knows them", async () => {
    await upsertNode(g, { type: "Task", id: "task:a", name: "A" });
    await upsertNode(g, { type: "Task", id: "task:b", name: "B" });
    const unknown = await count(() => upsertEdge(g, { from: "task:a", type: "DEPENDS_ON", to: "task:b" }));
    expect(unknown).toEqual({ reads: 1, writes: 1 });
    const known = await count(() => upsertEdge(g, { from: "task:a", type: "DEPENDS_ON", to: "task:b" }, Date.now(),
      new Map([["task:a", ["Entity", "Task"]], ["task:b", ["Entity", "Task"]]])));
    expect(known).toEqual({ reads: 0, writes: 1 });
  });

  it("still refuses an edge to a node that does not exist, and a weaker reading, and a missing subject", async () => {
    await expect(upsertEdge(g, { from: "task:a", type: "DEPENDS_ON", to: "task:ghost" })).rejects.toThrow(/missing|no node|does not exist/i);
    await expect(addObservation(g, { ...obs(1), subject: "business:ghost" })).rejects.toThrow(/business:ghost/);
    await addObservation(g, { ...obs(9), asOf: "2026-10-02", conf: 1 });
    const weaker = await count(() => addObservation(g, { ...obs(1), asOf: "2026-10-02", conf: 0.2 }));
    expect(weaker.writes).toBe(0); // skipped on the read alone
  });

  it("a write to a graph that was never created reads it as empty (no 'empty key' error)", async () => {
    const { g: fresh, cleanup: c } = await testGraph();
    try {
      await expect(upsertNode(fresh, { type: "Task", id: "task:first", name: "First" })).resolves.toMatchObject({ created: true });
    } finally {
      await c();
    }
  });
});
