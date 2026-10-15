// Is a logo file good enough to print on a poster? Two plain checks, both from the pixels: is it small, and are its
// edges soft (a thumbnail stretched up). When either is true the owner is asked once for a better file.
import sharp from "sharp";

export const LOW_RES_SIDE = 480;       // the longest side, in px: below this a logo goes soft on a 1080 px poster
export const BLURRY_BELOW = 0.2;       // edge sharpness: crisp artwork reads about 0.5, a stretched thumbnail under 0.05

export interface LogoQuality { w: number; h: number; hasAlpha: boolean; lowRes: boolean; blurry: boolean; sharpness: number }

// How steep the steepest edges are, relative to the picture's own contrast: the 99.5th percentile of the Laplacian over
// the contrast range, on a copy of at most 800 px wide (so size alone does not decide it). About 0.5 is a hard step (the convolution output is clamped at half range), near 0 a haze.
export async function edgeSharpness(png: Buffer): Promise<number> {
  const { data, info } = await sharp(png).flatten({ background: "#ffffff" }).resize({ width: 800, withoutEnlargement: true }).greyscale().raw().toBuffer({ resolveWithObject: true });
  if (info.width < 3 || info.height < 3) return 0;
  const lap = await sharp(data, { raw: { width: info.width, height: info.height, channels: 1 } })
    .convolve({ width: 3, height: 3, kernel: [0, -1, 0, -1, 4, -1, 0, -1, 0], scale: 1, offset: 128 }).raw().toBuffer();
  const hist = new Uint32Array(256);
  let lo = 255, hi = 0;
  for (const v of data) { if (v < lo) lo = v; if (v > hi) hi = v; }
  for (const v of lap) hist[Math.abs(v - 128)]!++;
  const contrast = Math.max(1, hi - lo);
  let seen = 0;
  const total = lap.length;
  let p = 0;
  for (let i = 255; i >= 0; i--) { seen += hist[i]!; if (seen / total >= 0.005) { p = i; break; } }
  return Math.min(1, p / contrast);
}

export async function logoQuality(png: Buffer): Promise<LogoQuality> {
  const meta = await sharp(png).metadata();
  const w = meta.width ?? 0, h = meta.height ?? 0;
  const sharpness = await edgeSharpness(png);
  return { w, h, hasAlpha: meta.hasAlpha === true, lowRes: Math.max(w, h) < LOW_RES_SIDE, blurry: sharpness < BLURRY_BELOW, sharpness: Math.round(sharpness * 100) / 100 };
}
