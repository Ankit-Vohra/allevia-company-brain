// Caches on disk (data/cache/...) are keyed by content, and a content-keyed cache shared by every business is a place where
// one business's text or photo can meet another's. Each answer's key already carries the business context, so a hit
// across businesses needs identical text AND identical context; this pins the second line of defence: each business has
// its own folder, and a business that has no cache of its own never reads another's.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractDoc, cacheKey, type LlmRunner } from "../../src/ingest/extract.js";
import { makeAsk } from "../../src/ingest/sources/website/ask.js";
import type { RawDoc } from "../../src/ingest/types.js";
import { legacyCacheDir, tenantCacheDir } from "../../src/util/cache.js";
import sharp from "sharp";
import { openGraph } from "../../src/graph/client.js";
import { assessPhoto } from "../../src/studio/assess.js";
import { CachedVision, FakeVision, visionForGraph, visionKey, type VisionInput } from "../../src/studio/vision.js";
import { CRAFTED_SLUGS } from "./crafted.js";

let dataDir: string;
beforeAll(() => { dataDir = mkdtempSync(join(tmpdir(), "allevia-cache-")); });
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

const DOC: RawDoc = { id: "document:plan", kind: "note", title: "Plan", text: "We will buy Quillmark for four million.", hash: "h".repeat(64) };
const BUSINESS = { name: "Same Name Ltd", industry: "same industry" }; // two businesses can share a name

const countingRunner = (): LlmRunner & { calls: number } => {
  const r = {
    calls: 0,
    async structured() {
      r.calls++;
      return { entities: [{ type: "Product", name: "Quillmark", summary: "target" }], relations: [], observations: [] };
    },
  };
  return r as unknown as LlmRunner & { calls: number };
};

describe("cache folders", () => {
  it("are one per business, named from a valid slug only", () => {
    expect(tenantCacheDir("/d", "extract", "tenant_a")).toBe("/d/cache/extract/tenant_a");
    expect(tenantCacheDir("/d", "extract", "tenant_a")).not.toBe(tenantCacheDir("/d", "extract", "tenant_b"));
    for (const [what, slug] of CRAFTED_SLUGS) expect(() => tenantCacheDir("/d", "extract", slug), what).toThrow(/tenant slug/);
    expect(() => tenantCacheDir("/d", "extract", "meta")).toThrow(/tenant slug/);
  });

  it("the shared folder of earlier versions is read only for the founder's own businesses", () => {
    expect(legacyCacheDir("/d", "extract", "aamdani")).toBe("/d/cache/extract");
    expect(legacyCacheDir("/d", "extract", "avs_atelier")).toBe("/d/cache/extract");
    expect(legacyCacheDir("/d", "extract", "customer_x")).toBeUndefined();
  });
});

describe("the extraction cache", () => {
  it("one business's extraction is not served to another that sends the same text", async () => {
    const a = countingRunner();
    const b = countingRunner();
    const dirA = tenantCacheDir(dataDir, "extract", "tenant_a");
    const dirB = tenantCacheDir(dataDir, "extract", "tenant_b");
    expect((await extractDoc(DOC, BUSINESS, { runner: a, model: "haiku", cacheDir: dirA })).cached).toBe(false);
    expect((await extractDoc(DOC, BUSINESS, { runner: a, model: "haiku", cacheDir: dirA })).cached).toBe(true);
    expect((await extractDoc(DOC, BUSINESS, { runner: b, model: "haiku", cacheDir: dirB })).cached).toBe(false); // B asks the model itself
    expect(a.calls).toBe(1);
    expect(b.calls).toBe(1);
    expect(readdirSync(dirA)).toHaveLength(1);
    expect(readdirSync(dirB)).toHaveLength(1);
  });

  it("a customer's folder never falls back to the shared one; a founder business reads it once and keeps its own copy", async () => {
    const shared = join(dataDir, "cache", "extract");
    mkdirSync(shared, { recursive: true });
    const key = cacheKey(DOC, BUSINESS, "haiku");
    writeFileSync(join(shared, `${key}.json`), JSON.stringify({ extraction: { entities: [{ type: "Product", name: "FromShared", summary: "x" }], relations: [], observations: [] } }));

    const customer = countingRunner();
    const c = await extractDoc(DOC, BUSINESS, { runner: customer, model: "haiku", cacheDir: tenantCacheDir(dataDir, "extract", "customer_x") });
    expect(c.cached).toBe(false);
    expect(JSON.stringify(c.extraction)).not.toContain("FromShared");

    const founder = countingRunner();
    const f = await extractDoc(DOC, BUSINESS, {
      runner: founder, model: "haiku", cacheDir: tenantCacheDir(dataDir, "extract", "aamdani"), legacyCacheDir: legacyCacheDir(dataDir, "extract", "aamdani")!,
    });
    expect(f.cached).toBe(true);
    expect(founder.calls).toBe(0);
    expect(readdirSync(tenantCacheDir(dataDir, "extract", "aamdani"))).toEqual([`${key}.json`]); // copied in
  });
});

describe("the website questions' cache", () => {
  const input = { label: "brand", system: "s", schema: {}, data: "customer site text", after: "Answer." };
  it("is per business too", async () => {
    let calls = 0;
    const runner = { structured: async () => { calls++; return { v: calls }; } } as unknown as LlmRunner;
    const a = makeAsk(runner, { model: "haiku", cacheDir: tenantCacheDir(dataDir, "onboard", "tenant_a") });
    const b = makeAsk(runner, { model: "haiku", cacheDir: tenantCacheDir(dataDir, "onboard", "tenant_b") });
    expect(await a.structured(input)).toEqual({ v: 1 });
    expect(await a.structured(input)).toEqual({ v: 1 });
    expect(await b.structured(input)).toEqual({ v: 2 });
  });
});

describe("the photo-reading cache", () => {
  const photo = { label: "photo", mime: "image/jpeg" as const, data: Buffer.from("the same stock photo") };
  const input: VisionInput = { agent: "content-strategist", system: "s", prompt: "p", images: [photo], schema: {}, model: "sonnet" };

  it("an answer for one business's photo is not replayed for another business that sends the same bytes", async () => {
    const inner = new FakeVision({ "content-strategist": [{ n: 1 }, { n: 2 }, { n: 3 }] });
    const cache = new CachedVision(inner, join(dataDir, "cache", "studio"));
    const a = cache.forTenant("tenant_a");
    const b = cache.forTenant("tenant_b");
    expect(await a.see(input)).toEqual({ n: 1 });
    expect(await a.see(input)).toEqual({ n: 1 }); // A's repeat is a hit
    expect(await b.see(input)).toEqual({ n: 2 }); // B's identical photo is a miss, answered fresh
    expect(inner.calls).toHaveLength(2);
    expect(readdirSync(join(dataDir, "cache", "studio", "tenant_a"))).toHaveLength(1);
    expect(readdirSync(join(dataDir, "cache", "studio", "tenant_b"))).toHaveLength(1);
    expect(visionKey(input)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a crafted business name as a folder", () => {
    const cache = new CachedVision(new FakeVision({}), join(dataDir, "cache", "studio"));
    for (const [, slug] of CRAFTED_SLUGS) expect(() => cache.forTenant(slug)).toThrow(/tenant slug/);
  });
});

describe("whoever asks, a photo is read through the cache of the graph it belongs to", () => {
  const ctx = { businessName: "Same Name Ltd", w: 100, h: 100 };
  const answer = { subject: "a door", subjectKind: "building", angle: "front", lighting: "even", clutter: "none", resolution: "ok",
    quality: { tiltDeg: 0, exposure: "ok", cast: "none", sharpness: "ok" }, salvageable: [], locks: [], verdict: "good", overlays: [], textInImage: [], story: "s", caption: "c", altText: "a" };

  it("the Studio's reading steps (assess, and fidelity the same way) use the view for the graph they are given, so Discord, revisions and videos are covered too", async () => {
    const a = await openGraph("test_cache_a");
    const b = await openGraph("test_cache_b");
    const photo = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#808080" } }).jpeg().toBuffer();
    const inner = new FakeVision({ "content-strategist": [answer, { ...answer, subject: "second" }, { ...answer, subject: "third" }] });
    const cache = new CachedVision(inner, join(dataDir, "cache", "studio-g"));
    const ra = await assessPhoto(a, "asset:x", photo, ctx, { vision: cache, model: "sonnet", now: 1, record: false });
    const rb = await assessPhoto(b, "asset:x", photo, ctx, { vision: cache, model: "sonnet", now: 1, record: false });
    const ra2 = await assessPhoto(a, "asset:x", photo, ctx, { vision: cache, model: "sonnet", now: 1, record: false });
    expect(ra.subject).toBe("a door");
    expect(rb.subject).toBe("second"); // B asked its own, though A had already asked the same
    expect(ra2.subject).toBe("a door"); // A's repeat is A's hit
    expect(inner.calls).toHaveLength(2);
    expect(readdirSync(join(dataDir, "cache", "studio-g", "test_cache_a"))).toHaveLength(1);
    expect(readdirSync(join(dataDir, "cache", "studio-g", "test_cache_b"))).toHaveLength(1);
    expect(readdirSync(join(dataDir, "cache", "studio-g")).filter((n) => n.endsWith(".json"))).toEqual([]); // nothing in the shared folder
  });

  it("a view asked for again is itself, for another business is refused, and a scratch graph keeps the runner as it is", () => {
    const cache = new CachedVision(new FakeVision({}), join(dataDir, "cache", "studio-h"));
    const mine = cache.forTenant("tenant_a");
    expect(mine.forTenant?.("tenant_a")).toBe(mine);
    expect(() => mine.forTenant?.("tenant_b")).toThrow(/tenant_a's/);
    expect(visionForGraph(mine, "allevia_tenant_a")).toBe(mine);
    const plain = new FakeVision({});
    expect(visionForGraph(plain, "allevia_tenant_a")).toBe(plain); // a runner with no cache is its own view
    expect(visionForGraph(cache, "some_scratch_graph")).toBe(cache);
    expect(visionForGraph(cache, "allevia_meta")).toBe(cache); // not a business
  });
});
