// The turn under the tenant's settings: the capability ladder's modes in the Chief's prompts.
import { describe, it, expect } from "vitest";
import { z } from "zod";
import type { GraphHandle } from "../../src/graph/client.js";
import { runTurn, type TurnDeps, type TurnInput } from "../../src/agent/orchestrator.js";
import { FakeRuntime, type FakeScript } from "../../src/agent/runtime.js";
import type { AlleviaTool } from "../../src/agent/tool.js";
import type { CapabilityModeInfo } from "../../src/capabilities/modes.js";
import { sourcesBlock } from "../../src/agent/prompts.js";
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

function setup(scripts: Record<string, FakeScript>, over: Partial<TurnDeps> = {}) {
  const runtime = new FakeRuntime(scripts);
  const deps: TurnDeps = { runtime, getTools, graph: {} as GraphHandle, now: NOW, ...over };
  const rec = recorder();
  return { runtime, ...rec, run: () => runTurn(INPUT, deps, rec.emit) };
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
