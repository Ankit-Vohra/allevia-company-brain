// Builds site/public/img from the product screens (taken by scripts/product-shots.mjs) and the trial photos in
// docs/screenshots (cropped, WebP at two widths) and, when ART_DIR points at the original Higgsfield renders, the
// illustrations and the hero loop. The outputs are committed, so a normal `npm run build` never needs this.
// Needs `cwebp` and `ffmpeg` on PATH.
//
//   node site/scripts/product-shots.mjs                  # fresh screens into scripts/.product-shots (not committed)
//   npm run images                                       # screens and trial photos
//   ART_DIR=/path/to/renders npm run images              # plus the art
//
// ART_DIR holds the art/*.png named below (jobs listed in docs/higgsfield-spend.md).
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = fileURLToPath(new URL("..", import.meta.url));
const DOCS = join(SITE, "..", "docs", "screenshots");
const SHOTS = resolve(process.env.SHOTS_DIR ?? join(SITE, "scripts", ".product-shots"));
const OUT = join(SITE, "public", "img");
mkdirSync(OUT, { recursive: true });

const webp = (src, out, width, quality, crop) => {
  const args = ["-quiet", "-q", String(quality), "-sharp_yuv", "-m", "6"];
  if (crop) args.push("-crop", ...crop.map(String));
  args.push("-resize", String(width), "0", src, "-o", join(OUT, out));
  execFileSync("cwebp", args, { stdio: "inherit" });
};

// Product screens, 2880×1800 at 2x (phone: 780×1688). crop = x y w h in source pixels.
const screens = [
  { src: "office-idle.png", name: "tour-office", widths: [1600, 800] },
  { src: "office-midrun.png", name: "tour-office-working", widths: [1600, 800] },
  { src: "office-idle.png", name: "tour-plan-card", crop: [2120, 180, 700, 1360], widths: [700, 420] },
  { src: "onboard-done.png", name: "tour-plan-setup", crop: [760, 170, 1360, 1180], widths: [1200, 700] },
  { src: "onboard-steps.png", name: "tour-onboard", widths: [1600, 800] },
  { src: "ask-default.png", name: "tour-ask", widths: [1600, 800] },
  { src: "ask-expanded.png", name: "tour-path", widths: [1600, 800] },
  { src: "approvals.png", name: "tour-approve", crop: [760, 130, 1360, 1180], widths: [1200, 700] },
  { src: "team.png", name: "tour-team", crop: [660, 160, 1560, 1640], widths: [1200, 700] },
  { src: "insights.png", name: "tour-insights", widths: [1600, 800] },
  { src: "phone-office.png", name: "phone-office", widths: [780, 390] },
  { src: "phone-approvals.png", name: "phone-approvals", widths: [780, 390] },
];
for (const s of screens) {
  const src = join(SHOTS, s.src);
  if (!existsSync(src)) { console.warn("missing", src, "(run product-shots.mjs)"); continue; }
  for (const w of s.widths) webp(src, `${s.name}-${w}.webp`, w, 82, s.crop);
}

// The Studio trial photos: docs/screenshots/content-p2-compare.png is 1472×644, three panels under a 44 px label bar.
const compare = join(DOCS, "content-p2-compare.png");
for (const p of [
  { name: "studio-before", crop: [0, 197, 480, 293], widths: [480] },
  { name: "studio-local", crop: [496, 44, 480, 600], widths: [480] },
  { name: "studio-ai", crop: [992, 44, 480, 600], widths: [480] },
]) for (const w of p.widths) webp(compare, `${p.name}-${w}.webp`, w, 86, p.crop);

// The office-life loop (docs/screenshots/office-life.mp4, 28 s, recorded in the app's mock mode): a poster frame, and an
// MP4 re-encoded small, with no sound track.
const life = join(DOCS, "office-life.mp4");
if (existsSync(life)) {
  execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", "9", "-i", life, "-frames:v", "1", "-vf", "scale=1280:-2", join(OUT, "office-life-poster.png")]);
  webp(join(OUT, "office-life-poster.png"), "office-life-poster-1280.webp", 1280, 80);
  execFileSync("rm", ["-f", join(OUT, "office-life-poster.png")]);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", life, "-an", "-vf", "scale=960:-2", "-c:v", "libx264", "-preset", "slow", "-crf", "30", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(OUT, "office-life.mp4")]);
}

const ART = process.env.ART_DIR;
if (ART && existsSync(ART)) {
  const art = [
    { src: "hero.png", name: "art-hero", widths: [1600, 900] },
    { src: "before-after.png", name: "art-before-after", widths: [1600, 900] },
    { src: "ledger.png", name: "art-ledger", widths: [1200, 700] },
    { src: "security.png", name: "art-security", widths: [1200, 700] },
    { src: "steps.png", name: "art-steps", widths: [1400, 800] },
    { src: "about.png", name: "art-about", widths: [1200, 700] },
    { src: "contact.png", name: "art-contact", widths: [1000, 600] },
  ];
  for (const a of art) {
    if (!existsSync(join(ART, a.src))) continue;
    for (const w of a.widths) webp(join(ART, a.src), `${a.name}-${w}.webp`, w, 78);
  }
  for (const v of ["hero.mp4"]) if (existsSync(join(ART, v))) copyFileSync(join(ART, v), join(OUT, `art-${v}`));
}
console.log("images written to", OUT);
