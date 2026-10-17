// The 5 second clip option: priced before anything is spent, a 9:16 start frame fixed in code, silent and honest about what a
// clip cannot do, its own cap, never for a photo with a child, and the same ledger and daily cap as the image edits.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { GraphHandle } from "../../src/graph/client.js";
import { closeAll } from "../../src/graph/client.js";
import { CLIP_CAPS, ClipService, startFrame } from "../../src/studio/clip.js";
import { CreditLedger } from "../../src/studio/credits.js";
import { FakeEngine } from "../../src/studio/engine.js";
import { HiggsfieldEngine } from "../../src/studio/higgsfield.js";
import { runStudio } from "../../src/studio/pipeline.js";
import { AssetStore } from "../../src/studio/store.js";
import { FakeVision } from "../../src/studio/vision.js";
import { fakeCli, type FakeCliOpts } from "../helpers/fake-higgsfield.js";
import { testGraph } from "../helpers/graph.js";
import { BIZ, DEV_ANSWER, facadePhoto, NOW, seedBrand, TARA_ANSWER } from "./fixtures.js";

describe("the clip option (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  const dirs: string[] = [];
  let clock = NOW;
  const now = () => (clock += 1000);
  let seq = 0;
  const nisha = (input: { images: Array<{ label: string }> }) => ({
    variants: input.images.filter((i) => !["original", "frame"].includes(i.label)).map((i) => ({ label: i.label, sameBuilding: true, structuralChange: false, added: [], removed: [], note: "nothing added" })),
  });

  async function world(o: { overlays?: unknown[]; cli?: FakeCliOpts; cap?: number } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "allevia-clip-"));
    dirs.push(dir);
    const store = new AssetStore(dir);
    const overlays = o.overlays ?? TARA_ANSWER.overlays.filter((x) => x.kind === "lock");
    const vision = new FakeVision({ "content-strategist": { ...TARA_ANSWER, overlays }, "fact-checker": nisha as never, "copy-editor": DEV_ANSWER });
    const engine = new FakeEngine(async (i) => sharp(i.image).modulate({ brightness: 1.1 }).jpeg().toBuffer(), { credits: 2 });
    const r = await runStudio(g, { tenant: "kestrel_oak", businessId: BIZ, bytes: await facadePhoto({ tilt: 3 + (++seq) * 0.017, gps: false }), note: "" }, { store, vision, engine, now }, () => undefined);
    const fake = fakeCli({ cost: 7.5, resultUrl: "https://cdn.example.test/out.mp4", ...o.cli });
    const ledger = new CreditLedger(dir, { now: () => NOW });
    const video = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(400, 7)]);
    const hf = new HiggsfieldEngine({ cli: fake.run, ledger, caps: { run: 5, daily: 25 }, balanceFloor: 20, tmpRoot: dir, fetchImage: async () => video, timeouts: { account: 1000, cost: 1000, create: 1000, wait: 2000 } });
    const clip = new ClipService({ g, store, engine: hf, ...(o.cap !== undefined ? { cap: o.cap } : {}), now });
    return { r, clip, fake, ledger, store, video, ids: { tenant: "kestrel_oak", businessId: BIZ, approvalId: r.approvalId } };
  }

  beforeAll(async () => { ({ g, cleanup } = await testGraph()); await seedBrand(g); }, 60_000);
  afterAll(async () => { await cleanup(); await closeAll(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

  it("the start frame is 9:16 at 1080x1920, cropped to the middle", async () => {
    const f = await startFrame(await sharp({ create: { width: 1080, height: 1350, channels: 3, background: "#789" } }).jpeg().toBuffer());
    const m = await sharp(f).metadata();
    expect([m.width, m.height]).toEqual([1080, 1920]);
  });

  it("the offer quotes first, says what a clip cannot do, and spends nothing", async () => {
    const w = await world();
    const o = await w.clip.offer(w.ids);
    expect(o).toMatchObject({ ok: true, credits: 7.5, words: "about 7.5 Studio credits", label: "B" });
    expect(o.ok && o.message).toContain("about 7.5 Studio credits");
    expect(o.ok && o.message).toContain(CLIP_CAPS);
    expect(CLIP_CAPS).toMatch(/silent, with no text or voice-over/);
    expect(w.fake.created).toEqual([]);
    expect(w.ledger.spentOn()).toBe(0);
    const frame = w.fake.images.at(-1)!;
    expect(frame.existed).toBe(true);
  }, 60_000);

  it("making it: a 9:16, 5 second, silent request on the clip model; the clip is stored with its lineage and counted in the ledger", async () => {
    const w = await world();
    const out = await w.clip.make(w.ids);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const create = w.fake.calls.find((c) => c.includes("create"))!;
    expect(create[create.indexOf("--aspect_ratio") + 1]).toBe("9:16");
    expect(create[create.indexOf("--duration") + 1]).toBe("5");
    expect(create[create.indexOf("--sound") + 1]).toBe("off");
    expect(create).toContain("--start-image");
    expect(create).toContain("kling3_0");
    expect(out.credits).toBe(7.5);
    expect(out.video.equals(w.video)).toBe(true);
    expect(out.message).toContain("It used about 7.5 Studio credits.");
    expect(w.ledger.spentOn()).toBe(7.5);
    const [a] = await g.roQuery<{ kind: string; media: string; step: string; key: string; seconds: number; aspect: string }>(
      "MATCH (a:Asset {id:$id})-[:DERIVED_FROM]->(:Asset) RETURN a.kind AS kind, a.mediaType AS media, a.step AS step, a.storageKey AS key, a.seconds AS seconds, a.aspect AS aspect", { id: out.assetId });
    expect(a).toMatchObject({ kind: "final", media: "video", step: "clip", seconds: 5, aspect: "9:16" });
    expect(w.store.get("kestrel_oak", a!.key)!.equals(w.video)).toBe(true);
    // the same request again joins the job: nothing is charged twice
    const again = await w.clip.make(w.ids);
    expect(again.ok).toBe(true);
    expect(w.fake.created).toHaveLength(1);
    expect(w.ledger.spentOn()).toBe(7.5);
  }, 60_000);

  it("above the clip cap it is refused with the price said; the per-image cap does not apply to a clip", async () => {
    const w = await world({ cli: { cost: 9 } });
    const o = await w.clip.offer(w.ids);
    expect(o).toMatchObject({ ok: false });
    expect(!o.ok && o.message).toMatch(/about 9 Studio credits, more than the 8 Studio credits allowed/);
    expect((await w.clip.make(w.ids)).ok).toBe(false);
    expect(w.fake.created).toEqual([]);
  }, 60_000);

  it("not signed in: a plain sentence, nothing spent", async () => {
    const w = await world({ cli: { loggedIn: false } });
    const o = await w.clip.offer(w.ids);
    expect(!o.ok && o.message).toMatch(/isn't signed in right now/);
    expect(w.fake.created).toEqual([]);
  }, 60_000);

  it("a photo with a child never gets a clip", async () => {
    const kids = [...TARA_ANSWER.overlays.filter((x) => x.kind === "lock"), { kind: "privacy", x: 0.1, y: 0.55, w: 0.12, h: 0.25, note: "a child by the gate" }];
    const w = await world({ overlays: kids });
    const o = await w.clip.offer(w.ids);
    expect(!o.ok && o.message).toMatch(/AI edits aren't used on photos with children/);
    expect(w.fake.calls).toEqual([]);
  }, 60_000);

  it("only an option Fact Checker passed can become a clip", async () => {
    const w = await world();
    const o = await w.clip.offer({ ...w.ids, variantId: "asset:nope" });
    expect(!o.ok && o.message).toMatch(/needs an option Fact Checker has checked and passed/);
  }, 60_000);
});
