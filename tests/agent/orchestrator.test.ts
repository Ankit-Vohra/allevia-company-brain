import { describe, it, expect } from "vitest";
import { z } from "zod";
import type { AgentEvent } from "../../shared/contracts.js";
import type { GraphHandle } from "../../src/graph/client.js";
import { AGENTS, agentById } from "../../shared/roster.js";
import {
  MAX_REVIEWERS, MAX_TURNS, PATH_FIRST_NOTE, asksToRemember, notePathFirst, toolRounds, normalisePlan, isDiagnosisQuestion, rememberRefusal, reviewersFor, runTurn, toProposal, toolsFor, arrayArgKey,
  type TurnDeps, type TurnInput,
} from "../../src/agent/orchestrator.js";
import { directPrompt, synthesisPrompt } from "../../src/agent/prompts.js";
import { FakeRuntime, type FakeScript, type RunInput } from "../../src/agent/runtime.js";
import type { AlleviaTool } from "../../src/agent/tool.js";
import { CONTENT_FINDING_MAX_CHARS, FINDING_MAX_CHARS } from "../../src/agent/prompts.js";
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
    remember: Object.assign(fakeTool("remember", result({ data: { id: "memory:pref" } }), { text: z.string() }), { writes: true }),
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
  const SEVEN = [
    { agent: "data-analyst", task: "a" }, { agent: "ghost", task: "x" }, { agent: "data-analyst", task: "b" },
    { agent: "tech-lead", task: "t" }, { agent: "growth-marketer", task: "g" }, { agent: "librarian", task: "l" },
    { agent: "ops-manager", task: "o" }, { agent: "coe-lead", task: "c" },
  ];
  it("drops unknown agents, merges duplicate desks and caps an ordinary question at 3 desks (the first listed)", () => {
    const p = normalisePlan({ rationale: "r", steps: SEVEN }, "Which reel did best last week?");
    expect(p.steps.map((s) => s.agent)).toEqual(["data-analyst", "tech-lead", "growth-marketer"]);
    expect(p.steps[0]!.task).toBe("a; b");
  });
  it("allows up to 5 desks only for a broad review of the whole business", () => {
    for (const q of ["How is the business doing overall?", "Give me the weekly review", "Morning brief please", "What is in today's note?", "A full report across the business"]) {
      expect(normalisePlan({ rationale: "r", steps: SEVEN }, q).steps.map((s) => s.agent)).toEqual(["data-analyst", "tech-lead", "growth-marketer", "librarian", "ops-manager"]);
    }
    for (const q of ["How's everything going?", "How are we doing overall?"]) expect(normalisePlan({ rationale: "r", steps: SEVEN }, q).steps.length).toBe(5);
    for (const q of ["Which reel did best?", "Is everything in the sitemap fine?", "Why do we post reels on Tuesdays?"]) {
      expect(normalisePlan({ rationale: "r", steps: SEVEN }, q).steps.length).toBe(3);
    }
  });
  it("allows 5 desks for a diagnosis (why a number fell, what broke), which joins what moved, what broke and what shipped", () => {
    for (const q of ["Why did sign-ups drop this week, and what should we do?", "Why have bookings fallen since Monday?", "What broke on the sign-up page?", "Why is crash-free down?", "Why did traffic dip in Mumbai?"]) {
      expect(isDiagnosisQuestion(q), q).toBe(true);
      expect(normalisePlan({ rationale: "r", steps: SEVEN }, q).steps.length, q).toBe(5);
    }
    for (const q of ["Which reel did best?", "Why do we post reels on Tuesdays?", "Who owns the publisher?", "Why did we pause daily stories?"]) expect(isDiagnosisQuestion(q), q).toBe(false);
  });
  it("keeps only `after` agents that are planned, orders topologically and breaks cycles", () => {
    const p = normalisePlan({ rationale: "", steps: [
      { agent: "growth-marketer", task: "g", after: ["data-analyst", "librarian"] },
      { agent: "data-analyst", task: "a" },
      { agent: "tech-lead", task: "t", after: ["ops-manager"] },
      { agent: "ops-manager", task: "o", after: ["tech-lead"] },
    ] }, "weekly review");
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
    ] }, "weekly review");
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
  it("one numbers reviewer (CoE) when the automatic check already passed; content keeps both of its reviewers", () => {
    expect(reviewersFor("data-analyst", "Signups fell from 55 to 41.", { checked: true }).map((a) => a.id)).toEqual(["coe-lead"]);
    expect(reviewersFor("growth-marketer", "Spend ₹5,000 on search.", { checked: true }).map((a) => a.id)).toEqual(["coe-lead"]);
    expect(reviewersFor("content-strategist", "3 hooks [[content:reel-1]]", { checked: true }).map((a) => a.id)).toEqual(["copy-editor", "fact-checker"]);
  });
  it("desks nobody reviews get no reviewers", () => {
    expect(ids("oncall-engineer", "Sentry shows 14 new issues since 2026-10-14 [[metric:sentry-new-issues]].")).toEqual([]);
    expect(ids("librarian", "We paused stories on 2026-10-10 [[decision:pause-stories]].")).toEqual([]);
  });
  it("the QA & Release Manager reviews the Tech Lead only on releases or app health", () => {
    // Site, SEO and dependency findings are not his: no reviewer.
    expect(ids("tech-lead", "The sitemap returns 404.")).toEqual([]);
    expect(ids("tech-lead", "The reel publisher [[system:reel-publisher]] depends on the connector [[system:ig-connector]].")).toEqual([]);
    expect(ids("tech-lead", "Technical SEO: 12 pages have no canonical tag [[page:jobs]].")).toEqual([]);
    // Releases, store review, crashes and ANRs are.
    for (const t of [
      "Version 4.2.0 went out on 2026-10-12 and the checkout screen broke [[release:4-2-0]].",
      "The iOS build is stuck in App Store review [[system:app-store]].",
      "Crash-free sessions fell after the last release [[metric:crash-free]].",
      "The ANR rate on Play is close to the bad-behaviour threshold [[metric:play-anr-rate]].",
      "The Android app crashes on launch for Samsung devices [[system:android-app]].",
      "Roll back the hotfix: Sentry errors doubled [[metric:sentry-events]].",
    ]) expect(ids("tech-lead", t), t).toEqual(["qa-release"]);
  });
  it("the QA & Release Manager reviews no one but the Tech Lead", () => {
    const release = "Version 4.2.0 crashed on launch [[release:4-2-0]].";
    for (const a of AGENTS.filter((x) => x.id !== "tech-lead")) expect(ids(a.id, release)).not.toContain("qa-release");
  });
  it("never more than MAX_REVIEWERS (2) per finding", () => {
    expect(MAX_REVIEWERS).toBe(2);
    for (const a of AGENTS) expect(reviewersFor(a.id, "Spend 5,000 on search for 41 signups [[metric:signups]]").length).toBeLessThanOrEqual(MAX_REVIEWERS);
  });
});

describe("toolsFor (which tools a job gets)", () => {
  const { getTools } = registry();
  const names = (agent: string, phase: Parameters<typeof toolsFor>[1], lean = false) => toolsFor(agentById(agent)!, phase, getTools, { lean }).map((t) => t.name);
  it("a desk's work gets its roster tools, including the write tools its roster lists", () => {
    expect(names("tech-lead", "work")).toEqual(["search", "get_entity", "seo_report", "propose_action"]);
    expect(names("data-analyst", "work")).not.toContain("propose_action");
  });
  it("reviews and revisions never get write tools", () => {
    expect(names("tech-lead", "revise")).toEqual(["search", "get_entity", "seo_report"]);
    expect(names("coe-lead", "review")).toEqual(["search", "get_entity", "metric_trend"]);
  });
  it("the Chief writing from findings gets only show_path and propose_action; answering alone, all its tools", () => {
    expect(names("chief-of-staff", "synthesis", true)).toEqual(["show_path", "propose_action"]);
    expect(names("chief-of-staff", "direct")).toEqual(["search", "get_entity", "show_path", "propose_action"]);
  });
  it("a registry that hands out more than asked for is cut back to the roster", () => {
    const greedy = (n: string[]) => [...getTools(n), ...getTools(["propose_action", "metric_trend"])];
    expect(toolsFor(agentById("librarian")!, "work", greedy).map((t) => t.name)).toEqual(["search"]);
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
      "data-analyst:work": { calls: [{ name: "metric_trend", args: { metric: "signups" } }], ...finding("Signups fell from 55 to 40 [[metric:signups]].") },
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
    const out = await run();
    expect(out.findings[0]!.citations).toEqual(["obs:signups:2026-10-05"]); // the record keeps only ids a tool returned
    expect(out.findings[0]!.text).toContain("[[made:up]]");                 // the text keeps what was written
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
        calls: [{ name: "show_path", args: { ids: ["decision:pause-stories"] } }],
        text: "To recap: we paused daily stories [[decision:pause-stories]].",
      },
    });
    const out = await run();
    expect(out.answer).toBe(answer);
    expect(events.filter(is("text")).map((e) => (e as { delta: string }).delta).join("")).toBe(answer);
  });

  // Eval 2026-10-15 (two-hop-cron-team): the answer began with the Chief's working note "Owner is agent:ops (OWNS). Check
  // its team.", written before a lookup. Text written before a lookup is a note: it leaves the answer (stored and shown)
  // and goes to the work log as the Chief's status.
  describe("the Chief's working notes", () => {
    const ANSWER = "The publish-due cron is owned by the Ops agent, which belongs to the Operations team [[decision:pause-stories]].";
    const shown = (events: AgentEvent[]) => events.filter(is("text", "chief-of-staff"))
      .reduce((s, e) => ((e as { reset?: boolean }).reset ? (e as { delta: string }).delta : s + (e as { delta: string }).delta), "");

    it("text written before a lookup is a note: not in the answer, taken back from the stream, shown as the Chief's status", async () => {
      const note = "Owner is agent:ops (OWNS). Check its team.";
      const { events, run } = setup({
        "chief-of-staff:plan": plan([{ agent: "chief-of-staff", task: "Look it up" }]),
        "chief-of-staff:direct": {
          turns: [
            { text: note, calls: [{ name: "search", args: { query: "publish-due cron" } }] },
            { text: ANSWER, calls: [{ name: "show_path", args: { ids: ["decision:pause-stories"] } }] },
          ],
        },
      });
      const out = await run();
      expect(out.answer).toBe(ANSWER);
      expect(shown(events)).toBe(ANSWER);
      expect(events.some(is("text", "chief-of-staff", (e) => e.reset === true))).toBe(true);
      expect(events.find(is("agent_status", "chief-of-staff", (e) => e.text.includes("Check its team")))).toBeTruthy();
      // the note is taken back before the lookup runs
      expect(idx(events, is("text", "chief-of-staff", (e) => e.reset === true))).toBeLessThan(idx(events, is("tool_call", "chief-of-staff", (e) => e.name === "search")));
    });

    it("a short note before a path drawn too early is a note as well", async () => {
      const { events, run } = setup({
        "chief-of-staff:plan": plan([{ agent: "chief-of-staff", task: "Look it up" }]),
        "chief-of-staff:direct": { turns: [{ text: "Drawing the path first.", calls: [{ name: "show_path", args: { ids: ["decision:pause-stories"] } }] }, { text: ANSWER }] },
      });
      const out = await run();
      expect(out.answer).toBe(ANSWER);
      expect(shown(events)).toBe(ANSWER);
    });

    it("text before a proposal is part of the answer: an action doesn't make it a note", async () => {
      const first = "Worst: the sitemap is broken [[decision:pause-stories]]. I've drafted a fix for your approval.";
      const second = "It waits for you in Approvals.";
      const { events, run } = setup({
        "chief-of-staff:plan": plan([{ agent: "chief-of-staff", task: "Look it up" }]),
        "chief-of-staff:direct": {
          turns: [
            { text: first, calls: [{ name: "propose_action", args: { title: "Fix the sitemap", kind: "github_issue" } }] },
            { text: second, calls: [{ name: "show_path", args: { ids: ["decision:pause-stories"] } }] },
          ],
        },
      });
      const out = await run();
      expect(out.answer).toBe(`${first}\n\n${second}`);
      expect(shown(events).trim()).toBe(`${first}\n\n${second}`);
    });

    it("an answer written before a last lookup, with nothing after it, is kept rather than lost", async () => {
      const { events, run } = setup({
        "chief-of-staff:plan": plan([{ agent: "chief-of-staff", task: "Look it up" }]),
        "chief-of-staff:direct": { turns: [{ text: ANSWER, calls: [{ name: "search", args: { query: "double-check" } }] }] },
      });
      const out = await run();
      expect(out.answer).toBe(ANSWER);
      expect(shown(events)).toBe(ANSWER);
    });

    it("the direct and synthesis prompts tell the Chief to write nothing before its lookups are done", () => {
      expect(directPrompt({ question: "q", recall: "" })).toMatch(/nothing before/i);
      expect(synthesisPrompt({ question: "q", recall: "", findings: [], failed: [] })).toMatch(/nothing before/i);
    });
  });

  // Eval 2026-10-15 (memory-ig-token): the Chief drew the path before writing anything, then wrote only "Everything is
  // in the answer above." The show_path result it reads now says that the owner has seen no answer yet.
  it("a path drawn before any answer tells the Chief nothing was shown yet; a path drawn after the answer doesn't", async () => {
    const pathSummary = (events: AgentEvent[]) => (events.find(is("tool_result", "chief-of-staff", (e) => e.name === "show_path")) as { summary: string }).summary;
    const answer = "We paused daily stories on 2026-10-10 to put the time into reels [[decision:pause-stories]]. Next: review reel reach.";
    const first = setup({
      "chief-of-staff:plan": plan([{ agent: "chief-of-staff", task: "Look it up" }]),
      "chief-of-staff:direct": { calls: [{ name: "search", args: { query: "stories" } }, { name: "show_path", args: { ids: ["decision:pause-stories"] } }], text: answer },
    });
    const out = await first.run();
    expect(pathSummary(first.events)).toMatch(/no answer yet/);
    expect(out.answer).toBe(answer); // what it writes after the path is the answer

    const after = setup({
      "chief-of-staff:plan": plan([{ agent: "chief-of-staff", task: "Look it up" }]),
      "chief-of-staff:direct": { preText: answer, calls: [{ name: "show_path", args: { ids: ["decision:pause-stories"] } }] },
    });
    await after.run();
    expect(pathSummary(after.events)).not.toMatch(/no answer yet/);
  });

  it("notePathFirst only touches show_path, and only while nothing has been written", async () => {
    let written = false;
    const { tools } = registry();
    const [search, path] = notePathFirst([tools.search!, tools.show_path!], () => written);
    expect(search).toBe(tools.search);
    const ctx = { touched: undefined } as never;
    expect((await path!.run({ ids: ["a"] }, ctx)).note).toBe(PATH_FIRST_NOTE);
    written = true;
    expect((await path!.run({ ids: ["a"] }, ctx)).note).toBeUndefined();
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

// ---------- latency: reviews overlap the work downstream ----------

const CHECKED = "Signups fell from 55 to 41 in the week to 2026-10-05 [[metric:signups]].";
const REVISED = "Signups fell from 55 (week to 2026-09-28) to 41 (week to 2026-10-05) [[metric:signups]].";
const ANSWER = "Signups fell from 55 to 41 in the week to 2026-10-05 [[metric:signups]]. Next: hold paid search until the sitemap is fixed.";
const ok = (note = "Fine.", delayMs = 0) => ({ delayMs, structured: { verdict: "ok", note } });
const fix = (note: string, delayMs = 0) => ({ delayMs, structured: { verdict: "fix", note } });
const trend = { name: "metric_trend", args: { metric: "signups" } };
const texts = (events: AgentEvent[]) => events.filter(is("text")).map((e) => (e as { delta: string }).delta).join("");

describe("runTurn: a finding's review runs alongside the desks that build on it", () => {
  const scripts = (over: Record<string, FakeScript> = {}): Record<string, FakeScript> => ({
    "chief-of-staff:plan": plan([{ agent: "data-analyst", task: "Signups" }, { agent: "growth-marketer", task: "Move", after: ["data-analyst"] }]),
    "data-analyst:work": { calls: [trend], ...finding(CHECKED, { citations: ["metric:signups"] }) },
    "data-analyst:revise": finding(REVISED),
    "coe-lead:review": ok("Figures match.", 80),
    "fact-checker:review": ok("Supported.", 80),
    "growth-marketer:work": { delayMs: 5, ...finding("Hold paid search [[metric:signups]].") },
    "chief-of-staff:synthesis": { text: ANSWER },
    ...over,
  });

  it("a finding whose ids and numbers check out is handed on at once, marked as a draft", async () => {
    const { events, run, runtime } = setup(scripts());
    await run();
    const startG = idx(events, is("agent_start", "growth-marketer"));
    expect(startG).toBeLessThan(idx(events, is("agent_done", "coe-lead"))); // its numbers checked out: one reviewer, the CoE lead
    expect(events.some(is("agent_start", "fact-checker"))).toBe(false);
    expect(events.find(is("handoff"))).toMatchObject({ from: "data-analyst", to: "growth-marketer", note: expect.stringContaining("(draft, review running)") });
    const g = runtime.runs.find((r) => r.agentId === "growth-marketer")!.prompt;
    expect(g).toContain("(draft: its review is still running)");
    expect(g).toContain("rely on its cited data, not its wording");
  });

  it("a finding that fails the automatic check waits for its review before anyone builds on it", async () => {
    const { events, run } = setup(scripts({ "data-analyst:work": { calls: [trend], ...finding("Signups fell to 41 [[made:up]].") } }));
    await run();
    const startG = idx(events, is("agent_start", "growth-marketer"));
    expect(startG).toBeGreaterThan(idx(events, is("agent_done", "coe-lead")));
    expect(startG).toBeGreaterThan(idx(events, is("agent_done", "fact-checker")));
    expect(events.find(is("handoff"))).toMatchObject({ note: expect.not.stringContaining("draft") });
  });

  it("if reviewers then revise the draft, the Chief is told which finding built on the earlier version", async () => {
    const { run, runtime } = setup(scripts({ "coe-lead:review": fix("Name the comparison week.", 40) }));
    const out = await run();
    expect(out.findings[0]).toMatchObject({ revised: true, text: REVISED });
    const s = runtime.runs.filter((r) => r.phase === "synthesis").at(-1)!.prompt;
    expect(s).toContain("Caveat: it built on an earlier draft of Kabir's finding [finding:t1-data-analyst], which reviewers then revised");
    expect(s).toContain(REVISED);
  });

  it("a desk working from a draft proposes only once the draft is final, and not if reviewers changed it", async () => {
    const propose = { calls: [trend, { name: "propose_action", args: { title: "Pause search ads", kind: "pause_ad" } }], ...finding("Pause search [[metric:signups]].") };
    const a = setup(scripts({ "growth-marketer:work": propose }));
    let reviewsWhenRun = -1;
    const real = a.tools.propose_action!.run.bind(a.tools.propose_action);
    a.tools.propose_action!.run = async (args, ctx) => { reviewsWhenRun = a.events.filter(is("review")).length; return real(args, ctx); };
    const okRun = await a.run();
    expect(reviewsWhenRun).toBe(1); // it waited for the draft's review
    expect(okRun.proposals).toHaveLength(1);

    const b = setup(scripts({ "growth-marketer:work": propose, "coe-lead:review": fix("Name the comparison week.", 40) }));
    const changed = await b.run();
    expect(b.tools.propose_action!.calls).toHaveLength(0);
    expect(changed.proposals).toHaveLength(0);
    expect(b.events.find(is("tool_result", "growth-marketer", (e) => e.name === "propose_action"))).toMatchObject({ summary: expect.stringContaining("changed in review") });
  });
});

describe("runTurn: the Chief drafts the answer while the last reviews finish", () => {
  const scripts = (over: Record<string, FakeScript> = {}): Record<string, FakeScript> => ({
    "chief-of-staff:plan": plan([{ agent: "data-analyst", task: "Signups" }]),
    "data-analyst:work": { calls: [trend], ...finding(CHECKED, { citations: ["metric:signups"] }) },
    "data-analyst:revise": finding(REVISED),
    "coe-lead:review": ok("Figures match.", 60),
    "fact-checker:review": ok("Supported.", 60),
    "chief-of-staff:synthesis": {
      preText: ANSWER,
      calls: [{ name: "show_path", args: { ids: ["metric:signups"] } }, { name: "propose_action", args: { title: "Hold paid search", kind: "pause_ad" } }],
    },
    ...over,
  });
  const lastReview = (events: AgentEvent[]) => events.map((e, i) => (e.type === "review" ? i : -1)).reduce((a, b) => Math.max(a, b), -1);

  it("starts before the reviews end, shows nothing until they come back ok, then releases it", async () => {
    const s = setup(scripts());
    let reviewsWhenProposed = -1;
    const real = s.tools.propose_action!.run.bind(s.tools.propose_action);
    s.tools.propose_action!.run = async (args, ctx) => { reviewsWhenProposed = s.events.filter(is("review")).length; return real(args, ctx); };
    const out = await s.run();
    const { events, runtime } = s;
    const start = idx(events, is("agent_start", "chief-of-staff", (e) => e.task === "Writing the answer"));
    expect(start).toBeLessThan(idx(events, is("review")));
    expect(events[start + 1]).toMatchObject({ type: "agent_status", agent: "chief-of-staff", text: "Drafting the answer while Isha finishes reviewing" });
    expect(idx(events, is("text", "chief-of-staff"))).toBeGreaterThan(lastReview(events));
    expect(idx(events, is("path"))).toBeGreaterThan(lastReview(events));
    expect(reviewsWhenProposed).toBe(1); // a write waits for the release
    expect(runtime.runs.filter((r) => r.phase === "synthesis")).toHaveLength(1);
    expect(runtime.runs.find((r) => r.phase === "synthesis")!.prompt).not.toContain("(draft");
    expect(out).toMatchObject({ ok: true, answer: ANSWER });
    expect(texts(events)).toBe(ANSWER);
    expect(out.path?.nodes.map((n) => n.id)).toEqual(["metric:signups"]);
    expect(out.proposals).toHaveLength(1);
    expect(events.filter(is("agent_start", "chief-of-staff"))).toHaveLength(2); // plan + one answer step
  });

  it("a reviewer sending the finding back sets the draft aside: its run is stopped, none of it is shown, and the Chief writes again", async () => {
    const signals: Array<AbortSignal | undefined> = [];
    const s = setup(scripts({
      "coe-lead:review": fix("Name the comparison week.", 20),
      "chief-of-staff:synthesis": (input: RunInput, n: number) => {
        signals.push(input.signal);
        return n === 0 ? { delayMs: 3_000, preText: "DRAFT that must never be seen [[metric:signups]]." } : { preText: ANSWER, calls: [{ name: "show_path", args: { ids: ["metric:signups"] } }] };
      },
    }));
    const t0 = Date.now();
    const out = await s.run();
    expect(Date.now() - t0).toBeLessThan(2_000); // the draft was stopped, not waited out
    expect(signals).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(texts(s.events)).toBe(ANSWER);
    expect(s.events.some((e) => e.type === "path" && e.nodes.length !== 1)).toBe(false);
    expect(s.runtime.runs.filter((r) => r.phase === "synthesis")[1]!.prompt).toContain(REVISED);
    expect(s.events.find(is("agent_status", "chief-of-staff", (e) => /sent a finding back/.test(e.text)))).toBeDefined();
    expect(s.events.filter(is("agent_done", "chief-of-staff"))).toHaveLength(2);
    expect(out).toMatchObject({ ok: true, answer: ANSWER });
  });

  it("a draft that fails while held is written again once the reviews are in", async () => {
    const s = setup(scripts({ "chief-of-staff:synthesis": [{ fail: "overloaded" }, { text: ANSWER }] }));
    const out = await s.run();
    expect(out).toMatchObject({ ok: true, answer: ANSWER });
    expect(s.events.some((e) => e.type === "error")).toBe(false);
    expect(idx(s.events, is("text", "chief-of-staff"))).toBeGreaterThan(lastReview(s.events));
  });

  it("with draftWhileReviewing off, the Chief starts only after every review", async () => {
    const { events, run } = setup(scripts(), { draftWhileReviewing: false });
    await run();
    expect(idx(events, is("agent_start", "chief-of-staff", (e) => e.task === "Writing the answer"))).toBeGreaterThan(lastReview(events));
  });

  it("a finding already sent back when the last finding lands holds the Chief back until its revision lands", async () => {
    const { events, run, runtime } = setup(scripts({
      "chief-of-staff:plan": plan([{ agent: "data-analyst", task: "Signups" }, { agent: "librarian", task: "History" }]),
      librarian: { delayMs: 40, ...finding("We paused daily stories [[decision:pause-stories]].") },
      "coe-lead:review": fix("Name the comparison week.", 5),
      "fact-checker:review": ok("Supported.", 5),
      "data-analyst:revise": { delayMs: 80, ...finding(REVISED) },
    }));
    await run();
    expect(idx(events, is("finding", "librarian"))).toBeLessThan(events.findLastIndex(is("finding", "data-analyst"))); // landed mid-revision
    const revised = events.findLastIndex(is("agent_done", "data-analyst"));
    expect(events[revised - 1]).toMatchObject({ type: "finding", text: REVISED });
    expect(idx(events, is("agent_start", "chief-of-staff", (e) => e.task === "Writing the answer"))).toBeGreaterThan(revised);
    expect(runtime.runs.filter((r) => r.phase === "synthesis")).toHaveLength(1);
    expect(runtime.runs.find((r) => r.phase === "synthesis")!.prompt).toContain(REVISED);
  });
});

describe("runTurn: budgets, timeouts and stopping", () => {
  it("every job runs with its turn budget, and its prompt states the tool rounds", async () => {
    const { run, runtime } = setup({
      "chief-of-staff:plan": plan([{ agent: "data-analyst", task: "Signups" }]),
      "data-analyst:work": { calls: [trend], ...finding(CHECKED, { citations: ["metric:signups"] }) },
      "data-analyst:revise": finding(REVISED),
      "coe-lead:review": fix("Name the comparison week."),
      "fact-checker:review": ok(),
      "chief-of-staff:synthesis": { text: ANSWER },
    });
    await run();
    expect(new Set(runtime.runs.map((r) => r.phase))).toEqual(new Set(["plan", "work", "review", "revise", "synthesis"]));
    for (const r of runtime.runs) expect(r.maxTurns).toBe(MAX_TURNS[r.phase!]);
    expect(runtime.runs.find((r) => r.phase === "work")!.prompt).toContain(`at most ${toolRounds("work")} rounds of tool calls`);
    expect(runtime.runs.find((r) => r.phase === "review")!.prompt).toContain(`at most ${toolRounds("review")} round of lookups`);
    expect(toolRounds("review")).toBe(MAX_TURNS.review - 1); // a review: one lookup at most, then its verdict
    expect(runtime.runs.find((r) => r.phase === "synthesis")!.tools.map((t) => t.name)).toEqual(["show_path", "propose_action"]);
  });

  it("a desk that times out has its run aborted (so the SDK closes its process), not just abandoned", async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const { run } = setup({
      "chief-of-staff:plan": plan([{ agent: "librarian", task: "History" }]),
      librarian: (input: RunInput) => { seen.push(input.signal); return { delayMs: 5_000, ...finding("late") }; },
      "chief-of-staff:synthesis": { text: "Not recorded." },
    }, { agentTimeoutMs: 40 });
    const out = await run();
    expect(out.failed).toEqual(["librarian"]);
    expect(seen[0]!.aborted).toBe(true);
    expect(String((seen[0]!.reason as Error).message)).toMatch(/timed out/);
  });

  it("the turn's signal stops every running agent at once", async () => {
    const ac = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    const slow = (input: RunInput) => { seen.push(input.signal); return { delayMs: 5_000, ...finding("late") }; };
    const { run, events } = setup({
      "chief-of-staff:plan": plan([{ agent: "librarian", task: "History" }, { agent: "tech-lead", task: "Site" }]),
      librarian: slow, "tech-lead": slow,
      "chief-of-staff:synthesis": { text: "never" },
    }, { signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    const t0 = Date.now();
    const out = await run();
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(seen).toHaveLength(2);
    expect(seen.every((s) => s!.aborted)).toBe(true);
    expect(out.failed.sort()).toEqual(["librarian", "tech-lead"]);
    expect(out.ok).toBe(false);
    expect(events.find(is("agent_status", "librarian"))).toMatchObject({ text: "Couldn't finish: the turn was stopped" });
  });

  it("an answer written in full and pathed is kept when the Chief's run fails afterwards (e.g. out of turns)", async () => {
    const { events, run } = setup({
      "chief-of-staff:plan": plan([{ agent: "chief-of-staff", task: "Look it up" }]),
      "chief-of-staff:direct": { preText: ANSWER, calls: [{ name: "show_path", args: { ids: ["metric:signups"] } }], fail: "error_max_turns: max turns" },
    });
    const out = await run();
    expect(out).toMatchObject({ ok: true, answer: ANSWER });
    expect(texts(events)).toBe(ANSWER);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });
});

describe("runTurn: a long finding is cut between items, never inside one", () => {
  it("keeps whole bullets within the character limit and no ellipsis", async () => {
    const bullets = Array.from({ length: 12 }, (_, i) => `- Point ${i + 1}: the sitemap issue on page ${i + 1} is still open and needs a fix this week. [[system:sitemap]]`);
    const long = `The sitemap is broken [[system:sitemap]].\n${bullets.join("\n")}`;
    expect(long.length).toBeGreaterThan(FINDING_MAX_CHARS);
    const { events, run } = setup({
      "chief-of-staff:plan": plan([{ agent: "tech-lead", task: "Site" }]),
      "tech-lead": { calls: [{ name: "get_entity", args: { id: "system:sitemap" } }], ...finding(long) },
      "chief-of-staff:synthesis": { text: "The sitemap is broken [[system:sitemap]]." },
    });
    await run();
    const f = events.find(is("finding", "tech-lead")) as Extract<AgentEvent, { type: "finding" }>;
    expect(f.text.length).toBeLessThanOrEqual(FINDING_MAX_CHARS);
    expect(f.text.endsWith("…")).toBe(false);
    for (const line of f.text.split("\n")) expect(line === long.split("\n")[0] || bullets.includes(line), line).toBe(true);
  });
});

describe("runTurn: content findings hold the whole deliverable", () => {
  it("a week of captions and a script (about 3000 characters) is kept whole; a revision keeps it too", async () => {
    const day = (i: number) => `${i}. "Hook line ${i}? A calm sentence about the project, from what the record says [[content:reel-1]]. Another short one."`;
    const week = `Seven captions and the reel script.\n${Array.from({ length: 7 }, (_, i) => day(i + 1)).join("\n")}\n\nScript, 0-3s: hook. 3-10s: the problem. 10-17s: the answer. 17-20s: the name.`;
    const big = `${week}\n${"Film: the place, from the owner's own phone. ".repeat(40)}`.slice(0, 3200);
    expect(big.length).toBeGreaterThan(FINDING_MAX_CHARS);
    const { events, run, runtime } = setup({
      "chief-of-staff:plan": plan([{ agent: "content-strategist", task: "A week of posts and a reel script" }]),
      "content-strategist:work": { calls: [{ name: "content_performance" }], ...finding(big) },
      "content-strategist:revise": finding(`${big}\n(Dev: fixed one hook.)`),
      "copy-editor:review": { structured: { verdict: "fix", note: "Hook 3 is vague." } },
      "fact-checker:review": { structured: { verdict: "ok", note: "ok" } },
      "chief-of-staff:synthesis": { text: "Here it is [[content:reel-1]]." },
    });
    await run();
    const fs = events.filter(is("finding", "content-strategist")) as Array<Extract<AgentEvent, { type: "finding" }>>;
    expect(fs[0]!.text.length).toBeGreaterThan(FINDING_MAX_CHARS);
    expect(fs[0]!.text).toContain("Script, 0-3s");
    expect(fs[1]!.text).toContain("(Dev: fixed one hook.)");
    expect(runtime.runs.find((r) => r.phase === "work" && r.agentId === "content-strategist")!.prompt).toContain(`at most ${CONTENT_FINDING_MAX_CHARS} characters`);
  });
});

describe("runTurn: a reviewer that did not run", () => {
  const scripts = (review: FakeScript): Record<string, FakeScript> => ({
    "chief-of-staff:plan": plan([{ agent: "content-strategist", task: "A caption" }]),
    "content-strategist:work": { calls: [{ name: "content_performance" }], ...finding("A calm caption about Reel 1 [[content:reel-1]].") },
    "copy-editor:review": { structured: { verdict: "ok", note: "Plain." } },
    "fact-checker:review": review,
    "chief-of-staff:synthesis": { text: "Here is the caption [[content:reel-1]]." },
  });

  it("is asked again once; a second try that works counts as a normal review", async () => {
    const { run, runtime } = setup(scripts([{ fail: "Claude Code process terminated by signal SIGSEGV" }, { structured: { verdict: "ok", note: "Checked." } }]));
    const out = await run();
    expect(runtime.runs.filter((r) => r.agentId === "fact-checker" && r.phase === "review")).toHaveLength(2);
    expect(out.reviews.map((r) => r.reviewer).sort()).toEqual(["copy-editor", "fact-checker"]);
    expect(runtime.runs.find((r) => r.phase === "synthesis")!.prompt).not.toContain("could not check");
  });

  it("if it still cannot run, the Chief is told the finding is unreviewed and must say so (the check fails closed, not silent)", async () => {
    const { run, runtime, events } = setup(scripts({ fail: "Claude Code process terminated by signal SIGSEGV" }));
    const out = await run();
    expect(runtime.runs.filter((r) => r.agentId === "fact-checker" && r.phase === "review")).toHaveLength(2);
    const p = runtime.runs.find((r) => r.phase === "synthesis")!.prompt;
    expect(p).toContain("Nisha (Fact Checker) could not check this finding");
    expect(p).toMatch(/say plainly that .* was not fact-checked/);
    expect(events.some(is("agent_done", "fact-checker", (e) => e.ok === false))).toBe(true);
    expect(out.ok).toBe(true);
  });
});

describe("runTurn: findings nobody reviews", () => {
  it("are final at once, so the Chief never drafts for them", async () => {
    const { events, run, runtime } = setup({
      "chief-of-staff:plan": plan([{ agent: "tech-lead", task: "Site" }]),
      "tech-lead": { calls: [{ name: "get_entity", args: { id: "system:sitemap" } }], ...finding("The sitemap is broken [[system:sitemap]].") },
      "chief-of-staff:synthesis": { text: "The sitemap is broken [[system:sitemap]]." },
    });
    await run();
    expect(events.some(is("agent_status", "chief-of-staff", (e) => /Drafting/.test(e.text)))).toBe(false);
    expect(runtime.runs.filter((r) => r.phase === "synthesis")).toHaveLength(1);
  });
});

// From the review's probe-late.mts: a desk times out while its tool calls are still running.
describe("runTurn: nothing from a stopped run lands after it stops", () => {
  it("in-flight tool calls of timed-out desks emit nothing, record nothing, and a write sees its run stopped", async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let proposeSawStop: boolean | undefined;
    const tools: Record<string, AlleviaTool> = {
      metric_trend: { name: "metric_trend", description: "", input: { metric: z.string().optional() }, async run() {
        await sleep(300);
        return result({ data: { v: 41 }, nodes: [node("metric:late", "Metric", "Late")] });
      } },
      show_path: { name: "show_path", description: "", input: { ids: z.array(z.string()) }, async run(a) { return result({ data: {}, nodes: (a.ids as string[]).map((id) => node(id, "E")) }); } },
      propose_action: { name: "propose_action", description: "", writes: true, input: { title: z.string(), kind: z.string() }, async run(_a, ctx) {
        await sleep(250);
        proposeSawStop = ctx.signal?.aborted; // a real write tool checks this before it commits
        return result({ data: { recommendationId: "recommendation:x", approvalId: "approval:x" } });
      } },
    };
    const getTools = (names: string[]) => names.map((n) => tools[n]).filter((t): t is AlleviaTool => !!t);
    const after: string[] = [];
    let returned = false;
    const events: AgentEvent[] = [];
    const out = await runTurn(INPUT, {
      runtime: new FakeRuntime({
        "chief-of-staff:plan": plan([{ agent: "data-analyst", task: "trend" }, { agent: "growth-marketer", task: "ads" }]),
        "data-analyst": { calls: [{ name: "metric_trend", args: {} }], ...finding("x") },
        "growth-marketer": { calls: [{ name: "propose_action", args: { title: "Pause ad", kind: "pause_ad" } }], ...finding("y") },
        "chief-of-staff:synthesis": { text: "An answer that is long enough to count as an answer for the stream sealing rule, yes indeed." },
      }),
      getTools, graph: {} as GraphHandle, now: NOW, agentTimeoutMs: 100,
    }, (e) => { events.push(e); if (returned) after.push(`${e.type}:${(e as { agent?: string }).agent ?? ""}`); });
    returned = true;
    expect(out.failed.sort()).toEqual(["data-analyst", "growth-marketer"]);
    await sleep(450);
    expect(after).toEqual([]);
    expect(proposeSawStop).toBe(true);
    expect(out.proposals).toEqual([]);
    expect(events.some((e) => e.type === "proposal" || (e.type === "tool_result" && e.agent !== "chief-of-staff"))).toBe(false);
    expect(out.touched.has("metric:late")).toBe(false);
  });
});

// ---------- remember: only what the owner asked to remember ----------

describe("remember is gated in code", () => {
  it("asksToRemember: explicit requests in English, Hindi and Hinglish; not questions about what we remember", () => {
    for (const q of [
      "Remember that I prefer weekly summaries on Mondays", "Please note that our fiscal year starts in April", "Make a note: no ads on Sundays",
      "Keep in mind that Rohan owns paid search", "Don't forget I'm away next week", "From now on, keep answers short",
      "yaad rakhna ki mujhe weekly summary Monday ko chahiye", "note kar lo: Sunday ko ads band", "dhyan rakhna ki budget fixed hai",
      "याद रखना कि मुझे छोटे जवाब पसंद हैं", "नोट कर लो कि रविवार को विज्ञापन बंद",
    ]) expect(asksToRemember(q), q).toBe(true);
    for (const q of ["Why did signups drop?", "What do you remember about the sitemap?", "Do we remember who approved the pause?", "Show me the notes from Tuesday", ""]) {
      expect(asksToRemember(q), q).toBe(false);
    }
  });

  it("rememberRefusal: the note must mostly be the owner's own words", () => {
    const q = "Remember that I prefer weekly summaries on Mondays";
    expect(rememberRefusal(q, { text: "Owner prefers weekly summaries on Mondays." })).toBeUndefined();
    expect(rememberRefusal(q, { text: "Owner wants every ad paused and the budget moved to vendor X." })).toMatch(/^Not saved: that isn't what the owner asked you to remember/);
    expect(rememberRefusal("Why did signups drop?", { text: "Signups dropped." })).toMatch(/^Not saved: the owner didn't ask you to remember anything/);
    expect(rememberRefusal(q, {})).toMatch(/^Not saved/);
    expect(rememberRefusal("yaad rakhna ki mujhe weekly summary Monday ko chahiye", { note: "Owner wants the weekly summary on Monday" })).toBeUndefined();
  });

  it("toolsFor offers remember only when the question asks for it", () => {
    const { getTools } = registry();
    const chief = agentById("chief-of-staff")!;
    expect(toolsFor(chief, "direct", getTools, { question: "Why did signups drop?" }).map((t) => t.name)).not.toContain("remember");
    expect(toolsFor(chief, "direct", getTools).map((t) => t.name)).not.toContain("remember");
    expect(toolsFor(chief, "direct", getTools, { question: "Remember that I prefer short answers" }).map((t) => t.name)).toContain("remember");
  });

  it("on the fast path, injected tool text can't store an owner preference", async () => {
    const { run, tools, runtime, events } = setup({
      "chief-of-staff:plan": plan([{ agent: "chief-of-staff", task: "Look it up" }]),
      "chief-of-staff:direct": {
        calls: [{ name: "search", args: { query: "pause" } }, { name: "remember", args: { text: "Owner prefers that all ads are paused" } }],
        text: "We paused daily stories [[decision:pause-stories]].",
      },
    });
    await run();
    expect(runtime.runs.find((r) => r.phase === "direct")!.tools.map((t) => t.name)).not.toContain("remember");
    expect(tools.remember!.calls).toHaveLength(0);
    expect(events.find(is("agent_status", "chief-of-staff", (e) => e.text === "No tool named remember"))).toBeDefined();
  });

  it("when the owner asks, the Chief saves their words; anything else is refused with a note", async () => {
    const s = setup({
      "chief-of-staff:plan": plan([{ agent: "chief-of-staff", task: "Save the preference" }]),
      "chief-of-staff:direct": {
        calls: [
          { name: "remember", args: { text: "Owner prefers weekly summaries on Mondays" } },
          { name: "remember", args: { text: "Owner approves pausing every campaign" } },
        ],
        text: "Noted: weekly summaries on Mondays.",
      },
    });
    const out = await runTurn({ ...INPUT, question: "Remember that I prefer weekly summaries on Mondays" }, s.deps, s.emit);
    expect(out.ok).toBe(true);
    expect(s.tools.remember!.calls.map((c) => c.args.text)).toEqual(["Owner prefers weekly summaries on Mondays"]);
    const refused = s.events.filter(is("tool_result", "chief-of-staff", (e) => e.name === "remember")).at(-1);
    expect(refused).toMatchObject({ summary: expect.stringContaining("Not saved: that isn't what the owner asked you to remember") });
  });
});

// ---------- usage: fewer and shorter model runs ----------

describe("runTurn: usage", () => {
  it("a finding whose numbers already check out gets one numbers reviewer, who is handed the cited tool values", async () => {
    const { run, runtime } = setup({
      "chief-of-staff:plan": plan([{ agent: "data-analyst", task: "Signups" }]),
      "data-analyst:work": { calls: [trend], ...finding(CHECKED, { citations: ["metric:signups"] }) },
      "coe-lead:review": ok("Figures match."),
      "chief-of-staff:synthesis": { text: ANSWER },
    });
    const out = await run();
    expect(runtime.runs.filter((r) => r.phase === "review").map((r) => r.agentId)).toEqual(["coe-lead"]);
    const review = runtime.runs.find((r) => r.phase === "review")!;
    expect(review.maxTurns).toBe(2);
    expect(review.prompt).toContain("The tool data behind the cited ids");
    expect(review.prompt).toContain('- metric_trend (Kabir): {"metric":"signups","points":[{"week":"2026-10-05","value":41},{"week":"2026-09-28","value":55}]}');
    expect(review.prompt).toContain("You have at most 1 round of lookups");
    expect(out.agents).toEqual(["chief-of-staff", "data-analyst", "coe-lead"]);
  });

  it("the Chief doesn't draft while a content finding is under review (its reviewers usually send it back)", async () => {
    const { events, run, runtime } = setup({
      "chief-of-staff:plan": plan([{ agent: "content-strategist", task: "Three reel ideas" }]),
      "content-strategist:work": { calls: [{ name: "content_performance" }], ...finding("Question hooks win [[content:reel-1]].") },
      "copy-editor:review": ok("Fine.", 30),
      "fact-checker:review": ok("Supported.", 30),
      "chief-of-staff:synthesis": { text: "Lead with a question hook [[content:reel-1]]." },
    });
    await run();
    const lastReview = events.findLastIndex(is("review"));
    expect(idx(events, is("agent_start", "chief-of-staff", (e) => e.task === "Writing the answer"))).toBeGreaterThan(lastReview);
    expect(runtime.runs.filter((r) => r.phase === "synthesis")).toHaveLength(1);
  });

  it("a desk that runs out of turns hands over what it wrote, marked partial, instead of failing", async () => {
    const { events, run, runtime } = setup({
      "chief-of-staff:plan": plan([{ agent: "data-analyst", task: "Signups" }, { agent: "growth-marketer", task: "Move", after: ["data-analyst"] }]),
      "data-analyst:work": { calls: [trend], text: "Signups fell from 55 to 41 [[metric:signups]]; spend not checked yet.", partial: true },
      "coe-lead:review": ok("Figures match, but incomplete."),
      "growth-marketer:work": finding("Hold paid search [[metric:signups]]."),
      "chief-of-staff:synthesis": { text: ANSWER },
    });
    const out = await run();
    expect(out.failed).toEqual([]);
    expect(out.findings[0]).toMatchObject({ partial: true, text: "Signups fell from 55 to 41 [[metric:signups]]; spend not checked yet." });
    expect(events.find(is("agent_status", "data-analyst", (e) => /ran out of turns/i.test(e.text)))).toBeDefined();
    expect(events.find(is("handoff"))).toMatchObject({ note: expect.not.stringContaining("draft") }); // partial: not handed on early
    expect(runtime.runs.find((r) => r.agentId === "growth-marketer")!.prompt).toContain("PARTIAL: it ran out of turns");
    expect(runtime.runs.find((r) => r.phase === "synthesis")!.prompt).toContain("PARTIAL: it ran out of turns");
  });

  it("a partial review, revision or plan counts as not finished (never as an 'ok')", async () => {
    const { run, runtime } = setup({
      "chief-of-staff:plan": plan([{ agent: "data-analyst", task: "Signups" }]),
      "data-analyst:work": finding("Signups were 99 [[metric:signups]]."),
      "coe-lead:review": { text: "Still looking", partial: true },
      "fact-checker:review": { structured: { verdict: "fix", note: "99 is not in the data." } },
      "data-analyst:revise": { text: "half a revision", partial: true },
      "chief-of-staff:synthesis": { text: ANSWER },
    });
    const out = await run();
    expect(out.reviews.map((r) => [r.reviewer, r.verdict])).toEqual([["fact-checker", "fix"]]);
    expect(out.findings[0]).toMatchObject({ text: "Signups were 99 [[metric:signups]].", revised: false });
    expect(runtime.runs.filter((r) => r.phase === "revise")).toHaveLength(1);

    const p = setup({ "chief-of-staff:plan": { text: '{"steps":[{"agent":"librarian","task":"x"}]}', partial: true }, "chief-of-staff:direct": { text: "Not recorded." } });
    expect((await p.run()).fastPath).toBe(true);
  });

  it("the planner runs on haiku; the desks on their roster models; a model override still applies to all", async () => {
    const scripts: Record<string, FakeScript> = {
      "chief-of-staff:plan": plan([{ agent: "tech-lead", task: "Site" }]),
      "tech-lead": finding("The sitemap is broken [[system:sitemap]]."),
      "chief-of-staff:synthesis": { text: "Fix the sitemap." },
    };
    const a = setup(scripts);
    await a.run();
    expect(a.runtime.runs.map((r) => [r.phase, r.model])).toEqual([["plan", "haiku"], ["work", "sonnet"], ["synthesis", "sonnet"]]);
    const b = setup(scripts, { model: "sonnet" });
    await b.run();
    expect(b.runtime.runs.every((r) => r.model === "sonnet")).toBe(true);
  });
});

describe("runTurn: a direct chat with one agent", () => {
  const ANSWER = "Reels with a question hook did 2.4 times the average [[content:reel-1]]. Next: reuse that hook on Friday.";
  const target = (over: Partial<TurnInput> = {}) => {
    const s = setup({
      "content-strategist:direct": { calls: [{ name: "content_performance", args: {} }], text: ANSWER },
    });
    return { ...s, run: () => runTurn({ ...INPUT, question: "Which hook works best?", target: "content-strategist", ...over }, s.deps, s.emit) };
  };

  it("skips planning: the named agent answers with its own tools, and no other desk runs", async () => {
    const { run, runtime, events } = target();
    const out = await run();
    expect(out.fastPath).toBe(true);
    expect(out.agents).toEqual(["content-strategist"]);
    expect(runtime.runs.some((r) => r.phase === "plan")).toBe(false);
    expect(runtime.runs.some((r) => r.agentId === "chief-of-staff")).toBe(false);
    const direct = runtime.runs.find((r) => r.phase === "direct")!;
    expect(direct.agentId).toBe("content-strategist");
    // its own roster tools, plus show_path to draw how the answer was reached
    expect(direct.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["content_performance", "show_path"]));
    expect(direct.tools.map((t) => t.name)).not.toContain("metric_trend");
    expect(direct.system).toContain("You are Tara");
    // the streamed answer is attributed to the agent the owner asked, not the Chief
    const text = events.filter((e): e is Extract<AgentEvent, { type: "text" }> => e.type === "text" && !e.reset);
    expect(text.length).toBeGreaterThan(0);
    expect(text.every((e) => e.agent === "content-strategist")).toBe(true);
    expect(events.some((e) => e.type === "plan")).toBe(false);
    expect(out.answer).toContain("question hook");
  });

  it("draws the path itself when the agent didn't, as the Chief does", async () => {
    const { run, tools } = target();
    await run();
    expect(tools.show_path!.calls).toEqual([{ args: { ids: ["content:reel-1"] }, agentId: "content-strategist" }]);
  });

  it("asking the Chief is asking the whole team: it still plans", async () => {
    const s = setup({ "chief-of-staff:plan": plan([{ agent: "chief-of-staff", task: "Answer" }]), "chief-of-staff:direct": { text: "Fine, thanks [[decision:pause-stories]]." } });
    await runTurn({ ...INPUT, target: "chief-of-staff" }, s.deps, s.emit);
    expect(s.runtime.runs.some((r) => r.phase === "plan")).toBe(true);
  });
});
