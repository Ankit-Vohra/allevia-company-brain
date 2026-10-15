// makePoster end to end on a throwaway graph with a fake engine and a fake Nisha: artwork through the capped engine, two
// layouts composed by code with the real logo, Nisha's check, assets with lineage, a card that Approve turns into a draft
// post; and every way it can fall short says so and still delivers what it can.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { approveStudioDraft, studioCard } from "../../src/studio/approve.js";
import { DecisionError, decide } from "../../src/server/approvals.js";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { makePoster, PosterRefused, type PosterRequest } from "../../src/creative/poster.js";
import type { CreativeDeps } from "../../src/creative/ports.js";
import { FakeVision } from "../../src/studio/vision.js";
import { AssetStore } from "../../src/studio/store.js";
import { sha256Hex } from "../../src/studio/image.js";
import { upsertNode } from "../../src/graph/upsert.js";
import { testGraph } from "../helpers/graph.js";
import { BIZ, FakeCreativeEngine, fakeVisionFor, NOW, nishaReads, seedKit, TENANT } from "./helpers.js";

describe("makePoster (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  let dir: string;
  let store: AssetStore;
  let engine: FakeCreativeEngine;
  let clock = NOW;
  const now = () => (clock += 1000);

  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    dir = mkdtempSync(join(tmpdir(), "allevia-poster-"));
    store = new AssetStore(dir);
    await seedKit(g, store);
  }, 60_000);
  afterAll(async () => {
    await cleanup();
    await closeAll();
    rmSync(dir, { recursive: true, force: true });
  });

  const deps = (over: Partial<CreativeDeps> = {}): CreativeDeps => ({ store, vision: fakeVisionFor(), engine, maxCreditsPerRequest: 6, spent: { credits: 0 }, ...over });
  const req = (over: Partial<PosterRequest> = {}): PosterRequest => ({
    tenant: TENANT, businessId: BIZ, agentId: "chief-of-staff", turnId: `t${clock}`, now: now(), question: "I want a poster for Insta for the Diwali sale, 20% off, with my logo",
    content: { eyebrow: "Diwali sale", headline: "A festival of light for your home", offer: "20% off" }, format: "insta_portrait", occasion: "offer", count: 2,
    scenes: ["warm lamps on a wooden table, soft evening light", "a quiet interior with a brass diya"], artwork: "generate", ...over,
  });
  const one = async <T>(cypher: string, params?: Record<string, unknown>) => (await g.roQuery<T>(cypher, params))[0]!;

  it("makes two options with different layouts and artwork, the real logo, checked, with lineage and a card", async () => {
    engine = new FakeCreativeEngine();
    const r = await makePoster(g, req(), deps());
    expect(r.saved.options).toHaveLength(2);
    expect(new Set(r.layouts).size).toBe(2); // different layouts
    expect(r.layouts[0]).toBe("badge-offer"); // an offer leads with a badge
    expect(engine.generated).toHaveLength(2);
    expect(engine.generated[0]!.prompt).toMatch(/no text, no letters/);
    expect(engine.generated[0]!.prompt).toContain("warm lamps");
    expect(engine.generated[0]!.prompt).not.toBe(engine.generated[1]!.prompt); // different artwork
    expect(r.hfCredits).toBe(3);
    expect(r.verdicts.map((v) => v.badge)).toEqual(["ok", "ok"]);
    expect(r.saved.options.every((o) => o.badge === "ok" && o.aiEdited)).toBe(true);
    // the files are real posters of the right size
    for (const o of r.saved.options) {
      const [a] = await g.roQuery<{ key: string; w: number; h: number; layout: string; logo: string }>("MATCH (a:Entity:Asset {id:$id}) RETURN a.storageKey AS key, a.w AS w, a.h AS h, a.layout AS layout, a.logoKind AS logo", { id: o.assetId });
      expect(a).toMatchObject({ w: 1080, h: 1350, logo: "file" });
      expect((await sharp(store.get(TENANT, a!.key)!).metadata()).width).toBe(1080);
    }
    // lineage: each poster derives from its own artwork, uses the logo and the font files, is guided by the brand rules, and was reviewed by Nisha
    const [first, second] = r.saved.options;
    const parents = await g.roQuery<{ p: string }>("MATCH (a:Asset)-[:DERIVED_FROM]->(p:Asset {kind:'artwork'}) WHERE a.id IN $ids RETURN p.id AS p ORDER BY p", { ids: [first!.assetId, second!.assetId] });
    expect(new Set(parents.map((x) => x.p)).size).toBe(2);
    expect(await g.roQuery("MATCH (:Asset {id:$id})-[:USES_ASSET]->(b:BrandAsset {kind:'logo'}) RETURN b.id", { id: first!.assetId })).toHaveLength(1);
    expect((await g.roQuery("MATCH (:Asset {id:$id})-[:USES_ASSET]->(b:BrandAsset) WHERE b.kind = 'font-file' RETURN b.id", { id: first!.assetId })).length).toBeGreaterThanOrEqual(2);
    expect(await g.roQuery("MATCH (:Asset {id:$id})-[:GUIDED_BY]->(r:BrandRule) RETURN r.id", { id: first!.assetId })).not.toHaveLength(0);
    expect(await g.roQuery("MATCH (:Agent {id:'agent:allevia-fact-checker'})-[:REVIEWED]->(:Asset {id:$id}) RETURN 1", { id: first!.assetId })).toHaveLength(1);
    expect(await g.roQuery("MATCH (:Agent {id:'agent:allevia-chief-of-staff'})-[:PRODUCED]->(:Asset {id:$id}) RETURN 1", { id: first!.assetId })).toHaveLength(1);
    // the artwork records what made it, with its job and its cost
    const art = await one<{ model: string; job: string; credits: number; prompt: string }>("MATCH (a:Asset {kind:'artwork'}) RETURN a.model AS model, a.hfJobId AS job, a.hfCredits AS credits, a.prompt AS prompt LIMIT 1");
    expect(art).toMatchObject({ model: "fake-image", credits: 1.5 });
    // the card waits for the owner and nothing is posted
    const card = await studioCard(g, r.saved.approvalId);
    expect(card!.status).toBe("pending");
    expect(card!.payload.studio.creative).toMatchObject({ kind: "poster", aspect: "4:5", channel: "instagram", by: "chief-of-staff", allowUnchecked: true });
    expect(card!.payload.studio.variants.map((v) => v.badge)).toEqual(["unchanged", "unchanged"]);
    expect(card!.payload.body).toContain("20% off");
  }, 60_000);

  it("approving an option writes a draft post that uses that poster, and nothing is published", async () => {
    engine = new FakeCreativeEngine();
    const r = await makePoster(g, req({ turnId: "t-approve" }), deps());
    const pick = r.saved.options[1]!;
    const decideWith = (id: string, edited?: { title: string; body: string; target: string }) => decide(g, TENANT, id, { decision: "approve", ...(edited ? { editedPayload: edited } : {}) }, { now: now(), actions: { config: { dataDir: dir } } });
    const out = await approveStudioDraft(g, { approvalId: r.saved.approvalId, variantId: pick.assetId, now: now() }, decideWith);
    const [row] = await g.roQuery<{ format: string; status: string; asset: string; made: string; by: string }>(
      "MATCH (c:Content {id:$id})-[:USES_ASSET]->(a:Asset) OPTIONAL MATCH (:Agent)-[:PRODUCED]->(c) RETURN c.format AS format, c.status AS status, a.id AS asset, c.madeAs AS made, c.createdBy AS by", { id: out.contentId });
    expect(row).toEqual({ format: "post", status: "draft", asset: pick.assetId, made: "poster", by: "creative" });
    expect((await one<{ s: string }>("MATCH (a:Asset {id:$id}) RETURN a.status AS s", { id: pick.assetId })).s).toBe("approved");
    await expect(approveStudioDraft(g, { approvalId: r.saved.approvalId, now: now() }, decideWith)).rejects.toThrow(DecisionError); // already decided
  }, 60_000);

  it("with no engine the layouts still stand on a brand-colour ground, and the result says exactly that", async () => {
    const r = await makePoster(g, req({ turnId: "t-noengine" }), deps({ engine: null }));
    expect(r.generated).toBe(0);
    expect(r.hfCredits).toBe(0);
    expect(r.saved.options.every((o) => !o.aiEdited)).toBe(true);
    expect(r.notes.join(" ")).toMatch(/no image engine/i);
    expect(r.notes.join(" ")).toMatch(/plain background in your brand colours/);
    expect(r.layouts).toEqual(["type-only", "split"]);
  }, 60_000);

  it("says why in plain words when the engine, credits or CLI is unavailable, and spends nothing", async () => {
    for (const [reason, plain] of [["no_cli", "the Higgsfield tool isn't installed on this computer"], ["not_signed_in", "the Higgsfield account isn't signed in"], ["no_credits", "there are no Higgsfield credits left"]] as const) {
      engine = new FakeCreativeEngine();
      engine.statusNow = { ok: false, reason, plain };
      const r = await makePoster(g, req({ turnId: `t-${reason}` }), deps());
      expect(engine.generated).toHaveLength(0);
      expect(r.notes.join(" ")).toContain(plain);
      expect(r.saved.options).toHaveLength(2); // still delivered
    }
  }, 60_000);

  it("refuses to go over the request's credit limit: quotes first, keeps what fits, and says so", async () => {
    engine = new FakeCreativeEngine();
    engine.cost = 4;
    const r = await makePoster(g, req({ turnId: "t-cap" }), deps({ maxCreditsPerRequest: 6 }));
    expect(engine.generated).toHaveLength(1); // 4 fits, 8 does not
    expect(r.hfCredits).toBe(4);
    expect(r.notes.join(" ")).toMatch(/1 piece of artwork, not 2/);
    expect(r.saved.options).toHaveLength(2); // the second layout reuses the artwork
    engine.cost = 9;
    const none = await makePoster(g, req({ turnId: "t-cap2" }), deps({ maxCreditsPerRequest: 6 }));
    expect(none.generated).toBe(0);
    expect(none.notes.join(" ")).toMatch(/more credits than this request is allowed/);
    // a request that already spent its credits cannot spend more
    engine.cost = 1.5;
    const spent = await makePoster(g, req({ turnId: "t-cap3" }), deps({ spent: { credits: 6 } }));
    expect(spent.generated).toBe(0);
  }, 60_000);

  it("a generation that fails is reported and that option falls back to the plain ground", async () => {
    engine = new FakeCreativeEngine();
    engine.failNext = 1;
    const r = await makePoster(g, req({ turnId: "t-fail" }), deps());
    expect(r.notes.join(" ")).toMatch(/failed|wasn't made/);
    expect(r.saved.options).toHaveLength(2);
  }, 60_000);

  it("never puts a claim on the poster that the owner did not make", async () => {
    engine = new FakeCreativeEngine();
    await expect(makePoster(g, req({ content: { headline: "Diwali sale", offer: "50% off", cta: "Visit evil.example" }, turnId: "t-claim" }), deps())).rejects.toThrow(PosterRefused);
    try {
      await makePoster(g, req({ content: { headline: "Free consultation for everyone" }, turnId: "t-claim2" }), deps());
    } catch (e) {
      expect((e as PosterRefused).code).toBe("claims");
      expect((e as PosterRefused).plain).toMatch(/free/);
    }
    expect(engine.generated).toHaveLength(0); // refused before any credit was spent
    // facts the business holds are fair: its own website and handle
    const ok = await makePoster(g, req({ content: { headline: "Diwali sale", offer: "20% off", cta: "Visit kestrel.example" }, turnId: "t-claim3" }), deps());
    expect(ok.saved.options).toHaveLength(2);
  }, 60_000);

  it("refuses a headline that cannot fit, naming what to shorten, before spending credits", async () => {
    engine = new FakeCreativeEngine();
    const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    await expect(makePoster(g, req({ content: { headline: long }, question: `a poster that says ${long}`, turnId: "t-fit" }), deps())).rejects.toMatchObject({ code: "fit" });
  }, 60_000);

  it("holds back an option Nisha found wrong, still lets an unchecked one be approved with a warning, and never approves a held one", async () => {
    engine = new FakeCreativeEngine();
    const held = await makePoster(g, req({ turnId: "t-held" }), deps({ vision: fakeVisionFor(nishaReads({ A: { garbled: true } })) }));
    expect(held.saved.options.map((o) => o.badge)).toEqual(["held", "ok"]);
    expect(held.saved.recommended).toBe(held.saved.options[1]!.assetId);
    const decideWith = (id: string) => decide(g, TENANT, id, { decision: "approve" }, { now: now(), actions: { config: { dataDir: dir } } });
    await expect(approveStudioDraft(g, { approvalId: held.saved.approvalId, variantId: held.saved.options[0]!.assetId, now: now() }, decideWith)).rejects.toThrow(/held/);
    const unchecked = await makePoster(g, req({ turnId: "t-unchecked" }), deps({ vision: new FakeVision({}) }));
    expect(unchecked.saved.options.map((o) => o.badge)).toEqual(["unchecked", "unchecked"]);
    expect(unchecked.notes.join(" ")).toMatch(/couldn't double-check/);
    await expect(approveStudioDraft(g, { approvalId: unchecked.saved.approvalId, now: now() }, decideWith)).resolves.toBeTruthy();
  }, 60_000);

  it("uses the owner's own photo as the hero when asked, with no engine call", async () => {
    engine = new FakeCreativeEngine();
    const photo = await sharp({ create: { width: 1200, height: 900, channels: 3, background: "#667788" } }).jpeg().toBuffer();
    const key = store.put(TENANT, sha256Hex(photo), photo);
    await upsertNode(g, { type: "Asset", id: "asset:owner-photo", name: "Photo", props: { kind: "original", storageKey: key, mime: "image/jpeg" } }, NOW);
    const r = await makePoster(g, req({ turnId: "t-photo", artwork: { photoAssetId: "asset:owner-photo" }, content: { headline: "New menu this week" }, occasion: "announcement" }), deps());
    expect(engine.generated).toHaveLength(0);
    expect(r.saved.options.every((o) => !o.aiEdited)).toBe(true);
    expect(await g.roQuery("MATCH (a:Asset {id:$id})-[:DERIVED_FROM]->(:Asset {id:'asset:owner-photo'}) RETURN 1", { id: r.saved.options[0]!.assetId })).toHaveLength(1);
    await expect(makePoster(g, req({ turnId: "t-photo2", artwork: { photoAssetId: "asset:nope" } }), deps())).rejects.toMatchObject({ code: "photo" });
  }, 60_000);

  it("without a logo file the name is set as a wordmark and the owner is asked once for the logo", async () => {
    const t = await testGraph();
    const s2 = new AssetStore(mkdtempSync(join(tmpdir(), "allevia-poster2-")));
    try {
      await seedKit(t.g, s2, { logo: false });
      const r = await makePoster(t.g, req({ turnId: "t-nologo" }), deps({ store: s2, engine: null }));
      expect(r.notes.join(" ")).toMatch(/don't have a logo file/);
      const [a] = await t.g.roQuery<{ k: string }>("MATCH (a:Asset {kind:'poster'}) RETURN a.logoKind AS k LIMIT 1");
      expect(a!.k).toBe("wordmark");
    } finally {
      await t.cleanup();
    }
  }, 60_000);

  it("a business's poster only uses its own files: another tenant's directory has none of them", async () => {
    const r = await makePoster(g, req({ turnId: "t-iso", engine: undefined } as never), deps({ engine: null }));
    const [a] = await g.roQuery<{ key: string }>("MATCH (a:Asset {id:$id}) RETURN a.storageKey AS key", { id: r.saved.options[0]!.assetId });
    expect(store.get("another_tenant", a!.key)).toBeNull();
    expect(store.get(TENANT, a!.key)).not.toBeNull();
  }, 60_000);
});
