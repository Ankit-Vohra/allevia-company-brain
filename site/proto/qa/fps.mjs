// Measures frames per second and long frames of the 3D hero (and, for comparison, a page with no WebGL) in headless Chrome.
// Usage (from site/): node proto/qa/fps.mjs chrome   (channel "chrome" uses the installed Google Chrome, which can use the GPU)
import { chromium } from "playwright";
const BASE = process.env.BASE ?? "http://127.0.0.1:8812";
const channel = process.argv[2];
const browser = await chromium.launch({ ...(channel ? { channel } : {}), args: process.argv.includes("--swift") ? ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] : ["--ignore-gpu-blocklist", "--enable-gpu-rasterization"] });
for (const [label, viewport, dpr] of [["desktop 1440x900 @2x", { width: 1440, height: 900 }, 2], ["laptop 1280x720 @1x", { width: 1280, height: 720 }, 1]]) {
  const page = await (await browser.newContext({ viewport, deviceScaleFactor: dpr })).newPage();
  await page.goto(`${BASE}/a/`, { waitUntil: "load" }); await page.waitForTimeout(5000);
  const r = await page.evaluate(() => new Promise((res) => {
    const gl = document.createElement("canvas").getContext("webgl"); const info = gl?.getExtension("WEBGL_debug_renderer_info"); const renderer = gl && info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : "n/a";
    let frames = 0, long = 0, last = performance.now(); const gaps = []; const t0 = last;
    const tick = (ts) => { frames++; const d = ts - last; last = ts; gaps.push(d); if (d > 24) long++; if (ts - t0 < 6000) requestAnimationFrame(tick); else { gaps.sort((a, b) => a - b); res({ renderer, fps: (frames / ((ts - t0) / 1000)).toFixed(1), long, p50: gaps[Math.floor(gaps.length / 2)].toFixed(1), p95: gaps[Math.floor(gaps.length * 0.95)].toFixed(1), worst: gaps[gaps.length - 1].toFixed(1) }); } };
    requestAnimationFrame(tick);
  }));
  console.log(label, JSON.stringify(r));
  await page.close();
}
await browser.close();
