// Content trial 2026-10-15 (docs/content-trials.md): what the Studio does when the photo should not become a post.
// - reshoot: Tara says it cannot be saved; the studio used to carry on (a variant, Nisha's "unchanged", a card to approve).
// - use: Tara says post it as it is; the studio used to spend a generative edit on it anyway.
// - a person: the unblurred original used to be stored on disk and shown back; it must be flagged and never stored.
// - a child, or a person Tara could not place: nothing is kept and nothing is made.
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
import { readPrivacy } from "../../src/studio/privacy.js";
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
    expect(readPrivacy(a({ overlays: [privacyBox("a number plate")] }))).toMatchObject({ people: false, minor: false });
    expect(readPrivacy(a({ overlays: [privacyBox("house number 42")] })).people).toBe(false);
  });
  it("a person, a face or a worker is a person; a child, a kid or a girl is a possible minor and stops the run", () => {
    expect(readPrivacy(a({ overlays: [privacyBox("a person by the gate")] }))).toMatchObject({ people: true, minor: false});
    expect(readPrivacy(a({ overlays: [privacyBox("a worker on the roof")] })).people).toBe(true);
    for (const note of ["a child on the slide", "kid in the pool", "a young girl", "toddler", "boy with a bike"]) {
      expect(readPrivacy(a({ overlays: [privacyBox(note)] })), note).toMatchObject({ people: true, minor: true, stop: "minor" });
    }
  });
  it("a photo of people with no box marking where they are cannot be blurred, so it stops", () => {
    expect(readPrivacy(a({ subjectKind: "people", overlays: [] }))).toMatchObject({ people: true, located: false, stop: "unlocated" });
    expect(readPrivacy(a({ subjectKind: "people", overlays: [privacyBox("face")] })).stop).toBeUndefined();
  });
  it("a kids' room with nobody in it is not a child in the photo (only boxes Tara marked as privacy count)", () => {
    expect(readPrivacy(a({ subject: "a children's room with a green slide", story: "A kids' room", overlays: [] }))).toMatchObject({ people: false, minor: false});
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

  it("a 'use' verdict makes the local variant only: a good photo is not sent for a generative edit", async () => {
    const { store } = fresh();
    const vision = new FakeVision({ "content-strategist": { ...noPeople, verdict: "use" }, "fact-checker": { variants: [{ label: "A", sameBuilding: true, structuralChange: false, added: [], removed: [], note: "straightened" }] }, "copy-editor": DEV_ANSWER });
    const eng = engine();
    const events: AgentEvent[] = [];
    const r = await runStudio(g, { tenant: "kestrel_oak", businessId: BIZ, bytes: await photo(), note: "" }, { store, vision, engine: eng, now }, (e) => events.push(e));
    expect(r.stopped).toBeUndefined();
    expect(r.variants.map((v) => v.label)).toEqual(["A"]);
    expect(eng.prompts).toEqual([]);
    expect(events.some((e) => e.type === "agent_status" && /post it as it is|no generative edit is needed/i.test(e.text))).toBe(true);
    expect(r.approvalId).toMatch(/^approval:studio-/);
  }, 60_000);

  it("a person: flagged on the card, blurred in the stored original, and the unblurred original is never written to disk", async () => {
    const { dir, store } = fresh();
    // a high-contrast checker where the person is, so a blur is plainly visible in the pixels
    const base = await photo();
    const bm = await sharp(base).metadata();
    const cells = Array.from({ length: 64 }, (_, i) => `<rect x="${(i % 8) * 10}" y="${Math.floor(i / 8) * 10}" width="10" height="10" fill="${(i + Math.floor(i / 8)) % 2 ? "#000" : "#fff"}"/>`).join("");
    const checker = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80">${cells}</svg>`);
    const bytes = await sharp(base).composite([{
      input: await sharp(checker).resize(Math.round(bm.width! * 0.14), Math.round(bm.height! * 0.3), { fit: "fill", kernel: "nearest" }).png().toBuffer(),
      left: Math.round(bm.width! * 0.1), top: Math.round(bm.height! * 0.55),
    }]).jpeg({ quality: 95 }).toBuffer();
    const plain = await normalizeUpload(bytes);
    const vision = new FakeVision({ "content-strategist": TARA_ANSWER, "fact-checker": nishaAnswer(false), "copy-editor": DEV_ANSWER });
    const events: AgentEvent[] = [];
    const r = await runStudio(g, { tenant: "kestrel_oak", businessId: BIZ, bytes, note: "" }, { store, vision, engine: engine(), now }, (e) => events.push(e));
    expect(r.stopped).toBeUndefined();
    // never stored unblurred: the original's own content address is not on disk, only the redacted copy
    expect(files(dir)).not.toContain(`${plain.sha256}.jpg`);
    const kept = store.get("kestrel_oak", r.original.storageKey)!;
    expect(sha256Hex(kept)).not.toBe(plain.sha256);
    // the person's box differs from the unblurred photo, the rest of the frame is the same
    const region = async (buf: Buffer, x: number, y: number, w: number, h: number) => {
      const m = await sharp(buf).metadata();
      return sharp(buf).extract({ left: Math.round(x * m.width!), top: Math.round(y * m.height!), width: Math.round(w * m.width!), height: Math.round(h * m.height!) }).raw().toBuffer();
    };
    const diff = (a: Buffer, b: Buffer) => a.reduce((s, v, i) => s + Math.abs(v - b[i]!), 0) / a.length;
    expect(diff(await region(kept, 0.11, 0.57, 0.1, 0.2), await region(plain.buffer, 0.11, 0.57, 0.1, 0.2))).toBeGreaterThan(20);
    expect(diff(await region(kept, 0.5, 0.0, 0.4, 0.15), await region(plain.buffer, 0.5, 0.0, 0.4, 0.15))).toBeLessThan(3);
    const node = (await one<{ p: Record<string, unknown> }>("MATCH (a:Asset {id:$id}) RETURN properties(a) AS p", { id: r.original.id })).p;
    expect(node).toMatchObject({ containsPerson: true, privacyRedacted: true, storageKey: r.original.storageKey });
    // Nisha and Dev were shown the blurred original, never the person
    const nisha = vision.calls.find((c) => c.agent === "fact-checker")!;
    expect(sha256Hex(nisha.images[0]!.data)).not.toBe(sha256Hex(await visionCopy(plain.buffer, 1024)));
    // flagged on the card and in the work log
    const card = (await studioCard(g, r.approvalId))!;
    expect(card.payload.studio.privacy).toMatchObject({ people: true });
    expect(card.payload.studio.privacy!.note).toMatch(/person.*blurred.*not kept/i);
    expect(events.some((e) => e.type === "agent_status" && /a person/i.test(e.text))).toBe(true);
    // the asset event for the original comes after the redacted copy exists, so its thumbnail is never a missing file
    const at = events.findIndex((e) => e.type === "asset" && e.kind === "original");
    expect(at).toBeGreaterThan(events.findIndex((e) => e.type === "agent_status" && /a person/i.test(e.text)));
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

  it("a child: nothing is kept and nothing is made, and the owner is told why in plain words", async () => {
    const { dir, store } = fresh();
    const vision = new FakeVision({ "content-strategist": { ...noPeople, overlays: [...noPeople.overlays, privacyBox("a child sliding down the slide")] }, "fact-checker": nishaAnswer(false), "copy-editor": DEV_ANSWER });
    const eng = engine();
    const events: AgentEvent[] = [];
    const r = await runStudio(g, { tenant: "kestrel_oak", businessId: BIZ, bytes: await photo(), note: "kids room" }, { store, vision, engine: eng, now }, (e) => events.push(e));
    expect(r.stopped).toMatchObject({ reason: "privacy" });
    expect(r.stopped!.message).toMatch(/child/i);
    expect(r.stopped!.message).toMatch(/without (a child|children|anyone)/i);
    expect(files(dir)).toEqual([]);
    expect(r.variants).toEqual([]);
    expect(eng.prompts).toEqual([]);
    expect(vision.calls.map((c) => c.agent)).toEqual(["content-strategist"]);
    const kinds = events.map((e) => e.type);
    expect(kinds).not.toContain("proposal");
    expect(events.filter((e) => e.type === "asset")).toEqual([]);   // no picture to show: it was not kept
    expect(events.find((e) => e.type === "error")).toMatchObject({ message: expect.stringMatching(/child/i) });
    expect(events.at(-1)!.type).toBe("final");
    const node = (await one<{ p: Record<string, unknown> }>("MATCH (a:Asset {id:$id}) RETURN properties(a) AS p", { id: r.original.id })).p;
    expect(node).toMatchObject({ status: "blocked", blockedReason: "minor" });
    expect(node.storageKey).toBeUndefined();
    expect(node.assessment).toBeUndefined(); // what the photo showed is not kept either
  }, 60_000);

  it("people Tara could not place cannot be blurred, so the run stops rather than keep them", async () => {
    const { dir, store } = fresh();
    const vision = new FakeVision({ "content-strategist": { ...noPeople, subjectKind: "people", overlays: [] }, "fact-checker": nishaAnswer(false), "copy-editor": DEV_ANSWER });
    const r = await runStudio(g, { tenant: "kestrel_oak", businessId: BIZ, bytes: await photo(), note: "" }, { store, vision, engine: engine(), now }, () => undefined);
    expect(r.stopped).toMatchObject({ reason: "privacy" });
    expect(files(dir)).toEqual([]);
  }, 60_000);

  it("the stored file for a stopped, non-private photo is the normal one (a reshoot keeps the owner's photo)", async () => {
    const { dir, store } = fresh();
    const vision = new FakeVision({ "content-strategist": { ...noPeople, verdict: "reshoot", coaching: "Step back." }, "fact-checker": nishaAnswer(false), "copy-editor": DEV_ANSWER });
    const r = await runStudio(g, { tenant: "kestrel_oak", businessId: BIZ, bytes: await photo(), note: "" }, { store, vision, engine: engine(), now }, () => undefined);
    expect(files(dir)).toEqual([r.original.storageKey]);
    expect(readFileSync(join(dir, "assets", "kestrel_oak", r.original.storageKey)).length).toBeGreaterThan(1000);
  }, 60_000);
});
