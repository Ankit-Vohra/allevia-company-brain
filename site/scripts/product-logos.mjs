// The tool logos the home page shows: cropped from the app's own Your tools screen (src: web/src/components/ConnectionsPanel.tsx),
// where each tool already appears with its logo. Nothing is fetched by the site itself; the page ships small local files.
//
//   node site/scripts/product-logos.mjs      (your own server on LIVE_PORT, default 4381, never 8787)
//
// Writes site/public/img/tool-<id>.webp at 96 px (cwebp), for the tools named in WANT.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const OUT = resolve(HERE, "..", "public", "img");
const TMP = resolve(HERE, ".footage-live", "logos");
mkdirSync(OUT, { recursive: true });
mkdirSync(TMP, { recursive: true });
const port = Number(process.env.LIVE_PORT ?? 4381);
if (port === 8787) throw new Error("port 8787 is the real server; use your own");

// app name on the Your tools screen -> file id
const WANT = {
  Gmail: "gmail", "Google Calendar": "calendar", "Google Analytics": "analytics",
  "Meta Ads": "meta-ads", Instagram: "instagram", Shopify: "shopify", Stripe: "stripe",
  HubSpot: "hubspot", Slack: "slack", "WhatsApp Business": "whatsapp",
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1000, height: 1200 }, deviceScaleFactor: 4, colorScheme: "light" });
const page = await ctx.newPage();
await page.goto(`http://localhost:${port}/connections?tenant=demo_growth`, { waitUntil: "load" });
await page.waitForSelector(".cx-logo img", { timeout: 20000 });
await page.waitForTimeout(2500);
// open "More" lists when the app folds them
for (const b of await page.getByRole("button", { name: /more|show all/i }).all()) await b.click().catch(() => {});
await page.waitForTimeout(1500);

const got = [];
for (const [name, id] of Object.entries(WANT)) {
  const card = page.locator("article, li, section, div").filter({ has: page.locator(`text="${name}"`) }).filter({ has: page.locator(".cx-logo img") }).last();
  const logo = card.locator(".cx-logo").first();
  if (!(await logo.count())) { console.log("not found:", name); continue; }
  await logo.scrollIntoViewIfNeeded().catch(() => {});
  const png = join(TMP, `${id}.png`);
  await logo.screenshot({ path: png, omitBackground: true });
  execFileSync("cwebp", ["-quiet", "-q", "92", "-resize", "96", "96", png, "-o", join(OUT, `tool-${id}.webp`)]);
  got.push(id);
}
console.log("logos:", got.join(", "));
await browser.close();
rmSync(TMP, { recursive: true, force: true });
