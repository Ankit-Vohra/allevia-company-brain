// End to end: the owner says "No emojis on LinkedIn; switch Techie off", applies it, then asks for a LinkedIn post. The
// plan skips Techie, Miss Influencer's prompt carries the instruction, and the saved Turn and her Finding are GUIDED_BY it.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { z } from "zod";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { writeBatch } from "../../src/graph/upsert.js";
import { ask } from "../../src/agent/ask.js";
import { ensureRoster } from "../../src/agent/memory.js";
import { FakeRuntime, type FakeScript } from "../../src/agent/runtime.js";
import type { AlleviaTool } from "../../src/agent/tool.js";
import { applyDirective, previewDirective } from "../../src/settings/directives.js";
import { testGraph } from "../helpers/graph.js";
import { fakeTool, recorder, result, NOW } from "../helpers/agent.js";

const tools: Record<string, AlleviaTool> = {
  get_entity: fakeTool("get_entity", result({ data: { summary: "A Victorian terrace opened to the garden." }, nodes: [{ id: "content:harbour-house", label: "Content", name: "Harbour House" }] })),
  show_path: fakeTool("show_path", (a) => result({ data: {}, nodes: (a.ids as string[]).map((id) => ({ id, label: "Entity", name: id })) }), { ids: z.array(z.string()) }),
};
const getTools = (names: string[]) => names.map((n) => tools[n]).filter((t): t is AlleviaTool => !!t);

describe("Tell your team, then ask (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  let memoryId = "";
  const count = async (cypher: string, params?: Record<string, unknown>) => (await g.roQuery<{ c: number }>(cypher, params))[0]!.c;

  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await ensureIndexes(g);
    const s = await writeBatch(g, {
      nodes: [
        { type: "Business", id: "business:kestrel-oak", name: "Kestrel & Oak Studio" },
        { type: "Channel", id: "channel:linkedin", name: "LinkedIn" },
        { type: "Content", id: "content:harbour-house", name: "Harbour House" },
      ],
      edges: [{ from: "channel:linkedin", type: "PART_OF", to: "business:kestrel-oak" }],
    }, NOW);
    expect(s.errors).toEqual([]);
    await ensureRoster(g, { businessId: "business:kestrel-oak" }, NOW);
    const pv = await previewDirective(g, { text: "No emojis on LinkedIn; switch Techie off till the new site launches" }, { llm: null, now: NOW });
    const applied = await applyDirective(g, pv.id, { now: NOW });
    expect(applied.errors).toEqual([]);
    memoryId = pv.diff.find((l) => l.op === "add")!.target;
  });
  afterAll(async () => {
    await cleanup();
    await closeAll();
  });

  it("the plan skips Techie, Miss Influencer works under the instruction, and the Turn and her Finding are GUIDED_BY it", async () => {
    const post = "Harbour House: a Victorian terrace, opened up to the garden [[content:harbour-house]].";
    const scripts: Record<string, FakeScript> = {
      "chief-of-staff:plan": { structured: { rationale: "content, and the site", steps: [
        { agent: "content-strategist", task: "Draft a LinkedIn post about Harbour House" }, { agent: "tech-lead", task: "Check the project page loads" },
      ] } },
      "content-strategist": { calls: [{ name: "get_entity", args: { id: "content:harbour-house" } }], structured: { text: post, citations: ["content:harbour-house"] } },
      "copy-editor": { structured: { verdict: "ok", note: "No emojis; on voice." } },
      "fact-checker": { structured: { verdict: "ok", note: "Supported." } },
      "chief-of-staff:synthesis": { calls: [{ name: "show_path", args: { ids: ["content:harbour-house", memoryId] } }], text: `${post} No emojis, as you asked [[${memoryId}]].` },
    };
    const runtime = new FakeRuntime(scripts);
    const { events, emit } = recorder();
    const r = await ask({ tenant: "test", question: "Draft a LinkedIn post about Harbour House", channel: "cli" },
      { runtime, getTools, graph: g, now: () => NOW + 60_000 }, emit);

    expect(r.ok).toBe(true);
    expect(events.find((e) => e.type === "plan")).toMatchObject({ steps: [{ agent: "content-strategist" }] });
    expect(runtime.runs.some((x) => x.agentId === "tech-lead")).toBe(false);
    expect(runtime.runs.find((x) => x.agentId === "content-strategist")!.system).toContain(`No emojis on LinkedIn. (applies on LinkedIn) [[${memoryId}]]`);
    expect(r.checks.citationsValid).toBe(true);

    expect(await count("MATCH (:Turn {id:$t})-[:GUIDED_BY]->(:Memory {id:$m}) RETURN count(*) AS c", { t: r.turnId, m: memoryId })).toBe(1);
    expect(await count("MATCH (f:Finding)-[:PART_OF]->(:Turn {id:$t}) MATCH (f)-[:GUIDED_BY]->(:Memory {id:$m}) WHERE f.agent = 'content-strategist' RETURN count(*) AS c",
      { t: r.turnId, m: memoryId })).toBe(1);
    // the path from the answer to the owner's own words
    expect(await count("MATCH (:Person {id:'person:founder'})-[:STATED]->(:Memory {id:$m})<-[:GUIDED_BY]-(:Turn {id:$t}) RETURN count(*) AS c", { t: r.turnId, m: memoryId })).toBe(1);
  });
});
