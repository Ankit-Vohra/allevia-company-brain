// Fresh screens of the real web app for the product tour, taken at 2x in the app's own mock mode (?mock=1: sample
// numbers, the app says "Demo data" in its top bar) with headless Chromium. Never uses the shared browser pane and never
// port 8787: it serves web/dist itself on port 4175 (override with SHOTS_PORT).
//
//   (cd web && npm run build) && node site/scripts/product-shots.mjs [outDir]      # default: a folder next to this script
//
// The shots are PNGs for scripts/images.mjs to crop and convert; they are not committed (the WebP outputs in
// site/public/img are).
import { chromium } from "playwright";
import { preview } from "vite";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const WEB = resolve(HERE, "..", "..", "web");
const OUT = resolve(process.argv[2] ?? join(HERE, ".product-shots"));
await mkdir(OUT, { recursive: true });

const port = Number(process.env.SHOTS_PORT ?? 4175);
if (port === 8787) throw new Error("port 8787 is reserved for the real server");
const server = await preview({ root: WEB, preview: { port, strictPort: true, open: false } });
const base = `http://localhost:${port}`;

const enc = encodeURIComponent;
const Q = "What should we post this week?";
const SEED = "seed=11";
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

let browser;
try { browser = await chromium.launch(); } catch (e) { console.error("Chromium is not installed for Playwright:", e.message); process.exit(1); }

async function shoot(name, path, { vp = DESKTOP, dpr = 2, mobile = false, wait = 1500, action, full = false } = {}) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: dpr, isMobile: mobile, hasTouch: mobile, colorScheme: "light", reducedMotion: "no-preference" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error(`[${name}] pageerror:`, e.message));
  await page.goto(base + path, { waitUntil: "networkidle" });
  await page.waitForTimeout(wait);
  if (action) await action(page);
  const file = join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: full });
  console.log("saved", file);
  await ctx.close();
}

const untilDog = (page, ms = 40000) =>
  page.waitForFunction(() => window.__office?.life?.pets.some((p) => p.carrying), null, { timeout: ms }).then(() => true, () => false);

try {
  await shoot("office-idle", `/office?mock=1&${SEED}&clock=11:00`, { wait: 3200 });
  await shoot("office-midrun", `/office?mock=1&${SEED}&clock=11:00&debug=1&ask=${enc(Q)}&seek=3500`, {
    wait: 600,
    action: async (p) => { await untilDog(p); await p.waitForTimeout(250); },
  });
  await shoot("ask-default", "/ask/s-aamdani-stories?mock=1", {
    wait: 3000,
    action: async (p) => {
      await p.evaluate(() => { const el = document.querySelector(".ask-scroll"); if (el && el.scrollHeight > el.clientHeight) el.scrollTop = el.scrollHeight; else window.scrollTo(0, document.body.scrollHeight); });
      await p.waitForTimeout(400);
    },
  });
  await shoot("ask-expanded", "/ask/s-aamdani-stories?mock=1", {
    wait: 3000,
    action: async (p) => {
      await p.evaluate(() => { const el = document.querySelector(".ask-scroll"); if (el && el.scrollHeight > el.clientHeight) el.scrollTop = el.scrollHeight; else window.scrollTo(0, document.body.scrollHeight); });
      await p.waitForTimeout(400);
      await p.getByText("Show how the team worked").first().click();
      await p.waitForTimeout(700);
      await p.getByText("See the path").first().click();
      await p.waitForTimeout(2600);
    },
  });
  await shoot("approvals", "/approvals?mock=1", { wait: 1500 });
  await shoot("plan", "/plan?mock=1", { wait: 1800 });
  await shoot("studio", "/studio?mock=1", { wait: 1500 });
  await shoot("insights", "/insights?mock=1", { wait: 1800 });
  await shoot("team", "/team?mock=1", { wait: 1800 });
  await shoot("onboard-steps", "/onboard?mock=1&url=avsatelier.in&name=AVS%20Atelier&instagram=avs.atelier&country=India&go=1", { wait: 5200 });
  await shoot("onboard-done", "/onboard?mock=1&url=avsatelier.in&name=AVS%20Atelier&instagram=avs.atelier&country=India&go=1&speed=4", { wait: 9000 });
  // the same app on a phone
  await shoot("phone-office", `/office?mock=1&${SEED}&clock=11:00`, { vp: PHONE, mobile: true, wait: 3200 });
  await shoot("phone-approvals", "/approvals?mock=1", { vp: PHONE, mobile: true, wait: 1500 });
  await shoot("phone-plan", "/plan?mock=1", { vp: PHONE, mobile: true, wait: 1800 });
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
}
console.log("shots in", OUT);
