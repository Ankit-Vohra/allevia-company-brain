// Screenshots of the built site: every page in dist/ (read from sitemap.xml) at 390, 700 and 1440 px wide, whole page.
// Serves dist/ with `vite preview` in-process on port 4181 (never 8787), so run `npm run build` first. Motion is reduced
// so the hero shows its still drawing. Also reports anything wider than the viewport, failed requests and console errors.
//
//   npm run build && npm run shots                         # into scripts/.site-shots (not committed)
//   OUT=/some/dir PAGES=/,/privacy/ npm run shots          # a folder of your choice, some pages only
//   COMMIT=1 npm run shots                                 # also copy the first screen of the main pages into docs/screenshots
import { chromium } from "playwright";
import { preview } from "vite";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = fileURLToPath(new URL("..", import.meta.url));
const OUT = resolve(process.env.OUT ?? join(SITE, "scripts", ".site-shots"));
const DOCS = join(SITE, "..", "docs", "screenshots");
mkdirSync(OUT, { recursive: true });

const only = (process.env.PAGES ?? "").split(",").filter(Boolean);
const sitemap = readFileSync(join(SITE, "dist", "sitemap.xml"), "utf8");
const paths = [...sitemap.matchAll(/<loc>https?:\/\/[^/]+(\/[^<]*)<\/loc>/g)].map((m) => m[1]).filter((p) => !only.length || only.includes(p));
const widths = [390, 700, 1440];
const slug = (p) => (p === "/" ? "home" : p.replaceAll("/", ""));

const server = await preview({ root: SITE, preview: { port: 4181, strictPort: false, open: false } });
const base = (server.resolvedUrls?.local[0] ?? "http://localhost:4181/").replace(/\/$/, "");
const browser = await chromium.launch();
let problems = 0;
try {
  for (const width of widths) {
    const height = width < 600 ? 844 : 900;
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: width < 600 ? 2 : 1, reducedMotion: "reduce", locale: "en-US", timezoneId: "America/New_York" });
    for (const path of paths) {
      const tab = await ctx.newPage();
      const bad = [];
      tab.on("pageerror", (e) => bad.push(`pageerror: ${e.message}`));
      tab.on("console", (m) => { if (m.type() === "error") bad.push(`console: ${m.text()}`); });
      tab.on("requestfailed", (r) => bad.push(`request failed: ${r.url()}`));
      tab.on("response", (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`); });
      await tab.goto(base + path, { waitUntil: "networkidle" });
      await tab.evaluate(() => document.fonts.ready);
      // walk the page so lazy images load, then capture it whole
      const h = await tab.evaluate(() => document.body.scrollHeight);
      for (let y = 0; y < h; y += height) { await tab.evaluate((yy) => window.scrollTo(0, yy), y); await tab.waitForTimeout(100); }
      await tab.evaluate(() => window.scrollTo(0, 0));
      await tab.waitForLoadState("networkidle");
      await tab.screenshot({ path: join(OUT, `${slug(path)}-${width}.png`), fullPage: true });
      // anything poking past the right edge (the root clips overflow, so scrollWidth alone would hide it)
      const wide = await tab.evaluate(() =>
        [...document.querySelectorAll("body *")]
          .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1 && !el.closest(".hero__art, thead, .visually-hidden, .table-wrap, .skip"))
          .slice(0, 5)
          .map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join(".")} → ${Math.round(el.getBoundingClientRect().right)}px`),
      );
      if (wide.length) { problems++; console.warn(`${path} @${width}: wider than the viewport:`, wide); }
      if (bad.length) { problems++; console.warn(`${path} @${width}:`, bad); }
      if (process.env.COMMIT && ["/", "/how-it-works/", "/product/", "/security/", "/privacy/"].includes(path)) {
        await tab.screenshot({ path: join(OUT, `first-${slug(path)}-${width}.png`) });
      }
      await tab.close();
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
}
if (process.env.COMMIT) {
  mkdirSync(DOCS, { recursive: true });
  for (const p of ["/", "/how-it-works/", "/product/", "/security/", "/privacy/"]) for (const w of widths) {
    const f = join(OUT, `first-${slug(p)}-${w}.png`);
    if (existsSync(f)) copyFileSync(f, join(DOCS, `site-v3-${slug(p)}-${w}.png`));
  }
}
console.log(`${paths.length} pages x ${widths.length} widths in ${OUT}; ${problems} problem(s)`);
process.exit(problems ? 1 : 0);
