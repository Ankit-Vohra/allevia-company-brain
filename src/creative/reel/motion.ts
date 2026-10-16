// The reel's words and cards, made the way the founder's Aamdani reels are (aamdani-reel, reel-scenes, edit-reel): the hook
// is on screen from the first frame in Instagram-style boxes, each scene's line appears a few words at a time at reading
// pace (captions timed to the words, so the reel works on mute), everything sits inside Meta's reel safe zone (14% top,
// 35% bottom, 6% sides), and the end card carries the real logo and ONE action. All of it is HTML set in the brand's own
// fonts and rendered in Chromium (design/render.ts), so Devanagari and every other script is shaped properly.
import type { PlacedText } from "../compose/compose.js";
import { esc, type HtmlRenderer } from "../design/render.js";
import { logoNeedsPlate, type DesignSystem } from "../design/system.js";
import type { Picture } from "../design/layouts.js";

export const REEL_W = 1080;
export const REEL_H = 1920;
// Meta's Reels spec: keep words and logos out of the top 14%, the bottom 35% and 6% at each side.
export const REEL_SAFE = { top: 270, bottom: 672, side: 65 } as const;

export interface TimedOverlay { png: Buffer; from: number; to: number }
export interface ReelWords { timed: TimedOverlay[]; texts: PlacedText[] }

// Word groups of two or three for the reveal ("घर के पास" / "की नौकरी"); a group never starts with a lone short word.
export function wordGroups(text: string, size = 3): string[] {
  const w = text.trim().split(/\s+/).filter(Boolean);
  if (w.length <= size) return w.length ? [w.join(" ")] : [];
  const out: string[] = [];
  for (let i = 0; i < w.length; i += size) out.push(w.slice(i, i + size).join(" "));
  const last = out[out.length - 1]!;
  if (out.length > 1 && last.split(" ").length === 1) { out.pop(); out[out.length - 1] += ` ${last}`; }
  return out;
}

// When each group appears: the first at 0.15 s, then at reading pace (about 3 words a second), all shown by 70% of the scene.
export function revealTimes(groups: string[], seconds: number): number[] {
  if (!groups.length) return [];
  const words = groups.map((g) => g.split(/\s+/).length);
  const total = words.reduce((a, b) => a + b, 0);
  const span = Math.min(seconds * 0.7, total / 3);
  const out: number[] = [];
  let t = 0.15;
  for (const n of words) { out.push(Math.round(t * 100) / 100); t += (span * n) / total; }
  return out;
}

const DEVA = /[ऀ-ॿ]/;
const page = (ds: DesignSystem, css: string, body: string, lang: string): string =>
  `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><style>${ds.fonts.css}
*{box-sizing:border-box;margin:0;padding:0}html,body{width:${REEL_W}px;height:${REEL_H}px;background:transparent;overflow:hidden}
body{font-family:${ds.fonts.body};-webkit-font-smoothing:antialiased;font-kerning:normal}
.box{position:absolute;left:${REEL_SAFE.side}px;right:${REEL_SAFE.side}px;text-align:center}
.box p{display:inline;font-family:${ds.fonts.display};font-weight:700;-webkit-box-decoration-break:clone;box-decoration-break:clone;border-radius:14px;padding:.08em .38em .14em}
${css}</style></head><body>${body}</body></html>`;

// The line of one scene, revealed group by group in Instagram-style boxes, lower in the safe band; and on the first scene the
// hook, upper in the band, gone by 2.6 s (the Aamdani founder's pick: bold boxes above the heads, faded early).
export async function sceneWords(ds: DesignSystem, renderer: HtmlRenderer, o: { text: string; seconds: number; hook?: string }): Promise<ReelWords> {
  const c = ds.colour;
  const timed: TimedOverlay[] = [];
  const texts: PlacedText[] = [];
  const draw = async (html: string): Promise<{ png: Buffer; box?: { x: number; y: number; w: number; h: number }; size: number }> => {
    const r = await renderer.render({ html, width: REEL_W, height: REEL_H, transparent: true });
    const b = r.boxes.find((x) => x.role === "caption");
    return { png: r.png, ...(b ? { box: { x: b.x, y: b.y, w: b.w, h: b.h } } : {}), size: b?.fontSize ?? 0 };
  };
  const hook = o.hook?.trim();
  if (hook) {
    const deva = DEVA.test(hook);
    const html = page(ds, `.hook{top:${REEL_SAFE.top + 40}px}.hook p{font-size:84px;line-height:${deva ? 1.62 : 1.34};background:${c.deep};color:${c.onDeep}}`,
      `<div class="box hook" data-role="caption"><p>${esc(hook)}</p></div>`, deva ? "hi" : "en");
    const d = await draw(html);
    timed.push({ png: d.png, from: 0, to: Math.min(o.seconds, 2.6) });
    texts.push({ role: "hook", text: hook, shown: hook, box: d.box ?? { x: 0, y: 0, w: 0, h: 0 }, size: d.size, font: "BrandDisplay", color: c.onDeep, lines: [hook] });
  }
  const line = o.text.trim();
  if (line && line !== hook) {
    const groups = wordGroups(line);
    const times = revealTimes(groups, o.seconds);
    const deva = DEVA.test(line);
    const bottom = REEL_H - REEL_SAFE.bottom;
    for (let k = 0; k < groups.length; k++) {
      // everything said so far, the newest group in the brand's accent
      const shown = groups.slice(0, k + 1);
      const words = shown.map((g, j) => (j === k ? `<span class="new">${esc(g)}</span>` : esc(g))).join(" ");
      const html = page(ds, `.cap{bottom:${REEL_H - bottom}px}.cap p{font-size:70px;line-height:${deva ? 1.62 : 1.36};background:${c.ground};color:${c.ink}}.cap .new{color:${c.accentInk}}`,
        `<div class="box cap" data-role="caption" data-text="${esc(line)}"><p>${words}</p></div>`, deva ? "hi" : "en");
      const d = await draw(html);
      timed.push({ png: d.png, from: times[k]!, to: k + 1 < groups.length ? times[k + 1]! : o.seconds });
      if (k === groups.length - 1) texts.push({ role: "on screen", text: line, shown: line, box: d.box ?? { x: 0, y: 0, w: 0, h: 0 }, size: d.size, font: "BrandDisplay", color: c.ink, lines: [line] });
    }
  }
  return { timed, texts };
}

// The last card: the brand's deep colour, the real logo (on a plate when it would vanish) or the name, and ONE action.
export async function endCardHtml(ds: DesignSystem, renderer: HtmlRenderer, o: { line?: string; site?: string }): Promise<{ png: Buffer; texts: PlacedText[]; logo: "file" | "wordmark" }> {
  const c = ds.colour;
  const l = ds.logo;
  const plate = l ? logoNeedsPlate(l, c.deep) : false;
  const mark = l ? `<div class="lg${plate ? " plate" : ""}" data-role="logo" data-kind="image" data-text=""><img src="${l.url}" alt=""></div>` : `<p class="wm" data-role="logo">${esc(ds.business)}</p>`;
  const line = o.line?.trim();
  const deva = DEVA.test(line ?? "");
  const html = page(ds, `body{background:${c.deep}}
.wrap{position:absolute;left:${REEL_SAFE.side + 20}px;right:${REEL_SAFE.side + 20}px;top:${REEL_SAFE.top}px;bottom:${REEL_SAFE.bottom}px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:56px;text-align:center}
.lg{height:150px;display:flex;align-items:center}.lg img{height:100%;width:auto;max-width:760px;object-fit:contain}
.lg.plate{background:${c.ground};padding:26px 40px;border-radius:24px;height:200px}
.wm{font-family:${ds.fonts.display};font-weight:700;font-size:110px;color:${c.onDeep}}
.act{font-family:${ds.fonts.display};font-weight:700;font-size:66px;line-height:${deva ? 1.55 : 1.22};color:${c.accentOnDeep};text-wrap:balance}`,
    `<div class="wrap">${mark}${line ? `<p class="act" data-role="caption">${esc(line)}</p>` : ""}</div>`, deva ? "hi" : "en");
  const r = await renderer.render({ html, width: REEL_W, height: REEL_H });
  const b = r.boxes.find((x) => x.role === "caption");
  return { png: r.png, logo: l ? "file" : "wordmark", texts: line && b ? [{ role: "end card", text: line, shown: line, box: { x: b.x, y: b.y, w: b.w, h: b.h }, size: b.fontSize, font: "BrandDisplay", color: c.accentOnDeep, lines: [line] }] : [] };
}

// A real app screen as a reel frame: the phone large on the brand ground, and where in the frame its focus box lands (the
// camera pushes in there while the line about it is on screen).
export async function screenFrame(ds: DesignSystem, renderer: HtmlRenderer, s: Picture): Promise<{ png: Buffer; focus: { x: number; y: number } }> {
  const pw = 760, left = (REEL_W - pw) / 2, top = 230;
  const innerW = pw * 0.952;
  const f = s.focus ?? { x: 0.1, y: 0.3, w: 0.8, h: 0.2 };
  const fx = (left + pw * 0.024 + (f.x + f.w / 2) * innerW) / REEL_W;
  const fy = (top + pw * 0.024 + (f.y + f.h / 2) * innerW * (s.h / s.w)) / REEL_H;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:${REEL_W}px;height:${REEL_H}px;overflow:hidden;background:radial-gradient(ellipse at 50% 40%, ${ds.colour.ground}, color-mix(in srgb, ${ds.colour.ground} 82%, ${ds.colour.deep}))}
.phone{position:absolute;left:${left}px;top:${top}px;width:${pw}px;aspect-ratio:9/19.4;background:#101113;border-radius:9.5%/4.4%;padding:2.4%;box-shadow:0 60px 120px -40px rgba(0,0,0,.55)}
.scr{width:100%;height:100%;border-radius:7.6%/3.5%;overflow:hidden;background:${s.bg ?? "#fff"}}.scr img{display:block;width:100%;height:auto}</style></head>
<body><div class="phone"><div class="scr"><img src="${s.url}" alt=""></div></div></body></html>`;
  const r = await renderer.render({ html, width: REEL_W, height: REEL_H });
  return { png: r.png, focus: { x: Math.max(0.2, Math.min(0.8, fx)), y: Math.max(0.2, Math.min(0.8, fy)) } };
}
