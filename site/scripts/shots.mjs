// Screenshots of the built site at 1440×900 and 390×844: the first screen of each page into docs/screenshots (committed),
// and full pages into OUT_FULL when set (for review). Serves dist/ with `vite preview` in-process, so run `npm run build`
// first. Motion is reduced so the hero shows its still drawing.
//   npm run build && npm run shots
//   OUT_FULL=/tmp/site-full npm run shots
import { chromium } from "playwright";
import { preview } from "vite";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = fileURLToPath(new URL("..", import.meta.url));
const OUT = join(SITE, "..", "docs", "screenshots");
const FULL = process.env.OUT_FULL;
await mkdir(OUT, { recursive: true });
if (FULL) await mkdir(FULL, { recursive: true });

const server = await preview({ root: SITE, preview: { port: 4181, strictPort: false, open: false } });
const base = server.resolvedUrls?.local[0] ?? "http://localhost:4181/";
const browser = await chromium.launch();
try {
  for (const [vp, size] of [["desktop", { width: 1440, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
    for (const [page, path] of [["home", ""], ["pricing", "pricing/"]]) {
      const ctx = await browser.newContext({ viewport: size, deviceScaleFactor: vp === "mobile" ? 2 : 1, reducedMotion: "reduce", locale: "en-US", timezoneId: "America/New_York" });
      const tab = await ctx.newPage();
      await tab.goto(base + path, { waitUntil: "networkidle" });
      await tab.evaluate(() => document.fonts.ready);
      await tab.screenshot({ path: join(OUT, `site-${page}-${vp}.png`) });
      // Anything poking past the right edge (the root clips overflow, so scrollWidth alone would hide it)
      const wide = await tab.evaluate(() =>
        [...document.querySelectorAll("body *")]
          .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1 && !el.closest(".hero__art, thead, .visually-hidden"))
          .slice(0, 5)
          .map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join(".")} → ${Math.round(el.getBoundingClientRect().right)}px`),
      );
      if (wide.length) console.warn(`${page} ${vp}: wider than the viewport:`, wide);
      if (FULL) {
        // walk the page so lazy images load, then capture it whole
        const h = await tab.evaluate(() => document.body.scrollHeight);
        for (let y = 0; y < h; y += size.height) { await tab.evaluate((yy) => window.scrollTo(0, yy), y); await tab.waitForTimeout(120); }
        await tab.evaluate(() => window.scrollTo(0, 0));
        await tab.waitForLoadState("networkidle");
        await tab.screenshot({ path: join(FULL, `site-${page}-${vp}-full.png`), fullPage: true });
      }
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
}
console.log("screenshots in", OUT, FULL ? `and ${FULL}` : "");
