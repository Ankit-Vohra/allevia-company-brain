// Study-only screenshots of other people's product sites, for docs/research/website-motion.md (issue #37).
// Headless Chromium through the repo's own Playwright (never the shared browser pane). Screenshots go to
// ~/allevia-research/sites/ (outside the repo: third-party pictures, never copied into Allevia). Per site: the first
// screen, then three scrolled screens, plus a small JSON of what the page is made of (fonts, colours, canvas/video/svg
// counts, motion libraries by script name). Nothing is copied: we read how it works.
//
//   node scripts/study-sites.mjs [slug ...]
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const OUT = join(homedir(), "allevia-research", "sites");
mkdirSync(OUT, { recursive: true });

const SITES = {
  linear: "https://linear.app",
  vercel: "https://vercel.com",
  stripe: "https://stripe.com",
  raycast: "https://www.raycast.com",
  attio: "https://attio.com",
  arc: "https://arc.net",
  framer: "https://www.framer.com",
  cursor: "https://cursor.com",
  resend: "https://resend.com",
  obsidian: "https://obsidian.md",
  family: "https://family.co",
};

const only = process.argv.slice(2);
const picks = Object.entries(SITES).filter(([k]) => only.length === 0 || only.includes(k));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ headless: true });
const report = {};
for (const [slug, url] of picks) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, reducedMotion: "no-preference" });
  const page = await ctx.newPage();
  const scripts = new Set();
  page.on("request", (r) => { if (r.resourceType() === "script") scripts.add(r.url().split("?")[0].split("/").pop()); });
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await sleep(3500);
    // dismiss obvious cookie banners by declining nothing: we only look, so just ignore them
    await page.screenshot({ path: join(OUT, `${slug}-hero.jpg`), type: "jpeg", quality: 72 });
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let i = 1; i <= 3; i++) {
      await page.evaluate((y) => window.scrollTo({ top: y, behavior: "instant" }), Math.min(height - 900, i * 1100));
      await sleep(1600);
      await page.screenshot({ path: join(OUT, `${slug}-s${i}.jpg`), type: "jpeg", quality: 70 });
    }
    const facts = await page.evaluate(() => {
      const cs = (el, p) => (el ? getComputedStyle(el)[p] : null);
      const h1 = document.querySelector("h1");
      const body = document.body;
      const libs = [];
      for (const k of ["gsap", "Lenis", "THREE", "lottie", "Rive", "framerMotion", "__framer__"]) if (k in window) libs.push(k);
      return {
        title: document.title,
        h1: h1 ? h1.innerText.slice(0, 120) : null,
        h1Font: cs(h1, "fontFamily"), h1Size: cs(h1, "fontSize"), h1Weight: cs(h1, "fontWeight"), h1Color: cs(h1, "color"),
        bodyFont: cs(body, "fontFamily"), bodyBg: cs(body, "backgroundColor"), bodyColor: cs(body, "color"),
        canvas: document.querySelectorAll("canvas").length, video: document.querySelectorAll("video").length,
        svg: document.querySelectorAll("svg").length, scrollHeight: document.documentElement.scrollHeight, libs,
        smoothScrollClass: /lenis|locomotive/.test(document.documentElement.className),
      };
    });
    report[slug] = { url, ...facts, scripts: [...scripts].filter((s) => /gsap|lenis|three|motion|lottie|rive|scroll|framer/i.test(s)).slice(0, 12) };
    console.log("ok", slug, facts.title);
  } catch (e) {
    report[slug] = { url, error: String(e).slice(0, 200) };
    console.log("fail", slug, String(e).slice(0, 120));
  }
  await ctx.close();
}
await browser.close();
writeFileSync(join(OUT, "facts.json"), JSON.stringify(report, null, 2));
