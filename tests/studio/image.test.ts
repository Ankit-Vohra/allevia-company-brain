// Studio image utilities (product design §6, steps 1, 4 and 7): metadata stripped on intake, a perceptual dHash, a
// local tilt estimate, the 4:5 straighten-and-crop plan, variant A's grade, and the SSIM-like structure score Nisha uses.
import { describe, it, expect } from "vitest";
import sharp from "sharp";
import {
  dhash, estimateTilt, gradeTowards, hamming, normalizeUpload, planCrop, renderVariantA, similarity, straightenedBase,
  ImageRejected,
} from "../../src/studio/image.js";

// A synthetic "building": a pale facade with dark window bars and a roofline, on a sky. Rotated by `deg` (clockwise
// positive, as sharp rotates), then cropped back to its own size so no fill border remains.
async function facade(deg = 0, w = 640, h = 480): Promise<Buffer> {
  const bars = Array.from({ length: 7 }, (_, i) => `<rect x="${90 + i * 70}" y="170" width="18" height="220" fill="#2b2620"/>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect width="${w}" height="${h}" fill="#9fb3c8"/>
    <rect x="60" y="130" width="${w - 120}" height="300" fill="#e9e4da"/>
    <rect x="50" y="118" width="${w - 100}" height="14" fill="#5b4a3a"/>
    ${bars}
    <rect x="0" y="430" width="${w}" height="50" fill="#6b7a5a"/>
  </svg>`;
  const flat = await sharp(Buffer.from(svg)).png().toBuffer();
  if (!deg) return flat;
  const rotated = await sharp(flat).rotate(deg, { background: "#9fb3c8" }).toBuffer({ resolveWithObject: true });
  const left = Math.round((rotated.info.width - w * 0.8) / 2), top = Math.round((rotated.info.height - h * 0.8) / 2);
  return sharp(rotated.data).extract({ left, top, width: Math.round(w * 0.8), height: Math.round(h * 0.8) }).png().toBuffer();
}

describe("studio image utilities", () => {
  it("normalizeUpload re-encodes without EXIF or GPS, auto-orients, and records sha256, dHash and size", async () => {
    const withGps = await sharp(await facade()).jpeg()
      .withExif({ IFD0: { Make: "TestCam" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "21/1 15/1 0/1" } }).toBuffer();
    expect((await sharp(withGps).metadata()).exif).toBeDefined();
    const n = await normalizeUpload(withGps);
    const meta = await sharp(n.buffer).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.format).toBe("jpeg");
    expect({ w: n.w, h: n.h, mime: n.mime }).toEqual({ w: 640, h: 480, mime: "image/jpeg" });
    expect(n.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(n.dhash).toMatch(/^[0-9a-f]{16}$/);
    // deterministic: the same upload gives the same bytes and hashes
    const again = await normalizeUpload(withGps);
    expect(again.sha256).toBe(n.sha256);
  });

  it("normalizeUpload refuses what is not an image, and images that are too small or too large", async () => {
    await expect(normalizeUpload(Buffer.from("not an image at all"))).rejects.toBeInstanceOf(ImageRejected);
    const tiny = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#777" } }).png().toBuffer();
    await expect(normalizeUpload(tiny)).rejects.toThrow(/too small/);
    const big = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: "#777" } }).png().toBuffer();
    await expect(normalizeUpload(big, { maxPixels: 4_000_000 })).rejects.toThrow(/too large/);
  });

  it("dHash: the same picture is close after a regrade, a different picture is far", async () => {
    const a = await facade();
    const graded = await sharp(a).modulate({ brightness: 0.8 }).tint("#a0c0ff").toBuffer();
    const other = await sharp({ create: { width: 640, height: 480, channels: 3, background: "#777" } })
      .composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><circle cx="320" cy="240" r="200" fill="#111"/></svg>`) }])
      .png().toBuffer();
    expect(hamming(await dhash(a), await dhash(graded))).toBeLessThanOrEqual(6);
    expect(hamming(await dhash(a), await dhash(other))).toBeGreaterThan(16);
  });

  it("estimateTilt finds a clockwise and an anticlockwise tilt to within a degree, and level as level", async () => {
    expect(Math.abs((await estimateTilt(await facade(0))).deg)).toBeLessThan(0.75);
    const cw = await estimateTilt(await facade(5));
    expect(cw.deg).toBeGreaterThan(4);
    expect(cw.deg).toBeLessThan(6);
    expect(cw.confidence).toBeGreaterThan(0.2);
    const ccw = await estimateTilt(await facade(-4));
    expect(ccw.deg).toBeLessThan(-3);
    expect(ccw.deg).toBeGreaterThan(-5);
  });

  it("planCrop: a 4:5 window inside the straightened frame, over the locked building and away from a privacy box", () => {
    const plan = planCrop({ w: 880, h: 660 }, 5, [
      { kind: "lock", x: 0.5, y: 0.2, w: 0.45, h: 0.5, note: "the arches" },
      { kind: "privacy", x: 0.15, y: 0.4, w: 0.08, h: 0.25, note: "a person" },
    ]);
    expect(plan.rotate).toBe(-5);
    expect(plan.crop.w / plan.crop.h).toBeCloseTo(0.8, 2);
    // inside the rotated canvas, and covering the lock box's centre (0.725 of the width in the original)
    expect(plan.crop.left).toBeGreaterThanOrEqual(0);
    expect(plan.crop.left + plan.crop.w).toBeLessThanOrEqual(plan.canvas.w);
    expect(plan.lockCovered).toBeGreaterThan(0.6);
    expect(plan.privacyCovered).toBeLessThan(0.5);
  });

  it("straightenedBase and variant A: 1080x1350, warmer and brighter than a cool, dark input; structure kept", async () => {
    const dark = await sharp(await facade(4)).modulate({ brightness: 0.55 }).tint("#8fb0ff").jpeg().toBuffer();
    const n = await normalizeUpload(dark);
    const plan = planCrop({ w: n.w, h: n.h }, 4, [{ kind: "lock", x: 0.2, y: 0.2, w: 0.6, h: 0.6, note: "facade" }]);
    const base = await straightenedBase(n.buffer, plan, []);
    const baseMeta = await sharp(base).metadata();
    expect(baseMeta.width! / baseMeta.height!).toBeCloseTo(0.8, 1);
    const a = await renderVariantA(base, { paper: "#f4f1ea" });
    const meta = await sharp(a.buffer).metadata();
    expect({ w: meta.width, h: meta.height }).toEqual({ w: 1080, h: 1350 });
    const before = (await sharp(base).stats()).channels;
    const after = (await sharp(a.buffer).stats()).channels;
    const lum = (c: typeof before) => 0.2126 * c[0]!.mean + 0.7152 * c[1]!.mean + 0.0722 * c[2]!.mean;
    expect(lum(after)).toBeGreaterThan(lum(before) + 10);
    expect(after[0]!.mean - after[2]!.mean).toBeGreaterThan(before[0]!.mean - before[2]!.mean); // warmer: red up against blue
    expect(a.treatment).toMatch(/straighten/);
    const s = await similarity(base, a.buffer);
    expect(s.structure).toBeGreaterThan(0.8);
  });

  it("gradeTowards computes gains that move a cool, dark mean toward the warm paper tone", () => {
    const g = gradeTowards({ r: 60, g: 70, b: 95 }, "#f4f1ea");
    expect(g.gains[0]).toBeGreaterThan(g.gains[2]);
    expect(g.exposure).toBeGreaterThan(1);
  });

  it("similarity: identical is 1, a relight keeps structure high, a different picture scores low", async () => {
    const a = await facade();
    expect((await similarity(a, a)).ssim).toBeCloseTo(1, 3);
    const relit = await sharp(a).modulate({ brightness: 1.3, saturation: 0.7 }).toBuffer();
    expect((await similarity(a, relit)).structure).toBeGreaterThan(0.85);
    const blank = await sharp({ create: { width: 640, height: 480, channels: 3, background: "#9fb3c8" } })
      .composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><circle cx="200" cy="300" r="120" fill="#222"/></svg>`) }])
      .png().toBuffer();
    expect((await similarity(a, blank)).structure).toBeLessThan(0.5);
  });
});
