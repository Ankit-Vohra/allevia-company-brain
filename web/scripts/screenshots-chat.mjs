// Screenshots of the chat in sample mode (?mock=1) at 1440, 700 and 390 wide: the team chat (with and without "Watch the team
// talk"), a direct chat with an approval card, a new chat with starter chips, and the Customise drawer. Headless Playwright
// against a built app: npm run build && npx vite preview --port 4391 &  then  node scripts/screenshots-chat.mjs [baseUrl] [outDir]
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const base = process.argv[2] ?? "http://localhost:4391";
const out = resolve(process.argv[3] ?? "../docs/screenshots");
await mkdir(out, { recursive: true });
const VPS = [
  { tag: "1440", width: 1440, height: 900, dpr: 1, mobile: false },
  { tag: "700", width: 700, height: 900, dpr: 1, mobile: false },
  { tag: "390", width: 390, height: 844, dpr: 2, mobile: true },
];
const enc = encodeURIComponent;
const SCENES = [
  { name: "team", path: `/chat/team/${enc("s-aamdani-stories")}?mock=1`, how: true },
  { name: "team-talk", path: `/chat/team/${enc("s-aamdani-stories")}?mock=1`, talk: true },
  { name: "direct", path: `/chat/content-strategist/${enc("s-aamdani-tara-reels")}?mock=1`, how: true },
  { name: "new", path: "/chat/content-strategist?mock=1" },
  { name: "customise", path: `/chat/content-strategist/${enc("s-aamdani-tara-reels")}?mock=1&customise=1` },
  { name: "discord", path: `/chat/team/${enc("s-aamdani-discord")}?mock=1` },
];

let browser;
try { browser = await chromium.launch({ channel: "chrome" }); } catch { browser = await chromium.launch(); }
for (const vp of VPS) {
  for (const s of SCENES) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.dpr, isMobile: vp.mobile, hasTouch: vp.mobile, colorScheme: "light" });
    await ctx.addInitScript((talk) => { try { localStorage.setItem("allevia.chat.talk", talk ? "1" : "0"); } catch { /* */ } }, !!s.talk);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.error(`[${s.name}] pageerror:`, e.message));
    await page.goto(base + s.path, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    if (s.how) { const b = page.getByRole("button", { name: /How we got this/ }).first(); if (await b.count()) { await b.click(); await page.waitForTimeout(300); } }
    const file = `${out}/chat-${s.name}-${vp.tag}.png`;
    await page.screenshot({ path: file });
    console.log("saved", file);
    await ctx.close();
  }
}
await browser.close();
