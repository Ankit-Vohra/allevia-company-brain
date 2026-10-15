// Text for posters, drawn by code from the brand's own font files: each glyph's outline becomes a vector path (fontkit
// shapes the text, so kerning, ligatures and Devanagari come out right), and the paths are drawn into the poster with
// sharp. No platform font stack is involved, so the same file gives the same pixels on a Mac and in Docker, the words are
// exactly the words given (never re-typed by a model), and every line's width is measured before anything is drawn, so a
// headline that does not fit is made smaller or said to not fit, never cut off.
import { createHash } from "node:crypto";
import * as fontkit from "fontkit";

interface FkGlyph { path: { toSVG(): string }; id: number }
interface FkRun { glyphs: FkGlyph[]; positions: Array<{ xAdvance: number; xOffset: number; yOffset: number }> }
interface FkFont {
  familyName: string; unitsPerEm: number; ascent: number; descent: number; capHeight: number; xHeight: number;
  layout(text: string, features?: string[]): FkRun; hasGlyphForCodePoint(cp: number): boolean;
}

export interface LoadedFont { family: string; sha: string; font: FkFont }

const cache = new Map<string, LoadedFont>();

// A font from the bytes of a TrueType, OpenType or WOFF file. null when the bytes are not a font.
export function loadFont(bytes: Buffer): LoadedFont | null {
  const sha = createHash("sha256").update(bytes).digest("hex");
  const hit = cache.get(sha);
  if (hit) return hit;
  try {
    const f = fontkit.create(bytes) as unknown as FkFont | { fonts: FkFont[] };
    const font = "fonts" in f ? f.fonts[0] : f;
    if (!font || !font.unitsPerEm) return null;
    const loaded = { family: font.familyName, sha, font };
    cache.set(sha, loaded);
    return loaded;
  } catch {
    return null;
  }
}

// Does the font have a glyph for every character of the text (spaces and line breaks aside)?
export function coversText(f: LoadedFont, text: string): boolean {
  for (const ch of text) {
    if (/\s/u.test(ch)) continue;
    if (!f.font.hasGlyphForCodePoint(ch.codePointAt(0)!)) return false;
  }
  return true;
}

export interface TextStyle {
  font: LoadedFont;
  size: number;                          // px (the em)
  color: string;
  align?: "left" | "center" | "right";
  letterSpacing?: number;                // em
  lineHeight?: number;                   // em, default 1.14
  upper?: boolean;                       // set in capitals
}

export interface Line { text: string; width: number }
export interface TextLayout { lines: Line[]; width: number; height: number; lineH: number; capH: number; size: number; overflowWord: boolean }

const run = (f: LoadedFont, text: string): FkRun => f.font.layout(text);

function widthOf(f: LoadedFont, text: string, size: number, letterSpacing: number): number {
  if (!text) return 0;
  const r = run(f, text);
  const adv = r.positions.reduce((n, p) => n + p.xAdvance, 0);
  return (adv * size) / f.font.unitsPerEm + letterSpacing * size * Math.max(0, r.glyphs.length - 1);
}

export const displayText = (text: string, upper?: boolean): string => (upper ? text.toLocaleUpperCase() : text);

// Greedy word wrap at a size. A single word wider than the box cannot be broken: overflowWord says so.
export function layoutText(text: string, st: Pick<TextStyle, "font" | "size" | "letterSpacing" | "lineHeight" | "upper">, maxWidth: number): TextLayout {
  const ls = st.letterSpacing ?? 0;
  const shown = displayText(text, st.upper).replace(/[ \t]+/g, " ").trim();
  const space = widthOf(st.font, " ", st.size, 0) + ls * st.size;
  const lines: Line[] = [];
  let overflowWord = false;
  for (const para of shown.split(/\n+/)) {
    let cur = "", curW = 0;
    for (const word of para.split(" ").filter(Boolean)) {
      const w = widthOf(st.font, word, st.size, ls);
      if (w > maxWidth + 0.5) overflowWord = true;
      if (cur && curW + space + w > maxWidth + 0.5) { lines.push({ text: cur, width: curW }); cur = word; curW = w; }
      else { cur = cur ? `${cur} ${word}` : word; curW = cur === word ? w : curW + space + w; }
    }
    if (cur) lines.push({ text: cur, width: curW });
  }
  const lineH = st.size * (st.lineHeight ?? 1.14);
  const capH = (st.font.font.capHeight || st.font.font.unitsPerEm * 0.7) * st.size / st.font.font.unitsPerEm;
  const descent = (Math.abs(st.font.font.descent) * st.size / st.font.font.unitsPerEm) * 0.55;
  return {
    lines, width: Math.max(0, ...lines.map((l) => l.width)), lineH, capH, size: st.size, overflowWord,
    height: lines.length ? capH + (lines.length - 1) * lineH + descent : 0,
  };
}

export interface Fitted { layout: TextLayout; size: number; ok: boolean }

// The largest size (from max down to min, in steps) at which the text fits the box, in at most maxLines lines, with no word
// wider than the box. ok=false when even the smallest size does not fit: the caller says so instead of drawing it.
export function fitText(
  text: string, st: Omit<TextStyle, "size" | "color">, box: { w: number; h: number }, o: { max: number; min: number; maxLines?: number },
): Fitted {
  let last: Fitted | undefined;
  for (let size = o.max; size >= o.min; size -= Math.max(1, Math.round(o.max * 0.04))) {
    const layout = layoutText(text, { ...st, size }, box.w);
    const ok = !layout.overflowWord && layout.height <= box.h && layout.lines.length <= (o.maxLines ?? 99);
    last = { layout, size, ok };
    if (ok) return last;
  }
  const layout = layoutText(text, { ...st, size: o.min }, box.w);
  return { layout, size: o.min, ok: !layout.overflowWord && layout.height <= box.h && layout.lines.length <= (o.maxLines ?? 99) };
}

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export interface DrawnText { svg: string; box: { x: number; y: number; w: number; h: number }; lines: string[] }

// The SVG for a laid-out block whose top-left is (x, y) inside a box `boxW` wide (for centring and right alignment).
export function drawText(layout: TextLayout, st: TextStyle, x: number, y: number, boxW: number): DrawnText {
  const scale = st.size / st.font.font.unitsPerEm;
  const ls = (st.letterSpacing ?? 0) * st.size;
  let svg = "";
  let minX = Infinity, maxX = -Infinity;
  layout.lines.forEach((line, li) => {
    const lx = st.align === "center" ? x + (boxW - line.width) / 2 : st.align === "right" ? x + boxW - line.width : x;
    const baseline = y + layout.capH + li * layout.lineH;
    const r = run(st.font, line.text);
    let pen = 0;
    let paths = "";
    r.glyphs.forEach((g, i) => {
      const p = r.positions[i]!;
      const d = g.path.toSVG();
      if (d) paths += `<path transform="translate(${((pen + p.xOffset) * scale + 0).toFixed(2)},${(baseline - p.yOffset * scale).toFixed(2)}) scale(${scale.toFixed(5)},${(-scale).toFixed(5)})" d="${d}"/>`;
      pen += p.xAdvance + (ls / scale);
    });
    svg += `<g transform="translate(${lx.toFixed(2)},0)" aria-label="${esc(line.text)}">${paths}</g>`;
    minX = Math.min(minX, lx); maxX = Math.max(maxX, lx + line.width);
  });
  return {
    svg: `<g fill="${st.color}">${svg}</g>`,
    box: { x: Number.isFinite(minX) ? minX : x, y, w: Number.isFinite(minX) ? maxX - minX : 0, h: layout.height },
    lines: layout.lines.map((l) => l.text),
  };
}
