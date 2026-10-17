// A change asked for on a photo's card in Chat (or in the Library): POST /api/:t/chat/photo/change runs the Studio's own change path
// (server/studio.ts changeStudioOption, the one POST /studio/revise runs) and its clip service, as a turn in the photo's thread, with
// the new option as a card the chat shows and the Library lists. On the test FalkorDB (6391) with the Studio's fakes (no model, no
// Higgsfield).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { AgentEvent, LibraryDto } from "../../shared/contracts.js";
import type { StudioWiring } from "../../src/server/studio.js";
import { changeQuestion } from "../../src/server/routes/chat-photo.js";
import { FakeEngine } from "../../src/studio/engine.js";
import { AssetStore } from "../../src/studio/store.js";
import { FakeVision } from "../../src/studio/vision.js";
import { facadePhoto, TARA_ANSWER } from "../studio/fixtures.js";
import { harness, post, sseEvents, type Harness } from "./harness.js";

type Made = Extract<AgentEvent, { type: "deliverable" }>;
type Session = Extract<AgentEvent, { type: "session" }>;
type Final = Extract<AgentEvent, { type: "final" }>;

describe("server: a change to a photo's card from Chat (integration)", () => {
  let h: Harness;
  let dir: string;
  let wiring: StudioWiring;
  let engineCalls = 0;
  beforeAll(async () => {
    h = await harness();
    dir = mkdtempSync(join(tmpdir(), "allevia-chat-change-"));
    wiring = {
      deps: {
        store: new AssetStore(dir),
        vision: new FakeVision({ "content-strategist": TARA_ANSWER, "fact-checker": ((input: { images: Array<{ label: string }> }) => ({ variants: input.images.filter((i) => !["original", "frame"].includes(i.label)).map((i) => ({ label: i.label, sameBuilding: true, structuralChange: false, added: [], removed: [], note: "nothing added" })) })) as never }),
        engine: new FakeEngine(async (input) => { engineCalls++; return sharp(input.image).modulate({ brightness: 1.3 }).jpeg().toBuffer(); }),
      },
    };
  }, 90_000);
  afterAll(async () => {
    await h.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  const sendPhoto = async (app: ReturnType<Harness["make"]>, note: string) => {
    const form = new FormData();
    form.append("photo", new File([new Uint8Array(await facadePhoto({ tilt: 2 }))], "phone.jpg", { type: "image/jpeg" }));
    form.append("note", note);
    return sseEvents(await (await app.request("/api/mini/chat/photo", { method: "POST", body: form })).text());
  };
  const change = (app: ReturnType<Harness["make"]>, body: unknown) => post(app, "/api/mini/chat/photo/change", body);

  it("the owner's words reach the Studio's change path; the new option comes back as a card in the same thread and in the Library", async () => {
    const app = h.make({ studio: async () => wiring });
    const first = await sendPhoto(app, "a post from the front");
    const session = first[0] as Session;
    const card = first.find((e): e is Made => e.type === "deliverable")!;
    expect(card.studio).toBe(true);
    const a = card.options[0]!;

    // free light and colour: the Studio's local adjust (no engine call), in the thread the chat names
    const calls = engineCalls;
    const res = await change(app, { approvalId: card.approvalId, variantId: a.assetId, instruction: "make it warmer", sessionId: session.sessionId });
    expect(res.status).toBe(200);
    const warm = sseEvents(await res.text());
    expect(warm[0]).toMatchObject({ type: "session", sessionId: session.sessionId, question: `Change option ${a.label}: make it warmer` });
    expect(warm.some((e) => e.type === "agent_start" && e.task === "Make the change you asked for")).toBe(true); // the Studio's change path
    const made = warm.find((e): e is Made => e.type === "deliverable")!;
    expect(made).toMatchObject({ approvalId: card.approvalId, studio: true, kind: "image" });
    expect(made.options).toHaveLength(1);
    expect(made.options[0]!.label).toBe("C");
    expect((warm.at(-1) as Final).answer).toMatch(/free, made with the team's own light and colour tools/);
    expect(engineCalls).toBe(calls);

    // the card on the photo's card now has the new option, the thread has both turns, and the Library lists it
    const [row] = await h.g.roQuery<{ p: string }>("MATCH (a:Approval {id:$id}) RETURN a.payload AS p", { id: card.approvalId });
    expect((JSON.parse(row!.p) as { studio: { variants: Array<{ id: string }> } }).studio.variants.map((v) => v.id)).toContain(made.options[0]!.assetId);
    const thread = await (await app.request(`/api/mini/sessions/${encodeURIComponent(session.sessionId)}`)).json() as { turns: Array<{ question: string }> };
    expect(thread.turns.map((t) => t.question).sort()).toEqual([`Change option ${a.label}: make it warmer`, "a post from the front"]);
    const lib = await (await app.request("/api/mini/library")).json() as LibraryDto;
    expect(lib.items.find((i) => i.id === made.options[0]!.assetId)).toMatchObject({ state: "waiting", approvalId: card.approvalId });

    // from the Library (no session): the change joins the thread the photo was sent in; the AI editor runs (quoted, capped)
    const festive = sseEvents(await (await change(app, { approvalId: card.approvalId, instruction: "make it festive for Diwali" })).text());
    expect(festive[0]).toMatchObject({ type: "session", sessionId: session.sessionId, question: "make it festive for Diwali" });
    expect(festive.find((e): e is Made => e.type === "deliverable")?.options[0]?.aiEdited).toBe(true);
    expect(engineCalls).toBeGreaterThan(calls);
    expect((festive.at(-1) as Final).answer).toMatch(/is ready and Fact Checker checked it/);
  }, 120_000);

  it("a clip the owner said yes to is made by the Studio's clip service and comes back as a clip card; the rules still hold", async () => {
    const asks: Array<{ variantId?: string }> = [];
    const clip = {
      offer: async () => ({ ok: true as const, message: "A clip would use about 7.5 Studio credits.", label: "A", variantId: "v", credits: 7.5, words: "about 7.5 Studio credits" }),
      make: async (r: { variantId?: string }) => { asks.push(r); return { ok: true as const, message: "Here is your 5 second clip.", video: Buffer.from("x"), assetId: "asset:clip-chat", credits: 7.5, jobId: "j" }; },
    };
    const app = h.make({ studio: async () => ({ ...wiring, clip }) });
    const first = await sendPhoto(app, "clip me");
    const card = first.find((e): e is Made => e.type === "deliverable")!;
    const a = card.options[0]!;
    const events = sseEvents(await (await change(app, { approvalId: card.approvalId, variantId: a.assetId, clip: true })).text());
    expect(events[0]).toMatchObject({ type: "session", question: `Make a 5 second clip from option ${a.label}` });
    expect(asks).toEqual([expect.objectContaining({ approvalId: card.approvalId, variantId: a.assetId })]);
    const made = events.find((e): e is Made => e.type === "deliverable")!;
    expect(made).toMatchObject({ kind: "clip", studio: true, credits: 7.5, options: [{ assetId: "asset:clip-chat", label: "Clip" }] });

    // nothing to change, no card, public mode, no Studio, no clips: refused before anything runs
    expect((await change(app, { approvalId: card.approvalId })).status).toBe(400);
    expect((await change(app, { instruction: "warmer" })).status).toBe(400);
    expect((await change(h.make({ studio: async () => wiring, publicMode: true }), { approvalId: card.approvalId, instruction: "warmer" })).status).toBe(403);
    expect((await change(h.make(), { approvalId: card.approvalId, instruction: "warmer" })).status).toBe(501);
    expect((await change(h.make({ studio: async () => wiring }), { approvalId: card.approvalId, clip: true })).status).toBe(501);
    expect(asks).toHaveLength(1);
  }, 120_000);

  it("the words a change shows in the thread", () => {
    expect(changeQuestion({ instruction: "make it warmer", label: "B" })).toBe("Change option B: make it warmer");
    expect(changeQuestion({ instruction: "make it warmer" })).toBe("make it warmer");
    expect(changeQuestion({ clip: true, label: "A" })).toBe("Make a 5 second clip from option A");
    expect(changeQuestion({ retryOf: "B" })).toBe("Try option B again");
  });
});
