// "Make this a premium ad": a rough product photo becomes a premium, UGC-style ad picture (Higgsfield's product-photoshoot backend)
// and then a 5 second vertical clip, both on the pending card, with the job, its cost, the rules and the chain written into the
// business's graph and read back by a traversal. Fake engine, fake CLI, fake vision: no credits, no network.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { GraphHandle } from "../../src/graph/client.js";
import { closeAll } from "../../src/graph/client.js";
import { studioCard } from "../../src/studio/approve.js";
import { ClipService, CLIP_PROMPT_AD } from "../../src/studio/clip.js";
import { CreditLedger } from "../../src/studio/credits.js";
import { ChainEngine, FakeEngine, RecordedEngine, type GenerationEngine } from "../../src/studio/engine.js";
import { HiggsfieldEngine, PHOTOSHOOT_MODEL } from "../../src/studio/higgsfield.js";
import { assetLineage, SPEND_METRIC } from "../../src/studio/lineage.js";
import { chooseMode, makePremiumAd, premiumIntent } from "../../src/studio/premium.js";
import { runStudio } from "../../src/studio/pipeline.js";
import { routeRequest } from "../../src/studio/request.js";
import { AssetStore } from "../../src/studio/store.js";
import { FakeVision } from "../../src/studio/vision.js";
import { fakeCli } from "../helpers/fake-higgsfield.js";
import { testGraph } from "../helpers/graph.js";
import { BIZ, DEV_ANSWER, facadePhoto, NOW, seedBrand, TARA_ANSWER } from "./fixtures.js";

describe("what asks for a premium ad", () => {
  it("premium, UGC and lifestyle words are a premium ad, with the message the owner gave", () => {
    for (const w of ["make this a premium ad", "turn this into a UGC style ad", "I want a lifestyle shot of this", "make this look luxury, for Instagram", "give me a proper photoshoot of this"]) {
      expect(routeRequest(w).kind, w).toBe("premium");
    }
    expect(routeRequest("make this into a premium ad saying \"Fresh every morning\"")).toMatchObject({ kind: "premium", headline: "Fresh every morning" });
  });
  it("light and colour, plain ads and clips keep their own routes", () => {
    expect(routeRequest("make it warmer").kind).toBe("adjust");
    expect(routeRequest("make this into an ad saying \"Free site visit\"").kind).toBe("ad");
    expect(routeRequest("make a short reel from this").kind).toBe("clip");
    expect(routeRequest("make it festive").kind).toBe("generate");
  });
  it("picks the photoshoot mode from the words: a lifestyle scene unless they ask for hands, a studio shot or an ad pack", () => {
    expect(chooseMode("premium UGC ad")).toBe("lifestyle_scene");
    expect(chooseMode("a close-up with a hand holding it")).toBe("closeup_product_with_person");
    expect(chooseMode("clean white background for my shop")).toBe("product_shot");
    expect(chooseMode("a Meta ads pack")).toBe("ad_creative_pack");
  });
});

describe("the premium ad, end to end (fake engine)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  const dirs: string[] = [];
  let clock = NOW;
  const now = () => (clock += 1000);
  const fail = new Set<string>();
  let seq = 0;

  const nisha = (input: { images: Array<{ label: string }>; prompt: string }) => ({
    variants: input.images.filter((i) => !["original", "frame"].includes(i.label)).map((i) => fail.has(i.label)
      ? { label: i.label, sameBuilding: false, structuralChange: true, added: ["a second label"], removed: [], note: "the label changed" }
      : { label: i.label, sameBuilding: true, structuralChange: false, added: [], removed: [], note: "same product in a new scene; label intact" }),
  });

  async function world(o: { engine?: GenerationEngine; overlays?: unknown[] } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "allevia-premium-"));
    dirs.push(dir);
    const store = new AssetStore(dir);
    const overlays = o.overlays ?? TARA_ANSWER.overlays.filter((x) => x.kind === "lock");
    const vision = new FakeVision({ "content-strategist": { ...TARA_ANSWER, subjectKind: "product", subject: "a glass jar of honey with a paper label", overlays }, "fact-checker": nisha as never, "copy-editor": DEV_ANSWER });
    const engine = new FakeEngine(async (i) => sharp(i.image).modulate({ brightness: 1.2 }).jpeg().toBuffer(), { credits: 6.5 });
    const r = await runStudio(g, { tenant: "kestrel_oak", businessId: BIZ, bytes: await facadePhoto({ tilt: 3 + (++seq) * 0.019, gps: false }), note: "" }, { store, vision, engine: new FakeEngine(async (i) => sharp(i.image).jpeg().toBuffer(), { credits: 2 }), now }, () => undefined);
    const deps = { store, vision, engine: o.engine ?? engine, now: now() };
    return { r, deps, engine, vision, store, dir, ids: { tenant: "kestrel_oak", businessId: BIZ, approvalId: r.approvalId } };
  }

  beforeAll(async () => { ({ g, cleanup } = await testGraph()); await seedBrand(g); }, 60_000);
  afterAll(async () => { await cleanup(); await closeAll(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

  it("asks the backend for a lifestyle scene about the right business and product, checks the PRODUCT, and offers the picture on the card", async () => {
    fail.clear();
    const w = await world();
    const out = await makePremiumAd(g, { ...w.ids, request: { words: "make this a premium UGC ad" } }, w.deps);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.mode).toBe("lifestyle_scene");
    expect(out.variant).toMatchObject({ label: "C", aiEdited: true, engine: "fake", credits: 6.5 });
    expect(out.passed).toBe(true);
    // what the engine was asked
    const shot = (w.engine as FakeEngine).shoots.at(-1)!;
    expect(shot.opts).toMatchObject({ mode: "lifestyle_scene", aspect: "4:5" });
    expect(shot.intent).toContain("Kestrel & Oak");
    expect(shot.intent).toMatch(/premium, UGC-style Instagram ad/);
    expect(shot.intent).toMatch(/add no text, logos or numbers of your own/);
    expect(shot.opts.productContext).toContain("a glass jar of honey");
    const m = await sharp(shot.input.image).metadata();
    expect(m.width! / m.height!).toBeCloseTo(0.8, 1); // the straightened 4:5 frame, the reference the product must match
    // Nisha was asked about the product, not the building, and a new scene is allowed
    const nishaCall = w.vision.calls.filter((c) => c.agent === "fact-checker").at(-1)!;
    expect(nishaCall.system).toMatch(/same product/);
    expect(nishaCall.prompt).toMatch(/a new setting, background and surface/);
    expect(nishaCall.prompt).toMatch(/Not allowed: a different or redesigned product/);
    // the card offers it and recommends it
    const card = (await studioCard(g, w.r.approvalId))!;
    expect(card.payload.studio.variants.find((v) => v.label === "C")).toMatchObject({ aiEdited: true, badge: "unchanged", credits: 6.5 });
    expect(card.payload.studio.recommended).toBe(out.variant.id);
    expect(card.payload.studio.variants.find((v) => v.label === "C")!.note).toMatch(/^Product unchanged/);
  }, 60_000);

  it("writes the chain into the graph: the job, its cost, the rules it was built from, Nisha's check, and reads it back as lineage", async () => {
    fail.clear();
    const w = await world();
    const out = await makePremiumAd(g, { ...w.ids, request: { words: "premium UGC ad" } }, w.deps);
    if (!out.ok) throw new Error(out.message);
    const L = await assetLineage(g, out.variant.id);
    expect(L.root).toMatchObject({ id: out.variant.id, step: "premium-ad", aiEdited: true, badge: "unchanged" });
    expect(L.ancestors.map((a) => a.kind)).toEqual(["original"]); // the owner's photo it was made from
    expect(L.steps).toEqual([{ from: out.variant.id, to: w.r.original.id, step: "premium-ad" }]);
    expect(L.jobs).toHaveLength(1);
    expect(L.jobs[0]).toMatchObject({ assetId: out.variant.id, model: "fake-photoshoot", credits: 6.5, mode: "lifestyle_scene" });
    expect(L.spent).toBe(6.5);
    expect(L.rules.map((r) => r.ruleId)).toEqual(expect.arrayContaining(["brand-rule:tone-of-voice", "brand-rule:visual-style"]));
    expect(L.reviews.some((r) => r.by.endsWith("fact-checker") && r.verdict === "ok")).toBe(true);
    expect(L.cards.map((c) => c.approvalId)).toContain(w.r.approvalId);
    // the spend is an Observation that MEASURES the asset and is SOURCED_FROM the job's Document
    const [spend] = await g.roQuery<{ v: number; doc: string }>(
      `MATCH (o:Observation {metric:$m})-[:MEASURES]->(a:Asset {id:$id}) MATCH (o)-[:SOURCED_FROM]->(d:Document {kind:'generation'}) RETURN o.value AS v, d.id AS doc ORDER BY d.id LIMIT 1`, { m: SPEND_METRIC, id: out.variant.id });
    expect(spend!.v).toBe(6.5);
    expect(spend!.doc).toMatch(/^document:higgsfield-job-/);
  }, 60_000);

  it("a picture whose product changed is held back and cannot be the pick", async () => {
    const w = await world();
    fail.add("C");
    const out = await makePremiumAd(g, { ...w.ids, request: { words: "premium ad" } }, w.deps);
    fail.clear();
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.passed).toBe(false);
    expect(out.fidelity.note).toMatch(/^Changed: .*not the same product/);
    const card = (await studioCard(g, w.r.approvalId))!;
    expect(card.payload.studio.recommended).not.toBe(out.variant.id);
    expect(card.payload.studio.variants.find((v) => v.label === "C")!.badge).toBe("changed");
  }, 60_000);

  it("the owner's message is drawn by code on the picture, never generated", async () => {
    fail.clear();
    const w = await world();
    const out = await makePremiumAd(g, { ...w.ids, request: { words: "premium ad", headline: "Fresh every morning", sub: "Raw honey, Bristol" } }, w.deps);
    if (!out.ok) throw new Error(out.message);
    const [a] = await g.roQuery<{ h: string; s: string; instr: string }>("MATCH (a:Asset {id:$id}) RETURN a.adHeadline AS h, a.adSub AS s, a.instruction AS instr", { id: out.variant.id });
    expect(a).toMatchObject({ h: "Fresh every morning", s: "Raw honey, Bristol" });
    expect((w.engine as FakeEngine).shoots.at(-1)!.intent).not.toContain("Fresh every morning"); // the model is never given the words
  }, 60_000);

  it("a photo with a child never goes to the engine; an engine with no ad styling says so; a decline is plain", async () => {
    const child = await world({ overlays: [...TARA_ANSWER.overlays.filter((o) => o.kind === "lock"), { kind: "privacy", x: 0.1, y: 0.55, w: 0.12, h: 0.25, note: "a child by the gate" }] });
    const c = await makePremiumAd(g, { ...child.ids, request: { words: "premium ad" } }, child.deps);
    expect(c).toMatchObject({ ok: false, reason: "child" });
    expect((child.engine as FakeEngine).shoots).toEqual([]);
    const recorded = await world({ engine: new RecordedEngine(join(tmpdir(), "no-such-manifest.json")) });
    const r = await makePremiumAd(g, { ...recorded.ids, request: { words: "premium ad" } }, recorded.deps);
    expect(r).toMatchObject({ ok: false, reason: "declined" });
    expect(!r.ok && r.message).toMatch(/isn't switched on/);
    const none = await world({ engine: new ChainEngine([new RecordedEngine(join(tmpdir(), "no-such-manifest.json"))]) });
    expect(await makePremiumAd(g, { ...none.ids, request: { words: "premium ad" } }, none.deps)).toMatchObject({ ok: false });
  }, 90_000);

  it("the intent names the business, the product, the mode and asks for no text of its own", async () => {
    const w = await world();
    const a = (await import("../../src/studio/assess.js")).parseAssessment(TARA_ANSWER);
    const { loadStudioContext } = await import("../../src/studio/context.js");
    const ctx = await loadStudioContext(g, BIZ, "");
    const p = premiumIntent(ctx, a, { words: "for my Diwali sale", mode: "closeup_product_with_person" });
    expect(p.intent).toContain("a close-up with hands holding the product");
    expect(p.intent).toContain("for my Diwali sale");
    expect(p.brandContext).toContain("Kestrel & Oak");
    void w;
  }, 60_000);

  it("the clip from a premium picture uses the ad motion prompt, is attached to the card as an extra, and is part of the lineage and the spend", async () => {
    fail.clear();
    const w = await world();
    const out = await makePremiumAd(g, { ...w.ids, request: { words: "premium UGC ad" } }, w.deps);
    if (!out.ok) throw new Error(out.message);
    const cli = fakeCli({ cost: 5, resultUrl: "https://cdn.example.test/out.mp4" });
    const ledger = new CreditLedger(w.dir, { now: () => NOW });
    const video = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(400, 7)]);
    const hf = new HiggsfieldEngine({ cli: cli.run, ledger, caps: { run: 5, daily: 25 }, balanceFloor: 20, tmpRoot: w.dir, fetchImage: async () => video, timeouts: { account: 1000, cost: 1000, create: 1000, wait: 2000 } });
    const clip = new ClipService({ g, store: w.store, engine: hf, now });
    const made = await clip.make({ ...w.ids, variantId: out.variant.id });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const create = cli.calls.find((c) => c.includes("create"))!;
    expect(create).toContain(CLIP_PROMPT_AD);
    expect(created(cli.calls)).toBe(1);
    // on the card, next to the options, and it is not itself a choice
    const card = (await studioCard(g, w.r.approvalId))!;
    expect(card.payload.studio.extras).toEqual([expect.objectContaining({ id: made.assetId, kind: "clip", from: out.variant.id, seconds: 5, credits: 5 })]);
    expect(card.payload.studio.variants.some((v) => v.id === made.assetId)).toBe(false);
    // the chain: original <- premium picture <- clip, with both jobs and both costs
    const L = await assetLineage(g, made.assetId);
    expect(L.ancestors.map((a) => a.id)).toEqual([out.variant.id, w.r.original.id]);
    expect(L.steps.map((s) => s.step)).toEqual(["clip", "premium-ad"]);
    expect(L.jobs.map((j) => j.mode).sort()).toEqual(["clip", "lifestyle_scene"]);
    expect(L.spent).toBe(5 + 6.5);
    // and from the original, everything made from it
    const down = await assetLineage(g, w.r.original.id);
    expect(down.descendants.map((a) => a.id)).toEqual(expect.arrayContaining([out.variant.id, made.assetId]));
  }, 90_000);
});

const created = (calls: string[][]): number => calls.filter((c) => c.includes("create")).length;

describe("the Higgsfield engine's premium picture (fake CLI)", () => {
  const dirs: string[] = [];
  afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
  const input = async () => ({ image: await sharp({ create: { width: 400, height: 500, channels: 3, background: "#789" } }).jpeg().toBuffer(), mime: "image/jpeg" as const, originalSha256: "abc123", tenant: "kestrel_oak" });
  const opts = { mode: "lifestyle_scene" as const, treatment: "premium-ad:lifestyle_scene:k1", aspect: "4:5" as const, brandContext: "Kestrel, Bristol.", productContext: "a jar of honey" };
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(300, 1)]);

  function engine(cli: ReturnType<typeof fakeCli>, caps = { run: 5, daily: 25 }) {
    const dir = mkdtempSync(join(tmpdir(), "allevia-hfp-"));
    dirs.push(dir);
    const ledger = new CreditLedger(dir, { now: () => NOW });
    return { hf: new HiggsfieldEngine({ cli: cli.run, ledger, caps, balanceFloor: 20, tmpRoot: dir, fetchImage: async () => png, timeouts: { account: 1000, cost: 1000, create: 1000, wait: 2000 } }), ledger };
  }

  it("the backend writes the prompt (enhance-only, free); the photo goes to gpt_image_2 as the reference; quoted, capped and counted", async () => {
    const cli = fakeCli({ cost: 6.5 });
    const { hf, ledger } = engine(cli);
    const q = await hf.quotePhotoshoot(await input(), "premium ad for honey", { ...opts, maxCredits: 8 });
    expect(q).toMatchObject({ credits: 6.5, words: "about 6.5 Studio credits" });
    expect(cli.created).toEqual([]);
    const r = await hf.photoshoot(await input(), "premium ad for honey", { ...opts, maxCredits: 8 });
    expect(r).toMatchObject({ engine: "higgsfield", model: PHOTOSHOOT_MODEL, credits: 6.5, recorded: false });
    expect(r.prompt).toContain("[SCENE]"); // the backend's prompt, not ours
    const enhance = cli.calls.find((c) => c.includes("product-photoshoot"))!;
    expect(enhance).toEqual(expect.arrayContaining(["--mode", "lifestyle_scene", "--enhance-only", "--aspect_ratio", "4:5", "--brand_context", "Kestrel, Bristol.", "--product_context", "a jar of honey"]));
    expect(enhance).not.toContain("--image"); // the free prompt step needs no picture
    const create = cli.calls.find((c) => c.includes("generate") && c.includes("create"))!;
    expect(create[create.indexOf("create") + 1]).toBe("gpt_image_2");
    expect(create).toContain("--image");
    expect(create[create.indexOf("--resolution") + 1]).toBe("2k");
    expect(create[create.indexOf("--prompt") + 1]).toMatch(/keep its shape, colour, material, label and logo/);
    expect(ledger.spentOn()).toBe(6.5);
    // the same request again joins the job: no second prompt, no second charge
    const again = await hf.photoshoot(await input(), "premium ad for honey", { ...opts, maxCredits: 8 });
    expect(again.jobId).toBe(r.jobId);
    expect(cli.created).toHaveLength(1);
    expect(cli.calls.filter((c) => c.includes("product-photoshoot"))).toHaveLength(1);
    expect(ledger.spentOn()).toBe(6.5);
  });

  it("refuses above its own cap with a plain sentence and spends nothing; a dead prompt writer spends nothing either", async () => {
    const cli = fakeCli({ cost: 6.5 });
    const { hf, ledger } = engine(cli);
    await expect(hf.photoshoot(await input(), "premium ad", { ...opts, maxCredits: 5 })).rejects.toMatchObject({ code: "run-cap" });
    expect(ledger.spentOn()).toBe(0);
    const down = fakeCli({ cost: 6.5, enhanceFails: true });
    const e2 = engine(down);
    await expect(e2.hf.photoshoot(await input(), "premium ad", { ...opts, maxCredits: 8 })).rejects.toMatchObject({ code: "unavailable" });
    expect(down.created).toEqual([]);
    expect(e2.ledger.spentOn()).toBe(0);
  });
});
