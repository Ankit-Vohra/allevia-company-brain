// The wiring every surface uses (src/agent/wiring.ts), end to end over seedMini: the real graph tools, search-backed
// recall seeds and the tenant graph, with the FakeRuntime standing in for Claude. Also: the default runtime only runs on
// the subscription, a missing embedder falls back to text search, and stopping a turn reaches the write tools.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AgentEvent } from "../../shared/contracts.js";
import type { GraphHandle } from "../../src/graph/client.js";
import { ask, STOPPED_MESSAGE, type AskDeps } from "../../src/agent/ask.js";
import { getSession, getTurnEvents, compactEvents } from "../../src/agent/memory.js";
import { FakeRuntime, type FakeScript, type RunInput, type SdkModule } from "../../src/agent/runtime.js";
import { NotOnSubscriptionError } from "../../src/agent/sdk-env.js";
import type { AlleviaTool } from "../../src/agent/tool.js";
import { toolsByName } from "../../src/agent/tools/index.js";
import { SEED_LIMIT, createAskDeps, embedModelReady } from "../../src/agent/wiring.js";
import { entityId } from "../../src/util/ids.js";
import { fakeEmbed, SEED_NOW } from "../fixtures/seed-graph.js";
import { recorder, stubCtx } from "../helpers/agent.js";
import { seededGraph } from "../helpers/tools.js";

const QUESTION = "What breaks if the Instagram token expires, who owns fixing it, and how many reel views are at stake?";

const ANSWER = [
  "If the Instagram token expires, the Instagram connector [[system:ig-connector]] stops, and with it the reel publisher",
  "[[system:reel-publisher]], the reels scheduler [[system:reel-scheduler]] and the Instagram channel [[channel:instagram]];",
  "scheduling two reels a week [[task:schedule-reels]] is blocked. Priya [[person:priya]] owns the fix",
  "[[task:fix-ig-token]] since 5 Oct. The best reel had 48,000 views [[content:reel-salary-reveal]] against a median of 6,000.",
  "Status as of 12 Oct 2026.",
].join(" ");

const scripts: Record<string, FakeScript> = {
  "chief-of-staff:plan": { structured: {
    rationale: "Systems, ownership and the numbers at stake",
    steps: [
      { agent: "tech-lead", task: "What depends on the Instagram connector" },
      { agent: "ops-manager", task: "Who owns fixing the token refresh" },
      { agent: "data-analyst", task: "Reel views at stake on Instagram" },
    ],
  } },
  "tech-lead:work": {
    calls: [{ name: "impact_of", args: { id: "system:ig-connector" } }],
    structured: { text: "The reel publisher [[system:reel-publisher]] and the Instagram channel [[channel:instagram]] depend on the connector [[system:ig-connector]].",
      citations: ["system:reel-publisher", "channel:instagram", "system:ig-connector"] },
  },
  "ops-manager:work": {
    calls: [{ name: "who_owns", args: { id: "task:fix-ig-token" } }],
    structured: { text: "Priya [[person:priya]] owns the token fix [[task:fix-ig-token]]; the founder handed it over on 5 Oct.", citations: ["person:priya", "task:fix-ig-token"] },
  },
  "data-analyst:work": {
    calls: [{ name: "content_performance", args: { channel: "instagram" } }],
    structured: { text: "The salary reveal reel [[content:reel-salary-reveal]] had 48,000 views; the median reel had 6,000.", citations: ["content:reel-salary-reveal"] },
  },
  "coe-lead:review": { structured: { verdict: "ok", note: "Views match the content report." } },
  "fact-checker:review": { structured: { verdict: "ok", note: "Supported." } },
  "chief-of-staff:synthesis": {
    preText: ANSWER,
    calls: [{ name: "show_path", args: { ids: ["system:ig-connector", "system:reel-publisher", "task:fix-ig-token", "person:priya"] } }],
  },
};

describe("wiring (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  let clock = SEED_NOW;
  const count = async (cypher: string, params?: Record<string, unknown>) => (await g.roQuery<{ c: number }>(cypher, params))[0]!.c;
  const wired = async (runtime = new FakeRuntime(scripts), over: Partial<AskDeps> = {}): Promise<AskDeps> =>
    ({ ...(await createAskDeps({ tenant: "test" }, { graph: g, runtime, embedQuery: async (t) => fakeEmbed(t) })), now: () => (clock += 60_000), ...over });

  beforeAll(async () => ({ g, cleanup } = await seededGraph()), 60_000);
  afterAll(async () => cleanup());

  it("builds the deps from the real tools, the tenant graph and search-backed seeds", async () => {
    const deps = await createAskDeps({ tenant: "test", model: "haiku" }, { graph: g, runtime: new FakeRuntime({}), embedQuery: async (t) => fakeEmbed(t) });
    expect(deps.getTools).toBe(toolsByName);
    expect(deps.graph).toBe(g);
    expect(deps.model).toBe("haiku");
    expect(deps.embedQuery).toBeTypeOf("function");
    const seeds = await deps.seedSearch!("Instagram token refresh");
    expect(seeds).toContain("task:fix-ig-token");
    expect(seeds.length).toBeLessThanOrEqual(SEED_LIMIT);
  });

  it("without the model files there is no embedder, and seeds come from text search alone", async () => {
    expect(embedModelReady("/nonexistent-models-dir", "Xenova/multilingual-e5-small")).toBe(false);
    const deps = await createAskDeps({ tenant: "test" }, { graph: g, runtime: new FakeRuntime({}), modelsDir: "/nonexistent-models-dir" });
    expect(deps.embedQuery).toBeUndefined();
    expect(await deps.seedSearch!("reel publisher")).toContain("system:reel-publisher");
  });

  it("refuses a tenant that has no graph instead of creating one", async () => {
    await expect(createAskDeps({ tenant: "no_such_tenant_wiring" }, { runtime: new FakeRuntime({}), embedQuery: null })).rejects.toThrow(/No graph for tenant/);
    await expect(createAskDeps({ tenant: "Bad Slug" }, { runtime: new FakeRuntime({}), embedQuery: null })).rejects.toThrow(/tenant slug/);
  });

  it("the default runtime runs only on the subscription: any other key source stops the run before it works", async () => {
    const sdkSaying = (apiKeySource: string) => async () => ({
      tool: (name: string) => ({ name }),
      createSdkMcpServer: () => ({ type: "sdk" }),
      query: () => Object.assign((async function* () {
        yield { type: "system", subtype: "init", apiKeySource };
        yield { type: "result", subtype: "success", is_error: false, result: "worked" };
      })(), { close: () => {} }),
    }) as unknown as SdkModule;
    const run = async (src: string) => {
      const deps = await createAskDeps({ tenant: "test" }, { graph: g, sdk: sdkSaying(src), embedQuery: null });
      const input: RunInput = { agentId: "data-analyst", model: "haiku", system: "s", prompt: "p", tools: [], ctx: stubCtx() };
      return deps.runtime.run(input, () => {});
    };
    expect(await run("none")).toEqual({ text: "worked" });
    await expect(run("ANTHROPIC_API_KEY")).rejects.toThrow(NotOnSubscriptionError);
    await expect(run("apiKeyHelper")).rejects.toThrow(NotOnSubscriptionError);
  });

  it("ask() over seedMini: session -> plan -> agents -> finding -> review -> text -> path -> final, all checks pass, Turn saved", async () => {
    const runtime = new FakeRuntime(scripts);
    const { events, emit, types } = recorder();
    const r = await ask({ tenant: "test", question: QUESTION, channel: "cli" }, await wired(runtime), emit);
    expect(r.ok).toBe(true);

    // The milestones appear in this order (other events sit between them; the Chief's planning run starts before `plan`).
    const order = ["session", "recall", "plan", "agent_start", "tool_call", "tool_result", "finding", "review", "text", "path", "final"] as const;
    let from = 0;
    for (const t of order) {
      const i = types().indexOf(t, from);
      expect(i, `${t} after index ${from}`).toBeGreaterThanOrEqual(from);
      from = i + 1;
    }
    expect(types().filter((t) => t === "final")).toHaveLength(1);
    expect(types().at(-1)).toBe("final");
    expect(types()).not.toContain("error");

    // Real tools ran on the graph and every call is attributed to the agent that made it.
    const calls = events.filter((e): e is Extract<AgentEvent, { type: "tool_call" }> => e.type === "tool_call");
    expect(calls.map((c) => [c.agent, c.name])).toEqual(expect.arrayContaining([
      ["tech-lead", "impact_of"], ["ops-manager", "who_owns"], ["data-analyst", "content_performance"], ["chief-of-staff", "show_path"],
    ]));
    const impact = events.find((e) => e.type === "tool_result" && e.name === "impact_of") as Extract<AgentEvent, { type: "tool_result" }>;
    expect(impact.nodes.map((n) => n.id)).toEqual(expect.arrayContaining(["system:reel-publisher", "system:reel-scheduler", "channel:instagram"]));
    expect(events.filter((e) => e.type === "finding").map((e) => (e as { agent: string }).agent).sort()).toEqual(["data-analyst", "ops-manager", "tech-lead"]);
    expect(events.find((e) => e.type === "review")).toMatchObject({ agent: "coe-lead", verdict: "ok" });
    const path = events.find((e) => e.type === "path") as Extract<AgentEvent, { type: "path" }>;
    expect(path.nodes.map((n) => n.id)).toEqual(["system:ig-connector", "system:reel-publisher", "task:schedule-reels", "task:fix-ig-token", "person:priya"]);

    // Recall starts from the search tool's hits: the earlier turn that touched the Instagram channel comes back.
    expect((events.find((e) => e.type === "recall") as Extract<AgentEvent, { type: "recall" }>).ids).toContain("turn:t-001");

    expect(r.answer).toBe(ANSWER);
    expect(r.checks).toEqual({ citationsValid: true, invalidCitations: [], numbersGrounded: true, ungroundedNumbers: [], simulatedDisclosed: true, freshnessDisclosed: true, modeDisclosed: true });
    expect(r.agents).toEqual(expect.arrayContaining(["chief-of-staff", "tech-lead", "ops-manager", "data-analyst", "coe-lead"]));

    // The Turn is persisted with its log, findings, review and what it touched.
    expect(await getTurnEvents(g, r.turnId)).toEqual(compactEvents(events));
    const session = await getSession(g, r.sessionId);
    expect(session!.turns[0]).toMatchObject({ id: r.turnId, status: "ok", checks: r.checks });
    expect(await count("MATCH (f:Finding)-[:PART_OF]->(:Turn {id:$t}) RETURN count(f) AS c", { t: r.turnId })).toBe(3);
    expect(await count("MATCH (:Agent)-[r:REVIEWED]->(:Finding)-[:PART_OF]->(:Turn {id:$t}) RETURN count(r) AS c", { t: r.turnId })).toBe(1);
    expect(await count("MATCH (:Turn {id:$t})-[:TOUCHED]->(:Entity {id:'system:ig-connector'}) RETURN count(*) AS c", { t: r.turnId })).toBe(1);
    expect(await count("MATCH (:Turn {id:$t})-[:CITED]->(n) RETURN count(n) AS c", { t: r.turnId })).toBeGreaterThan(0);
  });

  it("stopping the turn reaches the write tools: a propose_action already under way saves nothing", async () => {
    const stop = new AbortController();
    const seen: unknown[] = [];
    // The Ops Manager's propose_action is the real tool; the turn is stopped the moment it starts.
    const getTools = (names: string[]): AlleviaTool[] => toolsByName(names).map((t) => t.name !== "propose_action" ? t : {
      ...t, async run(args, ctx) { stop.abort(new Error("stopped from the keyboard")); const r = await t.run(args, ctx); seen.push(r.data); return r; },
    });
    const title = "Fix the Instagram token refresh now";
    const runtime = new FakeRuntime({
      "chief-of-staff:plan": { structured: { rationale: "Ops", steps: [{ agent: "ops-manager", task: "Propose the token fix" }] } },
      "ops-manager:work": {
        calls: [{ name: "propose_action", args: { title, why: "The connector blocks reel scheduling.", kind: "github_issue", payload: { title, body: "Refresh the token before it expires." }, evidence: ["task:fix-ig-token"] } }],
        structured: { text: "Proposed the fix [[task:fix-ig-token]].", citations: ["task:fix-ig-token"] },
      },
    });
    const approvalsBefore = await count("MATCH (a:Approval) RETURN count(a) AS c");
    const { events, emit } = recorder();
    const r = await ask({ tenant: "test", question: "Open an issue to fix the Instagram token refresh", channel: "cli" },
      await wired(runtime, { getTools, signal: stop.signal }), emit);

    expect(seen).toEqual([expect.objectContaining({ refused: true, error: expect.stringMatching(/saved nothing: the run was stopped/) })]);
    expect(events.some((e) => e.type === "proposal")).toBe(false);
    expect(events.some((e) => e.type === "tool_result" && e.name === "propose_action")).toBe(false); // a result after the stop doesn't count
    expect(await count("MATCH (a:Approval) RETURN count(a) AS c")).toBe(approvalsBefore);
    expect(await count("MATCH (n:Entity {id:$id}) RETURN count(n) AS c", { id: entityId("Recommendation", title) })).toBe(0);
    expect(r.ok).toBe(false);
    const [t] = await g.roQuery<Record<string, unknown>>("MATCH (t:Turn {id:$id}) RETURN t.status AS s, t.error AS e", { id: r.turnId });
    expect(t).toEqual({ s: "failed", e: STOPPED_MESSAGE });
  });
});
