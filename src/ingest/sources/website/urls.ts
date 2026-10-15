// URL rules for the website source: normalisation (one URL per page), same-origin, which paths a polite crawler leaves
// alone (binaries, logins, carts), which pages matter most for understanding a business, and social profile links.
import { BlockList, isIP } from "node:net";
import { entityId, pageKey } from "../../../util/ids.js";

// Query params that only track a click; dropping them keeps one URL per page.
const TRACKING = /^(utm_[a-z]+|gclid|fbclid|msclkid|mc_cid|mc_eid|_ga|_gl|igshid|ref_src)$/i;

// Absolute http(s) URL without fragment, default port or tracking params, host lowercased (URL does that); null for
// anything that is not a web page address (mailto:, tel:, javascript:, data:, garbage).
export function normalizeUrl(href: string, base?: string): string | null {
  let u: URL;
  try {
    u = base ? new URL(href, base) : new URL(href);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname) return null;
  u.hash = "";
  u.username = "";
  u.password = "";
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  if (![...u.searchParams.keys()].length) u.search = "";
  return u.toString();
}

export function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

// One site, one origin: a link to the crawl origin's www/apex twin, or to its http:// form, is internal and is
// rewritten onto the origin; anything else is another site (null).
export function toSiteUrl(url: string, origin: string): string | null {
  let u: URL;
  let o: URL;
  try {
    u = new URL(url);
    o = new URL(origin);
  } catch {
    return null;
  }
  if (u.origin === o.origin) return u.toString();
  const bare = (h: string) => h.toLowerCase().replace(/^www\./, "");
  const defaultPort = !u.port || u.port === o.port;
  if (bare(u.hostname) !== bare(o.hostname) || !defaultPort || (u.protocol !== o.protocol && u.protocol !== "http:")) return null;
  u.protocol = o.protocol;
  u.host = o.host;
  return u.toString();
}

const BINARY_EXT = new Set([
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf", "csv", "zip", "rar", "7z", "gz", "tgz", "tar",
  "bz2", "dmg", "exe", "msi", "apk", "ipa", "iso", "bin", "mp3", "wav", "ogg", "m4a", "flac", "aac", "mp4", "m4v", "mov", "avi",
  "wmv", "mkv", "webm", "jpg", "jpeg", "png", "gif", "webp", "avif", "svg", "ico", "bmp", "tif", "tiff", "heic", "psd", "ai",
  "eps", "woff", "woff2", "ttf", "otf", "eot", "css", "js", "mjs", "map", "json", "xml", "rss", "atom", "txt", "dwg", "dxf", "skp",
]);

export function isBinaryPath(pathname: string): boolean {
  const last = pathname.split("/").pop() ?? "";
  const dot = last.lastIndexOf(".");
  return dot > 0 && BINARY_EXT.has(last.slice(dot + 1).toLowerCase());
}

// Paths that log in or out, change a cart or open an admin area: a crawler that only reads leaves them alone.
const ACTION_SEGMENT = /^(wp-admin|wp-login\.php|login|log-in|logout|log-out|signin|sign-in|signout|sign-out|signup|sign-up|register|account|my-account|cart|basket|checkout|admin|wp-json|xmlrpc\.php|feed|search)$/i;
const ACTION_PARAM = /^(add-to-cart|add_to_cart|replytocom|action|logout|s)$/i;

export function isActionPath(u: URL): boolean {
  if (u.pathname.split("/").some((s) => ACTION_SEGMENT.test(s))) return true;
  return [...u.searchParams.keys()].some((k) => ACTION_PARAM.test(k));
}

// A copy of a list rather than a page of its own: the next page of a blog or shop (?offset=, ?page=2, /page/3), or the
// same list sorted or filtered. A page cap spent on these reads one list many times and misses the pages behind it.
const LISTING_PARAMS = /^(offset|paged|pg|cursor|start|after|before|sort|sort_by|sortby|orderby|order|limit|per_page|perpage|view|layout|display|filter(?:\..*)?)$/i;
export function isListingVariant(u: URL): boolean {
  if (/\/page\/(?:[2-9]|\d{2,})\/?$/i.test(u.pathname)) return true;
  for (const [k, v] of u.searchParams) {
    if (/^page$/i.test(k) ? !/^0*1$/.test(v) : LISTING_PARAMS.test(k)) return true;
  }
  return false;
}

// Addresses a stranger's URL must never reach: loopback, private, link-local (cloud metadata lives at 169.254.169.254),
// CGNAT, multicast, reserved and documentation ranges, in IPv4 and IPv6 (IPv4-mapped IPv6 is checked as IPv4 by
// BlockList). Used on URL hosts and, at connect time, on every address a host name resolves to (fetch.ts).
const BLOCKED = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) BLOCKED.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32], ["64:ff9b::", 96], ["100::", 64],
] as const) BLOCKED.addSubnet(net, bits, "ipv6");

export function isBlockedAddress(address: string): boolean {
  const a = address.replace(/^\[|\]$/g, "");
  const v = isIP(a);
  if (v === 0) return true; // not an address at all: refuse rather than guess
  return BLOCKED.check(a, v === 4 ? "ipv4" : "ipv6");
}

// A URL host that is private by its name or its literal address. Host names are checked again when they resolve
// (fetch.ts), so a public-looking name that points at 10.0.0.1 is refused too.
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (isIP(h)) return isBlockedAddress(h);
  return h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".home.arpa")
    || !h.includes(".");
}

// How much a page tells us about the business, from its path alone. The crawler visits high scores first (so a page
// cap never drops "About"), and understanding reads the top pages.
const KEY_PATTERNS: Array<[RegExp, number]> = [
  [/^(about|about-us|who-we-are|our-story|story|studio|practice|our-practice|company|firm)$/, 90],
  [/^(services|what-we-do|expertise|offerings|solutions|capabilities|approach|process|treatments?|procedures|what-we-offer|our-services|classes|courses|workshops|lessons|training)$/, 85],
  [/^(projects|portfolio|work|our-work|case-studies|case-study|gallery)$/, 80],
  [/^(pricing|prices|packages|plans|fees|rates)$/, 75],
  [/^(products|shop|store|menu|our-menu|collections|caf[eé]s?|restaurant|nursery|food|drinks?|food-and-drink|bar|rooms|accommodation)$/, 70],
  [/^(contact|contact-us|get-in-touch|enquire|enquiry|book|booking|book-online|book-now|visit|visit-us|find-us|locations?|opening-hours|hours|directions|new-patients?|patients|appointments?|reservations?|reserve|order-online)$/, 70],
  [/^(team|people|our-team|meet-the-team|meet-us|founders|leadership|doctors|dentists|staff)$/, 60],
  [/^(testimonials|reviews|clients|awards|press|faqs?)$/, 55],
];

// Shopify and Wix put every content page under /pages/: "/pages/cafe" is "/cafe".
const WRAPPER_SEGMENTS = new Set(["pages"]);

const decode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

export function keyPagePriority(u: URL): number {
  const segs = u.pathname.toLowerCase().split("/").filter(Boolean).map((s) => decode(s).replace(/\.(html?|php|aspx?)$/, ""));
  if (!segs.length || (segs.length === 1 && segs[0] === "index")) return 100;
  if (segs.length > 1 && WRAPPER_SEGMENTS.has(segs[0]!)) segs.shift();
  let best = 0;
  segs.forEach((s, i) => {
    for (const [re, score] of KEY_PATTERNS) {
      // a detail page under a key section (/projects/harbour-house) is worth a little less than the section itself
      if (re.test(s)) best = Math.max(best, i === segs.length - 1 ? score : score - 25);
    }
  });
  return best || Math.max(1, 20 - segs.length * 5);
}

// The part of a site a page belongs to, by its first path segment ("/collections/roses" -> "collections"): what a
// catalogue, a blog or a docs tree is made of. Content pages under /pages/ and the home page are no section ("").
export function sectionOf(u: URL): string {
  const first = u.pathname.toLowerCase().split("/").filter(Boolean)[0] ?? "";
  const segs = u.pathname.split("/").filter(Boolean);
  return segs.length <= 1 || WRAPPER_SEGMENTS.has(first) ? "" : decode(first);
}

export interface SocialProfile { platform: string; handle?: string; url: string }

interface SocialRule { platform: string; host: RegExp; handle: (segs: string[]) => string | undefined }

const RESERVED = new Set([
  "sharer", "sharer.php", "share", "intent", "home", "p", "reel", "reels", "tv", "stories", "explore", "watch", "embed",
  "hashtag", "search", "login", "signup", "events", "groups", "pages", "plugins", "dialog", "tr", "photo", "photos", "status",
  "accounts", "legal", "privacy", "about", "help", "policies", "pin", "ideas",
]);
const plain = (s: string | undefined) => (s && !RESERVED.has(s.toLowerCase()) && /^[\p{L}\p{N}._-]{2,100}$/u.test(s) ? s : undefined);

const SOCIAL: SocialRule[] = [
  { platform: "instagram", host: /(^|\.)instagram\.com$/, handle: (s) => (s.length === 1 ? plain(s[0]) : undefined) },
  { platform: "facebook", host: /(^|\.)(facebook|fb)\.com$/, handle: (s) => (s.length === 1 ? plain(s[0]) : s[0] === "people" ? plain(s[1]) : undefined) },
  { platform: "linkedin", host: /(^|\.)linkedin\.com$/, handle: (s) => (["company", "in", "school", "showcase"].includes(s[0] ?? "") ? plain(s[1]) : undefined) },
  { platform: "youtube", host: /(^|\.)youtube\.com$/, handle: (s) => (s[0]?.startsWith("@") ? plain(s[0].slice(1)) : ["c", "channel", "user"].includes(s[0] ?? "") ? plain(s[1]) : undefined) },
  { platform: "x", host: /(^|\.)(twitter|x)\.com$/, handle: (s) => (s.length === 1 ? plain(s[0]) : undefined) },
  { platform: "tiktok", host: /(^|\.)tiktok\.com$/, handle: (s) => (s.length === 1 && s[0]!.startsWith("@") ? plain(s[0]!.slice(1)) : undefined) },
  { platform: "pinterest", host: /(^|\.)pinterest\.[a-z.]+$/, handle: (s) => (s.length === 1 ? plain(s[0]) : undefined) },
  { platform: "threads", host: /(^|\.)threads\.(net|com)$/, handle: (s) => (s.length === 1 && s[0]!.startsWith("@") ? plain(s[0]!.slice(1)) : undefined) },
  { platform: "behance", host: /(^|\.)behance\.net$/, handle: (s) => (s.length === 1 ? plain(s[0]) : undefined) },
  { platform: "houzz", host: /(^|\.)houzz\.[a-z.]+$/, handle: (s) => (["professionals", "pro"].includes(s[0] ?? "") ? plain(s[s.length - 1]?.split("~")[0]) : undefined) },
];

// A link to the business's own profile on a social platform, or null (share buttons, single posts, other pages).
// WhatsApp click-to-chat links carry a phone number, so only the platform is kept.
export function socialProfile(href: string): SocialProfile | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  if (host === "wa.me" || host === "api.whatsapp.com" || host === "chat.whatsapp.com") return { platform: "whatsapp", url: "https://wa.me" };
  const segs = decodeURIComponent(u.pathname).split("/").filter(Boolean);
  for (const r of SOCIAL) {
    if (!r.host.test(host)) continue;
    const handle = r.handle(segs);
    if (!handle) return null;
    return { platform: r.platform, handle, url: `${u.origin}${u.pathname}` };
  }
  return null;
}

// The Document that holds one crawled page's text: "https://www.example.com/about/" -> "document:web-www-example-com-about".
export const pageDocId = (url: string): string => entityId("Document", `web ${pageKey(url)}`);
export const pageId = (url: string): string => entityId("Page", url);
