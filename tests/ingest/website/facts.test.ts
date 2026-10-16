// Issue #24: day-one facts from a website. Structured data first (no model), the page text for the rest (a fake model
// whose every answer needs a verbatim quote), and the write: typed props with their page, the Google Maps listing not
// repeated, prices on the products extraction made, a price range read off the catalogue.
import { describe, it, expect } from "vitest";
import {
  factsWrite, hoursFromSpec, hoursFromStrings, readDayOneFacts, structuredFacts, textFacts, type DayOneFacts,
} from "../../../src/ingest/sources/website/facts.js";
import { pageDocId, type PageData } from "../../../src/ingest/sources/website/index.js";
import type { Ask, AskInput } from "../../../src/ingest/sources/website/ask.js";

const O = "https://cafe.example.com";
const page = (path: string, text: string, over: Partial<PageData> = {}): PageData => ({
  url: `${O}${path}`, finalUrl: `${O}${path}`, redirects: [], status: 200, fetchedAt: "2026-10-15T09:00:00.000Z", bytes: 1,
  title: path, titleCount: 1, metaDescriptionCount: 0, h1: [], h2: [], text, wordCount: text.split(/\s+/).length,
  internalLinks: [], externalLinks: [], images: [], jsonLd: [], jsonLdTypes: [], jsonLdErrors: 0, og: {}, timing: { responseMs: 1, fetchMs: 1 },
  mixedContent: [], ...over,
});

const LD = {
  "@context": "https://schema.org", "@type": "CafeOrCoffeeShop", name: "Cafe Example", priceRange: "££",
  address: { "@type": "PostalAddress", streetAddress: "23–25 Leather Lane", addressLocality: "London", postalCode: "EC1N 7TE", addressCountry: "GB" },
  openingHoursSpecification: [
    { dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], opens: "07:30", closes: "16:00" },
    { dayOfWeek: "https://schema.org/Saturday", opens: "08:00", closes: "16:00" },
  ],
  hasMenu: { "@type": "Menu", hasMenuSection: { hasMenuItem: [
    { "@type": "MenuItem", name: "Flat white", offers: { "@type": "Offer", price: "3.60", priceCurrency: "GBP" } },
    { "@type": "MenuItem", name: "Filter coffee", offers: { price: 3.2, priceCurrency: "GBP" } },
    { "@type": "MenuItem", name: "Banana bread", offers: { price: "4.00", priceCurrency: "GBP" } },
  ] } },
  // an event's place is not the business's address
  event: { "@type": "Event", name: "Cupping", location: { address: { streetAddress: "1 Somewhere Else", postalCode: "N1" } } },
};

class FakeAsk implements Ask {
  calls: AskInput[] = [];
  constructor(private readonly answer: unknown) {}
  async structured(i: AskInput): Promise<unknown> { this.calls.push(i); return this.answer; }
}

describe("structured data", () => {
  it("reads hours, the address, the price range and priced menu items from JSON-LD", () => {
    const f = structuredFacts([page("/", "Welcome.", { jsonLd: [LD] })]);
    expect(f.hours).toEqual({ value: ["Mon–Fri 07:30–16:00", "Sat 08:00–16:00"], doc: pageDocId(`${O}/`), via: "structured data" });
    expect(f.address).toMatchObject({ value: "23–25 Leather Lane, London, EC1N 7TE, GB", postalCode: "EC1N 7TE", via: "structured data" });
    expect(f.priceRange?.value).toBe("££");
    expect(f.items.map((i) => [i.name, i.price, i.currency])).toEqual([["Flat white", 3.6, "GBP"], ["Filter coffee", 3.2, "GBP"], ["Banana bread", 4, "GBP"]]);
  });
  it("spells openingHours strings and day runs one way, and takes no address from a city alone", () => {
    expect(hoursFromStrings(["Mo-Fr 08:00-17:00", "Sa 09:00-13:00"])).toEqual(["Mon–Fri 08:00–17:00", "Sat 09:00–13:00"]);
    expect(hoursFromSpec([{ dayOfWeek: ["Monday", "Wednesday"], opens: "9:00", closes: "17:00" }])).toEqual(["Mon, Wed 09:00–17:00"]);
    expect(structuredFacts([page("/", "x", { jsonLd: [{ "@type": "LocalBusiness", address: { addressLocality: "Bristol", addressCountry: "GB" } }] })]).address).toBeUndefined();
  });
});

describe("page text", () => {
  const visit = page("/visit", "Visit us. We are open Monday to Friday 8am to 5pm and Saturday 9am to 1pm. Flat white 3.60. Find us at 4 Mill Lane, Settle.", {
    footerText: "Cafe Example · 4 Mill Lane, Settle BD24 9AB · [redacted:phone]",
  });
  it("keeps only answers quoted from the pages, prices inside their quote", async () => {
    const ask = new FakeAsk({
      hours: [{ text: "Mon–Fri 8am–5pm", evidence: "open Monday to Friday 8am to 5pm" }, { text: "Sun 10–4", evidence: "Sunday 10 to 4" }],
      address: { text: "4 Mill Lane, Settle BD24 9AB", evidence: "4 Mill Lane, Settle BD24 9AB" },
      priceRange: { text: "£2–£9", evidence: "prices from two to nine pounds" },
      items: [
        { name: "Flat white", price: 3.6, currency: "gbp", evidence: "Flat white 3.60" },
        { name: "Scone", price: 2.5, currency: "GBP", evidence: "Scone 2.50" },          // not on the page
        { name: "Latte", price: 9, currency: "GBP", evidence: "Flat white 3.60" },       // the quote is not about it
      ],
    });
    const f = await textFacts(ask, [visit], "Cafe Example", { hours: true, address: true, priceRange: true, items: true });
    expect(f.hours).toMatchObject({ value: ["Mon–Fri 8am–5pm"], doc: pageDocId(`${O}/visit`), via: "page text" });
    expect(f.address).toMatchObject({ value: "4 Mill Lane, Settle BD24 9AB", via: "page text" }); // from the footer
    expect(f.priceRange).toBeUndefined();
    expect(f.items).toEqual([expect.objectContaining({ name: "Flat white", price: 3.6, currency: "GBP" })]);
    expect(ask.calls[0]!.data).toMatch(/\[footer\] Cafe Example/);
  });
  it("asks the model only for what structured data and the listing did not give, and not at all when nothing is missing", async () => {
    const ask = new FakeAsk({ hours: [], address: { text: "", evidence: "" }, priceRange: { text: "", evidence: "" }, items: [] });
    await readDayOneFacts([page("/", "Welcome.", { jsonLd: [LD] }), visit], { ask, business: "Cafe Example" });
    expect(ask.calls).toHaveLength(0);
    await readDayOneFacts([visit], { ask, business: "Cafe Example", listing: { hours: true, address: true } });
    expect(ask.calls).toHaveLength(1);
    expect(ask.calls[0]!.before).toMatch(/Wanted: price range, items with prices\.$/);
  });
});

describe("the write", () => {
  const doc = pageDocId(`${O}/`);
  const base: DayOneFacts = {
    hours: { value: ["Mon–Fri 07:30–16:00"], doc, via: "structured data" },
    address: { value: "23 Leather Lane, London", doc, via: "structured data" },
    items: [
      { name: "Flat white", price: 3.6, currency: "GBP", doc, via: "structured data" },
      { name: "Filter coffees", price: 3.2, currency: "GBP", doc, via: "structured data" },
      { name: "Banana bread", price: 4, currency: "GBP", doc, via: "structured data" },
    ],
  };
  const ctx = { businessId: "business:cafe", businessName: "Cafe Example", asOf: "2026-10-15T09:00:00.000Z", products: [{ id: "product:filter-coffee", name: "Filter coffee" }] };

  it("puts typed facts with their page on the business, a price on the product extraction made, new priced products, and a price range read off them", () => {
    const { write, written } = factsWrite(base, ctx);
    const biz = write.nodes.find((n) => n.id === "business:cafe")!;
    expect(biz.name).toBe("Cafe Example");
    expect(biz.props).toMatchObject({
      hours: ["Mon–Fri 07:30–16:00"], hoursSrc: doc, hoursVia: "structured data", address: "23 Leather Lane, London", addressSrc: doc,
      priceRange: "£3.20–£4", priceMin: 3.2, priceMax: 4, priceCurrency: "GBP", priceRangeBasis: "from 3 prices on the website", priceRangeSrc: doc,
    });
    expect(write.edges).toContainEqual(expect.objectContaining({ from: "business:cafe", type: "SOURCED_FROM", to: doc, props: { facts: ["hours", "address", "priceRange"] } }));
    expect(write.nodes.find((n) => n.id === "product:filter-coffee")!.props).toMatchObject({ price: 3.2, priceCurrency: "GBP", priceSrc: doc });
    expect(write.nodes.filter((n) => n.type === "Product" && n.props?.catalogue).map((n) => n.id)).toEqual(["product:flat-white", "product:banana-bread"]);
    expect(write.edges).toContainEqual(expect.objectContaining({ from: "product:flat-white", type: "PART_OF", to: "business:cafe" }));
    expect(written).toContain("price of Filter coffee");
  });
  it("does not repeat what the Google Maps listing already has", () => {
    const { write } = factsWrite(base, { ...ctx, listing: { hours: true, address: true } });
    const props = write.nodes.find((n) => n.id === "business:cafe")!.props!;
    expect(props.hours).toBeUndefined();
    expect(props.address).toBeUndefined();
    expect(props.priceRange).toBe("£3.20–£4");
  });
});
