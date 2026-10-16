// The v6 screenshots for docs/screenshots (site-v6-<page>-<width>.webp): the main pages at 390, 700 and 1440 px wide, whole
// page, with motion reduced so every picture is in its finished state (the stills a visitor with reduced motion sees). The
// home page also gets the scroll story's contact sheet from lab.mjs and the phone's playing frames, when they exist in the
// folders named below. Serves dist/ on port 4186 (never 8787); run `npm run build` first. Needs cwebp.
//
//   node site/scripts/shots-v6.mjs [outDir]       default: docs/screenshots
import { chromium } from "playwright";
import { preview } from "vite";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = fileURLToPath(new URL("..", import.meta.url));
const OUT = resolve(process.argv[2] ?? join(SITE, "..", "docs", "screenshots"));
const TMP = join(SITE, "scripts", ".shots-tmp");
mkdirSync(OUT, { recursive: true });
mkdirSync(TMP, { recursive: true });
const pages = [["home", "/"], ["product", "/product/"], ["pricing", "/pricing/"], ["security", "/security/"], ["faq", "/faq/"]];
const widths = [390, 700, 1440];

const server = await preview({ root: SITE, preview: { port: 4186, strictPort: true, open: false } });
const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
try {
  for (const width of widths) {
    const ctx = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 900 }, deviceScaleFactor: width < 600 ? 2 : 1, reducedMotion: "reduce", locale: "en-US", timezoneId: "America/New_York" });
    for (const [name, path] of pages) {
      const page = await ctx.newPage();
      await page.goto(`http://localhost:4186${path}`, { waitUntil: "networkidle" });
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => document.querySelectorAll("img[loading=lazy]").forEach((i) => { i.loading = "eager"; }));
      await page.waitForTimeout(1200);
      // the fixed route strip is a screen-sized thing; leave it where it would sit (bottom of the first screen) by hiding it in the long shot
      await page.addStyleTag({ content: ".route { display: none !important; }" });
      const png = join(TMP, `${name}-${width}.png`);
      await page.screenshot({ path: png, fullPage: true });
      execFileSync("cwebp", ["-quiet", "-q", "82", png, "-o", join(OUT, `site-v6-${name}-${width}.webp`)]);
      await page.close();
      console.log(`site-v6-${name}-${width}.webp`);
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
  rmSync(TMP, { recursive: true, force: true });
}
