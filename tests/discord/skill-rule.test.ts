// A standing rule for a skill said in a plain Discord message ("Miss Influencer, our posts always end with a question"): the bot
// shows what would change and asks; only the owner's Yes writes it (the same preview and apply as "Tell your team" in the
// web app). A question or anything the rules don't read as a skill rule is asked of the team as before.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ask as realAsk } from "../../src/agent/ask.js";
import { ensureRoster } from "../../src/agent/memory.js";
import { loadBusinessSkills } from "../../src/agent/skills/business.js";
import { AlleviaBot, isSkillRule, type ButtonPort, type MessagePort, type Outgoing } from "../../src/discord/bot.js";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { writeBatch } from "../../src/graph/upsert.js";
import { testGraph } from "../helpers/graph.js";
import { NOW } from "../helpers/agent.js";

const GUILD = "100000000000000001";
const CHANNEL = "200000000000000002";
const text = (m: Outgoing): string => (typeof m === "string" ? m : m.content);

describe("isSkillRule", () => {
  it("is a standing rule for a skill, not a question and not anything else", () => {
    expect(isSkillRule("Miss Influencer, our posts always end with a question")).toBe(true);
    expect(isSkillRule("Miss Influencer, add a skill called Festival post: open with the greeting in Hindi")).toBe(true);
    expect(isSkillRule("Why did we pause daily stories?")).toBe(false);
    expect(isSkillRule("Should our posts always end with a question?")).toBe(false);
    expect(isSkillRule("Switch Techie off")).toBe(false);
    expect(isSkillRule("make the captions punchier")).toBe(false);
    expect(isSkillRule("Write two posts for next week")).toBe(false); // a request to make something now, not a rule
    expect(isSkillRule("No emojis on LinkedIn posts")).toBe(false);
  });
});

describe("the bot offers a rule and applies it on the owner's Yes", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  const asked: string[] = [];
  let bot: AlleviaBot;

  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await ensureIndexes(g);
    await writeBatch(g, { nodes: [{ type: "Business", id: "business:kestrel-oak", name: "Kestrel & Oak" }, { type: "Person", id: "person:founder", name: "Founder" }] }, NOW);
    await ensureRoster(g, { businessId: "business:kestrel-oak" }, NOW);
    bot = new AlleviaBot({
      tenant: "test", guildId: GUILD, channelId: CHANNEL, webBase: "http://localhost", graph: g, now: () => NOW,
      ask: async (input, emit) => { asked.push(input.question); return realAsk({ ...input, question: "" }, { runtime: { run: async () => ({ text: "" }) }, getTools: () => [], graph: g }, emit).catch(() => ({ ok: false } as never)); },
    });
  });
  afterAll(async () => { await cleanup(); await closeAll(); });

  const message = (content: string, over: Partial<MessagePort> = {}) => {
    const replies: Outgoing[] = [];
    const m: MessagePort = {
      id: "1", guildId: GUILD, channelId: CHANNEL, threadParentId: null, authorId: "300000000000000004", authorIsBot: false,
      authorIsOwner: true, system: false, content, thread: () => null,
      async startThread() { throw new Error("a rule must not open a thread"); }, async reply(o) { replies.push(o); }, ...over,
    };
    return { m, replies };
  };
  const button = (customId: string, over: Partial<ButtonPort> = {}) => {
    const updates: Outgoing[] = []; const replies: string[] = [];
    const b: ButtonPort = {
      customId, guildId: GUILD, userId: "300000000000000004", isOwner: true,
      async reply(t) { replies.push(t); }, async update(o) { updates.push(o); }, ...over,
    };
    return { b, updates, replies };
  };

  it("shows the change with Yes and Not now, and writes nothing yet", async () => {
    const { m, replies } = message("Miss Influencer, our posts always end with a question");
    await bot.onMessage(m);
    expect(replies).toHaveLength(1);
    const r = replies[0] as Exclude<Outgoing, string>;
    expect(r.content).toMatch(/I can set this up for your team:/);
    expect(r.content).toMatch(/Rule for Miss Influencer's Instagram post craft: "Our posts always end with a question\."/);
    expect(r.buttons?.map((b) => b.label)).toEqual(["Yes, set it up", "Not now"]);
    expect((await loadBusinessSkills(g)).rules).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("only the owner's Yes applies it; a member's press does nothing", async () => {
    const { m, replies } = message("Miss Influencer, our posts always end with a question");
    await bot.onMessage(m);
    const yes = (replies[0] as Exclude<Outgoing, string>).buttons![0]!.customId;

    const member = button(yes, { isOwner: false });
    await bot.onButton(member.b);
    expect(member.replies[0]).toMatch(/Only the owner/);
    expect((await loadBusinessSkills(g)).rules).toEqual([]);

    const owner = button(yes);
    await bot.onButton(owner.b);
    expect(text(owner.updates[0]!)).toMatch(/Done\. Your team will work this way/);
    expect((await loadBusinessSkills(g)).rules.map((r) => [r.skillId, r.text])).toEqual([
      ["instagram-post", "Our posts always end with a question."], ["brand-voice-check", "Our posts always end with a question."],
    ]);
  });

  it("'Not now' changes nothing; saying the same rule again says it is already set", async () => {
    const again = message("Miss Influencer, our posts always end with a question");
    await bot.onMessage(again.m);
    expect(text(again.replies[0]!)).toMatch(/already works this way/);
    expect((again.replies[0] as Exclude<Outgoing, string>).buttons).toEqual([]);

    const fresh = message("Never use emojis in reels");
    await bot.onMessage(fresh.m);
    const skip = (fresh.replies[0] as Exclude<Outgoing, string>).buttons![1]!.customId;
    const b = button(skip);
    await bot.onButton(b.b);
    expect(text(b.updates[0]!)).toBe("Okay, nothing changed.");
    expect((await loadBusinessSkills(g)).rules.some((r) => r.skillId === "reel-script")).toBe(false);
  });

  it("a member's plain message is never read as a rule", async () => {
    const { m, replies } = message("Miss Influencer, our posts always end with a question", { authorIsOwner: false, startThread: async () => { throw new Error("asked as a question"); } });
    await expect(bot.onMessage(m)).rejects.toThrow(/asked as a question/);
    expect(replies).toEqual([]);
  });
});
