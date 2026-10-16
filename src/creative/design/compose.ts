// One design, rendered and measured: a spec (layout, size, words, real pictures, tune) becomes a page, the page becomes a
// picture in Chromium, and the code checks what it drew before any person or model looks at it:
//   fit       a headline that could not fit at its minimum size (never cut off: the layout is changed or the words are)
//   overflow  any text running out of its area
//   orphan    a line that ends with one word alone (text-wrap should prevent it; this proves it did)
//   contrast  text against the pixels really behind it, WCAG 4.5:1 for normal text and 3:1 for large text
//   size      nothing smaller than the scale's floor (about 11 pt on a phone)
//   safe      on a story, every word and the logo inside the band the app does not cover
//   collide   two blocks of words on top of each other, or words over the logo
//   hierarchy the headline at least 1.8x the supporting line
import sharp from "sharp";
import type { PlacedText, PosterManifest } from "../compose/compose.js";
import { FORMATS, type FormatKey } from "../compose/formats.js";
import { layoutByKey, pageFor, type DesignCopy, type LayoutKey, type Picture, type Tune } from "./layouts.js";
import type { HtmlRenderer, RenderBox } from "./render.js";
import type { DesignSystem } from "./system.js";

export interface DesignSpec {
  layout: LayoutKey;
  format: FormatKey;
  copy: DesignCopy;
  photos: Picture[];
  screens: Picture[];
  scene?: Picture;
  tune: Tune;
}

export type FindingCode = "fit" | "overflow" | "orphan" | "contrast" | "size" | "safe" | "collide" | "hierarchy" | "offcanvas";
export interface Finding { code: FindingCode; role: string; detail: string; blocking: boolean }

export interface ComposedDesign {
  spec: DesignSpec;
  png: Buffer;
  jpeg: Buffer;
  w: number; h: number;
  boxes: RenderBox[];
  findings: Finding[];
  manifest: PosterManifest;
  html: string;
}

// Meta's story and reel spec keeps 14% clear at the top; a still story's reply bar covers about the bottom 20%.
export const STORY_SAFE = { top: 268, bottom: 398 } as const;

const inter = (a: RenderBox, b: RenderBox): number => {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return x * y;
};

// Large text in WCAG terms: 24 px-equivalent regular or ~18.7 px bold at 1x; our pictures are seen at ~0.36x, so the
// thresholds are scaled to what the eye gets on a phone.
const isLarge = (b: RenderBox, min: number): boolean => b.fontSize >= min * 1.75;

export function findings(boxes: RenderBox[], o: { w: number; h: number; format: FormatKey; ds: DesignSystem }): Finding[] {
  const out: Finding[] = [];
  const text = boxes.filter((b) => b.isText);
  for (const b of text) {
    if (b.fitFailed) out.push({ code: "fit", role: b.role, detail: `the ${b.role} does not fit at a readable size`, blocking: true });
    else if (b.overflow) out.push({ code: "overflow", role: b.role, detail: `the ${b.role} runs out of its space`, blocking: true });
    const words = b.text.split(/\s+/).filter(Boolean).length;
    if (b.lines > 1 && b.lastLineWords === 1 && words >= 4 && /headline|support|offer|cta/.test(b.role)) out.push({ code: "orphan", role: b.role, detail: `the ${b.role} ends with one word alone on its last line`, blocking: false });
    const need = isLarge(b, o.ds.type.min) ? 3 : 4.5;
    if (b.contrast !== undefined && b.contrast < need) out.push({ code: "contrast", role: b.role, detail: `the ${b.role} is hard to read against what is behind it (${b.contrast.toFixed(1)}:1, needs ${need}:1)`, blocking: b.contrast < need * 0.75 });
    if (b.fontSize < o.ds.type.min - 1) out.push({ code: "size", role: b.role, detail: `the ${b.role} is too small to read on a phone (${Math.round(b.fontSize)} px)`, blocking: false });
    if (b.x < -1 || b.y < -1 || b.x + b.w > o.w + 1 || b.y + b.h > o.h + 1) out.push({ code: "offcanvas", role: b.role, detail: `the ${b.role} runs off the picture`, blocking: true });
  }
  if (o.format === "insta_story") {
    for (const b of boxes.filter((x) => x.isText || x.role === "logo")) {
      if (b.y < STORY_SAFE.top - 2 || b.y + b.h > o.h - STORY_SAFE.bottom + 2) out.push({ code: "safe", role: b.role, detail: `the ${b.role} sits where Instagram's own buttons cover it`, blocking: true });
    }
  }
  const logo = boxes.find((b) => b.role === "logo");
  for (let i = 0; i < text.length; i++) {
    for (let j = i + 1; j < text.length; j++) {
      const a = text[i]!, b = text[j]!;
      if (inter(a, b) > 0.08 * Math.min(a.w * a.h, b.w * b.h)) out.push({ code: "collide", role: `${a.role}+${b.role}`, detail: `the ${a.role} and the ${b.role} overlap`, blocking: true });
    }
    if (logo && logo.isText === false && inter(text[i]!, logo) > 0.05 * Math.min(text[i]!.w * text[i]!.h, logo.w * logo.h)) out.push({ code: "collide", role: `${text[i]!.role}+logo`, detail: `the ${text[i]!.role} runs into the logo`, blocking: true });
  }
  const head = text.find((b) => b.role === "headline" || b.role === "offer"), sup = text.find((b) => b.role === "support");
  if (head && sup && head.fontSize < sup.fontSize * 1.6) out.push({ code: "hierarchy", role: "headline", detail: "the headline is not much bigger than the supporting line, so nothing leads", blocking: false });
  return out;
}

export async function composeDesign(spec: DesignSpec, ds: DesignSystem, renderer: HtmlRenderer): Promise<ComposedDesign> {
  const F = FORMATS[spec.format];
  const def = layoutByKey(spec.layout);
  if (!def) throw new Error(`no layout ${spec.layout}`);
  const html = pageFor(def, { format: spec.format, w: F.w, h: F.h, ds, copy: spec.copy, photos: spec.photos, screens: spec.screens, ...(spec.scene ? { scene: spec.scene } : {}), tune: spec.tune });
  const r = await renderer.render({ html, width: F.w, height: F.h });
  const jpeg = await sharp(r.png).flatten({ background: "#ffffff" }).jpeg({ quality: 92, chromaSubsampling: "4:4:4", mozjpeg: true }).toBuffer();
  const found = findings(r.boxes, { w: F.w, h: F.h, format: spec.format, ds });
  const logoBox = r.boxes.find((b) => b.role === "logo");
  const texts: PlacedText[] = r.boxes.filter((b) => b.isText && b.role !== "logo").map((b) => ({
    role: b.role, text: b.text, shown: b.text, box: { x: b.x, y: b.y, w: b.w, h: b.h }, size: Math.round(b.fontSize), font: "", color: b.color, lines: [b.text],
  }));
  const manifest: PosterManifest = {
    format: spec.format, layout: spec.layout, width: F.w, height: F.h, texts,
    logo: {
      kind: ds.logo ? "file" : "wordmark", box: logoBox ? { x: logoBox.x, y: logoBox.y, w: logoBox.w, h: logoBox.h } : { x: 0, y: 0, w: 0, h: 0 },
      plate: false, scale: 1, sourceW: ds.logo?.w ?? 0, soft: !!ds.logo && !!logoBox && ds.logo.h < logoBox.h * 0.8,
      ...(!ds.logo && texts.some((t) => t.role === "headline" && t.text.toLowerCase().includes(ds.business.toLowerCase())) ? { inHeadline: true } : {}),
    },
    artwork: !!spec.scene,
    colours: { paper: ds.colour.ground, dark: ds.colour.ink, accent: ds.colour.accent, light: ds.colour.onDeep, background: ds.colour.ground },
    fonts: { heading: "BrandDisplay", body: "BrandBody" },
    problems: found.filter((f) => f.blocking).map((f) => f.detail),
  };
  return { spec, png: r.png, jpeg, w: F.w, h: F.h, boxes: r.boxes, findings: found, manifest, html };
}
