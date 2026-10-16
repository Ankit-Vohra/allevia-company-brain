// Usage (from site/): node proto/qa/interact.mjs
// Interaction checks on the built home and Product pages (installed Chrome, which plays H.264): the slider drag and keys, the clips playing
// when on screen, the OK demo cycle, the pinned steps changing, the flow cards lighting, and the growing brain buttons.
import { chromium } from "playwright";
const BASE = process.env.BASE ?? "http://127.0.0.1:8812";
const browser = await chromium.launch({ channel: "chrome", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
page.on("pageerror", (e) => errors.push(`pageerror ${String(e).slice(0, 200)}`));
const log = (k, v) => console.log(k.padEnd(34), v);
await page.goto(`${BASE}/a/`, { waitUntil: "load" });
await page.waitForTimeout(2500);

// slider
await page.evaluate(() => document.querySelector("[data-ba]").scrollIntoView({ block: "center" }));
await page.waitForTimeout(600);
const box = await page.locator("[data-ba] .ba__view").boundingBox();
const posOf = () => page.evaluate(() => getComputedStyle(document.querySelector("[data-ba]")).getPropertyValue("--pos").trim());
log("slider start --pos", await posOf());
await page.waitForTimeout(4800); // the one gentle sweep
log("slider after the sweep", await posOf());
await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.5, { steps: 8 });
log("slider dragged to 20%", await posOf());
await page.mouse.move(box.x + box.width * 0.85, box.y + box.height * 0.5, { steps: 8 });
await page.mouse.up();
log("slider dragged to 85%", await posOf());
await page.locator("[data-ba] .ba__range").focus();
await page.keyboard.press("ArrowLeft");
log("slider after ArrowLeft", await posOf());

// clips
const vids = await page.evaluate(async () => {
  const out = {};
  for (const sel of [".office__video", ".clip__video"]) {
    const v = document.querySelector(sel); v.scrollIntoView({ block: "center" });
    await new Promise((r) => setTimeout(r, 2200));
    const t0 = v.currentTime; await new Promise((r) => setTimeout(r, 800));
    out[sel] = { paused: v.paused, t0: +t0.toFixed(2), t1: +v.currentTime.toFixed(2), ready: v.readyState, w: v.videoWidth, h: v.videoHeight, err: v.error?.message ?? null };
  }
  return out;
});
for (const [k, v] of Object.entries(vids)) log(`clip ${k}`, JSON.stringify(v));

// the OK demo
await page.evaluate(() => document.querySelector("[data-ok]").scrollIntoView({ block: "center" }));
const states = [];
for (let i = 0; i < 8; i++) { await page.waitForTimeout(900); states.push(await page.evaluate(() => document.querySelector("[data-ok-stack]").className.replace("ok__stack", "").trim() || "before")); }
log("OK demo over 7 s", states.join(" > "));

// the flow
await page.evaluate(() => document.querySelector("[data-flow]").scrollIntoView({ block: "center" }));
const flow = [];
for (let i = 0; i < 6; i++) { await page.waitForTimeout(1500); flow.push(await page.evaluate(() => [...document.querySelectorAll(".fcard--in")].findIndex((c) => c.classList.contains("is-on")) + "/" + document.querySelectorAll(".fcard--out.is-lit").length)); }
log("flow lit (in/out count)", flow.join("  "));
log("console errors on /a/", errors.length ? errors.join(" | ") : "none");

// Product: steps and the growing brain
errors.length = 0;
await page.goto(`${BASE}/product/`, { waitUntil: "load" });
await page.waitForTimeout(2000);
const stepAt = async (p) => { await page.evaluate((pp) => { const el = document.querySelector("[data-steps]"); const r = el.getBoundingClientRect(); window.scrollTo(0, r.top + scrollY - 68 + pp * (r.height - innerHeight + 68)); }, p); await page.waitForTimeout(900); return page.evaluate(() => { const el = document.querySelector("[data-steps]"); const v = document.querySelector(".step__video"); return `${el.dataset.active} video ${v.paused ? "paused" : "playing"}`; }); };
log("steps at 5% / 45% / 85%", [await stepAt(0.05), await stepAt(0.45), await stepAt(0.85)].join("  |  "));
await page.evaluate(() => document.querySelector("#grow").scrollIntoView({ block: "center" }));
await page.waitForTimeout(800);
await page.locator("[data-grow-stage='2']").click();
await page.waitForTimeout(700);
log("grow: Year 1 pressed", await page.evaluate(() => document.querySelector("[data-grow-stage='2']").getAttribute("aria-pressed") + " caption " + document.querySelector("[data-grow-cap]").textContent));
await page.goto(`${BASE}/a/`, { waitUntil: "load" });
await page.waitForTimeout(800);
await page.locator("a[href='/product/#grow']").click();
await page.waitForTimeout(1500);
log("link 'keeps growing' lands on", await page.evaluate(() => location.pathname + location.hash + " grow top " + Math.round(document.querySelector("#grow").getBoundingClientRect().top)));
log("console errors on /product/", errors.length ? errors.join(" | ") : "none");
await browser.close();
