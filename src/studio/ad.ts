// "Make this into an ad": the AI edit styles the picture and leaves calm space at the bottom; the business's OWN message is
// then drawn on it by code, in the brand's colours. Image models cannot be trusted with lettering (the content trials saw
// garbled text appear), and the message is the owner's own words, so it is set exactly as written, never generated.
import sharp from "sharp";
import { POST_SIZE } from "./image.js";

export interface AdText { headline: string; sub?: string }
export interface AdBrand { paper?: string; ink?: string; accent?: string; font?: string }

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const hex = (v: string | undefined, fallback: string): string => (v && /^#[0-9a-f]{6}$/i.test(v) ? v : fallback);

// Greedy word wrap by an estimated glyph width (about half the font size per character).
export function wrapLines(text: string, maxChars: number, maxLines: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if (cur && (cur + " " + w).length > maxChars) { lines.push(cur); cur = w; } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1]!.replace(/[.,;:!?\s]+$/, "")}…`;
    return kept;
  }
  return lines;
}

/** The ad: the styled picture at post size, a soft dark scrim along the bottom, the message in the brand's paper colour. */
export async function renderAd(picture: Buffer, text: AdText, brand: AdBrand = {}): Promise<Buffer> {
  const { w, h } = POST_SIZE;
  const headline = text.headline.replace(/\s+/g, " ").trim().slice(0, 100);
  const sub = (text.sub ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  const size = headline.length <= 24 ? 84 : headline.length <= 48 ? 68 : 56;
  const lines = wrapLines(headline, Math.floor((w - 160) / (size * 0.5)), 3);
  const subSize = 36;
  const lineH = Math.round(size * 1.12);
  const blockH = lines.length * lineH + (sub ? subSize + 28 : 0);
  const bottom = h - 90;
  const top = bottom - blockH;
  const ink = hex(brand.ink, "#191714");
  const paper = hex(brand.paper, "#f4f1ea");
  const accent = hex(brand.accent, "#d9a441");
  const family = `${brand.font ? `${esc(brand.font)}, ` : ""}Georgia, 'Times New Roman', serif`;
  const tspans = lines.map((l, i) => `<text x="80" y="${top + size + i * lineH - Math.round(size * 0.12)}" font-family="${family}" font-size="${size}" font-weight="700" fill="${paper}">${esc(l)}</text>`).join("");
  const subText = sub ? `<text x="80" y="${bottom - 4}" font-family="${family}" font-size="${subSize}" fill="${accent}">${esc(sub)}</text>` : "";
  const scrimTop = Math.max(0, top - 220);
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${ink}" stop-opacity="0"/><stop offset="0.55" stop-color="${ink}" stop-opacity="0.72"/><stop offset="1" stop-color="${ink}" stop-opacity="0.9"/></linearGradient></defs>
    <rect x="0" y="${scrimTop}" width="${w}" height="${h - scrimTop}" fill="url(#s)"/>
    <rect x="80" y="${top - 26}" width="96" height="6" fill="${accent}"/>
    ${tspans}${subText}
  </svg>`);
  return sharp(picture).resize(w, h, { fit: "cover" }).composite([{ input: svg }]).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}
