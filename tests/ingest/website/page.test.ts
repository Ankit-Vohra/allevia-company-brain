// What the crawler keeps of a page is privacy-filtered at the source: the studio's own email and phone (and anyone's on
// a contact page) become [redacted:<kind>] before the text becomes a Page, Document or Chunk or reaches a model. The
// profile links stay: a social profile is a Channel, not personal data.
import { describe, it, expect } from "vitest";
import { MAX_TEXT_CHARS, countWords, fromCapture, redactPage, type Captured, type PageData } from "../../../src/ingest/sources/website/page.js";
import { findSocials, jsonLdAddress, pageRawDoc } from "../../../src/ingest/sources/website/understand.js";
import { pageWrite } from "../../../src/ingest/sources/website/index.js";

const ORIGIN = "https://www.example-studio.test";
const EMAIL = "hello@example-studio.test";
const PHONE = "+91 98765 43210";
const IG = "https://www.instagram.com/avs_atelier/";
const LI = "https://www.linkedin.com/company/avs-atelier/";

const LD = {
  "@context": "https://schema.org", "@type": "LocalBusiness", name: "Example Studio", email: EMAIL, telephone: PHONE,
  address: { "@type": "PostalAddress", streetAddress: `12 Park Road, write ${EMAIL}`, addressLocality: "Raipur", addressCountry: "IN" },
  sameAs: [IG, LI],
};

const captured = (over: Partial<Captured> = {}): Captured => ({
  title: `Contact us | ${EMAIL}`, titleCount: 1,
  metaDescription: `Call ${PHONE} or write to ${EMAIL}.`, metaDescriptionCount: 1,
  canonical: `${ORIGIN}/contact`, robotsMeta: null,
  h1: [`Write to ${EMAIL}`], h2: [`Call us on ${PHONE}`, "Visit the studio"],
  links: [IG, LI, "/about", `${ORIGIN}/projects`, `mailto:${EMAIL}`, "tel:+919876543210"],
  images: [], jsonLd: [JSON.stringify(LD)],
  og: { "og:title": `Example Studio, ${EMAIL}`, "og:description": `Call ${PHONE}`, "og:image": `${ORIGIN}/img/cover.jpg` },
  lang: "en", viewport: "width=device-width", mixed: [], favicon: null, logo: null,
  text: `Visit us at 12 Park Road.\n\nEmail ${EMAIL} or call ${PHONE}.\n\nFollow us on Instagram @avs_atelier.`,
  ...over,
});

// A page as an older or injected crawler would hand it over: nothing filtered.
const rawPage = (over: Partial<PageData> = {}): PageData => ({
  url: `${ORIGIN}/contact`, finalUrl: `${ORIGIN}/contact`, redirects: [], status: 200, fetchedAt: "2026-10-15T09:00:00.000Z", bytes: 1234,
  title: `Contact us | ${EMAIL}`, titleCount: 1, metaDescription: `Call ${PHONE} or write to ${EMAIL}.`, metaDescriptionCount: 1,
  h1: [`Write to ${EMAIL}`], h2: [`Call us on ${PHONE}`],
  text: `Email ${EMAIL} or call ${PHONE}. We reply within a day. `.repeat(8), wordCount: 140,
  internalLinks: [`${ORIGIN}/about`], externalLinks: [IG, LI], images: [], jsonLd: [LD], jsonLdTypes: ["LocalBusiness", "PostalAddress"], jsonLdErrors: 0,
  og: { "og:title": `Example Studio, ${EMAIL}`, "og:image": `${ORIGIN}/img/cover.jpg` },
  timing: { responseMs: 80, fetchMs: 120 }, mixedContent: [], ...over,
});

const noPersonalData = (s: string | undefined) => {
  expect(s ?? "").not.toMatch(/hello@|98765|43210/);
};

describe("fromCapture redacts what a page says", () => {
  const p: PageData = { ...rawPage(), ...fromCapture(captured(), ORIGIN) };

  it("redacts the main text, title, meta description, headings and Open Graph text", () => {
    expect(p.text).toContain("[redacted:email]");
    expect(p.text).toContain("[redacted:phone]");
    expect(p.text).toContain("Visit us at 12 Park Road.");
    for (const s of [p.text, p.title, p.metaDescription, ...p.h1, ...p.h2, p.og["og:title"], p.og["og:description"]]) noPersonalData(s);
    expect(p.title).toBe("Contact us | [redacted:email]");
    expect(p.metaDescription).toBe("Call [redacted:phone] or write to [redacted:email].");
    expect(p.h2).toEqual(["Call us on [redacted:phone]", "Visit the studio"]);
  });

  it("redacts every string in the JSON-LD blocks but keeps types, the address and the sameAs profile links", () => {
    const blob = JSON.stringify(p.jsonLd);
    noPersonalData(blob.replace(/https:\/\/www\.(?:instagram|linkedin)\.com[^"]*/g, ""));
    expect(p.jsonLd[0]).toMatchObject({ email: "[redacted:email]", telephone: "[redacted:phone]", sameAs: [IG, LI] });
    expect(p.jsonLdTypes).toEqual(["LocalBusiness", "PostalAddress"]);
    expect(jsonLdAddress([p])).toEqual({ city: "Raipur", country: "IN" });
  });

  it("measures the real page: the word count is of the text before redaction, and links, numbers and URLs are untouched", () => {
    const c = captured();
    expect(p.wordCount).toBe(countWords(c.text));
    expect(p.og["og:image"]).toBe(`${ORIGIN}/img/cover.jpg`);
    expect(p.canonical).toBe(`${ORIGIN}/contact`);
    expect(p.externalLinks).toEqual([IG, LI]);
    expect(p.internalLinks).toEqual([`${ORIGIN}/about`, `${ORIGIN}/projects`]);
  });

  it("keeps the social profile links: the Channels are found with their handles", () => {
    expect(findSocials([p]).map((s) => [s.platform, s.handle, s.url])).toEqual([
      ["instagram", "avs_atelier", IG],
      ["linkedin", "avs-atelier", LI],
    ]);
  });

  it("redacts before it cuts: an address straddling the text limit leaves no fragment", () => {
    // the address starts 20 characters before the limit and is 25 long: cut first and 20 characters of it would stay
    const lead = "Plain words about the studio. ".repeat(Math.ceil(MAX_TEXT_CHARS / 30)).slice(0, MAX_TEXT_CHARS - 20 - " write to ".length);
    const cut = fromCapture(captured({ text: `${lead} write to ${EMAIL} today` }), ORIGIN);
    expect(cut.text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
    expect(cut.text).toContain("[redacted:email]");
    expect(cut.text).not.toMatch(/@|example-studio|hello/);
  });
});

describe("redactPage (the boundary for any crawler)", () => {
  it("redacts text, title, meta description, headings, Open Graph text, JSON-LD strings and the error line", () => {
    const p = redactPage(rawPage({ error: `could not parse ${EMAIL}` }));
    for (const s of [p.text, p.title, p.metaDescription, ...p.h1, ...p.h2, p.og["og:title"], p.error]) noPersonalData(s);
    expect(p.jsonLd[0]).toMatchObject({ email: "[redacted:email]", telephone: "[redacted:phone]", sameAs: [IG, LI] });
    expect(p.text).toContain("[redacted:email]");
  });

  it("changes nothing else, does not touch its input, and is idempotent", () => {
    const raw = rawPage();
    const before = JSON.stringify(raw);
    const once = redactPage(raw);
    expect(JSON.stringify(raw)).toBe(before);
    expect(redactPage(once)).toEqual(once);
    const { text: _t, title: _ti, metaDescription: _m, h1: _h1, h2: _h2, og: _og, jsonLd: _j, ...rest } = once;
    const { text: _t0, title: _ti0, metaDescription: _m0, h1: _h10, h2: _h20, og: _og0, jsonLd: _j0, ...rest0 } = raw;
    expect(rest).toEqual(rest0);
    expect(once.wordCount).toBe(140);
    expect(once.og["og:image"]).toBe(`${ORIGIN}/img/cover.jpg`);
  });

  it("leaves a clean page exactly as it was", () => {
    const clean = rawPage({ title: "About the studio", metaDescription: "An architecture studio in Raipur.", h1: ["About"], h2: [], text: "We design homes.", jsonLd: [], og: {} });
    expect(redactPage(clean)).toEqual(clean);
  });
});

describe("what the graph and the model get from a redacted page", () => {
  const p = redactPage(rawPage());

  it("the Page, Document and Chunk nodes carry placeholders, not the contact details", () => {
    const w = pageWrite(p);
    const strings = w.nodes.flatMap((n) => [n.name, n.summary, ...Object.values(n.props ?? {}).flatMap((v) => (Array.isArray(v) ? v : [v]))]).filter((v): v is string => typeof v === "string");
    expect(strings.length).toBeGreaterThan(10);
    for (const s of strings) noPersonalData(s);
    expect(w.nodes.filter((n) => n.type === "Chunk").some((n) => String(n.props?.text).includes("[redacted:email]"))).toBe(true);
  });

  it("the extraction document does too", () => {
    const d = pageRawDoc(p);
    noPersonalData(d.text);
    noPersonalData(d.title);
    expect(d.text).toContain("Page description: Call [redacted:phone] or write to [redacted:email].");
  });
});
