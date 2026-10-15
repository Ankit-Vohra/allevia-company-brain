// Builds site/public/img from the product screenshots in docs/screenshots (cropped, WebP at two widths) and, when ART_DIR
// points at the original Higgsfield renders, the illustrations and the hero loop. The outputs are committed, so a normal
// `npm run build` never needs this. Needs `cwebp` and `ffmpeg` on PATH.
//
//   npm run images                       # screenshots only
//   ART_DIR=/path/to/renders npm run images
//
// ART_DIR holds: hero.png (job 856882d7), team.png (674ea36c), before-after.png (3292abb7, a stray camera mark painted
// out), ledger.png (be3969c6), hero.mp4 and hero.webm (job 659c4095, re-encoded). See docs/higgsfield-spend.md.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = fileURLToPath(new URL("..", import.meta.url));
const SHOTS = join(SITE, "..", "docs", "screenshots");
const OUT = join(SITE, "public", "img");
mkdirSync(OUT, { recursive: true });

const webp = (src, out, width, quality, crop) => {
  const args = ["-quiet", "-q", String(quality), "-sharp_yuv", "-m", "6"];
  if (crop) args.push("-crop", ...crop.map(String));
  args.push("-resize", String(width), "0", src, "-o", join(OUT, out));
  execFileSync("cwebp", args, { stdio: "inherit" });
};

// Product screenshots (2880×1800 captures at 2×). crop = x y w h in source pixels.
const shots = [
  { src: "live-office-answer.png", name: "shot-office", crop: [45, 395, 2030, 1370], widths: [1600, 800] },
  { src: "live-ask-final.png", name: "shot-ask", crop: [505, 112, 2375, 1688], widths: [1800, 900] },
  { src: "onboard-done-desktop.png", name: "shot-onboard", crop: [40, 140, 2140, 1300], widths: [1600, 800] },
  { src: "ask-final-desktop.png", name: "shot-run", crop: [560, 255, 1240, 760], widths: [1240, 700] },
  { src: "approvals-desktop.png", name: "shot-approve", crop: [255, 520, 2360, 580], widths: [1600, 800] },
  { src: "approvals-desktop.png", name: "shot-learn", crop: [255, 150, 2370, 250], widths: [1600, 800] },
];
for (const s of shots) for (const w of s.widths) webp(join(SHOTS, s.src), `${s.name}-${w}.webp`, w, 84, s.crop);

const ART = process.env.ART_DIR;
if (ART && existsSync(ART)) {
  const art = [
    { src: "hero.png", name: "art-hero", widths: [1600, 900] },
    { src: "team.png", name: "art-team", widths: [1400, 800] },
    { src: "before-after.png", name: "art-before-after", widths: [1600, 900] },
    { src: "ledger.png", name: "art-ledger", widths: [1200, 700] },
  ];
  for (const a of art) for (const w of a.widths) webp(join(ART, a.src), `${a.name}-${w}.webp`, w, 78);
  // Open Graph card: 1200×630 from the hero illustration
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", join(ART, "hero.png"), "-vf", "scale=1200:-2,crop=1200:630:0:90", "-q:v", "4", join(OUT, "og.jpg")]);
  for (const v of ["hero.mp4", "hero.webm"]) copyFileSync(join(ART, v), join(OUT, `art-${v}`));
}
console.log("images written to", OUT);
