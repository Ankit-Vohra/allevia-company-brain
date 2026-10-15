// The Discord bot's behaviour with a fake Discord (no network), over a seeded throwaway graph and the real ask() with
// a scripted runtime: one thread per conversation and replies that continue it (also after a restart), the demo
// server and channel only, the live work log, the answer with labels, badges and the path link, /brief, /approvals
// and owner-only Approve/Reject buttons.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "../../shared/contracts.js";
import { ask, type AskInput, type AskResult } from "../../src/agent/ask.js";
import { ensureRoster } from "../../src/agent/memory.js";
import { FakeRuntime } from "../../src/agent/runtime.js";
import { createAskDeps } from "../../src/agent/wiring.js";
import {
  AlleviaBot, type BotDeps, type ButtonPort, type CommandPort, type MessagePort, type Outgoing, type PostedPort, type ThreadPort,
} from "../../src/discord/bot.js";
import { findThreadSession } from "../../src/discord/sessions.js";
import type { GraphHandle } from "../../src/graph/client.js";
import { upsertNode } from "../../src/graph/upsert.js";
import { SCRIPTS } from "../server/harness.js";
import { fakeEmbed, SEED_NOW } from "../fixtures/seed-graph.js";
import { seededGraph } from "../helpers/tools.js";

const GUILD = "100000000000000001";
const CHANNEL = "200000000000000002";
const OTHER_CHANNEL = "200000000000000003";
const OWNER = "300000000000000004";
const MEMBER = "300000000000000005";
const QUESTION = "Why did we pause daily stories?";

// ---------- a fake Discord ----------

let seq = 0;
const nextId = () => String(900000000000000000n + BigInt(++seq));
const text = (m: Outgoing): string => (typeof m === "string" ? m : m.content);

class FakePosted implements PostedPort {
  id = nextId();
  edits: Outgoing[] = [];
  constructor(public first: Outgoing) {}
  get current(): Outgoing { return this.edits.at(-1) ?? this.first; }
  async edit(m: Outgoing): Promise<void> { this.edits.push(m); }
}

class FakeThread implements ThreadPort {
  sent: FakePosted[] = [];
  constructor(public id: string, public name: string) {}
  async send(m: Outgoing): Promise<FakePosted> { const p = new FakePosted(m); this.sent.push(p); return p; }
  texts(): string[] { return this.sent.map((p) => text(p.current)); }
}

const threads = new Map<string, FakeThread>();

// A message in the Allevia channel, or (with `thread`) in a thread under it.
function message(o: Partial<Omit<MessagePort, "thread">> & { content: string; thread?: FakeThread }): MessagePort & { started: FakeThread[]; replies: string[] } {
  const { thread, ...rest } = o;
  const started: FakeThread[] = [];
  const replies: string[] = [];
  return {
    id: nextId(), guildId: GUILD, channelId: thread?.id ?? CHANNEL, threadParentId: thread ? CHANNEL : null,
    authorId: OWNER, authorIsBot: false, authorIsOwner: true, system: false,
    thread: () => thread ?? null,
    async startThread(name) { const t = new FakeThread(nextId(), name); threads.set(t.id, t); started.push(t); return t; },
    async reply(m) { replies.push(text(m)); },
    started, replies,
    ...rest,
  };
}

interface FakeCommand extends CommandPort { responses: Array<{ m: Outgoing; ephemeral: boolean }>; followUps: FakePosted[]; created: FakeThread[] }
function command(o: Partial<CommandPort> & { command: string }): FakeCommand {
  const c: FakeCommand = {
    guildId: GUILD, channelId: CHANNEL, threadParentId: null, userId: OWNER, isOwner: true,
    responses: [], followUps: [], created: [],
    async defer() {},
    async respond(m, opts) { c.responses.push({ m, ephemeral: !!opts?.ephemeral }); },
    async followUp(m) { const p = new FakePosted(m); c.followUps.push(p); return p; },
    thread: () => null,
    async createThread(name) { const t = new FakeThread(nextId(), name); threads.set(t.id, t); c.created.push(t); return t; },
    ...o,
  };
  return c;
}

interface FakeButton extends ButtonPort { replies: Array<{ text: string; ephemeral: boolean }>; updates: Outgoing[] }
function button(customId: string, o: Partial<ButtonPort> = {}): FakeButton {
  const b: FakeButton = {
    customId, guildId: GUILD, userId: OWNER, isOwner: true, replies: [], updates: [],
    async reply(t, opts) { b.replies.push({ text: t, ephemeral: !!opts?.ephemeral }); },
    async update(m) { b.updates.push(m); },
    ...o,
  };
  return b;
}

// ---------- the harness ----------

let g: GraphHandle;
let cleanup: () => Promise<void>;
let calls: AskInput[] = [];
let decided: string[] = [];

async function makeBot(over: Partial<BotDeps> = {}): Promise<AlleviaBot> {
  const deps = await createAskDeps({ tenant: "mini" }, { graph: g, runtime: new FakeRuntime(SCRIPTS), embedQuery: async (t) => fakeEmbed(t) });
  let clock = SEED_NOW + 3_600_000;
  return new AlleviaBot({
    tenant: "mini", guildId: GUILD, channelId: CHANNEL, webBase: "http://127.0.0.1:8787", graph: g,
    ask: async (input: AskInput, emit: (e: AgentEvent) => void): Promise<AskResult> => {
      calls.push(input);
      return ask(input, { ...deps, now: () => (clock += 60_000) }, emit);
    },
    onDecision: (_tenant, a) => { decided.push(`${a.id}:${a.status}`); },
    workLogIntervalMs: 0,
    now: () => SEED_NOW + 3_600_000,
    log: () => {},
    ...over,
  });
}

beforeAll(async () => {
  ({ g, cleanup } = await seededGraph());
  await ensureRoster(g, { businessId: "business:aamdani" }, SEED_NOW);
});
afterAll(async () => { await cleanup?.(); });
beforeEach(() => { calls = []; decided = []; });

describe("threads and sessions", () => {
  it("a message in the channel opens a thread named after it, works there, and answers with labels, badges and the path link", async () => {
    const bot = await makeBot();
    const m = message({ content: QUESTION });
    await bot.onMessage(m);
    expect(m.started).toHaveLength(1);
    const t = m.started[0]!;
    expect(t.name).toBe(QUESTION);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.channel).toBe("discord");
    expect(calls[0]!.asker).toBe("person:founder");
    const sessionId = calls[0]!.sessionId!;
    expect(sessionId).toMatch(/^session:/);

    const [log, ...answer] = t.sent;
    expect(text(log!.current)).toMatch(/^\*\*Work log\*\* · done in/);
    expect(log!.edits.length).toBeGreaterThan(0);
    expect(text(log!.current)).toContain("Sara · done");
    const body = answer.map((p) => text(p.current)).join("\n");
    expect(body).toContain("We paused daily stories on 20 Sep 2026 `Pause daily stories`");
    expect(body).not.toContain("[[");
    expect(body).toMatch(/✅ sources verified|⚠️/);
    expect(body).toContain(`Path view: <http://127.0.0.1:8787/ask/${sessionId}?tenant=mini>`);
    for (const p of t.sent) expect(text(p.current).length).toBeLessThanOrEqual(2000);

    expect(await findThreadSession(g, t.id)).toBe(sessionId);
    const [s] = await g.roQuery<{ ch: string; tid: string }>("MATCH (s:Session {id:$id}) RETURN s.channel AS ch, s.discordThreadId AS tid", { id: sessionId });
    expect(s).toEqual({ ch: "discord", tid: t.id });
  });

  it("a reply in the thread continues the same session, also after the bot restarts; a new message starts a new one", async () => {
    const bot = await makeBot();
    const first = message({ content: QUESTION });
    await bot.onMessage(first);
    const t = first.started[0]!;
    await bot.onMessage(message({ content: "And what did that change?", thread: t }));
    const restarted = await makeBot();
    await restarted.onMessage(message({ content: "Who decided it?", thread: t }));
    const [a, b, c] = calls;
    expect(b!.sessionId).toBe(a!.sessionId);
    expect(c!.sessionId).toBe(a!.sessionId);
    const turns = await g.roQuery<{ n: number }>("MATCH (:Turn)-[:IN_SESSION]->(s:Session {id:$id}) RETURN count(*) AS n", { id: a!.sessionId });
    expect(turns[0]!.n).toBe(3);

    const other = message({ content: "What breaks if the Instagram token expires?" });
    await restarted.onMessage(other);
    expect(calls[3]!.sessionId).not.toBe(a!.sessionId);
    expect(other.started[0]!.id).not.toBe(t.id);
  });

  it("someone other than the owner asks as a generic member, never under their Discord name", async () => {
    const bot = await makeBot();
    await bot.onMessage(message({ content: QUESTION, authorId: MEMBER, authorIsOwner: false }));
    expect(calls[0]!.asker).toBe("person:discord-member");
  });
});

describe("scope: the demo server's channel only", () => {
  it("ignores other servers, other channels, threads elsewhere, bots, system messages and empty text", async () => {
    const bot = await makeBot();
    const elsewhere = new FakeThread(nextId(), "elsewhere");
    const ignored = [
      message({ content: QUESTION, guildId: "999999999999999999" }),
      message({ content: QUESTION, guildId: null }),
      message({ content: QUESTION, channelId: OTHER_CHANNEL }),
      message({ content: QUESTION, thread: elsewhere, threadParentId: OTHER_CHANNEL }),
      message({ content: QUESTION, authorIsBot: true }),
      message({ content: QUESTION, system: true }),
      message({ content: "   " }),
    ];
    for (const m of ignored) await bot.onMessage(m);
    expect(calls).toHaveLength(0);
    for (const m of ignored) { expect(m.started).toHaveLength(0); expect(m.replies).toHaveLength(0); }
    expect(elsewhere.sent).toHaveLength(0);
  });

  it("slash commands from another server are turned away politely, and /ask only works in the channel", async () => {
    const bot = await makeBot();
    const foreign = command({ command: "brief", guildId: "999999999999999999" });
    await bot.onCommand(foreign);
    expect(foreign.responses[0]).toMatchObject({ ephemeral: true });
    expect(text(foreign.responses[0]!.m)).toMatch(/demo server/);
    const wrongChannel = command({ command: "ask", question: QUESTION, channelId: OTHER_CHANNEL });
    await bot.onCommand(wrongChannel);
    expect(text(wrongChannel.responses[0]!.m)).toContain(`<#${CHANNEL}>`);
    expect(calls).toHaveLength(0);
  });
});

describe("slash commands", () => {
  it("/ask opens a thread in the channel and answers there; inside a thread it continues that thread", async () => {
    const bot = await makeBot();
    const c = command({ command: "ask", question: QUESTION });
    await bot.onCommand(c);
    expect(c.created).toHaveLength(1);
    const t = c.created[0]!;
    expect(text(c.responses[0]!.m)).toContain(`<#${t.id}>`);
    expect(t.texts()[0]).toContain(QUESTION);
    expect(t.texts().some((s) => s.includes("Path view"))).toBe(true);

    const again = command({ command: "ask", question: "Who decided it?", channelId: t.id, threadParentId: CHANNEL, thread: () => t });
    await bot.onCommand(again);
    expect(calls[1]!.sessionId).toBe(calls[0]!.sessionId);
    expect(again.created).toHaveLength(0);
  });

  it("/brief says when there is none yet, then shows the latest brief", async () => {
    const bot = await makeBot();
    const none = command({ command: "brief" });
    await bot.onCommand(none);
    expect(text(none.responses[0]!.m)).toMatch(/No morning brief yet/);
    await upsertNode(g, { type: "Document", id: "document:brief-2026-10-15", name: "Morning brief, 15 Oct", props: { kind: "brief", title: "Morning brief, 15 Oct", text: "Signups held steady.\n\n" + "More detail. ".repeat(200) }, asOf: "2026-10-15" }, SEED_NOW);
    const some = command({ command: "brief" });
    await bot.onCommand(some);
    const all = [text(some.responses[0]!.m), ...some.followUps.map((p) => text(p.first))];
    expect(all[0]).toContain("Morning brief, 15 Oct");
    expect(all.join("\n")).toContain("Signups held steady.");
    for (const p of all) expect(p.length).toBeLessThanOrEqual(2000);
  });
});

describe("/approvals and the buttons", () => {
  const card = (id: string, title: string) => upsertNode(g, {
    type: "Approval", id, name: `github_issue: ${title}`,
    props: { status: "pending", kind: "github_issue", title, payload: JSON.stringify({ title, body: "Fix it.", repo: "Ankit-Vohra/allevia" }) },
  }, SEED_NOW);

  beforeAll(async () => {
    await card("approval:t-090-1", "Fix sitemap errors");
    await card("approval:t-090-2", "Add alt text");
  });

  const status = async (id: string) => (await g.roQuery<{ s: string }>("MATCH (a:Approval {id:$id}) RETURN a.status AS s", { id }))[0]?.s;

  it("lists each pending approval as a card with Approve and Reject buttons", async () => {
    const bot = await makeBot();
    const c = command({ command: "approvals" });
    await bot.onCommand(c);
    expect(text(c.responses[0]!.m)).toMatch(/pending/);
    const cards = c.followUps.map((p) => p.first).filter((m): m is Exclude<Outgoing, string> => typeof m !== "string");
    const ids = cards.flatMap((m) => m.buttons ?? []).map((b) => b.customId);
    expect(ids).toEqual(expect.arrayContaining([
      "allevia:approve:approval:t-090-1", "allevia:reject:approval:t-090-1", "allevia:approve:approval:t-090-2", "allevia:reject:approval:t-090-2",
    ]));
    expect(cards.find((m) => m.content.includes("Fix sitemap errors"))!.content).toContain("Fix it.");
  });

  it("only the server owner may press them: anyone else is told so and nothing changes", async () => {
    const bot = await makeBot();
    const b = button("allevia:approve:approval:t-090-1", { userId: MEMBER, isOwner: false });
    await bot.onButton(b);
    expect(b.replies).toEqual([{ text: expect.stringMatching(/Only the server owner/), ephemeral: true }]);
    expect(b.updates).toHaveLength(0);
    expect(await status("approval:t-090-1")).toBe("pending");
    expect(decided).toEqual([]);
    const foreign = button("allevia:approve:approval:t-090-1", { guildId: "999999999999999999" });
    await bot.onButton(foreign);
    expect(await status("approval:t-090-1")).toBe("pending");
  });

  it("the owner's press goes through the same decision as the API (and its onDecision hook); a second press changes nothing", async () => {
    const bot = await makeBot();
    const ok = button("allevia:approve:approval:t-090-1");
    await bot.onButton(ok);
    expect(await status("approval:t-090-1")).toBe("approved");
    expect(decided).toEqual(["approval:t-090-1:approved"]);
    const updated = ok.updates[0]!;
    expect(typeof updated !== "string" && updated.buttons?.length).toBeFalsy();
    expect(text(updated)).toMatch(/Approved/);

    const no = button("allevia:reject:approval:t-090-2");
    await bot.onButton(no);
    expect(await status("approval:t-090-2")).toBe("rejected");

    const twice = button("allevia:reject:approval:t-090-1");
    await bot.onButton(twice);
    expect(await status("approval:t-090-1")).toBe("approved");
    expect(twice.replies[0]).toMatchObject({ ephemeral: true, text: expect.stringMatching(/already decided/i) });

    const gone = button("allevia:approve:approval:nope");
    await bot.onButton(gone);
    expect(gone.replies[0]).toMatchObject({ ephemeral: true, text: expect.stringMatching(/no longer exists/i) });
  });
});
