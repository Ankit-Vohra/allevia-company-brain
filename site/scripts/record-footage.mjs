// Real product footage for the website's scroll story: the working web app in its own demo mode (?mock=1: sample
// numbers, two sample businesses, the app says "Demo data" in its top bar), filmed frame by frame and assembled with
// ffmpeg. Nothing here is drawn or generated; every frame is the app running.
//
// How it films: Playwright's fake clock is installed before the app loads, then for each frame the clock is moved on by
// 1/30 s and a full-resolution screenshot is taken. Timers, Date and requestAnimationFrame all follow that clock, so the
// office, the onboarding and the answer run at their own pace and every frame is sharp at the device pixel ratio (the
// DevTools screencast only gives CSS-pixel frames in headless mode).
//
// Serves web/dist itself with `vite preview` on port 4392 (FOOTAGE_PORT to change; never 8787) and never uses the shared
// browser pane. Build the app first:
//
//   (cd web && npm run build) && node site/scripts/record-footage.mjs [scene ...]
//
// Writes masters (30 fps, near-lossless) and stills to site/scripts/.footage/ (not committed); encode-footage.sh turns
// them into the website's media in site/public/media/. Scenes: onboard, office, ask, stills.
import { chromium } from "playwright";
import { preview } from "vite";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const WEB = resolve(HERE, "..", "..", "web");
const OUT = resolve(process.env.FOOTAGE_OUT ?? join(HERE, ".footage"));
mkdirSync(OUT, { recursive: true });

const port = Number(process.env.FOOTAGE_PORT ?? 4392);
if (port === 8787) throw new Error("port 8787 is reserved for the real server");
const server = await preview({ root: WEB, preview: { port, strictPort: true, open: false } });
const base = `http://localhost:${port}`;
const enc = encodeURIComponent;

const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 };
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const Q_OFFICE = "What should we post this week?";
const Q_ASK = "Why did we pause daily stories, and what should we post instead?";
// 11:00 in Raipur on a Thursday; the app's own ?clock= sets the office light, this sets every date the app prints
const START = new Date("2026-10-15T11:00:00+05:30");
const FPS = 30;

const browser = await chromium.launch();

async function open(device, path) {
  const ctx = await browser.newContext({ ...device, colorScheme: "light", reducedMotion: "no-preference", locale: "en-US", timezoneId: "Asia/Kolkata" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error(`pageerror (${path}):`, e.message));
  await page.clock.install({ time: START });
  await page.goto(base + path, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  return { ctx, page };
}

/**
 * Film `seconds` of a page into <name>.mp4. `lead` seconds run first without filming (the app settles); `clip` is an
 * optional {x, y, width, height} in CSS pixels; `onFrame(page, t)` may act on the page at film time t (seconds).
 */
async function film(name, path, device, { seconds, lead = 0.6, clip, onFrame }) {
  const { ctx, page } = await open(device, path);
  await settle(page, lead);
  const dir = join(OUT, `${name}-frames`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const n = Math.round(seconds * FPS);
  for (let i = 0; i < n; i++) {
    if (onFrame) await onFrame(page, i / FPS);
    await page.screenshot({ path: join(dir, `${String(i).padStart(5, "0")}.png`), clip, animations: "allow", caret: "initial" });
    await page.clock.runFor(Math.round(1000 / FPS));
  }
  await ctx.close();
  const mp4 = join(OUT, `${name}.mp4`);
  execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-framerate", String(FPS), "-i", join(dir, "%05d.png"),
    "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p", "-c:v", "libx264", "-crf", "10", "-preset", "slow", "-an", mp4]);
  rmSync(dir, { recursive: true, force: true });
  console.log(`${name}: ${n} frames -> ${mp4}`);
}

async function still(name, path, device, { wait = 1.5, action, clip } = {}) {
  const { ctx, page } = await open(device, path);
  await settle(page, wait);
  if (action) { await action(page); await settle(page, 1.2); }
  await page.screenshot({ path: join(OUT, `${name}.png`), clip });
  console.log(`${name}.png`);
  await ctx.close();
}

/** Move the fake clock on in small steps, letting real network and module loads land in between. */
async function settle(page, seconds) {
  for (let i = 0; i < Math.round(seconds * 10); i++) { await page.clock.runFor(100); await page.waitForTimeout(25); }
}

/** Click the first element with this text once it is on the page (the fake clock runs between frames). */
function clickWhenThere(text, after = 0) {
  let done = false;
  let seenAt = -1;
  return async (page, t) => {
    if (done) return;
    const there = await page.getByText(text, { exact: false }).first().isVisible().catch(() => false);
    if (!there) return;
    if (seenAt < 0) seenAt = t;
    if (t - seenAt >= after) { done = true; await page.getByText(text).first().click().catch(() => {}); }
  };
}

const SCENES = {
  // Paste your website: onboarding reads a site, and the picture of the business grows step by step.
  async onboard() {
    const url = `/onboard?mock=1&url=avsatelier.in&name=${enc("AVS Atelier")}&instagram=avs.atelier&country=India&go=1`;
    await film("onboard", url, DESKTOP, { seconds: 15, lead: 0.2 });
    await film("onboard-phone", url, PHONE, { seconds: 13, lead: 0.2 });
  },
  // The office at eleven in the morning with a question running: desks light, bubbles open, dogs carry documents.
  async office() {
    const url = `/office?mock=1&seed=11&clock=11:00&ask=${enc(Q_OFFICE)}`;
    await film("office", url, DESKTOP, { seconds: 14, lead: 0.9 });
    await film("office-phone", url, PHONE, { seconds: 12, lead: 0.9 });
  },
  // One request all the way: the team's steps, the answer arriving with its sources, then "See the path".
  async ask() {
    const url = `/ask?mock=1&ask=${enc(Q_ASK)}`;
    await film("ask", url, DESKTOP, { seconds: 40, lead: 0.2, onFrame: clickWhenThere("See the path", 1.2) });
  },
  async stills() {
    await still("approve-before", "/approvals?mock=1", DESKTOP);
    await still("approve-after", "/approvals?mock=1", DESKTOP, {
      action: async (page) => { await page.getByRole("button", { name: /^Approve/ }).first().click(); },
    });
    await still("approve-phone", "/approvals?mock=1", PHONE);
    await still("plan", "/plan?mock=1", DESKTOP, { wait: 2 });
    await still("home-quiet", `/office?mock=1&seed=11&clock=11:00`, DESKTOP, { wait: 3.5 });
    await still("insights", "/insights?mock=1", DESKTOP, { wait: 2 });
    await still("studio", "/studio?mock=1", DESKTOP, { wait: 2 });
  },
};

try {
  const want = process.argv.slice(2);
  for (const [n, fn] of Object.entries(SCENES)) if (!want.length || want.includes(n)) await fn();
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
}
