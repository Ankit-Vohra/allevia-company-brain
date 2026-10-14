import { describe, it, expect } from "vitest";
import { z } from "zod";
import type { AgentEvent } from "../../shared/contracts.js";
import type { GraphHandle } from "../../src/graph/client.js";
import { normalisePlan, reviewersFor, runTurn, toProposal, arrayArgKey, type TurnDeps, type TurnInput } from "../../src/agent/orchestrator.js";
import { FakeRuntime, type FakeScript } from "../../src/agent/runtime.js";
import type { AlleviaTool } from "../../src/agent/tool.js";
import { fakeTool, recorder, result, NOW } from "../helpers/agent.js";

// ---------- fixtures ----------

const node = (id: string, label: string, name = id, extra: Record<string, unknown> = {}) => ({ id, label, name, ...extra });

function registry() {
  const tools: Record<string, AlleviaTool & { calls: Array<{ args: Record<string, unknown>; agentId: string }> }> = {
    search: fakeTool("search", result({ data: [{ id: "decision:pause-stories" }], nodes: [node("decision:pause-stories", "Decision", "Pause daily stories", { asOf: "2026-10-10" })] })),
    metric_trend: fakeTool("metric_trend", result({
      data: { metric: "signups", points: [{ week: "2026-10-05", value: 41 }, { week: "2026-09-28", value: 55 }] },
      nodes: [node("metric:signups", "Metric", "Signups"), node("obs:signups:2026-10-05", "Observation", "signups (2026-10-05)", { asOf: "2026-10-06" })],
    })),
    get_entity: fakeTool("get_entity", result({ data: { status: "broken" }, nodes: [node("system:sitemap", "System", "Sitemap")] })),
    seo_report: fakeTool("seo_report", result({ data: [], nodes: [node("page:x.ai/jobs", "Page", "Jobs page")] })),
    content_performance: fakeTool("content_performance", result({ data: [{ hook: "question", multiple: 2.4 }], nodes: [node("content:reel-1", "Content", "Reel 1")] })),
    playbook: fakeTool("playbook", result({ data: [], nodes: [node("rule:no-jargon", "Rule", "No jargon")] })),
    show_path: fakeTool("show_path", (args) => {
      const ids = (args.ids as string[]) ?? [];
      return result({ data: { ids }, nodes: ids.map((id) => node(id, "Entity")), edges: ids.slice(1).map((id, i) => ({ from: ids[i]!, type: "AFFECTS", to: id })) });
    }, { ids: z.array(z.string()) }),
    propose_action: fakeTool("propose_action", (args) => result({
      data: { recommendationId: "recommendation:fix-sitemap", approvalId: "approval:fix-sitemap", title: args.title, kind: args.kind },
      nodes: [node("recommendation:fix-sitemap", "Recommendation", String(args.title)), node("approval:fix-sitemap", "Approval", "pending")],
    }), { title: z.string(), kind: z.string() }),
  };
  const getTools = (names: string[]) => names.map((n) => tools[n]).filter((t): t is NonNullable<typeof t> => !!t);
  return { tools, getTools };
}

const INPUT: TurnInput = {
  tenant: "test", question: "Why did signups drop last week?", sessionId: "session:s1", turnId: "turn:t1", asker: "person:founder",
  recall: { text: "- [[turn:old]] 2026-10-01 · Q: signups?", ids: ["turn:old"] },
};

function setup(scripts: Record<string, FakeScript>, over: Partial<TurnDeps> = {}) {
  const { tools, getTools } = registry();
  const runtime = new FakeRuntime(scripts);
  const deps: TurnDeps = { runtime, getTools, graph: {} as GraphHandle, now: NOW, ...over };
  const rec = recorder();
  return { tools, runtime, deps, ...rec, run: () => runTurn(INPUT, deps, rec.emit) };
}

const plan = (steps: unknown[], rationale = "because") => ({ structured: { steps, rationale } });
const finding = (text: string, extra: Record<string, unknown> = {}) => ({ structured: { text, citations: [], ...extra } });
const idx = (events: AgentEvent[], pred: (e: AgentEvent) => boolean) => events.findIndex(pred);
const is = (type: string, agent?: string, extra: (e: any) => boolean = () => true) =>
  (e: AgentEvent) => e.type === type && (agent === undefined || (e as { agent?: string }).agent === agent) && extra(e);

// ---------- pure helpers ----------

describe("normalisePlan", () => {
  it("drops unknown agents, merges duplicate desks and caps at 5 steps", () => {
    const p = normalisePlan({ rationale: "r", steps: [
      { agent: "data-analyst", task: "a" }, { agent: "ghost", task: "x" }, { agent: "data-analyst", task: "b" },
      { agent: "tech-lead", task: "t" }, { agent: "growth-marketer", task: "g" }, { agent: "librarian", task: "l" },
      { agent: "ops-manager", task: "o" }, { agent: "coe-lead", task: "c" },
    ] }, "q");
    expect(p.steps.map((s) => s.agent)).toEqual(["data-analyst", "tech-lead", "growth-marketer", "librarian", "ops-manager"]);
    expect(p.steps[0]!.task).toBe("a; b");
  });
  it("keeps only `after` agents that are planned, orders topologically and breaks cycles", () => {
    const p = normalisePlan({ rationale: "", steps: [
      { agent: "growth-marketer", task: "g", after: ["data-analyst", "librarian"] },
      { agent: "data-analyst", task: "a" },
      { agent: "tech-lead", task: "t", after: ["ops-manager"] },
      { agent: "ops-manager", task: "o", after: ["tech-lead"] },
    ] }, "q");
    expect(p.steps.map((s) => s.agent)).toEqual(["data-analyst", "growth-marketer", "tech-lead", "ops-manager"]);
    expect(p.steps[1]).toEqual({ agent: "growth-marketer", task: "g", after: ["data-analyst"] });
    expect(p.steps[2]).toEqual({ agent: "tech-lead", task: "t" }); // cycle broken here
    expect(p.steps[3]).toEqual({ agent: "ops-manager", task: "o", after: ["tech-lead"] });
  });
  it("infers `after` when a task names another planned desk (id, title or name) that the model left out", () => {
    const p = normalisePlan({ rationale: "", steps: [
      { agent: "growth-marketer", task: "After the data-analyst breakdown, check spend" },
      { agent: "data-analyst", task: "Break down signups" },
      { agent: "coe-lead", task: "Sanity-check Kabir's numbers and the Growth Marketer's budget" },
      { agent: "tech-lead", task: "Check the dev deploy" },
    ] }, "q");
    expect(p.steps).toEqual([
      { agent: "data-analyst", task: "Break down signups" },
      { agent: "tech-lead", task: "Check the dev deploy" },
      { agent: "growth-marketer", task: "After the data-analyst breakdown, check spend", after: ["data-analyst"] },
      { agent: "coe-lead", task: "Sanity-check Kabir's numbers and the Growth Marketer's budget", after: ["growth-marketer", "data-analyst"] },
    ]);
  });

  it("turns the Chief alongside desks into a synthesis note, and nothing usable into a fast path", () => {
    const p = normalisePlan({ rationale: "r", steps: [{ agent: "chief-of-staff", task: "keep it short" }, { agent: "librarian", task: "l" }] }, "q");
    expect(p.steps).toEqual([{ agent: "librarian", task: "l" }]);
    expect(p.chiefTask).toBe("keep it short");
    expect(normalisePlan(undefined, "What is X?").steps).toEqual([{ agent: "chief-of-staff", task: "What is X?" }]);
    expect(normalisePlan({ steps: [{ agent: "ghost", task: "x" }] }, "q").steps[0]!.agent).toBe("chief-of-staff");
  });
});

describe("reviewersFor (relevance rules)", () => {
  const ids = (p: string, t: string) => reviewersFor(p, t).map((a) => a.id);
  it("content always gets the copy editor and the fact checker", () => {
    expect(ids("content-strategist", "Three hooks [[content:reel-1]]")).toEqual(["copy-editor", "fact-checker"]);
  });
  it("analysts and marketers get CoE and the fact checker only when the finding has numbers", () => {
    expect(ids("data-analyst", "Signups fell after the sitemap broke on 2026-10-05.")).toEqual([]);
    expect(ids("data-analyst", "Signups fell from 55 to 41.")).toEqual(["coe-lead", "fact-checker"]);
    expect(ids("growth-marketer", "Spend ₹5,000 on search.")).toEqual(["coe-lead", "fact-checker"]);
  });
  it("desks nobody reviews get no reviewers", () => {
    expect(ids("tech-lead", "The sitemap returns 404.")).toEqual([]);
  });
});

describe("toProposal and arrayArgKey", () => {
  it("reads ids from flat data, nested data or returned nodes", () => {
    expect(toProposal("tech-lead", { title: "Fix sitemap", kind: "github_issue" }, result({ data: { recommendationId: "recommendation:a", approvalId: "approval:a" } })))
      .toEqual({ agent: "tech-lead", recommendationId: "recommendation:a", approvalId: "approval:a", title: "Fix sitemap", kind: "github_issue" });
    expect(toProposal("x", {}, result({ data: { recommendation: { id: "recommendation:b", title: "T", kind: "pause_ad" }, approval: { id: "approval:b" } } })))
      .toMatchObject({ recommendationId: "recommendation:b", approvalId: "approval:b", title: "T", kind: "pause_ad" });
    expect(toProposal("x", { kind: "nonsense" }, result({ data: {}, nodes: [node("recommendation:c", "Recommendation", "Do C"), node("approval:c", "Approval")] })))
      .toMatchObject({ recommendationId: "recommendation:c", approvalId: "approval:c", title: "Do C", kind: "content_draft" });
    expect(toProposal("x", {}, result({ data: {} }))).toBeUndefined();
  });
  it("finds the id-list key of a tool's input shape", () => {
    expect(arrayArgKey({ ids: z.array(z.string()) })).toBe("ids");
    expect(arrayArgKey({ note: z.string(), nodes: z.array(z.string()).optional() })).toBe("nodes");
    expect(arrayArgKey({ note: z.string() })).toBeUndefined();
  });
});

// ---------- runTurn ----------

describe("runTurn: a 3-desk plan with a dependency", () => {
  const scripts: Record<string, FakeScript> = {
    "chief-of-staff:plan": plan([
      { agent: "data-analyst", task: "Find why signups dropped" },
      { agent: "tech-lead", task: "Check site health" },
      { agent: "growth-marketer", task: "Suggest a channel move", after: ["data-analyst"] },
    ], "Numbers, site, then a move"),
    "data-analyst": { delayMs: 30, calls: [{ name: "metric_trend", args: { metric: "signups" } }], ...finding("Signups dropped after the sitemap broke [[metric:signups]].", { citations: ["metric:signups"] }) },
    "tech-lead": { delayMs: 5, calls: [{ name: "get_entity", args: { id: "system:sitemap" } }], ...finding("The sitemap is broken [[system:sitemap]].") },
    "growth-marketer": { ...finding("Fix the sitemap before spending on search [[system:sitemap]].", { basedOn: ["finding:t1-data-analyst", "finding:bogus"] }) },
    "chief-of-staff:synthesis": {
      calls: [{ name: "show_path", args: { ids: ["system:sitemap", "metric:signups"] } }],
      text: "Signups dropped because the sitemap broke [[system:sitemap]] [[metric:signups]]. Next: fix the sitemap.",
    },
  };

  it("plans, runs independent desks in parallel, hands off before the dependent starts, then answers", async () => {
    const { events, run, runtime } = setup(scripts);
    const out = await run();

    expect(events.slice(0, 4).map((e) => e.type)).toEqual(["recall", "agent_start", "agent_done", "plan"]);
    expect(events[3]).toEqual({ type: "plan", by: "chief-of-staff", rationale: "Numbers, site, then a move", steps: [
      { agent: "data-analyst", task: "Find why signups dropped" },
      { agent: "tech-lead", task: "Check site health" },
      { agent: "growth-marketer", task: "Suggest a channel move", after: ["data-analyst"] },
    ] });

    const startA = idx(events, is("agent_start", "data-analyst"));
    const startT = idx(events, is("agent_start", "tech-lead"));
    const firstDeskDone = idx(events, (e) => e.type === "agent_done" && e.agent !== "chief-of-staff");
    expect(startA).toBeGreaterThan(3);
    expect(startT).toBeGreaterThan(3);
    expect(Math.max(startA, startT)).toBeLessThan(firstDeskDone); // both started before either finished
    expect(idx(events, is("agent_done", "tech-lead"))).toBeLessThan(idx(events, is("agent_done", "data-analyst"))); // really parallel

    const findingA = idx(events, is("finding", "data-analyst"));
    const doneA = idx(events, is("agent_done", "data-analyst"));
    const handoff = idx(events, is("handoff"));
    const startG = idx(events, is("agent_start", "growth-marketer"));
    expect(events[handoff]).toMatchObject({ from: "data-analyst", to: "growth-marketer" });
    expect(findingA).toBeLessThan(handoff);
    expect(doneA).toBeLessThan(handoff);
    expect(handoff).toBeLessThan(startG);
    expect(events.filter(is("handoff"))).toHaveLength(1);

    // tool calls are attributed to the agent that made them
    expect(events.find(is("tool_call", undefined, (e) => e.name === "metric_trend"))).toMatchObject({ agent: "data-analyst" });

    // the dependent got the finding it depends on, and its basedOn keeps only real findings
    const gRun = runtime.runs.find((r) => r.agentId === "growth-marketer")!;
    expect(gRun.prompt).toContain("Signups dropped after the sitemap broke");
    expect(gRun.prompt).toContain("finding:t1-data-analyst");
    expect(events.find(is("finding", "growth-marketer"))).toMatchObject({ findingId: "finding:t1-growth-marketer", basedOn: ["finding:t1-data-analyst"] });

    // synthesis after all desks, streamed, then the path
    const synth = idx(events, is("agent_start", "chief-of-staff", (e) => e.task === "Writing the answer"));
    expect(synth).toBeGreaterThan(idx(events, is("agent_done", "growth-marketer")));
    const text = events.filter(is("text")).map((e) => (e as { delta: string }).delta).join("");
    expect(text).toBe(out.answer);
    const showResult = idx(events, is("tool_result", "chief-of-staff", (e) => e.name === "show_path"));
    expect(events[showResult + 1]).toMatchObject({ type: "path", nodes: [{ id: "system:sitemap" }, { id: "metric:signups" }] });
    expect(events.at(-1)).toMatchObject({ type: "agent_done", agent: "chief-of-staff", ok: true });

    // the synthesis prompt carries every finding
    const sRun = runtime.runs.find((r) => r.phase === "synthesis")!;
    for (const a of ["Kabir (Data Analyst)", "Arjun (Tech Lead)", "Rohan (Growth Marketer)"]) expect(sRun.prompt).toContain(a);
    expect(sRun.streamText).toBe(true);

    expect(out.agents).toEqual(["chief-of-staff", "data-analyst", "tech-lead", "growth-marketer"]);
    expect(out.findings.map((f) => f.id)).toEqual(["finding:t1-data-analyst", "finding:t1-tech-lead", "finding:t1-growth-marketer"]);
    expect(out.findings[0]!.citations).toEqual(["metric:signups"]);
    expect(out.fastPath).toBe(false);
    expect(out.ok).toBe(true);
    expect(out.path?.nodes.map((n) => n.id)).toEqual(["system:sitemap", "metric:signups"]);
    expect(out.touched.has("turn:old")).toBe(true); // recall ids count as seen
    expect(out.touched.has("system:sitemap")).toBe(true);
  });

  it("each desk runs with only its own roster tools, and the model override applies to all", async () => {
    const { run, runtime } = setup(scripts, { model: "haiku" });
    await run();
    const a = runtime.runs.find((r) => r.agentId === "data-analyst")!;
    expect(a.tools.map((t) => t.name)).toEqual(["metric_trend", "seo_report", "content_performance", "search"]);
    expect(a.outputSchema).toBeDefined();
    expect(runtime.runs.every((r) => r.model === "haiku")).toBe(true);
    expect(runtime.runs.find((r) => r.phase === "plan")!.tools).toEqual([]);
  });
});

describe("runTurn: reviews", () => {
  it("a 'fix' verdict triggers exactly one revision with the same finding id", async () => {
    const { events, run, runtime } = setup({
      "chief-of-staff:plan": plan([{ agent: "content-strategist", task: "Three reel ideas for employers" }]),
      "content-strategist:work": { calls: [{ name: "content_performance" }], ...finding("Let's delve into hooks: question hooks win [[content:reel-1]].") },
      "content-strategist:revise": finding("Question hooks win for employers [[content:reel-1]]."),
      "copy-editor:review": { structured: { verdict: "fix", note: "Drop 'delve'." } },
      "fact-checker:review": { structured: { verdict: "ok", note: "Claims hold." } },
      "chief-of-staff:synthesis": { text: "Use question hooks [[content:reel-1]]." },
    });
    const out = await run();

    expect(runtime.runs.filter((r) => r.agentId === "content-strategist").map((r) => r.phase)).toEqual(["work", "revise"]);
    expect(runtime.runs.filter((r) => r.agentId === "copy-editor")).toHaveLength(1);
    expect(runtime.runs.filter((r) => r.agentId === "coe-lead")).toHaveLength(0);
    const findings = events.filter(is("finding", "content-strategist")) as Array<Extract<AgentEvent, { type: "finding" }>>;
    expect(findings.map((f) => f.findingId)).toEqual(["finding:t1-content-strategist", "finding:t1-content-strategist"]);
    expect(findings[1]!.text).toBe("Question hooks win for employers [[content:reel-1]].");
    expect(events.filter(is("review")).map((e) => [(e as { agent: string }).agent, (e as { verdict: string }).verdict]).sort())
      .toEqual([["copy-editor", "fix"], ["fact-checker", "ok"]]);
    // both reviewers start before either finishes (parallel), and the revision comes after both reviews
    const starts = [idx(events, is("agent_start", "copy-editor")), idx(events, is("agent_start", "fact-checker"))];
    const dones = [idx(events, is("agent_done", "copy-editor")), idx(events, is("agent_done", "fact-checker"))];
    expect(Math.max(...starts)).toBeLessThan(Math.min(...dones));
    expect(idx(events, is("agent_start", "content-strategist", (e) => e.task === "Revising after review"))).toBeGreaterThan(Math.max(...dones));
    expect(runtime.runs.find((r) => r.phase === "revise")!.prompt).toContain("Dev (Brand & Copy Editor): fix, Drop 'delve'.");

    expect(out.findings[0]).toMatchObject({ revised: true, rejected: false, text: "Question hooks win for employers [[content:reel-1]]." });
    expect(out.reviews).toHaveLength(2);
    expect(out.agents).toEqual(["chief-of-staff", "content-strategist", "copy-editor", "fact-checker"]);
  });

  it("a unanimous 'reject' marks the finding rejected, skips revision and warns the Chief", async () => {
    const { run, runtime } = setup({
      "chief-of-staff:plan": plan([{ agent: "data-analyst", task: "Signups" }]),
      "data-analyst": finding("Signups were 99 [[metric:signups]]."),
      "coe-lead": { structured: { verdict: "reject", note: "99 is not in the data." } },
      "fact-checker": { structured: { verdict: "reject", note: "Unsupported." } },
      "chief-of-staff:synthesis": { text: "Not recorded." },
    });
    const out = await run();
    expect(runtime.runs.filter((r) => r.agentId === "data-analyst")).toHaveLength(1);
    expect(out.findings[0]!.rejected).toBe(true);
    expect(runtime.runs.find((r) => r.phase === "synthesis")!.prompt).toContain("REJECTED: do not rely on it");
  });

  it("reviewers who disagree (reject + ok) earn one revision with every non-ok note, not a rejection", async () => {
    const { run, runtime } = setup({
      "chief-of-staff:plan": plan([{ agent: "data-analyst", task: "Signups" }]),
      "data-analyst:work": { calls: [{ name: "metric_trend", args: { metric: "signups" } }], ...finding("Signups fell from 55 to 41 [[metric:signups]].") },
      "data-analyst:revise": finding("Signups fell from 55 to 41 in the week to 2026-10-05 [[metric:signups]] [[obs:signups:2026-10-05]]."),
      "coe-lead": { structured: { verdict: "ok", note: "Figures match." } },
      "fact-checker": { structured: { verdict: "reject", note: "Could not find the source." } },
      "chief-of-staff:synthesis": { text: "Signups fell from 55 to 41 [[metric:signups]]." },
    });
    const out = await run();
    expect(runtime.runs.filter((r) => r.agentId === "data-analyst").map((r) => r.phase)).toEqual(["work", "revise"]);
    expect(runtime.runs.find((r) => r.phase === "revise")!.prompt).toContain("Nisha (Fact Checker): reject, Could not find the source.");
    expect(runtime.runs.find((r) => r.phase === "revise")!.prompt).not.toContain("Figures match.");
    expect(out.findings[0]).toMatchObject({ rejected: false, revised: true });
  });

  it("reviewers see which cited ids the tools returned and the automatic number check", async () => {
    const { runtime, run } = setup({
      "chief-of-staff:plan": plan([{ agent: "data-analyst", task: "Signups" }]),
      "data-analyst": { calls: [{ name: "metric_trend", args: { metric: "signups" } }], ...finding("Signups fell from 55 to 41 [[obs:signups:2026-10-05]] and 77 [[made:up]].") },
      "chief-of-staff:synthesis": { text: "ok" },
    });
    await run();
    const p = runtime.runs.find((r) => r.agentId === "coe-lead")!.prompt;
    expect(p).toContain('- obs:signups:2026-10-05: Observation "signups (2026-10-05)", as of 2026-10-06');
    expect(p).toContain("Automatic check: cited but returned by no tool: made:up; numbers not found in any tool data: 77");
    expect(runtime.runs.find((r) => r.phase === "synthesis")!.prompt).toContain("Automatic check: cited but returned by no tool: made:up");
  });
});

describe("runTurn: fast path", () => {
  it("a single chief-of-staff step answers with tools directly, without findings or reviews", async () => {
    const { events, run, runtime, tools } = setup({
      "chief-of-staff:plan": plan([{ agent: "chief-of-staff", task: "Look up the decision" }], "Quick lookup"),
      "chief-of-staff:direct": {
        calls: [{ name: "search", args: { query: "daily stories" } }],
        text: "We paused daily stories [[decision:pause-stories]] as of 2026-10-10. Cites [[made:up]] too.",
      },
    });
    const out = await run();
    expect(out.fastPath).toBe(true);
    expect(events.some((e) => e.type === "finding" || e.type === "review" || e.type === "handoff")).toBe(false);
    const direct = runtime.runs.find((r) => r.phase === "direct")!;
    expect(direct.tools.map((t) => t.name)).toContain("show_path");
    expect(direct.streamText).toBe(true);
    // the Chief didn't call show_path, so the orchestrator did, with the cited ids it actually saw, in order
    expect(tools.show_path!.calls).toEqual([{ args: { ids: ["decision:pause-stories"] }, agentId: "chief-of-staff" }]);
    expect(events.find(is("path"))).toMatchObject({ nodes: [{ id: "decision:pause-stories" }] });
    expect(out.agents).toEqual(["chief-of-staff"]);
    expect(out.findings).toEqual([]);
  });

  it("an answer re-written after show_path is dropped from the stream and the answer", async () => {
    const answer = "We paused daily stories on 2026-10-10 to put the time into reels [[decision:pause-stories]]. Next: review reel reach.";
    const { events, run } = setup({
      "chief-of-staff:plan": plan([{ agent: "chief-of-staff", task: "Look it up" }]),
      "chief-of-staff:direct": {
        preText: answer,
        calls: [{ name: "search", args: { query: "stories" } }, { name: "show_path", args: { ids: ["decision:pause-stories"] } }],
        text: "To recap: we paused daily stories [[decision:pause-stories]].",
      },
    });
    const out = await run();
    expect(out.answer).toBe(answer);
    expect(events.filter(is("text")).map((e) => (e as { delta: string }).delta).join("")).toBe(answer);
  });

  it("a failed plan falls back to the fast path", async () => {
    const { events, run } = setup({ "chief-of-staff:plan": { fail: "overloaded" }, "chief-of-staff:direct": { text: "Not recorded." } });
    const out = await run();
    expect(events.find(is("agent_done", "chief-of-staff"))).toMatchObject({ ok: false });
    expect(events.find(is("plan"))).toMatchObject({ steps: [{ agent: "chief-of-staff", task: INPUT.question }] });
    expect(out.fastPath).toBe(true);
    expect(out.answer).toBe("Not recorded.");
  });
});

describe("runTurn: failures and proposals", () => {
  it("a failing desk emits agent_done ok:false, its dependent works without it, and the Chief is told", async () => {
    const { events, run, runtime } = setup({
      "chief-of-staff:plan": plan([
        { agent: "data-analyst", task: "Signups" }, { agent: "tech-lead", task: "Site" },
        { agent: "growth-marketer", task: "Move", after: ["data-analyst"] },
      ]),
      "data-analyst": { calls: [{ name: "metric_trend", args: { metric: "signups" } }], fail: "model overloaded" },
      "tech-lead": finding("The sitemap is broken [[system:sitemap]]."),
      "growth-marketer": finding("Hold spend [[system:sitemap]]."),
      "chief-of-staff:synthesis": { text: "The sitemap is broken [[system:sitemap]]; the signup numbers are missing." },
    });
    const out = await run();
    expect(events.find(is("agent_done", "data-analyst"))).toMatchObject({ ok: false });
    expect(events.find(is("agent_status", "data-analyst", (e) => /Couldn't finish/.test(e.text)))).toBeDefined();
    expect(events.filter(is("handoff"))).toHaveLength(0);
    expect(runtime.runs.find((r) => r.agentId === "growth-marketer")!.prompt).toContain("Kabir (Data Analyst) could not finish");
    expect(runtime.runs.find((r) => r.phase === "synthesis")!.prompt).toContain("Desks that could not finish: Kabir (Data Analyst)");
    expect(out.failed).toEqual(["data-analyst"]);
    expect(out.ok).toBe(true);
    expect(out.touched.has("metric:signups")).toBe(true); // what it saw before failing still counts
  });

  it("a tool registry that throws for one desk fails only that desk", async () => {
    const { getTools } = registry();
    const { events, run } = setup({
      "chief-of-staff:plan": plan([{ agent: "librarian", task: "History" }, { agent: "tech-lead", task: "Site" }]),
      "tech-lead": finding("The sitemap is broken [[system:sitemap]]."),
      "chief-of-staff:synthesis": { text: "The sitemap is broken [[system:sitemap]]." },
    }, { getTools: (names) => { if (names.includes("trace_decision")) throw new Error("registry broken"); return getTools(names); } });
    const out = await run();
    expect(events.find(is("agent_done", "librarian"))).toMatchObject({ ok: false });
    expect(out.failed).toEqual(["librarian"]);
    expect(out.ok).toBe(true);
  });

  it("a desk that runs past the timeout is stopped and reported as failed", async () => {
    const { events, run } = setup({
      "chief-of-staff:plan": plan([{ agent: "librarian", task: "History" }]),
      librarian: { delayMs: 5_000, ...finding("late") },
      "chief-of-staff:synthesis": { text: "Not recorded." },
    }, { agentTimeoutMs: 40 });
    const t0 = Date.now();
    const out = await run();
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(events.find(is("agent_status", "librarian"))).toMatchObject({ text: "Couldn't finish: timed out after 0s" });
    expect(out.failed).toEqual(["librarian"]);
  });

  it("propose_action results become proposal events right after their tool_result", async () => {
    const { events, run } = setup({
      "chief-of-staff:plan": plan([{ agent: "tech-lead", task: "Fix the site" }]),
      "tech-lead": { calls: [{ name: "propose_action", args: { title: "Fix the sitemap", kind: "github_issue" } }], ...finding("Proposed a fix [[system:sitemap]].") },
      "chief-of-staff:synthesis": { text: "Approve the sitemap fix." },
    });
    const out = await run();
    const i = idx(events, is("tool_result", "tech-lead", (e) => e.name === "propose_action"));
    expect(events[i + 1]).toEqual({ type: "proposal", agent: "tech-lead", recommendationId: "recommendation:fix-sitemap", approvalId: "approval:fix-sitemap", title: "Fix the sitemap", kind: "github_issue" });
    expect(out.proposals).toHaveLength(1);
    expect(out.path).toBeUndefined(); // nothing cited, no path
  });

  it("when the Chief cannot write the answer, the desks' findings are returned with an error event", async () => {
    const { events, run } = setup({
      "chief-of-staff:plan": plan([{ agent: "tech-lead", task: "Site" }]),
      "tech-lead": finding("The sitemap is broken [[system:sitemap]]."),
      "chief-of-staff:synthesis": { fail: "overloaded" },
    });
    const out = await run();
    expect(out.ok).toBe(false);
    expect(events.find(is("error", "chief-of-staff"))).toMatchObject({ message: "The Chief of Staff could not write the answer: overloaded." });
    expect(out.answer).toContain("**Arjun:** The sitemap is broken [[system:sitemap]].");
    expect(events.filter(is("text")).map((e) => (e as { delta: string }).delta).join("")).toBe(out.answer);
  });
});
