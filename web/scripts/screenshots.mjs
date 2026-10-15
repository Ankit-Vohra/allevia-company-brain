// Screenshots of every page in mock mode, desktop (1440×900) and mobile (390×844).
// Usage: npm run build && npm run preview &  then  node scripts/screenshots.mjs [baseUrl] [outDir]
// SHOTS=office,ask filters by name prefix. THEME=dark switches theme. Uses the installed Chrome when available.
// The committed set in docs/screenshots: every shot in light, plus SHOTS=office-midrun,ask-final,insights,approvals THEME=dark.
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const base = process.argv[2] ?? "http://localhost:4173";
const out = resolve(process.argv[3] ?? "../docs/screenshots");
const only = (process.env.SHOTS ?? "").split(",").filter(Boolean);
const theme = process.env.THEME ?? "light";
await mkdir(out, { recursive: true });

const Q_STORIES = "Why did we pause daily stories, and what should we post instead?";
const enc = encodeURIComponent;

/** name, path, wait (ms after load), optional action */
const shots = [
  { name: "office-idle", path: "/?mock=1", wait: 1200 },
  { name: "office-midrun", path: `/?mock=1&ask=${enc(Q_STORIES)}&seek=17600`, wait: 2400 },
  { name: "office-answer", path: `/?mock=1&ask=${enc(Q_STORIES)}&seek=27000`, wait: 2600 },
  { name: "office-agent-profile", path: "/?mock=1", wait: 900, action: async (page) => { await page.getByRole("button", { name: /^Tara, Content Strategist/ }).click(); await page.waitForTimeout(1800); } },
  { name: "ask-midrun", path: `/ask?mock=1&ask=${enc(Q_STORIES)}&seek=19000`, wait: 2600 },
  { name: "ask-final", path: "/ask/s-aamdani-stories?mock=1", wait: 3200 },
  { name: "ask-final-checks", path: "/ask/s-aamdani-stories?mock=1", wait: 3200, action: async (page) => { await page.evaluate(() => { const el = document.querySelector(".ask-scroll"); if (el) el.scrollTop = el.scrollHeight; else window.scrollTo(0, document.body.scrollHeight); }); await page.waitForTimeout(400); } },
  { name: "brain", path: "/brain?mock=1&node=decision%3A007-pause-daily-posts-and-stories", wait: 3200 },
  { name: "insights", path: "/insights?mock=1", wait: 1800 },
  { name: "approvals", path: "/approvals?mock=1", wait: 1200 },
  { name: "onboard", path: "/onboard?mock=1&url=avsatelier.in&name=AVS%20Atelier&instagram=avs.atelier&country=India&go=1", wait: 9000 },
  { name: "onboard-done", path: "/onboard?mock=1&url=avsatelier.in&name=AVS%20Atelier&instagram=avs.atelier&country=India&go=1&speed=4", wait: 6000 },
  { name: "insights-avs", path: "/insights?mock=1&tenant=avs-atelier", wait: 1800 },
  { name: "studio", path: "/studio?mock=1", wait: 1200 },
];

const viewports = [
  { tag: "desktop", width: 1440, height: 900, dpr: 2, mobile: false },
  { tag: "mobile", width: 390, height: 844, dpr: 2, mobile: true },
];

let browser;
try { browser = await chromium.launch({ channel: "chrome" }); } catch { browser = await chromium.launch(); }

for (const vp of viewports) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.dpr,
    isMobile: vp.mobile,
    hasTouch: vp.mobile,
    colorScheme: theme === "dark" ? "dark" : "light",
  });
  for (const s of shots) {
    if (only.length && !only.some((o) => s.name.startsWith(o))) continue;
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.error(`[${s.name}/${vp.tag}] pageerror:`, e.message));
    page.on("console", (m) => { if (m.type() === "error") console.error(`[${s.name}/${vp.tag}] console:`, m.text()); });
    await page.goto(base + s.path, { waitUntil: "networkidle" });
    await page.waitForTimeout(s.wait);
    if (s.action) await s.action(page);
    const file = `${out}/${s.name}-${vp.tag}${theme === "dark" ? "-dark" : ""}.png`;
    await page.screenshot({ path: file, fullPage: !!s.full });
    console.log("saved", file);
    await page.close();
  }
  await ctx.close();
}
await browser.close();
