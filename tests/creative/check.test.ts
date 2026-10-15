// Nisha: claims are grounded in the request and the graph before anything is drawn, and after drawing she reads the poster
// back with vision and compares it with the words that were set. A look that cannot run is "unchecked", never a pass.
import { describe, it, expect } from "vitest";
import { checkPosters, claimTokens, coverage, groundClaims, NISHA } from "../../src/creative/compose/check.js";
import type { PosterManifest } from "../../src/creative/compose/compose.js";
import { FakeVision } from "../../src/studio/vision.js";
import sharp from "sharp";

describe("groundClaims (before drawing)", () => {
  const grounds = { request: "I want a poster for the Diwali sale, 20% off on all interiors until 15 November", facts: ["AV's Atelier", "Raipur", "avsatelier.in", "@avs_atelier"] };
  it("passes words the owner gave and facts the business holds", () => {
    expect(groundClaims([{ role: "offer", text: "20% off" }, { role: "cta", text: "Visit avsatelier.in" }, { role: "detail", text: "Until 15 November" }, { role: "cta", text: "Follow @avs_atelier" }], grounds)).toEqual([]);
  });
  it("catches an invented number, price, date, address or promise", () => {
    const bad = groundClaims([
      { role: "offer", text: "30% off" }, { role: "headline", text: "Free design consultation" }, { role: "detail", text: "Call 98765 43210" },
      { role: "cta", text: "Book at evil.example" }, { role: "subline", text: "The best studio in Raipur" },
    ], grounds);
    const claims = bad.map((b) => b.claim);
    expect(claims).toEqual(expect.arrayContaining(["30%", "free", "98765", "evil.example", "best"]));
    expect(bad.find((b) => b.claim === "30%")!.role).toBe("offer");
  });
  it("reads claim tokens: numbers with their sign, addresses, handles", () => {
    expect(claimTokens("Save ₹1,499 at shop.example/sale or @shop_now, 20% off")).toEqual(expect.arrayContaining(["1499", "shop.example/sale", "@shop_now", "20%"]));
  });
  it("a request that says 'free' makes 'free' grounded", () => {
    expect(groundClaims([{ role: "offer", text: "Free delivery" }], { request: "poster: free delivery this week", facts: [] })).toEqual([]);
  });
});

describe("coverage", () => {
  it("counts the expected words found in what was read, in any order, and names the missing", () => {
    expect(coverage("A festival of light", "festival of light A").share).toBe(1);
    const c = coverage("A festival of light for your home", "A festvl of light for your home");
    expect(c.missing).toEqual(["festival"]);
    expect(c.share).toBeCloseTo(6 / 7);
  });
});

const manifest = (over: Partial<PosterManifest> = {}): PosterManifest => ({
  format: "insta_square", layout: "hero-bottom", width: 1080, height: 1080,
  texts: [
    { role: "headline", text: "Diwali sale", shown: "Diwali sale", box: { x: 0, y: 0, w: 1, h: 1 }, size: 90, font: "Fraunces", color: "#fff", lines: ["Diwali sale"] },
    { role: "offer", text: "20% off", shown: "20% off", box: { x: 0, y: 0, w: 1, h: 1 }, size: 90, font: "Fraunces", color: "#fff", lines: ["20% off"] },
  ],
  logo: { kind: "file", box: { x: 0, y: 0, w: 1, h: 1 }, plate: false, scale: 1, sourceW: 1000, soft: false }, artwork: true,
  colours: { paper: "#f4f1ea", dark: "#191714", accent: "#a8542e", light: "#f4f1ea", background: "#191714" }, fonts: { heading: "Fraunces", body: "Inter" }, problems: [], ...over,
});
const img = () => sharp({ create: { width: 100, height: 100, channels: 3, background: "#888" } }).jpeg().toBuffer();
const good = { label: "A", textRead: "Diwali sale 20% off", extraText: [], garbled: false, logoVisible: true, logoIntact: true, inventedClaims: [], note: "clean" };

describe("checkPosters (after drawing)", () => {
  const opts = { businessName: "Kestrel & Oak", hasLogoFile: true };
  it("passes a poster whose words match and whose logo is whole", async () => {
    const v = await checkPosters([{ label: "A", image: await img(), manifest: manifest() }], opts, { vision: new FakeVision({ [NISHA]: { posters: [good] } }) });
    expect(v[0]).toMatchObject({ label: "A", badge: "ok", reasons: [] });
  });
  it("holds a poster whose words changed, that has lettering nobody asked for, a garbled word, an invented claim, or a lost logo", async () => {
    const vision = new FakeVision({ [NISHA]: { posters: [
      { ...good, label: "A", textRead: "Diwali sal 20% off" , garbled: true },
      { ...good, label: "B", extraText: ["OPEN NOW", "K&O"] },
      { ...good, label: "C", inventedClaims: ["Free delivery"] },
      { ...good, label: "D", logoIntact: false },
    ] } });
    const o = await img();
    const v = await checkPosters(["A", "B", "C", "D"].map((label) => ({ label, image: o, manifest: manifest() })), opts, { vision });
    expect(v.map((x) => x.badge)).toEqual(["held", "held", "held", "held"]);
    expect(v[0]!.reasons.join(" ")).toMatch(/words changed or missing.*sale|garbled/);
    expect(v[1]!.reasons.join(" ")).toMatch(/extra lettering.*OPEN NOW/);
    expect(v[2]!.reasons.join(" ")).toMatch(/Free delivery/);
    expect(v[3]!.reasons.join(" ")).toMatch(/logo/);
  });
  it("does not count the business name or the logo's own letters as extra lettering", async () => {
    const v = await checkPosters([{ label: "A", image: await img(), manifest: manifest() }], opts, { vision: new FakeVision({ [NISHA]: { posters: [{ ...good, extraText: ["Kestrel & Oak"] }] } }) });
    expect(v[0]!.badge).toBe("ok");
  });
  it("counts the code's own findings: a line off the poster or a covered logo holds it, a soft logo does not", async () => {
    const o = await img();
    const vision = new FakeVision({ [NISHA]: { posters: [good, { ...good, label: "B" }] } });
    const v = await checkPosters([
      { label: "A", image: o, manifest: manifest({ problems: ["the headline overlaps the logo"] }) },
      { label: "B", image: o, manifest: manifest({ problems: ["the logo file is small for this size, so it may look soft"] }) },
    ], opts, { vision });
    expect(v.map((x) => x.badge)).toEqual(["held", "ok"]);
  });
  it("is 'unchecked' when the look cannot run, never a pass, and held when the code already found a problem", async () => {
    const o = await img();
    const v = await checkPosters([{ label: "A", image: o, manifest: manifest() }, { label: "B", image: o, manifest: manifest({ problems: ["the offer runs off the poster"] }) }], opts, { vision: new FakeVision({}) });
    expect(v[0]!.badge).toBe("unchecked");
    expect(v[0]!.note).toMatch(/Not double-checked/);
    expect(v[1]!.badge).toBe("held");
  });
  it("expects the business name when the poster has a wordmark instead of a logo file", async () => {
    const m = manifest({ logo: { kind: "wordmark", box: { x: 0, y: 0, w: 1, h: 1 }, plate: false, scale: 1, sourceW: 0, soft: false } });
    const vision = new FakeVision({ [NISHA]: { posters: [{ ...good, textRead: "Diwali sale 20% off" }] } });
    const v = await checkPosters([{ label: "A", image: await img(), manifest: m }], { businessName: "Kestrel & Oak", hasLogoFile: false }, { vision });
    expect(v[0]!.badge).toBe("held");
    expect(v[0]!.reasons.join(" ")).toMatch(/kestrel/);
    expect(vision.calls[0]!.prompt).toContain("Kestrel & Oak");
  });
});
