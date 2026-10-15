// "What is the need of it?" Every poster, picture and reel serves a brief (goal, the thing promoted, audience, one message, a
// call to action, a placement). A missing part is never guessed: the tool returns "needs brief" with at most three short
// questions whose tap-to-answer options come from the business's own record; the turn streams them as quick replies, and on
// Discord a tap is the owner's next message.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { AgentEvent, ToolResult } from "../../shared/contracts.js";
import { TouchedSet, type ToolContext } from "../../src/agent/tool.js";
import { generateImageTool, makePosterTool, makeReelTool } from "../../src/agent/tools/creative.js";
import { toQuickReplies } from "../../src/agent/orchestrator.js";
import { MAX_QUESTIONS, resolveBrief } from "../../src/creative/brief.js";
import { AlleviaBot, type ButtonPort, type MessagePort, type Outgoing, type PostedPort, type ThreadPort } from "../../src/discord/bot.js";
import type { AskInput, AskResult } from "../../src/agent/ask.js";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { upsertNode } from "../../src/graph/upsert.js";
import { AssetStore } from "../../src/studio/store.js";
import { testGraph } from "../helpers/graph.js";
import { snowflake } from "../helpers/hub-fakes.js";
import { FakeCreativeEngine, fakeVisionFor, NOW, seedKit, TENANT } from "./helpers.js";

describe("the brief", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  let dir: string;
  let store: AssetStore;
  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    dir = mkdtempSync(join(tmpdir(), "allevia-brief-"));
    store = new AssetStore(dir);
    await seedKit(g, store);
    await upsertNode(g, { type: "Product", id: "product:interior-design", name: "Interior Design", summary: "Interiors for homes and workplaces." }, NOW);
    await upsertNode(g, { type: "Product", id: "product:site-visit", name: "Site visit", summary: "A first visit to the site to see what is possible." }, NOW);
    await upsertNode(g, { type: "Audience", id: "audience:homeowners", name: "Homeowners in Bristol" }, NOW);
  }, 60_000);
  afterAll(async () => { await cleanup(); await closeAll(); rmSync(dir, { recursive: true, force: true }); });

  it("asks at most three short questions, most important first, with options from the business's own record", async () => {
    const r = await resolveBrief(g, "poster", {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.needs.questions.length).toBeLessThanOrEqual(MAX_QUESTIONS);
    expect(r.needs.questions.map((q) => q.field)).toEqual(["promoting", "message", "cta"]);
    expect(r.needs.questions[0]!.options).toEqual(expect.arrayContaining(["Interior Design", "Site visit"]));
    expect(r.needs.questions[1]!.options).toEqual([]); // the message is the owner's own words
    expect(r.needs.questions[2]!.options).toEqual(expect.arrayContaining(["Visit kestrel.example"]));
  });

  it("resolves the thing promoted to its node, defaults what may be defaulted, and says so", async () => {
    const r = await resolveBrief(g, "poster", { promoting: "Site visit", message: "See what your home could be", cta: "Book a visit", goal: "sell" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.brief.promoting).toMatchObject({ id: "product:site-visit", name: "Site visit" });
    expect(r.brief.audience).toBe("Homeowners in Bristol"); // the record's audience when the owner named none
    expect(r.brief.placement).toBe("insta_post");
    expect(r.defaulted).toEqual(expect.arrayContaining(["placement", "audience"]));
    expect((await resolveBrief(g, "poster", { promoting: "product:site-visit", message: "x y", cta: "Book", goal: "an offer", placement: "story" })).ok).toBe(true);
  });

  const ctx = (): ToolContext => ({
    graph: g, tenant: TENANT, turnId: "t-brief", agentId: "chief-of-staff", asker: "person:founder", touched: new TouchedSet(), now: NOW, question: "I want a poster for Insta with my logo",
    creative: { store, vision: fakeVisionFor(), engine: new FakeCreativeEngine(), maxCreditsPerRequest: 10, spent: { credits: 0 } },
  });
  const run = (tool: typeof makePosterTool, args: Record<string, unknown>) => tool.run(z.object(tool.input).parse(args), ctx()) as Promise<ToolResult & { data: Record<string, unknown> }>;

  it("every creating tool returns 'needs brief' instead of guessing, and makes nothing", async () => {
    for (const [tool, args] of [[makePosterTool, { brief: { message: "Looking good" } }], [generateImageTool, { brief: {} }], [makeReelTool, { brief: { promoting: "Site visit" } }]] as const) {
      const r = await run(tool, args);
      expect(r.data).toMatchObject({ made: false, needsBrief: true });
      expect((r.data.questions as unknown[]).length).toBeGreaterThan(0);
      expect(r.data.say).toMatch(/Don't make anything and don't guess/);
    }
    expect(await g.roQuery("MATCH (a:Asset) WHERE a.kind IN ['poster', 'image', 'clip'] RETURN a.id")).toHaveLength(0);
  });

  it("a complete brief makes a poster that sells the thing: it is the hero, it is promoted, and the strip carries the call to action", async () => {
    const engine = new FakeCreativeEngine();
    const r = await makePosterTool.run(z.object(makePosterTool.input).parse({ brief: { goal: "sell", promoting: "product:site-visit", message: "See what your home could be", cta: "Book a visit", placement: "insta_post" } }),
      { ...ctx(), creative: { store, vision: fakeVisionFor(), engine, maxCreditsPerRequest: 10, spent: { credits: 0 } } }) as ToolResult & { data: Record<string, unknown> };
    expect(r.data.made).toBe(true);
    expect(engine.generated[0]!.prompt).toContain("Site visit");
    const id = (r.data.options as Array<{ id: string }>)[0]!.id;
    expect(await g.roQuery("MATCH (:Asset {id:$id})-[:PROMOTES]->(:Product {id:'product:site-visit'}) RETURN 1", { id })).toHaveLength(1);
    const [m] = await g.roQuery<{ m: string }>("MATCH (a:Asset {id:$id}) RETURN a.manifest AS m", { id });
    const texts = (JSON.parse(m!.m) as { texts: Array<{ role: string; shown: string }> }).texts;
    expect(texts.find((t) => t.role === "cta")?.shown).toBe("Book a visit");
    expect(texts.find((t) => t.role === "headline")?.shown).toBe("See what your home could be");
    expect(texts.find((t) => t.role === "eyebrow")?.shown).toBe("SITE VISIT");
  }, 60_000);

  it("the questions become a quick_replies event, at most three, options clipped", () => {
    const e = toQuickReplies("chief-of-staff", { data: { quickReplies: [1, 2, 3, 4].map((i) => ({ field: "x", question: `Q${i}?`, options: ["a", "b", "c", "d", "e"] })) }, nodes: [], edges: [], sources: [] });
    expect(e!.questions).toHaveLength(3);
    expect(e!.questions[0]!.options).toHaveLength(4);
    expect(toQuickReplies("x", { data: {}, nodes: [], edges: [], sources: [] })).toBeUndefined();
  });

  it("on Discord the questions come as buttons, and a tap is the owner's next message in the same thread", async () => {
    class FakePosted implements PostedPort { id = snowflake(); constructor(public first: Outgoing) {} async edit() {} }
    class FakeThread implements ThreadPort { sent: FakePosted[] = []; constructor(public id: string) {} async send(m: Outgoing) { const p = new FakePosted(m); this.sent.push(p); return p; } }
    const asked: string[] = [];
    const ALL_OK = { citationsValid: true, invalidCitations: [], numbersGrounded: true, ungroundedNumbers: [], simulatedDisclosed: true, freshnessDisclosed: true };
    const bot = new AlleviaBot({
      tenant: TENANT, guildId: "g", channelId: "c", webBase: "https://allevia.test", graph: g, log: () => {}, workLogIntervalMs: 0,
      ask: async (input: AskInput, emit): Promise<AskResult> => {
        asked.push(input.question);
        if (asked.length === 1) emit({ type: "quick_replies", agent: "chief-of-staff", questions: [{ field: "promoting", question: "What should it sell or promote?", options: ["Interior Design", "Site visit"] }, { field: "message", question: "What should it say?", options: [] }] } satisfies AgentEvent);
        return { ok: true, turnId: "turn:x", sessionId: input.sessionId ?? "s", answer: "A couple of quick questions first.", citations: [], checks: ALL_OK, agents: [], ms: 1 };
      },
    });
    const thread = new FakeThread(snowflake());
    const m: MessagePort = { id: snowflake(), guildId: "g", channelId: "c", threadParentId: null, authorId: "u", authorIsBot: false, authorIsOwner: true, system: false, content: "I want a poster for Insta with my logo", thread: () => null, async startThread() { return thread; }, async reply() {} };
    await bot.onMessage(m);
    const qs = thread.sent.filter((p) => typeof p.first !== "string" && (p.first.content.startsWith("**What")));
    expect(qs).toHaveLength(2);
    const first = qs[0]!.first as Exclude<Outgoing, string>;
    expect(first.buttons!.map((b) => b.label)).toEqual(["Interior Design", "Site visit"]);
    expect((qs[1]!.first as Exclude<Outgoing, string>).content).toMatch(/Reply here in your own words/);
    const updates: Outgoing[] = [];
    const press: ButtonPort = { customId: first.buttons![1]!.customId, guildId: "g", userId: "u", isOwner: true, async reply() {}, async update(x) { updates.push(x); } };
    await bot.onButton(press);
    expect(asked).toEqual(["I want a poster for Insta with my logo", "Site visit"]);
    expect(typeof updates[0] === "string" ? updates[0] : updates[0]!.content).toMatch(/You chose: Site visit/);
    // a stranger cannot answer for the owner
    const replies: string[] = [];
    await bot.onButton({ ...press, customId: first.buttons![0]!.customId, isOwner: false, async reply(t) { replies.push(t); } });
    expect(replies[0]).toMatch(/Only the owner/);
  }, 60_000);
});
