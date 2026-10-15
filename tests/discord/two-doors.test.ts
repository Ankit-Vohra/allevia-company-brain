// One conversation, two doors: a thread started on Discord is the same Session in the graph as a web thread, shows in
// the web app's history, and can be continued there; a thread started in the web app can be carried on in Discord
// (/continue), and a reply there continues the very same Session. Every Turn says which door it came through
// (source: "web" | "discord"). Real ask() with a scripted runtime over the API test harness; Discord is the fake.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentEvent } from "../../shared/contracts.js";
import { ask, type AskInput } from "../../src/agent/ask.js";
import { FakeRuntime } from "../../src/agent/runtime.js";
import { createAskDeps } from "../../src/agent/wiring.js";
import { AlleviaBot, type ButtonPort, type CommandPort, type MessagePort, type Outgoing, type PostedPort, type ThreadPort } from "../../src/discord/bot.js";
import { findThreadSession } from "../../src/discord/sessions.js";
import { fakeEmbed, SEED_NOW } from "../fixtures/seed-graph.js";
import { SCRIPTS } from "../server/harness.js";
import { harness, post, sseEvents, type Harness } from "../server/harness.js";

const GUILD = "100000000000000001";
const CHANNEL = "200000000000000002";
const text = (m: Outgoing): string => (typeof m === "string" ? m : m.content);
let seq = 0;
const nextId = () => String(900000000000000000n + BigInt(++seq));

class FakePosted implements PostedPort {
  id = nextId();
  edits: Outgoing[] = [];
  constructor(public first: Outgoing) {}
  async edit(m: Outgoing) { this.edits.push(m); }
}
class FakeThread implements ThreadPort {
  sent: FakePosted[] = [];
  constructor(public id: string, public name: string) {}
  async send(m: Outgoing) { const p = new FakePosted(m); this.sent.push(p); return p; }
}

const message = (content: string, o: Partial<Omit<MessagePort, "thread">> & { thread?: FakeThread } = {}): MessagePort & { started: FakeThread[] } => {
  const started: FakeThread[] = [];
  const { thread, ...rest } = o;
  return {
    id: nextId(), guildId: GUILD, channelId: thread?.id ?? CHANNEL, threadParentId: thread ? CHANNEL : null, authorId: "300000000000000004",
    authorIsBot: false, authorIsOwner: true, system: false, content,
    thread: () => thread ?? null,
    async startThread(name) { const t = new FakeThread(nextId(), name); started.push(t); return t; },
    async reply() {}, started, ...rest,
  };
};

describe("one conversation, two doors", () => {
  let h: Harness;
  let bot: AlleviaBot;
  let calls: AskInput[] = [];

  beforeAll(async () => {
    h = await harness();
    const deps = await createAskDeps({ tenant: "mini" }, { graph: h.g, runtime: new FakeRuntime(SCRIPTS), embedQuery: async (t) => fakeEmbed(t) });
    let clock = SEED_NOW + 3_600_000;
    bot = new AlleviaBot({
      tenant: "mini", guildId: GUILD, channelId: CHANNEL, webBase: "http://127.0.0.1:8787", graph: h.g,
      ask: async (input, emit) => { calls.push(input); return ask(input, { ...deps, now: () => (clock += 60_000) }, emit); },
      workLogIntervalMs: 0, now: () => SEED_NOW + 3_600_000, log: () => {},
    });
  });
  afterAll(async () => { await h.cleanup(); });

  const api = async <T>(path: string) => (await (await h.app.request(path)).json()) as T;
  const detail = (id: string) => api<{ turns: Array<{ id: string; question: string; source?: string }> }>(`/api/mini/sessions/${encodeURIComponent(id)}`);
  const turnSource = async (id: string) => (await h.g.roQuery<{ s: string | null }>("MATCH (t:Turn {id:$id}) RETURN t.source AS s", { id }))[0]?.s;
  const sessionChannel = async (id: string) => (await h.g.roQuery<{ c: string | null }>("MATCH (s:Session {id:$id}) RETURN s.channel AS c", { id }))[0]?.c;

  it("a thread started on Discord is a Session in the graph, in the web history, and its Turn says it came from Discord", async () => {
    const m = message("Why did we pause daily stories?");
    await bot.onMessage(m);
    const sessionId = calls.at(-1)!.sessionId!;
    expect(calls.at(-1)!.channel).toBe("discord");
    const t = await detail(sessionId);
    expect(t.turns).toHaveLength(1);
    expect(t.turns[0]!.source).toBe("discord");
    expect(await turnSource(t.turns[0]!.id)).toBe("discord");
    const history = await api<Array<{ id: string; channel: string; turns: number }>>("/api/mini/sessions");
    expect(history.find((s) => s.id === sessionId)).toMatchObject({ channel: "discord", turns: 1 });
    // the live answer was one work-log message edited as the turn went, then the answer
    const [log] = m.started[0]!.sent;
    expect(log!.edits.length).toBeGreaterThan(0);
    expect(text(log!.edits.at(-1)!)).toMatch(/^\*\*Work log\*\*/);
  });

  it("the web app continues that very thread: same Session, a second Turn from the web", async () => {
    const first = message("What did the September report say?");
    await bot.onMessage(first);
    const sessionId = calls.at(-1)!.sessionId!;
    const before = (await api<unknown[]>("/api/mini/sessions")).length;
    const res = await post(h.app, "/api/mini/ask", { question: "And what did that change?", sessionId });
    const events = sseEvents(await res.text()) as AgentEvent[];
    expect(events.some((e) => e.type === "final")).toBe(true);
    expect((await api<unknown[]>("/api/mini/sessions")).length).toBe(before); // no new thread
    const t = await detail(sessionId);
    expect(t.turns.map((x) => x.source).sort()).toEqual(["discord", "web"]); // (two turns, one from each door)
    expect(await sessionChannel(sessionId)).toBe("discord"); // where it began
  });

  it("a thread started on the web is carried on in Discord with /continue, and replies there continue the same Session", async () => {
    const res = await post(h.app, "/api/mini/ask", { question: "Which pages have no title?" });
    const sessionId = (sseEvents(await res.text()) as AgentEvent[]).find((e): e is Extract<AgentEvent, { type: "session" }> => e.type === "session")!.sessionId;
    expect((await detail(sessionId)).turns.map((x) => x.source)).toEqual(["web"]);

    const responses: Outgoing[] = [];
    const cmd: CommandPort = {
      command: "continue", guildId: GUILD, channelId: CHANNEL, threadParentId: null, userId: "u1", isOwner: true,
      async defer() {}, async respond(m) { responses.push(m); }, async followUp(m) { return new FakePosted(m); },
      thread: () => null, async createThread(name) { return new FakeThread(nextId(), name); },
    };
    await bot.onCommand(cmd);
    const offer = responses[0]!;
    expect(typeof offer !== "string" && offer.buttons!.map((b) => b.customId)).toContain(`allevia:continue:${sessionId}`);
    expect(typeof offer !== "string" && offer.buttons!.find((b) => b.customId.endsWith(sessionId))!.label).toContain("Which pages have no title");

    // press it
    const made: FakeThread[] = [];
    const press = (userIsOwner = true): ButtonPort & { replies: string[]; updates: Outgoing[] } => {
      const b = {
        customId: `allevia:continue:${sessionId}`, guildId: GUILD, userId: "u1", isOwner: userIsOwner, replies: [] as string[], updates: [] as Outgoing[],
        async reply(t: string) { b.replies.push(t); }, async update(m: Outgoing) { b.updates.push(m); },
        async createThread(name: string) { const t = new FakeThread(nextId(), name); made.push(t); return t; },
      };
      return b as never;
    };
    const stranger = press(false);
    await bot.onButton(stranger);
    expect(made).toHaveLength(0); // only the owner
    const ok = press();
    await bot.onButton(ok);
    expect(made).toHaveLength(1);
    const thread = made[0]!;
    expect(await findThreadSession(h.g, thread.id)).toBe(sessionId);
    const recap = text(thread.sent[0]!.first);
    expect(recap).toContain("Carrying on from the web app");
    expect(recap).toContain("Which pages have no title?");
    expect(text(ok.updates[0]!)).toContain(`<#${thread.id}>`);

    // a reply in the Discord thread continues that Session
    await bot.onMessage(message("Fix those first, please.", { thread }));
    expect(calls.at(-1)).toMatchObject({ sessionId, channel: "discord" });
    const t = await detail(sessionId);
    expect(t.turns.map((x) => x.source).sort()).toEqual(["discord", "web"]);
    expect(await sessionChannel(sessionId)).toBe("web");

    // pressing it again does not open a second thread; /continue no longer offers it
    const again = press();
    await bot.onButton(again);
    expect(made).toHaveLength(1);
    expect(again.replies[0]).toContain(`<#${thread.id}>`);
    responses.length = 0;
    await bot.onCommand(cmd);
    const next = responses[0]!;
    expect(typeof next === "string" ? next : (next.buttons ?? []).map((b) => b.customId)).not.toContain(`allevia:continue:${sessionId}`);
  });

  it("/continue only works in the Allevia channel, and an unknown conversation is turned away", async () => {
    const out: Array<{ m: Outgoing; ephemeral: boolean }> = [];
    const elsewhere: CommandPort = {
      command: "continue", guildId: GUILD, channelId: "200000000000000099", threadParentId: null, userId: "u1", isOwner: true,
      async defer() {}, async respond(m, o) { out.push({ m, ephemeral: !!o?.ephemeral }); }, async followUp(m) { return new FakePosted(m); },
      thread: () => null, async createThread(n) { return new FakeThread(nextId(), n); },
    };
    await bot.onCommand(elsewhere);
    expect(out[0]).toMatchObject({ ephemeral: true });
    const replies: string[] = [];
    await bot.onButton({
      customId: "allevia:continue:session:nope", guildId: GUILD, userId: "u1", isOwner: true,
      async reply(t) { replies.push(t); }, async update() {}, async createThread(n) { return new FakeThread(nextId(), n); },
    });
    expect(replies[0]).toMatch(/no longer exists/);
  });
});
