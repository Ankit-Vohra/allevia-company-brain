// ask() lays a business's own skills over the shipped ones, read from that business's own graph each turn.
import { afterAll, describe, expect, it } from "vitest";
import type { AgentEvent } from "../../shared/contracts.js";
import { ask } from "../../src/agent/ask.js";
import { ensureRoster } from "../../src/agent/memory.js";
import { FakeRuntime } from "../../src/agent/runtime.js";
import { codeCatalog } from "../../src/agent/skills/catalog.js";
import { toolsByName } from "../../src/agent/tools/index.js";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { writeBatch } from "../../src/graph/upsert.js";
import { applyDirective, previewDirective } from "../../src/settings/directives.js";
import { testGraph } from "../helpers/graph.js";
import { NOW } from "../helpers/agent.js";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => { for (const c of cleanups) await c(); await closeAll(); });

async function business(name: string, said?: string): Promise<GraphHandle> {
  const { g, cleanup } = await testGraph();
  cleanups.push(cleanup);
  await ensureIndexes(g);
  await writeBatch(g, { nodes: [{ type: "Business", id: `business:${name}`, name }, { type: "Person", id: "person:founder", name: "Founder" }] }, NOW);
  await ensureRoster(g, { businessId: `business:${name}` }, NOW);
  if (said) {
    const pv = await previewDirective(g, { text: said }, { llm: null, now: NOW });
    await applyDirective(g, pv.id, { now: NOW + 1 });
  }
  return g;
}

const SCRIPTS = {
  "chief-of-staff:plan": { structured: { steps: [{ agent: "content-strategist", task: "Write the festival post" }], rationale: "content" } },
  "content-strategist": { calls: [{ name: "use_skill", args: { id: "festival-post" } }], structured: { text: "A draft.", citations: [] } },
  "chief-of-staff:synthesis": { text: "Here is the post." },
};

async function run(g: GraphHandle, skills: boolean) {
  const runtime = new FakeRuntime(SCRIPTS);
  const events: AgentEvent[] = [];
  await ask(
    { tenant: "test", question: "Write a festival post", channel: "cli" },
    { runtime, getTools: toolsByName, graph: g, now: () => NOW, ...(skills ? { skills: codeCatalog() } : {}) },
    (e) => events.push(e));
  const work = runtime.runs.find((r) => r.agentId === "content-strategist" && r.phase === "work")!;
  return { work, events };
}

const SAID = "Miss Influencer, add a skill called Festival post: open with the greeting in Hindi, then the offer";

describe("ask() and a business's own skills", () => {
  it("the business that added a skill sees it in the prompt and can open it; another business does not", async () => {
    const mine = await business("kestrel-oak", SAID);
    const other = await business("harbour-bakery");
    const a = await run(mine, true);
    expect(a.work.system).toContain("- festival-post: Festival post.");
    expect(a.work.system).toContain("(set up for this business)");
    expect(a.events.find((e) => e.type === "skill_used")).toMatchObject({ skillId: "festival-post", source: "business" });

    const b = await run(other, true);
    expect(b.work.system).not.toContain("festival-post");
    expect(b.work.system).toContain("instagram-post"); // the shipped skills are there
    expect(b.events.some((e) => e.type === "skill_used")).toBe(false); // opening a skill it does not have is an error, not a use
  });

  it("with skills off nothing is listed and the business's own are not read", async () => {
    const mine = await business("kestrel-oak-two", SAID);
    const r = await run(mine, false);
    expect(r.work.system).not.toContain("Your skills");
    expect(r.work.tools.map((t) => t.name)).not.toContain("use_skill");
  });
});
