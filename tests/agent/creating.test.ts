// A free-form request becomes a made thing through the real orchestrator: the Chief (a scripted model, since no keyword
// router exists) calls make_poster with the REAL tool over a real brand kit; the turn streams a `deliverable` and a `proposal`
// event, the outcome carries the deliverable, the Chief's answer is saved with the card waiting, and nothing is posted.
// The creating tools reach only the agents whose roster lists them, and a reviewer can never use them.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CREDIT_COSTS } from "../../shared/plans.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "../../shared/contracts.js";
import { agentById } from "../../shared/roster.js";
import { ask } from "../../src/agent/ask.js";
import { FakeRuntime } from "../../src/agent/runtime.js";
import { toolsFor } from "../../src/agent/orchestrator.js";
import { agentSystemPrompt, CREATING_RULES, planSystemPrompt } from "../../src/agent/prompts.js";
import { toolsByName } from "../../src/agent/tools/index.js";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { FakeVision } from "../../src/studio/vision.js";
import { AssetStore } from "../../src/studio/store.js";
import { testGraph } from "../helpers/graph.js";
import { FakeCreativeEngine, NOW, nishaReads, seedKit, TENANT } from "../creative/helpers.js";

describe("a request becomes a made thing (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  let dir: string;
  let store: AssetStore;

  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    dir = mkdtempSync(join(tmpdir(), "allevia-creating-"));
    store = new AssetStore(dir);
    await seedKit(g, store);
  }, 60_000);
  afterAll(async () => { await cleanup(); await closeAll(); rmSync(dir, { recursive: true, force: true }); });

  it("the Chief makes a poster from a free-form request, and the turn says what was made and that it waits for the owner", async () => {
    const engine = new FakeCreativeEngine();
    const runtime = new FakeRuntime({
      "chief-of-staff:plan": { structured: { steps: [{ agent: "chief-of-staff", task: "Make the poster" }], rationale: "A request to make something" } },
      "chief-of-staff:direct": {
        calls: [{ name: "make_poster", args: { brief: { goal: "offer", promoting: "Design consultation", audience: "homeowners in Bristol", message: "A festival of light for your home", cta: "Visit kestrel.example", offer: "20% off", placement: "insta_post" }, eyebrow: "Diwali sale", scene: ["warm lamps on a wooden table", "a brass diya at dusk"] } }],
        text: "I made two poster options for your Diwali sale: option A (our pick) and B. Fact Checker checked the words and your logo. They're waiting for your OK, and nothing has been posted.",
      },
    });
    const events: AgentEvent[] = [];
    const res = await ask({ tenant: TENANT, question: "got a Diwali sale coming, 20% off, can you do something for Insta with my logo", channel: "web" }, {
      runtime, getTools: toolsByName, graph: g, now: () => NOW + 5000,
      creative: { store, vision: new FakeVision({ "fact-checker": nishaReads() }), engine, maxCreditsPerRequest: 10 },
    }, (e) => events.push(e));
    expect(res.ok).toBe(true);
    // the plan was one step for the Chief: no desk was needed for something to make
    expect((events.find((e) => e.type === "plan") as Extract<AgentEvent, { type: "plan" }>).steps.map((s) => s.agent)).toEqual(["chief-of-staff"]);
    // the tool call and its result are visible work
    expect(events.some((e) => e.type === "tool_call" && e.name === "make_poster")).toBe(true);
    const made = events.find((e) => e.type === "deliverable") as Extract<AgentEvent, { type: "deliverable" }>;
    expect(made).toMatchObject({ agent: "chief-of-staff", kind: "poster", credits: CREDIT_COSTS.static_post });
    expect(made.options).toHaveLength(2);
    expect(made.options.every((o) => o.badge === "ok" && o.thumb.startsWith(`/api/${TENANT}/assets/`))).toBe(true);
    const proposal = events.find((e) => e.type === "proposal") as Extract<AgentEvent, { type: "proposal" }>;
    expect(proposal).toMatchObject({ approvalId: made.approvalId, kind: "content_draft" });
    expect(res.outcome!.deliverables).toHaveLength(1);
    expect(res.outcome!.proposals.map((p) => p.approvalId)).toEqual([made.approvalId]);
    expect(res.answer).toMatch(/waiting for your OK/);
    // the card is pending, nothing was published, and the turn kept the card
    expect(await g.roQuery("MATCH (a:Approval {id:$id, status:'pending'}) RETURN a.id", { id: made.approvalId })).toHaveLength(1);
    expect(await g.roQuery("MATCH (c:Content) WHERE c.createdBy = 'creative' RETURN c.id")).toHaveLength(0);
    expect(engine.generated.length).toBeGreaterThanOrEqual(1); // a scene only for the layouts that need a picture (none of the business's own fits)
  }, 60_000);

  it("only the Chief makes things; a reviewer never holds the tools, and in the middle of a review they are refused", async () => {
    const chief = agentById("chief-of-staff")!;
    const direct = toolsFor(chief, "direct", toolsByName).map((t) => t.name);
    for (const n of ["make_poster", "generate_image", "make_reel_script_and_clip", "write_copy", "get_brand_asset"]) expect(direct).toContain(n);
    // when the Chief writes from findings it gets only show_path and propose_action, as before
    expect(toolsFor(chief, "synthesis", toolsByName, { lean: true }).map((t) => t.name).sort()).toEqual(["propose_action", "show_path"]);
    for (const phase of ["review", "revise", "plan"] as const) expect(toolsFor(chief, phase, toolsByName).map((t) => t.name)).not.toContain("make_poster");
    for (const id of ["copy-editor", "fact-checker", "coe-lead", "data-analyst"]) expect(toolsFor(agentById(id)!, "work", toolsByName).map((t) => t.name)).not.toContain("make_poster");
  });

  it("the prompts tell the Chief to make things from any phrasing, honestly, and the planner to send them to the Chief", () => {
    const sys = agentSystemPrompt(agentById("chief-of-staff")!, toolsFor(agentById("chief-of-staff")!, "direct", toolsByName), { now: NOW, tenant: TENANT });
    expect(sys).toContain(CREATING_RULES);
    expect(CREATING_RULES).toMatch(/however they phrase it/);
    expect(CREATING_RULES).toMatch(/Never describe a picture, a clip or a result you were not given/);
    expect(CREATING_RULES).toMatch(/never invent an offer, price, date/i);
    expect(CREATING_RULES).toMatch(/Nothing is posted anywhere/);
    expect(planSystemPrompt({ now: NOW, tenant: TENANT })).toMatch(/MAKE something now.*goes to "chief-of-staff" alone/);
    // an agent without those tools is not given the rules
    expect(agentSystemPrompt(agentById("coe-lead")!, [], { now: NOW, tenant: TENANT })).not.toContain("Making things");
  });
});
