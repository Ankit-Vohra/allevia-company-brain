// Latency harness: the agent company's orchestration under a simulated per-call latency model, so changes to the flow
// (review overlap, desk and reviewer caps, turn budgets, the Chief drafting while the last reviews finish) are measured
// without live LLM calls. Timers are faked, so the numbers are exact and the run takes milliseconds.
//
// Model, in simulated seconds:
// - every agent run pays SPAWN: Agent SDK process start + initialize handshake, measured at 0.28-0.54 s on the dev Mac;
// - every model round trip costs TURN = 4 s (haiku with tool results). This calibrates the live-like scenario under the
//   old flow to 114.8 s, close to the 116 s live run with 6 haiku agents;
// - a run makes min(wanted, its job's tool-round budget) tool rounds (toolRounds: the budget its prompt states and its
//   maxTurns allows), only with tools it was given, then one final turn;
// - the Chief streams the answer in the turn after its lookups and calls show_path in that same turn; the round trip
//   after show_path is one more TURN (show_path's fake sleeps it), so "first token" and "done" differ by one TURN.
// The scenarios script what each desk wants to do; the orchestrator decides what actually runs and when.
// ALLEVIA_BENCH_BASELINE=1 reports without asserting (for measuring an older flow); ALLEVIA_BENCH_NOCAPS=1 and
// ALLEVIA_BENCH_NODRAFT=1 add a row per scenario with the turn caps ignored / without the Chief drafting during reviews.
import { describe, it, expect, vi, afterEach } from "vitest";
import { z } from "zod";
import type { AgentEvent } from "../../shared/contracts.js";
import type { GraphHandle } from "../../src/graph/client.js";
import { runTurn, toolRounds, type TurnDeps, type TurnInput } from "../../src/agent/orchestrator.js";
import { FakeRuntime, type FakeScript, type FakeStep, type RunInput } from "../../src/agent/runtime.js";
import type { AlleviaTool } from "../../src/agent/tool.js";
import { fakeTool, result, NOW } from "../helpers/agent.js";

const SCALE_MS = 1_000;  // fake-timer ms per simulated second
const SPAWN = 0.4;       // s
const TURN = 4;          // s
const sleep = (s: number) => new Promise<void>((r) => setTimeout(r, Math.round(s * SCALE_MS)));
const node = (id: string, label: string, name = id) => ({ id, label, name });

const LOOKUPS = new Set(["search", "recall", "get_entity", "neighbors", "find_paths", "cypher"]);

interface Stats { turns: number; capped: number }

function registry(): (names: string[]) => AlleviaTool[] {
  const plain = (name: string, ids: string[] = []) => fakeTool(name, result({ data: { ok: true }, nodes: ids.map((id) => node(id, "Entity")) }));
  const tools: Record<string, AlleviaTool> = {
    search: plain("search", ["decision:pause-stories"]), recall: plain("recall"), get_entity: plain("get_entity", ["system:sitemap"]),
    neighbors: plain("neighbors"), find_paths: plain("find_paths"), cypher: plain("cypher"), important: plain("important"), topics: plain("topics"),
    metric_trend: fakeTool("metric_trend", result({
      data: { metric: "signups", points: [{ week: "2026-09-28", value: 55 }, { week: "2026-10-05", value: 41 }] },
      nodes: [node("metric:signups", "Metric", "Signups")],
    })),
    seo_report: plain("seo_report", ["page:jobs"]), content_performance: plain("content_performance", ["content:reel-1"]),
    playbook: plain("playbook", ["rule:no-jargon"]), ad_report: plain("ad_report", ["campaign:search"]),
    trace_decision: plain("trace_decision", ["decision:pause-stories"]), who_knows: plain("who_knows"), history: plain("history"),
    impact_of: plain("impact_of", ["system:sitemap"]), who_owns: plain("who_owns"), remember: plain("remember"),
    propose_action: plain("propose_action"),
    show_path: fakeTool("show_path", async (a) => {
      await sleep(TURN); // the round trip after the Chief's answer + show_path turn
      return result({ data: {}, nodes: (a.ids as string[]).map((id) => node(id, "Entity")) });
    }, { ids: z.array(z.string()) }),
  };
  return (names) => names.map((n) => tools[n]).filter((t): t is AlleviaTool => !!t);
}

const roundsFor = (input: RunInput, want: number, s: Stats, honourCaps: boolean): number => {
  if (!input.tools.length) return 0;
  const cap = toolRounds(input.phase!);
  const r = honourCaps ? Math.min(want, cap) : want;
  if (r < want) s.capped++;
  return r;
};

// A desk run: `want` tool rounds, then its structured answer.
const desk = (s: Stats, caps: boolean, want: number, out: Partial<FakeStep>) => (input: RunInput): FakeStep => {
  const r = roundsFor(input, want, s, caps);
  s.turns += r + 1;
  return { delayMs: (SPAWN + (r + 1) * TURN) * SCALE_MS, ...out };
};

// The Chief writing the answer: lookups (only if it has lookup tools), then the answer + show_path, then one more turn.
const chiefAnswer = (s: Stats, caps: boolean, wantLookups: number, answer: string, ids: string[]) => (input: RunInput): FakeStep => {
  const lookups = input.tools.some((t) => LOOKUPS.has(t.name)) ? roundsFor(input, wantLookups, s, caps) : 0;
  s.turns += lookups + 2;
  return { delayMs: (SPAWN + (lookups + 1) * TURN) * SCALE_MS, preText: answer, calls: [{ name: "show_path", args: { ids } }] };
};

const plan = (s: Stats, steps: unknown[]) => (): FakeStep => {
  s.turns += 1;
  return { delayMs: (SPAWN + TURN) * SCALE_MS, structured: { steps, rationale: "scenario" } };
};

const finding = (text: string, citations: string[]) => ({ structured: { text, citations } });
const verdict = (v: "ok" | "fix", note: string) => ({ structured: { verdict: v, note } });

const ANSWER = "Signups fell from 55 to 41 in the week to 2026-10-05 [[metric:signups]] after we paused daily stories [[decision:pause-stories]]. Next: fix the sitemap.";

type Scenario = { name: string; question: string; scripts: (s: Stats, caps: boolean) => Record<string, FakeScript> };

const SCENARIOS: Scenario[] = [
  {
    name: "why (live-like: 3 desks, a dependency, numbers reviewed)",
    question: "Which channel brought the most employer signups last week?",
    scripts: (s, c) => ({
      "chief-of-staff:plan": plan(s, [
        { agent: "data-analyst", task: "Find why signups dropped" },
        { agent: "librarian", task: "Trace the decisions around signups" },
        { agent: "growth-marketer", task: "Suggest a channel move", after: ["data-analyst"] },
      ]),
      "data-analyst:work": desk(s, c, 6, { calls: [{ name: "metric_trend", args: { metric: "signups" } }], ...finding("Signups fell from 55 to 41 in the week to 2026-10-05 [[metric:signups]].", ["metric:signups"]) }),
      "data-analyst:revise": desk(s, c, 2, finding("Signups fell from 55 (week to 2026-09-28) to 41 (week to 2026-10-05) [[metric:signups]].", ["metric:signups"])),
      "librarian:work": desk(s, c, 4, { calls: [{ name: "trace_decision" }], ...finding("We paused daily stories on 2026-10-10 [[decision:pause-stories]].", ["decision:pause-stories"]) }),
      "growth-marketer:work": desk(s, c, 5, { calls: [{ name: "metric_trend", args: { metric: "signups" } }], ...finding("Hold paid search while signups sit at 41 [[metric:signups]].", ["metric:signups"]) }),
      "coe-lead:review": (input: RunInput) => desk(s, c, 3, input.prompt.includes("-data-analyst]") ? verdict("fix", "Name the comparison week.") : verdict("ok", "Figures match."))(input),
      "fact-checker:review": desk(s, c, 3, verdict("ok", "Supported.")),
      "chief-of-staff:synthesis": chiefAnswer(s, c, 1, ANSWER, ["decision:pause-stories", "metric:signups"]),
    }),
  },
  {
    name: "content (1 desk, 2 reviewers, a revision)",
    question: "Give me three reel ideas for employers",
    scripts: (s, c) => ({
      "chief-of-staff:plan": plan(s, [{ agent: "content-strategist", task: "Three reel ideas for employers" }]),
      "content-strategist:work": desk(s, c, 5, { calls: [{ name: "content_performance" }, { name: "playbook" }], ...finding("Question hooks win [[content:reel-1]].", ["content:reel-1"]) }),
      "content-strategist:revise": desk(s, c, 2, finding("Lead with a question hook [[content:reel-1]].", ["content:reel-1"])),
      "copy-editor:review": desk(s, c, 3, verdict("fix", "Drop 'delve'.")),
      "fact-checker:review": desk(s, c, 3, verdict("ok", "Supported.")),
      "chief-of-staff:synthesis": chiefAnswer(s, c, 1, "Lead with a question hook [[content:reel-1]]. Next: script the first reel.", ["content:reel-1"]),
    }),
  },
  {
    name: "over-planned (Chief asks for 5 desks on an ordinary question)",
    question: "Which channel brought the most employer signups last week?",
    scripts: (s, c) => ({
      "chief-of-staff:plan": plan(s, [
        { agent: "data-analyst", task: "Find why signups dropped" },
        { agent: "tech-lead", task: "Check site health" },
        { agent: "growth-marketer", task: "Suggest a channel move", after: ["data-analyst"] },
        { agent: "coe-lead", task: "Put the drop in context", after: ["data-analyst", "growth-marketer"] },
        { agent: "ops-manager", task: "List open follow-ups" },
      ]),
      "data-analyst:work": desk(s, c, 6, { calls: [{ name: "metric_trend", args: { metric: "signups" } }], ...finding("Signups fell from 55 to 41 in the week to 2026-10-05 [[metric:signups]].", ["metric:signups"]) }),
      "tech-lead:work": desk(s, c, 4, { calls: [{ name: "impact_of" }], ...finding("The sitemap is broken [[system:sitemap]].", ["system:sitemap"]) }),
      "growth-marketer:work": desk(s, c, 5, { calls: [{ name: "metric_trend", args: { metric: "signups" } }], ...finding("Hold paid search while signups sit at 41 [[metric:signups]].", ["metric:signups"]) }),
      "coe-lead:work": desk(s, c, 5, { calls: [{ name: "metric_trend", args: { metric: "signups" } }], ...finding("41 is the lowest week since 2026-09-28 [[metric:signups]].", ["metric:signups"]) }),
      "ops-manager:work": desk(s, c, 3, { calls: [{ name: "who_owns" }], ...finding("Nothing pending on signups.", []) }),
      "coe-lead:review": desk(s, c, 3, verdict("ok", "Figures match.")),
      "fact-checker:review": desk(s, c, 3, verdict("ok", "Supported.")),
      "chief-of-staff:synthesis": chiefAnswer(s, c, 1, ANSWER, ["decision:pause-stories", "metric:signups"]),
    }),
  },
  {
    name: "fast path (the Chief answers alone)",
    question: "When did we pause daily stories?",
    scripts: (s, c) => ({
      "chief-of-staff:plan": plan(s, [{ agent: "chief-of-staff", task: "Look up the decision" }]),
      "chief-of-staff:direct": chiefAnswer(s, c, 3, "We paused daily stories on 2026-10-10 [[decision:pause-stories]].", ["decision:pause-stories"]),
    }),
  },
];

interface Measured { wall: number; firstToken: number; runs: number; redone: number; turns: number; capped: number; agents: number }

async function measure(sc: Scenario, opts: { honourCaps?: boolean; draft?: boolean } = {}): Promise<Measured> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  const stats: Stats = { turns: 0, capped: 0 };
  const runtime = new FakeRuntime(sc.scripts(stats, opts.honourCaps ?? true));
  const deps: TurnDeps = { runtime, getTools: registry(), graph: {} as GraphHandle, now: NOW, ...(opts.draft === false ? { draftWhileReviewing: false } : {}) };
  const input: TurnInput = { tenant: "bench", question: sc.question, sessionId: "session:b", turnId: "turn:b", asker: "person:founder", recall: { text: "", ids: [] } };
  const t0 = performance.now();
  let first = 0;
  let answering = false;
  const emit = (e: AgentEvent) => {
    if (e.type === "agent_start" && e.agent === "chief-of-staff" && e.task !== "Planning who does what") answering = true;
    if (e.type === "text" && answering && !first) first = performance.now();
  };
  let done = false;
  const turn = runTurn(input, deps, emit).finally(() => { done = true; });
  while (!done) await vi.advanceTimersToNextTimerAsync();
  const out = await turn;
  const sim = (ms: number) => Math.round((ms / SCALE_MS) * 10) / 10;
  return {
    wall: sim(performance.now() - t0), firstToken: sim(first - t0), runs: runtime.runs.length, redone: Math.max(0, runtime.runs.filter((r) => r.phase === "synthesis" || r.phase === "direct").length - 1),
    turns: stats.turns, capped: stats.capped, agents: out.agents.length,
  };
}

const row = (name: string, m: Measured) =>
  `${name.padEnd(64)} wall ${String(m.wall).padStart(6)} s  first token ${String(m.firstToken).padStart(6)} s  runs ${String(m.runs).padStart(2)}` +
  ` (${m.redone} answer redone)  turns ${String(m.turns).padStart(3)}  agents ${m.agents}  capped ${m.capped}`;

describe("latency harness (simulated per-call latency)", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("measures every scenario", async () => {
    const lines: string[] = [];
    const results: Record<string, Measured> = {};
    for (const sc of SCENARIOS) {
      const m = await measure(sc);
      results[sc.name] = m;
      lines.push(row(sc.name, m));
      if (process.env.ALLEVIA_BENCH_NOCAPS) lines.push(row("  (turn caps ignored)", await measure(sc, { honourCaps: false })));
      if (process.env.ALLEVIA_BENCH_NODRAFT) lines.push(row("  (no drafting during reviews)", await measure(sc, { draft: false })));
    }
    console.log(`\n${lines.join("\n")}\n`);
    for (const m of Object.values(results)) expect(m.wall).toBeGreaterThan(0);
    if (process.env.ALLEVIA_BENCH_BASELINE) return; // measuring an older flow: report only
    const [why, content, over, fast] = SCENARIOS.map((sc) => results[sc.name]!);
    expect(why!.wall).toBeLessThan(65);        // old flow: 114.8 s
    expect(why!.firstToken).toBeLessThan(65);  // old flow: 110.8 s
    expect(why!.turns).toBeLessThanOrEqual(27); // old flow: 41 model turns (usage)
    expect(content!.wall).toBeLessThan(60);    // old flow: 70 s
    expect(content!.redone).toBe(0);           // no draft for a content finding, so none is thrown away
    expect(over!.agents).toBeLessThanOrEqual(5);
    expect(over!.wall).toBeLessThan(65);       // old flow: 126.8 s with 7 agents
    expect(fast!.wall).toBeLessThan(26);       // unchanged: 24.8 s
  });
});
