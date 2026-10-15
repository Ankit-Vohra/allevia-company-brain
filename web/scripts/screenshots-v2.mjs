// The v2 screenshots (owner-first redesign, open-plan office): every page in mock mode at 1440×900, 700×900 and 390×844,
// the office at five times of day (driven through the office clock's own slider), and a short video of the office with
// the dogs carrying documents. Usage: npm run build && npm run preview &  then
//   node scripts/screenshots-v2.mjs [baseUrl] [outDir]         (SHOTS=office,ask filters by name prefix; VIDEO=1 records the video)
import { chromium } from "playwright";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const base = process.argv[2] ?? "http://localhost:4173";
const out = resolve(process.argv[3] ?? "../docs/screenshots");
const only = (process.env.SHOTS ?? "").split(",").filter(Boolean);
await mkdir(out, { recursive: true });

const Q = "What should we post this week?";
const enc = encodeURIComponent;
const SEED = "seed=11"; // the office's idle life is seeded: the same people at the same places each run
const VPS = [
  { tag: "1440", width: 1440, height: 900, dpr: 1, mobile: false },
  { tag: "700", width: 700, height: 900, dpr: 1, mobile: false },
  { tag: "390", width: 390, height: 844, dpr: 2, mobile: true },
];

const want = (name) => !only.length || only.some((o) => name.startsWith(o));
const newCtx = (browser, vp, extra = {}) => browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.dpr, isMobile: vp.mobile, hasTouch: vp.mobile, colorScheme: "light", ...extra });
const open = async (ctx, path, wait = 1500) => {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error(`[${path}] pageerror:`, e.message));
  await page.goto(base + path, { waitUntil: "networkidle" });
  await page.waitForTimeout(wait);
  return page;
};
const save = async (page, name, opts = {}) => {
  const file = `${out}/v2-${name}.png`;
  await page.screenshot({ path: file, ...opts });
  console.log("saved", file);
};

/** Wait until a dog is carrying a document (or has just been given its treat), up to `ms`. */
const untilDog = (page, what, ms = 40000) =>
  page.waitForFunction((w) => {
    const l = window.__office?.life;
    if (!l) return false;
    return w === "carry" ? l.pets.some((p) => p.carrying) : l.fx.some((f) => f.kind === "treat");
  }, what, { timeout: ms }).then(() => true, () => false);

let browser;
try { browser = await chromium.launch({ channel: "chrome" }); } catch { browser = await chromium.launch(); }

for (const vp of VPS) {
  const ctx = await newCtx(browser, vp);
  // the office, idle: coffee, ping-pong, a sleepy desk, the dogs and cats
  if (want("office-idle")) { const p = await open(ctx, `/?mock=1&${SEED}&clock=11:00`, 3200); await save(p, `office-idle-${vp.tag}`, { fullPage: vp.mobile }); await p.close(); }
  // mid-request: a dog running a document from one desk to the next
  if (want("office-midrun")) {
    const p = await open(ctx, `/?mock=1&${SEED}&clock=11:00&debug=1&ask=${enc(Q)}&seek=3500`, 600);
    await untilDog(p, "carry");
    await p.waitForTimeout(250);
    await save(p, `office-midrun-${vp.tag}`, { fullPage: vp.mobile });
    await p.close();
  }
  // the treat: the receiver hops, the dog gets a biscuit
  if (want("office-treat")) {
    const p = await open(ctx, `/?mock=1&${SEED}&clock=11:00&debug=1&ask=${enc(Q)}&seek=3500`, 600);
    await untilDog(p, "treat");
    await p.waitForTimeout(400);
    await save(p, `office-treat-${vp.tag}`, { fullPage: vp.mobile });
    await p.close();
  }
  // Ask: the quiet default, then everything open
  if (want("ask")) {
    const p = await open(ctx, "/ask/s-aamdani-stories?mock=1", 3000);
    await p.evaluate(() => { const el = document.querySelector(".ask-scroll"); if (el && el.scrollHeight > el.clientHeight) el.scrollTop = el.scrollHeight; else window.scrollTo(0, document.body.scrollHeight); });
    await p.waitForTimeout(400);
    await save(p, `ask-default-${vp.tag}`);
    await p.getByText("Show how the team worked").first().click();
    await p.waitForTimeout(700);
    await p.getByText("See the path").first().click();
    await p.waitForTimeout(2600);
    await save(p, `ask-expanded-${vp.tag}`);
    await p.close();
  }
  for (const [name, path, wait] of [
    ["insights", "/insights?mock=1", 1800],
    ["approvals", "/approvals?mock=1", 1500],
    ["brain", "/brain?mock=1", 2500],
    ["team", "/team?mock=1", 1800],
    ["onboard-steps", "/onboard?mock=1&url=avsatelier.in&name=AVS%20Atelier&instagram=avs.atelier&country=India&go=1", 5200],
    ["onboard", "/onboard?mock=1&url=avsatelier.in&name=AVS%20Atelier&instagram=avs.atelier&country=India&go=1&speed=4", 9000],
  ]) {
    if (!want(name)) continue;
    const p = await open(ctx, path, wait);
    await save(p, `${name}-${vp.tag}`, { fullPage: vp.mobile });
    await p.close();
  }
  await ctx.close();
}

// the office through the day, by dragging the clock chip's slider
if (want("office-0") || want("office-1") || want("office-2") || want("office-time")) {
  const ctx = await newCtx(browser, VPS[0]);
  const p = await open(ctx, `/?mock=1&${SEED}`, 2500);
  for (const [hh, mins] of [["09", 9 * 60], ["13", 13 * 60], ["17", 17 * 60 + 30], ["19", 19 * 60 + 30], ["22", 22 * 60]]) {
    await p.locator(".clock-chip").click();
    await p.locator(".clock-range").fill(String(mins));
    await p.keyboard.press("Escape");
    await p.waitForTimeout(1500);
    await save(p, `office-${hh}`);
  }
  await ctx.close();
}

// a short video: the office mid-request, dogs delivering
if (process.env.VIDEO) {
  const tmp = `${out}/.video-tmp`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  const ctx = await newCtx(browser, { width: 1280, height: 720, dpr: 1, mobile: false }, { recordVideo: { dir: tmp, size: { width: 1280, height: 720 } } });
  const p = await open(ctx, `/?mock=1&${SEED}&clock=11:00&ask=${enc(Q)}&speed=1`, 500);
  await p.waitForTimeout(26000);
  await ctx.close();
  const [webm] = (await readdir(tmp)).filter((f) => f.endsWith(".webm"));
  await rename(`${tmp}/${webm}`, `${tmp}/raw.webm`);
  execFileSync("ffmpeg", ["-y", "-i", `${tmp}/raw.webm`, "-vf", "fps=24,scale=1280:-2", "-c:v", "libx264", "-preset", "slow", "-crf", "29", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", `${out}/office-life.mp4`], { stdio: "inherit" });
  await rm(tmp, { recursive: true, force: true });
  console.log("saved", `${out}/office-life.mp4`);
}
await browser.close();
