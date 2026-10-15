// Renders the logo mark (public/favicon.svg: a pixel "a" on an indigo tile with a gold rule, the same mark as the
// office's pixel art) into the PNG icons the head links: favicon-48, apple-touch-icon (180), icon-192, logo-512. Headless
// Chromium only. The outputs are committed.   node scripts/icons.mjs
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC = join(fileURLToPath(new URL("..", import.meta.url)), "public");
const svg = readFileSync(join(PUBLIC, "favicon.svg"), "utf8");
const browser = await chromium.launch();
try {
  for (const [file, size, dir] of [["favicon-48.png", 48, PUBLIC], ["apple-touch-icon.png", 180, PUBLIC], ["icon-192.png", 192, PUBLIC], ["img/logo-512.png", 512, PUBLIC]]) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
    await page.screenshot({ path: join(dir, file), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    await page.close();
  }
} finally {
  await browser.close();
}
console.log("icons written to", PUBLIC);
