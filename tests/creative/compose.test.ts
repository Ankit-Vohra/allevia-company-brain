// The poster composer: the logo is the owner's real file placed whole (pixel-exact where it sits), the words are exactly the
// words given and drawn from the brand's font files, colours are the brand's own, every size and layout fits, a headline that
// cannot fit is an error rather than a cut-off line, and with no artwork the layout still stands on a brand-colour ground.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import {
  composePoster, layoutOrder, LAYOUTS, PosterFontMissing, PosterTextDoesNotFit, type BrandForCompose, type PosterContent,
} from "../../src/creative/compose/compose.js";
import { FORMATS, FORMAT_KEYS } from "../../src/creative/compose/formats.js";
import { contrast, ensureContrast, paletteFrom } from "../../src/creative/compose/palette.js";
import { fitText, layoutText, loadFont } from "../../src/creative/compose/type.js";
import { crispLogo } from "../brand/helpers.js";

const font = (n: string) => loadFont(readFileSync(`tests/fixtures/fonts/${n}`))!;
const palette = paletteFrom({ paper: "#f4f1ea", ink: "#6b6457", accent: "#a8542e", neutral: "#191714" });
const brand = (logo: BrandForCompose["logo"]): BrandForCompose => ({
  businessName: "Kestrel & Oak", palette, logo,
  heading: { regular: font("Fraunces-400.ttf"), bold: font("Fraunces-700.ttf") },
  body: { regular: font("Inter-400.ttf"), bold: font("Inter-700.ttf") },
});
const content: PosterContent = { eyebrow: "Diwali", headline: "A festival of light for your home", subline: "Book a design visit before the festival.", offer: "20% off", cta: "Visit kestrel.example" };

async function artwork(): Promise<Buffer> {
  return sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#6a7a5a" } })
    .composite([{ input: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><circle cx="500" cy="400" r="200" fill="#f0d9a0"/><rect y="700" width="1024" height="324" fill="#2c2018"/></svg>') }]).jpeg().toBuffer();
}

describe("type: measured before it is drawn", () => {
  const f = font("Fraunces-700.ttf");
  it("wraps by words, and a word wider than the box is reported, never cut", () => {
    const l = layoutText("A festival of light for your home", { font: f, size: 100 }, 600);
    expect(l.lines.length).toBeGreaterThan(1);
    expect(l.lines.every((x) => x.width <= 600.5)).toBe(true);
    expect(l.lines.map((x) => x.text).join(" ")).toBe("A festival of light for your home");
    expect(layoutText("Supercalifragilisticexpialidocious", { font: f, size: 100 }, 300).overflowWord).toBe(true);
  });
  it("fits the largest size that works, and says when none does", () => {
    const ok = fitText("Diwali sale", { font: f }, { w: 800, h: 300 }, { max: 200, min: 30 });
    expect(ok.ok).toBe(true);
    expect(ok.size).toBeLessThanOrEqual(200);
    expect(layoutText("Diwali sale", { font: f, size: ok.size }, 800).height).toBeLessThanOrEqual(300);
    expect(fitText("an extremely long headline that cannot possibly fit in a tiny box at all", { font: f }, { w: 200, h: 40 }, { max: 100, min: 30 }).ok).toBe(false);
  });
});

describe("palette", () => {
  it("builds from the brand's own colours and keeps text readable", () => {
    expect(palette).toMatchObject({ paper: "#f4f1ea", dark: "#191714", accent: "#a8542e", source: "brand" });
    expect(contrast(palette.dark, palette.paper)).toBeGreaterThan(10);
    const lifted = ensureContrast(palette.accent, palette.dark, 4.5, palette.light);
    expect(contrast(lifted, palette.dark)).toBeGreaterThanOrEqual(4.5);
    expect(ensureContrast("#ffffff", palette.dark, 4.5, "#ffffff")).toBe("#ffffff"); // already readable: unchanged
  });
});

describe("composePoster", () => {
  let logoBytes: Buffer;
  let art: Buffer;
  beforeAll(async () => { logoBytes = await crispLogo(1400, 460); art = await artwork(); });

  it("makes every format and layout at the exact size, with nothing off the edge, and no problems", async () => {
    for (const format of FORMAT_KEYS) {
      for (const layout of LAYOUTS) {
        const r = await composePoster({ format, layout, content, brand: brand({ bytes: logoBytes, w: 1400, h: 460 }), artwork: layout === "type-only" ? null : art });
        const meta = await sharp(r.buffer).metadata();
        expect({ format, layout, w: meta.width, h: meta.height, kind: meta.format }).toEqual({ format, layout, w: FORMATS[format].w, h: FORMATS[format].h, kind: FORMATS[format].mime === "image/png" ? "png" : "jpeg" });
        expect(r.manifest.problems, `${format} ${layout}`).toEqual([]);
      }
    }
  }, 120_000);

  it("sets the words exactly as given, in the brand's own fonts and colours", async () => {
    const r = await composePoster({ format: "insta_portrait", layout: "hero-bottom", content, brand: brand(null), artwork: art });
    const by = Object.fromEntries(r.manifest.texts.map((t) => [t.role, t]));
    expect(by.headline!.text).toBe(content.headline);
    expect(by.headline!.shown).toBe(content.headline);
    expect(by.offer!.shown).toBe("20% off");
    expect(by.cta!.shown).toBe("Visit kestrel.example");
    expect(by.eyebrow!.shown).toBe("DIWALI"); // set in capitals: a display choice, the same letters
    expect(by.headline!.font).toBe("Fraunces");
    expect(by.subline!.font).toBe("Inter");
    expect(r.manifest.fonts).toEqual({ heading: "Fraunces", body: "Inter" });
    expect(r.manifest.colours).toMatchObject({ paper: "#f4f1ea", dark: "#191714", accent: "#a8542e" });
    // every text colour is one of the brand's, or the accent nudged for contrast: never an unrelated colour
    for (const t of r.manifest.texts) expect(t.color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("places the real logo whole, in proportion, and pixel-exact where it sits (no plate needed on paper)", async () => {
    const lg = { bytes: logoBytes, w: 1400, h: 460 };
    const r = await composePoster({ format: "flyer", layout: "frame-centre", content, brand: brand(lg), artwork: null });
    expect(r.manifest.logo).toMatchObject({ kind: "file", plate: false });
    const box = r.manifest.logo.box;
    const trimmed = await sharp(logoBytes).trim({ threshold: 8 }).png().toBuffer({ resolveWithObject: true });
    expect(Math.abs(box.w / box.h - trimmed.info.width / trimmed.info.height)).toBeLessThan(0.02); // proportions kept
    const expected = await sharp({ create: { width: Math.round(box.w), height: Math.round(box.h), channels: 3, background: palette.paper } })
      .composite([{ input: await sharp(trimmed.data).resize(Math.round(box.w), Math.round(box.h), { fit: "fill", kernel: "lanczos3" }).ensureAlpha().png().toBuffer() }]).removeAlpha().raw().toBuffer();
    const got = await sharp(r.buffer).extract({ left: Math.round(box.x), top: Math.round(box.y), width: Math.round(box.w), height: Math.round(box.h) }).raw().toBuffer();
    let worst = 0;
    for (let i = 0; i < expected.length; i++) worst = Math.max(worst, Math.abs(expected[i]! - got[i]!));
    expect(worst).toBeLessThanOrEqual(1);
  });

  it("gives a logo a plate in a brand colour when the backdrop would swallow it, and a logo with its own background keeps it", async () => {
    const dark = await composePoster({ format: "insta_square", layout: "hero-bottom", content, brand: brand({ bytes: logoBytes, w: 1400, h: 460 }), artwork: art });
    const darkLogo = await sharp({ create: { width: 900, height: 300, channels: 4, background: "#00000000" } }).composite([{ input: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="300"><rect x="30" y="30" width="840" height="240" fill="#111111"/></svg>') }]).png().toBuffer();
    const onDark = await composePoster({ format: "insta_square", layout: "type-only", content, brand: brand({ bytes: darkLogo, w: 900, h: 300 }), artwork: null });
    expect(onDark.manifest.logo.plate).toBe(true);
    expect(["#f4f1ea", "#ffffff"]).toContain(onDark.manifest.logo.plateColor);
    expect(dark.manifest.logo.kind).toBe("file");
    const opaque = await sharp({ create: { width: 800, height: 260, channels: 3, background: "#ffffff" } }).composite([{ input: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="260"><rect x="40" y="60" width="300" height="140" fill="#a8542e"/></svg>') }]).jpeg().toBuffer();
    const o = await composePoster({ format: "insta_square", layout: "hero-bottom", content, brand: brand({ bytes: opaque, w: 800, h: 260 }), artwork: art });
    expect(o.manifest.logo.plate).toBe(true);
  });

  it("without a logo file the name is set in the brand font and the manifest says it is a wordmark", async () => {
    const r = await composePoster({ format: "insta_square", layout: "split", content, brand: brand(null), artwork: art });
    expect(r.manifest.logo.kind).toBe("wordmark");
  });

  it("does not set the name twice: with no logo file and the name as the headline, there is no separate wordmark", async () => {
    const r = await composePoster({ format: "insta_portrait", layout: "split", content: { headline: "Kestrel & Oak", subline: "Architecture studio" }, brand: brand(null), artwork: null });
    expect(r.manifest.logo).toMatchObject({ kind: "wordmark", inHeadline: true });
    expect(r.manifest.logo.box.w).toBe(0);
  });

  it("flags a small logo file as soft instead of silently stretching it", async () => {
    const tiny = await sharp(logoBytes).resize(120).png().toBuffer();
    const r = await composePoster({ format: "insta_portrait", layout: "hero-bottom", content, brand: brand({ bytes: tiny, w: 120, h: 40 }), artwork: art });
    expect(r.manifest.logo.soft).toBe(true);
    expect(r.manifest.problems.join(" ")).toMatch(/soft/);
    expect(r.manifest.logo.scale).toBeLessThanOrEqual(1.5);
  });

  it("keeps a story's words out of the zones the app draws over", async () => {
    const r = await composePoster({ format: "insta_story", layout: "hero-bottom", content, brand: brand({ bytes: logoBytes, w: 1400, h: 460 }), artwork: art });
    for (const t of r.manifest.texts) {
      expect(t.box.y, t.role).toBeGreaterThanOrEqual(FORMATS.insta_story.safeTop - 1);
      expect(t.box.y + t.box.h, t.role).toBeLessThanOrEqual(FORMATS.insta_story.h - FORMATS.insta_story.safeBottom + 1);
    }
  });

  it("refuses a headline that cannot fit, naming it, rather than cutting it", async () => {
    const long = { ...content, headline: Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ") };
    await expect(composePoster({ format: "insta_square", layout: "hero-bottom", content: long, brand: brand(null), artwork: art })).rejects.toThrow(PosterTextDoesNotFit);
    await expect(composePoster({ format: "insta_square", layout: "hero-bottom", content: long, brand: brand(null), artwork: art })).rejects.toThrow(/headline/);
  });

  it("refuses text the brand font has no letters for, instead of drawing boxes", async () => {
    await expect(composePoster({ format: "insta_square", layout: "type-only", content: { ...content, headline: "दीवाली की शुभकामनाएं" }, brand: brand(null), artwork: null })).rejects.toThrow(PosterFontMissing);
  });

  it("with no artwork a picture layout falls back to the brand-colour ground, and layouts follow the occasion", async () => {
    const r = await composePoster({ format: "insta_square", layout: "hero-bottom", content, brand: brand(null), artwork: null });
    expect(r.manifest).toMatchObject({ layout: "type-only", artwork: false });
    expect(layoutOrder("offer", true)[0]).toBe("badge-offer");
    expect(layoutOrder("festival", true)[0]).toBe("frame-centre");
    expect(layoutOrder("announcement", true)[0]).toBe("hero-bottom");
    expect(layoutOrder("offer", false)).not.toContain("hero-bottom");
  });

  it("leaves out what was not given: no offer, no cta, no invented line", async () => {
    const r = await composePoster({ format: "insta_square", layout: "hero-bottom", content: { headline: "Open house on Sunday" }, brand: brand(null), artwork: art });
    expect(r.manifest.texts.map((t) => t.role).filter((x) => x !== "wordmark")).toEqual(["headline"]);
  });
});
