// Accessibility check of the built site with axe-core (WCAG 2.1 A and AA rules, including colour contrast) on every page at
// 390 and 1440 px, with motion reduced. Serves dist/ on port 4182 (never 8787). Run `npm run build` first.
//   npm run check:a11y
import { chromium } from "playwright";
import { preview } from "vite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = fileURLToPath(new URL("..", import.meta.url));
const axeSource = readFileSync(join(SITE, "node_modules", "axe-core", "axe.min.js"), "utf8");
const sitemap = readFileSync(join(SITE, "dist", "sitemap.xml"), "utf8");
const paths = [...sitemap.matchAll(/<loc>https?:\/\/[^/]+(\/[^<]*)<\/loc>/g)].map((m) => m[1]);

const server = await preview({ root: SITE, preview: { port: 4182, strictPort: false, open: false } });
const base = (server.resolvedUrls?.local[0] ?? "http://localhost:4182/").replace(/\/$/, "");
const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
let violations = 0;
try {
  // every page with motion reduced, and the home page again with motion welcome (the pinned story on a wide screen, the playing pictures on a phone)
  const runs = [{ width: 390, reduce: true, only: null }, { width: 1440, reduce: true, only: null }, { width: 390, reduce: false, only: "/" }, { width: 1440, reduce: false, only: "/" }];
  for (const { width, reduce, only } of runs) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: reduce ? "reduce" : "no-preference", locale: "en-US" });
    for (const path of only ? [only] : paths) {
      const page = await ctx.newPage();
      await page.goto(base + path, { waitUntil: "networkidle" });
      await page.evaluate(() => document.fonts.ready);
      await page.addScriptTag({ content: axeSource });
      const result = await page.evaluate(() => window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"] } }));
      for (const v of result.violations) {
        violations++;
        console.error(`${path} @${width}: ${v.id} (${v.impact}) ${v.help}`);
        for (const n of v.nodes.slice(0, 3)) console.error(`    ${n.target.join(" ")}  ${(n.failureSummary ?? "").split("\n").slice(1, 2).join("")}`);
      }
      await page.close();
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
}
console.log(`${paths.length} pages x 2 widths with motion reduced, and the home page with motion at 390 and 1440, checked; ${violations} violation(s)`);
process.exit(violations ? 1 : 0);
