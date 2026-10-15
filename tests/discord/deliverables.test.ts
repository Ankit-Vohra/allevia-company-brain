// What the team makes comes back in the Discord thread: each option as a real file with its check and Approve / Change
// buttons (a held option has none), a plain closing line that nothing is posted, and Approve there is the same decision as
// the web's (a draft post that uses that option). Change tells the owner to reply in the thread.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { AgentEvent } from "../../shared/contracts.js";
import { ensureRoster } from "../../src/agent/memory.js";
import type { AskResult } from "../../src/agent/ask.js";
import { AlleviaBot, type ButtonPort, type MessagePort, type Outgoing, type PostedPort, type ThreadPort } from "../../src/discord/bot.js";
import { StudioDiscord, StudioGate, studioButtonId } from "../../src/discord/studio-bot.js";
import { loadAssetFile } from "../../src/creative/files.js";
import { makePoster } from "../../src/creative/poster.js";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { FakeEngine } from "../../src/studio/engine.js";
import { AssetStore } from "../../src/studio/store.js";
import { FakeVision } from "../../src/studio/vision.js";
import { testGraph } from "../helpers/graph.js";
import { snowflake } from "../helpers/hub-fakes.js";
import { BIZ, FakeCreativeEngine, NOW, nishaReads, seedKit, TENANT } from "../creative/helpers.js";

const text = (m: Outgoing): string => (typeof m === "string" ? m : m.content);
const ALL_OK = { citationsValid: true, invalidCitations: [], numbersGrounded: true, ungroundedNumbers: [], simulatedDisclosed: true, freshnessDisclosed: true };

class FakePosted implements PostedPort {
  id = snowflake();
  edits: Outgoing[] = [];
  constructor(public first: Outgoing) {}
  async edit(m: Outgoing) { this.edits.push(m); }
  get now(): Outgoing { return this.edits.at(-1) ?? this.first; }
}
class FakeThread implements ThreadPort {
  sent: FakePosted[] = [];
  constructor(public id: string, public name: string) {}
  async send(m: Outgoing) { const p = new FakePosted(m); this.sent.push(p); return p; }
}

describe("deliverables on Discord", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  let dir: string;
  let store: AssetStore;
  let thread: FakeThread;
  let approvalId = "";
  let options: Array<{ assetId: string; label: string }> = [];

  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    dir = mkdtempSync(join(tmpdir(), "allevia-discord-made-"));
    store = new AssetStore(dir);
    await seedKit(g, store);
    await ensureRoster(g, { businessId: BIZ }, NOW);
  }, 60_000);
  afterAll(async () => { await cleanup(); await closeAll(); rmSync(dir, { recursive: true, force: true }); });

  it("posts each option as a file with Approve and Change, holds back a failed one, and says nothing was posted", async () => {
    const engine = new FakeCreativeEngine();
    const bot = new AlleviaBot({
      tenant: TENANT, guildId: "g", channelId: "c", webBase: "https://allevia.test", graph: g, log: () => {}, workLogIntervalMs: 0,
      deliverables: { file: (id) => loadAssetFile(g, store, TENANT, id) },
      ask: async (input, emit): Promise<AskResult> => {
        const r = await makePoster(g, {
          tenant: TENANT, businessId: BIZ, agentId: "chief-of-staff", turnId: "t-discord", now: NOW + 1000, question: input.question,
          content: { headline: "A festival of light", offer: "20% off" }, format: "insta_portrait", occasion: "offer", count: 2, scenes: ["warm lamps", "a brass diya"], artwork: "generate",
        }, { store, vision: new FakeVision({ "fact-checker": nishaReads({ B: { garbled: true } }) }), engine, maxCreditsPerRequest: 10, spent: { credits: 0 } });
        const ev: AgentEvent = { type: "deliverable", agent: "chief-of-staff", kind: "poster", title: r.saved.title, approvalId: r.saved.approvalId, recommended: r.saved.recommended, options: r.saved.options, notes: r.notes };
        emit(ev);
        const answer = "I made two options. They are waiting for your OK.";
        emit({ type: "text", agent: "chief-of-staff", delta: answer });
        return { ok: true, turnId: "turn:x", sessionId: input.sessionId ?? "s", answer, citations: [], checks: ALL_OK, agents: ["chief-of-staff"], ms: 1 };
      },
    });
    thread = new FakeThread(snowflake(), "poster");
    const m: MessagePort = {
      id: snowflake(), guildId: "g", channelId: "c", threadParentId: null, authorId: "u", authorIsBot: false, authorIsOwner: true, system: false,
      content: "I want a poster for the Diwali sale, 20% off, for Insta with my logo", thread: () => null, async startThread() { return thread; }, async reply() {},
    };
    await bot.onMessage(m);
    const optionPosts = thread.sent.filter((p) => typeof p.first !== "string" && p.first.files?.length);
    expect(optionPosts).toHaveLength(2);
    for (const p of optionPosts) {
      const f = p.first as Exclude<Outgoing, string>;
      const meta = await sharp(f.files![0]!.data).metadata();
      expect({ w: meta.width, h: meta.height, kind: meta.format }).toEqual({ w: 1080, h: 1350, kind: "jpeg" });
    }
    const [a, b] = optionPosts.map((p) => p.first as Exclude<Outgoing, string>) as [Exclude<Outgoing, string>, Exclude<Outgoing, string>];
    expect(a.content).toMatch(/Option A.*our pick/);
    expect(a.content).toMatch(/Checked:/);
    approvalId = a.buttons![0]!.customId.replace(/^allevia:studio:approve:/, "").replace(/:A$/, "");
    expect(a.buttons!.map((x) => x.label)).toEqual(["Approve", "Change"]);
    expect(a.buttons!.every((x) => x.customId.length <= 100)).toBe(true);
    expect(b.content).toMatch(/Held back:.*garbled/);
    expect(b.buttons).toEqual([]); // a held option can't be approved
    const last = text(thread.sent.at(-1)!.first);
    expect(last).toMatch(/nothing is posted anywhere/);
    expect(last).toMatch(/reply here/);
    options = [{ assetId: "", label: "A" }];
  }, 60_000);

  it("Approve on the option is the web's own decision: a draft post that uses that poster", async () => {
    const studio = new StudioDiscord({
      tenant: TENANT, businessId: BIZ, graph: g, gate: new StudioGate(), log: () => {}, now: (() => { let t = NOW + 100_000; return () => (t += 1000); })(),
      ffmpeg: { available: async () => false, firstFrame: async () => null, stripMetadata: async (b) => b }, actions: { config: { dataDir: dir } },
      studio: { store, vision: new FakeVision({}), engine: new FakeEngine(async (i) => i.image) },
    });
    const updates: Outgoing[] = [];
    const replies: string[] = [];
    const press = (id: string): ButtonPort => ({ customId: id, guildId: "g", userId: "u", isOwner: true, async reply(t) { replies.push(t); }, async update(m) { updates.push(m); } });
    // Change tells how to ask for a change
    expect(await studio.onButton(press(studioButtonId("change", approvalId, "A")))).toBe(true);
    expect(replies.at(-1)).toMatch(/make the headline shorter/);
    expect(await studio.onButton(press(studioButtonId("approve", approvalId, "A")))).toBe(true);
    expect(text(updates.at(-1)!)).toMatch(/You approved option A.*saved as a draft post.*Nothing has been published/s);
    const [row] = await g.roQuery<{ id: string; made: string }>("MATCH (c:Content)-[:USES_ASSET]->(a:Asset {kind:'poster', label:'A'}) RETURN a.id AS id, c.madeAs AS made");
    expect(row!.made).toBe("poster");
    options = [{ assetId: row!.id, label: "A" }];
    // the held option cannot be approved from a button that was never offered, or by hand
    replies.length = 0;
    await studio.onButton(press(studioButtonId("approve", approvalId, "B")));
    expect(replies.at(-1)).toMatch(/already decided|held/);
  }, 60_000);

  it("loadAssetFile reads only the business's own file", async () => {
    const f = await loadAssetFile(g, store, TENANT, options[0]!.assetId);
    expect(f!.mime).toBe("image/jpeg");
    expect(await loadAssetFile(g, store, "another_tenant", options[0]!.assetId)).toBeNull();
    expect(await loadAssetFile(g, store, TENANT, "asset:nope")).toBeNull();
  });
});
