// Colour maths for the poster composer, and the palette it works from: the brand's own colours (paper, ink, accent), never
// invented ones. Text colour is chosen by contrast (WCAG), so a poster stays readable whatever artwork sits behind it.
export interface Rgb { r: number; g: number; b: number }

export const HEX6 = /^#[0-9a-f]{6}$/i;

export function parseHex(hex: string): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`not a colour: ${JSON.stringify(hex)}`);
  const n = parseInt(m[1]!, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export const toHex = (c: Rgb): string => `#${[c.r, c.g, c.b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;

export function luminance(c: Rgb): number {
  const f = (v: number) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

export function contrast(a: Rgb | string, b: Rgb | string): number {
  const la = luminance(typeof a === "string" ? parseHex(a) : a), lb = luminance(typeof b === "string" ? parseHex(b) : b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export function mix(a: string, b: string, t: number): string {
  const x = parseHex(a), y = parseHex(b);
  return toHex({ r: x.r + (y.r - x.r) * t, g: x.g + (y.g - x.g) * t, b: x.b + (y.b - x.b) * t });
}

export interface Palette {
  paper: string;     // the light ground
  dark: string;      // the darkest brand colour: headlines on paper, scrims
  accent: string;    // the brand's primary or accent colour
  light: string;     // text on dark: the paper colour when it is light enough, else white
  source: "brand" | "default";
}

export const DEFAULT_PALETTE: Palette = { paper: "#f4f1ea", dark: "#191714", accent: "#a8542e", light: "#f4f1ea", source: "default" };

// The palette from the brand kit's colours (any may be missing). The darkest of the text and neutral colours is the dark;
// the primary (else accent) colour is the accent; the paper is the background colour. Missing ones are made from what is
// there, so a one-colour brand still gets a coherent poster.
export function paletteFrom(k: { paper?: string; ink?: string; accent?: string; neutral?: string; extra?: string[] }): Palette {
  const have = [k.paper, k.ink, k.accent, k.neutral, ...(k.extra ?? [])].filter((c): c is string => !!c && HEX6.test(c));
  if (!have.length) return DEFAULT_PALETTE;
  const paper = k.paper && HEX6.test(k.paper) ? k.paper.toLowerCase() : "#f4f1ea";
  const darks = [k.ink, k.neutral].filter((c): c is string => !!c && HEX6.test(c)).sort((a, b) => luminance(parseHex(a)) - luminance(parseHex(b)));
  const dark = (darks[0] ?? "#191714").toLowerCase();
  const accent = (k.accent && HEX6.test(k.accent) ? k.accent : k.extra?.find((c) => HEX6.test(c) && contrast(c, paper) >= 2.2) ?? mix(dark, "#c8a23d", 0.5)).toLowerCase();
  return { paper, dark: contrast(dark, paper) >= 7 ? dark : mix(dark, "#000000", 0.55), accent, light: luminance(parseHex(paper)) > 0.6 ? paper : "#ffffff", source: "brand" };
}

// The more readable of two candidate text colours on a background.
export function readableOn(bg: string | Rgb, a: string, b: string): string {
  return contrast(bg, a) >= contrast(bg, b) ? a : b;
}

// `fg` itself when it reads on `bg` (contrast at least `min`), else `fg` mixed towards `toward` in small steps until it does:
// the brand's colour, no more changed than it takes.
export function ensureContrast(fg: string, bg: string, min: number, toward: string): string {
  for (let t = 0; t <= 1.0001; t += 0.1) {
    const c = t === 0 ? fg : mix(fg, toward, t);
    if (contrast(c, bg) >= min) return c;
  }
  return toward;
}
