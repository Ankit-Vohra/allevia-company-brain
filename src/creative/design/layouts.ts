// The layout library: sixteen genuinely different formats for posts, stories and ads, each a small HTML/CSS page built
// only from the brand's design system (system.ts). Each one says WHEN to use it and what it NEEDS (a real app screen, real
// photos, an offer, a quote...), so the chooser (choose.ts) can pick by the brief and the material at hand, and never
// repeat the last layout a business used.
//
// The rules every layout keeps (docs/design-research.md has the sources):
//   - one idea: one headline, at most one supporting line, ONE call to action; nothing else competes;
//   - hierarchy by size and weight from one modular scale (1.333): headline >= 2.4x the supporting line, nothing under 30 px;
//   - real material first: the business's own photos and real app screens; a generated scene only where none fits;
//   - words never over a face or the busy middle of a photo: a calibrated scrim or a solid ground under every line;
//   - text-wrap: balance on headlines and pretty on body lines (no orphan words), Devanagari gets taller lines;
//   - a story keeps every word and the logo inside the safe band (270 px from the top, 400 px from the bottom; Meta's 14%);
//   - the logo is the owner's real file, small and calm, on a plate only when the ground would swallow it.
import { esc } from "./render.js";
import { logoNeedsPlate, type DesignSystem } from "./system.js";
import type { FormatKey } from "../compose/formats.js";

export type LayoutKey =
  | "device-hero" | "scene-device" | "feature-callout" | "photo-full-bleed" | "editorial-frame" | "gallery-trio"
  | "split-panel" | "offer-card" | "big-type" | "quote-card" | "before-after" | "date-announcement"
  | "hiring-card" | "local-place" | "carousel-cover" | "event-poster";

export interface Picture {
  url: string;                 // a data: URL (the bytes travel inside the page)
  w: number; h: number;
  kind: "photo" | "scene" | "screen";
  id?: string;                 // the Asset or BrandAsset it came from (lineage)
  label?: string;              // a caption the owner gave (a project's name), shown small where the layout has room
  focal?: { x: number; y: number };                       // 0..1: what must stay in frame when it is cropped
  focus?: { x: number; y: number; w: number; h: number }; // a screen's region the words are about (fractions)
  bg?: string;                 // a screen's own background colour (fills the phone below a cropped screen)
}

export interface DesignCopy {
  headline: string;
  support?: string;
  eyebrow?: string;
  cta?: string;
  offer?: string;
  details?: string[];
  quote?: { text: string; by?: string; illustrative?: boolean };
  pair?: [string, string];     // before / after labels
}

export interface Tune {
  scrim: number;               // 0 light .. 3 strongest shade under words on a photo
  scale: number;               // headline scale factor (0.8 .. 1.15)
  focal?: "center" | "top" | "bottom" | "left" | "right";
  plate: boolean;              // the logo on a plate
  ground: "ground" | "deep";   // light or dark ground where the layout has a choice
  dropEyebrow: boolean;
  dropSupport: boolean;
  swapPhotos: boolean;         // use the photos in another order
}

export const DEFAULT_TUNE: Tune = { scrim: 1, scale: 1, plate: false, ground: "ground", dropEyebrow: false, dropSupport: false, swapPhotos: false };

export interface LayoutInput {
  format: FormatKey; w: number; h: number;
  ds: DesignSystem;
  copy: DesignCopy;
  photos: Picture[];           // the business's own photos (projects, products, place), best first
  screens: Picture[];          // real app screens, best first
  scene?: Picture;             // a generated scene, when there is no real photo for the idea
  tune: Tune;
}

export interface Needs { screens?: number; photos?: number; offer?: boolean; quote?: boolean; details?: number; pair?: boolean; date?: boolean }

export interface LayoutDef {
  key: LayoutKey;
  name: string;
  use: string;                 // when to use it, for the chooser and the skills
  needs: Needs;
  goals: Array<"sell" | "offer" | "announce" | "awareness">;
  build(i: LayoutInput): { body: string; css: string };
}

// ---------- shared pieces ----------

const DEVA = /[ऀ-ॿ]/;
const script = (s: string | undefined): string => (s && DEVA.test(s) ? " deva" : "");
const pics = (i: LayoutInput): Picture[] => { const p = [...i.photos, ...(i.scene ? [i.scene] : [])]; return i.tune.swapPhotos && p.length > 1 ? [...p.slice(1), p[0]!] : p; };
const pos = (p: Picture | undefined, t: Tune): string => {
  if (t.focal === "top") return "50% 20%";
  if (t.focal === "bottom") return "50% 80%";
  if (t.focal === "left") return "25% 50%";
  if (t.focal === "right") return "75% 50%";
  if (p?.focal) return `${Math.round(p.focal.x * 100)}% ${Math.round(p.focal.y * 100)}%`;
  return "50% 50%";
};
export const img = (p: Picture, t: Tune, cls = "ph", role = "photo"): string =>
  `<img class="${cls}" data-role="${role}" data-kind="image" data-text="" src="${p.url}" style="object-position:${pos(p, t)}" alt="">`;

// The headline, fitted in the page between min and max (scaled by the tune), on at most `lines` lines.
const headline = (i: LayoutInput, o: { max: number; min?: number; lines?: number; cls?: string; tag?: string }): string => {
  const max = Math.round(o.max * i.tune.scale), min = Math.round(o.min ?? Math.max(i.ds.type.h2 * 0.8, i.ds.type.lede));
  return `<h1 class="hl ${o.cls ?? ""}${script(i.copy.headline)}" data-role="headline" data-fit data-order="1" data-min="${Math.min(min, max)}" data-max="${max}" data-lines="${o.lines ?? 4}">${esc(i.copy.headline)}</h1>`;
};
const support = (i: LayoutInput, cls = ""): string =>
  i.copy.support && !i.tune.dropSupport ? `<p class="sup ${cls}${script(i.copy.support)}" data-role="support" data-fit data-order="2" data-min="${i.ds.type.body}" data-max="${i.ds.type.lede}" data-lines="3">${esc(i.copy.support)}</p>` : "";
const eyebrow = (i: LayoutInput, cls = ""): string =>
  i.copy.eyebrow && !i.tune.dropEyebrow ? `<p class="eb ${cls}${script(i.copy.eyebrow)}" data-role="eyebrow">${esc(i.copy.eyebrow)}</p>` : "";
const cta = (i: LayoutInput, cls = "pill"): string =>
  i.copy.cta ? `<p class="cta ${cls}${script(i.copy.cta)}" data-role="cta">${esc(i.copy.cta)}</p>` : "";
const details = (i: LayoutInput, cls = "chips"): string =>
  i.copy.details?.length ? `<ul class="${cls}">${i.copy.details.map((d) => `<li class="${script(d).trim()}" data-role="detail">${esc(d)}</li>`).join("")}</ul>` : "";
// The real logo file (never redrawn), or the name set in the display face when there is no file.
const logo = (i: LayoutInput, o: { on: "ground" | "deep" | "photo"; cls?: string }): string => {
  const l = i.ds.logo;
  if (!l) return `<p class="wordmark ${o.cls ?? ""} on-${o.on}" data-role="logo">${esc(i.ds.business)}</p>`;
  const plate = i.tune.plate || (o.on === "photo" ? l.dark && !l.opaque : logoNeedsPlate(l, o.on === "deep" ? i.ds.colour.deep : i.ds.colour.ground));
  return `<div class="logo ${o.cls ?? ""}${plate ? " plate" : ""}" data-role="logo" data-kind="image" data-text=""><img src="${l.url}" alt=""></div>`;
};
const phone = (s: Picture, cls = ""): string =>
  `<div class="phone ${cls}" data-role="screen" data-kind="image" data-text=""><div class="scr" style="background:${s.bg ?? "#ffffff"}"><img src="${s.url}" alt=""></div><i class="isl"></i></div>`;

// ---------- the base sheet: tokens, type, pieces ----------

export function baseCss(i: Pick<LayoutInput, "format" | "w" | "h" | "ds">): string {
  const c = i.ds.colour, t = i.ds.type;
  const story = i.format === "insta_story";
  const m = i.format === "flyer" ? 120 : i.format === "insta_square" ? 72 : 80;
  return `${i.ds.fonts.css}
:root{--ground:${c.ground};--ink:${c.ink};--muted:${c.muted};--accent:${c.accent};--accent-ink:${c.accentInk};--on-accent:${c.onAccent};
--deep:${c.deep};--on-deep:${c.onDeep};--muted-deep:${c.mutedOnDeep};--accent-deep:${c.accentOnDeep};--second:${c.second};--on-second:${c.onSecond};--line:${c.line};
--display:${i.ds.fonts.display};--body:${i.ds.fonts.body};
--hero:${t.hero}px;--d:${t.display}px;--h1:${t.h1}px;--h2:${t.h2}px;--lede:${t.lede}px;--b:${t.body}px;--s:${t.small}px;
--m:${m}px;--st:${story ? 270 : m}px;--sb:${story ? 400 : m}px;--W:${i.w}px;--H:${i.h}px}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${i.w}px;height:${i.h}px;overflow:hidden;background:var(--ground)}
body{font-family:var(--body);color:var(--ink);font-kerning:normal;font-feature-settings:"kern","liga";-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
.f{position:relative;width:${i.w}px;height:${i.h}px;overflow:hidden}
.hl{font-family:var(--display);font-weight:700;line-height:1.04;letter-spacing:-0.018em;text-wrap:balance;hyphens:none;overflow-wrap:normal}
.hl.deva{line-height:1.28;letter-spacing:0}
.sup{font-size:var(--lede);line-height:1.32;text-wrap:pretty;font-weight:400}
.sup.deva{line-height:1.5}
.eb{font-size:var(--s);font-weight:700;letter-spacing:.01em;line-height:1.3;color:var(--accent-ink)}
.cta{font-size:var(--b);font-weight:700;line-height:1.2;text-wrap:balance}
.cta.deva{line-height:1.45}
.pill{display:inline-block;align-self:flex-start;background:var(--accent);color:var(--on-accent);padding:.62em 1.05em .66em;border-radius:999px}
.link{display:inline-block;border-bottom:3px solid currentColor;padding-bottom:.12em}
.chips{list-style:none;display:flex;flex-wrap:wrap;gap:14px}
.chips li{font-size:var(--s);font-weight:700;line-height:1.25;padding:.5em .9em;border-radius:999px;background:var(--second);color:var(--on-second)}
.chips li.deva{line-height:1.5}
.logo{display:flex;align-items:center}
.logo img{display:block;height:100%;width:auto;max-width:100%;object-fit:contain}
.logo.plate{background:var(--ground);padding:14px 22px;border-radius:16px;box-shadow:0 6px 24px rgba(0,0,0,.18)}
.wordmark{font-family:var(--display);font-weight:700;font-size:var(--b);letter-spacing:-0.01em}
.wordmark.on-deep,.wordmark.on-photo{color:var(--on-deep)}
.wordmark.on-photo{background:color-mix(in srgb,var(--deep) 80%,transparent);padding:.22em .6em .28em;border-radius:12px;align-self:flex-start}
.ph{display:block;width:100%;height:100%;object-fit:cover}
.phone{position:absolute;aspect-ratio:9/19.4;background:#101113;border-radius:9.5%/4.4%;padding:2.4%;box-shadow:0 50px 90px -30px rgba(0,0,0,.55),0 0 0 2px #2b2c30 inset}
.phone .scr{width:100%;height:100%;border-radius:7.6%/3.5%;overflow:hidden}
.phone .scr img{display:block;width:100%;height:auto}
.phone .isl{position:absolute;top:2.9%;left:50%;width:27%;height:2.6%;transform:translateX(-50%);background:#101113;border-radius:999px}
`;
}

// ---------- the sixteen layouts ----------

const deviceHero: LayoutDef = {
  key: "device-hero", name: "Product hero: the real app in a phone",
  use: "An app or software launch, or 'it's live / coming soon': the real screen IS the product, so it is the hero. Headline and action above, the phone (two phones for two screens) rising from the bottom edge. Needs one real app screen.",
  needs: { screens: 1 }, goals: ["announce", "sell", "awareness"],
  build: (i) => {
    const [a, b] = i.screens;
    const deep = i.tune.ground === "deep";
    const story = i.format === "insta_story", sq = i.format === "insta_square";
    const body = `<div class="f dh ${deep ? "deep" : "light"}">
  <header class="top">${logo(i, { on: deep ? "deep" : "ground", cls: "lg" })}${eyebrow(i)}</header>
  <section class="words" data-area>${headline(i, { max: sq ? i.ds.type.h1 : i.ds.type.display, lines: 3 })}${support(i)}${cta(i)}</section>
  ${b ? phone(b, "back") : ""}${phone(a!, "front")}
</div>`;
    // geometry: the words take the top band, the phones fill the rest and run off the bottom edge
    const wordsTop = story ? 370 : 175, wordsH = story ? 620 : sq ? 420 : 470;
    const phoneTop = wordsTop + wordsH + (story ? 40 : 30);
    const fw = story ? 640 : sq ? 360 : 500, bw = Math.round(fw * 0.86);
    const frontLeft = sq ? 1080 - 72 - fw : b ? (story ? 380 : 470) : Math.round((1080 - fw) / 2);
    const css = `
.dh.light{background:var(--ground)}.dh.deep{background:var(--deep);color:var(--on-deep)}
.dh.deep .sup{color:var(--muted-deep)}.dh.light .sup{color:var(--muted)}.dh.deep .eb{color:var(--accent-deep)}
.dh .top{position:absolute;left:var(--m);right:var(--m);top:var(--st);height:${story ? 80 : 68}px;display:flex;justify-content:space-between;align-items:center}
.dh .lg{height:100%}
.dh .words{position:absolute;left:var(--m);${sq ? "width:560px" : "right:var(--m)"};top:${wordsTop}px;height:${sq ? 1080 - 175 - 72 : wordsH}px;display:flex;flex-direction:column;gap:22px;overflow:hidden}
.dh .words .pill{margin-top:6px}
.dh .front{width:${fw}px;left:${frontLeft}px;top:${sq ? 200 : phoneTop}px}
.dh .back{width:${bw}px;left:${story ? 60 : 110}px;top:${(sq ? 200 : phoneTop) + Math.round(fw * 0.32)}px;transform:rotate(-4deg);opacity:.97}
.dh.deep .pill{box-shadow:0 10px 30px rgba(0,0,0,.35)}`;
    return { body, css };
  },
};

const sceneDevice: LayoutDef = {
  key: "scene-device", name: "Person and the real screen",
  use: "An app feature in someone's real day: a photograph of the person and the place (real, or a generated scene with the phone's back to camera) above, the REAL screen in a phone overlapping the edge, the words on a calm ground beside it. Needs a screen and a photo or scene.",
  needs: { screens: 1, photos: 1 }, goals: ["sell", "announce", "awareness"],
  build: (i) => {
    const p = pics(i)[0]!, s = i.screens[0]!;
    const story = i.format === "insta_story", sq = i.format === "insta_square";
    const photoH = story ? 1000 : sq ? 560 : 740;
    const pw = sq ? 280 : 340, ptop = story ? 700 : sq ? 300 : 420;
    const body = `<div class="f sd">
  <div class="pic">${img(p, i.tune)}<div class="fade"></div></div>
  <div class="lgw">${logo(i, { on: "photo", cls: "lg" })}</div>
  ${phone(s, "ph1")}
  <section class="words" data-area>${eyebrow(i)}${headline(i, { max: i.ds.type.h1, lines: 4 })}${support(i)}${cta(i, "link")}</section>
</div>`;
    const css = `
.sd{background:var(--ground)}
.sd .pic{position:absolute;inset:0 0 auto 0;height:${photoH}px;overflow:hidden}
.sd .pic::before{content:"";position:absolute;inset:0 0 auto 0;height:200px;z-index:1;background:linear-gradient(to bottom,color-mix(in srgb,var(--deep) 45%,transparent),transparent)}
.sd .fade{position:absolute;inset:auto 0 0 0;height:140px;background:linear-gradient(to bottom,transparent,var(--ground))}
.sd .lgw{position:absolute;left:var(--m);top:var(--st);height:${story ? 84 : 76}px;z-index:2}
.sd .lg{height:100%}
.sd .ph1{width:${pw}px;right:var(--m);top:${ptop}px;z-index:2}
.sd .words{position:absolute;left:var(--m);right:${80 + pw + 40}px;top:${photoH + 10}px;bottom:${story ? "var(--sb)" : "var(--m)"};display:flex;flex-direction:column;gap:16px;overflow:hidden}
.sd .sup{color:var(--muted)}
.sd .cta{color:var(--accent-ink);margin-top:auto}`;
    return { body, css };
  },
};

const featureCallout: LayoutDef = {
  key: "feature-callout", name: "Feature spotlight on the real screen",
  use: "One feature, shown exactly: the real screen in a phone with the part the words are about lifted out, enlarged and outlined, with a short label. Use for 'see pay, distance and shift before you apply'-type points. Needs a screen with a focus box.",
  needs: { screens: 1 }, goals: ["sell", "awareness"],
  build: (i) => {
    const s = i.screens.find((x) => x.focus) ?? i.screens[0]!;
    const f = s.focus ?? { x: 0.04, y: 0.25, w: 0.92, h: 0.22 };
    const story = i.format === "insta_story", sq = i.format === "insta_square";
    const phoneW = story ? 520 : sq ? 360 : 430;
    const lensW = story ? 900 : sq ? 600 : 700;
    // the lens shows the focus region at lensW wide: the screen image is scaled so that region fills it
    const scale = lensW / (f.w * s.w);
    const lensH = Math.round(f.h * s.h * scale);
    const body = `<div class="f fc ${i.tune.ground === "deep" ? "deep" : "light"}">
  <header class="hd">${logo(i, { on: i.tune.ground === "deep" ? "deep" : "ground", cls: "lg" })}</header>
  <section class="words" data-area>${headline(i, { max: sq ? i.ds.type.h1 : i.ds.type.display * 0.8, lines: 3 })}${support(i)}</section>
  ${phone(s, "ph1")}
  <div class="lens" data-role="callout" data-kind="image" data-text=""><div class="clip"><img src="${s.url}" alt="" style="width:${Math.round(s.w * scale)}px;transform:translate(${-Math.round(f.x * s.w * scale)}px,${-Math.round(f.y * s.h * scale)}px)"></div></div>
  ${eyebrow(i, "tag")}
  ${i.copy.cta ? `<footer class="foot">${cta(i)}</footer>` : ""}
</div>`;
    const top = (story ? 270 : sq ? 72 : 80) + 96;
    const wordsH = story ? 420 : sq ? 260 : 330;
    const css = `
.fc.light{background:var(--ground)}.fc.deep{background:var(--deep);color:var(--on-deep)}.fc.deep .sup{color:var(--muted-deep)}.fc.light .sup{color:var(--muted)}
.fc .words{position:absolute;left:var(--m);right:var(--m);top:${top}px;height:${wordsH}px;display:flex;flex-direction:column;gap:16px;overflow:hidden}
.fc .ph1{width:${phoneW}px;left:${sq ? 90 : 120}px;top:${top + wordsH + 40}px;opacity:.9}
.fc .lens{position:absolute;right:${sq ? 60 : 70}px;width:${lensW}px;height:${lensH}px;top:${top + wordsH + (story ? 300 : sq ? 120 : 190)}px;border-radius:28px;background:#fff;box-shadow:0 0 0 8px var(--accent),0 40px 80px -24px rgba(0,0,0,.5)}
.fc .clip{width:100%;height:100%;overflow:hidden;border-radius:28px}
.fc .clip img{display:block;max-width:none}
.fc .tag{position:absolute;right:${sq ? 60 : 70}px;top:${top + wordsH + (story ? 300 : sq ? 120 : 190) - 74}px;background:var(--accent);color:var(--on-accent);padding:.45em .9em;border-radius:999px;font-size:var(--s)}
.fc .hd{position:absolute;left:var(--m);top:var(--st);height:64px}.fc .lg{height:100%}
.fc .foot{position:absolute;right:${sq ? 60 : 70}px;bottom:${story ? "var(--sb)" : "var(--m)"};z-index:3}`;
    return { body, css };
  },
};

const photoFullBleed: LayoutDef = {
  key: "photo-full-bleed", name: "Full-bleed photograph",
  use: "When one real photograph carries the idea on its own (a finished room, the shop, the product in use): the picture fills the frame, the words sit low on a calibrated shade, the logo small at the top. Needs one strong photo or scene.",
  needs: { photos: 1 }, goals: ["sell", "announce", "awareness", "offer"],
  build: (i) => {
    const p = pics(i)[0]!;
    const story = i.format === "insta_story";
    const shade = [0.45, 0.62, 0.78, 0.9][Math.max(0, Math.min(3, i.tune.scrim))]!;
    const body = `<div class="f fb">
  ${img(p, i.tune)}
  <div class="shade"></div>
  <div class="lgw">${logo(i, { on: "photo", cls: "lg" })}</div>
  <section class="words" data-area>${eyebrow(i)}${headline(i, { max: i.ds.type.display, lines: 3 })}${support(i)}${cta(i)}</section>
</div>`;
    const css = `
.fb{background:var(--deep);color:var(--on-deep)}
.fb > .ph{position:absolute;inset:0}
.fb .shade{position:absolute;inset:0;background:linear-gradient(to top,color-mix(in srgb,var(--deep) ${Math.round(shade * 100)}%,transparent) 0%,color-mix(in srgb,var(--deep) ${Math.round(shade * 80)}%,transparent) ${story ? 38 : 34}%,transparent ${story ? 62 : 60}%),linear-gradient(to bottom,color-mix(in srgb,var(--deep) 55%,transparent),transparent 20%)}
.fb .lgw{position:absolute;left:var(--m);top:var(--st);height:84px}
.fb .lg{height:100%}
.fb .words{position:absolute;left:var(--m);right:var(--m);bottom:${story ? "var(--sb)" : "var(--m)"};max-height:${story ? 760 : 620}px;display:flex;flex-direction:column;gap:20px;justify-content:safe flex-end;overflow:hidden}
.fb .hl{text-shadow:0 2px 24px rgba(0,0,0,.25)}
.fb .sup{color:var(--on-deep);opacity:.92}
.fb .eb{color:var(--on-deep);opacity:.9}
.fb .pill{margin-top:8px}`;
    return { body, css };
  },
};

const editorialFrame: LayoutDef = {
  key: "editorial-frame", name: "Editorial: framed photo, set type",
  use: "Premium services and finished work (architecture, interiors, a studio's project): the real photo framed with generous paper around it like a magazine page, the project's name small, the headline set large below. Quiet and confident. Needs one real photo.",
  needs: { photos: 1 }, goals: ["sell", "awareness"],
  build: (i) => {
    const p = pics(i)[0]!;
    const story = i.format === "insta_story", sq = i.format === "insta_square";
    const photoH = story ? 860 : sq ? 520 : 640;
    const body = `<div class="f ef">
  <header class="top">${logo(i, { on: "ground", cls: "lg" })}${p.label ? `<p class="cap" data-role="caption">${esc(p.label)}</p>` : ""}</header>
  <div class="frame">${img(p, i.tune)}</div>
  <section class="words" data-area>${eyebrow(i)}${headline(i, { max: sq ? i.ds.type.h1 : i.ds.type.h1 * 1.12, lines: 3 })}${support(i)}</section>
  ${i.copy.cta ? `<footer class="act">${cta(i, "link")}</footer>` : ""}
</div>`;
    const css = `
.ef{background:var(--ground)}
.ef .top{position:absolute;left:var(--m);right:var(--m);top:var(--st);height:58px;display:flex;justify-content:space-between;align-items:center}
.ef .lg{height:100%}
.ef .cap{font-size:var(--s);color:var(--muted);font-weight:400;letter-spacing:.01em}
.ef .frame{position:absolute;left:var(--m);right:var(--m);top:calc(var(--st) + 90px);height:${photoH}px;overflow:hidden;border-radius:4px}
.ef .words{position:absolute;left:var(--m);right:${sq ? "var(--m)" : "calc(var(--m) + 60px)"};top:calc(var(--st) + ${photoH + 130}px);bottom:calc(${story ? "var(--sb)" : "var(--m)"} + 80px);display:flex;flex-direction:column;gap:16px;overflow:hidden}
.ef .sup{color:var(--muted)}
.ef .act{position:absolute;left:var(--m);bottom:${story ? "var(--sb)" : "var(--m)"}}
.ef .cta{color:var(--accent-ink)}`;
    return { body, css };
  },
};

const galleryTrio: LayoutDef = {
  key: "gallery-trio", name: "Portfolio: three real projects",
  use: "Proof by work: three of the business's own photos (projects, dishes, products) in a magazine grid, one large and two small, each with its name; the headline sells the service they prove. Needs three real photos.",
  needs: { photos: 3 }, goals: ["sell", "awareness"],
  build: (i) => {
    const [a, b, c] = pics(i);
    const story = i.format === "insta_story", sq = i.format === "insta_square";
    const label = (p: Picture | undefined) => (p?.label ? `<span class="nm" data-role="caption">${esc(p.label)}</span>` : "");
    const body = `<div class="f gt">
  <section class="words" data-area>${headline(i, { max: sq ? i.ds.type.h1 * 0.9 : i.ds.type.h1, lines: 2 })}${support(i)}</section>
  <div class="grid">
    <figure class="a">${img(a!, i.tune)}${label(a)}</figure>
    <figure class="b">${img(b!, DEFAULT_TUNE)}${label(b)}</figure>
    <figure class="c">${img(c!, DEFAULT_TUNE)}${label(c)}</figure>
  </div>
  <footer class="foot">${logo(i, { on: "ground", cls: "lg" })}${cta(i)}</footer>
</div>`;
    const wordsH = story ? 380 : sq ? 230 : 290;
    const css = `
.gt{background:var(--ground)}
.gt .words{position:absolute;left:var(--m);right:var(--m);top:var(--st);height:${wordsH}px;display:flex;flex-direction:column;gap:14px;overflow:hidden}
.gt .sup{color:var(--muted)}
.gt .grid{position:absolute;left:var(--m);right:var(--m);top:calc(var(--st) + ${wordsH + 30}px);bottom:calc(${story ? "var(--sb)" : "var(--m)"} + 110px);display:grid;grid-template-columns:${story ? "1fr 1fr" : "1.7fr 1fr"};grid-template-rows:${story ? "1.6fr 1fr" : "1fr 1fr"};gap:16px}
.gt figure{position:relative;overflow:hidden;border-radius:6px;margin:0}
.gt .a{${story ? "grid-column:1 / 3" : "grid-row:1 / 3"}}
.gt .nm{position:absolute;left:14px;bottom:14px;font-size:var(--s);font-weight:700;color:#fff;background:rgba(0,0,0,.62);padding:.25em .6em;border-radius:8px;line-height:1.3}
.gt .foot{position:absolute;left:var(--m);right:var(--m);bottom:${story ? "var(--sb)" : "var(--m)"};height:74px;display:flex;justify-content:space-between;align-items:center}
.gt .lg{height:56px}`;
    return { body, css };
  },
};

const splitPanel: LayoutDef = {
  key: "split-panel", name: "Split: photo and a solid panel",
  use: "A clear selling line next to a real photo that needs no words on it: the photo takes one half, the brand's deep colour the other, the words sit on solid colour (best legibility). Good default for services. Needs one photo or scene.",
  needs: { photos: 1 }, goals: ["sell", "offer", "announce", "awareness"],
  build: (i) => {
    const p = pics(i)[0]!;
    const story = i.format === "insta_story", sq = i.format === "insta_square";
    const vertical = story || !sq;
    const body = `<div class="f sp">
  <div class="pic">${img(p, i.tune)}</div>
  <section class="panel">
    <div class="words" data-area>${eyebrow(i)}${headline(i, { max: sq ? i.ds.type.h1 * 0.9 : i.ds.type.h1, lines: 4 })}${support(i)}</div>
    <footer class="foot">${cta(i)}<div class="lgw">${logo(i, { on: "deep", cls: "lg" })}</div></footer>
  </section>
</div>`;
    const css = vertical ? `
.sp{background:var(--deep);color:var(--on-deep)}
.sp .pic{position:absolute;left:0;right:0;top:0;height:${story ? 820 : 640}px}
.sp .panel{position:absolute;left:0;right:0;top:${story ? 820 : 640}px;bottom:0;padding:${story ? 60 : 48}px var(--m) ${story ? "var(--sb)" : "var(--m)"};display:flex;flex-direction:column;gap:22px}
.sp .foot{display:flex;justify-content:space-between;align-items:center;gap:24px;height:76px}
.sp .lgw{height:60px}
.sp .lg{height:100%}
.sp .words{display:flex;flex-direction:column;gap:16px;flex:1;min-height:0;overflow:hidden}
.sp .sup{color:var(--muted-deep)}.sp .eb{color:var(--accent-deep)}` : `
.sp{background:var(--deep);color:var(--on-deep);display:grid;grid-template-columns:1fr 1fr}
.sp .pic{position:relative}
.sp .panel{padding:var(--m) var(--m) var(--m) 56px;display:flex;flex-direction:column;gap:22px}
.sp .foot{display:flex;flex-direction:column-reverse;align-items:flex-start;gap:28px}
.sp .lgw{height:56px}.sp .lg{height:100%}
.sp .words{display:flex;flex-direction:column;gap:16px;flex:1;min-height:0;overflow:hidden;justify-content:safe center}
.sp .sup{color:var(--muted-deep)}.sp .eb{color:var(--accent-deep)}`;
    return { body, css };
  },
};

const offerCard: LayoutDef = {
  key: "offer-card", name: "Offer card",
  use: "A real offer the owner gave (a price, a discount, a free first visit): the offer itself is the hero in big type, the reason to believe in one line, the terms small and honest, one action. A photo strip if there is a real photo. Needs an offer.",
  needs: { offer: true }, goals: ["offer", "sell"],
  build: (i) => {
    const p = pics(i)[0];
    const story = i.format === "insta_story", sq = i.format === "insta_square";
    const deep = i.tune.ground === "deep";
    const body = `<div class="f oc ${deep ? "deep" : "light"}">
  <header class="top">${logo(i, { on: deep ? "deep" : "ground", cls: "lg" })}</header>
  <section class="words" data-area>
    <p class="offer${script(i.copy.offer)}" data-role="offer" data-fit data-order="0" data-min="${i.ds.type.h1}" data-max="${Math.round(i.ds.type.hero * 1.25 * i.tune.scale)}" data-lines="2">${esc(i.copy.offer ?? "")}</p>
    ${headline(i, { max: i.ds.type.h2, min: i.ds.type.lede, lines: 3, cls: "sub" })}
    ${support(i)}${details(i)}
  </section>
  ${p ? `<div class="strip">${img(p, i.tune)}</div>` : ""}
  <footer class="act">${cta(i)}</footer>
</div>`;
    const stripH = p ? (story ? 440 : sq ? 0 : 250) : 0;
    const css = `
.oc.light{background:var(--ground)}.oc.deep{background:var(--deep);color:var(--on-deep)}
.oc .top{position:absolute;left:var(--m);top:var(--st);height:70px}.oc .lg{height:100%}
.oc .words{position:absolute;left:var(--m);right:var(--m);top:calc(var(--st) + 120px);bottom:calc(${story ? "var(--sb)" : "var(--m)"} + ${stripH + 130}px);display:flex;flex-direction:column;gap:20px;overflow:hidden}
.oc .offer{font-family:var(--display);font-weight:700;line-height:.98;letter-spacing:-0.03em;color:var(--accent-ink);text-wrap:balance}
.oc.deep .offer{color:var(--accent-deep)}
.oc .offer.deva{line-height:1.25;letter-spacing:0}
.oc .hl.sub{font-family:var(--display);line-height:1.12}
.oc.light .sup{color:var(--muted)}.oc.deep .sup{color:var(--muted-deep)}
.oc .strip{position:absolute;left:0;right:0;bottom:${story ? "calc(var(--sb) + 120px)" : "calc(var(--m) + 110px)"};height:${stripH}px;${sq ? "display:none" : ""}}
.oc .act{position:absolute;left:var(--m);right:var(--m);bottom:${story ? "var(--sb)" : "var(--m)"};height:80px;display:flex;align-items:center}`;
    return { body, css };
  },
};

const bigType: LayoutDef = {
  key: "big-type", name: "One big statement",
  use: "Awareness or a short, strong message (five words or fewer) with no picture needed: the words ARE the design, very large on the brand's deep colour, a single accent rule, the logo small. Costs nothing to make. Needs a short headline.",
  needs: {}, goals: ["awareness", "announce", "sell"],
  build: (i) => {
    const story = i.format === "insta_story";
    const body = `<div class="f bt">
  <div class="rule"></div>
  <section class="words" data-area>${headline(i, { max: Math.round(i.ds.type.hero * 1.1), min: i.ds.type.h1, lines: 5 })}${support(i)}</section>
  <footer class="foot">${logo(i, { on: "deep", cls: "lg" })}${cta(i, "link")}</footer>
</div>`;
    const css = `
.bt{background:var(--deep);color:var(--on-deep)}
.bt .rule{position:absolute;left:var(--m);top:var(--st);width:120px;height:10px;background:var(--accent)}
.bt .words{position:absolute;left:var(--m);right:var(--m);top:calc(var(--st) + 70px);bottom:calc(${story ? "var(--sb)" : "var(--m)"} + 130px);display:flex;flex-direction:column;justify-content:safe center;gap:28px;overflow:hidden}
.bt .hl{letter-spacing:-0.03em;line-height:.98}
.bt .hl.deva{line-height:1.25;letter-spacing:0}
.bt .sup{color:var(--muted-deep);max-width:820px}
.bt .foot{position:absolute;left:var(--m);right:var(--m);bottom:${story ? "var(--sb)" : "var(--m)"};height:72px;display:flex;justify-content:space-between;align-items:center}
.bt .lg{height:60px}.bt .cta{color:var(--accent-deep)}`;
    return { body, css };
  },
};

const quoteCard: LayoutDef = {
  key: "quote-card", name: "Testimonial / quote",
  use: "A real customer's words (given by the owner, with permission) or a clearly marked illustrative quote: the quote in the display face, large accent quote marks, the person's name, a small real photo if there is one. Needs a quote.",
  needs: { quote: true }, goals: ["sell", "awareness"],
  build: (i) => {
    const q = i.copy.quote!;
    const story = i.format === "insta_story";
    const body = `<div class="f qc">
  <div class="mark">&ldquo;</div>
  <section class="words" data-area>
    <blockquote class="q${script(q.text)}" data-role="headline" data-fit data-order="1" data-min="${i.ds.type.h2 * 0.8}" data-max="${Math.round(i.ds.type.h1 * i.tune.scale)}" data-lines="6">${esc(q.text)}</blockquote>
    ${q.by ? `<p class="by" data-role="attribution">${esc(q.by)}${q.illustrative ? ` <span class="ill">(illustrative)</span>` : ""}</p>` : ""}
  </section>
  <footer class="foot">${logo(i, { on: "ground", cls: "lg" })}${cta(i)}</footer>
</div>`;
    const css = `
.qc{background:var(--ground)}
.qc .mark{position:absolute;left:calc(var(--m) - 12px);top:calc(var(--st) - 40px);font-family:var(--display);font-size:340px;line-height:1;color:var(--accent);font-weight:700}
.qc .words{position:absolute;left:var(--m);right:var(--m);top:calc(var(--st) + 210px);bottom:calc(${story ? "var(--sb)" : "var(--m)"} + 140px);display:flex;flex-direction:column;gap:30px;overflow:hidden}
.qc .q{font-family:var(--display);font-weight:400;line-height:1.16;letter-spacing:-0.01em;text-wrap:pretty}
.qc .q.deva{line-height:1.4}
.qc .by{font-size:var(--b);font-weight:700}.qc .ill{font-weight:400;color:var(--muted)}
.qc .avatar{position:absolute;right:var(--m);top:var(--st);width:180px;height:180px;border-radius:50%;overflow:hidden;box-shadow:0 0 0 6px var(--ground),0 0 0 9px var(--accent)}
.qc .foot{position:absolute;left:var(--m);right:var(--m);bottom:${story ? "var(--sb)" : "var(--m)"};height:72px;display:flex;justify-content:space-between;align-items:center}
.qc .lg{height:56px}`;
    return { body, css };
  },
};

const beforeAfter: LayoutDef = {
  key: "before-after", name: "Before / after",
  use: "A change the business makes (a room before and after, the old way and the new): two real photos with labels, the headline names the change. Never a fake 'before'. Needs two photos (and two labels).",
  needs: { photos: 2, pair: true }, goals: ["sell", "awareness"],
  build: (i) => {
    const [a, b] = pics(i);
    const [la, lb] = i.copy.pair ?? ["Before", "After"];
    const story = i.format === "insta_story", sq = i.format === "insta_square";
    const body = `<div class="f ba">
  <section class="words" data-area>${headline(i, { max: sq ? i.ds.type.h1 * 0.85 : i.ds.type.h1, lines: 2 })}</section>
  <div class="pair"><figure>${img(a!, i.tune)}<span class="lbl l1${script(la)}" data-role="label">${esc(la)}</span></figure><figure>${img(b!, DEFAULT_TUNE)}<span class="lbl l2${script(lb)}" data-role="label">${esc(lb)}</span></figure></div>
  <footer class="foot">${logo(i, { on: "ground", cls: "lg" })}${cta(i)}</footer>
</div>`;
    const wordsH = story ? 300 : sq ? 190 : 230;
    const css = `
.ba{background:var(--ground)}
.ba .words{position:absolute;left:var(--m);right:var(--m);top:var(--st);height:${wordsH}px;display:flex;flex-direction:column;justify-content:safe center;overflow:hidden}
.ba .pair{position:absolute;left:var(--m);right:var(--m);top:calc(var(--st) + ${wordsH + 24}px);bottom:calc(${story ? "var(--sb)" : "var(--m)"} + 110px);display:grid;${story ? "grid-template-rows:1fr 1fr" : "grid-template-columns:1fr 1fr"};gap:12px}
.ba figure{position:relative;overflow:hidden;border-radius:6px;margin:0}
.ba .lbl{position:absolute;left:16px;top:16px;font-size:var(--s);font-weight:700;padding:.35em .8em;border-radius:999px;line-height:1.3}
.ba .lbl.deva{line-height:1.5}
.ba .l1{background:var(--ink);color:var(--ground)}.ba .l2{background:var(--accent);color:var(--on-accent)}
.ba .foot{position:absolute;left:var(--m);right:var(--m);bottom:${story ? "var(--sb)" : "var(--m)"};height:74px;display:flex;justify-content:space-between;align-items:center}
.ba .lg{height:56px}`;
    return { body, css };
  },
};

const dateAnnouncement: LayoutDef = {
  key: "date-announcement", name: "Announcement with a date",
  use: "Something happens on a date the owner gave (a launch, an opening, the last day of an offer): the date is the hero in huge numerals, the headline says what happens, one action. Needs a detail with a date in it.",
  needs: { date: true }, goals: ["announce", "offer"],
  build: (i) => {
    const date = (i.copy.details ?? []).find((d) => /\d/.test(d)) ?? "";
    const rest = (i.copy.details ?? []).filter((d) => d !== date);
    const story = i.format === "insta_story";
    const body = `<div class="f da">
  <header class="top">${logo(i, { on: "deep", cls: "lg" })}${eyebrow(i)}</header>
  <p class="date${script(date)}" data-role="date" data-fit data-order="0" data-min="${i.ds.type.h1}" data-max="${Math.round(i.ds.type.hero * 1.5)}" data-lines="2">${esc(date)}</p>
  <section class="words" data-area>${headline(i, { max: i.ds.type.h1, min: i.ds.type.lede, lines: 3 })}${support(i)}${rest.length ? `<ul class="chips">${rest.map((d) => `<li data-role="detail">${esc(d)}</li>`).join("")}</ul>` : ""}</section>
  <footer class="act">${cta(i)}</footer>
</div>`;
    const css = `
.da{background:var(--deep);color:var(--on-deep)}
.da .top{position:absolute;left:var(--m);right:var(--m);top:var(--st);height:70px;display:flex;justify-content:space-between;align-items:center}.da .lg{height:100%}
.da .eb{color:var(--accent-deep)}
.da .date{position:absolute;left:var(--m);right:var(--m);top:calc(var(--st) + 120px);height:${story ? 520 : 400}px;font-family:var(--display);font-weight:700;line-height:.92;letter-spacing:-0.04em;color:var(--accent-deep);overflow:hidden;text-wrap:balance}
.da .words{position:absolute;left:var(--m);right:var(--m);top:calc(var(--st) + ${story ? 680 : 550}px);bottom:calc(${story ? "var(--sb)" : "var(--m)"} + 120px);display:flex;flex-direction:column;gap:18px;overflow:hidden}
.da .sup{color:var(--muted-deep)}
.da .act{position:absolute;left:var(--m);bottom:${story ? "var(--sb)" : "var(--m)"}}`;
    return { body, css };
  },
};

const hiringCard: LayoutDef = {
  key: "hiring-card", name: "Hiring / job card",
  use: "A job or role the business is filling: the role is the headline, three facts as chips (pay, shift, place: only as given), one 'apply' action, a real photo of the workplace in an arch. Needs at least two details.",
  needs: { details: 2 }, goals: ["announce", "sell"],
  build: (i) => {
    const p = pics(i)[0];
    const story = i.format === "insta_story", sq = i.format === "insta_square";
    const body = `<div class="f hc">
  <header class="top">${logo(i, { on: "ground", cls: "lg" })}${eyebrow(i, "tag")}</header>
  ${p ? `<div class="arch">${img(p, i.tune)}</div>` : ""}
  <section class="words" data-area>${headline(i, { max: sq ? i.ds.type.h1 : i.ds.type.display * 0.85, lines: 3 })}${support(i)}${details(i)}</section>
  <footer class="act">${cta(i)}</footer>
</div>`;
    const archH = p ? (story ? 640 : sq ? 0 : 460) : 0;
    const css = `
.hc{background:var(--ground)}
.hc .top{position:absolute;left:var(--m);right:var(--m);top:var(--st);height:64px;display:flex;justify-content:space-between;align-items:center}.hc .lg{height:100%}
.hc .tag{background:var(--second);color:var(--on-second);padding:.4em .9em;border-radius:999px}
.hc .arch{position:absolute;right:var(--m);top:calc(var(--st) + 100px);width:${story ? 560 : 470}px;height:${archH}px;border-radius:300px 300px 12px 12px;overflow:hidden;${sq ? "display:none" : ""}}
.hc .words{position:absolute;left:var(--m);right:var(--m);top:calc(var(--st) + ${archH ? archH + 140 : 120}px);bottom:calc(${story ? "var(--sb)" : "var(--m)"} + 110px);display:flex;flex-direction:column;gap:22px;overflow:hidden}
.hc .sup{color:var(--muted)}
.hc .act{position:absolute;left:var(--m);bottom:${story ? "var(--sb)" : "var(--m)"}}`;
    return { body, css };
  },
};

const localPlace: LayoutDef = {
  key: "local-place", name: "Local place",
  use: "A local business inviting people in (a shop, studio, clinic): the place's own photo, the neighbourhood or city set big like a stamp, the address or hours as given, 'visit us'. Needs a photo and a detail (an address or hours).",
  needs: { photos: 1, details: 1 }, goals: ["awareness", "sell", "announce"],
  build: (i) => {
    const p = pics(i)[0]!;
    const story = i.format === "insta_story", sq = i.format === "insta_square";
    const body = `<div class="f lp">
  <div class="pic">${img(p, i.tune)}</div>
  <section class="card">
    <div class="lgw">${logo(i, { on: "ground", cls: "lg" })}</div>
    <div class="words" data-area>${eyebrow(i)}${headline(i, { max: i.ds.type.h1, lines: 3 })}${support(i)}</div>
    ${details(i, "addr")}
    ${cta(i)}
  </section>
</div>`;
    const css = `
.lp{background:var(--deep)}
.lp .pic{position:absolute;inset:0}
.lp .card{position:absolute;left:var(--m);right:var(--m);bottom:${story ? "var(--sb)" : "var(--m)"};max-height:${story ? 1000 : sq ? 700 : 820}px;background:var(--ground);border-radius:24px;padding:44px;display:flex;flex-direction:column;gap:20px;box-shadow:0 30px 80px -20px rgba(0,0,0,.5)}
.lp .lgw{height:56px}.lp .lg{height:100%}
.lp .words{display:flex;flex-direction:column;gap:14px;min-height:0;overflow:hidden}
.lp .sup{color:var(--muted)}
.lp .addr{list-style:none;display:flex;flex-direction:column;gap:6px}
.lp .addr li{font-size:var(--b);font-weight:700;line-height:1.3;color:var(--ink);padding-left:28px;position:relative}
.lp .addr li::before{content:"";position:absolute;left:0;top:.45em;width:14px;height:14px;border-radius:50%;background:var(--accent)}`;
    return { body, css };
  },
};

const carouselCover: LayoutDef = {
  key: "carousel-cover", name: "Carousel cover",
  use: "The first slide of a carousel ('3 things to check before you...'): a promise the next slides keep, huge type, a swipe cue, a half photo. Needs the headline to promise a list or a story.",
  needs: {}, goals: ["awareness", "sell"],
  build: (i) => {
    const p = pics(i)[0];
    const story = i.format === "insta_story";
    const body = `<div class="f cc">
  ${p ? `<div class="pic">${img(p, i.tune)}</div>` : ""}
  <section class="panel">
    <div class="lgw">${logo(i, { on: "ground", cls: "lg" })}</div>
    <div class="words" data-area>${eyebrow(i)}${headline(i, { max: i.ds.type.display, lines: 4 })}${support(i)}</div>
    <p class="swipe" data-role="cta">${esc(i.copy.cta ?? "Swipe")} <span class="arr">&#8594;</span></p>
  </section>
</div>`;
    const css = `
.cc{background:var(--ground)}
.cc .pic{position:absolute;right:0;top:0;bottom:0;width:${p ? 38 : 0}%}
.cc .panel{position:absolute;left:var(--m);top:var(--st);bottom:${story ? "var(--sb)" : "var(--m)"};width:${p ? "calc(62% - var(--m) - 40px)" : "calc(100% - 2 * var(--m))"};display:flex;flex-direction:column;gap:24px}
.cc .lgw{height:56px}.cc .lg{height:100%}
.cc .words{flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column;justify-content:safe center;gap:18px}
.cc .sup{color:var(--muted)}
.cc .swipe{font-size:var(--b);font-weight:700;color:var(--accent-ink)}.cc .arr{display:inline-block;margin-left:6px}`;
    return { body, css };
  },
};

const eventPoster: LayoutDef = {
  key: "event-poster", name: "Event",
  use: "An event the business hosts or attends (a workshop, an open house, a stall): photo on top, then a structured block with what, when and where exactly as given, one 'register' or 'come by' action. Needs two details (when and where).",
  needs: { details: 2, photos: 1 }, goals: ["announce"],
  build: (i) => {
    const p = pics(i)[0]!;
    const story = i.format === "insta_story", sq = i.format === "insta_square";
    const body = `<div class="f ev">
  <div class="pic">${img(p, i.tune)}</div>
  <div class="lgw">${logo(i, { on: "photo", cls: "lg" })}</div>
  <section class="block">
    <div class="words" data-area>${eyebrow(i)}${headline(i, { max: i.ds.type.h1, lines: 3 })}</div>
    <dl class="facts">${(i.copy.details ?? []).slice(0, 3).map((d) => `<dd data-role="detail">${esc(d)}</dd>`).join("")}</dl>
    ${cta(i)}
  </section>
</div>`;
    const picH = story ? 760 : sq ? 430 : 600;
    const css = `
.ev{background:var(--ground)}
.ev .pic{position:absolute;left:0;right:0;top:0;height:${picH}px}
.ev .lgw{position:absolute;left:var(--m);top:var(--st);height:70px}.ev .lg{height:100%}
.ev .block{position:absolute;left:var(--m);right:var(--m);top:${picH + 50}px;bottom:${story ? "var(--sb)" : "var(--m)"};display:flex;flex-direction:column;gap:24px}
.ev .words{display:flex;flex-direction:column;gap:12px;min-height:0;overflow:hidden}
.ev .facts{display:grid;grid-template-columns:1fr 1fr;gap:12px 24px;border-top:3px solid var(--ink);padding-top:20px}
.ev dd{font-size:var(--b);font-weight:700;line-height:1.3}`;
    return { body, css };
  },
};

export const LAYOUTS: LayoutDef[] = [
  deviceHero, sceneDevice, featureCallout, photoFullBleed, editorialFrame, galleryTrio, splitPanel, offerCard,
  bigType, quoteCard, beforeAfter, dateAnnouncement, hiringCard, localPlace, carouselCover, eventPoster,
];
export const LAYOUT_KEYS = LAYOUTS.map((l) => l.key);
export const layoutByKey = (k: string): LayoutDef | undefined => LAYOUTS.find((l) => l.key === k);

export function pageFor(def: LayoutDef, i: LayoutInput): string {
  const { body, css } = def.build(i);
  return `<!doctype html><html lang="${DEVA.test(i.copy.headline) ? "hi" : "en"}"><head><meta charset="utf-8"><style>${baseCss(i)}${css}</style></head><body>${body}</body></html>`;
}
