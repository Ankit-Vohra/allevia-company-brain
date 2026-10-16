// The Apify store actors Allevia may run, and nothing else (docs/apify-setup.md). Each entry says what it reads, the most
// results one run may return, and how its cost is estimated BEFORE it runs, in US dollars, from the store's published
// price per 1,000 results (rounded up, plus a small start allowance). The estimate is what the spend ledger reserves;
// a run that reports a higher actual cost is recorded at the higher figure.
//
// Only public, business-level data: a business's Google Maps listing, its public website, public Instagram profiles and
// posts of businesses, and ads in the public ad libraries. Never private insights, never a private person's profile.

export const ACTOR_IDS = [
  "compass/crawler-google-places",
  "apify/website-content-crawler",
  "apify/instagram-profile-scraper",
  "apify/instagram-post-scraper",
  "apify/instagram-reel-scraper",
  "apify/facebook-ads-scraper",
  "s-r/google-ads-transparency",
  "apify/google-search-scraper",
] as const;
export type ActorId = (typeof ACTOR_IDS)[number];

export interface ActorSpec {
  id: ActorId;
  what: string;               // one plain line: what it reads
  usdPer1000: number;         // the store price per 1,000 results, rounded up
  startUsd: number;           // allowance for the run itself (start-up, a little compute)
  maxItems: number;           // the most results one run may return (the per-run cap)
  timeoutMs: number;          // how long we wait for it before stopping it
}

const S = 1000;
export const ACTORS: Record<ActorId, ActorSpec> = {
  "compass/crawler-google-places": { id: "compass/crawler-google-places", what: "A Google Maps listing: address, hours, rating, review count and recent reviews", usdPer1000: 4, startUsd: 0.01, maxItems: 25, timeoutMs: 180 * S },
  "apify/website-content-crawler": { id: "apify/website-content-crawler", what: "The text of a public website, when our own reader is turned away", usdPer1000: 5, startUsd: 0.02, maxItems: 15, timeoutMs: 240 * S },
  "apify/instagram-profile-scraper": { id: "apify/instagram-profile-scraper", what: "A public Instagram profile: followers, posts count and its latest posts' public numbers", usdPer1000: 1.6, startUsd: 0.005, maxItems: 5, timeoutMs: 120 * S },
  "apify/instagram-post-scraper": { id: "apify/instagram-post-scraper", what: "Recent public Instagram posts: likes, comments, views", usdPer1000: 1, startUsd: 0.005, maxItems: 24, timeoutMs: 120 * S },
  "apify/instagram-reel-scraper": { id: "apify/instagram-reel-scraper", what: "Recent public Instagram reels: plays, likes, comments", usdPer1000: 1, startUsd: 0.005, maxItems: 24, timeoutMs: 120 * S },
  "apify/facebook-ads-scraper": { id: "apify/facebook-ads-scraper", what: "Ads in Meta's public Ad Library: the creative, copy, button, run dates and whether it is running", usdPer1000: 5, startUsd: 0.01, maxItems: 20, timeoutMs: 180 * S },
  "s-r/google-ads-transparency": { id: "s-r/google-ads-transparency", what: "Ads in Google's public Ads Transparency Center for a website", usdPer1000: 5, startUsd: 0.01, maxItems: 20, timeoutMs: 180 * S },
  "apify/google-search-scraper": { id: "apify/google-search-scraper", what: "One page of Google results: news and mentions", usdPer1000: 5, startUsd: 0.005, maxItems: 2, timeoutMs: 90 * S },
};

export const isAllowedActor = (id: string): id is ActorId => (ACTOR_IDS as readonly string[]).includes(id);

// Dollars, rounded UP to the cent's tenth, so a reservation never under-counts.
const up = (usd: number): number => Math.ceil(usd * 1000 - 1e-6) / 1000; // (the 1e-6 absorbs float noise: 0.054 stays 0.054)

/** What a run returning at most `items` results may cost, in dollars, before it runs. */
export function estimateUsd(actor: ActorId, items: number): number {
  const a = ACTORS[actor];
  const n = Math.max(1, Math.min(Math.floor(items), a.maxItems));
  return up(a.startUsd + (n * a.usdPer1000) / 1000);
}

/** The cap a run is given: never more results than the actor's own cap. */
export const capItems = (actor: ActorId, wanted: number): number => Math.max(1, Math.min(Math.floor(wanted) || 1, ACTORS[actor].maxItems));

/** "$0.05", "$0.004" -> "under 1 cent" for the owner. */
export function usdWords(usd: number): string {
  if (usd < 0.01) return "under 1 cent";
  return `$${usd.toFixed(2)}`;
}
