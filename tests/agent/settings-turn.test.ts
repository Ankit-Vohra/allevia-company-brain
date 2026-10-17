// The turn under the tenant's settings: the capability ladder's modes in the Chief's prompts; desks switched off; the
// owner's standing instructions in the prompts and GUIDED_BY.
import { describe, it, expect } from "vitest";
import { z } from "zod";
import type { GraphHandle } from "../../src/graph/client.js";
import { namesChannel, normalisePlan, reviewersFor, runTurn, type TurnDeps, type TurnInput } from "../../src/agent/orchestrator.js";
import { FakeRuntime, type FakeScript } from "../../src/agent/runtime.js";
import type { AlleviaTool } from "../../src/agent/tool.js";
import type { TeamSettings } from "../../src/agent/types.js";
import type { CapabilityModeInfo } from "../../src/capabilities/modes.js";
import { planSchema, planSystemPrompt, sourcesBlock } from "../../src/agent/prompts.js";
import { AGENTS } from "../../shared/roster.js";
import { fakeTool, recorder, result, NOW } from "../helpers/agent.js";

const tools: Record<string, AlleviaTool> = {
  get_entity: fakeTool("get_entity", result({ data: { handle: "kestrel.example", followers: 2300 }, nodes: [{ id: "channel:instagram", label: "Channel", name: "Instagram" }] })),
  search: fakeTool("search", result({ data: [], nodes: [{ id: "channel:instagram", label: "Channel", name: "Instagram" }] })),
  content_performance: fakeTool("content_performance", result({ data: [], nodes: [{ id: "content:harbour-house", label: "Content", name: "Harbour House" }] })),
  playbook: fakeTool("playbook", result({ data: [], nodes: [] })),
  show_path: fakeTool("show_path", (a) => result({ data: {}, nodes: (a.ids as string[]).map((id) => ({ id, label: "Entity", name: id })) }), { ids: z.array(z.string()) }),
};
const getTools = (names: string[]) => names.map((n) => tools[n]).filter((t): t is AlleviaTool => !!t);

const INPUT: TurnInput = {
  tenant: "kestrel", question: "How is our Instagram doing?", sessionId: "session:s1", turnId: "turn:t1", asker: "person:founder", recall: { text: "", ids: [] },
};
const CAPS: CapabilityModeInfo[] = [
  { key: "instagram_insights", name: "Instagram insights", accessMode: "public" },
  { key: "ga4", name: "Website analytics (GA4)", accessMode: "api" },
  { key: "ads", name: "Ads", accessMode: "benchmark" },
];

function setup(scripts: Record<string, FakeScript>, over: Partial<TurnDeps> = {}, input: Partial<TurnInput> = {}) {
  const runtime = new FakeRuntime(scripts);
  const deps: TurnDeps = { runtime, getTools, graph: {} as GraphHandle, now: NOW, ...over };
  const rec = recorder();
  return { runtime, ...rec, run: () => runTurn({ ...INPUT, ...input }, deps, rec.emit) };
}

describe("the Chief is told where non-live data comes from (capability ladder)", () => {
  it("sourcesBlock lists only modes that are not live", () => {
    expect(sourcesBlock(CAPS, "Where:")).toBe("Where:\n- Instagram insights: from your public profile or website\n- Ads: benchmark (industry norms, not your own numbers)");
    expect(sourcesBlock([CAPS[1]!], "Where:")).toBe("");
  });

  it("synthesis names the mode of each capability the desks' data drew on, and only those", async () => {
    const s = setup({
      "chief-of-staff:plan": { structured: { steps: [{ agent: "content-strategist", task: "Review the Instagram profile" }], rationale: "content" } },
      "content-strategist": { calls: [{ name: "get_entity", args: { id: "channel:instagram" } }], structured: { text: "The profile is active [[channel:instagram]].", citations: ["channel:instagram"] } },
      "copy-editor": { structured: { verdict: "ok", note: "fine" } },
      "fact-checker": { structured: { verdict: "ok", note: "fine" } },
      "chief-of-staff:synthesis": { calls: [{ name: "show_path", args: { ids: ["channel:instagram"] } }], text: "From your public profile, the account is active [[channel:instagram]]." },
    }, { capabilities: CAPS });
    await s.run();
    const synth = s.runtime.runs.find((r) => r.agentId === "chief-of-staff" && r.phase === "synthesis")!;
    expect(synth.prompt).toContain("Where this data comes from (it is not live");
    expect(synth.prompt).toContain("- Instagram insights: from your public profile or website");
    expect(synth.prompt).not.toContain("Ads: benchmark");
    expect(synth.prompt).toContain('"simulated", "as of <date>" and data-source rules apply');
  });

  it("on the fast path the Chief gets every capability that isn't live; with no ladder, no block", async () => {
    const fast: Record<string, FakeScript> = {
      "chief-of-staff:plan": { structured: { steps: [{ agent: "chief-of-staff", task: "Look it up" }], rationale: "quick" } },
      "chief-of-staff:direct": { text: "Nothing recorded yet." },
    };
    const s = setup(fast, { capabilities: CAPS });
    await s.run();
    const direct = s.runtime.runs.find((r) => r.phase === "direct")!;
    expect(direct.prompt).toContain("Sources that are not live");
    expect(direct.prompt).toContain("- Ads: benchmark");
    expect(direct.prompt).not.toContain("GA4");
    const bare = setup(fast);
    await bare.run();
    expect(bare.runtime.runs.find((r) => r.phase === "direct")!.prompt).not.toContain("Sources that are not live");
  });
});

// ---------- "Tell your team": desks off, light desks, standing instructions ----------

const NO_EMOJIS = { id: "memory:directive-2026-10-15-0a1b2c3d-1", text: "No emojis on LinkedIn.", agents: ["content-strategist", "copy-editor"], channel: { id: "channel:linkedin", name: "LinkedIn" } };
const FREE_CONSULT = { id: "memory:directive-2026-10-15-0a1b2c3d-2", text: "Always mention free consultation.", agents: ["content-strategist", "copy-editor", "growth-marketer"] };
const ARJUN_OFF: TeamSettings = { disabled: ["tech-lead"], instructions: [] };

describe("a desk switched off is never planned and never reviews", () => {
  it("the plan schema and the planner's desk list hold only the desks that are on", () => {
    const enabled = AGENTS.map((a) => a.id).filter((id) => id !== "tech-lead");
    expect(planSchema(enabled).properties.steps.items.properties.agent.enum).toEqual(enabled);
    const p = planSystemPrompt({ now: NOW, tenant: "t", disabled: ["tech-lead", "chief-of-staff"] });
    expect(p).not.toMatch(/- tech-lead:/);
    expect(p).toContain('Switched off by the owner (never plan them; if the question needs one, plan only "chief-of-staff" and say that desk is off): Techie (Tech Lead).');
    expect(planSystemPrompt({ now: NOW, tenant: "t" })).not.toContain("Switched off");
  });

  it("normalisePlan drops a switched-off desk even if the model names it; the Chief can't be switched off", () => {
    const raw = { rationale: "r", steps: [{ agent: "tech-lead", task: "check the site" }, { agent: "data-analyst", task: "after the Tech Lead, check traffic" }] };
    expect(normalisePlan(raw, "q", { disabled: ["tech-lead"] }).steps).toEqual([{ agent: "data-analyst", task: "after the Tech Lead, check traffic" }]);
    expect(normalisePlan({ steps: [{ agent: "tech-lead", task: "x" }] }, "Is the site up?", { disabled: ["tech-lead"] }).steps).toEqual([{ agent: "chief-of-staff", task: "Is the site up?" }]);
    expect(normalisePlan({ steps: [{ agent: "chief-of-staff", task: "x" }] }, "q", { disabled: ["chief-of-staff"] }).steps[0]!.agent).toBe("chief-of-staff");
  });

  it("'switch Techie off': the turn never plans or runs tech-lead", async () => {
    const s = setup({
      "chief-of-staff:plan": { structured: { steps: [{ agent: "tech-lead", task: "Check the contact form" }, { agent: "content-strategist", task: "Draft a post" }], rationale: "both" } },
      "content-strategist": { structured: { text: "A draft post.", citations: [] } },
      "copy-editor": { structured: { verdict: "ok", note: "fine" } },
      "fact-checker": { structured: { verdict: "ok", note: "fine" } },
      "chief-of-staff:synthesis": { text: "Here is a draft post, and the tech desk is off for now." },
    }, { team: ARJUN_OFF });
    const out = await s.run();
    const plan = s.runtime.runs.find((r) => r.phase === "plan")!;
    expect((plan.outputSchema as ReturnType<typeof planSchema>).properties.steps.items.properties.agent.enum).not.toContain("tech-lead");
    expect(plan.system).toContain("Switched off by the owner");
    expect(out.plan.steps.map((x) => x.agent)).toEqual(["content-strategist"]);
    expect(s.runtime.runs.some((r) => r.agentId === "tech-lead")).toBe(false);
    expect(out.agents).not.toContain("tech-lead");
  });

  it("a switched-off reviewer is skipped", () => {
    expect(reviewersFor("data-analyst", "55 signups", {}).map((r) => r.id)).toEqual(["coe-lead", "fact-checker"]);
    expect(reviewersFor("data-analyst", "55 signups", { disabled: new Set(["coe-lead"]) }).map((r) => r.id)).toEqual(["fact-checker"]);
    expect(reviewersFor("content-strategist", "a post", { disabled: new Set(["copy-editor", "fact-checker"]) })).toEqual([]);
  });

  it("a light desk runs on the cheapest model", async () => {
    const s = setup({
      "chief-of-staff:plan": { structured: { steps: [{ agent: "librarian", task: "Trace it" }], rationale: "history" } },
      "librarian": { structured: { text: "Decided in March.", citations: [] } },
      "chief-of-staff:synthesis": { text: "It was decided in March." },
    }, { team: { disabled: [], light: ["librarian"], instructions: [] } });
    await s.run();
    expect(s.runtime.runs.find((r) => r.agentId === "librarian")!.model).toBe("haiku");
    expect(s.runtime.runs.find((r) => r.phase === "synthesis")!.model).toBe("sonnet");
  });
});

describe("the owner's standing instructions reach the right prompts and become GUIDED_BY", () => {
  const scripts = (post: string): Record<string, FakeScript> => ({
    "chief-of-staff:plan": { structured: { steps: [{ agent: "content-strategist", task: "Draft the post about Harbour House" }], rationale: "content" } },
    "content-strategist": { calls: [{ name: "content_performance", args: {} }], structured: { text: post, citations: ["content:harbour-house"] } },
    "copy-editor": { structured: { verdict: "ok", note: "On voice." } },
    "fact-checker": { structured: { verdict: "ok", note: "Supported." } },
    "chief-of-staff:synthesis": { calls: [{ name: "show_path", args: { ids: ["content:harbour-house", NO_EMOJIS.id] } }], text: `${post} No emojis, as you asked [[${NO_EMOJIS.id}]].` },
  });
  const team: TeamSettings = { disabled: [], instructions: [NO_EMOJIS, FREE_CONSULT] };

  it("'no emojis on LinkedIn' lands in Miss Influencer's and Wordsmith's prompts, not Fact Checker's; the turn and Miss Influencer's finding are guided by it", async () => {
    const s = setup(scripts("Harbour House: a Victorian terrace opened to the garden [[content:harbour-house]]."), { team }, { question: "Draft a LinkedIn post about Harbour House" });
    const out = await s.run();
    const tara = s.runtime.runs.find((r) => r.agentId === "content-strategist" && r.phase === "work")!;
    expect(tara.system).toContain("Standing instructions from the owner, for you.");
    expect(tara.system).toContain(`- No emojis on LinkedIn. (applies on LinkedIn) [[${NO_EMOJIS.id}]]`);
    expect(tara.system).toContain(`- Always mention free consultation. [[${FREE_CONSULT.id}]]`);
    expect(tara.system.indexOf("Standing instructions")).toBeGreaterThan(tara.system.indexOf("House rules"));
    const dev = s.runtime.runs.find((r) => r.agentId === "copy-editor" && r.phase === "review")!;
    expect(dev.system).toContain("No emojis on LinkedIn.");
    const nisha = s.runtime.runs.find((r) => r.agentId === "fact-checker")!;
    expect(nisha.system).not.toContain("Standing instructions");
    const synth = s.runtime.runs.find((r) => r.phase === "synthesis")!;
    expect(synth.prompt).toContain("The owner's standing instructions the desks worked under");
    expect(synth.prompt).toContain(`- No emojis on LinkedIn. (on LinkedIn) [[${NO_EMOJIS.id}]]`);

    expect([...out.guidedBy].sort()).toEqual([NO_EMOJIS.id, FREE_CONSULT.id].sort());
    expect([...out.findings[0]!.guidedBy!].sort()).toEqual([NO_EMOJIS.id, FREE_CONSULT.id].sort());
    expect(out.touched.has(NO_EMOJIS.id)).toBe(true); // what a prompt showed may be cited (and pathed)
  });

  it("a LinkedIn-only instruction doesn't guide an Instagram turn (it is still in the prompt, in case it matters)", async () => {
    const s = setup(scripts("An Instagram reel about Harbour House [[content:harbour-house]]."), { team }, { question: "Draft an Instagram reel about Harbour House" });
    const out = await s.run();
    expect(s.runtime.runs.find((r) => r.agentId === "content-strategist")!.system).toContain("No emojis on LinkedIn.");
    expect(out.guidedBy).toEqual([FREE_CONSULT.id]);
  });

  it("no team settings: prompts and outcome as before", async () => {
    const s = setup(scripts("A post [[content:harbour-house]]."), {}, { question: "Draft a LinkedIn post" });
    const out = await s.run();
    expect(s.runtime.runs.every((r) => !r.system.includes("Standing instructions"))).toBe(true);
    expect(out.guidedBy).toEqual([]);
    expect(out.findings[0]!.guidedBy).toBeUndefined();
  });

  it("namesChannel matches a channel's name or key as a word", () => {
    const ch = { id: "channel:linkedin", name: "LinkedIn" };
    expect(namesChannel("a linkedin post", ch)).toBe(true);
    expect(namesChannel("post on LinkedIn.", ch)).toBe(true);
    expect(namesChannel("linkedinfluencer", ch)).toBe(false);
    expect(namesChannel("an Instagram reel", ch)).toBe(false);
    expect(namesChannel("our Google Business Profile", { id: "channel:google-business", name: "Google Business Profile" })).toBe(true);
  });
});
