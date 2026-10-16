import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { z } from "zod";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { writeBatch } from "../../src/graph/upsert.js";
import { ask, type AskDeps } from "../../src/agent/ask.js";
import { FakeRuntime, SdkMessageFolder, UsageMeter, addUsage, tokensRead, usageFromResult, EMPTY_USAGE, type FakeScript } from "../../src/agent/runtime.js";
import type { AlleviaTool } from "../../src/agent/tool.js";
import { testGraph } from "../helpers/graph.js";
import { fakeTool, recorder, result, NOW } from "../helpers/agent.js";

describe("token usage of a run (the Agent SDK's result message)", () => {
  it("reads fresh, cached and written prompt tokens, output tokens and the number of model calls", () => {
    const u = usageFromResult({ usage: { input_tokens: 12, output_tokens: 340, cache_read_input_tokens: 9000, cache_creation_input_tokens: 600 }, num_turns: 4, duration_api_ms: 8123 });
    expect(u).toEqual({ inputTokens: 12, outputTokens: 340, cacheReadTokens: 9000, cacheWriteTokens: 600, modelCalls: 4, apiMs: 8123 });
    expect(tokensRead(u!)).toBe(9612);
    expect(usageFromResult({})).toBeUndefined(); // a fake's result carries none
  });

  it("SdkMessageFolder hands the usage on with the run's output", () => {
    const f = new SdkMessageFolder("a", false, () => {});
    f.push({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } });
    f.push({ type: "result", subtype: "success", is_error: false, result: "Done.", num_turns: 2, usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
    expect(f.output()).toEqual({ text: "Done.", usage: { inputTokens: 5, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0, modelCalls: 2 } });
  });

  it("adds runs up in a meter, whatever order they finish in", async () => {
    const rt = new FakeRuntime({
      a: { text: "x", usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 100, cacheWriteTokens: 0, modelCalls: 1 } },
      b: { text: "y", usage: { inputTokens: 20, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 50, modelCalls: 3 } },
      c: { text: "z" },
    });
    const meter = new UsageMeter();
    const run = meter.wrap(rt);
    const { emit } = recorder();
    for (const agentId of ["a", "b", "c"]) await run.run({ agentId, model: "haiku", system: "", prompt: "", tools: [], ctx: undefined as never }, emit);
    expect(meter.runs).toBe(3);
    expect(meter.total).toEqual({ inputTokens: 30, outputTokens: 3, cacheReadTokens: 100, cacheWriteTokens: 50, modelCalls: 4 });
    expect(addUsage(EMPTY_USAGE, undefined)).toBe(EMPTY_USAGE);
  });
});

describe("ask() saves what an answer cost on its Turn", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  const signups = result({ data: { metric: "signups", points: [{ week: "2026-10-05", value: 41 }] }, nodes: [{ id: "metric:signups", label: "Metric", name: "Signups", asOf: "2026-10-06" }] });
  const tools: Record<string, AlleviaTool> = {
    metric_trend: fakeTool("metric_trend", signups),
    show_path: fakeTool("show_path", (a) => result({ data: {}, nodes: (a.ids as string[]).map((id) => ({ id, label: "Entity", name: id })) }), { ids: z.array(z.string()) }),
  };
  const getTools = (names: string[]) => names.map((n) => tools[n]).filter((t): t is AlleviaTool => !!t);
  const use = (n: number): FakeScript => ({ usage: { inputTokens: n, outputTokens: n, cacheReadTokens: 1000 * n, cacheWriteTokens: 0, modelCalls: 1 } });

  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await ensureIndexes(g);
    await writeBatch(g, { nodes: [{ type: "Metric", id: "metric:signups", name: "Signups", asOf: "2026-10-06" }] }, NOW);
  });
  afterAll(async () => { await cleanup(); await closeAll(); });

  it("sums every agent run and counts the tool calls, on the Turn node", async () => {
    const scripts: Record<string, FakeScript> = {
      "chief-of-staff:plan": { structured: { steps: [{ agent: "data-analyst", task: "Explain the signups trend" }], rationale: "numbers" }, ...use(1) },
      "data-analyst": { calls: [{ name: "metric_trend", args: { metric: "signups" } }], structured: { text: "Signups were 41 [[metric:signups]].", citations: ["metric:signups"] }, ...use(2) },
      "coe-lead": { structured: { verdict: "ok", note: "ok" }, ...use(3) },
      "fact-checker": { structured: { verdict: "ok", note: "ok" }, ...use(4) },
      "chief-of-staff:synthesis": { calls: [{ name: "show_path", args: { ids: ["metric:signups"] } }], text: "Signups were 41 [[metric:signups]].", ...use(5) },
    };
    const deps: AskDeps = { runtime: new FakeRuntime(scripts), getTools, graph: g, now: () => NOW + 1000, seedSearch: async () => ["metric:signups"] };
    const r = await ask({ tenant: "t", question: "How are signups?", channel: "cli" }, deps, () => {});
    expect(r.usage?.toolCalls).toBe(2);
    expect(r.usage!.modelCalls).toBeGreaterThanOrEqual(2);
    const [t] = await g.roQuery<{ tin: number; tout: number; calls: number; tools: number; fresh: number }>(
      "MATCH (t:Entity:Turn {id:$id}) RETURN t.tokensIn AS tin, t.tokensOut AS tout, t.modelCalls AS calls, t.toolCalls AS tools, t.tokensFresh AS fresh", { id: r.turnId });
    expect(t!.tools).toBe(2);
    expect(t!.tin).toBe(tokensRead(r.usage!));
    expect(t!.tout).toBe(r.usage!.outputTokens);
    expect(t!.tin).toBeGreaterThan(t!.fresh);
  });
});
