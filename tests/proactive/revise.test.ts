// "Change" on a stand-up draft, end to end with a fake Discord: the owner presses Change in #todays-note, says what to
// change in #your-team, the person who drafted it redrafts, and the card comes back still waiting for the OK.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AlleviaBot, type ButtonPort, type MessagePort, type Outgoing } from "../../src/discord/bot.js";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { upsertNode } from "../../src/graph/upsert.js";
import { reviseDraft } from "../../src/proactive/revise.js";
import type { Drafters } from "../../src/proactive/draft.js";
import { approval as readApproval } from "../../src/server/reads.js";
import { SEED_NOW } from "../fixtures/seed-graph.js";
import { testGraph } from "../helpers/graph.js";

const GUILD = "100000000000000001";
const TEAM = "200000000000000002";
const NOTE = "200000000000000009";
const OWNER = "300000000000000004";
let g: GraphHandle;
let cleanup: () => Promise<void>;
const asked: string[] = [];
const text: Drafters["text"] = async (job) => { asked.push(job.brief); return { ok: true, text: "Shorter: Diwali greetings from our Raipur office.", hashtags: ["#Raipur"], warnings: [] }; };

beforeAll(async () => {
  ({ g, cleanup } = await testGraph());
  await upsertNode(g, { type: "Approval", id: "approval:standup-diwali-1", name: "content_draft: A Diwali post", props: {
    status: "pending", kind: "content_draft", title: "A Diwali post", by: "content-strategist", standup: true, standupKey: "season:diwali", standupKind: "post",
    payload: JSON.stringify({ title: "A Diwali post", body: "A long Diwali post that goes on and on.", target: "Instagram post" }) } }, SEED_NOW);
  await upsertNode(g, { type: "Approval", id: "approval:ad", name: "pause_ad: Pause it", props: { status: "pending", kind: "pause_ad", title: "Pause it", payload: "{}" } }, SEED_NOW);
  await upsertNode(g, { type: "Approval", id: "approval:other", name: "github_issue: Fix it", props: { status: "pending", kind: "github_issue", title: "Fix it", payload: "{}" } }, SEED_NOW);
});
afterAll(async () => { await cleanup(); await closeAll(); });

describe("reviseDraft", () => {
  it("redrafts the way the owner asked and keeps it waiting, with the earlier words kept", async () => {
    const r = await reviseDraft(g, "approval:standup-diwali-1", "shorter, and say Raipur", { text, now: SEED_NOW + 1000 });
    expect(r).toEqual({ ok: true, approvalId: "approval:standup-diwali-1" });
    expect(asked[0]).toContain('The owner asked: "shorter, and say Raipur"');
    const [row] = await g.roQuery<{ status: string; payload: string; n: number }>("MATCH (a:Entity:Approval {id:'approval:standup-diwali-1'}) RETURN a.status AS status, a.payload AS payload, a.changeRequests AS n");
    expect(row!.status).toBe("pending");
    expect(row!.n).toBe(1);
    expect(JSON.parse(row!.payload)).toMatchObject({ body: "Shorter: Diwali greetings from our Raipur office.\n\n#Raipur", previousBody: "A long Diwali post that goes on and on." });
  });

  it("teaches: the change note becomes a learned rule on the skill that drafted it, and the next draft is given it", async () => {
    const rules = await g.roQuery<{ text: string; skills: string[]; op: string; conf: number }>(
      "MATCH (r:Rule {kind:'learned'})-[:LEARNED_FROM]->(a:Approval {id:'approval:standup-diwali-1'}) RETURN r.text AS text, r.skills AS skills, r.op AS op, r.confidence AS conf");
    expect(rules).toEqual([{ text: "The owner asked for: shorter, and say Raipur.", skills: ["campaign-brief"], op: "instruction", conf: 0.5 }]);
    const { activeRules } = await import("../../src/actions/learning.js");
    const { agentNodeId } = await import("../../src/agent/memory.js");
    expect((await activeRules(g, { agentId: agentNodeId("content-strategist") })).map((r) => r.text)).toContain("The owner asked for: shorter, and say Raipur.");
    // asking for the same thing again reinforces the rule instead of adding a second
    await reviseDraft(g, "approval:standup-diwali-1", "Shorter, and say Raipur!", { text, now: SEED_NOW + 2000 });
    const [again] = await g.roQuery<{ n: number; conf: number }>("MATCH (r:Rule {kind:'learned'}) WHERE r.text STARTS WITH 'The owner asked for' RETURN count(r) AS n, max(r.confidence) AS conf");
    expect(again).toEqual({ n: 1, conf: 0.6 });
  });

  it("only changes a stand-up draft that is still waiting", async () => {
    expect(await reviseDraft(g, "approval:ad", "x", { text })).toMatchObject({ ok: false, why: expect.stringMatching(/web app/) }); // nothing to reword
    // any other waiting draft is redrafted by whoever made it, not only the ones from today's note (Discord is where owners work)
    expect(await reviseDraft(g, "approval:other", "shorter", { text })).toMatchObject({ ok: true });
    expect(await reviseDraft(g, "approval:nope", "x", { text })).toMatchObject({ ok: false });
    expect(await reviseDraft(g, "approval:standup-diwali-1", "   ", { text })).toMatchObject({ ok: false });
  });
});

describe("Change on Discord", () => {
  it("Change asks what to change; 'Change: …' in #your-team brings the redraft back with its buttons", async () => {
    const bot = new AlleviaBot({
      tenant: "test", guildId: GUILD, channelId: TEAM, webBase: "http://localhost", graph: g, now: () => SEED_NOW + 5000,
      ask: async () => { throw new Error("not a question"); },
      revise: async (id, instruction) => {
        const r = await reviseDraft(g, id, instruction, { text });
        return r.ok ? (await readApproval(g, id))! : { why: r.why };
      },
    });
    const replies: Array<{ text: string; ephemeral: boolean }> = [];
    const button: ButtonPort = {
      customId: "allevia:change:approval:standup-diwali-1", guildId: GUILD, channelId: NOTE, userId: OWNER, isOwner: true,
      async reply(t, o) { replies.push({ text: t, ephemeral: !!o?.ephemeral }); }, async update() {},
    };
    await bot.onButton(button);
    expect(replies[0]).toMatchObject({ ephemeral: true, text: expect.stringContaining(`<#${TEAM}>`) });

    const out: Outgoing[] = [];
    const msg: MessagePort = {
      id: "m1", guildId: GUILD, channelId: TEAM, threadParentId: null, authorId: OWNER, authorIsBot: false, authorIsOwner: true, system: false,
      content: "Change: make it shorter", thread: () => null, async startThread() { throw new Error("no thread for a change"); }, async reply(m) { out.push(m); },
    };
    await bot.onMessage(msg);
    expect(out).toHaveLength(1);
    const card = out[0] as { content: string; buttons: Array<{ customId: string }> };
    expect(card.content).toContain("drafted by Miss Influencer");
    expect(card.buttons.map((b) => b.customId)).toEqual(["allevia:approve:approval:standup-diwali-1", "allevia:change:approval:standup-diwali-1", "allevia:reject:approval:standup-diwali-1"]);

    // a "Change:" with no Change pressed is just a question for the team
    await expect(bot.onMessage({ ...msg, id: "m2" })).rejects.toThrow("no thread for a change");
  });
});
