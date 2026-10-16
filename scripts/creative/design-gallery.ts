// Renders every layout in the library for one brand, to look at them side by side (a design review sheet, free: nothing
// is generated). The brand is described by a small JSON file; pictures and screens are local files.
//   npx tsx scripts/creative/design-gallery.ts --brand brand.json --out .cache/gallery [--format insta_portrait] [--only device-hero,big-type]
// brand.json: { "name": "...", "colours": ["#..."], "paper": "#..", "ink": "#..", "accent": "#..",
//   "heading": ["Heading-400.ttf", "Heading-700.ttf"], "body": ["Body-400.ttf", "Body-700.ttf"], "logo": "logo.png",
//   "photos": [{"file": "..", "label": ".."}], "screens": [{"file": "..", "crop": {"y0": 0.1}, "focus": {...}}],
//   "copy": { "headline": "..", "support": "..", "cta": "..", "offer": "..", "details": [".."], "quote": {...} } }
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { paletteFrom } from "../../src/creative/compose/palette.js";
import { loadFont } from "../../src/creative/compose/type.js";
import type { FormatKey } from "../../src/creative/compose/formats.js";
import { composeDesign } from "../../src/creative/design/compose.js";
import { DEFAULT_TUNE, LAYOUTS, type DesignCopy } from "../../src/creative/design/layouts.js";
import { photoPicture, screenPicture } from "../../src/creative/design/material.js";
import { closeSharedRenderer, sharedRenderer } from "../../src/creative/design/render.js";
import { designSystem } from "../../src/creative/design/system.js";

const { values: a } = parseArgs({ options: { brand: { type: "string" }, out: { type: "string" }, format: { type: "string" }, only: { type: "string" } } });
if (!a.brand || !a.out) throw new Error("usage: --brand brand.json --out dir [--format insta_portrait] [--only a,b]");
const base = dirname(resolve(a.brand));
const b = JSON.parse(readFileSync(a.brand, "utf8")) as {
  name: string; colours: string[]; paper?: string; ink?: string; accent?: string; heading: string[]; body: string[]; logo?: string;
  photos: Array<{ file: string; label?: string }>; screens: Array<{ file: string; crop?: { y0?: number; y1?: number; statusBar?: number }; focus?: { x: number; y: number; w: number; h: number } }>;
  copy: DesignCopy;
};
const file = (f: string) => readFileSync(resolve(base, f));
const pair = (files: string[]) => ({ regular: loadFont(file(files[0]!)), bold: loadFont(file(files[1] ?? files[0]!)) });
const brand = {
  businessName: b.name, palette: paletteFrom({ ...(b.paper ? { paper: b.paper } : {}), ...(b.ink ? { ink: b.ink } : {}), ...(b.accent ? { accent: b.accent } : {}), extra: b.colours }),
  heading: pair(b.heading), body: pair(b.body), logo: b.logo ? { bytes: file(b.logo), w: 0, h: 0 } : null,
};
const format = (a.format ?? "insta_portrait") as FormatKey;
const ds = await designSystem(brand, b.colours, format);
const photos = await Promise.all(b.photos.map((p) => photoPicture(file(p.file), { ...(p.label ? { label: p.label } : {}) })));
const screens = await Promise.all(b.screens.map((s) => screenPicture(file(s.file), { ...(s.crop ? { crop: s.crop } : {}), ...(s.focus ? { focus: s.focus } : {}) })));
mkdirSync(a.out, { recursive: true });
const only = a.only ? new Set(a.only.split(",")) : null;
const tiles: Buffer[] = [];
for (const L of LAYOUTS) {
  if (only && !only.has(L.key)) continue;
  try {
    const r = await composeDesign({ layout: L.key, format, copy: b.copy, photos, screens, tune: DEFAULT_TUNE }, ds, sharedRenderer());
    writeFileSync(join(a.out, `${L.key}.jpg`), r.jpeg);
    writeFileSync(join(a.out, `${L.key}.html`), r.html.replace(/data:[^"')]+/g, "data:…"));
    console.log(`${L.key}: ${r.findings.length ? r.findings.map((f) => `${f.code}(${f.role})`).join(" ") : "clean"}`);
    tiles.push(await sharp(r.jpeg).resize({ width: 360 }).jpeg().toBuffer());
  } catch (e) {
    console.log(`${L.key}: FAILED ${e instanceof Error ? e.message : e}`);
  }
}
const th = Math.round(360 * (format === "insta_story" ? 1920 / 1080 : format === "insta_square" ? 1 : 1350 / 1080));
const cols = 4, rows = Math.ceil(tiles.length / cols);
await sharp({ create: { width: cols * 368, height: rows * (th + 8), channels: 3, background: "#777" } })
  .composite(tiles.map((t, i) => ({ input: t, left: (i % cols) * 368, top: Math.floor(i / cols) * (th + 8) }))).jpeg({ quality: 84 }).toFile(join(a.out, "sheet.jpg"));
await closeSharedRenderer();
