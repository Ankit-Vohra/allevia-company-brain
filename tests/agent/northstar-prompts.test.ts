// Every agent knows its job and works toward the business's main goal (the north star), brain first. Offline, fake runtime:
//   - each of the thirteen roles has a job (what it owns, what it reads in the brain first, the output standard, how it moves the
//     main goal, when it hands off) in its own prompt;
//   - the main goal and the growth-plan goals reach every prompt of a turn (plan, work, review, synthesis), and may be cited;
//   - the content and marketing roles tie their work to the main goal's call to action and open from what worked;
//   - the house rules say brain first, and a skill opened says it again.
import { describe, it, expect } from "vitest";
import { z } from "zod";
import type { GraphHandle } from "../../src/graph/client.js";
import { runTurn, type TurnDeps, type TurnInput } from "../../src/agent/orchestrator.js";
import { FakeRuntime, type FakeScript } from "../../src/agent/runtime.js";
import type { AlleviaTool } from "../../src/agent/tool.js";
import { HOUSE_RULES, agentSystemPrompt, planSystemPrompt } from "../../src/agent/prompts.js";
import { JOBS, jobBlock } from "../../src/agent/jobs.js";
import { BRAIN_FIRST_CREATIVE, BRAIN_FIRST_READ, isCreativeSkill } from "../../src/agent/skills/render.js";
import { northStarBlock, type NorthStar } from "../../src/northstar/northstar.js";
import { AGENTS, agentById } from "../../shared/roster.js";
import { ALL_TOOLS } from "../../src/agent/tools/index.js";
import { fakeTool, recorder, result, NOW } from "../helpers/agent.js";

const NS: NorthStar = {
  id: "memory:north-star-aamdani", outcome: "more app downloads and sign-ups", outcomeKind: "downloads", audiences: ["Job seekers looking for local work"],
  offer: "Local job feed", cta: { kind: "download", text: "Download the app" }, channel: "Play Store", source: "backfill", asOf: "2026-10-17",
};
const GOALS = [{ id: "goal:weekly-signups", name: "Weekly signups", priority: 1 }];
const BLOCK = northStarBlock(NS, GOALS);

describe("each role's job", () => {
  it("all thirteen roles have one, and it reaches their prompt", () => {
    expect(AGENTS).toHaveLength(13);
    for (const a of AGENTS) {
      const j = JOBS[a.id];
      expect(j, a.id).toBeDefined();
      for (const k of ["owns", "brain", "standard", "moves", "handoff"] as const) expect(j![k].length, `${a.id}.${k}`).toBeGreaterThan(20);
      const p = agentSystemPrompt(a, [], { now: NOW, tenant: "aamdani", northStar: BLOCK });
      expect(p).toContain(jobBlock(a.id));
      expect(p).toContain("Brain first:");
      expect(p).toContain("Outcome: more app downloads and sign-ups");
      expect(p.indexOf("Outcome:")).toBeLessThan(p.indexOf("House rules"));
    }
  });
  it("names only tools each role holds when it says what to read first", () => {
    const names = new Set(ALL_TOOLS.map((t) => t.name));
    for (const a of AGENTS) {
      const said = [...JOBS[a.id]!.brain.matchAll(/\b([a-z]+_[a-z_]+)\b/g)].map((m) => m[1]!).filter((n) => names.has(n));
      for (const n of said) expect(agentById(a.id)!.tools, `${a.id} reads ${n}`).toContain(n);
    }
  });
  it("the content and marketing roles tie every piece to the main goal's call to action", () => {
    for (const id of ["growth-marketer", "content-strategist", "copy-editor", "fact-checker"]) expect(JOBS[id]!.moves).toMatch(/call to action|app link/);
    expect(JOBS["content-strategist"]!.standard).toContain("Made for: <main goal> · CTA: <call to action>");
    expect(JOBS["content-strategist"]!.brain).toMatch(/^what_worked first/);
    expect(JOBS["growth-marketer"]!.moves).toMatch(/app-install campaign for downloads/);
  });
  it("brain first, in the house rules and in every skill opened", () => {
    expect(HOUSE_RULES).toMatch(/Brain first: .* Read them before any outside tool/);
    expect(isCreativeSkill({ tools: ["what_worked"], agents: ["growth-marketer"] })).toBe(true);
    expect(isCreativeSkill({ tools: ["metric_trend"], agents: ["data-analyst"] })).toBe(false);
    expect(BRAIN_FIRST_CREATIVE).toMatch(/call what_worked/);
    expect(BRAIN_FIRST_READ).toMatch(/only to fill a gap/);
  });
  it("with no main goal on record, agents are told to ask once", () => {
    expect(northStarBlock(null, [])).toMatch(/not recorded yet[\s\S]*ask the owner once/);
  });
});

describe("the main goal reaches every prompt of a turn", () => {
  const tools: Record<string, AlleviaTool> = {
    content_performance: fakeTool("content_performance", result({ data: [], nodes: [{ id: "content:salary-reel", label: "Content", name: "Salary in 7 days" }] })),
    show_path: fakeTool("show_path", (a) => result({ data: {}, nodes: (a.ids as string[]).map((id) => ({ id, label: "Entity", name: id })) }), { ids: z.array(z.string()) }),
  };
  const getTools = (names: string[]) => names.map((n) => tools[n]).filter((t): t is AlleviaTool => !!t);
  const INPUT: TurnInput = { tenant: "aamdani", question: "Write a post about the salary feature", sessionId: "session:s1", turnId: "turn:t1", asker: "person:founder", recall: { text: "", ids: [] } };
  const post = "Made for: more app downloads and sign-ups · CTA: Download the app [[memory:north-star-aamdani]]. Salary in 7 days [[content:salary-reel]]. Download the app.";
  const scripts: Record<string, FakeScript> = {
    "chief-of-staff:plan": { structured: { steps: [{ agent: "content-strategist", task: "Draft the post" }], rationale: "content" } },
    "content-strategist": { calls: [{ name: "content_performance", args: {} }], structured: { text: post, citations: ["content:salary-reel", NS.id] } },
    "copy-editor": { structured: { verdict: "ok", note: "On voice." } },
    "fact-checker": { structured: { verdict: "ok", note: "Supported." } },
    "chief-of-staff:synthesis": { calls: [{ name: "show_path", args: { ids: [NS.id, "content:salary-reel"] } }], text: post },
  };

  it("plan, work and review prompts carry it, and its id counts as seen", async () => {
    const runtime = new FakeRuntime(scripts);
    const nodes = [{ id: NS.id, label: "Memory", name: `Main goal: ${NS.outcome}` }, { id: "goal:weekly-signups", label: "Goal", name: "Weekly signups" }];
    const deps: TurnDeps = { runtime, getTools, graph: {} as GraphHandle, now: NOW, northStar: { text: BLOCK, nodes } };
    const rec = recorder();
    const out = await runTurn(INPUT, deps, rec.emit);
    for (const phase of ["plan", "work", "review"]) {
      const runs = runtime.runs.filter((r) => r.phase === phase);
      expect(runs.length, phase).toBeGreaterThan(0);
      for (const r of runs) expect(r.system, `${r.agentId} ${phase}`).toContain("Call to action: Download the app");
    }
    expect(out.touched.has(NS.id)).toBe(true);
    expect(out.touched.has("goal:weekly-signups")).toBe(true);
  });

  it("the planner sees the main goal too", () => {
    expect(planSystemPrompt({ now: NOW, tenant: "aamdani", northStar: BLOCK })).toContain("Outcome: more app downloads and sign-ups");
  });
});
