// Loads every built page on BASE (default http://127.0.0.1:8812, the preview of the built prototypes) in headless Chromium and reports console errors, failed requests, horizontal overflow and
// the page height, at desktop, phone and reduced motion. Usage (from site/): node proto/qa/verify.mjs
import { chromium } from "playwright";
const BASE = process.env.BASE ?? "http://127.0.0.1:8812";
const pages = ["/", "/a/", "/product/", "/integrations/", "/pricing/", "/security/", "/faq/", "/team/", "/contact/"];
const configs = [
  { name: "desktop 1440", opts: { viewport: { width: 1440, height: 900 } } },
  { name: "phone 390", opts: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } },
  { name: "reduced 1280", opts: { viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" } },
];
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
let bad = 0;
for (const c of configs) {
  const ctx = await browser.newContext(c.opts);
  for (const p of pages) {
    const page = await ctx.newPage(); const errors = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });
    page.on("pageerror", (e) => errors.push(`pageerror ${String(e).slice(0, 160)}`));
    page.on("requestfailed", (r) => errors.push(`failed ${r.url().slice(0, 90)}`));
    page.on("response", (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url().slice(0, 90)}`); });
    await page.goto(BASE + p, { waitUntil: "load", timeout: 60000 }); await page.waitForTimeout(p === "/a/" ? 4500 : 2500);
    const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, h: document.documentElement.scrollHeight, title: document.title }));
    const ok = errors.length === 0 && m.sw <= m.cw + 1; if (!ok) bad++;
    console.log(`${ok ? "ok " : "BAD"} ${c.name.padEnd(13)} ${p.padEnd(15)} h=${m.h} overflowX=${m.sw > m.cw + 1 ? "YES " + m.sw + ">" + m.cw : "no"} ${errors.length ? errors.slice(0, 4).join(" | ") : ""}`);
    await page.close();
  }
  await ctx.close();
}
await browser.close();
console.log(bad ? `${bad} pages with problems` : "all pages load without console errors or horizontal scroll");
