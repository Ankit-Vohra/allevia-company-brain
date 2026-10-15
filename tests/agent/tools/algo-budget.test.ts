// Graph algorithms get the tools' own time budget (TOOL_ALGO_TIMEOUT_MS), passed in a form dev's algorithms.ts accepts
// both before and after it gains `timeoutMs`: inside shortestPaths' options, and as a trailing options argument to
// pageRank and communities.
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
  });
});
