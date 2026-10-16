// The design system a layout is built from, per business: the brand's own fonts (as @font-face from its files), colour
// ROLES derived from its colours with every text pairing held to WCAG contrast, one modular type scale, an 8-point spacing
// scale and the platform's safe zones. Layouts never pick a colour or a size of their own: they use these tokens, so two
// layouts for one brand look like one brand, and a weak pairing (gold text on cream) is fixed here once, not per poster.
import sharp from "sharp";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contrast, ensureContrast, luminance, mix, parseHex, readableOn, type Palette, type Rgb } from "../compose/palette.js";
import type { BrandForCompose, FontPair } from "../compose/compose.js";
import type { FormatKey } from "../compose/formats.js";
import { dataUrl } from "./render.js";

export interface ColourRoles {
  ground: string;        // the light paper
  ink: string;           // text on ground (>= 7:1)
  muted: string;         // secondary text on ground (>= 4.5:1)
  accent: string;        // the brand's signature colour, for fills and rules
  accentInk: string;     // accent as text on ground (>= 4.5:1, nudged no further than needed)
  onAccent: string;      // text on an accent fill (>= 4.5:1)
  deep: string;          // the dark ground (the brand's darkest colour, or ink)
  onDeep: string;        // text on deep (>= 7:1)
  mutedOnDeep: string;   // secondary text on deep (>= 4.5:1)
  accentOnDeep: string;  // accent as text on deep (>= 4.5:1)
  second: string;        // a second brand colour for chips and small marks (accent when there is none)
  onSecond: string;
  line: string;          // hairlines and frames on ground
}

export interface TypeScale { hero: number; display: number; h1: number; h2: number; lede: number; body: number; small: number; min: number }

export interface DesignSystem {
  business: string;
  colour: ColourRoles;
  type: TypeScale;
  space: (n: number) => number;   // 8-point grid: space(1) = 8 px
  fonts: { css: string; display: string; body: string };
  logo: LogoInfo | null;
  colours: string[];              // the brand colours on record
}

export interface LogoInfo { url: string; w: number; h: number; dark: boolean; opaque: boolean; mean: string }

// Type: one modular scale (perfect fourth, 1.333) from a 32 px floor. A 1080-px-wide picture is seen 360-430 px wide on a
// phone (x0.33-0.40), so 32 px reads as ~12 px and body text (43 px) as ~16 px, Material's body size: nothing on a post is
// set smaller than the floor, and only captions under a photo sit at it.
export const RATIO = 1.333;
export function typeScale(format: FormatKey): TypeScale {
  const k = format === "flyer" ? 1.5 : 1;
  const min = Math.round(32 * k), step = (n: number) => Math.round(min * RATIO ** n);
  return { min, small: min, body: step(1), lede: step(1.6), h2: step(3), h1: step(4), display: step(5), hero: step(6) };
}

const lum = (c: string): number => luminance(parseHex(c));
const chroma = (c: string): number => { const x = parseHex(c); return Math.max(x.r, x.g, x.b) - Math.min(x.r, x.g, x.b); };

// Which colours the record names by role (background, text, primary); the rest are read from the colours themselves.
export interface NamedRoles { paper: boolean; ink: boolean; accent: boolean }

export function colourRoles(p: Palette, brandColours: string[], named: NamedRoles = { paper: true, ink: true, accent: true }): ColourRoles {
  const own = [...new Set(brandColours.map((c) => c.toLowerCase()))];
  // a palette with no roles (swatches the owner sent): the lightest is the ground, the darkest the ink, the most colourful the accent
  const lightest = [...own].sort((a, b) => lum(b) - lum(a))[0];
  const ground = !named.paper && lightest && lum(lightest) > 0.8 ? lightest : p.paper;
  const darkest = [...own].sort((a, b) => lum(a) - lum(b))[0];
  const ink = !named.ink && darkest && contrast(darkest, ground) >= 7 ? darkest : p.dark;
  const vivid = own.filter((c) => lum(c) > 0.05 && lum(c) < 0.75).sort((a, b) => chroma(b) - chroma(a))[0];
  const accentPick = !named.accent && vivid ? vivid : p.accent;
  const all = [...new Set([...own, ground, ink, accentPick])];
  // the deep ground: the brand's darkest colour with some colour in it (a forest green, a deep brown), else the ink
  const darks = all.filter((c) => lum(c) < 0.09 && contrast(c, ground) >= 7).sort((a, b) => chroma(b) - chroma(a));
  const deep = darks[0] ?? ink;
  const onDeep = contrast(ground, deep) >= 7 ? ground : "#ffffff";
  const accent = accentPick;
  const onAccent = ensureContrast(readableOn(accent, onDeep, ink), accent, 4.5, contrast(accent, "#ffffff") > contrast(accent, "#000000") ? "#ffffff" : "#000000");
  // a second colour: the most colourful brand colour that is not the accent and reads against the ground as a fill
  const second = all.filter((c) => c !== accent && c !== ground && c !== deep && chroma(c) > 40 && contrast(c, ground) >= 2).sort((a, b) => chroma(b) - chroma(a))[0] ?? accent;
  return {
    ground, ink,
    muted: ensureContrast(mix(ink, ground, 0.3), ground, 4.5, ink),
    accent,
    accentInk: ensureContrast(accent, ground, 4.5, ink),
    onAccent,
    deep, onDeep,
    mutedOnDeep: ensureContrast(mix(onDeep, deep, 0.3), deep, 4.5, onDeep),
    accentOnDeep: ensureContrast(accent, deep, 4.5, onDeep),
    second, onSecond: ensureContrast(readableOn(second, onDeep, ink), second, 4.5, contrast(second, "#ffffff") > contrast(second, "#000000") ? "#ffffff" : "#000000"),
    line: mix(ink, ground, 0.82),
  };
}

const VENDOR_FONTS = new URL("../../../vendor/fonts/", import.meta.url);
const vendorFont = (file: string): Buffer | null => { try { return readFileSync(join(VENDOR_FONTS.pathname, file)); } catch { return null; } };

function faces(alias: string, pair: FontPair): string {
  const out: string[] = [];
  const add = (bytes: Buffer | undefined, weight: number) => { if (bytes) out.push(`@font-face{font-family:"${alias}";src:url(${dataUrl(bytes, "font/ttf")}) format("truetype");font-weight:${weight};font-style:normal;font-display:block}`); };
  add(pair.regular?.bytes, 400);
  if (pair.bold?.bytes && pair.bold.sha !== pair.regular?.sha) add(pair.bold.bytes, 700);
  else add(pair.regular?.bytes, 700); // one file: the browser synthesises no fake bold, the one weight stands for both
  return out.join("\n");
}

export async function logoInfo(bytes: Buffer): Promise<LogoInfo> {
  const trimmed = await sharp(bytes).trim({ threshold: 8 }).png().toBuffer({ resolveWithObject: true }).catch(async () => sharp(bytes).png().toBuffer({ resolveWithObject: true }));
  const { data, info } = await sharp(trimmed.data).ensureAlpha().resize(64, 64, { fit: "inside" }).raw().toBuffer({ resolveWithObject: true });
  let r = 0, g = 0, b = 0, a = 0, n = 0;
  for (let i = 0; i < data.length; i += 4) { const al = data[i + 3]! / 255; r += data[i]! * al; g += data[i + 1]! * al; b += data[i + 2]! * al; a += al; n++; }
  const mean: Rgb = a > 0 ? { r: r / a, g: g / a, b: b / a } : { r: 0, g: 0, b: 0 };
  const hex = `#${[mean.r, mean.g, mean.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
  return { url: dataUrl(trimmed.data, "image/png"), w: trimmed.info.width, h: trimmed.info.height, dark: luminance(mean) < 0.35, opaque: n > 0 && a / n > 0.97, mean: hex };
}

export async function designSystem(brand: BrandForCompose, colours: string[], format: FormatKey, named?: NamedRoles): Promise<DesignSystem> {
  const inter = { regular: { family: "Inter", sha: "inter-400", font: null as never, bytes: vendorFont("Inter-400.ttf") ?? undefined }, bold: { family: "Inter", sha: "inter-700", font: null as never, bytes: vendorFont("Inter-700.ttf") ?? undefined } };
  const css = [faces("BrandDisplay", brand.heading), faces("BrandBody", brand.body), faces("HouseSans", inter)].join("\n");
  const stack = (first: string) => `"${first}", "BrandBody", "HouseSans", "Noto Sans Devanagari", "Kohinoor Devanagari", "Devanagari Sangam MN", system-ui, sans-serif`;
  return {
    business: brand.businessName,
    colour: colourRoles(brand.palette, colours, named),
    type: typeScale(format),
    space: (n: number) => Math.round(n * 8),
    fonts: { css, display: stack("BrandDisplay"), body: stack("BrandBody") },
    logo: brand.logo ? await logoInfo(brand.logo.bytes) : null,
    colours,
  };
}

// Is a logo of this tone readable straight on this ground, or does it need a plate?
export const logoNeedsPlate = (logo: LogoInfo, ground: string): boolean => logo.opaque ? false : contrast(logo.mean, ground) < 3;
