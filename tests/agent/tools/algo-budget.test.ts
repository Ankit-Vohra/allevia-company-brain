// Graph algorithms get the tools' own time budget (TOOL_ALGO_TIMEOUT_MS) as the graph core's `timeoutMs`, and run on
// the tenant graph itself (no wrapper): shortestPaths in its options, pageRank and communities in their trailing options.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { GraphHandle } from "../../../src/graph/client.js";
import * as algorithms from "../../../src/graph/algorithms.js";
import { TOOL_ALGO_TIMEOUT_MS } from "../../../src/agent/tools/common.js";
import { findPaths, showPath } from "../../../src/agent/tools/paths.js";
import { important, topics } from "../../../src/agent/tools/ranking.js";
import { call, makeCtx, seededGraph } from "../../helpers/tools.js";

vi.mock("../../../src/graph/algorithms.js", async (load) => {
  const real = await load<typeof import("../../../src/graph/algorithms.js")>();
  return { ...real, shortestPaths: vi.fn(real.shortestPaths), pageRank: vi.fn(real.pageRank), communities: vi.fn(real.communities) };
});

const last = (calls: unknown[][]): unknown => calls.at(-1)?.at(-1);

describe("algorithm time budget (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeAll(async () => ({ g, cleanup } = await seededGraph()), 60_000);
  afterAll(async () => cleanup());

  it("find_paths and show_path pass it to shortestPaths", async () => {
    await call(findPaths, { from: "person:founder", to: "system:ig-connector" }, makeCtx(g));
    expect(last(vi.mocked(algorithms.shortestPaths).mock.calls)).toMatchObject({ timeoutMs: TOOL_ALGO_TIMEOUT_MS });
    expect(vi.mocked(algorithms.shortestPaths).mock.calls.at(-1)?.[0]).toBe(g);
    vi.mocked(algorithms.shortestPaths).mockClear();
    await call(showPath, { ids: ["decision:007-pause-daily-stories", "system:ig-connector"] }, makeCtx(g));
    expect(last(vi.mocked(algorithms.shortestPaths).mock.calls)).toMatchObject({ timeoutMs: expect.any(Number) });
    expect((last(vi.mocked(algorithms.shortestPaths).mock.calls) as { timeoutMs: number }).timeoutMs).toBeLessThanOrEqual(TOOL_ALGO_TIMEOUT_MS);
  });

  it("important and topics pass it to pageRank and communities", async () => {
    const r = await call(important, { label: "System" }, makeCtx(g));
    expect(r.data.method).toBe("pagerank");
    expect(last(vi.mocked(algorithms.pageRank).mock.calls)).toEqual({ timeoutMs: TOOL_ALGO_TIMEOUT_MS });
    const t = await call(topics, {}, makeCtx(g));
    expect(t.data.method).toBe("label_propagation");
    expect(last(vi.mocked(algorithms.communities).mock.calls)).toEqual({ timeoutMs: TOOL_ALGO_TIMEOUT_MS });
    expect(vi.mocked(algorithms.pageRank).mock.calls.at(-1)?.[0]).toBe(g);
    expect(vi.mocked(algorithms.communities).mock.calls.at(-1)?.[0]).toBe(g);
  });

  it("a result computed on the last good projection says so", async () => {
    const stale = <T>(rows: T[]) => Object.assign(rows, { stale: true as const });
    vi.mocked(algorithms.pageRank).mockResolvedValueOnce(stale([{ id: "system:ig-connector", score: 0.5 }]));
    const r = await call(important, { label: "System" }, makeCtx(g));
    expect(r.data.items.map((i: { id: string }) => i.id)).toEqual(["system:ig-connector"]);
    expect(r.note).toMatch(/last consistent snapshot/);
    vi.mocked(algorithms.communities).mockResolvedValueOnce(stale([{ id: "channel:instagram", communityId: 1 }, { id: "document:adr-007", communityId: 1 }]));
    expect((await call(topics, {}, makeCtx(g))).note).toMatch(/last consistent snapshot/);
    expect((await call(important, { label: "System" }, makeCtx(g))).note).toBeUndefined();
  });
});
