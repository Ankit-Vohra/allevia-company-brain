// Onboarding enrichment from public data (docs/apify-setup.md), both optional and inside the business's budget:
//   - readBlockedSite: when our own reader is turned away (HTTP 429, 403, a bot wall), Apify's Website Content Crawler
//     reads the public pages instead, so the business can still be set up from its own words;
//   - enrichOwnListing: the business's Google Maps listing, so day one has its address, hours, rating and a reviews
//     number, not only page text.
// Both return a plain reason instead of throwing, so a lookup that is off, over budget or fails never fails onboarding.
import type { GraphHandle } from "../graph/client.js";
import { writeBatch } from "../graph/upsert.js";
import type { PageData } from "../ingest/sources/website/page.js";
import { listingFrom, pagesFromCrawler, type Listing } from "./normalize.js";
import type { PublicDataPort } from "./service.js";
import { ownListingWrite } from "./write.js";

export const FALLBACK_PAGES = 12;
export const ONBOARDING_REVIEWS = 10;

const host = (u?: string): string => {
  try { return u ? new URL(/^https?:/i.test(u) ? u : `https://${u}`).hostname.toLowerCase().replace(/^www\./, "") : ""; } catch { return ""; }
};

export async function readBlockedSite(pd: PublicDataPort, o: { tenant: string; url: string; signal?: AbortSignal }): Promise<{ pages: PageData[]; usd: number } | { why: string }> {
  if (!pd.enabled) return { why: "public data lookups aren't switched on" };
  const r = await pd.run({
    tenant: o.tenant, actor: "apify/website-content-crawler", maxItems: FALLBACK_PAGES,
    input: { startUrls: [{ url: o.url }], maxCrawlPages: FALLBACK_PAGES, maxCrawlDepth: 2, crawlerType: "playwright:adaptive", saveMarkdown: false, removeCookieWarnings: true },
    ...(o.signal ? { signal: o.signal } : {}),
  });
  if (!r.ok) return { why: r.why };
  // only pages of the site we were asked to read
  const site = host(o.url);
  const pages = pagesFromCrawler(r.items, r.asOf).filter((p) => host(p.finalUrl) === site || host(p.finalUrl).endsWith(`.${site}`));
  return pages.length ? { pages, usd: r.usd } : { why: "the public-data reader found no readable text either" };
}

export async function enrichOwnListing(g: GraphHandle, pd: PublicDataPort, o: { tenant: string; businessId: string; name: string; city?: string; domain?: string; now: number; signal?: AbortSignal }):
  Promise<{ listing: Listing; usd: number; nodes: number } | { why: string }> {
  if (!pd.enabled) return { why: "public data lookups aren't switched on" };
  const query = [o.name, o.city].filter(Boolean).join(" ");
  const r = await pd.run({
    tenant: o.tenant, actor: "compass/crawler-google-places", maxItems: 1, units: 1 + ONBOARDING_REVIEWS,
    input: { searchStringsArray: [query], maxCrawledPlacesPerSearch: 1, language: "en", maxReviews: ONBOARDING_REVIEWS, reviewsSort: "newest", scrapeReviewsPersonalData: false, maxImages: 0, maxQuestions: 0, scrapeContacts: false, scrapeDirectories: false },
    ...(o.signal ? { signal: o.signal } : {}),
  });
  if (!r.ok) return { why: r.why };
  const listing = listingFrom(r.items[0], { maxReviews: ONBOARDING_REVIEWS });
  if (!listing) return { why: `Google Maps has no listing for "${query}"` };
  // a listing whose website is another site's is not taken as this business's own
  if (o.domain && listing.website && host(listing.website) !== host(o.domain)) return { why: `the closest listing ("${listing.name}") links to ${host(listing.website)}, not ${host(o.domain)}` };
  const w = ownListingWrite(listing, { businessId: o.businessId, asOf: r.asOf, actor: r.actor }, `${o.businessId} own`);
  (w.nodes[0]!.props as Record<string, unknown>).result = JSON.stringify({ listing, whose: "ours", name: o.name });
  const s = await writeBatch(g, w, o.now);
  if (s.errors.length) return { why: `${s.errors.length} write(s) failed` };
  return { listing, usd: r.usd, nodes: w.nodes.length };
}
