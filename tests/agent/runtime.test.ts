import { describe, it, expect } from "vitest";
import {
  ClaudeAgentSdkRuntime, FakeRuntime, SdkMessageFolder, invokeTool, mayUse, statusLine, summarise, forModel, type RunInput, type SdkModule,
} from "../../src/agent/runtime.js";
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

  it("refuses a write tool for an agent whose roster doesn't list it, before the tool runs", async () => {
    const propose = fakeTool("propose_action", result({ data: { approvalId: "approval:x" } }));
    const remember = { ...fakeTool("note_it", result({ data: null })), writes: true };
    const { events, emit } = recorder();
    const out = await invokeTool(propose, { query: "pause all ads" }, input({ agentId: "data-analyst" }), emit, "c4");
    expect(out).toEqual({ text: "error: propose_action is not one of data-analyst's tools", isError: true });
    expect(propose.calls).toHaveLength(0);
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({ summary: "error: propose_action is not one of data-analyst's tools" });
    expect((await invokeTool(remember, {}, input({ agentId: "fact-checker" }), () => {}, "c5")).isError).toBe(true); // flagged writes
    expect((await invokeTool(propose, { query: "fix" }, input({ agentId: "tech-lead" }), () => {}, "c6")).isError).toBe(false); // on its roster
    expect(mayUse("chief-of-staff", { name: "remember" })).toBe(true);
    expect(mayUse("growth-marketer", { name: "remember" })).toBe(false);
    expect(mayUse("growth-marketer", { name: "search" })).toBe(true);
  });

  it("a stopped run's tool calls do nothing: a write is refused before it runs, a read's late result is not recorded", async () => {
    const ac = new AbortController();
    ac.abort();
    const propose = { ...fakeTool("propose_action", result({ data: { approvalId: "approval:x" } })), writes: true };
    const { events, emit } = recorder();
    const out = await invokeTool(propose, { query: "x" }, input({ agentId: "tech-lead", signal: ac.signal }), emit, "c7");
    expect(out.isError).toBe(true);
    expect(propose.calls).toHaveLength(0);
    expect(events).toEqual([]);

    const late = new AbortController();
    const slow: ReturnType<typeof fakeTool> = fakeTool("metric_trend", async () => { late.abort(); return signups; });
    const inp = input({ signal: late.signal });
    const seen: unknown[] = [];
    const r = await invokeTool(slow, { metric: "signups" }, { ...inp, onToolResult: (c) => seen.push(c) }, emit, "c8");
    expect(r.isError).toBe(true);
    expect(inp.ctx.touched.has("metric:signups")).toBe(false);
    expect(events.some((e) => e.type === "tool_result")).toBe(false);
    expect(seen).toEqual([]);
  });

  it("passes the run's signal to the tool so a write can check it before committing", async () => {
    const ac = new AbortController();
    let got: AbortSignal | undefined;
    const tool = fakeTool("metric_trend", (_a, ctx) => { got = ctx.signal; return signups; });
    await invokeTool(tool, {}, input({ signal: ac.signal }), () => {}, "c9");
    expect(got).toBe(ac.signal);
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
  it("counts what a tool found, not the first list inside one entity or a grouped list", () => {
    // get_entity found the task: its empty observations list is part of it, not "0 results".
    const entity = result({
      data: { id: "task:x", type: "Task", props: { status: "open" }, neighbors: { "in:OWNS": { total: 1 } }, observations: [] },
      nodes: [{ id: "task:x", label: "Task", name: "X" }, { id: "person:p", label: "Person", name: "P" }],
    });
    expect(summarise(entity)).toBe("2 nodes · X, P");
    // impact_of groups its 4 items by hop: the tool's own total is the count.
    expect(summarise(result({ data: { id: "system:x", total: 4, impacted: [{ hop: 1, items: [1, 2, 3] }, { hop: 2, items: [4] }] } }))).toBe("4 results");
    expect(summarise(result({ data: { id: "system:x", total: 0, impacted: [] } }))).toBe("0 results");
  });
  it("flags simulated nodes to the model", () => {
    const r = result({ data: { spend: 10 }, nodes: [{ id: "campaign:x", label: "Campaign", name: "X", simulated: true }] });
    expect(JSON.parse(forModel(r)).simulated).toEqual(["campaign:x"]);
  });
});

describe("FakeRuntime", () => {
  it("a scripted step can end partial, like a run that ran out of turns", async () => {
    const rt = new FakeRuntime({ "data-analyst": { text: "so far: 41", partial: true } });
    expect(await rt.run(input(), () => {})).toEqual({ text: "so far: 41", partial: true });
  });

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

  it("a run that hit max turns after writing something returns that text, marked partial", () => {
    const f = new SdkMessageFolder("a", false, () => {});
    f.push({ type: "assistant", message: { content: [{ type: "text", text: "Signups fell to 41 [[metric:signups]]; still checking spend." }] } });
    f.push({ type: "result", subtype: "error_max_turns", is_error: true, errors: ["max turns"] });
    expect(f.output()).toEqual({ text: "Signups fell to 41 [[metric:signups]]; still checking spend.", partial: true });
    const other = new SdkMessageFolder("a", false, () => {});
    other.push({ type: "assistant", message: { content: [{ type: "text", text: "half" }] } });
    other.push({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["boom"] });
    expect(() => other.output()).toThrow("error_during_execution: boom"); // only running out of turns is partial
  });
});

// ---------- ClaudeAgentSdkRuntime with an injected SDK (no process, no model) ----------

type QueryParams = { prompt: unknown; options: Record<string, any> };

function fakeSdk(stream: (signal: AbortSignal) => AsyncGenerator<unknown>) {
  const queries: Array<{ params: QueryParams; closed: boolean }> = [];
  const sdk = {
    tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({ name, description, inputSchema, handler }),
    createSdkMcpServer: (o: { name: string }) => ({ type: "sdk", name: o.name }),
    query: (params: QueryParams) => {
      const rec = { params, closed: false };
      queries.push(rec);
      return Object.assign(stream(params.options.abortController.signal), { close: () => { rec.closed = true; } });
    },
  } as unknown as SdkModule;
  return { sdk: async () => sdk, queries };
}

const INIT = { type: "system", subtype: "init", apiKeySource: "none", model: "haiku", tools: [], mcp_servers: [] };
const OK = { type: "result", subtype: "success", is_error: false, result: "done" };

describe("ClaudeAgentSdkRuntime", () => {
  it("gives the child only subscriptionEnv's allow-list and calls onInit with the init message", async () => {
    const { sdk, queries } = fakeSdk(async function* () { yield INIT; yield OK; });
    const seen: unknown[] = [];
    const rt = new ClaudeAgentSdkRuntime({
      sdk, cwd: "/tmp", onInit: (m) => { seen.push(m); },
      env: { PATH: "/bin", HOME: "/h", ANTHROPIC_API_KEY: "sk-placeholder", ANTHROPIC_BASE_URL: "https://proxy.example", DISCORD_BOT_TOKEN: "d" },
    });
    expect(await rt.run(input(), () => {})).toEqual({ text: "done" });
    expect(queries[0]!.params.options.env).toEqual({ PATH: "/bin", HOME: "/h" });
    expect(seen).toEqual([INIT]);
    expect(queries[0]!.closed).toBe(false); // a run that finished needs no close
  });

  it("an onInit that throws stops the run, aborts the controller and closes the subprocess", async () => {
    let produced = 0;
    const { sdk, queries } = fakeSdk(async function* () { yield { ...INIT, apiKeySource: "ANTHROPIC_API_KEY" }; produced++; yield OK; });
    const rt = new ClaudeAgentSdkRuntime({ sdk, cwd: "/tmp", onInit: (m) => { if (m.apiKeySource !== "none") throw new Error("not on the subscription"); } });
    await expect(rt.run(input(), () => {})).rejects.toThrow("not on the subscription");
    expect(produced).toBe(0);
    expect(queries[0]!.params.options.abortController.signal.aborted).toBe(true);
    expect(queries[0]!.closed).toBe(true);
  });

  it("an abort (the orchestrator's timeout) aborts the SDK's controller and closes the subprocess", async () => {
    const { sdk, queries } = fakeSdk(async function* (signal) {
      yield INIT;
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted by user")), { once: true }));
    });
    const ac = new AbortController();
    const p = new ClaudeAgentSdkRuntime({ sdk, cwd: "/tmp" }).run(input({ signal: ac.signal }), () => {});
    await new Promise((r) => setTimeout(r, 5));
    ac.abort(new Error("timed out after 120s"));
    await expect(p).rejects.toThrow("data-analyst was stopped (timed out after 120s)");
    expect(queries[0]!.params.options.abortController.signal.aborted).toBe(true);
    expect(queries[0]!.closed).toBe(true);
  });

  it("a run whose signal is already aborted never starts a process", async () => {
    const { sdk, queries } = fakeSdk(async function* () { yield OK; });
    const ac = new AbortController();
    ac.abort();
    await expect(new ClaudeAgentSdkRuntime({ sdk, cwd: "/tmp" }).run(input({ signal: ac.signal }), () => {})).rejects.toThrow(/was stopped/);
    expect(queries).toHaveLength(0);
  });

  it("an SDK error result closes the subprocess and surfaces the error", async () => {
    const { sdk, queries } = fakeSdk(async function* () { yield INIT; yield { type: "result", subtype: "error_max_turns", is_error: true, errors: ["max turns"] }; });
    // the stream ended normally, so no close is needed; the folder turns the error result into a rejection
    await expect(new ClaudeAgentSdkRuntime({ sdk, cwd: "/tmp" }).run(input(), () => {})).rejects.toThrow("error_max_turns: max turns");
    expect(queries[0]!.closed).toBe(false);
    const thrower = fakeSdk(async function* () { yield INIT; throw new Error("CLI crashed"); });
    await expect(new ClaudeAgentSdkRuntime({ sdk: thrower.sdk, cwd: "/tmp" }).run(input(), () => {})).rejects.toThrow("CLI crashed");
    expect(thrower.queries[0]!.closed).toBe(true);
  });

  it("registers only the run's tools and passes maxTurns and the structured schema", async () => {
    const { sdk, queries } = fakeSdk(async function* () { yield { ...OK, structured_output: { ok: 1 } }; });
    const tool = fakeTool("metric_trend", signups);
    const out = await new ClaudeAgentSdkRuntime({ sdk, cwd: "/tmp" }).run(input({ tools: [tool], maxTurns: 4, outputSchema: { type: "object" } }), () => {});
    expect(out.structured).toEqual({ ok: 1 });
    const o = queries[0]!.params.options;
    expect(o.allowedTools).toEqual(["mcp__allevia__metric_trend"]);
    expect(o.tools).toEqual([]);
    expect(o.settingSources).toEqual([]);
    expect(o.maxTurns).toBe(4);
    expect(o.outputFormat).toEqual({ type: "json_schema", schema: { type: "object" } });
  });
});
