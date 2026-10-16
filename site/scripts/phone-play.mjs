// The phone story with motion on: scroll to each picture, let it play, and write one strip of frames (mid-play and finished)
// as docs/screenshots/site-v6-phone-play-390.webp. No scrubbing happens on a phone: each picture plays once when seen.
// Serves dist/ on port 4185 (never 8787); run `npm run build` first. Needs ffmpeg and cwebp.
//
//   node site/scripts/phone-play.mjs [outFile]
import { chromium } from "playwright";
import { preview } from "vite";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = fileURLToPath(new URL("..", import.meta.url));
const OUT = resolve(process.argv[2] ?? join(SITE, "..", "docs", "screenshots", "site-v6-phone-play-390.webp"));
const TMP = join(SITE, "scripts", ".shots-tmp");
mkdirSync(TMP, { recursive: true });
const server = await preview({ root: SITE, preview: { port: 4185, strictPort: true, open: false } });
const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
const files = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: "no-preference" });
  const page = await ctx.newPage();
  const errs = [];
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  page.on("pageerror", (e) => errs.push(e.message));
  await page.goto("http://localhost:4185/", { waitUntil: "load" });
  await page.waitForTimeout(1200);
  for (const [name, sel, wait] of [["brain", '[data-scene="form"] .panel', 9500], ["office", ".panel--office", 14000], ["path", ".panel--ask", 1500]]) {
    await page.evaluate((s) => document.querySelector(s).scrollIntoView({ block: "center", behavior: "instant" }), sel);
    await page.waitForTimeout(3200);
    const mid = join(TMP, `${name}-mid.png`);
    await page.screenshot({ path: mid });
    files.push(mid);
    await page.waitForTimeout(wait);
    if (name !== "office") { const end = join(TMP, `${name}-end.png`); await page.screenshot({ path: end }); files.push(end); }
  }
  console.log("errors:", JSON.stringify(errs));
  await ctx.close();
  const strip = join(TMP, "strip.png");
  execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...files.flatMap((f) => ["-i", f]), "-filter_complex", `${files.map((_, i) => `[${i}:v]scale=390:-1[s${i}]`).join(";")};${files.map((_, i) => `[s${i}]`).join("")}hstack=inputs=${files.length}`, strip]);
  execFileSync("cwebp", ["-quiet", "-q", "80", strip, "-o", OUT]);
  console.log("wrote", OUT);
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
  rmSync(TMP, { recursive: true, force: true });
}
