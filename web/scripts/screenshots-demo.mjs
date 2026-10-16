// Screenshots of the SYNTHETIC business (Shiftly, demo_growth) from a running server, for the README and docs/live-scenarios.md.
// Nothing here shows a real business: it reads only the tenant you name. Headless Playwright against the public read-only
// server loaded with the recorded copy (the hero answer replays from its stored work log):
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
  { tag: "desktop", width: 1440, height: 1000, dpr: 1, mobile: false },
  { tag: "mobile", width: 390, height: 844, dpr: 2, mobile: true },
];
const q = `tenant=${encodeURIComponent(tenant)}`;
const api = async (path) => (await fetch(`${base}/api/${tenant}${path}`)).json();
const sessions = await api("/sessions");
const hero = sessions.find((s) => /sign-?ups drop/i.test(s.title)) ?? sessions[0];

const SCENES = [
  { name: "office", path: `/?${q}`, wait: 1500 },
  // the answer on the Ask page, then "See the path": the chain lit node by node in the business's own graph
  ...(hero ? [{ name: "hero-answer", path: `/ask/${encodeURIComponent(hero.id)}?${q}`, wait: 2500 }] : []),
  ...(hero ? [{ name: "hero-path", path: `/ask/${encodeURIComponent(hero.id)}?${q}`, wait: 2500, click: /See the path/, after: 3500 }] : []),
  // "What breaks if something stops" on the broken screen: one step away against up to four steps away, each with its path
  { name: "brain", path: `/brain?${q}`, wait: 2000, run: async (page) => {
    const sel = page.locator("select").first();
    if (await sel.count()) { await sel.selectOption({ label: "Sign-up screen (phone number)" }).catch(() => undefined); await page.waitForTimeout(2500); }
    await page.getByRole("heading", { name: /What breaks if something stops/ }).first().evaluate((el) => { el.scrollIntoView({ block: "start" }); window.scrollBy(0, -70); }).catch(() => undefined);
    await page.waitForTimeout(500);
  } },
  { name: "insights", path: `/insights?${q}`, wait: 1500 },
  { name: "approvals", path: `/approvals?${q}`, wait: 1500 },
];

let browser;
try { browser = await chromium.launch({ channel: "chrome" }); } catch { browser = await chromium.launch(); }
for (const vp of VPS) {
  for (const s of SCENES) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.dpr, isMobile: vp.mobile, hasTouch: vp.mobile, colorScheme: "light" });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.error(`[${s.name}] pageerror:`, e.message));
    await page.goto(base + s.path, { waitUntil: "networkidle" });
    await page.waitForTimeout(s.wait);
    if (s.click) {
      const b = page.getByRole("button", { name: s.click }).first();
      if (await b.count()) { await b.click(); await page.waitForTimeout(s.after ?? 1000); }
    }
    if (s.run) await s.run(page);
    const file = `${out}/${s.name}-${vp.tag}.png`;
    await page.screenshot({ path: file });
    console.log("saved", file);
    await ctx.close();
  }
}
await browser.close();
