// Throwaway: serve dist/ and run a snippet in the page. Usage: node site/scripts/_probe.mjs "<js expression>" [width] [height]
import { chromium } from "playwright";
import { preview } from "vite";
import { fileURLToPath } from "node:url";
const SITE = fileURLToPath(new URL("..", import.meta.url));
const server = await preview({ root: SITE, preview: { port: 4184, strictPort: true, open: false } });
const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: Number(process.argv[3] ?? 1440), height: Number(process.argv[4] ?? 900) } });
await page.goto("http://localhost:4184/", { waitUntil: "load" });
await page.waitForTimeout(1200);
console.log(JSON.stringify(await page.evaluate(process.argv[2]), null, 1));
await browser.close();
await new Promise((r) => server.httpServer.close(r));
