// Builds side-by-side evidence images for docs/content-trials.md. Usage: node scripts/trials/_sheet.mjs <out.png> <label=file>...
import sharp from "sharp";
import { writeFileSync } from "node:fs";
const [out, ...items] = process.argv.slice(2);
const H = 640, LABEL = 44, GAP = 16;
const panels = [];
for (const it of items) {
  const i = it.indexOf("=");
  const label = it.slice(0, i), file = it.slice(i + 1);
  const img = await sharp(file).resize({ height: H }).jpeg({ quality: 88 }).toBuffer();
  const m = await sharp(img).metadata();
  panels.push({ label, img, w: m.width });
}
const total = panels.reduce((s, p) => s + p.w, 0) + GAP * (panels.length - 1);
const comp = [];
let x = 0;
for (const p of panels) {
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${p.w}" height="${LABEL}"><rect width="${p.w}" height="${LABEL}" fill="#191714"/><text x="14" y="29" font-family="Helvetica" font-size="20" fill="#f4f1ea">${p.label.replace(/&/g, "and")}</text></svg>`);
  comp.push({ input: svg, left: x, top: 0 }, { input: p.img, left: x, top: LABEL });
  x += p.w + GAP;
}
writeFileSync(out, await sharp({ create: { width: total, height: H + LABEL, channels: 3, background: "#f4f1ea" } }).composite(comp).png().toBuffer());
console.log(out, total, H + LABEL);
