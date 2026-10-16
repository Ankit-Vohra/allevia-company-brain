// What the Apify actors return, reduced to the few public, business-level facts Allevia keeps, with the privacy filter run
// over every piece of text. Actor output is untrusted data: every field is read defensively (snake_case or camelCase,
// missing, the wrong type) and nothing from it is ever treated as an instruction.
//
// Privacy (docs/apify-setup.md): a reviewer keeps at most a first name (letters only), never a surname, a profile link, a
// photo or an id; review text, captions and bios go through redact() (no e-mails, phone numbers or keys); the business's
// own phone number is not kept (the privacy scan treats any phone number as personal until the owner confirms a contact
// card). A private Instagram account gives nothing: only public business profiles are read.
import { redact } from "../ingest/redact.js";
import { sha256 } from "../util/ids.js";
import type { PageData } from "../ingest/sources/website/page.js";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const pick = (o: Obj, ...keys: string[]): unknown => { for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k]; return undefined; };
const str = (v: unknown, max = 300): string | undefined => {
  if (typeof v !== "string" && typeof v !== "number") return undefined;
  const s = String(v).replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : undefined;
};
const num = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v.replace(/,/g, "")) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined; // Instagram reports hidden likes as -1: unknown, not zero
};
/** Text from a public source, filtered: no contact details or keys, whitespace folded, clipped. */
export const clean = (v: unknown, max = 600): string | undefined => {
  const s = str(v, max * 2);
  return s ? redact(s).text.slice(0, max) : undefined;
};
const iso = (v: unknown): string | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  if (typeof v === "string" && v.trim()) {
    if (/^\d{9,13}$/.test(v.trim())) return iso(Number(v.trim()));
    const t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
  }
  return undefined;
};
const httpUrl = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  try {
    const u = new URL(v.trim());
    return (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password ? u.toString().slice(0, 500) : undefined;
  } catch { return undefined; }
};
const round = (v: number, d = 2): number => Math.round(v * 10 ** d) / 10 ** d;

/** A reviewer's first name only, letters and at most 20 of them; undefined when there is no plain first name. */
export function firstNameOnly(v: unknown): string | undefined {
  const s = str(v, 80);
  if (!s || /@|\d|https?:/i.test(s)) return undefined;
  const first = s.split(/[\s.,]+/)[0] ?? "";
  return /^\p{L}[\p{L}'-]{1,19}$/u.test(first) ? first : undefined;
}

// ---------- Google Maps listing ----------

export interface Review { id: string; firstName?: string; stars?: number; text?: string; publishedAt?: string; ownerReplied: boolean }

export interface Listing {
  name: string;
  placeId?: string;
  mapsUrl?: string;
  address?: string;
  city?: string;
  countryCode?: string;
  category?: string;
  website?: string;
  rating?: number;
  reviewCount?: number;
  hours: string[];                       // "Monday: 9 AM to 5 PM"
  closed?: "permanently" | "temporarily";
  phoneListed: boolean;                  // the listing shows a phone number (the number itself is not kept)
  reviews: Review[];
}

export function listingFrom(item: unknown, o: { maxReviews?: number } = {}): Listing | undefined {
  const it = obj(item);
  const name = clean(pick(it, "title", "name"), 160);
  if (!name) return undefined;
  const hours = arr(pick(it, "openingHours", "opening_hours")).map((h) => {
    const x = obj(h);
    const day = str(x.day, 20);
    const time = str(x.hours, 80);
    return day && time ? `${day}: ${time.replace(/ | /g, " ").replace(/[–—]/g, " to ")}` : undefined;
  }).filter((s): s is string => !!s).slice(0, 7);
  const placeId = str(pick(it, "placeId", "place_id"), 120);
  const reviews: Review[] = arr(it.reviews).slice(0, o.maxReviews ?? 20).map((r, i) => {
    const x = obj(r);
    const text = clean(pick(x, "text", "textTranslated"), 1000);
    const at = iso(pick(x, "publishedAtDate", "publishedAt", "date"));
    const rawId = str(pick(x, "reviewId", "review_id", "id"), 200);
    // the review's own id is hashed: it identifies the review, not the person
    const id = sha256(`${placeId ?? name}|${rawId ?? `${at ?? ""}|${text ?? ""}|${i}`}`).slice(0, 16);
    const stars = num(pick(x, "stars", "rating"));
    const firstName = firstNameOnly(pick(x, "name", "reviewerName", "author"));
    return {
      id, ownerReplied: !!str(pick(x, "responseFromOwnerText", "ownerResponse"), 10),
      ...(firstName ? { firstName } : {}), ...(stars !== undefined && stars <= 5 ? { stars } : {}), ...(text ? { text } : {}), ...(at ? { publishedAt: at } : {}),
    };
  });
  const rating = num(pick(it, "totalScore", "rating"));
  const reviewCount = num(pick(it, "reviewsCount", "reviews_count", "userRatingsTotal"));
  const out: Listing = {
    name, hours, reviews, phoneListed: !!str(pick(it, "phone", "phoneUnformatted"), 40),
    ...(placeId ? { placeId } : {}),
    ...(httpUrl(it.url) ? { mapsUrl: httpUrl(it.url)! } : {}),
    ...(clean(pick(it, "address", "fullAddress"), 240) ? { address: clean(pick(it, "address", "fullAddress"), 240)! } : {}),
    ...(clean(it.city, 80) ? { city: clean(it.city, 80)! } : {}),
    ...(str(it.countryCode, 4) ? { countryCode: str(it.countryCode, 4)! } : {}),
    ...(clean(pick(it, "categoryName", "category"), 100) ? { category: clean(pick(it, "categoryName", "category"), 100)! } : {}),
    ...(httpUrl(it.website) ? { website: httpUrl(it.website)! } : {}),
    ...(rating !== undefined && rating <= 5 ? { rating } : {}),
    ...(reviewCount !== undefined ? { reviewCount: Math.round(reviewCount) } : {}),
    ...(it.permanentlyClosed === true ? { closed: "permanently" as const } : it.temporarilyClosed === true ? { closed: "temporarily" as const } : {}),
  };
  return out;
}

// ---------- Instagram ----------

export interface IgPost { url?: string; kind: "image" | "video" | "carousel"; at?: string; likes?: number; comments?: number; views?: number; caption?: string }
export interface IgProfile { handle: string; name?: string; followers?: number; following?: number; posts?: number; isPrivate: boolean; isBusiness?: boolean; category?: string; bio?: string; website?: string; latest: IgPost[] }
export interface IgStats {
  postsLooked: number;
  postsPerWeek?: number;
  avgLikes?: number;
  avgComments?: number;
  avgViews?: number;
  engagementRatePct?: number;            // average (likes + comments) per post, as a share of followers
  topPosts: IgPost[];                    // the three with the most likes + comments
  from?: string;
  to?: string;
}

export const igHandle = (raw: string): string | undefined => {
  const s = raw.trim().replace(/^https?:\/\/(?:www\.)?instagram\.com\//i, "").replace(/^@/, "").split(/[/?#]/)[0]!.toLowerCase();
  return /^[a-z0-9._]{1,30}$/.test(s) ? s : undefined;
};

export function igPostFrom(item: unknown): IgPost | undefined {
  const x = obj(item);
  const type = String(pick(x, "type", "productType") ?? "").toLowerCase();
  const kind: IgPost["kind"] = /video|clips|reel/.test(type) ? "video" : /sidecar|carousel/.test(type) ? "carousel" : "image";
  const likes = num(pick(x, "likesCount", "likes_count", "likes"));
  const comments = num(pick(x, "commentsCount", "comments_count", "comments"));
  const views = num(pick(x, "videoPlayCount", "videoViewCount", "playsCount", "video_view_count"));
  const at = iso(pick(x, "timestamp", "taken_at", "takenAt"));
  const short = str(pick(x, "shortCode", "shortcode", "code"), 40);
  const url = httpUrl(x.url) ?? (short && /^[\w-]+$/.test(short) ? `https://www.instagram.com/p/${short}/` : undefined);
  if (likes === undefined && comments === undefined && views === undefined && !at) return undefined;
  const caption = clean(x.caption, 200);
  return { kind, ...(url ? { url } : {}), ...(at ? { at } : {}), ...(likes !== undefined ? { likes } : {}), ...(comments !== undefined ? { comments } : {}), ...(views !== undefined ? { views } : {}), ...(caption ? { caption } : {}) };
}

export function igProfileFrom(item: unknown): IgProfile | undefined {
  const x = obj(item);
  const handle = igHandle(String(pick(x, "username", "handle") ?? ""));
  if (!handle) return undefined;
  const isPrivate = x.private === true || x.isPrivate === true;
  const followers = num(pick(x, "followersCount", "followers_count", "followers"));
  const following = num(pick(x, "followsCount", "follows_count", "following"));
  const posts = num(pick(x, "postsCount", "posts_count", "mediaCount"));
  const name = clean(pick(x, "fullName", "full_name"), 120);
  const category = clean(pick(x, "businessCategoryName", "category"), 80);
  const bio = clean(pick(x, "biography", "bio"), 300);
  const website = httpUrl(pick(x, "externalUrl", "external_url"));
  return {
    handle, isPrivate,
    latest: isPrivate ? [] : arr(pick(x, "latestPosts", "latest_posts")).map(igPostFrom).filter((p): p is IgPost => !!p),
    ...(name ? { name } : {}), ...(followers !== undefined ? { followers } : {}), ...(following !== undefined ? { following } : {}),
    ...(posts !== undefined ? { posts } : {}), ...(typeof x.isBusinessAccount === "boolean" ? { isBusiness: x.isBusinessAccount } : {}),
    ...(category ? { category } : {}), ...(bio ? { bio } : {}), ...(website ? { website } : {}),
  };
}

const DAY = 86_400_000;
export function igStats(posts: IgPost[], followers: number | undefined): IgStats {
  const ps = posts.filter((p) => p.at).sort((a, b) => (a.at! < b.at! ? 1 : -1));
  const avg = (xs: Array<number | undefined>): number | undefined => {
    const v = xs.filter((n): n is number => n !== undefined);
    return v.length ? round(v.reduce((s, n) => s + n, 0) / v.length, 1) : undefined;
  };
  const avgLikes = avg(ps.map((p) => p.likes));
  const avgComments = avg(ps.map((p) => p.comments));
  const avgViews = avg(ps.filter((p) => p.kind === "video").map((p) => p.views));
  const from = ps[ps.length - 1]?.at;
  const to = ps[0]?.at;
  let postsPerWeek: number | undefined;
  if (ps.length >= 2 && from && to) {
    // the gaps between the posts looked at, over the weeks they span (at least one week)
    const weeks = Math.max(1, (Date.parse(to) - Date.parse(from)) / (7 * DAY));
    postsPerWeek = round((ps.length - 1) / weeks, 1);
  }
  const engagementRatePct = followers && followers > 0 && (avgLikes !== undefined || avgComments !== undefined)
    ? round((((avgLikes ?? 0) + (avgComments ?? 0)) / followers) * 100, 2) : undefined;
  const score = (p: IgPost) => (p.likes ?? 0) + (p.comments ?? 0);
  const topPosts = [...ps].sort((a, b) => score(b) - score(a) || (a.at! < b.at! ? 1 : -1)).slice(0, 3);
  return {
    postsLooked: ps.length, topPosts,
    ...(postsPerWeek !== undefined ? { postsPerWeek } : {}), ...(avgLikes !== undefined ? { avgLikes } : {}),
    ...(avgComments !== undefined ? { avgComments } : {}), ...(avgViews !== undefined ? { avgViews } : {}),
    ...(engagementRatePct !== undefined ? { engagementRatePct } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}),
  };
}

// ---------- ads in the public libraries ----------

export interface Ad {
  platform: "meta" | "google";
  id: string;                            // the library's own ad id (public), or a hash
  advertiser?: string;
  active?: boolean;
  startedAt?: string;
  endedAt?: string;
  text?: string;
  title?: string;
  cta?: string;
  link?: string;
  format?: string;
  placements?: string[];
  reach?: number;                        // only where the library shows it (EU/UK delivery, political ads)
}

export function metaAdFrom(item: unknown): Ad | undefined {
  const x = obj(item);
  const snap = obj(pick(x, "snapshot"));
  const card = obj(arr(snap.cards)[0]);
  const bodyRaw = pick(snap, "body");
  const text = clean(typeof bodyRaw === "string" ? bodyRaw : pick(obj(bodyRaw), "text", "markup") ?? pick(card, "body") ?? pick(x, "adText", "ad_creative_body"), 500);
  const id = str(pick(x, "adArchiveID", "adArchiveId", "ad_archive_id", "adId", "id"), 60) ?? sha256(JSON.stringify(x).slice(0, 2000)).slice(0, 16);
  const advertiser = clean(pick(x, "pageName", "page_name") ?? pick(snap, "page_name", "pageName"), 120);
  const active = typeof pick(x, "isActive", "is_active") === "boolean" ? (pick(x, "isActive", "is_active") as boolean) : undefined;
  const startedAt = iso(pick(x, "startDate", "start_date", "startDateFormatted"));
  const endedAt = iso(pick(x, "endDate", "end_date", "endDateFormatted"));
  const title = clean(pick(snap, "title") ?? pick(card, "title"), 160);
  const cta = clean(pick(snap, "cta_text", "ctaText") ?? pick(card, "cta_text", "ctaText"), 40);
  const link = httpUrl(pick(snap, "link_url", "linkUrl") ?? pick(card, "link_url", "linkUrl"));
  const format = str(pick(snap, "display_format", "displayFormat"), 30)?.toLowerCase();
  const placements = arr(pick(x, "publisherPlatform", "publisher_platform", "publisherPlatforms")).map((p) => str(p, 30)?.toLowerCase()).filter((p): p is string => !!p);
  const reach = num(pick(x, "reachEstimate", "euTotalReach", "eu_total_reach", "totalReach"));
  return {
    platform: "meta", id,
    ...(advertiser ? { advertiser } : {}), ...(active !== undefined ? { active } : {}), ...(startedAt ? { startedAt } : {}), ...(endedAt ? { endedAt } : {}),
    ...(text ? { text } : {}), ...(title ? { title } : {}), ...(cta ? { cta } : {}), ...(link ? { link } : {}), ...(format ? { format } : {}),
    ...(placements.length ? { placements } : {}), ...(reach !== undefined ? { reach } : {}),
  };
}

export function googleAdFrom(item: unknown): Ad | undefined {
  const x = obj(item);
  const id = str(pick(x, "creativeId", "creative_id", "adId", "id"), 80) ?? sha256(JSON.stringify(x).slice(0, 2000)).slice(0, 16);
  const advertiser = clean(pick(x, "advertiserName", "advertiser_name", "advertiser"), 120);
  const startedAt = iso(pick(x, "firstShown", "first_shown", "firstShownDate", "startDate"));
  const endedAt = iso(pick(x, "lastShown", "last_shown", "lastShownDate", "endDate"));
  const format = str(pick(x, "format", "adFormat", "creativeFormat"), 30)?.toLowerCase();
  const text = clean(pick(x, "text", "adText", "description", "headline"), 500);
  const link = httpUrl(pick(x, "url", "previewUrl", "adUrl", "transparencyUrl"));
  if (!advertiser && !startedAt && !text && !link) return undefined;
  return {
    platform: "google", id,
    ...(advertiser ? { advertiser } : {}), ...(startedAt ? { startedAt } : {}), ...(endedAt ? { endedAt } : {}),
    ...(format ? { format } : {}), ...(text ? { text } : {}), ...(link ? { link } : {}),
  };
}

/** One line per ad, for a Document: "Running since 2026-09-01 · Shop now · \"copy…\"". */
export function adLine(a: Ad): string {
  const since = a.startedAt?.slice(0, 10);
  const until = a.endedAt?.slice(0, 10);
  const when = a.active === true ? `running since ${since ?? "an unknown date"}` : a.active === false ? `ran ${since ?? "?"} to ${until ?? "?"}` : since ? `first seen ${since}${until ? `, last seen ${until}` : ""}` : "dates not shown";
  return [`${a.platform === "meta" ? "Meta" : "Google"} ad, ${when}`, a.format, a.cta, a.title ? `"${a.title}"` : undefined, a.text ? `"${a.text.slice(0, 160)}"` : undefined]
    .filter(Boolean).join(" · ");
}

// ---------- a public website, read by Apify when our own reader was turned away ----------

/** Website Content Crawler items as the onboarding's pages: text, title and description only (no styles, links or timing). */
export function pagesFromCrawler(items: unknown[], fetchedAt: string): PageData[] {
  const out: PageData[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const x = obj(it);
    const url = httpUrl(pick(x, "url", "loadedUrl"));
    const text = str(x.text, 20_000) ?? str(x.markdown, 20_000);
    if (!url || !text || seen.has(url)) continue;
    seen.add(url);
    const meta = obj(x.metadata);
    const title = str(pick(meta, "title"), 200);
    const description = str(pick(meta, "description"), 400);
    out.push({
      url, finalUrl: url, redirects: [], status: 200, contentType: "text/html", fetchedAt, bytes: text.length,
      titleCount: title ? 1 : 0, metaDescriptionCount: description ? 1 : 0, h1: [], h2: [], text, wordCount: text.split(/\s+/).length,
      internalLinks: [], externalLinks: [], images: [], jsonLd: [], jsonLdTypes: [], jsonLdErrors: 0, og: {}, timing: { responseMs: 0, fetchMs: 0 }, mixedContent: [],
      ...(title ? { title } : {}), ...(description ? { metaDescription: description } : {}),
      ...(str(pick(meta, "languageCode"), 10) ? { lang: str(pick(meta, "languageCode"), 10)! } : {}),
    });
  }
  return out;
}
