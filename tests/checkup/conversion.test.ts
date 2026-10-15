import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import {
  CONVERSION_SCRIPT, guessKind, headlineSaysWhat, judgePage, judgeSite, redactCapture, type ConversionCapture, type PageConversion,
} from "../../src/checkup/conversion.js";

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); });

async function capture(html: string, mobile: boolean): Promise<ConversionCapture> {
  const ctx = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  await page.setContent(html);
  const c = (await page.evaluate(CONVERSION_SCRIPT)) as ConversionCapture;
  await ctx.close();
  return redactCapture(c);
}

const GOOD = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;font:16px sans-serif">
<header><a href="/">Shree Interiors</a> <a href="https://wa.me/919876543210" style="display:inline-block;padding:14px">WhatsApp us</a></header>
<h1>Home interiors in Raipur, designed and built in 90 days</h1>
<p>Over 120 homes delivered.</p>
<div style="height:2000px"></div>
<section class="testimonials"><h2>What our clients say</h2><p>"Lovely work" - 4.9 out of 5 from 87 Google reviews</p></section>
<p>Open Monday to Saturday, 10am to 7pm. 2nd Floor, VIP Road, Raipur 492001</p>
<a href="tel:+919876543210" style="display:inline-block;padding:14px">Call +91 98765 43210</a>
</body></html>`;

const POOR = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0">
<h1>Welcome to Shree Interiors</h1>
<img src="data:," style="width:100%;height:1200px">
<nav>${Array.from({ length: 8 }, (_, i) => `<a href="/p${i}" style="font-size:9px;display:inline-block">p${i}</a>`).join(" ")}</nav>
<a href="/contact" style="display:inline-block;padding:12px">Contact us</a>
</body></html>`;

describe("the conversion capture", () => {
  it("finds the WhatsApp button on the first screen and the call button below it, without keeping the number", async () => {
    const c = await capture(GOOD, true);
    const wa = c.ctas.find((x) => x.kind === "whatsapp")!;
    expect(wa.aboveFold).toBe(true);
    const call = c.ctas.find((x) => x.kind === "call")!;
    expect(call.aboveFold).toBe(false);
    expect(JSON.stringify(c)).not.toContain("98765");
    expect(c.proof.rating).toBe(true);
    expect(c.proof.testimonials).toBe(true);
    expect(c.hours.found).toBe(true);
    expect(c.location.address).toBe(true);
    expect(c.firstHeading).toMatch(/Home interiors in Raipur/);
  });

  it("sees a greeting headline, no first-screen contact and small tap targets", async () => {
    const m = await capture(POOR, true);
    const d = await capture(POOR, false);
    const page: PageConversion = { url: "https://shree.example/", mobile: m, desktop: d };
    const f = judgePage(page, { home: true, businessName: "Shree Interiors" });
    const by = Object.fromEntries(f.map((x) => [x.check, x]));
    expect(by["contact-above-fold-mobile"]!.pass).toBe(false);
    expect(by["contact-above-fold-mobile"]!.evidence).toMatch(/screens down/);
    expect(by["clear-offer"]!.pass).toBe(false);
    expect(by["clear-offer"]!.evidence).toContain("Welcome to Shree Interiors");
    expect(by["tap-targets"]!.pass).toBe(false);
  });

  it("judges the whole site for proof, hours and location", async () => {
    const good = { url: "https://shree.example/", mobile: await capture(GOOD, true) };
    const poor = { url: "https://bare.example/", mobile: await capture(POOR, true) };
    const s = { kind: "local" as const, jsonLdTypes: [], jsonLdHasHours: false, jsonLdHasAddress: false, jsonLdHasRating: false, contactPageFound: false };
    expect(judgeSite([good], good.url, s).every((x) => x.pass)).toBe(true);
    const bad = Object.fromEntries(judgeSite([poor], poor.url, s).map((x) => [x.check, x]));
    expect(bad.proof!.pass).toBe(false);
    expect(bad["opening-hours"]!.pass).toBe(false);
    expect(bad.location!.pass).toBe(false);
    expect(bad["contact-path"]!.pass).toBe(true); // "Contact us" is an enquiry path
    // an online business is not asked for opening hours
    expect(judgeSite([poor], poor.url, { ...s, kind: "online" }).map((x) => x.check)).not.toContain("opening-hours");
  });
});

describe("headlines and kinds", () => {
  it("tells a promise from a greeting or a bare name", () => {
    expect(headlineSaysWhat("Welcome to AVS Atelier", "AVS Atelier")).toBe(false);
    expect(headlineSaysWhat("AVS Atelier", "AVS Atelier")).toBe(false);
    expect(headlineSaysWhat(null)).toBe(false);
    expect(headlineSaysWhat("Interiors for homes and offices in Raipur", "AVS Atelier")).toBe(true);
  });
  it("calls a business local when its structured data says so", () => {
    expect(guessKind([], ["Organization", "HomeAndConstructionBusiness"])).toBe("local");
  });
});
