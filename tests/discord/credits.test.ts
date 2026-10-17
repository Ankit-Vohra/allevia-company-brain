// Out of credits on Discord (src/discord/credits.ts): the same sentence as the web app, with its two buttons as links to the
// plan page, for a question (the work log becomes the sentence; nothing runs), an Approve button (the card keeps waiting)
// and /checkup (nothing starts). Discord's questions are charged through chargedAsk, like the web's.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentEvent } from "../../shared/contracts.js";
import { FakeRuntime } from "../../src/agent/runtime.js";
import { createAskDeps } from "../../src/agent/wiring.js";
import { putSubscription } from "../../src/billing/subscription.js";
import { CheckupJobs } from "../../src/checkup/jobs.js";
import { chargedAsk } from "../../src/credits/ask.js";
import { Credits } from "../../src/credits/index.js";
import { AlleviaBot, type ButtonPort, type CommandPort, type MessagePort, type Outgoing, type PostedPort, type ThreadPort } from "../../src/discord/bot.js";
import { openGraphByName, type GraphHandle } from "../../src/graph/client.js";
import { upsertNode } from "../../src/graph/upsert.js";
import { SCRIPTS } from "../server/harness.js";
import { fakeEmbed, SEED_NOW } from "../fixtures/seed-graph.js";
import { testGraphName } from "../helpers/graph.js";
import { seededGraph } from "../helpers/tools.js";

const GUILD = "100000000000000001";
const CHANNEL = "200000000000000002";
const NOW = SEED_NOW + 3_600_000;
const SENTENCE = "You've used this month's credits. Buy 100 more for $29 or move to Growth.";
const LINKS = [
  { label: "Buy 100 credits", url: "https://app.example/plan?buy=pack100" },
  { label: "Move to Growth", url: "https://app.example/plan?plan=growth" },
];

let seq = 0;
const nextId = () => String(900000000000000000n + BigInt(++seq));
class Posted implements PostedPort {
  id = nextId();
  edits: Outgoing[] = [];
  constructor(public first: Outgoing) {}
  get current(): Outgoing { return this.edits.at(-1) ?? this.first; }
  async edit(m: Outgoing): Promise<void> { this.edits.push(m); }
}
class Thread implements ThreadPort {
  sent: Posted[] = [];
  constructor(public id: string) {}
  async send(m: Outgoing): Promise<Posted> { const p = new Posted(m); this.sent.push(p); return p; }
}

describe("discord: out of credits", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  const metaGraph = testGraphName();
  let credits: Credits;
  let asked = 0;
  const checkups = new CheckupJobs({ run: async () => {}, log: () => {} });

  const bot = async () => {
    const deps = await createAskDeps({ tenant: "mini" }, { graph: g, runtime: new FakeRuntime(SCRIPTS), embedQuery: async (t) => fakeEmbed(t) });
    return new AlleviaBot({
      tenant: "mini", guildId: GUILD, channelId: CHANNEL, webBase: "https://app.example/", graph: g, credits, checkup: checkups,
      ask: (input, emit: (e: AgentEvent) => void) => { asked++; return chargedAsk(input, { ...deps, now: () => NOW }, emit, { credits, g }); },
      workLogIntervalMs: 0, now: () => NOW, log: () => {},
    });
  };

  beforeAll(async () => {
    ({ g, cleanup } = await seededGraph());
    credits = new Credits({ openGraph: async () => g, tenantOpts: { metaGraph }, now: () => NOW, log: () => {} });
    await putSubscription({ slug: "mini", plan: "pause", cycle: "monthly", status: "paused", startedAt: NOW, provider: "test", updatedAt: NOW }, { metaGraph });
  }, 90_000);
  afterAll(async () => {
    await (await openGraphByName(metaGraph)).drop().catch(() => undefined);
    await cleanup();
  });

  it("a question is charged like the web's while credits last", async () => {
    const b = await bot();
    const t = new Thread(nextId());
    const m: MessagePort = {
      id: nextId(), guildId: GUILD, channelId: CHANNEL, threadParentId: null, authorId: "1", authorIsBot: false, authorIsOwner: true, system: false,
      content: "Why did we pause daily stories?", thread: () => null, startThread: async () => t, reply: async () => {},
    };
    await b.onMessage(m);
    await expect.poll(async () => (await credits.balance("mini")).used).toBe(5); // the team looked into it: a deep question
    expect((await credits.entries("mini", "2026-10")).find((e) => e.service === "question_deep")?.by).toBe("person:founder");
  });

  it("with none left: a question, an Approve button and /checkup each get the sentence and the plan page's two buttons", async () => {
    const left = (await credits.balance("mini")).left;
    await credits.grant("mini", -left, "Taken back for the test", "drain");
    const b = await bot();

    const t = new Thread(nextId());
    const before = asked;
    await b.onMessage({
      id: nextId(), guildId: GUILD, channelId: CHANNEL, threadParentId: null, authorId: "1", authorIsBot: false, authorIsOwner: true, system: false,
      content: "Anything new this week?", thread: () => null, startThread: async () => t, reply: async () => {},
    });
    expect(asked).toBe(before + 1);
    const log = t.sent.find((p) => typeof p.current !== "string");
    expect(log?.current).toEqual({ content: SENTENCE, links: LINKS });

    await upsertNode(g, { type: "Approval", id: "approval:dc-1", name: "email_send: Hi", props: { status: "pending", kind: "email_send", title: "Hi", payload: JSON.stringify({ title: "Hi", body: "Hello" }) } }, SEED_NOW);
    const replies: Array<{ m: Outgoing; ephemeral: boolean }> = [];
    const btn: ButtonPort = {
      customId: "allevia:approve:approval:dc-1", guildId: GUILD, userId: "1", isOwner: true,
      reply: async (text, o) => { replies.push({ m: text, ephemeral: !!o?.ephemeral }); },
      replyWith: async (m, o) => { replies.push({ m, ephemeral: !!o?.ephemeral }); },
      update: async () => { throw new Error("the card must not change"); },
    };
    await b.onButton(btn);
    expect(replies).toEqual([{ m: { content: SENTENCE, links: LINKS }, ephemeral: true }]);
    const [card] = await g.roQuery<{ status: string }>("MATCH (a:Entity:Approval {id:'approval:dc-1'}) RETURN a.status AS status");
    expect(card?.status).toBe("pending");

    await upsertNode(g, { type: "Business", id: "business:aamdani", name: "Aamdani", props: { domain: "mini.example" } }, SEED_NOW);
    const responses: Array<{ m: Outgoing; ephemeral: boolean }> = [];
    const cmd: CommandPort = {
      command: "checkup", guildId: GUILD, channelId: CHANNEL, threadParentId: null, userId: "1", isOwner: true,
      defer: async () => {}, respond: async (m, o) => { responses.push({ m, ephemeral: !!o?.ephemeral }); },
      followUp: async (m) => new Posted(m), thread: () => null, createThread: async () => new Thread(nextId()),
    };
    await b.onCommand(cmd);
    expect(responses.at(-1)).toEqual({ m: { content: SENTENCE, links: LINKS }, ephemeral: true });
    expect(checkups.state("mini")).toBeUndefined();
  });
});
