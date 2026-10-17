// Declutter pass 2: every owner page on the real businesses (aamdani, demo_growth) at 375 and 1280, plus the More menu,
// with a word count per shot. Read-only: it never clicks OK, No or any card button.
// Usage: node scripts/screenshots-declutter2.mjs <baseUrl> <before|after> [outDir]      (SHOTS=home,chat filters pages)
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const base = process.argv[2] ?? "http://127.0.0.1:8787";
const phase = process.argv[3] ?? "before";
const out = resolve(process.argv[4] ?? "../docs/screenshots/declutter2");
const only = (process.env.SHOTS ?? "").split(",").filter(Boolean);
await mkdir(out, { recursive: true });

const PAGES = [
  ["home", "/"], ["chat", "/chat"], ["brain", "/brain"], ["approvals", "/approvals"], ["insights", "/insights"],
  ["office", "/office"], ["studio", "/studio"], ["tools", "/connections"], ["plan", "/plan"], ["program", "/program"],
];
const TENANTS = (process.env.TENANTS ?? "aamdani,demo_growth").split(",");
const VPS = [{ tag: "375", width: 375, height: 812, mobile: true }, { tag: "1280", width: 1280, height: 860, mobile: false }];

const countsFile = `${out}/word-counts.json`;
let counts = {};
try { counts = JSON.parse(await readFile(countsFile, "utf8")); } catch {}

const words = (page, sel) => page.evaluate((s) => (document.querySelector(s)?.innerText ?? "").split(/\s+/).filter(Boolean).length, sel);

let browser;
try { browser = await chromium.launch({ channel: "chrome" }); } catch { browser = await chromium.launch(); }
for (const t of TENANTS) {
  for (const vp of VPS) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1, isMobile: vp.mobile, hasTouch: vp.mobile, colorScheme: "light" });
    for (const [name, path] of PAGES) {
      if (only.length && !only.includes(name)) continue;
      const page = await ctx.newPage();
      page.on("pageerror", (e) => console.error(`[${t} ${path}] pageerror:`, e.message));
      await page.goto(`${base}${path}?tenant=${t}`, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(name === "office" || name === "brain" ? 3500 : 1800);
      const w = await words(page, "main");
      const file = `${out}/${t}-${name}-${phase}-${vp.tag}.png`;
      await page.screenshot({ path: file, fullPage: true });
      (counts[`${t}/${name}`] ??= {})[`${phase}-${vp.tag}`] = w;
      (counts[`${t}/topbar`] ??= {})[`${phase}-${vp.tag}`] = await words(page, "header");
      console.log(file, w);
      if (name === "home" && t === TENANTS[0]) {
        const btn = page.locator(vp.mobile ? ".more-mobile .more-btn" : ".more-desktop .more-btn");
        if (await btn.count()) {
          await btn.first().click();
          await page.waitForTimeout(400);
          (counts[`${t}/more-menu`] ??= {})[`${phase}-${vp.tag}`] = await words(page, ".more-menu");
          await page.screenshot({ path: `${out}/${t}-more-menu-${phase}-${vp.tag}.png` });
        }
      }
      await page.close();
    }
    await ctx.close();
  }
}
await browser.close();
await writeFile(countsFile, JSON.stringify(counts, null, 2) + "\n");
