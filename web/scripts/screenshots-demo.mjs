// Screenshots of the SYNTHETIC business (Shiftly, demo_growth) from a running server, for the README and docs/live-scenarios.md.
// Nothing here shows a real business: it reads only the tenant you name. Headless Playwright against the public read-only
// server loaded with the recorded copy:
//   npm run cli -- seed-demo --recorded && npm run cli -- serve --public &
//   node web/scripts/screenshots-demo.mjs [baseUrl] [outDir] [tenant]
// Defaults: http://127.0.0.1:8787, docs/demo-screens, demo_growth.
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const base = (process.argv[2] ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const out = resolve(process.argv[3] ?? "docs/demo-screens");
const tenant = process.argv[4] ?? "demo_growth";
if (!/^demo_|_seed$/.test(tenant)) throw new Error(`refusing to photograph "${tenant}": only demo_* or *_seed businesses`);
await mkdir(out, { recursive: true });

const VPS = [
  { tag: "desktop", width: 1440, height: 900, dpr: 1, mobile: false },
  { tag: "mobile", width: 390, height: 844, dpr: 2, mobile: true },
];
const q = `tenant=${encodeURIComponent(tenant)}`;

let browser;
try { browser = await chromium.launch({ channel: "chrome" }); } catch { browser = await chromium.launch(); }
const api = async (path) => (await fetch(`${base}/api/${tenant}${path}`)).json();
const sessions = await api("/sessions");
const hero = sessions.find((s) => /sign-?ups drop/i.test(s.title)) ?? sessions[0];

const SCENES = [
  { name: "office", path: `/?${q}`, wait: 1500 },
  ...(hero ? [{ name: "ask-hero", path: `/chat/team/${encodeURIComponent(hero.id)}?${q}`, wait: 2500, how: true }] : []),
  { name: "brain", path: `/brain?${q}`, wait: 2000 },
  { name: "insights", path: `/insights?${q}`, wait: 1500 },
  { name: "approvals", path: `/approvals?${q}`, wait: 1500 },
];

for (const vp of VPS) {
  for (const s of SCENES) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.dpr, isMobile: vp.mobile, hasTouch: vp.mobile, colorScheme: "light" });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.error(`[${s.name}] pageerror:`, e.message));
    await page.goto(base + s.path, { waitUntil: "networkidle" });
    await page.waitForTimeout(s.wait);
    if (s.how) { const b = page.getByRole("button", { name: /How we got this/ }).first(); if (await b.count()) { await b.click(); await page.waitForTimeout(800); } }
    const file = `${out}/${s.name}-${vp.tag}.png`;
    await page.screenshot({ path: file });
    console.log("saved", file);
    await ctx.close();
  }
}
await browser.close();
