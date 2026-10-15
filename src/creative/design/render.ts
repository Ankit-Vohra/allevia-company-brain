// HTML/CSS to a picture, in headless Chromium (Playwright). The composer's layouts are real web pages so the words get real
// typography: the brand's own font files loaded with @font-face, kerning and ligatures, Devanagari and other scripts shaped
// properly, `text-wrap: balance` on headlines and `pretty` on body lines (no orphan words), CSS grid, and object-fit crops.
//
// Every render also MEASURES what it drew, so the code can judge the result before anyone looks at it:
//   - each [data-role] element: its box, font size, line count, the words on its last line, and whether it overflowed;
//   - [data-fit] text is fitted in the page: the biggest size between data-min and data-max at which its area does not
//     overflow and it keeps to data-lines lines (a headline that cannot fit at its minimum is reported, never cut off);
//   - a second, "bare" render with every glyph made transparent gives the pixels BEHIND each text box, so the contrast of
//     the text against what is really under it (a photo, a scrim, a pill) is measured, not assumed.
// The page is our own HTML with every value escaped; it never loads anything from the network (every request is aborted:
// fonts and pictures arrive inline as data: URLs).
import { chromium, type Browser } from "playwright";
import sharp from "sharp";
import { contrast } from "../compose/palette.js";

export interface RenderBox {
  role: string;
  text: string;
  x: number; y: number; w: number; h: number;
  fontSize: number;
  lines: number;
  lastLineWords: number;
  overflow: boolean;          // the element or its fit area overflowed
  fitFailed: boolean;         // a [data-fit] element could not fit even at its minimum size
  color: string;              // computed text colour, #rrggbb
  isText: boolean;
  contrast?: number;          // measured: text colour against the 10th-percentile pixel behind it (WCAG ratio)
}

export interface RenderDoc { html: string; width: number; height: number }
export interface RenderResult { png: Buffer; boxes: RenderBox[]; width: number; height: number }

export interface HtmlRenderer {
  render(doc: RenderDoc): Promise<RenderResult>;
  close(): Promise<void>;
}

// Runs inside the page: fits [data-fit] text, then measures every [data-role] element.
const MEASURE = `(() => {
  const px = (v) => parseFloat(v) || 0;
  const hex = (c) => { const m = c.match(/\\d+(\\.\\d+)?/g); if (!m) return '#000000'; return '#' + m.slice(0, 3).map((v) => Math.round(+v).toString(16).padStart(2, '0')).join(''); };
  const linesOf = (el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const words = [];
    let n;
    while ((n = walker.nextNode())) {
      const t = n.textContent || '';
      const re = /\\S+/g; let m;
      while ((m = re.exec(t))) {
        const r = document.createRange(); r.setStart(n, m.index); r.setEnd(n, m.index + m[0].length);
        const rects = r.getClientRects();
        if (rects.length) words.push({ top: Math.round(rects[rects.length - 1].top), w: m[0] });
      }
    }
    if (!words.length) return { lines: 0, last: 0 };
    const tops = [];
    for (const w of words) if (!tops.some((t) => Math.abs(t - w.top) < 4)) tops.push(w.top);
    tops.sort((a, b) => a - b);
    const lastTop = tops[tops.length - 1];
    return { lines: tops.length, last: words.filter((w) => Math.abs(w.top - lastTop) < 4).length };
  };
  const areaOf = (el) => el.closest('[data-area]');
  // a word wider than its line (never broken mid-word)
  const tooWide = (el) => el.scrollWidth > el.clientWidth + 1;
  // the area's children reach outside the area (glyph overhang inside a tight line-height is not overflow)
  const spills = (a) => {
    if (!a) return false;
    const r = a.getBoundingClientRect();
    let top = Infinity, bottom = -Infinity, left = Infinity, right = -Infinity;
    for (const c of a.children) { const k = c.getBoundingClientRect(); if (!k.width && !k.height) continue; top = Math.min(top, k.top); bottom = Math.max(bottom, k.bottom); left = Math.min(left, k.left); right = Math.max(right, k.right); }
    return top < r.top - 1 || bottom > r.bottom + 1 || left < r.left - 1 || right > r.right + 1;
  };
  const overflows = (el) => tooWide(el) || spills(areaOf(el));
  const fits = (el) => { const max = +(el.dataset.lines || 99); return !overflows(el) && linesOf(el).lines <= max; };
  const fitFailed = new Set();
  const fitEls = [...document.querySelectorAll('[data-fit]')].sort((a, b) => (+(a.dataset.order || 0)) - (+(b.dataset.order || 0)));
  for (const el of fitEls) {
    let lo = +el.dataset.min, hi = +el.dataset.max;
    el.style.fontSize = hi + 'px';
    if (fits(el)) continue;
    el.style.fontSize = lo + 'px';
    if (!fits(el)) { fitFailed.add(el); continue; }
    while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); el.style.fontSize = mid + 'px'; if (fits(el)) lo = mid; else hi = mid; }
    el.style.fontSize = lo + 'px';
  }
  return [...document.querySelectorAll('[data-role]')].map((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const text = (el.dataset.text !== undefined ? el.dataset.text : el.innerText || '').replace(/\\s+/g, ' ').trim();
    const isText = el.dataset.kind !== 'image' && text.length > 0;
    const l = isText ? linesOf(el) : { lines: 0, last: 0 };
    return { role: el.dataset.role, text, x: r.x, y: r.y, w: r.width, h: r.height, fontSize: px(cs.fontSize), lines: l.lines, lastLineWords: l.last,
      overflow: isText && overflows(el), fitFailed: fitFailed.has(el), color: hex(cs.color), isText };
  });
})()`;

const BARE_CSS = `*, *::before, *::after { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; -webkit-text-stroke: 0 !important; text-decoration-color: transparent !important; caret-color: transparent !important; }`;

// The contrast of a text colour against the pixels behind its box: the 10th percentile (90% of the pixels behind it give at
// least this ratio), so one dark corner of a photo does not hide a washed-out middle.
export async function measuredContrast(bare: Buffer, box: { x: number; y: number; w: number; h: number }, color: string, size: { width: number; height: number }): Promise<number> {
  const left = Math.max(0, Math.floor(box.x)), top = Math.max(0, Math.floor(box.y));
  const width = Math.min(size.width - left, Math.ceil(box.w)), height = Math.min(size.height - top, Math.ceil(box.h));
  if (width < 2 || height < 2) return 21;
  const { data, info } = await sharp(bare).extract({ left, top, width, height }).resize({ width: Math.min(64, width), height: Math.min(64, height), fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const ratios: number[] = [];
  for (let i = 0; i < data.length; i += info.channels) ratios.push(contrast(color, { r: data[i]!, g: data[i + 1]!, b: data[i + 2]! }));
  ratios.sort((a, b) => a - b);
  return Math.round((ratios[Math.floor(ratios.length * 0.1)] ?? 21) * 100) / 100;
}

export interface ChromiumRendererOpts { launch?: () => Promise<Browser>; idleMs?: number; timeoutMs?: number }

// One browser for the process, opened on the first render and closed after a quiet spell (so a CLI run or a test exits).
export function chromiumRenderer(o: ChromiumRendererOpts = {}): HtmlRenderer {
  let browser: Promise<Browser> | undefined;
  let idle: NodeJS.Timeout | undefined;
  let busy = 0;
  const idleMs = o.idleMs ?? 20_000;
  const timeoutMs = o.timeoutMs ?? 60_000;
  const close = async (): Promise<void> => {
    const b = browser;
    browser = undefined;
    if (b) await (await b).close().catch(() => {});
  };
  const touch = (): void => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => { if (!busy) void close(); }, idleMs);
    idle.unref?.();
  };
  return {
    async render(doc: RenderDoc): Promise<RenderResult> {
      busy++;
      try {
        browser ??= (o.launch ?? (() => chromium.launch({ headless: true })))();
        const b = await browser;
        const ctx = await b.newContext({ viewport: { width: doc.width, height: doc.height }, deviceScaleFactor: 1, javaScriptEnabled: true, serviceWorkers: "block", acceptDownloads: false });
        try {
          await ctx.route("**/*", (r) => r.abort("blockedbyclient"));
          const page = await ctx.newPage();
          page.setDefaultTimeout(timeoutMs);
          await page.setContent(doc.html, { waitUntil: "load", timeout: timeoutMs });
          await page.evaluate("document.fonts.ready.then(() => true)");
          await page.evaluate("Promise.all([...document.images].map((i) => i.decode().catch(() => null)))");
          const boxes = (await page.evaluate(MEASURE)) as RenderBox[];
          const png = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: doc.width, height: doc.height }, animations: "disabled" });
          await page.addStyleTag({ content: BARE_CSS });
          const bare = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: doc.width, height: doc.height }, animations: "disabled" });
          for (const box of boxes) if (box.isText) box.contrast = await measuredContrast(bare, box, box.color, { width: doc.width, height: doc.height });
          return { png, boxes, width: doc.width, height: doc.height };
        } finally {
          await ctx.close().catch(() => {});
        }
      } finally {
        busy--;
        touch();
      }
    },
    close,
  };
}

let shared: HtmlRenderer | undefined;
export const sharedRenderer = (): HtmlRenderer => (shared ??= chromiumRenderer());
export async function closeSharedRenderer(): Promise<void> {
  const s = shared;
  shared = undefined;
  await s?.close();
}

// Escapes text for HTML (the words are always data, never markup).
export const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export const dataUrl = (bytes: Buffer, mime: string): string => `data:${mime};base64,${bytes.toString("base64")}`;
