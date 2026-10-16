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
import { execFileSync } from "node:child_process";
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

/** Real screens of the app on the sample business, cropped and written as small webp files in site/public/media. */
async function stills() {
  const media = resolve(HERE, "..", "public", "media");
  const tmp = join(OUT, "stills");
  mkdirSync(tmp, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "light", locale: "en-US", timezoneId: "Asia/Kolkata" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("pageerror:", e.message));
  const save = async (name, width, q = 84) => {
    const png = join(tmp, name + ".png");
    return { png, done: () => execFileSync("cwebp", ["-quiet", "-q", String(q), "-resize", String(width), "0", png, "-o", join(media, name + ".webp")]) };
  };
  // The tenant goes in the query, before any #hash, and every page is checked to be the sample business before anything is clicked:
  // a mistake here once opened the default business instead.
  const open = async (path) => {
    const [p, hash] = path.split("#");
    const url = `${base}${p}${p.includes("?") ? "&" : "?"}tenant=${TENANT}${hash ? "#" + hash : ""}`;
    await page.goto(url, { waitUntil: "load" });
    await page.waitForTimeout(2500);
    const who = await page.locator("header").first().innerText();
    if (!/Shiftly/.test(who)) throw new Error(`not the sample business on ${path}: ${who.slice(0, 80)}`);
  };
  const approvals = await api("/approvals");
  const find = (re) => approvals.find((a) => a.status === "pending" && re.test(a.title))?.id;
  const only = (process.env.ONLY ?? "").split(",").filter(Boolean);
  const want = (n) => !only.length || only.includes(n);
  const emailId = find(/Re: Weekend baristas/);
  const fixId = find(/Fix sign-up crash in PhoneInput/);
  const msgId = find(/Dussehra|(Message|Send) (to )?affected users/);
  const card = async (id, name, { details = false, width = 720 } = {}) => {
    await open(`/approvals#${id}`);
    if (details) { await page.getByRole("button", { name: /details/i }).first().click().catch(() => {}); await page.waitForTimeout(600); }
    const el = page.locator(".appr-card").first();
    const { png, done } = await save(name, width);
    await el.screenshot({ path: png });
    done();
    return el;
  };
  if (emailId && want("email")) await card(emailId, "shot-email-times", { details: true });
  if (fixId && want("fix")) await card(fixId, "shot-fix-card");
  if (msgId && want("ok")) {
    // the same region before and after one tap: the card, then the line that says nothing was posted
    const clip = { x: 420, y: 250, width: 600, height: 470 };
    await open(`/approvals#${msgId}`);
    { const { png, done } = await save("shot-ok-before", 720); await page.screenshot({ path: png, clip }); done(); }
    await page.getByRole("button", { name: /^Approve/ }).first().click();
    await page.waitForTimeout(3500);
    { const { png, done } = await save("shot-ok-after", 720); await page.screenshot({ path: png, clip }); done(); }
  }
  // the answer to the hero question, with a source on every claim
  const sessions = await api("/sessions");
  const hero = sessions.find((s) => /sign-ups drop/.test(s.title) && s.turns > 0 && s.id === (process.env.HERO_SESSION ?? s.id));
  if (hero && want("answer")) {
    await open(`/ask/${hero.id}`);
    const { png, done } = await save("shot-answer", 760);
    await page.screenshot({ path: png, clip: { x: 500, y: 120, width: 700, height: 720 } });
    done();
  }
  // the office with Sales at its desk, the brain, your tools
  if (want("office")) { await open("/?clock=11:00");
  { const { png, done } = await save("shot-office-sales", 1200, 82); await page.screenshot({ path: png, clip: { x: 32, y: 144, width: 1008, height: 432 } }); done(); } }
  if (want("brain")) { await open("/brain");
  { const { png, done } = await save("shot-brain", 1000); await page.screenshot({ path: png, clip: { x: 330, y: 80, width: 780, height: 700 } }); done(); } }
  if (want("tools")) { await open("/connections");
  { const { png, done } = await save("shot-tools", 900); await page.screenshot({ path: png, clip: { x: 360, y: 80, width: 720, height: 800 } }); done(); } }
  await ctx.close();
  rmSync(tmp, { recursive: true, force: true });
  console.log("stills written to", media);
}

const SCENES = {
  async run() { await run(); },
  async stills() { await stills(); },
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
