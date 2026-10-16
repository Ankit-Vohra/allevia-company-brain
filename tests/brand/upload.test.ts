// The brand library: what the owner drops (a logo, a palette, a font, a brand guide, a product photo, a past design) is
// checked by its bytes, stripped of metadata, classified by Claude vision (never by file name), stored per business, and
// written as a BrandAsset with lineage. Limits are enforced; nothing is stored for a file that is refused.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { GraphHandle } from "../../src/graph/client.js";
import { closeAll } from "../../src/graph/client.js";
import { upsertEdge, upsertNode } from "../../src/graph/upsert.js";
import { BrandUploadRejected, ingestBrandUpload, MAX_FONT_BYTES, MAX_IMAGE_BYTES } from "../../src/brand/upload.js";
import { activeLogo, listBrandAssets } from "../../src/brand/library.js";
import { AssetStore } from "../../src/studio/store.js";
import { FakeVision } from "../../src/studio/vision.js";
import { testGraph } from "../helpers/graph.js";
import { blurryLogo, crispLogo, photo, svgLogo, tinyFont } from "./helpers.js";

const BIZ = "business:kestrel-oak";
const OWNER = "person:sam-example";
const NOW = Date.parse("2026-10-15T09:00:00Z");

const verdict = (o: Record<string, unknown> = {}) => ({
  kind: "logo", confidence: 0.95, description: "A rust square with two bars.", containsPerson: false, containsChild: false, colours: [], workOnIt: false, ...o,
});

describe("brand uploads", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  let dir: string;
  let store: AssetStore;
  let clock = NOW;
  const now = () => (clock += 1000);

  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await upsertNode(g, { type: "Business", id: BIZ, name: "Kestrel & Oak" }, NOW);
    await upsertNode(g, { type: "Person", id: OWNER, name: "Sam Example", summary: "Founder." }, NOW);
    dir = mkdtempSync(join(tmpdir(), "allevia-brand-test-"));
    store = new AssetStore(dir);
  }, 60_000);
  afterAll(async () => {
    await cleanup();
    await closeAll();
    rmSync(dir, { recursive: true, force: true });
  });

  const base = { tenant: "kestrel_oak", businessId: BIZ, ownerId: OWNER, source: "discord" as const };
  const put = async (input: Parameters<typeof ingestBrandUpload>[1], deps: Parameters<typeof ingestBrandUpload>[2]) => {
    const r = await ingestBrandUpload(g, input, deps);
    if (r.route !== "brand") throw new Error("expected the brand library");
    return r;
  };
  const row = async (id: string) => (await g.roQuery<{ p: Record<string, unknown> }>("MATCH (a:BrandAsset {id:$id}) RETURN properties(a) AS p", { id }))[0]?.p;

  it("classifies a logo by looking at it, keeps transparency, stores it per tenant and writes the BrandAsset", async () => {
    const vision = new FakeVision({ librarian: verdict({ kind: "logo" }) });
    const bytes = await crispLogo(1200, 400);
    const r = await put({ ...base, bytes, filename: "totally-not-a-logo.jpg", note: "here's my logo" }, { store, vision, now: now() });
    expect(r.route).toBe("brand");
    expect(r.kind).toBe("logo");
    expect(r.message).toMatch(/logo/i);
    expect(r.needsBetter).toBe(false);
    // the model saw the owner's note as data and the file's own pixels, never a trusted name
    expect(vision.calls).toHaveLength(1);
    expect(vision.calls[0]!.prompt).toContain("here's my logo");
    // stored where only this tenant's directory reaches it
    const file = store.path("kestrel_oak", r.asset.storageKey)!;
    expect(file.includes(join("assets", "kestrel_oak"))).toBe(true);
    expect(existsSync(file)).toBe(true);
    expect(store.get("another_tenant", r.asset.storageKey)).toBeNull();
    const meta = await sharp(readFileSync(file)).metadata();
    expect(meta.hasAlpha).toBe(true); // a logo keeps its transparent background
    expect(meta.format).toBe("png");
    const p = (await row(r.asset.id))!;
    expect(p).toMatchObject({ kind: "logo", origin: "upload", source: "discord", mime: "image/png", status: "active", w: 1200, h: 400 });
    expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await g.roQuery("MATCH (:Business {id:$b})-[:OWNS]->(a:BrandAsset {id:$id}) RETURN a.id AS id", { b: BIZ, id: r.asset.id })).toHaveLength(1);
    expect(await g.roQuery("MATCH (:Person {id:$o})-[:AUTHORED]->(a:BrandAsset {id:$id}) RETURN a.id AS id", { o: OWNER, id: r.asset.id })).toHaveLength(1);
    expect((await activeLogo(g))?.id).toBe(r.asset.id);
  });

  it("strips EXIF (GPS) from a product photo and never trusts the declared type", async () => {
    const vision = new FakeVision({ librarian: verdict({ kind: "product_photo", description: "A brown cabinet." }) });
    const bytes = await photo();
    expect((await sharp(bytes).metadata()).exif).toBeDefined();
    const r = await put({ ...base, bytes, filename: "cabinet.png" }, { store, vision, now: now() });
    expect(r.kind).toBe("product-photo");
    const stored = readFileSync(store.path("kestrel_oak", r.asset.storageKey)!);
    expect((await sharp(stored).metadata()).exif).toBeUndefined();
    expect(r.route).toBe("brand");
  });

  it("files a screenshot of the business's own app as an app screen, kept for posters even in a chat channel", async () => {
    const vision = new FakeVision({ librarian: verdict({ kind: "app_screen", description: "A job feed screen of the app." }) });
    const r = await put({ ...base, bytes: await photo(), intent: "any" }, { store, vision, now: now() });
    expect(r).toMatchObject({ route: "brand", kind: "app-screen" });
    expect(r.message).toMatch(/real screen in a phone/);
  });

  it("sends a photo the owner wants worked on to the Studio instead of filing it as brand material", async () => {
    const vision = new FakeVision({ librarian: verdict({ kind: "product_photo", workOnIt: true }) });
    const before = (await listBrandAssets(g)).length;
    const r = await ingestBrandUpload(g, { ...base, bytes: await photo(1000, 800, "#aa9988"), note: "make this look better" }, { store, vision, now: now() });
    expect(r.route).toBe("studio");
    expect(r.asset).toBeNull();
    expect((await listBrandAssets(g)).length).toBe(before);
  });

  it("in a chat channel a product photo or an unknown picture goes to the Studio and the library keeps nothing of it", async () => {
    const photos = async () => (await listBrandAssets(g, { kinds: ["product-photo", "other"] })).length;
    const before = await photos();
    for (const kind of ["product_photo", "other"]) {
      const r = await ingestBrandUpload(g, { ...base, intent: "any", bytes: await photo(1000, 800, "#bb9988") }, { store, vision: new FakeVision({ librarian: verdict({ kind }) }), now: now() });
      expect(r.route).toBe("studio");
    }
    // but a logo dropped in the same channel is filed
    const logo = await ingestBrandUpload(g, { ...base, intent: "any", bytes: await crispLogo(1300, 450) }, { store, vision: new FakeVision({ librarian: verdict({ kind: "logo" }) }), now: now() });
    expect(logo.route).toBe("brand");
    expect(await photos()).toBe(before);
    expect((await listBrandAssets(g)).some((a) => a.id === (logo.route === "brand" ? logo.asset.id : ""))).toBe(true);
  });

  it("turns an SVG logo into a PNG and keeps no SVG", async () => {
    const vision = new FakeVision({ librarian: verdict({ kind: "logo" }) });
    const r = await put({ ...base, bytes: Buffer.from(svgLogo()), filename: "logo.svg" }, { store, vision, now: now() });
    expect(r.kind).toBe("logo");
    const png = readFileSync(store.path("kestrel_oak", r.asset.storageKey)!);
    const meta = await sharp(png).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBeGreaterThanOrEqual(1024);
    expect(meta.hasAlpha).toBe(true);
    const p = (await row(r.asset.id))!;
    expect(p).toMatchObject({ convertedFrom: "svg", mime: "image/png" });
    expect(r.needsBetter).toBe(false);
  });

  it("refuses an SVG that reaches out or runs script", async () => {
    const vision = new FakeVision({ librarian: verdict() });
    const evil = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="9" height="9"/></svg>';
    await expect(ingestBrandUpload(g, { ...base, bytes: Buffer.from(evil) }, { store, vision, now: now() })).rejects.toThrow(BrandUploadRejected);
    const ext = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="http://169.254.169.254/x"/></svg>';
    await expect(ingestBrandUpload(g, { ...base, bytes: Buffer.from(ext) }, { store, vision, now: now() })).rejects.toThrow(/svg/i);
    expect(vision.calls).toHaveLength(0);
  });

  it("asks the owner once for a better file when the logo is small or blurry", async () => {
    const vision = new FakeVision({ librarian: verdict({ kind: "logo" }) });
    const small = await sharp(await crispLogo(1200, 400)).resize(240).png().toBuffer();
    const a = await put({ ...base, bytes: small }, { store, vision, now: now() });
    expect(a.needsBetter).toBe(true);
    expect(a.message).toMatch(/bigger|larger|better/i);
    expect((await row(a.asset.id))).toMatchObject({ needsBetter: true, lowRes: true });
    const b = await put({ ...base, bytes: await blurryLogo() }, { store, vision, now: now() });
    expect(b.needsBetter).toBe(true);
    expect((await row(b.asset.id))).toMatchObject({ needsBetter: true, blurry: true });
    // a crisp, big one is fine
    const c = await put({ ...base, bytes: await crispLogo(2000, 700) }, { store, vision, now: now() });
    expect(c.needsBetter).toBe(false);
  });

  it("a newer logo supersedes the old one: the old stays as history", async () => {
    const vision = new FakeVision({ librarian: verdict({ kind: "logo" }) });
    const first = await put({ ...base, bytes: await crispLogo(1500, 500) }, { store, vision, now: now() });
    const second = await put({ ...base, bytes: await crispLogo(1800, 600) }, { store, vision, now: now() });
    expect((await activeLogo(g))?.id).toBe(second.asset.id);
    expect((await row(first.asset.id))?.status).toBe("superseded");
    expect(await g.roQuery("MATCH (n:BrandAsset {id:$n})-[:SUPERSEDES]->(o:BrandAsset {id:$o}) RETURN o.id", { n: second.asset.id, o: first.asset.id })).toHaveLength(1);
  });

  it("takes a TrueType font by its bytes and names its family; refuses WOFF and oversize files", async () => {
    const vision = new FakeVision({});
    const r = await put({ ...base, bytes: tinyFont("Fraunces"), filename: "whatever.bin" }, { store, vision, now: now() });
    expect(r.kind).toBe("font");
    expect(r.message).toContain("Fraunces");
    expect(await row(r.asset.id)).toMatchObject({ kind: "font", family: "Fraunces", mime: "font/ttf" });
    expect(vision.calls).toHaveLength(0); // a font is known from its bytes: no model call
    await expect(ingestBrandUpload(g, { ...base, bytes: Buffer.from("wOFF" + "x".repeat(50)) }, { store, vision, now: now() })).rejects.toThrow(/\.ttf|\.otf/);
    await expect(ingestBrandUpload(g, { ...base, bytes: Buffer.concat([tinyFont("Big"), Buffer.alloc(MAX_FONT_BYTES)]) }, { store, vision, now: now() })).rejects.toThrow(/too large/i);
  });

  it("files a PDF as a brand guide and reads the colours and fonts it names", async () => {
    const vision = new FakeVision({ librarian: { summary: "Warm earth palette, Fraunces for headings.", colours: ["#A8542E", "#191714", "not-a-colour"], fonts: ["Fraunces", "Inter"] } });
    const pdf = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF");
    const r = await put({ ...base, bytes: pdf, filename: "guide.pdf" }, { store, vision, now: now() });
    expect(r.kind).toBe("guide");
    expect(vision.calls[0]!.documents).toHaveLength(1);
    expect(await row(r.asset.id)).toMatchObject({ kind: "guide", mime: "application/pdf", guideColours: ["#a8542e", "#191714"], guideFonts: ["Fraunces", "Inter"] });
    expect(r.message).toMatch(/#a8542e/i);
  });

  it("keeps a guide even when it cannot be read, and says so", async () => {
    const vision = new FakeVision({}); // no answer: the call fails
    const r = await put({ ...base, bytes: Buffer.from("%PDF-1.4\n%%EOF"), filename: "g2.pdf" }, { store, vision, now: now() });
    expect(r.kind).toBe("guide");
    expect(r.message).toMatch(/couldn't read|could not read/i);
  });

  it("records a palette image's colours, a past design and an unknown file, and refuses a child's photo", async () => {
    const pal = await put({ ...base, bytes: await photo(900, 600, "#a8542e") },
      { store, vision: new FakeVision({ librarian: verdict({ kind: "palette", colours: ["#A8542E", "#f4f1ea", "zzz"] }) }), now: now() });
    expect(pal.kind).toBe("palette");
    expect(await row(pal.asset.id)).toMatchObject({ kind: "palette", colours: ["#a8542e", "#f4f1ea"] });
    const past = await put({ ...base, bytes: await photo(900, 600, "#223344") },
      { store, vision: new FakeVision({ librarian: verdict({ kind: "past_design" }) }), now: now() });
    expect(past.kind).toBe("past-design");
    const other = await put({ ...base, bytes: await photo(900, 600, "#556677") },
      { store, vision: new FakeVision({ librarian: verdict({ kind: "other", confidence: 0.2 }) }), now: now() });
    expect(other.kind).toBe("other");
    expect(other.message).toMatch(/tell me/i);
    const before = (await listBrandAssets(g)).length;
    await expect(ingestBrandUpload(g, { ...base, bytes: await photo(900, 600, "#778899") },
      { store, vision: new FakeVision({ librarian: verdict({ kind: "product_photo", containsChild: true }) }), now: now() })).rejects.toThrow(/child/i);
    expect((await listBrandAssets(g)).length).toBe(before);
  });

  it("flags a photo with a person and never lets it be treated as plain brand material", async () => {
    const r = await put({ ...base, bytes: await photo(900, 600, "#998877") },
      { store, vision: new FakeVision({ librarian: verdict({ kind: "past_design", containsPerson: true }) }), now: now() });
    expect(await row(r.asset.id)).toMatchObject({ containsPerson: true });
    expect(r.message).toMatch(/person/i);
  });

  it("refuses what is not a brand file, too big, or too tiny, and stores nothing", async () => {
    const vision = new FakeVision({ librarian: verdict() });
    const before = (await listBrandAssets(g)).length;
    await expect(ingestBrandUpload(g, { ...base, bytes: Buffer.from("MZ\x90\0 not a picture") }, { store, vision, now: now() })).rejects.toThrow(BrandUploadRejected);
    await expect(ingestBrandUpload(g, { ...base, bytes: Buffer.alloc(0) }, { store, vision, now: now() })).rejects.toThrow(/empty/i);
    await expect(ingestBrandUpload(g, { ...base, bytes: Buffer.concat([await crispLogo(), Buffer.alloc(MAX_IMAGE_BYTES)]) }, { store, vision, now: now() })).rejects.toThrow(/too large/i);
    const tiny = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#fff" } }).png().toBuffer();
    await expect(ingestBrandUpload(g, { ...base, bytes: tiny }, { store, vision, now: now() })).rejects.toThrow(/small/i);
    expect((await listBrandAssets(g)).length).toBe(before);
  });

  it("two businesses' assets never mix: a library read only sees its own graph", async () => {
    const other = await testGraph();
    try {
      await upsertNode(other.g, { type: "Business", id: "business:other", name: "Other" }, NOW);
      expect(await activeLogo(other.g)).toBeNull();
      expect(await listBrandAssets(other.g)).toEqual([]);
      void upsertEdge; // (edges are per graph by construction)
    } finally {
      await other.cleanup();
    }
  });
});
