// "Make it warmer": a text reply adjusts the next variant (a new Asset with its lineage, checked by Nisha, added to the
// pending card), and videos: kept as a raw Asset, honest about ffmpeg. Fake vision and a fake engine; no credits, no network.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { GraphHandle } from "../../src/graph/client.js";
import { closeAll } from "../../src/graph/client.js";
import { decide } from "../../src/server/approvals.js";
import { approveStudioDraft, studioCard, type DecideFn } from "../../src/studio/approve.js";
import { FakeEngine } from "../../src/studio/engine.js";
import { runStudio } from "../../src/studio/pipeline.js";
import { adjustVariant, parseAdjustment, reviseVariant, CANNOT_REVISE } from "../../src/studio/revise.js";
import { AssetStore } from "../../src/studio/store.js";
import { assessFirstFrame, realFfmpeg, sniffVideo, storeVideo, VideoRejected, type Ffmpeg } from "../../src/studio/video.js";
import { FakeVision } from "../../src/studio/vision.js";
import { testGraph } from "../helpers/graph.js";
import { BIZ, DEV_ANSWER, facadePhoto, NOW, seedBrand, TARA_ANSWER } from "./fixtures.js";

// a made-up place, written in two pieces so it reads as no real coordinate
const PLANTED_PLACE = ["+51.45", "45-002.5", "879/"].join("");
const meanRB = async (b: Buffer) => { const s = await sharp(b).stats(); return s.channels[0]!.mean - s.channels[2]!.mean; };
const meanL = async (b: Buffer) => { const s = await sharp(b).stats(); return (s.channels[0]!.mean + s.channels[1]!.mean + s.channels[2]!.mean) / 3; };

describe("what the owner's words mean", () => {
  it("understands warmer, cooler, lighter, darker, contrast and colour, and how much", () => {
    expect(parseAdjustment("make it warmer")).toMatchObject({ warmth: 1, label: "warmer" });
    expect(parseAdjustment("Make it a bit warmer please")).toMatchObject({ warmth: 0.5 });
    expect(parseAdjustment("much cooler")).toMatchObject({ warmth: -2 });
    expect(parseAdjustment("brighter and with more contrast")).toMatchObject({ brightness: 1, contrast: 1, label: "brighter, with more contrast" });
    expect(parseAdjustment("darker, calmer colours")).toMatchObject({ brightness: -1, saturation: -1 });
    expect(parseAdjustment("more vibrant")).toMatchObject({ saturation: 1 });
  });
  it("says nothing it cannot do: changes to what is IN the photo are not adjustments", () => {
    expect(parseAdjustment("remove the bin on the left")).toBeNull();
    expect(parseAdjustment("add a garden")).toBeNull();
    expect(parseAdjustment("")).toBeNull();
    expect(CANNOT_REVISE).toMatch(/not something the team can do yet/);
  });
  it("applies it: warmer adds red over blue, brighter is lighter", async () => {
    const grey = await sharp({ create: { width: 64, height: 80, channels: 3, background: "#808080" } }).jpeg().toBuffer();
    expect(await meanRB(await adjustVariant(grey, parseAdjustment("warmer")!))).toBeGreaterThan(await meanRB(grey) + 4);
    expect(await meanRB(await adjustVariant(grey, parseAdjustment("cooler")!))).toBeLessThan(await meanRB(grey) - 4);
    expect(await meanL(await adjustVariant(grey, parseAdjustment("brighter")!))).toBeGreaterThan(await meanL(grey) + 5);
    expect(await meanL(await adjustVariant(grey, parseAdjustment("darker")!))).toBeLessThan(await meanL(grey) - 5);
  });
});

describe("revising a variant (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  let dir: string;
  let store: AssetStore;
  let clock = NOW;
  const now = () => (clock += 1000);
  const checks = (labels: string[], changed = false) => ({
    variants: labels.map((label) => ({ label, sameBuilding: true, structuralChange: changed, added: changed ? ["a second roofline"] : [], removed: [], note: changed ? "a second roofline appeared" : "adjusted light; nothing added" })),
  });

  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await seedBrand(g);
    dir = mkdtempSync(join(tmpdir(), "allevia-revise-"));
    store = new AssetStore(dir);
  }, 60_000);
  afterAll(async () => { await cleanup(); await closeAll(); rmSync(dir, { recursive: true, force: true }); });

  async function newCard(vision: FakeVision) {
    const engine = new FakeEngine(async (input) => sharp(input.image).modulate({ brightness: 1.05 }).jpeg().toBuffer());
    return runStudio(g, { tenant: "kestrel_oak", businessId: BIZ, bytes: await facadePhoto({ tilt: 5 }), note: "Harbour House" }, { store, vision, engine, now }, () => {});
  }
  const toPlain = (id: string) => `${id}`;

  it("a text reply makes the next variant: a new Asset with its lineage, checked, on the pending card, and replies add up", async () => {
    const vision = new FakeVision({ "content-strategist": TARA_ANSWER, "fact-checker": [
      { variants: [{ label: "A", sameBuilding: true, structuralChange: false, added: [], removed: [], note: "straightened; nothing added" }, { label: "B", sameBuilding: true, structuralChange: false, added: [], removed: [], note: "relit; nothing added" }] },
      checks(["C"]), checks(["D"]),
    ], "copy-editor": DEV_ANSWER });
    const r = await newCard(vision);
    const labels = r.variants.map((v) => v.label);
    expect(labels).toEqual(["A", "B"]);

    const first = await reviseVariant(g, { tenant: "kestrel_oak", businessId: BIZ, approvalId: r.approvalId, instruction: "make it warmer" }, { store, vision, now: now() });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.variant.label).toBe("C");
    expect(first.fidelity.badge).toBe("unchanged");
    // it is warmer than the local variant it started from
    const a = r.variants.find((v) => v.label === "A")!;
    expect(await meanRB(first.variant.buffer)).toBeGreaterThan(await meanRB(a.buffer) + 2);
    // graph: a variant Asset DERIVED_FROM the original and from variant A, with the owner's words kept
    const [row] = await g.roQuery<{ kind: string; status: string; instr: string; ai: boolean; step: string }>(
      "MATCH (v:Asset {id:$id}) RETURN v.kind AS kind, v.status AS status, v.instruction AS instr, v.aiEdited AS ai, v.step AS step", { id: first.variant.id });
    expect(row).toMatchObject({ kind: "variant", status: "proposed", instr: "make it warmer", ai: false, step: "revision" });
    const parents = await g.roQuery<{ to: string }>("MATCH (:Asset {id:$id})-[:DERIVED_FROM]->(p:Asset) RETURN p.id AS to", { id: first.variant.id });
    expect(parents.map((p) => p.to).sort()).toEqual([r.original.id, a.id].sort());
    const [by] = await g.roQuery<{ n: number }>("MATCH (:Agent)-[:PRODUCED]->(:Asset {id:$id}) RETURN count(*) AS n", { id: first.variant.id });
    expect(by!.n).toBeGreaterThanOrEqual(1);
    const [rev] = await g.roQuery<{ n: number }>("MATCH (:Agent)-[x:REVIEWED]->(:Asset {id:$id}) WHERE x.step = 'fidelity' RETURN count(x) AS n", { id: first.variant.id });
    expect(rev!.n).toBe(1);
    // the card offers it, recommended
    const card = (await studioCard(g, r.approvalId))!;
    expect(card.status).toBe("pending");
    expect(card.payload.studio.variants.map((v) => v.label)).toEqual(["A", "B", "C"]);
    expect(card.payload.studio.recommended).toBe(first.variant.id);

    // "a bit more" adds up: D starts from C
    const second = await reviseVariant(g, { tenant: "kestrel_oak", businessId: BIZ, approvalId: r.approvalId, instruction: "a bit more, warmer" }, { store, vision, now: now() });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.variant.label).toBe("D");
    expect(await meanRB(second.variant.buffer)).toBeGreaterThan(await meanRB(first.variant.buffer));
    const [from] = await g.roQuery<{ f: string }>("MATCH (v:Asset {id:$id}) RETURN v.adjustedFrom AS f", { id: second.variant.id });
    expect(from!.f).toBe(first.variant.id);

    // it can be approved like the others: the draft uses it, and it becomes the approved Asset with its lineage
    const decideWith: DecideFn = (id, edited) => decide(g, "kestrel_oak", id, { decision: "approve", ...(edited ? { editedPayload: edited } : {}) }, { now: now(), actions: { config: { dataDir: dir } } });
    const approved = await approveStudioDraft(g, { approvalId: r.approvalId, variantId: second.variant.id, now: now() }, decideWith);
    expect(approved.variantId).toBe(second.variant.id);
    const [uses] = await g.roQuery<{ n: number }>("MATCH (:Content {id:$c})-[:USES_ASSET]->(:Asset {id:$v}) RETURN count(*) AS n", { c: approved.contentId, v: second.variant.id });
    expect(uses!.n).toBe(1);
    const [status] = await g.roQuery<{ s: string }>("MATCH (v:Asset {id:$id}) RETURN v.status AS s", { id: second.variant.id });
    expect(status!.s).toBe("approved");
    // and a decided card takes no more revisions
    const late = await reviseVariant(g, { tenant: "kestrel_oak", businessId: BIZ, approvalId: r.approvalId, instruction: "cooler" }, { store, vision, now: now() });
    expect(late).toMatchObject({ ok: false, reason: "decided" });
    void toPlain;
  });

  it("an instruction it cannot follow, and a card that does not exist, change nothing", async () => {
    const vision = new FakeVision({ "content-strategist": TARA_ANSWER, "fact-checker": [{ variants: [] }, checks(["C"], true)], "copy-editor": DEV_ANSWER });
    const r = await newCard(vision);
    const nodes = async () => (await g.roQuery<{ n: number }>("MATCH (a:Asset) RETURN count(a) AS n"))[0]!.n;
    const before = await nodes();
    expect(await reviseVariant(g, { tenant: "kestrel_oak", businessId: BIZ, approvalId: r.approvalId, instruction: "remove the bin" }, { store, vision, now: now() }))
      .toMatchObject({ ok: false, reason: "unsupported", message: CANNOT_REVISE });
    expect(await reviseVariant(g, { tenant: "kestrel_oak", businessId: BIZ, approvalId: "approval:nope", instruction: "warmer" }, { store, vision, now: now() }))
      .toMatchObject({ ok: false, reason: "missing" });
    expect(await nodes()).toBe(before);
    // a revision Nisha holds back is on the card but not recommended and cannot be approved
    const held = await reviseVariant(g, { tenant: "kestrel_oak", businessId: BIZ, approvalId: r.approvalId, instruction: "warmer" }, { store, vision, now: now() });
    expect(held.ok && held.fidelity.badge).not.toBe("unchanged");
    if (held.ok) expect((await studioCard(g, r.approvalId))!.payload.studio.recommended).not.toBe(held.variant.id);
  });
});

// ---------- video ----------

const fakeFfmpeg = (o: { available: boolean; frame?: Buffer | null; strip?: (b: Buffer) => Buffer | null }): Ffmpeg & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    available: async () => o.available,
    firstFrame: async () => { calls.push("firstFrame"); return o.frame ?? null; },
    stripMetadata: async (b) => { calls.push("strip"); return o.strip ? o.strip(b) : null; },
  };
};
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(40, 7)]);

describe("videos", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  let dir: string;
  let store: AssetStore;

  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await seedBrand(g);
    dir = mkdtempSync(join(tmpdir(), "allevia-video-test-"));
    store = new AssetStore(dir);
  }, 60_000);
  afterAll(async () => { await cleanup(); await closeAll(); rmSync(dir, { recursive: true, force: true }); });

  it("recognises the containers by their first bytes", () => {
    expect(sniffVideo(MP4)).toBe("mp4");
    expect(sniffVideo(Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from("ftypqt  "), Buffer.alloc(30)]))).toBe("mov");
    expect(sniffVideo(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(30)]))).toBe("webm");
    expect(sniffVideo(Buffer.from("<html>hello this is not a video at all</html>"))).toBeNull();
  });

  it("without ffmpeg: kept as a raw Asset, nothing looked at, nothing claimed", async () => {
    const ff = fakeFfmpeg({ available: false });
    const r = await storeVideo(g, { tenant: "kestrel_oak", bytes: MP4, mime: "video/mp4", note: "walk-through" }, { store, now: NOW, ffmpeg: ff });
    expect(r).toMatchObject({ stripped: false, hasFfmpeg: false, frame: null });
    expect(ff.calls).toEqual([]);
    expect(Buffer.compare(store.get("kestrel_oak", r.asset.storageKey)!, MP4)).toBe(0);
    const [a] = await g.roQuery<{ kind: string; media: string; mime: string; stripped: boolean; key: string; owner: number }>(
      "MATCH (a:Asset {id:$id}) OPTIONAL MATCH (p:Person)-[:AUTHORED]->(a) RETURN a.kind AS kind, a.mediaType AS media, a.mime AS mime, a.metadataStripped AS stripped, a.storageKey AS key, count(p) AS owner", { id: r.asset.id });
    expect(a).toMatchObject({ kind: "original", media: "video", mime: "video/mp4", stripped: false, owner: 1 });
    expect(a!.key).toMatch(/^[0-9a-f]{64}\.mp4$/);
  });

  it("with ffmpeg: metadata removed, first frame handed over, and Tara's look at it kept on the video", async () => {
    const frame = await facadePhoto({ gps: false });
    const ff = fakeFfmpeg({ available: true, frame, strip: (b) => Buffer.concat([b, Buffer.from("-clean")]) });
    const r = await storeVideo(g, { tenant: "kestrel_oak", bytes: MP4, mime: "video/mp4" }, { store, now: NOW, ffmpeg: ff });
    expect(r).toMatchObject({ stripped: true, hasFfmpeg: true });
    expect(r.frame).toBe(frame);
    expect(store.get("kestrel_oak", r.asset.storageKey)!.toString("latin1").endsWith("-clean")).toBe(true); // the stored file is the stripped one
    const vision = new FakeVision({ "content-strategist": TARA_ANSWER });
    const a = await assessFirstFrame(g, { businessId: BIZ, assetId: r.asset.id, frame: r.frame! }, { vision, now: NOW });
    expect(a.verdict).toBe("enhance");
    const [row] = await g.roQuery<{ v: string; media: string }>("MATCH (x:Asset {id:$id}) RETURN x.verdict AS v, x.mediaType AS media", { id: r.asset.id });
    expect(row).toEqual({ v: "enhance", media: "video" });
    const [rv] = await g.roQuery<{ n: number }>("MATCH (:Agent)-[x:REVIEWED]->(:Asset {id:$id}) RETURN count(x) AS n", { id: r.asset.id });
    expect(rv!.n).toBe(1);
  });

  it("refuses a file that is not the video it says it is, or a type it does not take", async () => {
    const ff = fakeFfmpeg({ available: true });
    await expect(storeVideo(g, { tenant: "kestrel_oak", bytes: Buffer.from("<html>not a video, just text pretending</html>"), mime: "video/mp4" }, { store, now: NOW, ffmpeg: ff })).rejects.toThrow(VideoRejected);
    await expect(storeVideo(g, { tenant: "kestrel_oak", bytes: MP4, mime: "video/x-msvideo" }, { store, now: NOW, ffmpeg: ff })).rejects.toThrow(/not a video I can keep/);
    await expect(storeVideo(g, { tenant: "kestrel_oak", bytes: MP4, mime: "video/webm" }, { store, now: NOW, ffmpeg: ff })).rejects.toThrow(VideoRejected); // a webm claim on an mp4
    expect(ff.calls).toEqual([]);
  });

  const haveFfmpeg = (() => { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } })();
  it.skipIf(!haveFfmpeg)("with the real ffmpeg: the planted location is gone from the file and the first frame is a photo", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "allevia-ff-"));
    try {
      const file = join(tmp, "clip.mp4");
      execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10:duration=1", "-pix_fmt", "yuv420p", "-metadata", `location=${PLANTED_PLACE}`, "-metadata", "title=Secret site visit", file]);
      const raw = readFileSync(file);
      expect(raw.includes(Buffer.from("Secret site visit"))).toBe(true); // planted
      const r = await storeVideo(g, { tenant: "kestrel_oak", bytes: raw, mime: "video/mp4" }, { store, now: NOW, ffmpeg: realFfmpeg() });
      expect(r).toMatchObject({ stripped: true, hasFfmpeg: true });
      const kept = store.get("kestrel_oak", r.asset.storageKey)!;
      expect(kept.includes(Buffer.from("Secret site visit"))).toBe(false);
      expect(kept.includes(Buffer.from("+51.45"))).toBe(false);
      expect(r.frame).not.toBeNull();
      expect(await sharp(r.frame!).metadata()).toMatchObject({ format: "jpeg", width: 320, height: 240 });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
