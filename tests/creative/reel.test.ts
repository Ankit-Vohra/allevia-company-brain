// A reel plan (from a skill or the writer) becomes a vertical reel draft: scenes from approved pictures, new stills or brand
// cards, the words set by code inside the safe band, the hook on the first frame, the real logo on the end card, 1080x1920;
// priced before any credit is spent; checked frame by frame; a scene with a bad generated picture repaired with a brand card.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import sharp from "sharp";
import { makeReelDraft } from "../../src/creative/reel/draft.js";
import { normaliseReelPlan, planSeconds, ReelPlanRejected, type ReelPlan } from "../../src/creative/reel/plan.js";
import { frameAt, realReelVideo, REEL_H, REEL_W, sceneOverlay, SAFE_BOTTOM, SAFE_TOP } from "../../src/creative/reel/render.js";
import type { CreativeDeps } from "../../src/creative/ports.js";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { upsertNode } from "../../src/graph/upsert.js";
import { sha256Hex } from "../../src/studio/image.js";
import { AssetStore } from "../../src/studio/store.js";
import { FakeVision, type VisionInput } from "../../src/studio/vision.js";
import { loadComposeKit } from "../../src/creative/kit.js";
import { testGraph } from "../helpers/graph.js";
import { BIZ, FakeCreativeEngine, NOW, nishaReads, seedKit, TENANT } from "./helpers.js";

const video = realReelVideo();
let hasFfmpeg = false;
try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); hasFfmpeg = true; } catch { hasFfmpeg = false; }

const skillPlan = (over: Record<string, unknown> = {}) => ({
  title: "The new studio", hook: "A morning at the studio",
  scenes: [
    { seconds: 2.5, onScreen: "Sketches before sunrise", visual: { kind: "asset", assetId: "asset:photo-1" }, voiceOver: "Every home starts here." },
    { seconds: 2.5, onScreen: "Materials, chosen by hand", visual: { kind: "generate", prompt: "terracotta and oak samples on a table" } },
    { seconds: 2, onScreen: "Book a visit", visual: { kind: "card" } },
  ],
  caption: "A morning at the studio.", endCard: { logo: true, line: "Kestrel & Oak, Bristol" }, ...over,
});

describe("reel plans", () => {
  it("takes a skill's plan within the limits and refuses one that breaks them, in plain words", () => {
    const p = normaliseReelPlan(skillPlan(), "skill");
    expect(p).toMatchObject({ source: "skill", hook: "A morning at the studio", endCard: { logo: true } });
    expect(p.scenes.map((s) => s.visual.kind)).toEqual(["asset", "generate", "card"]);
    expect(planSeconds(p)).toBe(9);
    expect(() => normaliseReelPlan({ scenes: [{ onScreen: "one" }] }, "skill")).toThrow(ReelPlanRejected);
    expect(() => normaliseReelPlan(skillPlan({ scenes: Array.from({ length: 6 }, () => ({ seconds: 6, onScreen: "x" })) }), "skill")).toThrow(/30/);
    expect(() => normaliseReelPlan(skillPlan({ scenes: [{ onScreen: "a b c d e f g h i j k l m n", seconds: 2 }, { onScreen: "x", seconds: 2 }] }), "skill")).toThrow(/too many words/);
    // a visual it does not know becomes a brand card, an asset reference must look like one
    const q = normaliseReelPlan(skillPlan({ scenes: [{ seconds: 2, onScreen: "a", visual: { kind: "drawn-by-model" } }, { seconds: 2, onScreen: "b", visual: { kind: "asset", assetId: "../etc" } }] }), "skill");
    expect(q.scenes.map((s) => s.visual.kind)).toEqual(["card", "card"]);
  });
});

describe.skipIf(!hasFfmpeg)("reel drafts (ffmpeg)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  let dir: string;
  let store: AssetStore;
  let n = 0;
  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    dir = mkdtempSync(join(tmpdir(), "allevia-reel-"));
    store = new AssetStore(dir);
    await seedKit(g, store);
    const photo = await sharp({ create: { width: 1200, height: 900, channels: 3, background: "#7a6a5a" } }).jpeg().toBuffer();
    await upsertNode(g, { type: "Asset", id: "asset:photo-1", name: "Studio", props: { kind: "original", status: "approved", storageKey: store.put(TENANT, sha256Hex(photo), photo) } }, NOW);
  }, 60_000);
  afterAll(async () => { await cleanup(); await closeAll(); rmSync(dir, { recursive: true, force: true }); });

  // Fact Checker reads each frame back as it was set (S1..Sn and END)
  const nisha = (over: Record<string, Record<string, unknown>> = {}) => new FakeVision({ "fact-checker": (i: VisionInput) => nishaReads(over as never)(i) });
  const deps = (over: Partial<CreativeDeps> = {}, engine = new FakeCreativeEngine()) => ({ store, vision: nisha(), engine, maxCreditsPerRequest: 10, spent: { credits: 0 }, video, ...over }) as CreativeDeps & { video: typeof video };
  const job = (plan: ReelPlan, confirmSpend = false) => ({ tenant: TENANT, businessId: BIZ, agentId: "chief-of-staff", turnId: `r${++n}`, now: NOW + n * 1000, question: "a reel about a morning at the studio, Kestrel & Oak, Bristol", plan, confirmSpend });

  it("prices a plan that needs new pictures and stops before spending anything", async () => {
    const engine = new FakeCreativeEngine();
    const r = await makeReelDraft(g, job(normaliseReelPlan(skillPlan(), "skill")), deps({}, engine));
    expect(r).toMatchObject({ status: "priced", priceCredits: 1.5, spentCredits: 0 });
    expect(r.why).toMatch(/would cost 1.5 image credits .*say OK/);
    expect(engine.generated).toHaveLength(0);
  });

  it("makes the reel draft once agreed: 1080x1920, the words on every scene, the hook on frame one, the logo on the end card", async () => {
    const engine = new FakeCreativeEngine();
    const r = await makeReelDraft(g, job(normaliseReelPlan(skillPlan(), "skill"), true), deps({}, engine));
    expect(r.status).toBe("made");
    expect(r.spentCredits).toBe(1.5);
    expect(engine.generated[0]!.prompt).toMatch(/no text, no letters/);
    expect(r.verdicts.map((v) => [v.label, v.badge])).toEqual([["S1", "ok"], ["S2", "ok"], ["S3", "ok"], ["END", "ok"]]);
    const [a] = await g.roQuery<{ key: string; mime: string; w: number; h: number; check: string; seconds: number }>(
      "MATCH (a:Asset {kind:'clip'}) RETURN a.storageKey AS key, a.mime AS mime, a.w AS w, a.h AS h, a.check AS check, a.seconds AS seconds LIMIT 1");
    expect(a).toMatchObject({ mime: "video/mp4", w: 1080, h: 1920, check: "ok", seconds: 9 });
    const mp4 = store.get(TENANT, a!.key)!;
    const tmp = join(dir, "check.mp4");
    writeFileSync(tmp, mp4);
    const probe = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate:format=duration", "-of", "json", tmp]).toString();
    const info = JSON.parse(probe) as { streams: Array<{ width: number; height: number; r_frame_rate: string }>; format: { duration: string } };
    expect(info.streams[0]).toMatchObject({ width: 1080, height: 1920, r_frame_rate: "30/1" });
    expect(Number(info.format.duration)).toBeCloseTo(9, 0);
    // lineage: it derives from the approved picture and uses the logo file
    expect(await g.roQuery("MATCH (c:Asset {kind:'clip'})-[:DERIVED_FROM]->(:Asset {id:'asset:photo-1'}) RETURN c.id")).not.toHaveLength(0);
    expect(await g.roQuery("MATCH (c:Asset {kind:'clip'})-[:USES_ASSET]->(:BrandAsset {kind:'logo'}) RETURN c.id")).not.toHaveLength(0);
    // the end card frame is the brand's deep colour with the logo in the middle (one confident close, not a pale card)
    const endFrame = await frameAt(video, mp4, 8);
    const stats = await sharp(endFrame).extract({ left: 0, top: 0, width: 200, height: 200 }).stats();
    expect(stats.channels[0]!.mean).toBeLessThan(60);
    expect(r.notes.join(" ")).toMatch(/no sound/);
  }, 120_000);

  it("keeps every word inside the band the app leaves free", async () => {
    const kit = await loadComposeKit(g, BIZ, { store, tenant: TENANT, businessId: BIZ, now: NOW });
    const o = await sceneOverlay(kit.brand, { onScreen: "Materials, chosen by hand, for every room", hook: "A morning at the studio" });
    for (const t of o.texts) {
      expect(t.box.y).toBeGreaterThanOrEqual(SAFE_TOP);
      expect(t.box.y + t.box.h).toBeLessThanOrEqual(REEL_H - SAFE_BOTTOM);
      expect(t.box.x + t.box.w).toBeLessThanOrEqual(REEL_W);
    }
  });

  it("repairs a scene whose new picture came back with lettering: a brand card, assembled again, checked again", async () => {
    let looks = 0;
    const vision = new FakeVision({ "fact-checker": (i: VisionInput) => { looks++; return nishaReads(looks === 1 ? { S2: { extraText: ["OPEN 24H"] } } : {})(i); } });
    const r = await makeReelDraft(g, job(normaliseReelPlan(skillPlan(), "skill"), true), deps({ vision }));
    expect(looks).toBe(2);
    expect(r.repaired.join(" ")).toMatch(/scene 2: .*OPEN 24H.*brand card/);
    expect(r.verdicts.every((v) => v.badge === "ok")).toBe(true);
  }, 120_000);

  it("is free and makes nothing new when the plan uses only approved pictures and cards; says when the engine is away", async () => {
    const engine = new FakeCreativeEngine();
    engine.statusNow = { ok: false, reason: "no_credits", plain: "there are no Higgsfield credits left" };
    const r = await makeReelDraft(g, job(normaliseReelPlan(skillPlan(), "skill")), deps({}, engine));
    expect(r).toMatchObject({ status: "made", priceCredits: 0, spentCredits: 0 });
    expect(r.notes.join(" ")).toMatch(/Scene 2 uses a brand card instead of a new picture: there are no Higgsfield credits left/);
  }, 120_000);

  it("refuses words nobody gave, and says when this server cannot make video", async () => {
    const bad = await makeReelDraft(g, job(normaliseReelPlan(skillPlan({ scenes: [{ seconds: 2, onScreen: "50% off this week", visual: { kind: "card" } }, { seconds: 2, onScreen: "Book now", visual: { kind: "card" } }] }), "skill")), deps());
    expect(bad).toMatchObject({ status: "refused" });
    expect(bad.why).toMatch(/50%/);
    const none = await makeReelDraft(g, job(normaliseReelPlan(skillPlan(), "skill")), deps({ video: { available: async () => false, run: async () => {} } } as never));
    expect(none).toMatchObject({ status: "no_video" });
    expect(none.why).toMatch(/ffmpeg/);
  }, 60_000);
});
