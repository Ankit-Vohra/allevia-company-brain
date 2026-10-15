// At onboarding the brand kit stops being references: the logo file is downloaded (the header's own logo first, the
// biggest transparent variant, an SVG drawn to a PNG), a social-media card or a 64 px icon is not mistaken for a logo, a
// small or blurry one is flagged, and the brand's Google fonts are fetched as real files the poster composer can set text in.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { GraphHandle } from "../../src/graph/client.js";
import { closeAll } from "../../src/graph/client.js";
import { upsertEdge, upsertNode } from "../../src/graph/upsert.js";
import { activeLogo, fontFile, getBrandAsset } from "../../src/brand/library.js";
import { fetchWebsiteBrandFiles, type BrandFetch } from "../../src/brand/website.js";
import { brandWrite, LOGO_ASSET_ID } from "../../src/ingest/sources/website/brand.js";
import type { PageData } from "../../src/ingest/sources/website/page.js";
import { AssetStore } from "../../src/studio/store.js";
import { FakeVision } from "../../src/studio/vision.js";
import { testGraph } from "../helpers/graph.js";
import { blurryLogo, crispLogo, svgLogo, tinyFont } from "./helpers.js";

const BIZ = "business:kestrel-oak";
const NOW = Date.parse("2026-10-15T09:00:00Z");
const DOC = "document:kestrel.example";

const page = (over: Partial<PageData> = {}): PageData => ({
  url: "https://kestrel.example/", finalUrl: "https://kestrel.example/", redirects: [], status: 200, fetchedAt: "2026-10-15T00:00:00Z", bytes: 1, titleCount: 1,
  metaDescriptionCount: 0, h1: [], h2: [], text: "x", wordCount: 1, internalLinks: [], externalLinks: [], images: [], jsonLd: [], jsonLdTypes: [], jsonLdErrors: 0,
  og: {}, timing: { responseMs: 1, fetchMs: 1 }, mixedContent: [], ...over,
} as PageData);

// url -> response, with a log of what was asked for
function web(files: Record<string, { type: string; body: Buffer } | number>): { fetch: BrandFetch; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    fetch: async (url) => {
      asked.push(url);
      const f = files[url];
      if (f === undefined || typeof f === "number") return { status: f ?? 404, headers: {} as Record<string, string>, body: Buffer.alloc(0) };
      return { status: 200, headers: { "content-type": f.type }, body: f.body };
    },
  };
}

describe("website brand files", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  let dir: string;
  let store: AssetStore;

  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await upsertNode(g, { type: "Business", id: BIZ, name: "Kestrel & Oak" }, NOW);
    await upsertNode(g, { type: "Document", id: DOC, name: "Home page" }, NOW);
    dir = mkdtempSync(join(tmpdir(), "allevia-brand-web-"));
    store = new AssetStore(dir);
  }, 60_000);
  afterAll(async () => {
    await cleanup();
    await closeAll();
    rmSync(dir, { recursive: true, force: true });
  });

  const seed = async (logoValue: string | null, fonts: string[] = []) => {
    const w = brandWrite({ palette: [], fonts: fonts.map((family) => ({ family, role: "heading" as const, share: 0.5 })), logo: logoValue ? { value: logoValue, source: "header", format: "img" } : null },
      { businessId: BIZ, businessName: "Kestrel & Oak", docId: DOC, asOf: "2026-10-15" });
    for (const n of w.nodes) await upsertNode(g, n, NOW);
    for (const e of w.edges) await upsertEdge(g, e, NOW);
  };
  const run = (home: PageData, kit: Parameters<typeof fetchWebsiteBrandFiles>[2], fetch: BrandFetch, extra: Partial<Parameters<typeof fetchWebsiteBrandFiles>[3]> = {}) =>
    fetchWebsiteBrandFiles(g, home, kit, { tenant: "kestrel_oak", businessId: BIZ, docId: DOC, store, now: NOW, fetch, googleFonts: false, ...extra });

  it("downloads the header logo, keeps it as the site's logo node with its file, and records where it came from", async () => {
    const logo = await crispLogo(1600, 500);
    await seed("https://kestrel.example/logo.png");
    const w = web({ "https://kestrel.example/logo.png": { type: "image/png", body: logo } });
    const r = await run(page({ logo: { kind: "img", src: "https://kestrel.example/logo.png", inHeader: true, keyword: true, width: 160, height: 50 } }),
      { logo: { value: "https://kestrel.example/logo.png", source: "header", format: "img" }, fonts: [] }, w.fetch);
    expect(r.logo).toBe("stored");
    const a = (await getBrandAsset(g, LOGO_ASSET_ID))!;
    expect(a.storageKey).toMatch(/^[0-9a-f]{64}\.png$/);
    expect(a).toMatchObject({ kind: "logo", origin: "website", w: 1600, h: 500, needsBetter: false, status: "active" });
    expect((await sharp(store.get("kestrel_oak", a.storageKey!)!).metadata()).hasAlpha).toBe(true);
    expect((await activeLogo(g))?.id).toBe(LOGO_ASSET_ID);
  });

  it("draws an inline SVG logo to a PNG", async () => {
    const svg = svgLogo();
    await seed(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
    const r = await run(page({ logo: { kind: "svg", svg, inHeader: true, keyword: true, width: 150, height: 50 } }),
      { logo: { value: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`, source: "header", format: "svg" }, fonts: [] }, web({}).fetch);
    expect(r.logo).toBe("stored");
    const a = (await getBrandAsset(g, LOGO_ASSET_ID))!;
    expect(a.mime).toBe("image/png");
    expect(a.w).toBeGreaterThanOrEqual(1024);
  });

  it("prefers the biggest declared icon over a small favicon when there is no header logo", async () => {
    const big = await sharp(await crispLogo(1200, 1200)).resize(512, 512).png().toBuffer();
    const small = await sharp(big).resize(64, 64).png().toBuffer();
    await seed(null);
    const w = web({
      "https://kestrel.example/touch.png": { type: "image/png", body: big },
      "https://kestrel.example/fav.png": { type: "image/png", body: small },
    });
    const r = await run(page({ favicon: "https://kestrel.example/fav.png", iconLinks: [
      { href: "https://kestrel.example/fav.png", sizes: "64x64", rel: "icon" }, { href: "https://kestrel.example/touch.png", sizes: "180x180", rel: "apple-touch-icon" }] }),
      { logo: null, fonts: [] }, w.fetch);
    expect(r.logo).toBe("stored");
    expect((await getBrandAsset(g, LOGO_ASSET_ID))?.w).toBe(512);
    expect(w.asked[0]).toBe("https://kestrel.example/touch.png");
  });

  it("does not take a social-media card for a logo, nor a 64 px icon: the logo node says so and the owner is asked for a file", async () => {
    const card = await sharp({ create: { width: 1200, height: 630, channels: 3, background: "#191714" } }).png().toBuffer();
    const icon = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#a8542e" } }).png().toBuffer();
    await seed("https://kestrel.example/og.png");
    const w = web({ "https://kestrel.example/og.png": { type: "image/png", body: card }, "https://kestrel.example/icon.png": { type: "image/png", body: icon } });
    const r = await run(page({ og: { "og:image": "https://kestrel.example/og.png" }, favicon: "https://kestrel.example/icon.png" }),
      { logo: { value: "https://kestrel.example/og.png", source: "og:image", format: "img" }, fonts: [] }, w.fetch);
    expect(r.logo).toBe("none");
    expect(r.notes.join(" ")).toMatch(/social|card|icon/i);
    const a = (await getBrandAsset(g, LOGO_ASSET_ID))!;
    expect(a.status).toBe("not-a-logo");
    expect(a.needsBetter).toBe(true);
    expect(a.storageKey).toBeNull();
    expect(await activeLogo(g)).toBeNull(); // so the composer falls back to the name in the brand font and says so
  });

  it("asks Claude to confirm a logo when vision is available, and refuses what it says is not one", async () => {
    const photoLike = await sharp(await crispLogo(1200, 900)).png().toBuffer();
    await seed("https://kestrel.example/hero.png");
    const vision = new FakeVision({ librarian: { kind: "product_photo", confidence: 0.9, description: "a building", containsPerson: false, containsChild: false, colours: [], workOnIt: false } });
    const r = await run(page({ logo: { kind: "img", src: "https://kestrel.example/hero.png", inHeader: true, keyword: true, width: 160, height: 50 } }),
      { logo: { value: "https://kestrel.example/hero.png", source: "header", format: "img" }, fonts: [] },
      web({ "https://kestrel.example/hero.png": { type: "image/png", body: photoLike } }).fetch, { vision });
    expect(vision.calls).toHaveLength(1);
    expect(r.logo).toBe("none");
  });

  it("flags a small or blurry site logo for a better file", async () => {
    await seed("https://kestrel.example/blur.png");
    const r = await run(page({ logo: { kind: "img", src: "https://kestrel.example/blur.png", inHeader: true, keyword: true, width: 160, height: 50 } }),
      { logo: { value: "https://kestrel.example/blur.png", source: "header", format: "img" }, fonts: [] },
      web({ "https://kestrel.example/blur.png": { type: "image/png", body: await blurryLogo() } }).fetch);
    expect(r.logo).toBe("stored");
    expect(r.needsBetter).toBe(true);
    expect(await getBrandAsset(g, LOGO_ASSET_ID)).toMatchObject({ needsBetter: true });
  });

  it("survives a logo address that fails, with the failure said plainly", async () => {
    await seed("https://kestrel.example/gone.png");
    const r = await run(page({ logo: { kind: "img", src: "https://kestrel.example/gone.png", inHeader: true, keyword: true, width: 160, height: 50 } }),
      { logo: { value: "https://kestrel.example/gone.png", source: "header", format: "img" }, fonts: [] }, web({}).fetch);
    expect(r.logo).toBe("none");
    expect(r.notes.join(" ")).toMatch(/couldn't|could not/i);
  });

  it("fetches the brand's Google fonts as real files (regular and bold), only from Google's own hosts", async () => {
    await seed(null, ["Fraunces"]);
    const css = (w: number, u: string) => `@font-face { font-family: 'Fraunces'; font-style: normal; font-weight: ${w}; src: url(${u}) format('truetype'); }`;
    const files: Record<string, { type: string; body: Buffer }> = {
      "https://fonts.googleapis.com/css2?family=Fraunces%3Awght%40400%3B700": { type: "text/css", body: Buffer.from(
        `${css(400, "https://fonts.gstatic.com/s/fraunces/v38/r.ttf")}\n${css(700, "https://fonts.gstatic.com/s/fraunces/v38/b.ttf")}\n${css(900, "https://evil.example/x.ttf")}`) },
      "https://fonts.gstatic.com/s/fraunces/v38/r.ttf": { type: "font/ttf", body: tinyFont("Fraunces") },
      "https://fonts.gstatic.com/s/fraunces/v38/b.ttf": { type: "font/ttf", body: tinyFont("Fraunces") },
    };
    const w = web(files);
    const r = await run(page(), { logo: null, fonts: [{ family: "Fraunces", role: "heading", share: 0.5 }] }, w.fetch, { googleFonts: true });
    expect(r.fonts.map((f) => `${f.family}:${f.weight}`)).toEqual(["Fraunces:400", "Fraunces:700"]);
    expect(w.asked.some((u) => u.includes("evil.example"))).toBe(false);
    const f = (await fontFile(g, "Fraunces"))!;
    expect(f.storageKey).toMatch(/\.ttf$/);
    expect(readFileSync(store.path("kestrel_oak", f.storageKey!)!).length).toBeGreaterThan(20);
  });

  it("a font Google does not have is skipped without fuss", async () => {
    await seed(null, ["Studio Sans"]);
    const r = await run(page(), { logo: null, fonts: [{ family: "Studio Sans", role: "body", share: 0.5 }] }, web({}).fetch, { googleFonts: true });
    expect(r.fonts).toEqual([]);
    expect(await fontFile(g, "Studio Sans")).toBeNull();
  });
});
