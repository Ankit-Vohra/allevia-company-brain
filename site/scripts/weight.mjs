// What the home page costs to load: bytes over the wire (as served by vite preview, uncompressed text counted as gzip would
// leave it, estimated) by kind, on first paint and after scrolling the whole page, on a wide screen and on a phone, motion on.
//
//   (cd site && npm run build) && node site/scripts/weight.mjs
import { chromium } from "playwright";
import { preview } from "vite";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const SITE = fileURLToPath(new URL("..", import.meta.url));
const server = await preview({ root: SITE, preview: { port: 4187, strictPort: true, open: false } });
const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
async function run(label, viewport, mobile) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile, reducedMotion: "no-preference" });
  const page = await ctx.newPage();
  const seen = new Map();
  const bytesOf = async (r) => {
    try {
      const type = r.request().resourceType();
      const body = await r.body();
      const size = /html|css|javascript|json|svg/.test(r.headers()["content-type"] ?? "") ? gzipSync(body).length : body.length;
      seen.set(r.url(), { type, size });
    } catch { /* aborted media requests */ }
  };
  page.on("response", (r) => { void bytesOf(r); });
  await page.goto("http://localhost:4187/", { waitUntil: "load" });
  await page.waitForTimeout(1500);
  const sum = () => { const by = {}; for (const { type, size } of seen.values()) by[type] = (by[type] ?? 0) + size; const total = Object.values(by).reduce((a, b) => a + b, 0); return { total, by }; };
  const first = sum();
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < h; y += viewport.height * 0.6) { await page.evaluate((t) => scrollTo({ top: t, behavior: "instant" }), y); await page.waitForTimeout(160); }
  await page.waitForTimeout(1500);
  const all = sum();
  console.log(`${label}: first paint ${kb(first.total)} (${Object.entries(first.by).map(([k, v]) => `${k} ${kb(v)}`).join(", ")}); after scrolling it all ${kb(all.total)} (${Object.entries(all.by).map(([k, v]) => `${k} ${kb(v)}`).join(", ")})`);
  await ctx.close();
}
try {
  await run("1440 wide", { width: 1440, height: 900 }, false);
  await run("390 phone", { width: 390, height: 844 }, true);
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
}
