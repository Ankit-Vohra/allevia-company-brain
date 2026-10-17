// The coffee demo's private layer: SAMPLE NUMBERS, written on top of a real business's public graph (its website, Google
// listing, public Instagram and ads, read by onboarding). Everything here is marked `simulated: true` (the UI says "sample
// numbers") and every number comes from coffee-model.ts. Nothing here is the business's real orders, revenue, analytics, ad
// spend, error log or inbox, and no real person says anything: staff are roles ("Web lead (sample role)"), customers in the
// sample inbox are made-up names at .example addresses, wholesale accounts are made-up businesses.
//
// What it links into the real graph:
//   - orders by product MEASURE the products the crawl found on the website (a small fixed list of sample products when it
//     found none), and the online store DEPENDS_ON the website channel;
//   - the sample Instagram reach MEASURES the real Instagram channel; the sample ad campaigns sit on the Meta and Google
//     Ads channels;
//   - the sample connections (Shopify, Gmail, Google Calendar) are Systems the business OWNS, which PRODUCED the sample exports
//     every number is SOURCED_FROM.
//
// The hero chain ("Why did online orders drop this week?"), each step an edge:
//   release (Event) -AFFECTS{introduced}-> UPI timeout error (Event) -AFFECTS{breaks}-> UPI payments (Feature)
//   <-DEPENDS_ON- order placed (funnel step) -DEPENDS_ON-> online store (Channel), whose daily orders fall about 18%;
//   the Meta campaign for the new roast DEPENDS_ON the payment page and kept spending; a customer's complaint MENTIONS the error.
//   Red herring: Instagram reach (sample) dipped nine days before the release; orders held that week.
// Deterministic for a given `now`; no network, no model. Seeded by `npm run cli -- seed-sample <tenant> --profile coffee`.
import type { GraphHandle } from "../../graph/client.js";
import { ensureIndexes } from "../../graph/indexes.js";
import { writeBatch } from "../../graph/batch.js";
import { SEARCHABLE, type EntityType, type RelType } from "../../graph/schema.js";
import type { EdgeInput, NodeInput, ObservationInput, Prim } from "../../graph/validate.js";
import { ensureActor, ensureAgentNode, findBusinessId } from "../../actions/shared.js";
import { logMessage, openDeal, recordEnquiry } from "../../sales/graph.js";
import { addDays } from "../../insights/text.js";
import { entityId } from "../../util/ids.js";
import { fakeEmbed } from "../embed.js";
import {
  CAMPAIGNS, CITIES, WHOLESALE_ACCOUNTS, adDay, coffeeTimeline, heroNumbers, oldIssueDay, productShares, reachDay, storeDay, upiIssueDay, weekTotals,
  type CoffeeTimeline,
} from "./coffee-model.js";
import { COFFEE_INBOX, sampleAt } from "./coffee-inbox.js";

// ---------- ids the tests, the connections and the docs name ----------

export const SAMPLE_IDS = {
  shopifyExport: "document:sample-shopify-export",
  errorLog: "document:sample-error-log",
  releaseNotes: "document:sample-release-notes-checkout-4-12",
  analytics: "document:sample-analytics-export",
  adsExport: "document:sample-ads-export",
  instagramInsights: "document:sample-instagram-insights",
  wholesaleLedger: "document:sample-wholesale-ledger",
  complaint: "document:sample-email-upi-complaint",
  shopify: "system:shopify",
  gmail: "system:gmail",
  calendar: "system:google-calendar",
  gateway: "system:sample-payment-gateway",
  onlineStore: "channel:online-store",
  subscriptions: "channel:subscriptions",
  quickCommerce: "channel:quick-commerce",
  wholesale: "channel:wholesale",
  metaAds: "channel:meta-ads",
  googleAds: "channel:google-ads",
  website: "channel:website",
  instagram: "channel:instagram",
  paymentPage: "page:sample-checkout-payment",
  upi: "feature:checkout-upi-payments",
  cards: "feature:checkout-card-payments",
  release: "event:sample-release-checkout-4-12",
  previousRelease: "event:sample-release-checkout-4-11",
  upiIssue: "event:sample-error-upi-timeout",
  oldIssue: "event:sample-error-product-image",
  newRoast: "product:sample-new-roast",
  heroCampaign: "campaign:meta-new-roast-launch",
} as const;

export const FUNNEL_STEPS: ReadonlyArray<{ id: string; key: string; name: string }> = [
  { id: "feature:checkout-cart-viewed", key: "cart_viewed", name: "Cart viewed" },
  { id: "feature:checkout-started", key: "checkout_started", name: "Checkout started" },
  { id: "feature:checkout-payment-attempted", key: "payment_attempted", name: "Payment attempted" },
  { id: "feature:checkout-order-placed", key: "order_placed", name: "Order placed" },
];

// Roles, never names: no real employee is invented.
export const SAMPLE_ROLES: ReadonlyArray<{ id: string; name: string; role: string; summary: string }> = [
  { id: "person:sample-role-web-lead", name: "Web lead (sample role)", role: "web lead", summary: "Looks after the online store and its checkout. A role in the sample data, not a real person." },
  { id: "person:sample-role-performance-marketing", name: "Performance marketing lead (sample role)", role: "performance marketing", summary: "Runs the paid ads. A role in the sample data, not a real person." },
  { id: "person:sample-role-wholesale", name: "Wholesale lead (sample role)", role: "wholesale", summary: "Looks after café and office accounts. A role in the sample data, not a real person." },
  { id: "person:sample-role-cafe-manager-indiranagar", name: "Café manager, Indiranagar (sample role)", role: "café manager", summary: "Runs a café. A role in the sample data, not a real person." },
];

// Used when the crawl found no products: plain, clearly sample, priced as sample.
export const FALLBACK_PRODUCTS: ReadonlyArray<{ key: string; name: string; price: number }> = [
  { key: "house-espresso-blend", name: "House espresso blend, 250 g (sample product)", price: 650 },
  { key: "single-estate-medium-roast", name: "Single-estate medium roast, 250 g (sample product)", price: 720 },
  { key: "dark-roast", name: "Dark roast, 500 g (sample product)", price: 990 },
  { key: "cold-brew-bags", name: "Cold brew bags, pack of 10 (sample product)", price: 499 },
  { key: "drip-bags", name: "Drip coffee bags, pack of 10 (sample product)", price: 449 },
  { key: "pour-over-kit", name: "Pour-over starter kit (sample product)", price: 2_490 },
];
const MAX_PRODUCTS = 8;

export interface ProductPick { id: string; name: string; price: number | null; crawled: boolean }
const NEW_ROAST: ProductPick = { id: SAMPLE_IDS.newRoast, name: "The new roast (sample product)", price: 840, crawled: false };

export interface CoffeeSeedOptions {
  tenant: string;
  now?: number;
  weeks?: number;
  embed?: (text: string) => number[];
  log?: (line: string) => void;
}

export interface CoffeeSeedResult {
  timeline: CoffeeTimeline;
  businessId: string;
  products: ProductPick[];
  nodes: number;
  edges: number;
  observations: number;
  sample: string[];          // every node id this seed wrote as sample (simulated: true)
  hero: ReturnType<typeof heroNumbers>;
  sales: { leads: string[]; complaint: string };
}

interface N { type: EntityType; id: string; name: string; summary?: string; props?: Record<string, Prim>; src?: string; asOf?: string }
interface E { from: string; type: RelType; to: string; props?: Record<string, Prim>; src?: string; asOf?: string; conf?: number }

const SRC_WORDS = "Sample numbers for the demo, not the business's real data.";

/** The crawled products to hang orders on (priced ones first), else none. A product merged or retired by the tidy pass is skipped. */
export async function crawledProducts(g: GraphHandle): Promise<ProductPick[]> {
  const rows = await g.roQuery<{ id: string; name: string | null; price: number | null; merged: string | null; retired: boolean | null }>(
    `MATCH (p:Product)-[s:SOURCED_FROM]->(d:Document) WHERE s.until IS NULL AND d.kind = 'webpage'
     RETURN DISTINCT p.id AS id, p.name AS name, p.price AS price, p.mergedInto AS merged, p.retired AS retired ORDER BY id LIMIT 300`);
  return rows
    .filter((r) => r.name && !r.merged && r.retired !== true && !r.id.startsWith("product:sample-") && !/\(sample/i.test(r.name))
    .map((r) => ({ id: r.id, name: r.name!, price: typeof r.price === "number" && Number.isFinite(r.price) && r.price > 0 ? r.price : null, crawled: true }))
    .sort((a, b) => Number(b.price !== null) - Number(a.price !== null) || a.id.localeCompare(b.id))
    .slice(0, MAX_PRODUCTS - 1);
}

export async function seedCoffeeSample(g: GraphHandle, o: CoffeeSeedOptions): Promise<CoffeeSeedResult> {
  await ensureIndexes(g);
  const now = o.now ?? Date.now();
  const t = coffeeTimeline(now, o.weeks ?? 8);
  const embed = o.embed ?? fakeEmbed;
  const log = o.log ?? (() => undefined);
  const biz = await findBusinessId(g, o.tenant);
  if (!biz) throw new Error(`"${o.tenant}" has no business in its graph yet: onboard it first (npm run cli -- onboard <url>)`);
  const [b] = await g.roQuery<{ domain: string | null; name: string | null }>("MATCH (b:Entity:Business {id:$id}) RETURN b.domain AS domain, b.name AS name", { id: biz });
  const domain = (b?.domain ?? "").replace(/^www\./, "") || "the website";

  const nodes: NodeInput[] = [];
  const edges: EdgeInput[] = [];
  const observations: ObservationInput[] = [];
  const sample = new Set<string>();
  // nodes that already exist (a real channel from onboarding) are linked to, never re-flagged as sample
  const candidates = [SAMPLE_IDS.website, SAMPLE_IDS.instagram, SAMPLE_IDS.metaAds, SAMPLE_IDS.googleAds, SAMPLE_IDS.shopify, SAMPLE_IDS.gmail, SAMPLE_IDS.calendar];
  const present = new Set((await g.roQuery<{ id: string }>("UNWIND $ids AS id MATCH (n:Entity {id:id}) RETURN n.id AS id", { ids: candidates })).map((r) => r.id));

  const node = (n: N, o2: { sample?: boolean } = {}): void => {
    const isSample = o2.sample !== false;
    const text = n.type === "Chunk" ? String(n.props?.text ?? "") : `${n.name} ${n.summary ?? ""}`;
    nodes.push({ ...n, ...(isSample ? { simulated: true } : {}), ...(n.type === "Chunk" || SEARCHABLE.includes(n.type) ? { embedding: embed(text) } : {}) });
    if (isSample) sample.add(n.id);
  };
  const edge = (e: E): void => { edges.push({ ...e, ...(e.asOf ? {} : { asOf: t.lastDay }) }); };
  const obs = (o3: Omit<ObservationInput, "simulated" | "asOf"> & { asOf?: string }): void => {
    observations.push({ ...o3, asOf: o3.asOf ?? o3.windowEnd ?? t.lastDay, simulated: true });
  };
  const daily = (subject: string, metric: string, unit: string, src: string, from: string, value: (day: string) => number): void => {
    for (const day of t.days) if (day >= from) obs({ subject, metric, value: value(day), unit, windowStart: day, windowEnd: day, asOf: day, src });
  };

  // the products orders are about: the crawl's own when it found any, else a fixed sample list; plus the sample new roast
  let products: ProductPick[] = await crawledProducts(g);
  if (!products.length) products = FALLBACK_PRODUCTS.map((p) => ({ id: entityId("Product", `sample ${p.key}`), name: p.name, price: p.price, crawled: false }));
  const sold: ProductPick[] = [...products, NEW_ROAST];

  // ---------- the sample sources: each a Document a sample connection PRODUCED ----------
  const docs: Array<[string, string, string]> = [
    [SAMPLE_IDS.shopifyExport, "Shopify store export (sample numbers)", "Orders, checkouts, payments and refunds from the online store, as sample numbers."],
    [SAMPLE_IDS.errorLog, "Checkout error log (sample)", "Errors the online store's checkout reported, as sample data."],
    [SAMPLE_IDS.releaseNotes, "Release notes: checkout 4.12 (sample)", "What changed in the checkout on the day of the release, as sample data."],
    [SAMPLE_IDS.analytics, "Website analytics export (sample numbers)", "Visits to the website, as sample numbers."],
    [SAMPLE_IDS.adsExport, "Ad accounts export (sample numbers)", "Spend, clicks and purchases of the paid campaigns, as sample numbers."],
    [SAMPLE_IDS.instagramInsights, "Instagram insights export (sample numbers)", "Reach and visits from Instagram, as sample numbers. The public follower and post numbers are real and come from the public profile."],
    [SAMPLE_IDS.wholesaleLedger, "Wholesale accounts (sample)", "Café and office accounts and what each buys, as sample data. The accounts are made up."],
  ];
  for (const [id, name, summary] of docs) {
    // the store export also keeps when the seed ran and its products: the sample Shopify connection answers from the same week
    const anchor: Record<string, Prim> = id === SAMPLE_IDS.shopifyExport ? { anchorNow: now, weeks: o.weeks ?? 8, releaseDay: t.releaseDay, lastDay: t.lastDay, products: JSON.stringify(sold.map((p) => ({ id: p.id, name: p.name, price: p.price }))) } : {};
    node({ type: "Document", id, name, summary: `${summary} ${SRC_WORDS}`, props: { kind: "snapshot", sample: true, provider: "sample", title: name, ...anchor }, asOf: t.lastDay });
  }
  const shopifyDocs = [SAMPLE_IDS.shopifyExport, SAMPLE_IDS.errorLog, SAMPLE_IDS.releaseNotes, SAMPLE_IDS.wholesaleLedger];
  node({ type: "Chunk", id: "chunk:sample-release-notes-checkout-4-12:0", name: "Release notes: checkout 4.12 (sample) §0", props: {
    text: `Checkout 4.12 (sample release notes), out to everyone on ${t.releaseDay}: the payment step moves to a new one-page layout, and UPI payments now wait on that page for the payment app to answer. Card and net banking payments are unchanged.`, ord: 0,
  } });
  edge({ from: SAMPLE_IDS.releaseNotes, type: "HAS_CHUNK", to: "chunk:sample-release-notes-checkout-4-12:0", src: SAMPLE_IDS.releaseNotes });

  // ---------- the sample connections: Systems the business owns ----------
  const system = (id: string, name: string, connector: string, produced: string[]): void => {
    if (!present.has(id)) {
      node({ type: "System", id, name, summary: `${name}: sample data for the demo, not a real account.`, props: { kind: "connector", provider: "sample", connector, status: "ok", sample: true }, src: id === SAMPLE_IDS.shopify ? SAMPLE_IDS.shopifyExport : undefined, asOf: t.lastDay });
    }
    edge({ from: biz, type: "OWNS", to: id, src: produced[0] ?? SAMPLE_IDS.shopifyExport });
    for (const d of produced) edge({ from: id, type: "PRODUCED", to: d, src: d });
  };
  system(SAMPLE_IDS.shopify, "Shopify (sample store data)", "shopify", [...shopifyDocs, SAMPLE_IDS.analytics]);
  system(SAMPLE_IDS.gmail, "Gmail (sample inbox)", "gmail", []); // it PRODUCED the complaint, written with the inbox below
  system(SAMPLE_IDS.calendar, "Google Calendar (sample calendar)", "google-calendar", []);
  node({ type: "System", id: SAMPLE_IDS.gateway, name: "Payment gateway (sample)", summary: "Takes UPI, card and net banking payments at checkout. Sample data.", props: { kind: "payments", sample: true }, src: SAMPLE_IDS.shopifyExport, asOf: t.lastDay });
  edge({ from: SAMPLE_IDS.shopify, type: "DEPENDS_ON", to: SAMPLE_IDS.gateway, src: SAMPLE_IDS.shopifyExport });
  // the ads and Instagram exports are produced by the ad and Instagram connections in a real setup; here the sample store data stands in
  edge({ from: SAMPLE_IDS.shopify, type: "PRODUCED", to: SAMPLE_IDS.adsExport, src: SAMPLE_IDS.adsExport });
  edge({ from: SAMPLE_IDS.shopify, type: "PRODUCED", to: SAMPLE_IDS.instagramInsights, src: SAMPLE_IDS.instagramInsights });

  // ---------- where the business sells ----------
  if (!present.has(SAMPLE_IDS.website)) node({ type: "Channel", id: SAMPLE_IDS.website, name: "Website", props: { platform: "website" } }, { sample: false });
  if (!present.has(SAMPLE_IDS.instagram)) node({ type: "Channel", id: SAMPLE_IDS.instagram, name: "Instagram", props: { platform: "instagram" } }, { sample: false });
  const channels: Array<[string, string, string]> = [
    [SAMPLE_IDS.onlineStore, `Online store (${domain})`, "Orders placed on the website's shop. Its numbers here are sample numbers."],
    [SAMPLE_IDS.subscriptions, "Coffee subscriptions (sample)", "Repeat deliveries on a schedule. A sample sales channel."],
    [SAMPLE_IDS.quickCommerce, "Quick-commerce apps (sample)", "Orders through grocery delivery apps. A sample sales channel."],
    [SAMPLE_IDS.wholesale, "Wholesale: cafés and offices (sample)", "Beans sold by the kilo to cafés and offices. A sample sales channel."],
  ];
  for (const [id, name, summary] of channels) {
    node({ type: "Channel", id, name, summary, props: { kind: "sales_channel", status: "active", sample: true }, src: SAMPLE_IDS.shopifyExport, asOf: t.lastDay });
    edge({ from: id, type: "PART_OF", to: biz, src: SAMPLE_IDS.shopifyExport });
    edge({ from: id, type: "DEPENDS_ON", to: SAMPLE_IDS.shopify, src: SAMPLE_IDS.shopifyExport });
  }
  edge({ from: SAMPLE_IDS.onlineStore, type: "DEPENDS_ON", to: SAMPLE_IDS.website, src: SAMPLE_IDS.shopifyExport });
  edge({ from: SAMPLE_IDS.subscriptions, type: "DEPENDS_ON", to: SAMPLE_IDS.onlineStore, src: SAMPLE_IDS.shopifyExport });
  for (const [id, name, platform] of [[SAMPLE_IDS.metaAds, "Meta Ads", "meta"], [SAMPLE_IDS.googleAds, "Google Ads", "google"]] as const) {
    if (!present.has(id)) node({ type: "Channel", id, name, summary: `${name}: its campaigns and numbers here are sample data.`, props: { platform, status: "sample", dataSimulated: true }, src: SAMPLE_IDS.adsExport, asOf: t.lastDay });
    edge({ from: id, type: "PART_OF", to: biz, src: SAMPLE_IDS.adsExport });
  }

  // ---------- the checkout: its payment page, payment methods and steps ----------
  node({ type: "Page", id: SAMPLE_IDS.paymentPage, name: "Checkout: payment step (sample)", summary: "The page where the shopper pays. Sample data: the real checkout's numbers are private.", props: { kind: "checkout_step", path: "/checkouts/payment", sample: true }, src: SAMPLE_IDS.shopifyExport, asOf: t.lastDay });
  edge({ from: SAMPLE_IDS.paymentPage, type: "PART_OF", to: SAMPLE_IDS.onlineStore, src: SAMPLE_IDS.shopifyExport });
  for (const [id, name, share] of [[SAMPLE_IDS.upi, "UPI payments at checkout (sample)", 62], [SAMPLE_IDS.cards, "Card payments at checkout (sample)", 30]] as const) {
    node({ type: "Feature", id, name, summary: `About ${share}% of payment attempts on the online store. Sample numbers.`, props: { kind: "payment_method", sample: true }, src: SAMPLE_IDS.shopifyExport, asOf: t.lastDay });
    edge({ from: id, type: "DEPENDS_ON", to: SAMPLE_IDS.gateway, src: SAMPLE_IDS.shopifyExport });
    edge({ from: id, type: "DEPENDS_ON", to: SAMPLE_IDS.paymentPage, src: SAMPLE_IDS.shopifyExport });
  }
  FUNNEL_STEPS.forEach((s, i) => {
    node({ type: "Feature", id: s.id, name: `Online store checkout: ${s.name} (sample)`, summary: `Step ${i + 1} of the online store's checkout. Sample numbers.`, props: { kind: "funnel_step", step: s.key, order: i + 1, sample: true }, src: SAMPLE_IDS.shopifyExport, asOf: t.lastDay });
    edge({ from: s.id, type: "DEPENDS_ON", to: i === 0 ? SAMPLE_IDS.onlineStore : FUNNEL_STEPS[i - 1]!.id, src: SAMPLE_IDS.shopifyExport });
  });
  const placed = FUNNEL_STEPS[3]!.id, attempted = FUNNEL_STEPS[2]!.id;
  edge({ from: attempted, type: "DEPENDS_ON", to: SAMPLE_IDS.paymentPage, src: SAMPLE_IDS.shopifyExport });
  edge({ from: placed, type: "DEPENDS_ON", to: SAMPLE_IDS.upi, src: SAMPLE_IDS.shopifyExport });
  edge({ from: placed, type: "DEPENDS_ON", to: SAMPLE_IDS.cards, src: SAMPLE_IDS.shopifyExport });
  edge({ from: placed, type: "DEPENDS_ON", to: SAMPLE_IDS.onlineStore, src: SAMPLE_IDS.shopifyExport });

  // ---------- the release, the error it brought, and an old unrelated one ----------
  const release = (id: string, version: string, day: string, notes: string, src: string): void => {
    node({ type: "Event", id, name: `Checkout release ${version} (sample)`, summary: notes, props: { kind: "release", release: `checkout@${version}`, platform: "web", releasedAt: day, sample: true }, src, asOf: day });
    edge({ from: id, type: "AFFECTS", to: SAMPLE_IDS.onlineStore, src, asOf: day });
  };
  release(SAMPLE_IDS.previousRelease, "4.11", addDays(t.releaseDay, -14), "Routine fixes to the cart. Sample data.", SAMPLE_IDS.shopifyExport);
  release(SAMPLE_IDS.release, "4.12", t.releaseDay, "A new one-page payment step; UPI payments now wait on the page for the payment app. Sample data.", SAMPLE_IDS.releaseNotes);
  edge({ from: SAMPLE_IDS.release, type: "AFFECTS", to: SAMPLE_IDS.paymentPage, props: { how: "changed" }, src: SAMPLE_IDS.releaseNotes, asOf: t.releaseDay });
  edge({ from: SAMPLE_IDS.release, type: "SOURCED_FROM", to: SAMPLE_IDS.releaseNotes, src: SAMPLE_IDS.releaseNotes, asOf: t.releaseDay });

  const issue = (id: string, title: string, first: string, level: string, rel: string | null, pageHow: string, affects: string | null): void => {
    node({ type: "Event", id, name: title, props: { kind: "sentry_issue", level, unhandled: true, isNew: !!rel, firstSeen: first, lastSeen: t.lastDay, unresolved: true, sample: true }, src: SAMPLE_IDS.errorLog, asOf: t.lastDay });
    edge({ from: id, type: "AFFECTS", to: SAMPLE_IDS.onlineStore, src: SAMPLE_IDS.errorLog });
    edge({ from: id, type: "AFFECTS", to: SAMPLE_IDS.paymentPage, props: { how: pageHow }, src: SAMPLE_IDS.errorLog });
    edge({ from: id, type: "SOURCED_FROM", to: SAMPLE_IDS.errorLog, src: SAMPLE_IDS.errorLog });
    if (rel) edge({ from: rel, type: "AFFECTS", to: id, props: { how: "introduced" }, conf: 0.9, src: SAMPLE_IDS.errorLog, asOf: first });
    if (affects) edge({ from: id, type: "AFFECTS", to: affects, props: { how: "breaks" }, src: SAMPLE_IDS.errorLog, asOf: first });
  };
  issue(SAMPLE_IDS.upiIssue, "UPI payment timed out on the new payment step (sample)", t.releaseDay, "error", SAMPLE_IDS.release, "failed_on", SAMPLE_IDS.upi);
  node({ type: "Event", id: SAMPLE_IDS.oldIssue, name: "Product image failed to load on a collection page (sample)", props: { kind: "sentry_issue", level: "warning", unhandled: false, isNew: false, firstSeen: addDays(t.lastDay, -40), lastSeen: t.lastDay, unresolved: true, sample: true }, src: SAMPLE_IDS.errorLog, asOf: t.lastDay });
  edge({ from: SAMPLE_IDS.oldIssue, type: "AFFECTS", to: SAMPLE_IDS.onlineStore, src: SAMPLE_IDS.errorLog });
  edge({ from: SAMPLE_IDS.oldIssue, type: "SOURCED_FROM", to: SAMPLE_IDS.errorLog, src: SAMPLE_IDS.errorLog });

  // ---------- who looks after what (roles, not people) ----------
  for (const r of SAMPLE_ROLES) node({ type: "Person", id: r.id, name: r.name, summary: r.summary, props: { role: r.role, sampleRole: true }, src: SAMPLE_IDS.shopifyExport, asOf: t.lastDay });
  edge({ from: SAMPLE_ROLES[0]!.id, type: "OWNS", to: SAMPLE_IDS.paymentPage, src: SAMPLE_IDS.shopifyExport });
  edge({ from: SAMPLE_ROLES[0]!.id, type: "OWNS", to: SAMPLE_IDS.onlineStore, src: SAMPLE_IDS.shopifyExport });
  edge({ from: SAMPLE_ROLES[2]!.id, type: "OWNS", to: SAMPLE_IDS.wholesale, src: SAMPLE_IDS.wholesaleLedger });
  for (const r of SAMPLE_ROLES) edge({ from: r.id, type: "MEMBER_OF", to: biz, src: SAMPLE_IDS.shopifyExport });

  // ---------- products: the crawl's own, else a fixed sample list; the new roast the campaign sells is always sample ----------
  if (!products.some((p) => p.crawled)) {
    for (const p of products) {
      node({ type: "Product", id: p.id, name: p.name, summary: "A sample product: the crawl found no products on the website.", props: { price: p.price!, priceCurrency: "INR", sample: true }, src: SAMPLE_IDS.shopifyExport, asOf: t.lastDay });
      edge({ from: p.id, type: "PART_OF", to: biz, src: SAMPLE_IDS.shopifyExport });
    }
  }
  node({ type: "Product", id: SAMPLE_IDS.newRoast, name: NEW_ROAST.name, summary: "A new roast the sample Meta campaign promotes. Sample data: not a real product launch.", props: { price: NEW_ROAST.price!, priceCurrency: "INR", sample: true }, src: SAMPLE_IDS.shopifyExport, asOf: t.lastDay });
  edge({ from: SAMPLE_IDS.newRoast, type: "PART_OF", to: biz, src: SAMPLE_IDS.shopifyExport });
  const shares = productShares(sold.length);

  // ---------- the paid campaigns (sample) ----------
  const campaignId = (key: string) => `campaign:${key}`;
  for (const c of CAMPAIGNS) {
    const id = campaignId(c.key);
    node({ type: "Campaign", id, name: c.name, summary: `${c.objective}. Sample campaign: no ad account is connected; every figure is generated.`, props: { status: "active", objective: c.objective, platform: c.platform, dailyBudgetInr: c.spend, sample: true }, src: SAMPLE_IDS.adsExport, asOf: t.lastDay });
    edge({ from: id, type: "PUBLISHED_ON", to: c.platform === "meta" ? SAMPLE_IDS.metaAds : SAMPLE_IDS.googleAds, src: SAMPLE_IDS.adsExport });
    edge({ from: id, type: "DEPENDS_ON", to: SAMPLE_IDS.onlineStore, src: SAMPLE_IDS.adsExport });
    edge({ from: SAMPLE_ROLES[1]!.id, type: "OWNS", to: id, src: SAMPLE_IDS.adsExport });
    if (c.promotesNewRoast) {
      edge({ from: id, type: "DEPENDS_ON", to: SAMPLE_IDS.paymentPage, src: SAMPLE_IDS.adsExport });
      edge({ from: id, type: "PROMOTES", to: SAMPLE_IDS.newRoast, src: SAMPLE_IDS.adsExport });
    }
    for (const day of t.days) {
      if (day < t.recentFrom) continue;
      const a = adDay(t, c, day);
      const base = { subject: id, windowStart: day, windowEnd: day, asOf: day, src: SAMPLE_IDS.adsExport };
      obs({ ...base, metric: "spend", value: a.spend, unit: "INR" });
      obs({ ...base, metric: "impressions", value: a.impressions, unit: "count" });
      obs({ ...base, metric: "clicks", value: a.clicks, unit: "count" });
      obs({ ...base, metric: "conversions", value: a.conversions, unit: "purchases" });
    }
  }

  // ---------- orders and money, day by day (sample numbers) ----------
  const S = (day: string) => storeDay(t, day);
  daily(biz, "orders", "orders", SAMPLE_IDS.shopifyExport, t.firstDay, (d) => S(d).total);
  daily(biz, "revenue", "INR", SAMPLE_IDS.shopifyExport, t.firstDay, (d) => S(d).revenueInr);
  daily(SAMPLE_IDS.onlineStore, "orders", "orders", SAMPLE_IDS.shopifyExport, t.firstDay, (d) => S(d).online);
  daily(SAMPLE_IDS.subscriptions, "orders", "orders", SAMPLE_IDS.shopifyExport, t.firstDay, (d) => S(d).subscriptions);
  daily(SAMPLE_IDS.quickCommerce, "orders", "orders", SAMPLE_IDS.shopifyExport, t.firstDay, (d) => S(d).quickCommerce);
  daily(SAMPLE_IDS.wholesale, "orders", "orders", SAMPLE_IDS.wholesaleLedger, t.firstDay, (d) => S(d).wholesale);
  // the last four weeks in detail: the checkout's steps, how people paid, what failed, refunds, visits
  for (const s of FUNNEL_STEPS) {
    const pick = (d: string) => { const x = S(d); return s.key === "cart_viewed" ? x.cartViewed : s.key === "checkout_started" ? x.checkoutStarted : s.key === "payment_attempted" ? x.paymentAttempted : x.online; };
    daily(SAMPLE_IDS.onlineStore, `checkout_funnel_${s.key}`, "shoppers", SAMPLE_IDS.shopifyExport, t.recentFrom, pick);
    daily(s.id, "funnel_users", "shoppers", SAMPLE_IDS.shopifyExport, t.recentFrom, pick);
  }
  daily(SAMPLE_IDS.onlineStore, "checkout_completion_pct", "%", SAMPLE_IDS.shopifyExport, t.recentFrom, (d) => S(d).checkoutCompletionPct);
  daily(SAMPLE_IDS.onlineStore, "orders_paid_upi", "orders", SAMPLE_IDS.shopifyExport, t.recentFrom, (d) => S(d).ordersUpi);
  daily(SAMPLE_IDS.onlineStore, "orders_paid_card", "orders", SAMPLE_IDS.shopifyExport, t.recentFrom, (d) => S(d).ordersCard);
  daily(SAMPLE_IDS.onlineStore, "orders_paid_other", "orders", SAMPLE_IDS.shopifyExport, t.recentFrom, (d) => S(d).ordersOther);
  daily(SAMPLE_IDS.onlineStore, "refunds", "refunds", SAMPLE_IDS.shopifyExport, t.recentFrom, (d) => S(d).refunds);
  daily(SAMPLE_IDS.onlineStore, "abandoned_checkouts", "checkouts", SAMPLE_IDS.shopifyExport, t.recentFrom, (d) => S(d).abandonedCheckouts);
  daily(SAMPLE_IDS.upi, "payment_failure_pct", "%", SAMPLE_IDS.shopifyExport, t.recentFrom, (d) => S(d).upiFailurePct);
  daily(SAMPLE_IDS.upi, "payment_attempts", "attempts", SAMPLE_IDS.shopifyExport, t.recentFrom, (d) => S(d).upiAttempts);
  daily(SAMPLE_IDS.website, "ga4_sessions", "visits", SAMPLE_IDS.analytics, t.recentFrom, (d) => S(d).sessions);
  // the error log
  daily(SAMPLE_IDS.upiIssue, "sentry_issue_events", "count", SAMPLE_IDS.errorLog, t.releaseDay, (d) => upiIssueDay(t, d).events);
  daily(SAMPLE_IDS.upiIssue, "sentry_issue_users", "count", SAMPLE_IDS.errorLog, t.releaseDay, (d) => upiIssueDay(t, d).users);
  daily(SAMPLE_IDS.oldIssue, "sentry_issue_events", "count", SAMPLE_IDS.errorLog, t.recentFrom, (d) => oldIssueDay(d).events);
  daily(SAMPLE_IDS.oldIssue, "sentry_issue_users", "count", SAMPLE_IDS.errorLog, t.recentFrom, (d) => oldIssueDay(d).users);
  // the red herring: Instagram reach (sample; the public follower numbers stay real), daily and as 28-day readings
  daily(SAMPLE_IDS.instagram, "reach", "accounts", SAMPLE_IDS.instagramInsights, t.recentFrom, (d) => reachDay(t, d).reach);
  daily(SAMPLE_IDS.instagram, "referred_sessions", "visits", SAMPLE_IDS.instagramInsights, t.recentFrom, (d) => reachDay(t, d).referredSessions);
  for (const k of [0, 7, 14, 21]) {
    const end = addDays(t.lastDay, -k), start = addDays(end, -27);
    let sum = 0;
    for (let d = start; d <= end; d = addDays(d, 1)) sum += reachDay(t, d).reach;
    // a 28-day reach is not a sum of days (the same person counts once): a fixed share of it stands in for de-duplication
    obs({ subject: SAMPLE_IDS.instagram, metric: "account_reach", value: Math.round(sum * 0.31), unit: "accounts", windowStart: start, windowEnd: end, asOf: addDays(end, 1) < t.today ? addDays(end, 1) : end, src: SAMPLE_IDS.instagramInsights });
  }

  // ---------- by product, by city, and wholesale accounts, week by week (sample numbers) ----------
  for (const w of t.weeks) {
    const tot = weekTotals(t, w);
    const releasedWeek = w.to >= t.releaseDay;
    sold.forEach((p, i) => {
      // the new roast launched three weeks ago, and its buyers are the mobile UPI payers the payment step lost most of
      if (p.id === SAMPLE_IDS.newRoast && w.to < addDays(t.lastDay, -20)) return;
      const hit = p.id === SAMPLE_IDS.newRoast && releasedWeek ? 0.62 : 1;
      obs({ subject: p.id, metric: "units_sold", value: Math.max(1, Math.round(tot.units * shares[i]! * hit)), unit: "bags", windowStart: w.from, windowEnd: w.to, asOf: w.to, src: SAMPLE_IDS.shopifyExport });
    });
  }
  for (const c of CITIES) {
    const id = `audience:sample-online-customers-${c.key}`;
    node({ type: "Audience", id, name: `Online customers in ${c.name} (sample)`, summary: `People who order from the online store in ${c.name}. Sample numbers.`, props: { city: c.name, sample: true }, src: SAMPLE_IDS.shopifyExport, asOf: t.lastDay });
    edge({ from: SAMPLE_IDS.onlineStore, type: "TARGETS", to: id, src: SAMPLE_IDS.shopifyExport });
    for (const w of t.weeks) obs({ subject: id, metric: "orders", value: weekTotals(t, w).byCity[c.key]!, unit: "orders", windowStart: w.from, windowEnd: w.to, asOf: w.to, src: SAMPLE_IDS.shopifyExport });
  }
  for (const a of WHOLESALE_ACCOUNTS) {
    const id = entityId("Client", `sample ${a.key}`);
    node({ type: "Client", id, name: a.name, summary: `A made-up ${a.kind} in ${a.city} that buys beans wholesale. Sample data: not a real business.`, props: { kind: a.kind, city: a.city, sample: true }, src: SAMPLE_IDS.wholesaleLedger, asOf: t.lastDay });
    edge({ from: id, type: "CLIENT_OF", to: biz, src: SAMPLE_IDS.wholesaleLedger });
    t.weeks.forEach((w, i) => obs({ subject: id, metric: "wholesale_kg", value: Math.round(a.kgPerWeek * (0.9 + ((i * 7 + a.key.length) % 5) * 0.05)), unit: "kg", windowStart: w.from, windowEnd: w.to, asOf: w.to, src: SAMPLE_IDS.wholesaleLedger }));
  }

  const stats = await writeBatch(g, { nodes, edges, observations }, now);
  if (stats.errors.length) throw new Error(`seedCoffeeSample: ${stats.errors.length} write errors: ${stats.errors.slice(0, 5).map((e) => `${e.kind} ${e.error}`).join(" | ")}`);
  log(`coffee sample: ${nodes.length} nodes, ${edges.length} edges, ${observations.length} readings`);

  // ---------- the sample inbox: a wholesale enquiry, a gifting enquiry already answered, a complaint about a UPI payment ----------
  const sales = await seedInbox(g, t, { tenant: o.tenant, biz, sample, embed });
  return { timeline: t, businessId: biz, products: sold, nodes: nodes.length, edges: edges.length, observations: observations.length, sample: [...sample].sort(), hero: heroNumbers(t), sales };
}

// The enquiries go through the Sales department's own writers (src/sales/graph.ts), as the inbox reader would record them; the
// records they make are then marked sample. The complaint is a Document that MENTIONS the error it is about.
async function seedInbox(g: GraphHandle, t: CoffeeTimeline, c: { tenant: string; biz: string; sample: Set<string>; embed: (s: string) => number[] }): Promise<CoffeeSeedResult["sales"]> {
  const at = (key: (typeof COFFEE_INBOX)[number]["key"]) => sampleAt(t, key);
  const src = (id: string) => `gmail:${id}`;
  const leads: string[] = [];
  const made: string[] = [];
  const owner = await ensureActor(g, "person:owner", t.now);
  await ensureAgentNode(g, "sales-lead", t.now);

  const kettle = COFFEE_INBOX.find((m) => m.key === "wholesale")!;
  const k = await recordEnquiry(g, { name: kettle.fromName, email: kettle.fromEmail, channel: "email", subject: kettle.subject, body: kettle.body, at: at(kettle.key), externalId: kettle.id, threadId: kettle.threadId }, { src: src(kettle.id), now: at(kettle.key), tenant: c.tenant });
  leads.push(k.leadId);
  made.push(k.leadId, k.personId, k.messageId);

  const gift = COFFEE_INBOX.find((m) => m.key === "gifting")!;
  const gr = await recordEnquiry(g, { name: gift.fromName, email: gift.fromEmail, channel: "email", subject: gift.subject, body: gift.body, at: at(gift.key), externalId: gift.id, threadId: gift.threadId }, { src: src(gift.id), now: at(gift.key), tenant: c.tenant });
  leads.push(gr.leadId);
  made.push(gr.leadId, gr.personId, gr.messageId);
  const replyAt = at(gift.key) + 5 * 3_600_000;
  // the owner answered this one from Gmail (sample): the gift box options follow, so it is a deal in progress
  const reply = await logMessage(g, {
    leadId: gr.leadId, direction: "out", channel: "email", subject: `Re: ${gift.subject}`, status: "sent", at: replyAt, by: owner, toPersonId: gr.personId,
    body: "Thank you for thinking of us for Diwali. Yes, we can do gift boxes with a note for 120 people and deliver to both offices. I will send the box options and prices by Friday.",
    externalId: `${gift.id}-reply`, threadId: gift.threadId,
  }, { src: src(`${gift.id}-reply`), now: replyAt, tenant: c.tenant });
  const deal = await openDeal(g, { leadId: gr.leadId, title: `${gift.company}: Diwali gift boxes for 120 (sample)`, value: 168_000, currency: "INR", stage: "contacted", nextStep: "Send the gift box options and prices" }, { src: src(`${gift.id}-reply`), now: replyAt + 60_000, tenant: c.tenant });
  made.push(reply, deal);

  const complaint = COFFEE_INBOX.find((m) => m.key === "complaint")!;
  const w = await writeBatch(g, {
    nodes: [{
      type: "Document", id: SAMPLE_IDS.complaint, name: `Email: ${complaint.subject} (sample inbox)`, simulated: true, asOf: new Date(at(complaint.key)).toISOString(),
      summary: `${complaint.fromName} (a made-up customer) wrote: ${complaint.body}`, embedding: c.embed(`${complaint.subject} ${complaint.body}`),
      props: { kind: "email", sample: true, from: complaint.fromEmail, subject: complaint.subject, receivedAt: at(complaint.key), mailbox: "sample inbox" },
    }],
    edges: [
      { from: SAMPLE_IDS.gmail, type: "PRODUCED", to: SAMPLE_IDS.complaint, src: SAMPLE_IDS.complaint, asOf: t.lastDay },
      { from: SAMPLE_IDS.complaint, type: "MENTIONS", to: SAMPLE_IDS.upiIssue, src: SAMPLE_IDS.complaint, asOf: t.lastDay },
      { from: SAMPLE_IDS.complaint, type: "MENTIONS", to: SAMPLE_IDS.upi, src: SAMPLE_IDS.complaint, asOf: t.lastDay },
      { from: SAMPLE_IDS.complaint, type: "MENTIONS", to: SAMPLE_IDS.onlineStore, src: SAMPLE_IDS.complaint, asOf: t.lastDay },
    ],
  }, t.now);
  if (w.errors.length) throw new Error(`seedCoffeeSample: the complaint was not written: ${w.errors[0]!.error}`);
  c.sample.add(SAMPLE_IDS.complaint);

  // the Sales writers know nothing of sample data: what they made is marked here, so every screen says "sample"
  await g.query("UNWIND $ids AS id MATCH (n:Entity {id:id}) SET n.simulated = true", { ids: made });
  for (const id of made) c.sample.add(id);
  return { leads, complaint: SAMPLE_IDS.complaint };
}
