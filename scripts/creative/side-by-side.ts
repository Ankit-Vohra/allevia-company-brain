// A before/after board for the design proofs: the old picture on the left, the new ones on the right, labelled.
//   npx tsx scripts/creative/side-by-side.ts --out board.jpg --title "..." --before old.jpg --after new1.jpg --after new2.jpg
import { parseArgs } from "node:util";
import sharp from "sharp";

const { values: a } = parseArgs({ options: { out: { type: "string" }, title: { type: "string" }, before: { type: "string", multiple: true }, after: { type: "string", multiple: true }, height: { type: "string" } } });
if (!a.out || !a.before?.length || !a.after?.length) throw new Error("usage: --out file --before a.jpg --after b.jpg [--after c.jpg] [--title text]");
const H = Number(a.height ?? 900), gap = 28, head = 120, pad = 40;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const tiles = async (files: string[]) => Promise.all(files.map(async (f) => sharp(f).resize({ height: H }).jpeg({ quality: 88 }).toBuffer({ resolveWithObject: true })));
const before = await tiles(a.before), after = await tiles(a.after);
const wB = before.reduce((n, t) => n + t.info.width + gap, -gap), wA = after.reduce((n, t) => n + t.info.width + gap, -gap);
const W = pad * 2 + wB + 80 + wA, Ht = head + H + pad;
const comp: sharp.OverlayOptions[] = [];
let x = pad;
for (const t of before) { comp.push({ input: t.data, left: x, top: head }); x += t.info.width + gap; }
x = pad + wB + 80;
for (const t of after) { comp.push({ input: t.data, left: x, top: head }); x += t.info.width + gap; }
const label = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${head}">
  <text x="${pad}" y="46" font-family="Helvetica" font-size="30" font-weight="700" fill="#1b1b1b">${esc(a.title ?? "")}</text>
  <text x="${pad}" y="96" font-family="Helvetica" font-size="26" fill="#9a3b2a">Before (made 15 Oct, SVG composer)</text>
  <text x="${pad + wB + 80}" y="96" font-family="Helvetica" font-size="26" fill="#2c6b3f">After (design engine v2: real material, layout library, review and revision)</text></svg>`;
comp.push({ input: Buffer.from(label), left: 0, top: 0 });
await sharp({ create: { width: W, height: Ht, channels: 3, background: "#ecebe6" } }).composite(comp).jpeg({ quality: 86 }).toFile(a.out);
console.log(a.out, W, Ht);
