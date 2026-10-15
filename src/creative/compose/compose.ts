// The poster and ad composer (the core of "make me a poster"). AI-generated artwork is only ever the background or the
// hero scene. Everything that has to be right is put on by code:
//   - the LOGO is the owner's real file, never regenerated: trimmed of empty margin, scaled with its proportions kept,
//     placed whole, and given a plate (in a brand colour) only when the backdrop would swallow it;
//   - the TEXT is the exact words given (headline, offer, call to action, details), set in the brand's own font files as
//     vector outlines (type.ts), measured before drawing, in the brand's colours chosen for contrast;
//   - the COLOURS are the brand palette (paper, dark, accent), never invented.
// Five layouts (hero-bottom, split, frame-centre, badge-offer, type-only) in four sizes (Instagram square, portrait and
// story with its safe zones, an A4 flyer). With no artwork the layout still works on a solid or gradient ground in the
// brand colours: that is also the honest fallback when the image engine is not available.
// A headline that cannot fit at a readable size is an error (PosterTextDoesNotFit), never a cut-off line.
import sharp, { type OverlayOptions } from "sharp";
import { FORMATS, type FormatKey, type PosterFormat } from "./formats.js";
import { contrast, ensureContrast, luminance, mix, parseHex, readableOn, type Palette } from "./palette.js";
import { coversText, drawText, fitText, layoutText, type LoadedFont, type TextStyle } from "./type.js";

export type LayoutKey = "hero-bottom" | "split" | "frame-centre" | "badge-offer" | "type-only";
export type Occasion = "festival" | "offer" | "announcement" | "general";

export const LAYOUTS: LayoutKey[] = ["hero-bottom", "split", "frame-centre", "badge-offer", "type-only"];

export interface PosterContent {
  headline: string;
  eyebrow?: string;      // e.g. the festival or the kind of post
  subline?: string;
  offer?: string;        // "20% off", exactly as the owner gave it
  cta?: string;          // "Visit avsatelier.in"
  details?: string[];    // date, time, place
}

export interface FontPair { regular: LoadedFont | null; bold: LoadedFont | null }

export interface BrandForCompose {
  businessName: string;
  palette: Palette;
  heading: FontPair;
  body: FontPair;
  // the owner's real logo as a PNG (or JPEG) with its size, or null: then the name is set in the heading font and said so
  logo: { bytes: Buffer; w: number; h: number } | null;
}

export interface Rect { x: number; y: number; w: number; h: number }

export interface PlacedText { role: string; text: string; shown: string; box: Rect; size: number; font: string; color: string; lines: string[] }
export interface PosterManifest {
  format: FormatKey; layout: LayoutKey; width: number; height: number;
  texts: PlacedText[];
  logo: { kind: "file" | "wordmark"; box: Rect; plate: boolean; plateColor?: string; scale: number; sourceW: number; soft: boolean };
  artwork: boolean;
  colours: { paper: string; dark: string; accent: string; light: string; background: string };
  fonts: { heading: string; body: string };
  problems: string[];
}
export interface ComposedPoster { buffer: Buffer; mime: "image/jpeg" | "image/png"; w: number; h: number; manifest: PosterManifest }

export class PosterTextDoesNotFit extends Error {
  override name = "PosterTextDoesNotFit";
  constructor(readonly role: string, readonly text: string, readonly maxWords?: number) {
    super(`The ${role} "${text.length > 60 ? `${text.slice(0, 57)}...` : text}" is too long to fit on the poster at a readable size. Shorten it${maxWords ? ` to about ${maxWords} words` : ""}.`);
  }
}
export class PosterFontMissing extends Error {
  override name = "PosterFontMissing";
}

const hex = (c: string): string => c;
const round = (n: number): number => Math.round(n);
const intersects = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (a: Rect, w: number, h: number): boolean => a.x >= -0.5 && a.y >= -0.5 && a.x + a.w <= w + 0.5 && a.y + a.h <= h + 0.5;

// Which layouts suit an occasion, best first: an offer leads with a badge, a festival with a framed picture, an
// announcement with the headline over the picture. With no artwork only the type layout and the panel ones make sense.
export function layoutOrder(occasion: Occasion, hasArtwork: boolean): LayoutKey[] {
  const base: Record<Occasion, LayoutKey[]> = {
    offer: ["badge-offer", "split", "hero-bottom", "frame-centre", "type-only"],
    festival: ["frame-centre", "hero-bottom", "badge-offer", "split", "type-only"],
    announcement: ["hero-bottom", "split", "frame-centre", "badge-offer", "type-only"],
    general: ["hero-bottom", "split", "frame-centre", "badge-offer", "type-only"],
  };
  return hasArtwork ? base[occasion] : ["type-only", "split", "frame-centre"] as LayoutKey[];
}

const lum = (c: string): number => luminance(parseHex(c));

interface Ctx {
  F: PosterFormat; w: number; h: number; m: number; brand: BrandForCompose; p: Palette; content: PosterContent;
  under: string; over: string; texts: PlacedText[]; problems: string[]; layers: Array<{ input: Buffer; left: number; top: number }>;
  background: string;
}

const pick = (pair: FontPair, bold: boolean): LoadedFont => {
  const f = bold ? pair.bold ?? pair.regular : pair.regular ?? pair.bold;
  if (!f) throw new PosterFontMissing("No font is available for the poster text.");
  return f;
};

// Sets one block of text: fits it into the box, draws it, records it. Returns where it ended.
function setText(
  c: Ctx, role: string, text: string, o: {
    font: LoadedFont; color: string; x: number; y: number; w: number; h: number; max: number; min: number; maxLines?: number;
    align?: "left" | "center" | "right"; upper?: boolean; letterSpacing?: number; lineHeight?: number; maxWords?: number;
  },
): { box: Rect; size: number; below: number } {
  const style: Omit<TextStyle, "size" | "color"> = {
    font: o.font, ...(o.align ? { align: o.align } : {}), ...(o.upper ? { upper: true } : {}), ...(o.letterSpacing !== undefined ? { letterSpacing: o.letterSpacing } : {}),
    ...(o.lineHeight ? { lineHeight: o.lineHeight } : {}),
  };
  if (!coversText(o.font, text)) throw new PosterFontMissing(`The font ${o.font.family} has no letters for "${text.slice(0, 40)}".`);
  const fit = fitText(text, style, { w: o.w, h: o.h }, { max: o.max, min: o.min, ...(o.maxLines ? { maxLines: o.maxLines } : {}) });
  if (!fit.ok) throw new PosterTextDoesNotFit(role, text, o.maxWords);
  const drawn = drawText(fit.layout, { ...style, size: fit.size, color: o.color }, o.x, o.y, o.w);
  c.over += drawn.svg;
  c.texts.push({ role, text, shown: drawn.lines.join(" "), box: drawn.box, size: fit.size, font: o.font.family, color: o.color, lines: drawn.lines });
  return { box: drawn.box, size: fit.size, below: o.y + fit.layout.height };
}

// A block measured but not drawn (to stack blocks from the bottom up).
function measure(text: string, o: { font: LoadedFont; w: number; h: number; max: number; min: number; maxLines?: number; upper?: boolean; letterSpacing?: number; lineHeight?: number }): { height: number; size: number; ok: boolean } {
  const fit = fitText(text, { font: o.font, ...(o.upper ? { upper: true } : {}), ...(o.letterSpacing !== undefined ? { letterSpacing: o.letterSpacing } : {}), ...(o.lineHeight ? { lineHeight: o.lineHeight } : {}) },
    { w: o.w, h: o.h }, { max: o.max, min: o.min, ...(o.maxLines ? { maxLines: o.maxLines } : {}) });
  return { height: fit.layout.height, size: fit.size, ok: fit.ok };
}

const pill = (x: number, y: number, w: number, h: number, fill: string): string => `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="${(h / 2).toFixed(1)}" fill="${fill}"/>`;

// A text block stack, drawn top-down from y. Roles in order; each is optional. Returns the bottom edge.
interface StackOpts { x: number; y: number; w: number; maxH: number; align: "left" | "center"; onDark: boolean; scale?: number }

function drawStack(c: Ctx, o: StackOpts): number {
  const { content: t, p, F, w } = c;
  const sc = o.scale ?? 1;
  const ink = o.onDark ? p.light : p.dark;
  const soft = o.onDark ? mix(p.light, p.dark, 0.18) : mix(p.dark, p.paper, 0.3);
  // the brand accent, nudged towards light (on dark) or dark (on paper) only as far as it takes to be readable
  const accentText = o.onDark ? ensureContrast(p.accent, p.dark, 4.5, p.light) : ensureContrast(p.accent, p.paper, 4.5, p.dark);
  const heading = pick(c.brand.heading, true), body = pick(c.brand.body, false), bodyBold = pick(c.brand.body, true);
  let y = o.y;
  const gap = round(w * 0.022);
  const add = (role: string, text: string | undefined, f: Parameters<typeof setText>[3]): void => {
    if (!text?.trim()) return;
    const r = setText(c, role, text.trim(), f);
    y = r.below + gap;
  };
  const avail = (): number => Math.max(20, o.maxH - (y - o.y));
  add("eyebrow", t.eyebrow, { font: bodyBold, color: accentText, x: o.x, y, w: o.w, h: round(w * 0.06), max: round(w * 0.03 * sc), min: round(w * 0.02), upper: true, letterSpacing: 0.14, align: o.align, maxLines: 1, maxWords: 4 });
  add("headline", t.headline, { font: heading, color: ink, x: o.x, y, w: o.w, h: Math.min(avail() * 0.62, F.h * 0.34), max: round(w * 0.105 * sc), min: round(w * 0.05), maxLines: 4, lineHeight: 1.06, align: o.align, maxWords: 9 });
  add("subline", t.subline, { font: body, color: soft, x: o.x, y, w: o.w, h: Math.min(avail() * 0.5, F.h * 0.14), max: round(w * 0.038 * sc), min: round(w * 0.024), maxLines: 3, lineHeight: 1.28, align: o.align, maxWords: 22 });
  for (const d of t.details ?? []) add("detail", d, { font: bodyBold, color: ink, x: o.x, y, w: o.w, h: round(w * 0.1), max: round(w * 0.034 * sc), min: round(w * 0.022), maxLines: 2, align: o.align, maxWords: 14 });
  if (t.offer?.trim()) add("offer", t.offer, { font: heading, color: accentText, x: o.x, y, w: o.w, h: Math.min(avail() * 0.5, F.h * 0.16), max: round(w * 0.09 * sc), min: round(w * 0.04), maxLines: 2, lineHeight: 1.05, align: o.align, maxWords: 6 });
  if (t.cta?.trim()) {
    const bf = bodyBold, size = round(w * 0.034 * sc);
    const lay = layoutText(t.cta.trim(), { font: bf, size, letterSpacing: 0.02 }, o.w - size * 2);
    if (lay.overflowWord || lay.lines.length > 1 || lay.height + size > avail()) throw new PosterTextDoesNotFit("call to action", t.cta, 8);
    const pw = lay.width + size * 2, ph = size * 2.1;
    const px = o.align === "center" ? o.x + (o.w - pw) / 2 : o.x;
    const fill = p.accent, label = readableOn(fill, p.light, p.dark);
    c.over += pill(px, y, pw, ph, fill);
    const drawn = drawText(lay, { font: bf, size, color: label, letterSpacing: 0.02, align: "left" }, px + size, y + (ph - lay.height) / 2, lay.width);
    c.over += drawn.svg;
    c.texts.push({ role: "cta", text: t.cta.trim(), shown: drawn.lines.join(" "), box: { x: px, y, w: pw, h: ph }, size, font: bf.family, color: label, lines: drawn.lines });
    y += ph + gap;
  }
  return y - gap;
}

// The stack's height, measured without drawing, so a bottom-anchored block knows where to start.
function stackHeight(c: Ctx, o: Omit<StackOpts, "y">): number {
  const probe: Ctx = { ...c, over: "", texts: [], problems: [] };
  return drawStack(probe, { ...o, y: 0 }) - 0;
}

function wordmarkText(brand: BrandForCompose): string { return brand.businessName; }

// The biggest scale at which the whole stack fits `maxH` (1 down to 0.55): every block shrinks together, so the poster keeps
// its proportions. When even the smallest scale does not fit, the text is too long for this layout and the caller is told which block.
function fitStack(c: Ctx, o: Omit<StackOpts, "y" | "scale">): { scale: number; height: number } {
  let last: unknown;
  for (const scale of [1, 0.92, 0.85, 0.78, 0.7, 0.62, 0.55]) {
    try {
      const height = stackHeight(c, { ...o, scale });
      if (height <= o.maxH) return { scale, height };
    } catch (e) {
      if (!(e instanceof PosterTextDoesNotFit)) throw e;
      last = e;
    }
  }
  throw last ?? new PosterTextDoesNotFit("text", c.content.headline);
}

// Fits and draws the stack in the band [top, bottom]: at the bottom, the top, or the middle of it.
function placeStack(c: Ctx, o: { x: number; w: number; top: number; bottom: number; align: "left" | "center"; onDark: boolean; at: "bottom" | "top" | "middle"; scaleCap?: number }): void {
  const band = o.bottom - o.top;
  const { scale, height } = fitStack(c, { x: o.x, w: o.w, maxH: band, align: o.align, onDark: o.onDark });
  const sc = Math.min(scale, o.scaleCap ?? 1);
  const h2 = sc === scale ? height : stackHeight(c, { x: o.x, w: o.w, maxH: band, align: o.align, onDark: o.onDark, scale: sc });
  const y = o.at === "bottom" ? o.bottom - h2 : o.at === "top" ? o.top : o.top + (band - h2) / 2;
  drawStack(c, { x: o.x, y, w: o.w, maxH: band, align: o.align, onDark: o.onDark, scale: sc });
}

interface LogoSpot { x: number; y: number; w: number; h: number; align?: "left" | "center" | "right" }

// The logo (or the name as a wordmark) in its spot, after the base is drawn: the plate decision needs the pixels behind it.
async function placeLogo(c: Ctx, base: Buffer, spot: LogoSpot): Promise<{ overlays: OverlayOptions[]; info: PosterManifest["logo"] }> {
  const { brand, p } = c;
  if (!brand.logo) {
    const f = pick(brand.heading, true);
    const region = await sharp(base).extract({ left: Math.max(0, round(spot.x)), top: Math.max(0, round(spot.y)), width: Math.min(c.w - round(spot.x), round(spot.w)), height: Math.min(c.h - round(spot.y), round(spot.h)) }).stats();
    const bg = { r: region.channels[0]!.mean, g: region.channels[1]!.mean, b: region.channels[2]!.mean };
    const color = readableOn(bg, p.light, p.dark);
    const text = wordmarkText(brand);
    if (!coversText(f, text)) throw new PosterFontMissing(`The font ${f.family} has no letters for the name "${text}".`);
    const fit = fitText(text, { font: f, letterSpacing: 0.01, align: spot.align ?? "left" }, { w: spot.w, h: spot.h }, { max: round(spot.h * 0.7), min: round(spot.h * 0.25), maxLines: 1 });
    if (!fit.ok) throw new PosterTextDoesNotFit("name", text);
    const dx = spot.align === "center" ? spot.x : spot.align === "right" ? spot.x : spot.x;
    const drawn = drawText(fit.layout, { font: f, size: fit.size, color, letterSpacing: 0.01, align: spot.align ?? "left" }, dx, spot.y + (spot.h - fit.layout.height) / 2, spot.w);
    c.over += drawn.svg;
    return { overlays: [], info: { kind: "wordmark", box: drawn.box, plate: false, scale: 1, sourceW: 0, soft: false } };
  }
  // the real logo: trim empty margin, keep proportions, never stretch beyond what the file can bear
  const trimmed = await sharp(brand.logo.bytes).trim({ threshold: 8 }).png().toBuffer({ resolveWithObject: true }).catch(() => null);
  const src = trimmed ? { bytes: trimmed.data, w: trimmed.info.width, h: trimmed.info.height } : brand.logo;
  const fitScale = Math.min(spot.w / src.w, spot.h / src.h);
  const scale = Math.min(fitScale, 1.5);
  const lw = Math.max(1, round(src.w * scale)), lh = Math.max(1, round(src.h * scale));
  const lx = spot.align === "center" ? spot.x + (spot.w - lw) / 2 : spot.align === "right" ? spot.x + spot.w - lw : spot.x;
  const ly = spot.y + (spot.h - lh) / 2;
  const logoPng = await sharp(src.bytes).resize(lw, lh, { fit: "fill", kernel: "lanczos3" }).ensureAlpha().png().toBuffer();
  // what the logo looks like (alpha-weighted mean colour) against what is behind it
  const thumb = await sharp(logoPng).resize(48, 48, { fit: "inside" }).raw().toBuffer({ resolveWithObject: true });
  let r = 0, g = 0, b = 0, a = 0;
  for (let i = 0; i < thumb.data.length; i += 4) { const al = thumb.data[i + 3]! / 255; r += thumb.data[i]! * al; g += thumb.data[i + 1]! * al; b += thumb.data[i + 2]! * al; a += al; }
  const opaque = thumb.data.length ? (a / (thumb.data.length / 4)) > 0.97 : false;
  const logoRgb = a > 0 ? { r: r / a, g: g / a, b: b / a } : { r: 0, g: 0, b: 0 };
  const pad = round(Math.min(lw, lh) * 0.18);
  const region = await sharp(base).extract({ left: Math.max(0, round(lx - pad)), top: Math.max(0, round(ly - pad)), width: Math.min(c.w - Math.max(0, round(lx - pad)), lw + 2 * pad), height: Math.min(c.h - Math.max(0, round(ly - pad)), lh + 2 * pad) }).stats();
  const back = { r: region.channels[0]!.mean, g: region.channels[1]!.mean, b: region.channels[2]!.mean };
  const cornerPx = await sharp(logoPng).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
  const cornerColor = `#${[cornerPx[0], cornerPx[1], cornerPx[2]].map((v) => (v ?? 0).toString(16).padStart(2, "0")).join("")}`;
  // a logo with its own opaque background keeps that colour as its plate; a transparent one gets a plate only when it would vanish
  let plate: string | undefined;
  if (opaque) {
    // its own background is its plate (rounded to sit softly) unless that would disappear into the backdrop: then a contrasting one
    plate = contrast(cornerColor, back) >= 2 ? cornerColor
      : [p.paper, p.light, p.dark, "#ffffff", "#000000"].reduce((best, cand) => (Math.min(contrast(cand, cornerColor), contrast(cand, back)) > Math.min(contrast(best, cornerColor), contrast(best, back)) ? cand : best));
  } else if (contrast(logoRgb, back) < 3) plate = [p.paper, p.light, p.dark, "#ffffff", "#000000"].reduce((best, cand) => (contrast(logoRgb, cand) > contrast(logoRgb, best) ? cand : best));
  const overlays: OverlayOptions[] = [];
  let box: Rect = { x: lx, y: ly, w: lw, h: lh };
  if (plate) {
    const pr = round(pad * 0.9);
    const pb = { x: lx - pad, y: ly - pad, w: lw + 2 * pad, h: lh + 2 * pad };
    const plateSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${c.w}" height="${c.h}"><rect x="${pb.x.toFixed(1)}" y="${pb.y.toFixed(1)}" width="${pb.w.toFixed(1)}" height="${pb.h.toFixed(1)}" rx="${pr}" fill="${plate}"/></svg>`);
    overlays.push({ input: plateSvg, left: 0, top: 0 });
    box = pb;
  }
  overlays.push({ input: logoPng, left: round(lx), top: round(ly) });
  return { overlays, info: { kind: "file", box, plate: !!plate, ...(plate ? { plateColor: plate } : {}), scale: round(scale * 100) / 100, sourceW: src.w, soft: scale > 1.25 || src.w < lw * 0.8 } };
}

const gradient = (id: string, x1: number, y1: number, x2: number, y2: number, stops: Array<[number, string, number]>): string =>
  `<linearGradient id="${id}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${stops.map(([o, col, a]) => `<stop offset="${o}" stop-color="${col}" stop-opacity="${a}"/>`).join("")}</linearGradient>`;

async function coverArt(art: Buffer, w: number, h: number): Promise<Buffer> {
  return sharp(art).resize(w, h, { fit: "cover", position: sharp.strategy.attention, kernel: "lanczos3" }).png().toBuffer();
}

export interface ComposeRequest {
  format: FormatKey;
  layout: LayoutKey;
  content: PosterContent;
  brand: BrandForCompose;
  artwork?: Buffer | null;
}

export async function composePoster(req: ComposeRequest): Promise<ComposedPoster> {
  const F = FORMATS[req.format];
  const { w, h } = F;
  const p = req.brand.palette;
  const c: Ctx = { F, w, h, m: F.margin, brand: req.brand, p, content: req.content, under: "", over: "", texts: [], problems: [], layers: [], background: p.paper };
  const hasArt = !!req.artwork;
  const layout: LayoutKey = hasArt || req.layout === "type-only" || req.layout === "split" || req.layout === "frame-centre" ? req.layout : "type-only";
  const useLayout: LayoutKey = !hasArt && (layout === "hero-bottom" || layout === "badge-offer") ? "type-only" : layout;
  const m = c.m;
  const tw = w - 2 * m;                       // text width
  const top = F.safeTop, bottom = h - F.safeBottom;
  let spot: LogoSpot;
  const logoH = round(h * (req.format === "flyer" ? 0.06 : req.format === "insta_story" ? 0.055 : 0.1));
  const logoW = round(w * (req.format === "insta_square" ? 0.3 : 0.34));
  const defs: string[] = [];

  switch (useLayout) {
    case "hero-bottom": {
      c.background = p.dark;
      c.layers.push({ input: await coverArt(req.artwork!, w, h), left: 0, top: 0 });
      const textH = h * 0.5;
      defs.push(gradient("scrim", 0, 0, 0, 1, [[0, p.dark, 0], [0.35, p.dark, 0.55], [1, p.dark, 0.93]]));
      c.under += `<rect x="0" y="${round(h - textH * 1.45)}" width="${w}" height="${round(textH * 1.45)}" fill="url(#scrim)"/>`;
      defs.push(gradient("topscrim", 0, 0, 0, 1, [[0, p.dark, 0.5], [1, p.dark, 0]]));
      c.under += `<rect x="0" y="0" width="${w}" height="${round(h * 0.2)}" fill="url(#topscrim)"/>`;
      placeStack(c, { x: m, w: tw, top: top + logoH + 60, bottom, align: "left", onDark: true, at: "bottom" });
      spot = { x: m, y: top, w: logoW, h: logoH };
      break;
    }
    case "split": {
      const artH = round(h * (hasArt ? 0.52 : 0.0));
      if (hasArt) c.layers.push({ input: await coverArt(req.artwork!, w, artH), left: 0, top: 0 });
      c.under += `<rect x="0" y="${artH}" width="${w}" height="${h - artH}" fill="${p.paper}"/>`;
      c.background = p.paper;
      const panelTop = hasArt ? artH + round(h * 0.045) : top + logoH + round(h * 0.06);
      placeStack(c, { x: m, w: tw, top: panelTop, bottom, align: "left", onDark: false, at: "top" });
      c.under += `<rect x="${m}" y="${artH + (hasArt ? round(h * 0.018) : 0)}" width="${round(w * 0.12)}" height="${round(h * 0.006)}" fill="${p.accent}"/>`;
      spot = hasArt ? { x: m, y: top, w: logoW, h: logoH } : { x: m, y: top, w: logoW, h: logoH };
      break;
    }
    case "frame-centre": {
      c.background = p.paper;
      const frameTop = top + logoH + round(h * 0.04);
      const frameH = round(h * (req.format === "insta_square" ? 0.3 : req.format === "insta_story" ? 0.3 : req.format === "flyer" ? 0.36 : 0.34));
      if (hasArt) {
        c.layers.push({ input: await coverArt(req.artwork!, tw, frameH), left: m, top: frameTop });
        c.under += `<rect x="${m - 10}" y="${frameTop - 10}" width="${tw + 20}" height="${frameH + 20}" fill="none" stroke="${p.accent}" stroke-width="3"/>`;
      }
      const textTop = hasArt ? frameTop + frameH + round(h * 0.04) : frameTop;
      placeStack(c, { x: m, w: tw, top: textTop, bottom, align: "center", onDark: false, at: "middle" });
      spot = { x: m, y: top, w: tw, h: logoH, align: "center" };
      break;
    }
    case "badge-offer": {
      c.background = p.dark;
      c.layers.push({ input: await coverArt(req.artwork!, w, h), left: 0, top: 0 });
      defs.push(gradient("veil", 0, 0, 0, 1, [[0, p.dark, 0.25], [0.45, p.dark, 0.35], [1, p.dark, 0.92]]));
      c.under += `<rect width="${w}" height="${h}" fill="url(#veil)"/>`;
      const d = round(Math.min(w, h) * 0.3);
      const cx = w - m - d / 2, cy = top + logoH + d / 2 + round(h * 0.03);
      const offerText = req.content.offer?.trim();
      const badgeContent: PosterContent = { ...req.content, offer: undefined };
      const savedContent = c.content;
      c.content = badgeContent;
      try { placeStack(c, { x: m, w: tw, top: top + logoH + d + round(h * 0.06), bottom, align: "left", onDark: true, at: "bottom" }); } finally { c.content = savedContent; }
      if (offerText) {
        c.under += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(d / 2).toFixed(1)}" fill="${p.accent}"/><circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(d / 2 - 12).toFixed(1)}" fill="none" stroke="${readableOn(p.accent, p.light, p.dark)}" stroke-width="2" stroke-opacity="0.7"/>`;
        const inner = round(d * 0.66);
        setText(c, "offer", offerText, {
          font: pick(req.brand.heading, true), color: readableOn(p.accent, p.light, p.dark), x: cx - inner / 2, y: cy - inner * 0.34, w: inner, h: round(inner * 0.7), max: round(d * 0.3), min: round(d * 0.1), maxLines: 3,
          align: "center", lineHeight: 1.04, maxWords: 4,
        });
      }
      spot = { x: m, y: top, w: logoW, h: logoH };
      break;
    }
    case "type-only":
    default: {
      // the ground: a gradient in the brand colours (dark to a deeper accent), or paper when the brand is light and quiet
      const a = mix(p.dark, p.accent, 0.55);
      defs.push(gradient("ground", 0, 0, 1, 1, [[0, p.dark, 1], [1, a, 1]]));
      c.background = p.dark;
      c.under += `<rect width="${w}" height="${h}" fill="url(#ground)"/>`;
      c.under += `<rect x="${m}" y="${round(h * 0.38)}" width="${round(w * 0.14)}" height="${round(h * 0.006)}" fill="${p.accent}"/>`;
      placeStack(c, { x: m, w: tw, top: round(h * 0.4) + round(h * 0.03), bottom, align: "left", onDark: true, at: "top" });
      spot = { x: m, y: top, w: logoW, h: logoH };
      break;
    }
  }

  // ---- render: ground, artwork, shapes, logo (with its plate), then the text on top ----
  const defsSvg = defs.length ? `<defs>${defs.join("")}</defs>` : "";
  let base = await sharp({ create: { width: w, height: h, channels: 4, background: hex(c.background) } }).png().toBuffer();
  if (c.layers.length) base = await sharp(base).composite(c.layers.map((l) => ({ input: l.input, left: l.left, top: l.top }))).png().toBuffer();
  if (c.under) base = await sharp(base).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${defsSvg}${c.under}</svg>`), left: 0, top: 0 }]).png().toBuffer();
  const logo = await placeLogo(c, base, spot);
  const overSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${c.over}</svg>`);
  const final = await sharp(base).composite([...logo.overlays, { input: overSvg, left: 0, top: 0 }]).removeAlpha();
  const buffer = F.mime === "image/png" ? await final.png({ compressionLevel: 9 }).toBuffer() : await final.jpeg({ quality: 93, chromaSubsampling: "4:4:4", mozjpeg: true }).toBuffer();

  // ---- the code's own checks of the result ----
  const problems = [...c.problems];
  const safe: Rect = { x: 0, y: F.safeTop, w, h: h - F.safeTop - F.safeBottom };
  for (const t of c.texts) {
    if (!inside(t.box, w, h)) problems.push(`the ${t.role} runs off the poster`);
    if (F.key === "insta_story" && (t.box.y < safe.y - 1 || t.box.y + t.box.h > safe.y + safe.h + 1)) problems.push(`the ${t.role} sits where the story's own buttons are`);
    if (intersects(t.box, logo.info.box)) problems.push(`the ${t.role} overlaps the logo`);
  }
  if (!inside(logo.info.box, w, h)) problems.push("the logo runs off the poster");
  if (logo.info.soft) problems.push("the logo file is small for this size, so it may look soft");
  const manifest: PosterManifest = {
    format: req.format, layout: useLayout, width: w, height: h, texts: c.texts, logo: logo.info, artwork: hasArt,
    colours: { paper: p.paper, dark: p.dark, accent: p.accent, light: p.light, background: c.background },
    fonts: { heading: pick(req.brand.heading, true).family, body: pick(req.brand.body, false).family },
    problems,
  };
  return { buffer, mime: F.mime, w, h, manifest };
}
