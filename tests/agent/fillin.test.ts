// "Fill it in": the writer's clearly marked suggestions are accepted with one reply, on Discord and the web, in code.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentEvent } from "../../shared/contracts.js";
import { ask } from "../../src/agent/ask.js";
import { fillIn, gapsIn, hasGaps, isFillItIn } from "../../src/agent/fillin.js";
import { FakeRuntime, type FakeScript } from "../../src/agent/runtime.js";
import { createAskDeps } from "../../src/agent/wiring.js";
import { AlleviaBot, type MessagePort, type Outgoing, type PostedPort, type ThreadPort } from "../../src/discord/bot.js";
import { fakeEmbed, SEED_NOW } from "../fixtures/seed-graph.js";
import { harness, post, SCRIPTS, sseEvents, type Harness } from "../server/harness.js";

const DRAFT = [
  "Here are your two posts, ready to use.",
  "",
  "> **Sun 18 Oct: Anantam Villa**",
  "> Some homes you feel the moment you step in. Anantam Villa is in Raipur [[decision:007-pause-daily-stories]]. [suggested: Come and see how the light moves through the rooms in the afternoon.]",
  "",
  "> **Tue 20 Oct: The studio**",
  "> We design homes that feel calm. [suggested: Every project starts with a long conversation about how you live.] The price starts at [you tell us: your starting price].",
].join("\n");

describe("isFillItIn", () => {
  it("the ways an owner says yes to the suggestions", () => {
    for (const t of ["fill it in", "Fill it in", "fill it in please", "ok fill it in", "Yes, fill them in", "fill in the gaps", "fill all in", "use your suggestions", "accept the suggestions", "go ahead and fill it in", "fill them all in!"]) expect(isFillItIn(t), t).toBe(true);
  });
  it("and what is not that", () => {
    for (const t of ["fill the form in tomorrow", "how do I fill a tax return", "What's waiting on me this week?", "", "fill it in with something about our new menu and prices and the offer for Diwali week please"]) expect(isFillItIn(t), t).toBe(false);
  });
});

describe("fillIn (pure)", () => {
  it("replaces every suggestion with its words, keeps the hard gaps open and lists them", () => {
    const r = fillIn(DRAFT, "fill it in")!;
    expect(r.filled).toBe(2);
    expect(r.open).toEqual(["your starting price"]);
    expect(r.answer).toMatch(/^Done: I wrote my suggestions into your copy\./);
    expect(r.answer).toContain("Come and see how the light moves through the rooms in the afternoon.");
    expect(r.answer).toContain("Every project starts with a long conversation about how you live.");
    expect(r.answer).not.toContain("[suggested:");
    expect(r.answer).toContain("[you tell us: your starting price]");
    expect(r.answer).toMatch(/Still for you[^\n]*\n- your starting price/);
    expect(r.answer).toContain("[[decision:007-pause-daily-stories]]"); // the sources stay
  });
  it("a draft with nothing to fill in, or only hard gaps", () => {
    expect(fillIn("All done, nothing missing.", "fill it in")).toBeNull();
    const only = fillIn("Price: [you tell us: the price]", "fill it in")!;
    expect(only.filled).toBe(0);
    expect(only.answer).toMatch(/nothing I can suggest/);
  });
  it("the words around it follow the owner's language", () => {
    expect(fillIn(DRAFT, "सब भर दो")!.answer).toMatch(/^हो गया:/);
    expect(fillIn(DRAFT, "isko bhar do aur batao kaam kaise hoga")!.answer).toMatch(/^Ho gaya:/);
  });
  it("finds the markers", () => {
    expect(hasGaps(DRAFT)).toBe(true);
    expect(hasGaps("nothing here")).toBe(false);
    expect(gapsIn(DRAFT)).toEqual({ suggested: ["Come and see how the light moves through the rooms in the afternoon.", "Every project starts with a long conversation about how you live."], open: ["your starting price"] });
  });
});

const scripts = (): Record<string, FakeScript> => ({
  ...SCRIPTS,
  "chief-of-staff:synthesis": {
    preText: DRAFT,
    calls: [{ name: "show_path", args: { ids: ["decision:007-pause-daily-stories"] } }],
  },
});

describe("fill it in, in a thread (web and Discord)", () => {
  let h: Harness;
  beforeAll(async () => { h = await harness(); }, 60_000);
  afterAll(async () => { await h.cleanup(); });

  async function deps(runtime: FakeRuntime) {
    const d = await createAskDeps({ tenant: "mini" }, { graph: h.g, runtime, embedQuery: async (t) => fakeEmbed(t) });
    let clock = SEED_NOW + 3_600_000;
    return { ...d, now: () => (clock += 60_000) };
  }

  it("ask(): the second turn accepts the draft's suggestions with no desks running, and its sources check out", async () => {
    const runtime = new FakeRuntime(scripts());
    const d = await deps(runtime);
    const events: AgentEvent[] = [];
    const first = await ask({ tenant: "mini", question: "Write two posts for next week", channel: "web" }, d, (e) => events.push(e));
    expect(first.answer).toContain("[suggested:");
    const runsAfterFirst = runtime.runs.length;
    const second = await ask({ tenant: "mini", question: "Fill it in", sessionId: first.sessionId, channel: "web" }, d, (e) => events.push(e));
    expect(runtime.runs.length).toBe(runsAfterFirst); // nobody was asked anything
    expect(second.ok).toBe(true);
    expect(second.answer).toMatch(/^Done: I wrote my suggestions/);
    expect(second.answer).toContain("Come and see how the light moves");
    expect(second.answer).not.toContain("[suggested:");
    expect(second.checks.citationsValid).toBe(true);
    expect(second.agents).toEqual(["chief-of-staff"]);
    expect(events.filter((e) => e.type === "final")).toHaveLength(2);
    const [row] = await h.g.roQuery<{ a: string; s: string }>("MATCH (t:Turn {id:$id}) RETURN t.answer AS a, t.status AS s", { id: second.turnId });
    expect(row!.s).toBe("ok");
    expect(row!.a).toContain("Every project starts with a long conversation");
  });

  it("with no draft in the thread, or no gaps, 'fill it in' is just a question for the team", async () => {
    const runtime = new FakeRuntime(scripts());
    const d = await deps(runtime);
    const lone = await ask({ tenant: "mini", question: "Fill it in", channel: "web" }, d, () => undefined);
    expect(runtime.runs.length).toBeGreaterThan(0);
    expect(lone.ok).toBe(true);
  });

  it("on the web: POST /ask with the thread's session id", async () => {
    const first = sseEvents(await (await post(h.app, "/api/mini/ask", { question: "Write two posts for next week" })).text()) as AgentEvent[];
    const sessionId = first.find((e): e is Extract<AgentEvent, { type: "session" }> => e.type === "session")!.sessionId;
    // the harness runtime answers with SCRIPTS (no markers), so seed a draft turn the way the writer would have left it
    const runtime = new FakeRuntime(scripts());
    const d = await deps(runtime);
    const seeded = await ask({ tenant: "mini", question: "Write two more posts", sessionId, channel: "web" }, d, () => undefined);
    expect(seeded.answer).toContain("[suggested:");
    const res = sseEvents(await (await post(h.app, "/api/mini/ask", { question: "fill it in", sessionId })).text()) as AgentEvent[];
    const final = res.find((e): e is Extract<AgentEvent, { type: "final" }> => e.type === "final")!;
    expect(final.answer).toMatch(/^Done: I wrote my suggestions/);
    expect(final.answer).not.toContain("[suggested:");
  }, 60_000);

  it("on Discord: a reply in the thread", async () => {
    let seq = 0;
    const nextId = () => String(900000000000000000n + BigInt(++seq));
    const posted: string[] = [];
    class Posted implements PostedPort { id = nextId(); constructor(first: Outgoing) { posted.push(typeof first === "string" ? first : first.content); } async edit(m: Outgoing) { posted.push(typeof m === "string" ? m : m.content); } }
    class Thread implements ThreadPort { constructor(public id: string, public name: string) {} async send(m: Outgoing) { return new Posted(m); } }
    const runtime = new FakeRuntime(scripts());
    const d = await deps(runtime);
    const GUILD = "100000000000000001", CHANNEL = "200000000000000002";
    const bot = new AlleviaBot({
      tenant: "mini", guildId: GUILD, channelId: CHANNEL, webBase: "http://127.0.0.1:8787", graph: h.g,
      ask: (input, emit) => ask(input, d, emit), workLogIntervalMs: 0, now: () => SEED_NOW + 3_600_000, log: () => {},
    });
    const thread = new Thread(nextId(), "posts");
    const msg = (content: string, inThread: boolean): MessagePort => ({
      id: nextId(), guildId: GUILD, channelId: inThread ? thread.id : CHANNEL, threadParentId: inThread ? CHANNEL : null, authorId: "300000000000000004",
      authorIsBot: false, authorIsOwner: true, system: false, content, thread: () => (inThread ? thread : null),
      async startThread() { return thread; }, async reply() {},
    });
    await bot.onMessage(msg("Write two posts for next week", false));
    expect(posted.join("\n")).toContain("[suggested:");
    const runsBefore = runtime.runs.length;
    posted.length = 0;
    await bot.onMessage(msg("fill it in", true));
    expect(runtime.runs.length).toBe(runsBefore);
    const all = posted.join("\n");
    expect(all).toContain("Done: I wrote my suggestions");
    expect(all).toContain("Come and see how the light moves");
  });
});
