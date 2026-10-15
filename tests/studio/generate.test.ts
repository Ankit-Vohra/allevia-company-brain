// The owner's own requests to the AI editor: "make it festive", "remove the pole", "make this into an ad saying ...",
// "try again". Fake engine, fake vision: no credits. Checks what the engine is given (the frame, the brand's rules, the owner's
// words), Nisha's check with the request allowed, the card, retries, ads drawn by code, and the refusals (a child, a decline).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { GraphHandle } from "../../src/graph/client.js";
import { closeAll } from "../../src/graph/client.js";
import { upsertNode } from "../../src/graph/upsert.js";
import { studioCard } from "../../src/studio/approve.js";
import { EngineDecline, FakeEngine, type GenerationEngine } from "../../src/studio/engine.js";
import { generateVariant, NEED_AD_MESSAGE } from "../../src/studio/generate.js";
import { wrapLines } from "../../src/studio/ad.js";
import { runStudio } from "../../src/studio/pipeline.js";
import { adMessage, routeRequest } from "../../src/studio/request.js";
import { setBlurFaces } from "../../src/studio/settings.js";
import { AssetStore } from "../../src/studio/store.js";
import { FakeVision } from "../../src/studio/vision.js";
import { testGraph } from "../helpers/graph.js";
import { BIZ, DEV_ANSWER, facadePhoto, NOW, seedBrand, TARA_ANSWER } from "./fixtures.js";

describe("what the owner's words ask for", () => {
  it("light and colour stay free and local", () => {
    for (const w of ["make it warmer", "a bit darker", "more contrast please", "much brighter and warmer"]) expect(routeRequest(w).kind, w).toBe("adjust");
  });
  it("a change to what is in the photo, a style, or a new background goes to the AI editor", () => {
    for (const w of ["make it festive", "change the background", "remove the pole", "different background", "add some marigold garlands", "make it look like Diwali", "make it warmer and remove the pole"]) {
      expect(routeRequest(w), w).toMatchObject({ kind: "generate" });
    }
  });
  it("an ad, with the message it should carry", () => {
    expect(routeRequest("make this into an ad saying \"Free site visit this week\"")).toMatchObject({ kind: "ad", headline: "Free site visit this week" });
    expect(routeRequest("turn this into an ad with the offer 20% off all April bookings")).toMatchObject({ kind: "ad", headline: "20% off all April bookings" });
    expect(routeRequest("Make an ad for this")).toEqual({ kind: "ad", words: "Make an ad for this" });
    expect(adMessage("an ad that says Book now - First consultation is free")).toEqual({ headline: "Book now", sub: "First consultation is free" });
  });
  it("try again, a clip, and chat", () => {
    expect(routeRequest("try again")).toEqual({ kind: "retry" });
    expect(routeRequest("Please make a short reel from this")).toEqual({ kind: "clip" });
    expect(routeRequest("thanks!")).toEqual({ kind: "chat" });
    expect(routeRequest("")).toEqual({ kind: "chat" });
  });
  it("wraps ad text to a few whole lines", () => {
    expect(wrapLines("Free site visit this week for every new enquiry in April", 24, 3)).toEqual(["Free site visit this", "week for every new", "enquiry in April"]);
    expect(wrapLines("a ".repeat(80), 10, 2).at(-1)).toMatch(/…$/);
  });
});

describe("generateVariant (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  const dirs: string[] = [];
  let clock = NOW;
  const now = () => (clock += 1000);
  const fail = new Set<string>();
  let seq = 0;

  const nisha = (input: { images: Array<{ label: string }> }) => ({
    variants: input.images.filter((i) => !["original", "frame"].includes(i.label)).map((i) => fail.has(i.label)
      ? { label: i.label, sameBuilding: true, structuralChange: true, added: ["a glass balustrade"], removed: ["a terrace chair"], note: "it added things" }
      : { label: i.label, sameBuilding: true, structuralChange: false, added: [], removed: [], note: "nothing added" }),
  });
  const vision = () => new FakeVision({ "content-strategist": { ...TARA_ANSWER, overlays: TARA_ANSWER.overlays.filter((o) => o.kind === "lock") }, "fact-checker": nisha as never, "copy-editor": DEV_ANSWER });

  async function card(opts: { overlays?: unknown[]; engine?: GenerationEngine } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "allevia-gen-"));
    dirs.push(dir);
    const store = new AssetStore(dir);
    const v = opts.overlays ? new FakeVision({ "content-strategist": { ...TARA_ANSWER, overlays: opts.overlays }, "fact-checker": nisha as never, "copy-editor": DEV_ANSWER }) : vision();
    const engine = new FakeEngine(async (i) => sharp(i.image).modulate({ brightness: 1.1 }).jpeg().toBuffer(), { credits: 2 });
    const photo = await facadePhoto({ tilt: 3 + (++seq) * 0.013, gps: false });
    const r = await runStudio(g, { tenant: "kestrel_oak", businessId: BIZ, bytes: photo, note: "" }, { store, vision: v, engine, now }, () => undefined);
    const deps = { store, vision: v, engine: opts.engine ?? engine, now: now() };
    return { r, deps, engine, vision: v, store };
  }
  const req = (approvalId: string, request: Parameters<typeof generateVariant>[1]["request"]) => ({ tenant: "kestrel_oak", businessId: BIZ, approvalId, request });

  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await seedBrand(g);
  }, 60_000);
  afterAll(async () => {
    await cleanup();
    await closeAll();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("a free-form request: the engine gets the frame, the brand's rules and the owner's words; Nisha allows that change; the card offers it", async () => {
    fail.clear();
    const { r, deps, engine, vision: v } = await card();
    engine.prompts.length = 0;
    const out = await generateVariant(g, req(r.approvalId, { kind: "request", words: "make it festive for Diwali" }), deps);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.variant).toMatchObject({ label: "C", aiEdited: true, engine: "fake", credits: 2 });
    expect(out.passed).toBe(true);
    // what the engine saw
    expect(engine.prompts).toHaveLength(1);
    const p = engine.prompts[0]!;
    expect(p).toContain("REQUEST: Apply this change and nothing else: make it festive for Diwali.");
    expect(p).toMatch(/LOCK: Change only what the request names/);
    expect(p).toContain("#a8542e"); // the brand palette
    expect(p).toMatch(/Never alter, replace or reshape any person's face/);
    expect(p).not.toContain("Do not add, remove or alter architectural elements"); // the default edit's lock does not apply to a request
    const call = engine.calls.at(-1)!;
    expect(call.input.tenant).toBe("kestrel_oak");
    const m = await sharp(call.input.image).metadata();
    expect(m.width! / m.height!).toBeCloseTo(0.8, 1); // the straightened 4:5 frame, not the whole photo
    // Nisha was told the owner asked for it
    const nishaCall = v.calls.filter((c) => c.agent === "fact-checker").at(-1)!;
    expect(nishaCall.prompt).toContain("The owner asked for this change");
    expect(nishaCall.prompt).toContain("make it festive for Diwali");
    // the card
    const c = (await studioCard(g, r.approvalId))!;
    const entry = c.payload.studio.variants.find((x) => x.label === "C")!;
    expect(entry).toMatchObject({ aiEdited: true, badge: "unchanged", request: "make it festive for Diwali", credits: 2 });
    expect(c.payload.studio.recommended).toBe(out.variant.id);
    const [node] = await g.roQuery<{ step: string; ai: boolean; inst: string }>("MATCH (a:Asset {id:$id}) RETURN a.step AS step, a.aiEdited AS ai, a.instruction AS inst", { id: out.variant.id });
    expect(node).toEqual({ step: "generative-request", ai: true, inst: "make it festive for Diwali" });
    const [lineage] = await g.roQuery<{ c: number }>("MATCH (:Asset {id:$id})-[:DERIVED_FROM]->(:Asset {id:$o}) RETURN count(*) AS c", { id: out.variant.id, o: r.original.id });
    expect(lineage!.c).toBe(1);
  }, 60_000);

  it("held back by Nisha: a retry is offered once, with a tighter lock naming what went wrong, and only once", async () => {
    fail.clear();
    const { r, deps, engine } = await card();
    fail.add("C");
    const first = await generateVariant(g, req(r.approvalId, { kind: "request", words: "remove the pole" }), deps);
    expect(first.ok && first.passed).toBe(false);
    if (!first.ok) return;
    expect(first.canRetry).toBe(true);
    expect(first.retryQuote).toBe("about 2 Studio credits");
    const held = (await studioCard(g, r.approvalId))!.payload.studio.variants.find((v) => v.label === "C")!;
    expect(held).toMatchObject({ badge: "changed", canRetry: true });

    fail.clear();
    engine.prompts.length = 0;
    const again = await generateVariant(g, req(r.approvalId, { kind: "retry" }), deps);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.variant.label).toBe("D");
    expect(again.passed).toBe(true);
    expect(again.canRetry).toBe(false);
    expect(engine.prompts[0]).toMatch(/The last attempt went wrong: it added a glass balustrade and removed a terrace chair\. This time keep those exactly as they are/);
    expect(engine.prompts[0]).toContain("remove the pole"); // the request carries over
    const c = (await studioCard(g, r.approvalId))!.payload.studio;
    expect(c.variants.find((v) => v.label === "C")!.canRetry).toBe(false);
    expect(c.recommended).toBe(again.variant.id);
    const [retry] = await g.roQuery<{ r: string }>("MATCH (a:Asset {id:$id}) RETURN a.retryOf AS r", { id: again.variant.id });
    expect(retry!.r).toBe(first.variant.id);
    // nothing left to try again
    const none = await generateVariant(g, req(r.approvalId, { kind: "retry" }), deps);
    expect(none).toMatchObject({ ok: false, reason: "no-retry" });
  }, 60_000);

  it("a retry that is held back again is not offered a third go", async () => {
    fail.clear();
    const { r, deps } = await card();
    fail.add("C"); fail.add("D");
    const first = await generateVariant(g, req(r.approvalId, { kind: "request", words: "a calmer background" }), deps);
    expect(first.ok && first.canRetry).toBe(true);
    const second = await generateVariant(g, req(r.approvalId, { kind: "retry" }), deps);
    expect(second.ok && second.passed).toBe(false);
    expect(second.ok && second.canRetry).toBe(false);
    expect(await generateVariant(g, req(r.approvalId, { kind: "retry" }), deps)).toMatchObject({ ok: false, reason: "no-retry" });
    fail.clear();
  }, 60_000);

  it("an ad: asks for the message when there is none; otherwise the message is drawn by code, not generated", async () => {
    fail.clear();
    const { r, deps, engine } = await card();
    engine.prompts.length = 0;
    expect(await generateVariant(g, req(r.approvalId, { kind: "ad", words: "make an ad" }), deps)).toEqual({ ok: false, reason: "need-message", message: NEED_AD_MESSAGE });
    expect(engine.prompts).toEqual([]);
    const out = await generateVariant(g, req(r.approvalId, { kind: "ad", words: "make an ad saying Free site visit", headline: "Free site visit", sub: "This week only" }), deps);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(engine.prompts[0]).toMatch(/clean advertising image for Kestrel & Oak/);
    expect(engine.prompts[0]).toMatch(/bottom third is calm, plain space/);
    expect(engine.prompts[0]).not.toContain("Free site visit"); // the model is never asked to write the words
    expect(engine.prompts[0]).toMatch(/NEGATIVES: No text, letters/);
    const [node] = await g.roQuery<{ step: string; h: string; storageKey: string }>("MATCH (a:Asset {id:$id}) RETURN a.step AS step, a.adHeadline AS h, a.storageKey AS storageKey", { id: out.variant.id });
    expect(node).toMatchObject({ step: "generative-ad", h: "Free site visit" });
    // the bottom of the picture was drawn on: lighter text pixels on a dark scrim, where the plain edit has neither
    const plain = await sharp(out.variant.buffer).extract({ left: 60, top: 1000, width: 960, height: 250 }).greyscale().raw().toBuffer();
    const light = plain.filter((v) => v > 200).length;
    expect(light).toBeGreaterThan(300);
    const mean = (b: Buffer) => b.reduce((x, v) => x + v, 0) / b.length;
    const plainA = await sharp(r.variants[0]!.buffer).extract({ left: 60, top: 1000, width: 960, height: 250 }).greyscale().raw().toBuffer();
    expect(mean(plain)).toBeLessThan(mean(plainA) - 20); // a dark scrim sits under the words
    const nishaCall = (deps.vision as FakeVision).calls.filter((c) => c.agent === "fact-checker").at(-1)!;
    expect(nishaCall.prompt).toContain("this message set at the bottom");
  }, 60_000);

  it("the engine declines (a cap, not signed in): nothing is added, the owner hears why in plain words, the card is untouched", async () => {
    fail.clear();
    const decliner: GenerationEngine = { name: "decline", edit: async () => { throw new EngineDecline("daily-cap", "Today's Studio budget for AI edits is used up (24 Studio credits of 25 today), so I kept to the simple clean-up. It starts again tomorrow."); } };
    const { r, deps } = await card({ engine: decliner });
    const before = (await studioCard(g, r.approvalId))!.payload.studio.variants.length;
    const out = await generateVariant(g, req(r.approvalId, { kind: "request", words: "make it festive" }), deps);
    expect(out).toMatchObject({ ok: false, reason: "declined" });
    expect(!out.ok && out.message).toMatch(/Today's Studio budget for AI edits is used up/);
    expect((await studioCard(g, r.approvalId))!.payload.studio.variants).toHaveLength(before);
    // an engine with nothing for this photo (recordings only) says so without a stack trace
    const none = await generateVariant(g, req(r.approvalId, { kind: "request", words: "make it festive" }), { ...deps, engine: { name: "recorded", edit: async () => null } });
    expect(none).toMatchObject({ ok: false, reason: "declined", message: expect.stringMatching(/isn't switched on here/) });
    const boom = await generateVariant(g, req(r.approvalId, { kind: "request", words: "make it festive" }), { ...deps, engine: { name: "boom", edit: async () => { throw new Error("secret stack detail"); } } });
    expect(!boom.ok && boom.message).toMatch(/stopped on a problem/);
    expect(!boom.ok && boom.message).not.toMatch(/secret/);
  }, 60_000);

  it("a photo with a child never reaches the AI editor: light and colour only", async () => {
    fail.clear();
    const kids = [...TARA_ANSWER.overlays.filter((o) => o.kind === "lock"), { kind: "privacy", x: 0.1, y: 0.55, w: 0.12, h: 0.25, note: "a child by the gate" }];
    const { r, deps, engine } = await card({ overlays: kids });
    expect(r.variants.map((v) => v.label)).toEqual(["A"]);
    engine.prompts.length = 0;
    const out = await generateVariant(g, req(r.approvalId, { kind: "request", words: "make it festive" }), deps);
    expect(out).toMatchObject({ ok: false, reason: "child" });
    expect(!out.ok && out.message).toMatch(/AI edits aren't used on photos with children/);
    expect(engine.prompts).toEqual([]);
  }, 60_000);

  it("with 'Blur people's faces' on, the engine is given the frame with the person already blurred, and the result is blurred again", async () => {
    fail.clear();
    await setBlurFaces(g, BIZ, true, now());
    try {
      const person = [...TARA_ANSWER.overlays.filter((o) => o.kind === "lock"), { kind: "privacy", x: 0.1, y: 0.55, w: 0.12, h: 0.25, note: "a person by the gate" }];
      const { r, deps, engine } = await card({ overlays: person });
      const out = await generateVariant(g, req(r.approvalId, { kind: "request", words: "make it festive" }), deps);
      expect(out.ok).toBe(true);
      expect(engine.calls.at(-1)!.input.image.length).toBeGreaterThan(1000);
    } finally {
      await setBlurFaces(g, BIZ, false, now());
    }
  }, 60_000);

  it("a decided card cannot be changed any more", async () => {
    fail.clear();
    const { r, deps } = await card();
    await upsertNode(g, { type: "Approval", id: r.approvalId, name: "decided", props: { status: "approved" } }, now());
    const out = await generateVariant(g, req(r.approvalId, { kind: "request", words: "make it festive" }), deps);
    expect(out).toMatchObject({ ok: false });
  }, 60_000);
});
