// Content trials: drives the real Studio page in headless Chromium (Playwright) against a local server, never the shared
// browser pane. Usage: node scripts/trials/studio-ui.mjs <baseUrl> <photosDir> <outDir> <case...>
// Cases: p2 (upload, approve variant B with an owner edit), p3 (reshoot), f2 (a child), x1 (a damaged file), p1 (the changed variant B)
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
const require = createRequire(new URL("../../web/package.json", import.meta.url));
const { chromium } = require("playwright");

const [base, photos, out, ...cases] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const NOTES = {
  p1: "The Penthouse, Civil Lines: the main bedroom. Taken on my phone after handover.",
  p2: "Our studio office, the director's desk. Quick snap on my phone this evening.",
  p3: "Naman Holidays office wall, took it quickly on my phone.",
  f2: "Anantam Villa kids room, my phone.",
  x1: "failure test",
};
const FILES = { p1: "p1-good.jpg", p2: "p2-rough.jpg", p3: "p3-bad.jpg", f2: "f2-face-child.jpg", x1: "x1-corrupt.jpg" };

const browser = await chromium.launch();
try {
  for (const c of cases) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.goto(`${base}/studio?tenant=avs_atelier`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    const fresh = page.getByRole("button", { name: /New photo/ });
    if (await fresh.count()) await fresh.first().click();
    await page.locator("input[type=file]").setInputFiles(join(photos, FILES[c]));
    await page.locator(".drop-note textarea").fill(NOTES[c]);
    await page.getByRole("button", { name: "Send to Tara" }).click();
    // wait for the run to end: a card, a stop, or an error
    await page.waitForFunction(() => document.querySelector(".approve") || document.querySelector(".studio-error") || /can't save|can't use|Nothing was made|Nothing was kept/i.test(document.body.innerText) || document.querySelector(".verdict-reshoot"), null, { timeout: 240_000 });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: join(out, `content-${c}-result.png`), fullPage: true });
    if (c === "p2" || c === "p1") {
      const b = page.locator("label.variant", { hasText: "B" }).first();
      console.log(c, "variant B held back?", await b.evaluate((el) => el.classList.contains("is-held")));
    }
    if (c === "p2") {
      const ta = page.locator(".caption-field textarea");
      const before = await ta.inputValue();
      await page.locator("label.variant", { hasText: "Generative edit" }).first().click();
      await ta.fill(before.replace("small tree", "bonsai").replace("A desk where the day begins slowly.", "The desk where our day begins."));
      await page.screenshot({ path: join(out, `content-${c}-edit.png`), fullPage: true });
      await page.getByRole("button", { name: /^Approve variant/ }).click();
      await page.waitForSelector(".approved", { timeout: 60_000 });
      await page.waitForTimeout(800);
      await page.screenshot({ path: join(out, `content-${c}-approved.png`), fullPage: true });
      console.log("approved:", (await page.locator(".approved").innerText()).replace(/\s+/g, " "));
    }
    console.log(c, "body:", (await page.locator(".studio-page").innerText()).replace(/\s+/g, " ").slice(0, 700));
    await ctx.close();
  }
} finally {
  await browser.close();
}
