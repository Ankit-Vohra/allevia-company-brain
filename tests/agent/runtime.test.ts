import { describe, it, expect } from "vitest";
import { FakeRuntime, SdkMessageFolder, invokeTool, statusLine, summarise, forModel, type RunInput } from "../../src/agent/runtime.js";
import { fakeTool, recorder, result, stubCtx } from "../helpers/agent.js";

const signups = result({
  data: { metric: "signups", points: [{ week: "2026-10-05", value: 55 }, { week: "2026-09-28", value: 41 }] },
  nodes: [{ id: "metric:signups", label: "Metric", name: "Signups" }, { id: "obs:signups:2026-10-05", label: "Observation", name: "signups (2026-10-05)", asOf: "2026-10-05" }],
  sources: [{ id: "document:ga4", title: "GA4 export", asOf: "2026-10-06" }],
});

function input(over: Partial<RunInput> = {}): RunInput {
  return { agentId: "data-analyst", model: "haiku", system: "s", prompt: "p", tools: [], ctx: stubCtx(), ...over };
}

describe("invokeTool (the single tool path)", () => {
  it("emits tool_call, agent_status, tool_result; records touched; returns compact JSON with ids", async () => {
    const tool = fakeTool("metric_trend", signups);
    const inp = input({ tools: [tool] });
    const { events, emit, types } = recorder();
    const out = await invokeTool(tool, { metric: "signups" }, inp, emit, "c1");

    expect(types()).toEqual(["tool_call", "agent_status", "tool_result"]);
    expect(events[0]).toEqual({ type: "tool_call", agent: "data-analyst", id: "c1", name: "metric_trend", args: { metric: "signups" } });
    expect(events[1]).toEqual({ type: "agent_status", agent: "data-analyst", text: "Checking the signups trend" });
    const tr = events[2] as Extract<typeof events[number], { type: "tool_result" }>;
    expect(tr).toMatchObject({ agent: "data-analyst", id: "c1", name: "metric_trend", nodes: signups.nodes, sources: signups.sources });
    expect(tr.summary.length).toBeLessThanOrEqual(140);
    expect(tr.summary).toContain("2 results");

    expect(inp.ctx.touched.has("metric:signups")).toBe(true);
    expect(inp.ctx.touched.has("document:ga4")).toBe(true);
    expect(inp.ctx.touched.numbers().has("55")).toBe(true);
    expect(tool.calls[0]!.agentId).toBe("data-analyst"); // ctx is re-bound to the calling agent

    expect(out.isError).toBe(false);
    const json = JSON.parse(out.text);
    expect(json.ids).toEqual(["metric:signups", "obs:signups:2026-10-05"]);
    expect(json.data.points[0].value).toBe(55);
  });

  it("turns a throwing tool into an 'error: …' result and a status line, never a crash", async () => {
    const tool = fakeTool("search", () => { throw new Error("graph is down"); });
    const inp = input();
    const { events, emit, types } = recorder();
    const out = await invokeTool(tool, { query: "x" }, inp, emit, "c2");
    expect(out).toEqual({ text: "error: graph is down", isError: true });
    expect(types()).toEqual(["tool_call", "agent_status", "agent_status", "tool_result"]);
    expect(events[2]).toMatchObject({ type: "agent_status", text: "Couldn't use search: graph is down" });
    expect(events[3]).toMatchObject({ type: "tool_result", summary: "error: graph is down", nodes: [] });
    expect(inp.ctx.touched.nodes()).toEqual([]);
  });

  it("rejects arguments that don't match the tool's input shape", async () => {
    const tool = fakeTool("metric_trend", signups);
    const out = await invokeTool(tool, { metric: 42 }, input(), () => {}, "c3");
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/^error: bad arguments: metric/);
    expect(tool.calls).toHaveLength(0);
  });
});

describe("statusLine, summarise, forModel", () => {
  it("phrases known tools from their args and falls back for unknown ones", () => {
    expect(statusLine("search", { query: "daily stories" })).toBe('Searching the graph for "daily stories"');
    expect(statusLine("get_entity", {})).toBe("Opening an entity");
    expect(statusLine("frobnicate_widget", {})).toBe("Using frobnicate widget");
  });
  it("summarises from data and nodes, and says when nothing came back", () => {
    expect(summarise(result({ data: [] }))).toBe("0 results");
    expect(summarise(result({ data: null }))).toBe("nothing found");
    const many = result({ data: { rows: [1, 2, 3, 4] }, nodes: ["a", "b", "c", "d"].map((x) => ({ id: x, label: "Page", name: x.toUpperCase() })), note: "capped" });
    expect(summarise(many)).toBe("4 results · A, B, C +1 · capped");
  });
  it("flags simulated nodes to the model", () => {
    const r = result({ data: { spend: 10 }, nodes: [{ id: "campaign:x", label: "Campaign", name: "X", simulated: true }] });
    expect(JSON.parse(forModel(r)).simulated).toEqual(["campaign:x"]);
  });
});

describe("FakeRuntime", () => {
  it("drives scripted tool calls through invokeTool and streams the final text", async () => {
    const tool = fakeTool("metric_trend", signups);
    const rt = new FakeRuntime({ "data-analyst": { calls: [{ name: "metric_trend", args: { metric: "signups" } }], text: "Signups were 55 [[metric:signups]] in the week of 2026-10-05, up from 41." } });
    const { events, emit } = recorder();
    const inp = input({ tools: [tool], streamText: true });
    const out = await rt.run(inp, emit);
    expect(tool.calls).toHaveLength(1);
    expect(events.filter((e) => e.type === "tool_result")).toHaveLength(1);
    const streamed = events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("");
    expect(streamed).toBe(out.text);
    expect(inp.ctx.touched.has("metric:signups")).toBe(true);
  });

  it("keys scripts by agent:phase first, consumes arrays in order, and records runs", async () => {
    const rt = new FakeRuntime({
      "chief-of-staff:plan": { structured: { steps: [], rationale: "r" } },
      "chief-of-staff": [{ text: "one" }, { text: "two" }],
    });
    const run = (phase: RunInput["phase"]) => rt.run(input({ agentId: "chief-of-staff", phase }), () => {});
    expect((await run("plan")).structured).toEqual({ steps: [], rationale: "r" });
    expect((await run("synthesis")).text).toBe("one");
    expect((await run("synthesis")).text).toBe("two");
    expect((await run("synthesis")).text).toBe("two");
    expect(rt.runs.map((r) => r.phase)).toEqual(["plan", "synthesis", "synthesis", "synthesis"]);
  });

  it("throws a scripted failure and honours an abort while delayed", async () => {
    const rt = new FakeRuntime({ a: { fail: "model overloaded" }, b: { delayMs: 5_000, text: "late" } });
    await expect(rt.run(input({ agentId: "a" }), () => {})).rejects.toThrow("model overloaded");
    const ac = new AbortController();
    const p = rt.run(input({ agentId: "b", signal: ac.signal }), () => {});
    ac.abort();
    await expect(p).rejects.toThrow(/aborted/);
  });
});

describe("SdkMessageFolder (SDK messages -> events and output)", () => {
  const delta = (text: string, parent: string | null = null) =>
    ({ type: "stream_event", parent_tool_use_id: parent, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
  const assistant = (text: string) => ({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text }, { type: "tool_use", id: "t", name: "x", input: {} }] } });

  it("streams top-level text deltas as text events and keeps every assistant text block", () => {
    const { events, emit } = recorder();
    const f = new SdkMessageFolder("chief-of-staff", true, emit);
    for (const m of [{ type: "system", subtype: "init" }, delta("Sign"), delta("ups"), delta("nested", "toolu_1"), assistant("Signups rose."), assistant("Path shown."),
      { type: "result", subtype: "success", is_error: false, result: "Path shown." }]) f.push(m);
    expect(events).toEqual([{ type: "text", agent: "chief-of-staff", delta: "Sign" }, { type: "text", agent: "chief-of-staff", delta: "ups" }]);
    expect(f.output()).toEqual({ text: "Signups rose.\n\nPath shown." });
  });

  it("separates text blocks that follow earlier streamed text with a paragraph break", () => {
    const { events, emit } = recorder();
    const f = new SdkMessageFolder("chief-of-staff", true, emit);
    const start = { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } };
    for (const m of [start, delta("Looking."), start, delta("Answer.")]) f.push(m);
    expect(events.map((e) => (e as { delta: string }).delta).join("")).toBe("Looking.\n\nAnswer.");
  });

  it("returns structured output and does not stream when streamText is off", () => {
    const { events, emit } = recorder();
    const f = new SdkMessageFolder("chief-of-staff", false, emit);
    f.push(delta("{"));
    f.push({ type: "result", subtype: "success", is_error: false, result: "", structured_output: { steps: [] } });
    expect(events).toEqual([]);
    expect(f.output()).toEqual({ text: "", structured: { steps: [] } });
  });

  it("throws on an error result or a missing result", () => {
    const f = new SdkMessageFolder("a", false, () => {});
    expect(() => f.output()).toThrow(/without a result/);
    f.push({ type: "result", subtype: "error_max_turns", is_error: true, errors: ["too many turns"] });
    expect(() => f.output()).toThrow("error_max_turns: too many turns");
  });
});
