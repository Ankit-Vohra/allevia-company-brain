// Studio image utilities (product design §6, steps 1, 4 and 7): metadata stripped on intake, a perceptual dHash, a
// local tilt estimate, the 4:5 straighten-and-crop plan, variant A's grade, and the SSIM-like structure score Nisha uses.
import { randomBytes } from "node:crypto";
import { describe, it, expect } from "vitest";
import sharp from "sharp";
import {
  dhash, estimateTilt, gradeTowards, hamming, normalizeUpload, planCrop, registerToFrame, renderVariantA, similarity, straightenedBase,
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

  // Content trial 2026-10-15: a JPEG cut off mid-upload has a good header, so it passed the checks and then failed in the
  // decode with "VipsJpeg: premature end", which the owner saw as "an unexpected problem".
  it("a photo cut off mid-upload is refused in plain words, not as an unexpected problem", async () => {
    const noise = (w: number, h: number) => sharp(randomBytes(w * h * 3), { raw: { width: w, height: h, channels: 3 } });
    const full = await noise(1200, 900).jpeg().toBuffer();
    for (const cut of [0.3, 0.6, 0.9]) {
      const e = await normalizeUpload(full.subarray(0, Math.floor(full.length * cut))).catch((x) => x);
      expect(e, `cut at ${cut}`).toBeInstanceOf(ImageRejected);
      expect((e as Error).message).toMatch(/damaged|cut off|didn't finish|did not finish/i);
    }
    const png = await noise(800, 600).png().toBuffer();
    expect(await normalizeUpload(png.subarray(0, Math.floor(png.length * 0.5))).catch((x) => x)).toBeInstanceOf(ImageRejected);
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

  // Content trial 2026-10-15: the local variant of a dark, cool, noisy phone photo came out grey and grainy (variant A is the
  // one that must still look good when the generative edit is unavailable).
  it("variant A removes sensor noise and corrects a strong cool cast on a dark phone photo", async () => {
    const w = 864, h = 1080;
    const noise = randomBytes(w * h * 3);
    const px = Buffer.alloc(w * h * 3);
    for (let i = 0; i < px.length; i += 3) {
      const x = ((i / 3) % w) / w;
      const band = x > 0.45 && x < 0.6 ? 25 : 0; // one soft vertical feature so the frame is not flat
      px[i] = Math.max(0, Math.min(255, 60 + band + (noise[i]! - 128) * 0.22));
      px[i + 1] = Math.max(0, Math.min(255, 70 + band + (noise[i + 1]! - 128) * 0.22));
      px[i + 2] = Math.max(0, Math.min(255, 95 + band + (noise[i + 2]! - 128) * 0.22));
    }
    const base = await sharp(px, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
    const grain = async (buf: Buffer) => { // the share of each pixel's value that does not survive a blur
      const g = await sharp(buf).resize(432, 540).greyscale().raw().toBuffer();
      const s = await sharp(buf).resize(432, 540).greyscale().blur(2).raw().toBuffer();
      const mean = g.reduce((a, v) => a + v, 0) / g.length;
      return Math.sqrt(g.reduce((a, v, i) => a + (v - s[i]!) ** 2, 0) / g.length) / mean;
    };
    const a = await renderVariantA(base, { paper: "#f4f1ea" });
    expect(await grain(a.buffer)).toBeLessThan((await grain(base)) * 0.6);
    const after = (await sharp(a.buffer).stats()).channels;
    expect(after[0]!.mean - after[2]!.mean).toBeGreaterThan(-8); // no longer clearly blue (it began 35 below)
    expect(a.treatment).toMatch(/denoise/);
  });

  it("registerToFrame finds the frame inside a reframed, relit edit; a featureless edit does not match", async () => {
    const frame = await sharp(await facade()).extract({ left: 300, top: 60, width: 320, height: 400 }).jpeg().toBuffer();
    // the "edit": the whole facade relit, on a square canvas (more sky), scaled up 1.5x; the frame holds the facade's end, so
    // the window rhythm cannot fool the search by one bay
    const edit = await sharp(await facade()).modulate({ brightness: 1.25 }).extend({ top: 160, background: "#dcd6cc" }).resize(960).jpeg().toBuffer();
    const r = await registerToFrame(edit, frame);
    expect(r.score).toBeGreaterThan(0.6);
    expect(r.rect.left).toBeGreaterThan(420);
    expect(r.rect.left).toBeLessThan(480);
    expect(r.rect.top).toBeGreaterThan(220); // sharp extends after resizing: 60 × 1.5 + 160 = 250
    expect(r.rect.top).toBeLessThan(280);
    expect(r.rect.w / 480).toBeCloseTo(1, 1);
    const flat = await sharp({ create: { width: 600, height: 600, channels: 3, background: "#d8cfc2" } }).jpeg().toBuffer();
    expect((await registerToFrame(flat, frame)).score).toBeLessThan(0.4);
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
