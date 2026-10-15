// The standing last pass in a turn: the Chief's answer is cleaned without a model, Dev (cheapest model) rewrites it once
// only when strong tells are left, the owner's stream is replaced with the cleaned answer, and nothing it cites moves.
import { describe, it, expect } from "vitest";
import { z } from "zod";
import type { GraphHandle } from "../../src/graph/client.js";
import { runTurn, type TurnDeps } from "../../src/agent/orchestrator.js";
import { FakeRuntime, type FakeScript } from "../../src/agent/runtime.js";
import type { AlleviaTool } from "../../src/agent/tool.js";
import { fakeTool, recorder, result, NOW } from "../helpers/agent.js";

const tools: Record<string, AlleviaTool> = {
  get_entity: fakeTool("get_entity", result({ data: { signups: [58, 41] }, nodes: [{ id: "metric:signups", label: "Metric", name: "Sign-ups" }] })),
  show_path: fakeTool("show_path", (a) => result({ data: {}, nodes: (a.ids as string[]).map((id) => ({ id, label: "Entity", name: id })) }), { ids: z.array(z.string()) }),
};
const getTools = (names: string[]) => names.map((n) => tools[n]).filter((t): t is AlleviaTool => !!t);
const INPUT = { tenant: "t", question: "Why did sign-ups fall?", sessionId: "session:s", turnId: "turn:t", asker: "person:founder", recall: { text: "", ids: [] } };
const FAST: FakeScript = { structured: { steps: [{ agent: "chief-of-staff", task: "Look it up" }], rationale: "quick" } };

function run(answer: string, scripts: Record<string, FakeScript> = {}, over: Partial<TurnDeps> = {}) {
  const runtime = new FakeRuntime({
    "chief-of-staff:plan": FAST,
    "chief-of-staff:direct": { calls: [{ name: "get_entity", args: { id: "metric:signups" } }], text: answer },
    ...scripts,
  });
  const rec = recorder();
  const deps: TurnDeps = { runtime, getTools, graph: {} as GraphHandle, now: NOW, ...over };
  return { runtime, rec, out: runTurn(INPUT, deps, rec.emit) };
}

describe("the last pass on the Chief's answer", () => {
  it("strips wrappers and dashes with no model call, and the stream shows the cleaned answer", async () => {
    const s = run("Great question! Sign-ups fell from 58 to 41 [[metric:signups]] — search fell. I hope this helps!");
    const out = await s.out;
    expect(out.answer).toBe("Sign-ups fell from 58 to 41 [[metric:signups]], search fell.");
    expect(s.runtime.runs.some((r) => r.phase === "polish")).toBe(false);
    const last = s.rec.events.filter((e) => e.type === "text").at(-1)!;
    expect(last).toMatchObject({ reset: true, delta: out.answer });
  });

  it("Dev rewrites once on the cheapest model when a strong tell is left; a rewrite that moves a number is refused", async () => {
    const tell = "Sign-ups fell from 58 to 41 [[metric:signups]]. It's not just a blip, it's a signal. Check the services page first.";
    const fixed = "Sign-ups fell from 58 to 41 [[metric:signups]], more than a normal week. Check the services page first.";
    const good = run(tell, { "copy-editor:polish": { structured: { text: fixed } } });
    const o = await good.out;
    const polish = good.runtime.runs.find((r) => r.phase === "polish")!;
    expect(polish).toMatchObject({ agentId: "copy-editor", model: "haiku", tools: [] });
    expect(polish.system).toMatch(/Change wording only/);
    expect(o.answer).toBe(fixed);
    expect(good.rec.events.some((e) => e.type === "agent_start" && e.agent === "copy-editor")).toBe(true);

    const bad = run(tell, { "copy-editor:polish": { structured: { text: "Sign-ups fell from 58 to 14 [[metric:signups]]. Check the services page first." } } });
    expect((await bad.out).answer).toBe(tell);
  });

  it("is off when asked, and leaves a table alone", async () => {
    const off = run("Great question! Sign-ups fell from 58 to 41 [[metric:signups]].", {}, { humanize: false });
    expect((await off.out).answer).toMatch(/^Great question!/);
    const table = "| Week | Sign-ups |\n|---|---|\n| 5 Oct | 58 — high |\n| 12 Oct | 41 [[metric:signups]] |";
    expect((await run(table).out).answer).toBe(table);
  });
});
