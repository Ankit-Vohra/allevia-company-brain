// The Library and a photo sent in the chat (src/server/routes/library.ts, routes/chat-photo.ts): the photo takes the Studio's
// upload path and pipeline as a turn in the conversation, saved in the thread with its options as a card; the Library then lists
// the owner's photo and the options newest first, each with where it stands (waiting for the OK, approved, declined), and follows
// an OK. Read-only, per business, on the test FalkorDB (6391) with the Studio's fakes (no model, no Higgsfield).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { AgentEvent, LibraryDto, LibraryItem } from "../../shared/contracts.js";
import type { StudioWiring } from "../../src/server/studio.js";
import { libraryKind, libraryState } from "../../src/server/routes/library.js";
import { DEFAULT_PHOTO_NOTE } from "../../src/server/routes/chat-photo.js";
import { upsertNode } from "../../src/graph/upsert.js";
import { FakeEngine } from "../../src/studio/engine.js";
import { AssetStore } from "../../src/studio/store.js";
import { FakeVision } from "../../src/studio/vision.js";
import { facadePhoto, TARA_ANSWER } from "../studio/fixtures.js";
import { harness, post, sseEvents, type Harness } from "./harness.js";

describe("server: the Library and a photo sent in the chat (integration)", () => {
  let h: Harness;
  let dir: string;
  let wiring: StudioWiring;
  beforeAll(async () => {
    h = await harness();
    dir = mkdtempSync(join(tmpdir(), "allevia-library-api-"));
    wiring = {
      deps: {
        store: new AssetStore(dir),
        vision: new FakeVision({ "content-strategist": TARA_ANSWER, "fact-checker": ((input: { images: Array<{ label: string }> }) => ({ variants: input.images.filter((i) => !["original", "frame"].includes(i.label)).map((i) => ({ label: i.label, sameBuilding: true, structuralChange: false, added: [], removed: [], note: "nothing added" })) })) as never }),
        engine: new FakeEngine(async (input) => sharp(input.image).modulate({ brightness: 1.3 }).jpeg().toBuffer()),
      },
    };
  }, 90_000);
  afterAll(async () => {
    await h.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  const send = async (app: ReturnType<Harness["make"]>, photo: Buffer | undefined, note: string, extra: Record<string, string> = {}) => {
    const form = new FormData();
    if (photo) form.append("photo", new File([new Uint8Array(photo)], "phone.jpg", { type: "image/jpeg" }));
    form.append("note", note);
    for (const [k, v] of Object.entries(extra)) form.append(k, v);
    return app.request("/api/mini/chat/photo", { method: "POST", body: form });
  };
  const library = async (app: ReturnType<Harness["make"]>) => (await (await app.request("/api/mini/library")).json() as LibraryDto).items;

  it("an empty business has an empty Library", async () => {
    expect(await library(h.make({ studio: async () => wiring }))).toEqual([]);
  });

  it("a photo in the chat runs the Studio as a turn, saved in the thread with its card; the Library lists it and follows the OK", async () => {
    const app = h.make({ studio: async () => wiring });
    const res = await send(app, await facadePhoto({ tilt: 3 }), "make this a Diwali post");
    expect(res.status).toBe(200);
    const events = sseEvents(await res.text());
    // a turn like any other: the session first, the Studio's work, the options as a card, the answer, the final last
    expect(events[0]).toMatchObject({ type: "session", question: "make this a Diwali post" });
    const types = events.map((e) => e.type);
    expect(types.filter((t) => ["asset", "assessment", "review", "proposal", "deliverable", "final"].includes(t)))
      .toEqual(["asset", "assessment", "asset", "asset", "review", "review", "proposal", "deliverable", "final"]);
    expect(types.at(-1)).toBe("final");
    const session = events[0] as Extract<AgentEvent, { type: "session" }>;
    const made = events.find((e): e is Extract<AgentEvent, { type: "deliverable" }> => e.type === "deliverable")!;
    const proposal = events.find((e): e is Extract<AgentEvent, { type: "proposal" }> => e.type === "proposal")!;
    expect(made.approvalId).toBe(proposal.approvalId);
    expect(made.options.map((o) => [o.label, o.badge])).toEqual([["A", "ok"], ["B", "ok"]]);
    const final = events.at(-1) as Extract<AgentEvent, { type: "final" }>;
    expect(final.turnId).toBe(session.turnId);
    expect(final.answer.length).toBeGreaterThan(0);

    // saved in the conversation: the thread has the turn, and its work log replays the card
    const thread = await (await app.request(`/api/mini/sessions/${encodeURIComponent(session.sessionId)}`)).json() as { turns: Array<{ id: string; question: string }> };
    expect(thread.turns.map((t) => t.question)).toEqual(["make this a Diwali post"]);
    const [turn] = await h.g.roQuery<{ events: string; source: string }>("MATCH (t:Turn {id:$id}) RETURN t.events AS events, t.source AS source", { id: session.turnId });
    expect(turn!.source).toBe("web");
    expect(JSON.parse(turn!.events).some((e: AgentEvent) => e.type === "deliverable")).toBe(true);

    // the Library: the two options waiting for the OK, then the owner's photo (newest first by when it was made)
    const before = await library(app);
    const original = events.find((e): e is Extract<AgentEvent, { type: "asset" }> => e.type === "asset" && e.kind === "original")!;
    const byId = new Map(before.map((i) => [i.id, i]));
    expect(byId.get(original.assetId)).toMatchObject({ kind: "your-photo", mine: true, state: null, media: "image" });
    const [a, b] = made.options.map((o) => byId.get(o.assetId)!) as [LibraryItem, LibraryItem];
    expect(a).toMatchObject({ kind: "picture", mine: false, state: "waiting", approvalId: proposal.approvalId, label: "A", check: "ok", credits: null });
    expect(b).toMatchObject({ state: "waiting", label: "B" });
    expect(a.url).toBe(`/api/mini/assets/${encodeURIComponent(a.id)}`);
    expect(a.thumb).toBe(`/api/mini/assets/${encodeURIComponent(a.id)}?w=480`);
    expect(before.map((i) => i.at)).toEqual([...before.map((i) => i.at)].sort((x, y) => y - x));
    expect((await app.request(a.thumb)).status).toBe(200);

    // OK on option B: B approved, A declined
    expect((await post(app, "/api/mini/studio/approve", { approvalId: proposal.approvalId, variantId: b.id })).status).toBe(200);
    const after = new Map((await library(app)).map((i) => [i.id, i]));
    expect(after.get(b.id)!.state).toBe("approved");
    expect(after.get(a.id)!.state).toBe("declined");
  }, 90_000);

  it("continues a conversation, says what a photo with no words is for, and refuses what it should", async () => {
    const app = h.make({ studio: async () => wiring });
    const first = sseEvents(await (await send(app, await facadePhoto({ tilt: -1 }), "")).text());
    const s = first[0] as Extract<AgentEvent, { type: "session" }>;
    expect(s.question).toBe(DEFAULT_PHOTO_NOTE);
    const again = sseEvents(await (await send(app, await facadePhoto({ tilt: 1.5 }), "another one", { sessionId: s.sessionId, target: "content-strategist" })).text());
    expect((again[0] as Extract<AgentEvent, { type: "session" }>).sessionId).toBe(s.sessionId);
    const thread = await (await app.request(`/api/mini/sessions/${encodeURIComponent(s.sessionId)}`)).json() as { turns: unknown[] };
    expect(thread.turns).toHaveLength(2);

    expect((await send(app, undefined, "no photo")).status).toBe(400);
    expect((await send(app, await facadePhoto(), "x", { target: "nobody" })).status).toBe(400);
    expect((await send(h.make({ studio: async () => wiring, publicMode: true }), await facadePhoto(), "x")).status).toBe(403);
    expect((await send(h.make(), await facadePhoto(), "x")).status).toBe(501);
    expect((await h.make({ studio: async () => wiring }).request("/api/other/library")).status).toBe(404);
    // an asset whose file is not kept here is left out (an empty frame helps nobody)
    await upsertNode(h.g, { type: "Asset", id: "asset:elsewhere", name: "Made on another machine", props: { kind: "poster", mediaType: "image", storageKey: "ab/abcdef0123456789.jpg", status: "proposed" } });
    expect((await library(app)).some((i) => i.id === "asset:elsewhere")).toBe(false);
  }, 90_000);
});

describe("the Library's words for what a thing is and where it stands", () => {
  it("names the kind from the asset", () => {
    expect(libraryKind({ kind: "original", mediaType: "image", mime: "image/jpeg", step: null, headline: null })).toBe("your-photo");
    expect(libraryKind({ kind: "original", mediaType: "video", mime: "video/mp4", step: null, headline: null })).toBe("your-video");
    expect(libraryKind({ kind: "final", mediaType: "video", mime: "video/mp4", step: "clip", headline: null })).toBe("clip");
    expect(libraryKind({ kind: "poster", mediaType: "image", mime: "image/png", step: null, headline: null })).toBe("poster");
    expect(libraryKind({ kind: "variant", mediaType: "image", mime: "image/jpeg", step: "premium-ad", headline: null })).toBe("product-shoot");
    expect(libraryKind({ kind: "variant", mediaType: "image", mime: "image/jpeg", step: "generative-ad", headline: "50% off" })).toBe("ad");
    expect(libraryKind({ kind: "variant", mediaType: "image", mime: "image/jpeg", step: "local-grade", headline: null })).toBe("picture");
  });
  it("posted beats an OK; the asset's own record beats the card; the owner's photo has no state", () => {
    expect(libraryState({ mine: false, status: "approved", posted: true, cards: [] })).toBe("posted");
    expect(libraryState({ mine: true, status: "used", posted: false, cards: [{ status: "pending" }] })).toBeNull();
    expect(libraryState({ mine: false, status: "declined", posted: false, cards: [{ status: "approved" }] })).toBe("declined");
    expect(libraryState({ mine: false, status: "proposed", posted: false, cards: [{ status: "pending" }] })).toBe("waiting");
    expect(libraryState({ mine: false, status: "proposed", posted: false, cards: [{ status: "rejected" }] })).toBe("declined");
    expect(libraryState({ mine: false, status: "proposed", posted: false, cards: [{ status: "executed" }] })).toBe("approved");
    expect(libraryState({ mine: false, status: "proposed", posted: false, cards: [] })).toBeNull();
  });
});
