// Studio pixel work (product design §6), all local and deterministic with sharp:
// - intake: re-encode without metadata (no EXIF GPS revealing a client's home), auto-orient, sRGB, a size guard, and
//   the fingerprints an Asset carries (sha256 of the stored bytes, a 64-bit dHash);
// - the plan: a tilt estimate from the photo's own edges, and a 4:5 window inside the straightened frame that keeps
//   Tara's "lock" boxes (the building) in and her privacy boxes out;
// - variant A ("Safe", $0, never labelled AI): straighten, crop, exposure and white balance toward the brand's paper
//   tone, a subtle vignette, 1080x1350;
// - Nisha's numbers: dHash distance and an SSIM-like structure score between a variant and the frame it came from.
import { createHash } from "node:crypto";
import sharp, { type Metadata, type OverlayOptions } from "sharp";
import type { AssessmentOverlay } from "../../shared/contracts.js";

export class ImageRejected extends Error {
  override name = "ImageRejected";
}

export interface Normalized { buffer: Buffer; w: number; h: number; mime: "image/jpeg"; sha256: string; dhash: string; bytes: number }

export interface NormalizeOpts { maxPixels?: number; minSide?: number; maxSide?: number }

const DEFAULT_MAX_PIXELS = 50_000_000; // a 50 MP phone photo is fine; a decompression bomb is not
const DEFAULT_MIN_SIDE = 256;
const DEFAULT_MAX_SIDE = 4096;         // stored originals are capped; the vision copy is smaller still

export const sha256Hex = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

// Re-encodes the upload: auto-orient from EXIF, flatten transparency, sRGB, cap the long side, JPEG with NO metadata
// (sharp drops EXIF, XMP, IPTC and ICC unless asked to keep them). Throws ImageRejected for anything we will not store.
export async function normalizeUpload(bytes: Buffer, opts: NormalizeOpts = {}): Promise<Normalized> {
  const maxPixels = opts.maxPixels ?? DEFAULT_MAX_PIXELS;
  let meta: Metadata;
  try {
    meta = await sharp(bytes, { limitInputPixels: false }).metadata();
  } catch {
    throw new ImageRejected("That file is not an image we can read. Send a JPEG, PNG or WebP photo.");
  }
  if (meta.format === "heif") throw new ImageRejected("HEIC photos are not supported yet. Share the photo as JPEG (most phones do this when you send it).");
  const w0 = meta.width ?? 0, h0 = meta.height ?? 0;
  if (!w0 || !h0) throw new ImageRejected("That image has no size we can read.");
  if (w0 * h0 > maxPixels) throw new ImageRejected(`That image is too large (${w0}×${h0}). Send one under ${Math.round(maxPixels / 1e6)} megapixels.`);
  const minSide = opts.minSide ?? DEFAULT_MIN_SIDE;
  if (Math.min(w0, h0) < minSide) throw new ImageRejected(`That image is too small (${w0}×${h0}): a post needs at least ${minSide} pixels on the short side.`);
  const maxSide = opts.maxSide ?? DEFAULT_MAX_SIDE;
  const { data, info } = await sharp(bytes, { limitInputPixels: maxPixels, failOn: "error" })
    .rotate() // auto-orient from EXIF before the EXIF goes
    .flatten({ background: "#ffffff" })
    .resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true })
    .toColourspace("srgb")
    .jpeg({ quality: 90, chromaSubsampling: "4:4:4" })
    .toBuffer({ resolveWithObject: true });
  return { buffer: data, w: info.width, h: info.height, mime: "image/jpeg", sha256: sha256Hex(data), dhash: await dhash(data), bytes: data.length };
}

// The copy a vision model sees: the long side at most 1568 px (Claude's useful maximum), JPEG.
export async function visionCopy(buffer: Buffer, maxSide = 1568): Promise<Buffer> {
  return sharp(buffer).resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
}

// A small preview for event thumbnails and the office wall.
export async function thumbnail(buffer: Buffer, width: number): Promise<Buffer> {
  return sharp(buffer).resize({ width, withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
}

// ---------- fingerprints ----------

// Difference hash: 9x8 greyscale, one bit per horizontally adjacent pair (left brighter than right). 16 hex chars.
export async function dhash(buffer: Buffer): Promise<string> {
  const px = await sharp(buffer).greyscale().resize(9, 8, { fit: "fill" }).raw().toBuffer();
  let bits = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) bits = (bits << 1n) | (px[y * 9 + x]! > px[y * 9 + x + 1]! ? 1n : 0n);
  }
  return bits.toString(16).padStart(16, "0");
}

export function hamming(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
}

// ---------- tilt ----------

// The photo's own edges vote: Sobel gradients on a 512 px greyscale copy, each strong edge's angle folded onto the
// nearest axis, a magnitude-weighted histogram in [-15°, 15°]. Architecture is full of verticals and horizontals, so
// the peak is the camera's roll. `deg` is clockwise-positive (sharp's convention: content rotated clockwise, verticals
// leaning right at the top); straightening is a rotation by -deg. `confidence` is the share of edge weight near the peak.
export async function estimateTilt(buffer: Buffer): Promise<{ deg: number; confidence: number }> {
  const { data, info } = await sharp(buffer).greyscale().resize({ width: 512, height: 512, fit: "inside" }).blur(0.8).raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const at = (x: number, y: number) => data[y * W + x]!;
  const mags: number[] = [];
  const angs: number[] = [];
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const gx = at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
      const gy = at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
      const m = Math.hypot(gx, gy);
      if (m < 40) continue;
      const phi = (Math.atan2(gy, gx) * 180) / Math.PI;
      mags.push(m);
      angs.push(((((phi + 45) % 90) + 90) % 90) - 45); // fold onto the nearest axis: [-45, 45)
    }
  }
  if (!mags.length) return { deg: 0, confidence: 0 };
  // keep the strongest fifth of the edges: texture and noise vote weakly
  const cut = [...mags].sort((a, b) => b - a)[Math.floor(mags.length * 0.2)] ?? 0;
  const BIN = 0.25, LIM = 15, n = Math.round((2 * LIM) / BIN);
  const hist = new Float64Array(n);
  let total = 0;
  for (let i = 0; i < mags.length; i++) {
    if (mags[i]! < cut) continue;
    total += mags[i]!;
    const a = angs[i]!;
    if (a < -LIM || a >= LIM) continue;
    hist[Math.floor((a + LIM) / BIN)]! += mags[i]!;
  }
  const smooth = new Float64Array(n);
  for (let i = 0; i < n; i++) for (let k = -4; k <= 4; k++) if (i + k >= 0 && i + k < n) smooth[i]! += hist[i + k]! * (5 - Math.abs(k));
  let peak = 0;
  for (let i = 1; i < n; i++) if (smooth[i]! > smooth[peak]!) peak = i;
  // refine: weighted mean of the raw histogram within ±0.75° of the peak
  let wsum = 0, asum = 0, near = 0;
  for (let i = Math.max(0, peak - 3); i <= Math.min(n - 1, peak + 3); i++) {
    const centre = -LIM + (i + 0.5) * BIN;
    wsum += hist[i]!; asum += hist[i]! * centre;
  }
  for (let i = Math.max(0, peak - 4); i <= Math.min(n - 1, peak + 4); i++) near += hist[i]!;
  const deg = wsum ? asum / wsum : -LIM + (peak + 0.5) * BIN;
  return { deg: Math.round(deg * 10) / 10, confidence: total ? Math.round((near / total) * 100) / 100 : 0 };
}

// ---------- the crop plan ----------

export interface Rect { left: number; top: number; w: number; h: number }
export interface CropPlan {
  src: { w: number; h: number };
  rotate: number;               // degrees, clockwise-positive (sharp), applied first
  canvas: { w: number; h: number }; // the rotated canvas (sharp expands it to fit)
  valid: Rect;                  // the largest axis-aligned rectangle with no fill corners
  crop: Rect;                   // the 4:5 window, in canvas pixels
  lockCovered: number;          // share of the lock boxes' area inside the window
  privacyCovered: number;       // share of the privacy boxes' area inside the window
}

const rad = (d: number) => (d * Math.PI) / 180;

// Largest axis-aligned rectangle inside a w×h rectangle rotated by `deg` (the classic closed form).
function maxInscribed(w: number, h: number, deg: number): { w: number; h: number } {
  const a = rad(deg);
  const sin = Math.abs(Math.sin(a)), cos = Math.abs(Math.cos(a));
  if (sin < 1e-9) return { w, h };
  const wide = w >= h;
  const long = wide ? w : h, short = wide ? h : w;
  if (short <= 2 * sin * cos * long || Math.abs(sin - cos) < 1e-10) {
    const x = 0.5 * short;
    return wide ? { w: x / sin, h: x / cos } : { w: x / cos, h: x / sin };
  }
  const cos2 = cos * cos - sin * sin;
  return { w: (w * cos - h * sin) / cos2, h: (h * cos - w * sin) / cos2 };
}

// Where a box of the source photo (0..1 coordinates) lands on the rotated canvas, in canvas pixels. Boxes keep their
// size: at a few degrees the difference is a pixel or two.
export function mapBox(plan: Pick<CropPlan, "src" | "rotate" | "canvas">, b: Pick<AssessmentOverlay, "x" | "y" | "w" | "h">): Rect {
  const a = rad(plan.rotate);
  const cx = (b.x + b.w / 2) * plan.src.w - plan.src.w / 2;
  const cy = (b.y + b.h / 2) * plan.src.h - plan.src.h / 2;
  const rx = cx * Math.cos(a) - cy * Math.sin(a);
  const ry = cx * Math.sin(a) + cy * Math.cos(a);
  const w = b.w * plan.src.w, h = b.h * plan.src.h;
  return { left: plan.canvas.w / 2 + rx - w / 2, top: plan.canvas.h / 2 + ry - h / 2, w, h };
}

const overlap = (a: Rect, b: Rect): number => {
  const w = Math.min(a.left + a.w, b.left + b.w) - Math.max(a.left, b.left);
  const h = Math.min(a.top + a.h, b.top + b.h) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
};

export const ASPECT_4_5 = 4 / 5;

// Straighten by -tiltDeg, then the largest 4:5 window inside the valid area, slid along its free axis to cover the
// lock boxes (the building) and miss the privacy boxes (people, plates, house numbers).
export function planCrop(src: { w: number; h: number }, tiltDeg: number, overlays: AssessmentOverlay[], aspect = ASPECT_4_5): CropPlan {
  const rotate = Math.abs(tiltDeg) < 0.3 ? 0 : -Math.round(tiltDeg * 10) / 10;
  const a = rad(rotate);
  const canvas = {
    w: Math.round(Math.abs(src.w * Math.cos(a)) + Math.abs(src.h * Math.sin(a))),
    h: Math.round(Math.abs(src.w * Math.sin(a)) + Math.abs(src.h * Math.cos(a))),
  };
  const ins = maxInscribed(src.w, src.h, rotate);
  const valid: Rect = { left: (canvas.w - ins.w) / 2, top: (canvas.h - ins.h) / 2, w: ins.w, h: ins.h };
  const geo = { src, rotate, canvas };
  const locks = overlays.filter((o) => o.kind === "lock").map((o) => mapBox(geo, o));
  const privacy = overlays.filter((o) => o.kind === "privacy").map((o) => mapBox(geo, o));
  const area = (rs: Rect[]) => rs.reduce((s, r) => s + r.w * r.h, 0);
  const lockArea = area(locks), privArea = area(privacy);
  const horizontal = valid.w / valid.h >= aspect;
  const w = horizontal ? valid.h * aspect : valid.w;
  const h = horizontal ? valid.h : valid.w / aspect;
  const slack = horizontal ? valid.w - w : valid.h - h;
  let best: { crop: Rect; score: number; lock: number; priv: number } | undefined;
  const STEPS = 40;
  for (let i = 0; i <= STEPS; i++) {
    const t = slack * (i / STEPS);
    const crop: Rect = horizontal ? { left: valid.left + t, top: valid.top, w, h } : { left: valid.left, top: valid.top + t, w, h };
    const lock = lockArea ? locks.reduce((s, r) => s + overlap(r, crop), 0) / lockArea : 0;
    const priv = privArea ? privacy.reduce((s, r) => s + overlap(r, crop), 0) / privArea : 0;
    const offCentre = slack ? Math.abs(i / STEPS - 0.5) : 0;
    const score = lock - 0.8 * priv - 0.05 * offCentre;
    if (!best || score > best.score + 1e-9) best = { crop, score, lock, priv };
  }
  const r = (v: number) => Math.round(v);
  const c = best!.crop;
  return {
    src, rotate, canvas, valid: { left: r(valid.left), top: r(valid.top), w: r(valid.w), h: r(valid.h) },
    crop: { left: r(c.left), top: r(c.top), w: r(c.w), h: r(c.h) },
    lockCovered: Math.round(best!.lock * 100) / 100, privacyCovered: Math.round(best!.priv * 100) / 100,
  };
}

// The straightened 4:5 frame the variants are made from (and compared against): rotated, cropped, with the privacy
// boxes that still fall inside it blurred beyond recognition. No grade yet.
export async function straightenedBase(buffer: Buffer, plan: CropPlan, blurBoxes: Array<Pick<AssessmentOverlay, "x" | "y" | "w" | "h">>): Promise<Buffer> {
  const rotated = plan.rotate
    ? await sharp(buffer).rotate(plan.rotate, { background: "#808080" }).toBuffer({ resolveWithObject: true })
    : await sharp(buffer).toBuffer({ resolveWithObject: true });
  // sharp's canvas can differ from ours by a pixel: keep the window centred the same way
  const dx = (rotated.info.width - plan.canvas.w) / 2, dy = (rotated.info.height - plan.canvas.h) / 2;
  const left = Math.max(0, Math.min(rotated.info.width - plan.crop.w, Math.round(plan.crop.left + dx)));
  const top = Math.max(0, Math.min(rotated.info.height - plan.crop.h, Math.round(plan.crop.top + dy)));
  let img = sharp(rotated.data).extract({ left, top, width: plan.crop.w, height: plan.crop.h });
  const patches: OverlayOptions[] = [];
  if (blurBoxes.length) {
    const cropped = await img.toBuffer();
    for (const b of blurBoxes) {
      const r = mapBox(plan, b);
      const x0 = Math.max(0, Math.floor(r.left - left + dx)), y0 = Math.max(0, Math.floor(r.top - top + dy));
      const x1 = Math.min(plan.crop.w, Math.ceil(r.left - left + dx + r.w)), y1 = Math.min(plan.crop.h, Math.ceil(r.top - top + dy + r.h));
      if (x1 - x0 < 2 || y1 - y0 < 2) continue;
      const patch = await sharp(cropped).extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 })
        .blur(Math.max(6, Math.min(x1 - x0, y1 - y0) / 4)).toBuffer();
      patches.push({ input: patch, left: x0, top: y0 });
    }
    img = sharp(cropped);
  }
  if (patches.length) img = img.composite(patches);
  return img.jpeg({ quality: 92 }).toBuffer();
}

// ---------- variant A: the local grade ----------

const hexRgb = (hex: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) throw new Error(`not a hex colour: ${hex}`);
  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
};
const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

// Per-channel gains that move the photo's average colour toward the paper tone's warmth (70% of the way: a cast is
// corrected, not replaced), and an exposure factor that lifts the mean toward a light, airy 128.
export function gradeTowards(mean: { r: number; g: number; b: number }, paperHex: string, targetLuma = 128): { gains: [number, number, number]; exposure: number; offset: number } {
  const [pr, pg, pb] = hexRgb(paperHex);
  const pl = luma(pr, pg, pb), ml = Math.max(1, luma(mean.r, mean.g, mean.b));
  const clampG = (v: number) => Math.min(1.25, Math.max(0.8, v));
  const gain = (p: number, m: number) => clampG(1 + 0.7 * (p / pl / (Math.max(1, m) / ml) - 1));
  const gains: [number, number, number] = [gain(pr, mean.r), gain(pg, mean.g), gain(pb, mean.b)];
  const exposure = Math.min(1.6, Math.max(1, 1 + 0.55 * (targetLuma / ml - 1)));
  const offset = Math.min(30, Math.max(0, targetLuma - exposure * ml) * 0.5);
  return { gains, exposure, offset };
}

export interface VariantRender { buffer: Buffer; w: number; h: number; treatment: string; step: string }

export const POST_SIZE = { w: 1080, h: 1350 };

export async function renderVariantA(base: Buffer, o: { paper: string; rotate?: number }): Promise<VariantRender> {
  const st = await sharp(base).stats();
  const [r, g, b] = st.channels;
  const grade = gradeTowards({ r: r!.mean, g: g!.mean, b: b!.mean }, o.paper);
  const mul = grade.gains.map((x) => x * grade.exposure) as [number, number, number];
  const vignette = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${POST_SIZE.w}" height="${POST_SIZE.h}">
      <defs><radialGradient id="v" cx="50%" cy="48%" r="75%">
        <stop offset="0" stop-color="#ffffff"/><stop offset="0.62" stop-color="#ffffff"/><stop offset="1" stop-color="#cfc6ba"/>
      </radialGradient></defs>
      <rect width="100%" height="100%" fill="url(#v)"/>
    </svg>`);
  const graded = await sharp(base)
    .linear(mul, [grade.offset, grade.offset, grade.offset])
    .modulate({ saturation: 0.92 })
    .resize(POST_SIZE.w, POST_SIZE.h, { fit: "cover", kernel: "lanczos3" })
    .sharpen({ sigma: 0.6 })
    .toBuffer();
  const out = await sharp(graded).composite([{ input: vignette, blend: "multiply" }]).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
  const ev = Math.log2(grade.exposure);
  const parts = [
    ...(o.rotate ? [`straighten ${o.rotate > 0 ? "+" : ""}${o.rotate.toFixed(1)}°`] : ["straighten (level already)"]),
    "crop 4:5",
    `exposure +${ev.toFixed(1)} EV`,
    `white balance toward ${o.paper}`,
    "muted saturation",
    "subtle vignette",
    `${POST_SIZE.w}×${POST_SIZE.h}`,
  ];
  return { buffer: out, w: POST_SIZE.w, h: POST_SIZE.h, treatment: parts.join(", "), step: "local-grade" };
}

// ---------- Nisha's numbers ----------

// SSIM on a 160 px wide greyscale copy of both (contrast-stretched first, so a relight is not mistaken for a new
// building), 8 px windows every 4 px. `ssim` is the classic index; `structure` is its structure term alone (the
// correlation of the two windows), which is what "same building" means.
export async function similarity(a: Buffer, b: Buffer): Promise<{ ssim: number; structure: number }> {
  const ma = await sharp(a).metadata();
  const W = 160, H = Math.max(16, Math.round((W * (ma.height ?? 200)) / (ma.width ?? 160)));
  const prep = (buf: Buffer) => sharp(buf).greyscale().resize(W, H, { fit: "fill" }).normalise().blur(0.6).raw().toBuffer();
  const [pa, pb] = await Promise.all([prep(a), prep(b)]);
  const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;
  let ssimSum = 0, sSum = 0, n = 0, ns = 0;
  const WIN = 8, STEP = 4, TEXTURE_VAR = 36; // a window counts as textured above a standard deviation of 6 grey levels
  for (let y = 0; y + WIN <= H; y += STEP) {
    for (let x = 0; x + WIN <= W; x += STEP) {
      let sa = 0, sb = 0;
      for (let j = 0; j < WIN; j++) for (let i = 0; i < WIN; i++) { sa += pa[(y + j) * W + x + i]!; sb += pb[(y + j) * W + x + i]!; }
      const N = WIN * WIN, mua = sa / N, mub = sb / N;
      let va = 0, vb = 0, cov = 0;
      for (let j = 0; j < WIN; j++) for (let i = 0; i < WIN; i++) {
        const da = pa[(y + j) * W + x + i]! - mua, db = pb[(y + j) * W + x + i]! - mub;
        va += da * da; vb += db * db; cov += da * db;
      }
      va /= N - 1; vb /= N - 1; cov /= N - 1;
      ssimSum += ((2 * mua * mub + C1) * (2 * cov + C2)) / ((mua * mua + mub * mub + C1) * (va + vb + C2));
      n++;
      // Structure only where there is structure: two flat patches of sky "agree" about nothing, and an edge on one
      // side against a flat patch on the other is a disagreement (correlation 0), not a match.
      if (Math.max(va, vb) > TEXTURE_VAR) {
        sSum += Math.min(va, vb) > TEXTURE_VAR / 4 ? cov / Math.sqrt(va * vb) : 0;
        ns++;
      }
    }
  }
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return { ssim: r(ssimSum / n), structure: r(ns ? sSum / ns : 1) };
}

// ---------- the demo's "rough phone photo" ----------

// Makes an honest stand-in for a phone snap from a good photo: tilted, underexposed, cool, a little soft and noisy,
// and awkwardly framed. Used only to build the demo input (scripts/studio-demo.ts); never on an owner's upload.
export async function roughen(buffer: Buffer, o: { tiltDeg: number; seed?: number; crop?: { x: number; y: number; w: number; h: number } } = { tiltDeg: 5 }): Promise<Buffer> {
  const rotated = await sharp(buffer).rotate(o.tiltDeg, { background: "#8a8f94" }).toBuffer({ resolveWithObject: true });
  const meta = await sharp(buffer).metadata();
  const ins = maxInscribed(meta.width!, meta.height!, o.tiltDeg);
  const c = o.crop ?? { x: 0.06, y: 0.1, w: 0.9, h: 0.88 };
  const left = Math.round((rotated.info.width - ins.w) / 2 + c.x * ins.w), top = Math.round((rotated.info.height - ins.h) / 2 + c.y * ins.h);
  const width = Math.round(c.w * ins.w), height = Math.round(Math.min(c.h * ins.h, rotated.info.height - top));
  const framed = await sharp(rotated.data).extract({ left, top, width: Math.min(width, rotated.info.width - left), height })
    .linear([0.58, 0.62, 0.74], [-4, -2, 6]) // about a stop under, with a cool cast
    .blur(1.4)
    .raw().toBuffer({ resolveWithObject: true });
  // deterministic sensor noise
  let s = o.seed ?? 7;
  const rand = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const px = framed.data;
  for (let i = 0; i < px.length; i += framed.info.channels) {
    const n = (rand() + rand() + rand() - 1.5) * 14;
    for (let ch = 0; ch < 3; ch++) px[i + ch] = Math.max(0, Math.min(255, px[i + ch]! + n));
  }
  return sharp(px, { raw: framed.info }).jpeg({ quality: 78 }).toBuffer();
}
