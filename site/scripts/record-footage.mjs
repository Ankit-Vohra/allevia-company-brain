// Real product footage for the website's scroll story: the working web app in its own demo mode (?mock=1: sample
// numbers, two sample businesses, the app says "Demo data" in its top bar), recorded frame by frame with the Chrome
// DevTools screencast and assembled with ffmpeg. Nothing here is drawn or generated; every frame is the app running.
//
// Serves web/dist itself with `vite preview` on port 4392 (FOOTAGE_PORT to change; never 8787) and never uses the shared
// browser pane. Build the app first:
//
//   (cd web && npm run build) && node site/scripts/record-footage.mjs [scene ...]
//
// Writes raw masters (CFR 30 fps, near-lossless) to site/scripts/.footage/ (not committed). scripts/encode-footage.sh then
// turns them into the scrub encodes in site/public/media/. Scenes: onboard, office, ask, approve (stills), plan (stills).
import { chromium } from "playwright";
import { preview } from "vite";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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

const browser = await chromium.launch();

/** Record `ms` of a page after `before` ran, into <name>.mp4 at 30 fps. */
async function record(name, path, device, { ms, before, during, settle = 600 }) {
  const ctx = await browser.newContext({ ...device, colorScheme: "dark", reducedMotion: "no-preference", locale: "en-US", timezoneId: "Asia/Kolkata" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error(`[${name}] pageerror:`, e.message));
  await page.goto(base + path, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  if (before) await before(page);
  await page.waitForTimeout(settle);

  const dir = join(OUT, `${name}-frames`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const cdp = await ctx.newCDPSession(page);
  const frames = [];
  cdp.on("Page.screencastFrame", async (f) => {
    const file = join(dir, `${String(frames.length).padStart(5, "0")}.jpg`);
    frames.push({ file, t: f.metadata.timestamp });
    writeFileSync(file, Buffer.from(f.data, "base64"));
    await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  const vp = device.viewport;
  const dpr = device.deviceScaleFactor;
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 94, maxWidth: Math.round(vp.width * dpr), maxHeight: Math.round(vp.height * dpr), everyNthFrame: 1 });
  const started = Date.now();
  if (during) await during(page);
  const left = ms - (Date.now() - started);
  if (left > 0) await page.waitForTimeout(left);
  await cdp.send("Page.stopScreencast");
  await page.waitForTimeout(200);
  await ctx.close();

  // a concat list with each frame's real duration, so the clip runs at the app's own pace
  const lines = [];
  for (let i = 0; i < frames.length; i++) {
    const d = i + 1 < frames.length ? frames[i + 1].t - frames[i].t : 1 / 30;
    lines.push(`file '${frames[i].file}'`, `duration ${Math.max(d, 1 / 120).toFixed(4)}`);
  }
  lines.push(`file '${frames[frames.length - 1].file}'`);
  const list = join(OUT, `${name}.txt`);
  writeFileSync(list, lines.join("\n"));
  const mp4 = join(OUT, `${name}.mp4`);
  execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list,
    "-vf", "fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p", "-c:v", "libx264", "-crf", "12", "-preset", "slow", "-an", mp4]);
  console.log(`${name}: ${frames.length} frames, ${((frames.at(-1).t - frames[0].t)).toFixed(1)} s -> ${mp4}`);
}

async function still(name, path, device, { wait = 1500, action } = {}) {
  const ctx = await browser.newContext({ ...device, colorScheme: "dark", reducedMotion: "no-preference", locale: "en-US", timezoneId: "Asia/Kolkata" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error(`[${name}] pageerror:`, e.message));
  await page.goto(base + path, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(wait);
  if (action) await action(page);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`${name}.png`);
  await ctx.close();
}

const SCENES = {
  // 1. Paste your website: onboarding reads a site and the picture of the business grows, step by step.
  async onboard() {
    const url = `/onboard?mock=1&theme=dark&url=avsatelier.in&name=${enc("AVS Atelier")}&instagram=avs.atelier&country=India&go=1`;
    await record("onboard", url, DESKTOP, { ms: 16000, settle: 200 });
    await record("onboard-phone", url, PHONE, { ms: 16000, settle: 200 });
  },
  // 2. Meet your team: the office at eleven in the morning, a question running, desks lighting, dogs carrying.
  async office() {
    const url = `/?mock=1&seed=11&clock=11:00&theme=dark&ask=${enc(Q_OFFICE)}`;
    await record("office", url, DESKTOP, { ms: 14000, settle: 900 });
    await record("office-phone", url, PHONE, { ms: 14000, settle: 900 });
  },
  // 3. Ask anything: the answer arriving in the Ask screen, then "See the path" lighting the steps behind it.
  async ask() {
    const url = `/ask?mock=1&theme=dark&ask=${enc(Q_ASK)}`;
    const during = async (page) => {
      await page.waitForFunction(() => /See the path/.test(document.body.innerText), null, { timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(1200);
      await page.getByText("See the path").first().click().catch(() => {});
    };
    await record("ask", url, DESKTOP, { ms: 34000, settle: 200, during });
  },
  async approve() {
    await still("approve-before", "/approvals?mock=1&theme=dark", DESKTOP);
    await still("approve-after", "/approvals?mock=1&theme=dark", DESKTOP, {
      action: async (page) => { await page.getByRole("button", { name: /^Approve/ }).first().click(); await page.waitForTimeout(1200); },
    });
    await still("approve-phone", "/approvals?mock=1&theme=dark", PHONE);
  },
  async plan() {
    await still("plan", "/plan?mock=1&theme=dark", DESKTOP, { wait: 2000 });
    await still("studio", "/studio?mock=1&theme=dark", DESKTOP, { wait: 2000 });
    await still("office-quiet", `/?mock=1&seed=11&clock=11:00&theme=dark`, DESKTOP, { wait: 3500 });
  },
};

try {
  const want = process.argv.slice(2);
  for (const [n, fn] of Object.entries(SCENES)) if (!want.length || want.includes(n)) await fn();
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
}
