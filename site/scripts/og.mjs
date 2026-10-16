// The social card (site/public/img/og.jpg, 1200 x 630): the home page's own first screen, headline and brain, shot from the
// built site with motion reduced and the masthead and route strip out of the way. Costs nothing, and it cannot drift from the
// page. Serves dist/ on port 4188 (never 8787); run `npm run build` first.
//
//   node scripts/og.mjs
import { chromium } from "playwright";
import { preview } from "vite";
import sharp from "sharp";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const SITE = fileURLToPath(new URL("..", import.meta.url));
const server = await preview({ root: SITE, preview: { port: 4188, strictPort: true, open: false } });
const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1, reducedMotion: "reduce" });
  await page.goto("http://localhost:4188/", { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({ content: ".mast, .route { display: none !important; } .act--hero { padding-top: 2.6rem !important; } .lead__h { font-size: 3.7rem !important; }" });
  await page.waitForTimeout(600);
  const png = await page.screenshot({ clip: { x: 0, y: 0, width: 1200, height: 630 } });
  await sharp(png).jpeg({ quality: 84, mozjpeg: true }).toFile(join(SITE, "public", "img", "og.jpg"));
  console.log("public/img/og.jpg written");
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
}
