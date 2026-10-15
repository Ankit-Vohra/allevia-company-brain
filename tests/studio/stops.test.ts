// Content trial 2026-10-15 (docs/content-trials.md): what the Studio does when the photo should not become a post.
// - reshoot: Tara says it cannot be saved; the studio used to carry on (a variant, Nisha's "unchanged", a card to approve).
// - use: Tara says post it as it is; the studio used to spend a generative edit on it anyway.
// - a person: kept as they are (the owner's own content); the setting "Blur people's faces in my content" blurs them in
//   everything made and kept, and the unblurred original is then never written to disk. No question is asked per photo.
// - a child: no stop, but the free local clean-up only (no AI edit), faces blurred in what is kept, one plain sentence.
// - a person Tara could not place, with the blur setting on: nothing is kept and nothing is made.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { AgentEvent } from "../../shared/contracts.js";
import type { GraphHandle } from "../../src/graph/client.js";
import { closeAll } from "../../src/graph/client.js";
import { studioCard } from "../../src/studio/approve.js";
import { FakeEngine } from "../../src/studio/engine.js";
import { normalizeUpload, sha256Hex, visionCopy } from "../../src/studio/image.js";
import { runStudio } from "../../src/studio/pipeline.js";
import { CHILD_NOTICE, readPrivacy } from "../../src/studio/privacy.js";
import { loadStudioSettings, parseStudioSetting, setBlurFaces } from "../../src/studio/settings.js";
import { parseAssessment } from "../../src/studio/assess.js";
import { AssetStore } from "../../src/studio/store.js";
import { FakeVision } from "../../src/studio/vision.js";
import { testGraph } from "../helpers/graph.js";
import { BIZ, DEV_ANSWER, facadePhoto, nishaAnswer, NOW, seedBrand, TARA_ANSWER } from "./fixtures.js";

const noPeople = { ...TARA_ANSWER, overlays: TARA_ANSWER.overlays.filter((o) => o.kind === "lock") };
const privacyBox = (note: string) => ({ kind: "privacy", x: 0.1, y: 0.55, w: 0.12, h: 0.25, note });

describe("readPrivacy (pure)", () => {
  const a = (over: Record<string, unknown>) => parseAssessment({ ...TARA_ANSWER, ...over });
  it("a plate or a house number is blurred but is not a person", () => {
    const r = readPrivacy(a({ overlays: [privacyBox("a number plate")] }));
    expect(r).toMatchObject({ people: false, minor: false });
    expect(r.blur).toHaveLength(1);
    expect(readPrivacy(a({ overlays: [privacyBox("house number 42")] })).people).toBe(false);
  });
  it("people are kept as they are by default: no blur box, no stop", () => {
    const r = readPrivacy(a({ overlays: [privacyBox("a person by the gate")] }));
    expect(r).toMatchObject({ people: true, minor: false, blurPeople: false, localOnly: false });
    expect(r.blur).toEqual([]);
    expect(r.stop).toBeUndefined();
    expect(readPrivacy(a({ overlays: [privacyBox("a worker on the roof")] })).people).toBe(true);
  });
  it("with the setting on, every person is blurred", () => {
    const r = readPrivacy(a({ overlays: [privacyBox("a person by the gate"), privacyBox("a number plate")] }), { blurFaces: true });
    expect(r).toMatchObject({ people: true, blurPeople: true });
    expect(r.blur).toHaveLength(2);
  });
  it("a child, a kid or a girl is a possible minor: no stop, local clean-up only, and blurred whatever the setting says", () => {
    for (const note of ["a child on the slide", "kid in the pool", "a young girl", "toddler", "boy with a bike"]) {
      const r = readPrivacy(a({ overlays: [privacyBox(note)] }));
      expect(r, note).toMatchObject({ people: true, minor: true, localOnly: true, blurPeople: true });
      expect(r.stop).toBeUndefined();
      expect(r.blur).toHaveLength(1);
    }
  });
  it("a photo of people with no box marking where they are: fine by default, a stop only when the owner asked for blurring", () => {
    expect(readPrivacy(a({ subjectKind: "people", overlays: [] })).stop).toBeUndefined();
    expect(readPrivacy(a({ subjectKind: "people", overlays: [] }), { blurFaces: true })).toMatchObject({ people: true, located: false, stop: "unlocated" });
    expect(readPrivacy(a({ subjectKind: "people", overlays: [privacyBox("face")] }), { blurFaces: true }).stop).toBeUndefined();
  });
  it("a kids' room with nobody in it is not a child in the photo (only boxes Tara marked as privacy count)", () => {
    expect(readPrivacy(a({ subject: "a children's room with a green slide", story: "A kids' room", overlays: [] }))).toMatchObject({ people: false, minor: false });
  });
});

describe("the blur setting, in the owner's words", () => {
  it("turns on and off from a plain reply", () => {
    for (const w of ["blur faces from now on", "Please blur people's faces", "always blur the faces", "blur everyone's face in my posts"]) expect(parseStudioSetting(w), w).toEqual({ blurFaces: true });
    for (const w of ["stop blurring faces", "don't blur faces", "no more blurring people", "keep faces as they are", "don't blur people's faces any more"]) expect(parseStudioSetting(w), w).toEqual({ blurFaces: false });
  });
  it("is silent about everything else", () => {
    for (const w of ["make it warmer", "remove the pole", "blur the background", "hello"]) expect(parseStudioSetting(w), w).toBeNull();
  });
});

describe("studio stops and privacy (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  const dirs: string[] = [];
  let clock = NOW;
  const now = () => (clock += 1000);
  const fresh = () => { const dir = mkdtempSync(join(tmpdir(), "allevia-studio-stop-")); dirs.push(dir); return { dir, store: new AssetStore(dir) }; };
  const files = (dir: string) => (existsSync(join(dir, "assets", "kestrel_oak")) ? readdirSync(join(dir, "assets", "kestrel_oak")) : []);
  const one = async <T>(cypher: string, params?: Record<string, unknown>) => (await g.roQuery<T>(cypher, params))[0]!;
  const engine = () => new FakeEngine(async (i) => sharp(i.image).modulate({ brightness: 1.2 }).jpeg().toBuffer(), { credits: 2 });
  let seq = 0;
  const photo = () => facadePhoto({ tilt: 2 + (++seq) * 0.01, gps: false }); // a distinct photo per test

  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await seedBrand(g);
  }, 60_000);
  afterAll(async () => {
    await cleanup();
    await closeAll();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("a reshoot verdict stops with Tara's coaching: no variants, no generative edit, no Nisha, no Dev, no card", async () => {
    const { store } = fresh();
    const vision = new FakeVision({ "content-strategist": { ...noPeople, verdict: "reshoot", coaching: "Retake it with the lights on, standing square to the wall." }, "fact-checker": nishaAnswer(false), "copy-editor": DEV_ANSWER });
    const eng = engine();
    const events: AgentEvent[] = [];
    const r = await runStudio(g, { tenant: "kestrel_oak", businessId: BIZ, bytes: await photo(), note: "front wall" }, { store, vision, engine: eng, now }, (e) => events.push(e));
    expect(r.stopped).toMatchObject({ reason: "reshoot" });
    expect(r.stopped!.message).toContain("Retake it with the lights on");
    expect(r.variants).toEqual([]);
    expect(eng.prompts).toEqual([]);
    expect(vision.calls.map((c) => c.agent)).toEqual(["content-strategist"]);
    const kinds = events.map((e) => e.type);
    expect(kinds).toContain("assessment");
    expect(kinds).not.toContain("proposal");
    expect(events.filter((e) => e.type === "asset" && e.kind === "variant")).toEqual([]);
    const final = events.at(-1) as Extract<AgentEvent, { type: "final" }>;
    expect(final.type).toBe("final");
    expect(final.answer).toContain("Retake it with the lights on");
    expect(final.answer).toMatch(/nothing was made|no credit/i);
    expect(await one("MATCH (a:Approval) WHERE a.recommendation = $r RETURN count(a) AS c", { r: `recommendation:studio-${r.original.sha256.slice(0, 12)}` })).toEqual({ c: 0 });
    expect(await one<{ s: string }>("MATCH (a:Asset {id:$id}) RETURN a.status AS s", { id: r.original.id })).toEqual({ s: "assessed" });
  }, 60_000);

  it("a 'use' verdict still gets both options (every photo does), and a quote is said before the AI edit", async () => {
    const { store } = fresh();
    const vision = new FakeVision({ "content-strategist": { ...noPeople, verdict: "use" }, "fact-checker": nishaAnswer(false), "copy-editor": DEV_ANSWER });
    const eng = engine();
    const events: AgentEvent[] = [];
    const r = await runStudio(g, { tenant: "kestrel_oak", businessId: BIZ, bytes: await photo(), note: "" }, { store, vision, engine: eng, now }, (e) => events.push(e));
    expect(r.stopped).toBeUndefined();
    expect(r.variants.map((v) => v.label)).toEqual(["A", "B"]);
    expect(eng.prompts).toHaveLength(1);
    expect(events.some((e) => e.type === "agent_status" && /AI edit costs about 2 Studio credits/.test(e.text))).toBe(true);
    expect(r.approvalId).toMatch(/^approval:studio-/);
  }, 60_000);

  // a high-contrast checker where the person is, so a blur is plainly visible in the pixels
  const checkerPhoto = async () => {
    const base = await photo();
    const bm = await sharp(base).metadata();
    const cells = Array.from({ length: 64 }, (_, i) => `<rect x="${(i % 8) * 10}" y="${Math.floor(i / 8) * 10}" width="10" height="10" fill="${(i + Math.floor(i / 8)) % 2 ? "#000" : "#fff"}"/>`).join("");
    const checker = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80">${cells}</svg>`);
    return sharp(base).composite([{
      input: await sharp(checker).resize(Math.round(bm.width! * 0.14), Math.round(bm.height! * 0.3), { fit: "fill", kernel: "nearest" }).png().toBuffer(),
      left: Math.round(bm.width! * 0.1), top: Math.round(bm.height! * 0.55),
    }]).jpeg({ quality: 95 }).toBuffer();
  };
  const region = async (buf: Buffer, x: number, y: number, w: number, h: number) => {
    const m = await sharp(buf).metadata();
    return sharp(buf).extract({ left: Math.round(x * m.width!), top: Math.round(y * m.height!), width: Math.round(w * m.width!), height: Math.round(h * m.height!) }).raw().toBuffer();
  };
  const diff = (a: Buffer, b: Buffer) => a.reduce((s, v, i) => s + Math.abs(v - b[i]!), 0) / a.length;

  it("a person is kept as they are by default: no question, no blur, the original is stored and shown back", async () => {
    const { dir, store } = fresh();
    const bytes = await checkerPhoto();
    const plain = await normalizeUpload(bytes);
    const vision = new FakeVision({ "content-strategist": TARA_ANSWER, "fact-checker": nishaAnswer(false), "copy-editor": DEV_ANSWER });
    const events: AgentEvent[] = [];
    const r = await runStudio(g, { tenant: "kestrel_oak", businessId: BIZ, bytes, note: "" }, { store, vision, engine: engine(), now }, (e) => events.push(e));
    expect(r.stopped).toBeUndefined();
    expect(await loadStudioSettings(g, BIZ)).toEqual({ blurFaces: false });
    expect(files(dir)).toContain(`${plain.sha256}.jpg`);               // the owner's own photo, as sent (metadata stripped)
    const kept = store.get("kestrel_oak", r.original.storageKey)!;
    expect(sha256Hex(kept)).toBe(plain.sha256);
    expect(diff(await region(kept, 0.11, 0.57, 0.1, 0.2), await region(plain.buffer, 0.11, 0.57, 0.1, 0.2))).toBeLessThan(1);
    const node = (await one<{ p: Record<string, unknown> }>("MATCH (a:Asset {id:$id}) RETURN properties(a) AS p", { id: r.original.id })).p;
    expect(node).toMatchObject({ containsPerson: true, storageKey: r.original.storageKey });
    expect(node.privacyRedacted).toBeUndefined();
    const card = (await studioCard(g, r.approvalId))!;
    expect(card.payload.studio.privacy).toBeUndefined();               // nothing to warn about, nothing to ask
    expect(r.privacy).toMatchObject({ people: true, blurredPeople: false, minor: false });
    expect(r.notices).toEqual([]);
    expect(events.some((e) => e.type === "agent_status" && /keeping them as they are/i.test(e.text))).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/Is it you|Keep them|Blur them/);
  }, 60_000);

  it("with 'Blur people's faces in my content' on: flagged on the card, blurred in the stored original, and the unblurred original is never written to disk", async () => {
    await setBlurFaces(g, BIZ, true, now());
    try {
      const { dir, store } = fresh();
      const bytes = await checkerPhoto();
      const plain = await normalizeUpload(bytes);
      const vision = new FakeVision({ "content-strategist": TARA_ANSWER, "fact-checker": nishaAnswer(false), "copy-editor": DEV_ANSWER });
      const events: AgentEvent[] = [];
      const r = await runStudio(g, { tenant: "kestrel_oak", businessId: BIZ, bytes, note: "" }, { store, vision, engine: engine(), now }, (e) => events.push(e));
      expect(r.stopped).toBeUndefined();
      expect(files(dir)).not.toContain(`${plain.sha256}.jpg`);
      const kept = store.get("kestrel_oak", r.original.storageKey)!;
      expect(sha256Hex(kept)).not.toBe(plain.sha256);
      expect(diff(await region(kept, 0.11, 0.57, 0.1, 0.2), await region(plain.buffer, 0.11, 0.57, 0.1, 0.2))).toBeGreaterThan(20);
      expect(diff(await region(kept, 0.5, 0.0, 0.4, 0.15), await region(plain.buffer, 0.5, 0.0, 0.4, 0.15))).toBeLessThan(3);
      const node = (await one<{ p: Record<string, unknown> }>("MATCH (a:Asset {id:$id}) RETURN properties(a) AS p", { id: r.original.id })).p;
      expect(node).toMatchObject({ containsPerson: true, privacyRedacted: true, storageKey: r.original.storageKey });
      const nisha = vision.calls.find((c) => c.agent === "fact-checker")!;
      expect(sha256Hex(nisha.images[0]!.data)).not.toBe(sha256Hex(await visionCopy(plain.buffer, 1024)));
      const card = (await studioCard(g, r.approvalId))!;
      expect(card.payload.studio.privacy).toMatchObject({ people: true });
      expect(card.payload.studio.privacy!.note).toMatch(/blurred.*setting/i);
      expect(r.privacy).toMatchObject({ people: true, blurredPeople: true });
      expect(events.some((e) => e.type === "agent_status" && /blurring their face.*your setting/i.test(e.text))).toBe(true);
      const at = events.findIndex((e) => e.type === "asset" && e.kind === "original");
      expect(at).toBeGreaterThan(events.findIndex((e) => e.type === "agent_status" && /a person/i.test(e.text)));
    } finally {
      await setBlurFaces(g, BIZ, false, now());
    }
  }, 60_000);

  it("a plate or house number is blurred in the stored original too, without calling it a person", async () => {
    const { dir, store } = fresh();
    const bytes = await photo();
    const plain = await normalizeUpload(bytes);
    const vision = new FakeVision({ "content-strategist": { ...noPeople, overlays: [...noPeople.overlays, privacyBox("a number plate")] }, "fact-checker": nishaAnswer(false), "copy-editor": DEV_ANSWER });
    const r = await runStudio(g, { tenant: "kestrel_oak", businessId: BIZ, bytes, note: "" }, { store, vision, engine: engine(), now }, () => undefined);
    expect(files(dir)).not.toContain(`${plain.sha256}.jpg`);
    const node = (await one<{ p: Record<string, unknown> }>("MATCH (a:Asset {id:$id}) RETURN properties(a) AS p", { id: r.original.id })).p;
    expect(node).toMatchObject({ privacyRedacted: true });
    expect(node.containsPerson).not.toBe(true);
    const card = (await studioCard(g, r.approvalId))!;
    expect(card.payload.studio.privacy).toMatchObject({ people: false });
    expect(card.payload.studio.privacy!.note).toMatch(/plates|numbers/i);
  }, 60_000);

  it("a child: no stop, the free clean-up only (no AI edit), faces blurred in what is kept, and one plain sentence", async () => {
    const { dir, store } = fresh();
    const bytes = await checkerPhoto();
    const plain = await normalizeUpload(bytes);
    const kids = { ...noPeople, overlays: [...noPeople.overlays, { ...privacyBox("a child sliding down the slide"), x: 0.1, y: 0.55, w: 0.14, h: 0.3 }] };
    const vision = new FakeVision({ "content-strategist": kids, "fact-checker": { variants: [nishaAnswer(false).variants[0]] }, "copy-editor": DEV_ANSWER });
    const eng = engine();
    const events: AgentEvent[] = [];
    const r = await runStudio(g, { tenant: "kestrel_oak", businessId: BIZ, bytes, note: "kids room" }, { store, vision, engine: eng, now }, (e) => events.push(e));
    expect(r.stopped).toBeUndefined();
    expect(r.variants.map((v) => v.label)).toEqual(["A"]);           // the local clean-up, nothing generative
    expect(eng.prompts).toEqual([]);                                  // never sent to the AI edit
    expect(r.notices).toEqual([CHILD_NOTICE]);
    expect(CHILD_NOTICE).toMatch(/^I kept this one to a simple clean-up; AI edits aren't used on photos with children\./);
    const final = events.at(-1) as Extract<AgentEvent, { type: "final" }>;
    expect(final.answer).toContain("AI edits aren't used on photos with children");
    expect(r.approvalId).toMatch(/^approval:studio-/);
    // what is kept is as safe as before: the unblurred original is never on disk and the face box is blurred
    expect(files(dir)).not.toContain(`${plain.sha256}.jpg`);
    const kept = store.get("kestrel_oak", r.original.storageKey)!;
    expect(diff(await region(kept, 0.11, 0.57, 0.1, 0.2), await region(plain.buffer, 0.11, 0.57, 0.1, 0.2))).toBeGreaterThan(20);
    const card = (await studioCard(g, r.approvalId))!;
    expect(card.payload.studio.notices).toEqual([CHILD_NOTICE]);
    expect(card.payload.studio.privacy!.note).toMatch(/child/i);
    // Nisha was shown the blurred copy, never the child
    const nisha = vision.calls.find((c) => c.agent === "fact-checker")!;
    expect(sha256Hex(nisha.images[0]!.data)).not.toBe(sha256Hex(await visionCopy(plain.buffer, 1024)));
  }, 60_000);

  it("people Tara could not place: fine by default; with blurring on they cannot be blurred, so the run stops rather than keep them", async () => {
    const { store } = fresh();
    const unplaced = { ...noPeople, subjectKind: "people", overlays: [] };
    const vision = new FakeVision({ "content-strategist": unplaced, "fact-checker": nishaAnswer(false), "copy-editor": DEV_ANSWER });
    const ok = await runStudio(g, { tenant: "kestrel_oak", businessId: BIZ, bytes: await photo(), note: "" }, { store, vision, engine: engine(), now }, () => undefined);
    expect(ok.stopped).toBeUndefined();
    await setBlurFaces(g, BIZ, true, now());
    try {
      const f = fresh();
      const stopped = await runStudio(g, { tenant: "kestrel_oak", businessId: BIZ, bytes: await photo(), note: "" }, { store: f.store, vision, engine: engine(), now }, () => undefined);
      expect(stopped.stopped).toMatchObject({ reason: "privacy" });
      expect(stopped.stopped!.message).toMatch(/turn the setting off/);
      expect(files(f.dir)).toEqual([]);
    } finally {
      await setBlurFaces(g, BIZ, false, now());
    }
  }, 60_000);

  it("the stored file for a stopped, non-private photo is the normal one (a reshoot keeps the owner's photo)", async () => {
    const { dir, store } = fresh();
    const vision = new FakeVision({ "content-strategist": { ...noPeople, verdict: "reshoot", coaching: "Step back." }, "fact-checker": nishaAnswer(false), "copy-editor": DEV_ANSWER });
    const r = await runStudio(g, { tenant: "kestrel_oak", businessId: BIZ, bytes: await photo(), note: "" }, { store, vision, engine: engine(), now }, () => undefined);
    expect(files(dir)).toEqual([r.original.storageKey]);
    expect(readFileSync(join(dir, "assets", "kestrel_oak", r.original.storageKey)).length).toBeGreaterThan(1000);
  }, 60_000);
});
