// The tools that create, called the way the runtime calls them (args validated by the tool's own shape): a poster with the
// real logo, a picture, a reel script and a priced clip, copy, and the brand library read. Each says exactly what happened,
// raises a card instead of posting, and refuses in plain words when it cannot or should not.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ToolResult } from "../../../shared/contracts.js";
import { TouchedSet, type AlleviaTool, type ToolContext } from "../../../src/agent/tool.js";
import { getBrandAsset } from "../../../src/agent/tools/brand.js";
import { writeCopyTool } from "../../../src/agent/tools/copy.js";
import { generateImageTool, makePosterTool, makeReelTool } from "../../../src/agent/tools/creative.js";
import type { CreativeDeps } from "../../../src/creative/ports.js";
import { closeAll, type GraphHandle } from "../../../src/graph/client.js";
import { AssetStore } from "../../../src/studio/store.js";
import { upsertNode } from "../../../src/graph/upsert.js";
import { FakeVision } from "../../../src/studio/vision.js";
import { testGraph } from "../../helpers/graph.js";
import { FakeCreativeEngine, NOW, nishaReads, seedKit, TENANT } from "../../creative/helpers.js";

const SCRIPT = { title: "New menu", beats: [{ at: "0-2 s", onScreen: "New menu", voiceOver: "", film: "Steam over the pass in morning light" }, { at: "2-5 s", onScreen: "Starts Friday", voiceOver: "Starts Friday.", film: "The chef plates a dish" }], caption: "The new menu starts Friday!" };
const PICTURES = (over: Record<string, unknown> = {}) => (input: { images: Array<{ label: string }> }) => ({ pictures: input.images.map((i) => ({ label: i.label, lettering: [], defects: [], onBrief: true, note: "clean", ...over })) });

describe("the creating tools", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  let dir: string;
  let store: AssetStore;
  let engine: FakeCreativeEngine;
  let n = 0;

  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    dir = mkdtempSync(join(tmpdir(), "allevia-tools-"));
    store = new AssetStore(dir);
    await seedKit(g, store);
  }, 60_000);
  afterAll(async () => { await cleanup(); await closeAll(); rmSync(dir, { recursive: true, force: true }); });

  const vision = (extra: Record<string, unknown> = {}) => new FakeVision({ "fact-checker": (i: never) => ((i as { prompt: string }).prompt.includes("expected text") ? nishaReads()(i) : PICTURES()(i)), "content-strategist": SCRIPT, "copy-editor": { variants: [{ text: "The new menu starts Friday! Come hungry.", hashtags: ["newmenu"] }, { text: "Save 40% on the new menu", hashtags: [] }] }, ...extra });
  const deps = (over: Partial<CreativeDeps> = {}): CreativeDeps => ({ store, vision: vision(), engine, maxCreditsPerRequest: 6, spent: { credits: 0 }, ...over });
  const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
    graph: g, tenant: TENANT, turnId: `t-${++n}`, agentId: "chief-of-staff", asker: "person:founder", touched: new TouchedSet(), now: NOW + n * 1000,
    question: "I want a poster for Insta for the Diwali sale, 20% off, with my logo", creative: deps(), ...over,
  });
  const run = (tool: AlleviaTool, args: Record<string, unknown>, c: ToolContext): Promise<ToolResult & { data: Record<string, unknown> }> =>
    tool.run(z.object(tool.input).parse(args), c) as never;

  it("make_poster makes checked options with the real logo, raises a card, posts nothing, and says what it did", async () => {
    engine = new FakeCreativeEngine();
    const r = await run(makePosterTool, { brief: { goal: "offer", promoting: "Design consultation", audience: "homeowners in Bristol", cta: "Visit kestrel.example", placement: "insta_post", message: "A festival of light for your home", offer: "20% off" }, eyebrow: "Diwali sale", scene: ["warm lamps", "a brass diya"] }, ctx());
    expect(r.data).toMatchObject({ made: true, kind: "poster", posted: false, waitingForOk: true, format: "insta_portrait" });
    const options = r.data.options as Array<{ label: string; id: string; check: string; layout: string }>;
    expect(options.map((o) => o.check)).toEqual(["checked", "checked"]);
    expect(new Set(options.map((o) => o.layout)).size).toBe(2);
    expect(r.nodes.map((x) => x.id)).toEqual(expect.arrayContaining([options[0]!.id, r.data.approvalId as string]));
    expect(r.data.say).toMatch(/waiting for their OK/);
    const proposed = r.data.proposed as Array<{ approvalId: string }>;
    expect(proposed[0]!.approvalId).toBe(r.data.approvalId);
    expect((r.data.deliverable as { kind: string; options: unknown[] }).options).toHaveLength(2);
    expect(await g.roQuery("MATCH (a:Approval {id:$id, status:'pending'}) RETURN a.id", { id: r.data.approvalId })).toHaveLength(1);
  }, 60_000);

  it("make_poster refuses an invented claim in plain words and spends nothing", async () => {
    engine = new FakeCreativeEngine();
    const r = await run(makePosterTool, { brief: { goal: "offer", promoting: "Design consultation", audience: "homeowners in Bristol", cta: "Visit kestrel.example", placement: "insta_post", message: "Diwali sale", offer: "50% off" } }, ctx());
    expect(r.data).toMatchObject({ made: false, reason: "claims", nothingSpent: true });
    expect(String(r.data.why)).toMatch(/50%/);
    expect(engine.generated).toHaveLength(0);
  }, 60_000);

  it("the tools that make things say so when creating is not set up, and refuse in read-only mode", async () => {
    for (const [tool, args] of [[makePosterTool, { brief: {} }], [generateImageTool, { brief: {} }], [makeReelTool, { brief: {} }]] as const) {
      const { creative: _drop, ...bare } = ctx();
      const r = await run(tool, args, bare as ToolContext);
      expect(r.data).toMatchObject({ made: false });
      expect(String(r.data.why)).toMatch(/isn't set up/);
    }
    const ro = await run(makePosterTool, { brief: {} }, ctx({ readOnly: true })).then((x) => x, (e: Error) => ({ error: e.message }));
    expect(JSON.stringify(ro)).toMatch(/read-only/);
  }, 60_000);

  it("generate_image makes a picture, checked, with its model and cost on the Asset, and a card", async () => {
    engine = new FakeCreativeEngine();
    const r = await run(generateImageTool, { brief: { goal: "awareness", promoting: "Reading corners", placement: "insta_post" }, scene: "a quiet reading corner with a brass lamp at dusk", options: 2 }, ctx({ question: "make me a picture of a reading corner" }));
    expect(r.data).toMatchObject({ made: true, kind: "image", posted: false, imageEngineCredits: 3 });
    const [a] = await g.roQuery<{ k: string; credits: number; job: string; check: string }>("MATCH (a:Asset {kind:'image'}) RETURN a.kind AS k, a.hfCredits AS credits, a.hfJobId AS job, a.check AS check LIMIT 1");
    expect(a).toMatchObject({ k: "image", credits: 1.5, check: "ok" });
    expect(engine.generated[0]!.prompt).toMatch(/no text, no letters/);
  }, 60_000);

  it("generate_image says exactly why and makes nothing when the engine is not available: no stand-in picture", async () => {
    engine = new FakeCreativeEngine();
    engine.statusNow = { ok: false, reason: "no_credits", plain: "there are no Higgsfield credits left" };
    const before = (await g.roQuery("MATCH (a:Asset {kind:'image'}) RETURN a.id")).length;
    const r = await run(generateImageTool, { brief: { goal: "awareness", promoting: "Reading corners", placement: "insta_post" }, scene: "a lamp on a wooden table" }, ctx());
    expect(r.data).toMatchObject({ made: false, nothingMadeNothingCharged: true });
    expect(String(r.data.why)).toContain("there are no Higgsfield credits left");
    expect((await g.roQuery("MATCH (a:Asset {kind:'image'}) RETURN a.id")).length).toBe(before);
    const none = await run(generateImageTool, { brief: { goal: "awareness", promoting: "Reading corners", placement: "insta_post" }, scene: "a lamp on a wooden table" }, ctx({ creative: deps({ engine: null }) }));
    expect(String(none.data.why)).toMatch(/no image engine/);
  }, 60_000);

  it("generate_image holds back a picture that came out with lettering on it", async () => {
    engine = new FakeCreativeEngine();
    const r = await run(generateImageTool, { brief: { goal: "awareness", promoting: "Reading corners", placement: "insta_post" }, scene: "a shop front at dusk", options: 1 }, ctx({ creative: deps({ vision: vision({ "fact-checker": PICTURES({ lettering: ["OPEN"] }) }) }) }));
    const opts = r.data.options as Array<{ check: string; note: string }>;
    expect(opts[0]).toMatchObject({ check: "held back" });
    expect(opts[0]!.note).toMatch(/lettering/);
  }, 60_000);

  it("the reel tool writes the script, quotes the clip, and makes it only for an approved picture at a price that fits", async () => {
    engine = new FakeCreativeEngine();
    const idea = "a reel of the new menu starting Friday";
    // no picture yet: script only, and the owner is told what a clip needs
    const a = await run(makeReelTool, { brief: { goal: "sell", promoting: "The new menu", audience: "regulars", message: "The new menu starts Friday", cta: "Come in on Friday" }, idea }, ctx({ question: idea }));
    expect(a.data).toMatchObject({ made: true, kind: "reel", posted: false });
    expect(String(a.data.script)).toMatch(/0-2 s .*On screen: New menu.*Film: Steam over the pass/);
    expect((a.data.clip as { made: boolean; why: string }).made).toBe(false);
    expect((a.data.clip as { why: string }).why).toMatch(/approve one first/);
    expect(a.data.scriptCard).toBeTruthy();
    // a picture that is not approved: priced, not made
    await upsertNode(g, { type: "Asset", id: "asset:still-1", name: "Still", props: { kind: "image", status: "proposed", storageKey: store.put(TENANT, "a".repeat(64), Buffer.from("x"), "jpg") } }, NOW);
    const b = await run(makeReelTool, { brief: { goal: "sell", promoting: "The new menu", audience: "regulars", message: "The new menu starts Friday", cta: "Come in on Friday" }, idea, image_asset_id: "asset:still-1" }, ctx({ question: idea }));
    expect((b.data.clip as { priceInImageCredits: number; why: string })).toMatchObject({ priceInImageCredits: 7.5 });
    expect((b.data.clip as { why: string }).why).toMatch(/would cost 7.5 Higgsfield credits; say OK/);
    expect(engine.clips).toHaveLength(0);
    const c = await run(makeReelTool, { brief: { goal: "sell", promoting: "The new menu", audience: "regulars", message: "The new menu starts Friday", cta: "Come in on Friday" }, idea, image_asset_id: "asset:still-1", make_clip: true }, ctx({ question: idea }));
    expect((c.data.clip as { why: string }).why).toMatch(/isn't approved yet/);
    // approved: made, priced in the result, unchecked, with a card
    await upsertNode(g, { type: "Asset", id: "asset:still-1", name: "Still", props: { status: "approved" } }, NOW);
    const d = await run(makeReelTool, { brief: { goal: "sell", promoting: "The new menu", audience: "regulars", message: "The new menu starts Friday", cta: "Come in on Friday" }, idea, image_asset_id: "asset:still-1", make_clip: true }, ctx({ question: idea, creative: deps({ maxCreditsPerRequest: 10 }) }));
    expect(JSON.stringify(d.data.clip)).toContain("made\":true");
    expect(engine.clips).toHaveLength(1);
    expect(engine.clips[0]).toMatchObject({ seconds: 5, aspect: "9:16" });
    expect((d.data.deliverable as { kind: string }).kind).toBe("clip");
    expect(await g.roQuery("MATCH (a:Asset {kind:'clip', check:'unchecked'}) RETURN a.id")).toHaveLength(1);
    // too dear for this request: refused with the price
    engine.clipCost = 9;
    const e = await run(makeReelTool, { brief: { goal: "sell", promoting: "The new menu", audience: "regulars", message: "The new menu starts Friday", cta: "Come in on Friday" }, idea, image_asset_id: "asset:still-1", make_clip: true }, ctx({ question: idea })); // the default limit of 6 is below any clip
    expect((e.data.clip as { made: boolean; why: string }).made).toBe(false);
    expect((e.data.clip as { why: string }).why).toMatch(/9 credits, more than this request is allowed to use \(6\)/);
  }, 60_000);

  it("write_copy cleans the voice and flags a number nobody gave, without smuggling it in", async () => {
    const r = await run(writeCopyTool, { kind: "caption", brief: "the new menu starts Friday", options: 2 }, ctx({ question: "write a caption: the new menu starts Friday" }));
    const v = r.data.variants as Array<{ text: string; checkBeforeUsing?: string[] }>;
    expect(v[0]!.text).not.toContain("!");
    expect(v[1]!.checkBeforeUsing!.join(" ")).toMatch(/40%/);
    expect(r.data.say).toMatch(/word for word/);
  }, 60_000);

  it("get_brand_asset names what the library holds and what is missing", async () => {
    const r = await run(getBrandAsset, {}, ctx());
    expect((r.data.logo as { kind: string }).kind).toBe("logo");
    expect((r.data.assets as unknown[]).length).toBeGreaterThan(5);
    expect(JSON.stringify(r.data)).not.toContain("storageKey");
    const t = await testGraph();
    try {
      await upsertNode(t.g, { type: "Business", id: "business:kestrel-oak", name: "Kestrel & Oak" }, NOW);
      const none = await run(getBrandAsset, {}, ctx({ graph: t.g }));
      expect(none.data.logo).toBeNull();
      expect((none.data.missing as string[]).join(" ")).toMatch(/logo file/);
    } finally {
      await t.cleanup();
    }
  }, 60_000);
});
