// Real footage of a real run: the web app on this machine, on the sample business demo_growth (Shiftly, made-up data),
// answering the hero question live on the Claude Code subscription (no API key, $0). Headless Chromium records the page in real
// time (Playwright's own video) while the run's events are read from the server as they arrive, each stamped with its time in
// the video, so the website's "request travels through the brain" scene is drawn from what the run actually did.
//
//   (cd web && npm run build)
//   PORT=4381 ALLEVIA_STANDUP=off ALLEVIA_CHECKUP_SCHEDULE=0 DISCORD_HUB_GUILD_ID= ... npx tsx src/server/main.ts   # your own server, never 8787, Discord off
//   node site/scripts/record-live.mjs hero       # the office while the question runs: hero.webm and timed-<turn>.json
//   node site/scripts/record-live.mjs events ID  # the stored events of an earlier turn
//
// Writes to site/scripts/.footage-live/ (not committed). encode-live.sh turns the masters into the site's media.
import { chromium } from "playwright";
import { mkdirSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const OUT = resolve(process.env.FOOTAGE_OUT ?? join(HERE, ".footage-live"));
mkdirSync(OUT, { recursive: true });
const port = Number(process.env.LIVE_PORT ?? 4381);
if (port === 8787) throw new Error("port 8787 is the real server; use your own");
const base = `http://localhost:${port}`;
const TENANT = process.env.LIVE_TENANT ?? "demo_growth";
const HERO_Q = process.env.LIVE_Q ?? "Why did sign-ups drop this week, and what should we do?";
const enc = encodeURIComponent;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();

async function api(path) {
  const r = await fetch(`${base}/api/${TENANT}${path}`);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

/** The real run, filmed. Polls the run's events while it goes so each one carries its time in the video. */
async function hero() {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: "light", locale: "en-US", timezoneId: "Asia/Kolkata",
    recordVideo: { dir: join(OUT, "video-tmp"), size: { width: 1440, height: 900 } },
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("pageerror:", e.message));
  const tPage = Date.now(); // the video starts when the page is made
  const at = () => Math.round(Date.now() - tPage) / 1000;
  await page.goto(`${base}/?tenant=${TENANT}&clock=11:00&ask=${enc(HERO_Q)}`, { waitUntil: "load" });
  const timed = [];
  let turnId = "";
  let seen = 0;
  let doneAt = 0;
  for (let i = 0; i < 1600; i++) {
    await sleep(300);
    if (!turnId) {
      const live = await api("/turns/live").catch(() => []);
      if (live.length) turnId = live[0].turnId;
      else continue;
    }
    const dto = await api(`/turns/${turnId}/events?after=${seen}`).catch(() => null);
    if (!dto) continue;
    for (const ev of dto.events) timed.push({ t: at(), ev });
    seen = dto.next;
    if (i % 50 === 0) await page.screenshot({ path: join(OUT, `hero-progress-${String(i / 50).padStart(2, "0")}.png`) });
    if (dto.done) { doneAt = at(); break; }
  }
  await sleep(6000); // the answer settles
  await page.screenshot({ path: join(OUT, "hero-end.png") });
  const total = at();
  const video = page.video();
  await ctx.close();
  renameSync(await video.path(), join(OUT, "hero.webm"));
  rmSync(join(OUT, "video-tmp"), { recursive: true, force: true });
  writeFileSync(join(OUT, `timed-${turnId}.json`), JSON.stringify({ turnId, doneAt, total, events: timed }));
  console.log(`hero: turn ${turnId}, ${timed.length} events, done at ${doneAt} s, ${total.toFixed(0)} s of video -> hero.webm`);
  return turnId;
}

async function saveEvents(turnId) {
  const events = [];
  let after = 0;
  for (let i = 0; i < 20; i++) {
    const page = await api(`/turns/${turnId}/events?after=${after}`);
    events.push(...page.events);
    after = page.next;
    if (page.done) break;
  }
  writeFileSync(join(OUT, `events-${turnId}.json`), JSON.stringify(events));
  console.log(`events: ${events.length} saved`);
}

/** Run one question live without filming it (the Sales reply, for its card). Returns the turn id. */
async function run() {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: "light", locale: "en-US", timezoneId: "Asia/Kolkata" });
  const page = await ctx.newPage();
  await page.goto(`${base}/?tenant=${TENANT}&clock=11:00&ask=${enc(HERO_Q)}`, { waitUntil: "load" });
  let turnId = "";
  for (let i = 0; i < 1500; i++) {
    await sleep(400);
    if (!turnId) { const live = await api("/turns/live").catch(() => []); if (live.length) turnId = live[0].turnId; else continue; }
    const dto = await api(`/turns/${turnId}/events?after=0`).catch(() => null);
    if (dto?.done) break;
  }
  await sleep(2500);
  await ctx.close();
  console.log("run done:", turnId);
  return turnId;
}

const SCENES = {
  async run() { await run(); },
  async hero() { await hero(); },
  async events() {
    const id = process.argv[3];
    if (!id) throw new Error("usage: record-live.mjs events <turnId>");
    await saveEvents(id);
  },
};

try {
  const want = process.argv[2];
  if (!want || !SCENES[want]) throw new Error(`scenes: ${Object.keys(SCENES).join(", ")}`);
  await SCENES[want]();
} finally {
  await browser.close();
}
