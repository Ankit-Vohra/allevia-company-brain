// Quick questions with tap-able answers: parsed from the answer, shown as Discord buttons (chips in the web app), and a
// tap carries the thread on with that answer as the owner's next message.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAll } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { testGraph } from "../helpers/graph.js";
import type { AgentEvent } from "../../shared/contracts.js";
import { quickReplies } from "../../shared/quick-replies.js";
import type { AskInput, AskResult } from "../../src/agent/ask.js";
import { AlleviaBot, quickReplyId, type ButtonPort, type MessagePort, type Outgoing, type PostedPort, type ThreadPort } from "../../src/discord/bot.js";
import type { GraphHandle } from "../../src/graph/client.js";

describe("quickReplies", () => {
  it("reads 'Quick question: ...? [A] [B]' lines, at most three, and nothing else", () => {
    const text = `Made to get bookings: the kitchen consultation.
Quick question: What should this sell? [Free site visit] [Kitchen redesign] [Other]
- **Quick question:** Which channel? [Instagram] [WhatsApp]
See [[product:kitchen]] for details.
Quick question: Only one option? [Yes]`;
    expect(quickReplies(text)).toEqual([
      { question: "What should this sell?", options: ["Free site visit", "Kitchen redesign", "Other"] },
      { question: "Which channel?", options: ["Instagram", "WhatsApp"] },
    ]);
    expect(quickReplies("No questions here [[metric:x]].")).toEqual([]);
  });
});

describe("Discord quick replies", () => {
  const GUILD = "100000000000000001", CHANNEL = "200000000000000002";
  const sent: Outgoing[] = [];
  const thread: ThreadPort = { id: "300000000000000009", async send(m) { sent.push(m); const p: PostedPort = { id: "x", async edit() {} }; return p; } };
  const asked: string[] = [];
  const answers = ["Here is a draft.\nQuick question: What should this sell? [Free site visit] [Kitchen redesign]", "Done: a post for the free site visit."];
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  let bot: AlleviaBot;
  beforeAll(async () => { ({ g, cleanup } = await testGraph()); await ensureIndexes(g); bot = make(); });
  afterAll(async () => { await cleanup(); await closeAll(); });
  const make = () => new AlleviaBot({
    tenant: "test", guildId: GUILD, channelId: CHANNEL, webBase: "http://localhost", graph: g,
    ask: async (input: AskInput, _emit: (e: AgentEvent) => void): Promise<AskResult> => {
      asked.push(input.question);
      const answer = answers[asked.length - 1] ?? "";
      return { ok: true, turnId: "turn:t", sessionId: input.sessionId ?? "session:s", answer, citations: [], agents: [], ms: 1,
        checks: { citationsValid: true, invalidCitations: [], numbersGrounded: true, ungroundedNumbers: [], simulatedDisclosed: true, freshnessDisclosed: true } };
    },
  });

  it("shows the options as buttons, and a tap asks the team with that answer in the same thread", async () => {
    const m: MessagePort = {
      id: "1", guildId: GUILD, channelId: thread.id, threadParentId: CHANNEL, authorId: "4", authorIsBot: false, authorIsOwner: true,
      system: false, content: "Make a post", thread: () => thread, startThread: async () => thread, reply: async () => {},
    };
    await bot.onMessage(m);
    const card = sent.find((s) => typeof s !== "string" && s.buttons?.length) as Exclude<Outgoing, string>;
    expect(card.content).toBe("What should this sell?");
    expect(card.buttons!.map((b) => [b.label, b.customId])).toEqual([["Free site visit", quickReplyId("Free site visit")], ["Kitchen redesign", quickReplyId("Kitchen redesign")]]);

    const updates: Outgoing[] = [];
    const b: ButtonPort = {
      customId: card.buttons![0]!.customId, guildId: GUILD, channelId: thread.id, threadParentId: CHANNEL, userId: "4", isOwner: true,
      thread: () => thread, async reply() {}, async update(o) { updates.push(o); },
    };
    await bot.onButton(b);
    expect(updates[0]).toEqual({ content: "Your answer: **Free site visit**", buttons: [] });
    expect(asked).toEqual(["Make a post", "Free site visit"]);
  });
});
