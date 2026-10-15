// Builds the social card, public/img/og.jpg (1200×630): the site's own wordmark and promise set in the site's fonts, over
// the hero drawing. The text is real text set here, not generated, so it is spelled right. Headless Chromium + ffmpeg.
//   node scripts/og.mjs
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = fileURLToPath(new URL("..", import.meta.url));
const font = (pkg, file) => `file://${join(SITE, "node_modules", pkg, "files", file)}`;
const art = `data:image/webp;base64,${readFileSync(join(SITE, "public", "img", "art-hero-1600.webp")).toString("base64")}`;

const html = `<!doctype html><meta charset="utf-8"><style>
@font-face{font-family:"News";src:url(${font("@fontsource-variable/newsreader", "newsreader-latin-opsz-normal.woff2")});font-weight:200 800}
@font-face{font-family:"Plex";src:url(${font("@fontsource/ibm-plex-sans", "ibm-plex-sans-latin-500-normal.woff2")});font-weight:500}
html,body{margin:0}
body{width:1200px;height:630px;background:#faf8f3;position:relative;overflow:hidden;font-family:"Plex",sans-serif;color:#162151}
.art{position:absolute;right:-110px;top:70px;width:760px;mix-blend-mode:multiply;-webkit-mask-image:linear-gradient(to right,transparent,#000 12%,#000 94%,transparent),linear-gradient(to bottom,transparent,#000 8%,#000 92%,transparent);-webkit-mask-composite:source-in}
.word{position:absolute;left:72px;top:64px;font-family:"News";font-size:64px;line-height:1;letter-spacing:-0.01em}
.word::after{content:"";display:block;width:68px;height:6px;margin-top:8px;background:#c8a23d}
h1{position:absolute;left:72px;top:230px;margin:0;width:480px;font-family:"News";font-weight:350;font-size:86px;line-height:0.98;letter-spacing:-0.02em}
p{position:absolute;left:72px;bottom:64px;margin:0;width:470px;font-size:25px;line-height:1.4;color:#34406f;font-weight:500}
.rule{position:absolute;left:0;right:0;bottom:0;height:12px;background:#162151}
</style><div class="word">allevia</div><h1>We set it up. You steer.</h1><p>A team of AI staff for your business. Nothing goes out without your OK.</p><img class="art" src="${art}"><div class="rule"></div>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  const png = join(SITE, "scripts", ".og.png");
  await page.screenshot({ path: png });
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", png, "-q:v", "3", join(SITE, "public", "img", "og.jpg")]);
  unlinkSync(png);
} finally {
  await browser.close();
}
console.log("og.jpg written");
