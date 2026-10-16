// The website check-up's verdict: every problem found (crawl checks, Lighthouse, conversion checks, site checks) turned
// into fixes an owner can act on, in plain words, ranked by how likely each is to cost enquiries. The top five are
// the answer; the rest sit behind "Show how".
//
// The ranking is a fixed, explainable model, not a model call:
//   impact = base × page weight + breadth
//   base        - how directly the problem loses an enquiry (a phone visitor who cannot find a call button: 95; a
//                 missing Open Graph image: 30; a missing canonical: 8). The table is FIXES below.
//   page weight - home page 1, a key page (about, services, contact, booking …) 0.8, any other page 0.5
//   breadth     - +2 for each further page with the same problem, at most +8
// Ties go to the quicker fix. Severity bands and checks draw on open-seo (audit issue types and Lighthouse severity,
// MIT) and claude-seo (Core Web Vitals bands, 24 px tap targets, AI search crawlers, LocalBusiness fields, Quick
// wins first; MIT parts only): see NOTICE.md.
import type { SeoReport } from "../ingest/sources/website/seo.js";
import { keyPagePriority } from "../ingest/sources/website/urls.js";
import type { BusinessKind, ConversionFinding } from "./conversion.js";
import { band, type LhIssue, type LighthouseResult } from "./lighthouse.js";

export type Who = "you" | "your web person";
export type Tier = "losing enquiries" | "harder to find or trust" | "tidy-up";

export interface FixDef {
  key: string;
  base: number;
  minutes: number;          // rough effort, for the owner and for tie-breaks
  who: Who;
  title: (n: number) => string;   // n = pages affected
  what: string;             // what to change, plainly
  why: string;              // why it matters for enquiries
}

const pages = (n: number) => (n === 1 ? "1 page" : `${n} pages`);

// The catalogue. Owner words only: no "LCP", "JSON-LD", "canonical" in title/what/why (those go in the evidence).
export const FIXES: FixDef[] = [
  // losing enquiries
  { key: "site-down", base: 100, minutes: 60, who: "your web person", title: () => "Your website does not open",
    what: "Get the site back up: check the hosting account and the domain renewal first.",
    why: "Nobody can reach you through the site while it is down." },
  { key: "contact-path", base: 100, minutes: 30, who: "you", title: () => "Give visitors a way to reach you",
    what: "Add a call, WhatsApp or booking button to every page, and a short enquiry form on the contact page.",
    why: "We found no call, WhatsApp, booking or enquiry button. A visitor who is ready to buy has nowhere to go." },
  { key: "contact-above-fold-mobile", base: 95, minutes: 30, who: "you", title: () => "Put a call or WhatsApp button on the first screen on phones",
    what: "Add a 'Call' or 'WhatsApp us' button at the top of the home page on phones, or a button that stays at the bottom of the screen.",
    why: "Most visitors come on a phone and decide in seconds. If they have to scroll to find how to reach you, many leave." },
  { key: "noindex", base: 90, minutes: 15, who: "you", title: (n) => `Google is told to ignore ${pages(n)}`,
    what: "Turn off 'hide from search engines' (noindex) on these pages in your site settings.",
    why: "These pages can never show up on Google, so nobody finds them by searching." },
  { key: "https", base: 90, minutes: 60, who: "your web person", title: () => "Make the site secure (the padlock)",
    what: "Turn on HTTPS (a free certificate from your host) and send every http:// visit to https://.",
    why: "Browsers mark the site 'Not secure', which scares people off before they read anything." },
  { key: "mobile-speed", base: 85, minutes: 240, who: "your web person", title: () => "Make the site faster on phones",
    what: "", // filled from what Lighthouse found
    why: "A slow page loses visitors: on a phone, people leave if nothing useful shows in about 3 seconds." },
  { key: "broken-pages", base: 80, minutes: 30, who: "you", title: (n) => `Fix ${pages(n)} that do not open`,
    what: "Bring these pages back, or point their old address to the right page (a redirect) and remove links to them.",
    why: "A visitor who clicks and gets an error page often gives up on the whole site." },
  { key: "viewport", base: 80, minutes: 15, who: "your web person", title: (n) => `${n === 1 ? "A page shows" : `${n} pages show`} zoomed out on phones`,
    what: "Add the mobile viewport setting to the page template (one line in the page head).",
    why: "Without it, phones show a tiny desktop page that people have to pinch to read." },
  { key: "clear-offer", base: 75, minutes: 30, who: "you", title: () => "Say what you do in the first line of the home page",
    what: "Replace the opening headline with one sentence that says what you offer, for whom and where, e.g. 'Interiors for homes and offices in Raipur'.",
    why: "Visitors decide in a few seconds whether they are in the right place; a greeting or just the name does not tell them." },
  { key: "proof", base: 65, minutes: 60, who: "you", title: () => "Show reviews or proof from customers",
    what: "Add 3 to 5 real customer reviews (or your Google rating) to the home page, with names and photos of the work where you can.",
    why: "People trust other customers more than the business itself; a page with no reviews feels risky to a new visitor." },
  { key: "broken-links", base: 60, minutes: 30, who: "you", title: (n) => `Fix broken links on ${pages(n)}`,
    what: "Update or remove the links that lead to missing pages.",
    why: "Dead links make the site feel neglected and stop visitors on their way to you." },
  { key: "titles", base: 60, minutes: 45, who: "you", title: (n) => `Write clear page titles for ${pages(n)}`,
    what: "Give each page its own title of up to 60 characters: what is on the page, then your name, e.g. 'Kitchen interiors in Raipur | AVS Atelier'.",
    why: "The title is the blue link people click on Google. Missing, repeated or cut-off titles get fewer clicks." },
  { key: "location", base: 50, minutes: 20, who: "you", title: () => "Show where you are",
    what: "Add your address and a Google Maps link (or map) to the contact page and the footer.",
    why: "Local customers want to know you are near them before they call; Google also uses it to show you in local searches." },
  { key: "descriptions", base: 45, minutes: 45, who: "you", title: (n) => `Write Google descriptions for ${pages(n)}`,
    what: "Write a one- or two-sentence summary (about 150 characters) for each page, saying what the visitor gets and how to reach you.",
    why: "This is the grey text under your link on Google. Without it Google picks random text from the page, and fewer people click." },
  { key: "tap-targets", base: 40, minutes: 60, who: "your web person", title: () => "Make buttons and links bigger on phones",
    what: "Make buttons and menu links at least the size of a fingertip (about 48 px tall) with space between them.",
    why: "Small links are hard to tap; people tap the wrong thing or give up." },
  { key: "opening-hours", base: 40, minutes: 15, who: "you", title: () => "Show your opening hours",
    what: "Add your working days and hours to the contact page and the footer.",
    why: "People want to know when they can call or visit; missing hours means a call that never happens." },
  { key: "mixed-content", base: 40, minutes: 30, who: "your web person", title: (n) => `Remove the 'not secure' warnings on ${pages(n)}`,
    what: "Change the images and scripts these pages load from http:// to https://.",
    why: "Browsers drop the padlock or block parts of the page." },
  { key: "page-jumps", base: 40, minutes: 120, who: "your web person", title: () => "Stop the page jumping while it loads",
    what: "Give images and banners a fixed size so the text does not move as they load.",
    why: "People tap the wrong thing when the page shifts under their finger." },
  { key: "contrast", base: 35, minutes: 45, who: "your web person", title: (n) => `Make text easier to read on ${pages(n)}`,
    what: "Use darker text (or a darker button colour) where text is pale on a light background.",
    why: "Light grey or thin text is hard to read on a phone outdoors, and older visitors skip it." },
  { key: "business-details", base: 35, minutes: 45, who: "your web person", title: () => "Tell Google your business details in a form it reads",
    what: "Add business details (name, address, phone, hours, area served) to the home and contact pages as structured data; most site builders have an SEO or 'local business' setting for it.",
    why: "Google uses it for the business panel, maps and rich results; without it, it guesses." },
  { key: "ai-crawlers", base: 35, minutes: 15, who: "your web person", title: () => "Let AI assistants read your site",
    what: "Allow the AI search crawlers (OAI-SearchBot, Claude-SearchBot, PerplexityBot) in robots.txt.",
    why: "People now ask ChatGPT, Claude and Perplexity for recommendations; if they cannot read your site they cannot suggest you." },
  { key: "thin-pages", base: 30, minutes: 120, who: "you", title: (n) => `Add more detail to ${pages(n)}`,
    what: "Write a few short paragraphs on these pages: what you do, for whom, a project or two, and how to get in touch.",
    why: "Pages with very few words rarely show up on Google and do not answer a visitor's questions." },
  { key: "sitemap", base: 30, minutes: 20, who: "your web person", title: () => "Add a sitemap so Google finds every page",
    what: "Turn on the sitemap in your site builder (most have it) and add it to Google Search Console.",
    why: "Google finds new pages sooner and misses fewer of them." },
  { key: "share-preview", base: 30, minutes: 30, who: "you", title: (n) => `Fix the WhatsApp and social preview for ${pages(n)}`,
    what: "Set a share title, short description and a picture (1200 x 630) for these pages in your site's SEO or social settings.",
    why: "When someone shares your link on WhatsApp or Facebook, it shows a bare link instead of a picture and title, so fewer people tap it." },
  { key: "robots-file", base: 30, minutes: 30, who: "your web person", title: () => "Fix the file that tells Google what to read",
    what: "Correct the errors in robots.txt (the file that tells search engines what to read).",
    why: "A broken robots.txt can stop Google reading parts of the site." },
  { key: "headings", base: 25, minutes: 20, who: "you", title: (n) => `Give ${pages(n)} one main heading`,
    what: "Each page should have exactly one main heading (H1) that says what the page is about.",
    why: "Google and screen readers use the main heading to understand the page." },
  { key: "image-text", base: 25, minutes: 45, who: "you", title: (n) => `Describe the photos on ${pages(n)}`,
    what: "Add a short description (alt text) to each photo, e.g. 'Living room with walnut panelling, Raipur'.",
    why: "Google Images and visitors using screen readers rely on it; it is also an easy way to show what you do." },
  { key: "button-labels", base: 20, minutes: 30, who: "your web person", title: (n) => `Name the unlabelled buttons on ${pages(n)}`,
    what: "Give icon-only buttons and links a text label.",
    why: "Screen readers announce them as 'button', and Google cannot tell what they are." },
  { key: "link-words", base: 15, minutes: 20, who: "you", title: (n) => `Use clear link words on ${pages(n)}`,
    what: "Replace 'click here' and 'read more' with words that say where the link goes.",
    why: "Clear link words help visitors and Google understand where a link leads." },
  { key: "console-errors", base: 12, minutes: 60, who: "your web person", title: (n) => `Fix the script errors on ${pages(n)}`,
    what: "Ask your web person to look at the errors the browser reports on these pages.",
    why: "They are often a broken form, chat widget or tracker." },
  { key: "page-language", base: 10, minutes: 10, who: "your web person", title: () => "Tell browsers what language the site is in",
    what: "Set the page language (lang attribute) in the site template.",
    why: "Browsers and screen readers then translate and pronounce it correctly." },
  { key: "canonical", base: 8, minutes: 20, who: "your web person", title: (n) => `Mark the main address of ${pages(n)}`,
    what: "Add a canonical link to each page so Google knows its one true address.",
    why: "Stops Google splitting a page's ranking between its http, www and https versions." },
  { key: "other-lighthouse", base: 12, minutes: 60, who: "your web person", title: (n) => `Smaller technical fixes on ${pages(n)}`,
    what: "Technical items Lighthouse flagged; see the list.",
    why: "Each is small; together they make the site a little faster, safer and easier to use." },
];
export const FIX_BY_KEY = new Map(FIXES.map((f) => [f.key, f]));

// For a business people sign up to or buy from online, the first-screen button is "sign up" or "get the app", not "call".
const ONLINE: Record<string, Pick<FixDef, "title" | "what" | "why">> = {
  "contact-above-fold-mobile": {
    title: () => "Put a sign-up or 'get the app' button on the first screen on phones",
    what: "Add one clear button at the top of the home page on phones (sign up, get the app, or start), or one that stays at the bottom of the screen.",
    why: "Most visitors come on a phone and decide in seconds. If the next step is several screens down, many leave before they see it.",
  },
  "contact-path": {
    title: () => "Give visitors one clear next step",
    what: "Add a sign-up, download or contact button to every page.",
    why: "We found no sign-up, download, booking or contact button. A visitor who is ready has nowhere to go.",
  },
};

// Fixes below this impact never make the top five, however few problems a site has: they stay behind "Show how".
export const TOP_MIN_IMPACT = 20;

// Crawl checks (website/seo.ts) → fix keys.
const SEO_TO_FIX: Record<string, string> = {
  "broken-page": "broken-pages", "server-error": "broken-pages", "missing-title": "titles", "duplicate-title": "titles",
  "title-too-long": "titles", "missing-meta-description": "descriptions", "duplicate-meta-description": "descriptions",
  "missing-h1": "headings", "multiple-h1": "headings", "images-missing-alt": "image-text", "noindex-page": "noindex",
  "thin-content": "thin-pages", "broken-internal-link": "broken-links", "missing-canonical": "canonical",
  "missing-structured-data": "business-details", "missing-viewport": "viewport", "mixed-content": "mixed-content",
  "missing-open-graph": "share-preview",
};
// Lighthouse audits → fix keys (speed audits feed "mobile-speed").
const LH_TO_FIX: Record<string, string> = {
  "color-contrast": "contrast", "image-alt": "image-text", "button-name": "button-labels", "link-name": "button-labels",
  "target-size": "tap-targets", "html-has-lang": "page-language", "meta-description": "descriptions", "document-title": "titles",
  "is-crawlable": "noindex", "link-text": "link-words", "robots-txt": "robots-file", "errors-in-console": "console-errors",
  "is-on-https": "https", "viewport": "viewport", "crawlable-anchors": "link-words",
  "cls-culprits-insight": "page-jumps", "layout-shifts": "page-jumps",
};

// Speed audits in owner words, for the "what to change" of the speed fix.
const SPEED_WORDS: Array<[RegExp, string]> = [
  [/image|offscreen|modern-image|responsive-images|optimized-images/, "make the photos lighter (compress them, use WebP, size them for phones)"],
  [/render-blocking|critical-request|network-dependency/, "load fewer scripts and styles before the page shows"],
  [/unused-javascript|legacy-javascript|third-party|bootup|mainthread|duplicated-javascript|unminified-javascript/, "remove apps, widgets and trackers the site does not need"],
  [/redirects/, "send visitors straight to the final address (one redirect, e.g. from the bare domain to www, costs most of a second on a phone)"],
  [/server-response|document-latency/, "speed up the hosting (the server is slow to answer)"],
  [/font/, "load the web fonts faster"],
  [/cache/, "let browsers keep files they have already downloaded (caching)"],
  [/unused-css|unminified-css/, "trim unused styles"],
  [/lcp-discovery|prioritize-lcp|preload/, "load the main picture first"],
];

export interface Fix {
  key: string;
  title: string;
  what: string;
  why: string;
  who: Who;
  effort: string;           // "about 30 minutes"
  minutes: number;
  impact: number;           // 0-100
  tier: Tier;
  pages: string[];          // page paths, home first
  urls: string[];           // the same pages as full addresses (the graph's Page ids are made from them)
  pageCount: number;
  evidence: string[];       // the technical detail behind "Show how"
  sources: Array<"crawl" | "lighthouse" | "conversion" | "site">;
}

export interface Scores {
  mobileSpeed?: number; desktopSpeed?: number; accessibility?: number; bestPractices?: number; googleBasics?: number;
  lcpMs?: number; cls?: number; tbtMs?: number;
}

export interface SiteFacts {
  origin: string;
  homeOk: boolean;
  https: boolean;
  sitemapFound: boolean;
  aiCrawlersBlocked: string[];   // AI search crawlers robots.txt disallows at "/"
}

export interface CheckupInput {
  site: SiteFacts;
  kind: BusinessKind;
  seo?: SeoReport;
  lighthouse: LighthouseResult[];
  conversion: ConversionFinding[];
}

export interface CheckupVerdict {
  top: Fix[];
  all: Fix[];
  scores: Scores;
  good: string[];                // what already works, plainly (for balance)
  kind: BusinessKind;
}

export const effortWords = (m: number): string =>
  m <= 15 ? "about 15 minutes" : m <= 30 ? "about 30 minutes" : m <= 60 ? "about an hour" : m <= 150 ? "an hour or two" : m <= 300 ? "half a day" : "a day or more";

const pathOf = (url: string): string => {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
};
export const pageWeight = (url: string): number => {
  try {
    const p = keyPagePriority(new URL(url));
    return p >= 100 ? 1 : p >= 70 ? 0.8 : 0.5;
  } catch {
    return 0.5;
  }
};

interface Acc { def: FixDef; pages: Map<string, number>; evidence: string[]; sources: Set<Fix["sources"][number]>; over?: number; what?: string }

export function buildVerdict(input: CheckupInput, topN = 5): CheckupVerdict {
  const acc = new Map<string, Acc>();
  const hit = (key: string, page: string | null, evidence: string, source: Fix["sources"][number], base?: number) => {
    const def = FIX_BY_KEY.get(key);
    if (!def) return;
    const a: Acc = acc.get(key) ?? { def, pages: new Map(), evidence: [], sources: new Set() };
    acc.set(key, a);
    if (page) a.pages.set(page, pageWeight(page));
    if (a.evidence.length < 12 && !a.evidence.includes(evidence)) a.evidence.push(evidence);
    a.sources.add(source);
    if (base !== undefined) a.over = Math.max(a.over ?? 0, base); // the worst case seen sets the base
  };
  const home = `${input.site.origin}/`;

  // site
  if (!input.site.homeOk) hit("site-down", home, "The home page did not load.", "site");
  if (!input.site.https) hit("https", home, `The site is served at ${input.site.origin} (no https).`, "site");
  if (!input.site.sitemapFound) hit("sitemap", null, "No sitemap.xml was found (robots.txt names none and /sitemap.xml is missing).", "site");
  if (input.site.aiCrawlersBlocked.length) hit("ai-crawlers", null, `robots.txt blocks ${input.site.aiCrawlersBlocked.join(", ")}.`, "site");

  // crawl checks
  for (const r of input.seo?.results ?? []) {
    if (r.pass) continue;
    const key = SEO_TO_FIX[r.check];
    if (!key) continue;
    if (key === "thin-pages" && pageWeight(r.page) < 0.8) continue; // a thin blog tag page is not worth the owner's time
    if (key === "broken-pages" && r.page === home) hit("site-down", home, `The home page answered: ${r.evidence}`, "crawl");
    else if (key === "business-details") hit(key, r.page, `${pathOf(r.page)}: ${r.evidence}`, "crawl", input.kind === "local" ? 35 : 20);
    else hit(key, r.page, `${pathOf(r.page)}: ${r.check}: ${r.evidence}`, "crawl");
  }

  // conversion
  for (const c of input.conversion) {
    if (!c.pass) hit(c.check, c.page, c.evidence, "conversion", c.base);
  }

  // Lighthouse
  const scores: Scores = {};
  const homeMobile = input.lighthouse.find((r) => r.strategy === "mobile" && sameUrl(r.url, home) && !r.error)
    ?? input.lighthouse.find((r) => r.strategy === "mobile" && !r.error);
  const homeDesktop = input.lighthouse.find((r) => r.strategy === "desktop" && sameUrl(r.url, home) && !r.error)
    ?? input.lighthouse.find((r) => r.strategy === "desktop" && !r.error);
  if (homeMobile) {
    scores.mobileSpeed = homeMobile.scores.performance;
    scores.accessibility = homeMobile.scores.accessibility;
    scores.bestPractices = homeMobile.scores["best-practices"];
    scores.googleBasics = homeMobile.scores.seo;
    scores.lcpMs = homeMobile.metrics.lcpMs;
    scores.cls = homeMobile.metrics.cls;
    scores.tbtMs = homeMobile.metrics.tbtMs;
  }
  if (homeDesktop) scores.desktopSpeed = homeDesktop.scores.performance;

  const speedIssues: LhIssue[] = [];
  for (const r of input.lighthouse) {
    if (r.error) continue;
    const perf = r.scores.performance;
    if (r.strategy === "mobile" && perf !== undefined && perf < 90) {
      const base = perf < 50 ? 85 : perf < 70 ? 70 : 50;
      const m = r.metrics;
      const vitals = [
        m.lcpMs !== undefined ? `main content shows in ${(m.lcpMs / 1000).toFixed(1)} s (${band("lcpMs", m.lcpMs)}; good is under 2.5 s)` : "",
        m.tbtMs !== undefined ? `page blocked for ${m.tbtMs} ms while loading (${band("tbtMs", m.tbtMs)})` : "",
        m.cls !== undefined ? `layout shift ${m.cls} (${band("cls", m.cls)})` : "",
      ].filter(Boolean).join("; ");
      hit("mobile-speed", r.url, `${pathOf(r.url)} on a phone: speed ${perf}/100; ${vitals}. Lighthouse lab test on a simulated mid-range phone over slow 4G.`, "lighthouse", base);
    }
    if (r.strategy === "mobile" && r.metrics.cls !== undefined && band("cls", r.metrics.cls) === "poor") {
      hit("page-jumps", r.url, `${pathOf(r.url)}: layout shift ${r.metrics.cls} (poor is over 0.25).`, "lighthouse");
    }
    for (const i of r.issues) {
      if (i.category === "performance") {
        if (r.strategy === "mobile") speedIssues.push(i);
        continue;
      }
      const key = LH_TO_FIX[i.id] ?? (i.severity === "info" ? undefined : "other-lighthouse");
      if (!key) continue;
      hit(key, r.url, `${pathOf(r.url)} (${r.strategy}): ${i.title}${i.displayValue ? ` (${i.displayValue})` : ""}${i.items.length ? `: ${i.items.slice(0, 2).join(", ")}` : ""}`, "lighthouse");
    }
  }
  const speed = acc.get("mobile-speed");
  if (speed) {
    const seen = new Set<string>();
    const steps: string[] = [];
    for (const i of speedIssues.sort((a, b) => (b.impactMs ?? 0) - (a.impactMs ?? 0) || (b.impactBytes ?? 0) - (a.impactBytes ?? 0))) {
      const w = SPEED_WORDS.find(([re]) => re.test(i.id))?.[1];
      if (w && !seen.has(w)) {
        seen.add(w);
        steps.push(w);
      }
      if (speed.evidence.length < 12) speed.evidence.push(`Lighthouse: ${i.title}${i.displayValue ? ` (${i.displayValue})` : ""}`);
    }
    speed.what = steps.length
      ? `Ask your web person to ${steps.slice(0, 3).join(", then ")}.`
      : "Ask your web person to make the home page lighter: smaller photos, fewer scripts and widgets.";
  }

  const all: Fix[] = [...acc.values()].map((a) => {
    const pagesSorted = [...a.pages.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
    const weight = pagesSorted.length ? pagesSorted[0]![1] : 1;
    const n = Math.max(1, pagesSorted.length);
    const impact = Math.min(100, Math.round((a.over ?? a.def.base) * weight + Math.min(8, 2 * (n - 1))));
    const tier: Tier = impact >= 60 ? "losing enquiries" : impact >= 30 ? "harder to find or trust" : "tidy-up";
    const minutes = Math.round(a.def.minutes * (["titles", "descriptions", "image-text", "share-preview"].includes(a.def.key) ? Math.min(4, 0.5 + n / 4) : 1));
    const words = input.kind === "online" ? ONLINE[a.def.key] : undefined;
    return {
      key: a.def.key, title: (words?.title ?? a.def.title)(n), what: a.what ?? words?.what ?? a.def.what, why: words?.why ?? a.def.why, who: a.def.who,
      effort: effortWords(minutes), minutes, impact, tier,
      pages: pagesSorted.map(([p]) => pathOf(p)).slice(0, 12), urls: pagesSorted.map(([p]) => p).slice(0, 50), pageCount: pagesSorted.length,
      evidence: a.evidence, sources: [...a.sources].sort(),
    };
  }).sort((x, y) => y.impact - x.impact || x.minutes - y.minutes || x.key.localeCompare(y.key));

  const good: string[] = [];
  const passed = new Set(input.conversion.filter((c) => c.pass).map((c) => c.check));
  if (passed.has("contact-above-fold-mobile")) good.push("Phone visitors see a way to reach you on the first screen.");
  if (passed.has("clear-offer")) good.push("The home page headline says what you do.");
  if (passed.has("proof")) good.push("Customer reviews or proof are on the site.");
  if (scores.mobileSpeed !== undefined && scores.mobileSpeed >= 90) good.push(`The site is fast on phones (${scores.mobileSpeed}/100).`);
  if (scores.accessibility !== undefined && scores.accessibility >= 90) good.push(`It is easy to read and use (${scores.accessibility}/100).`);
  if (input.site.https) good.push("It is secure (https).");

  return { top: all.filter((f) => f.impact >= TOP_MIN_IMPACT).slice(0, topN), all, scores, good, kind: input.kind };
}

function sameUrl(a: string, b: string): boolean {
  const n = (s: string) => s.replace(/\/+$/, "").toLowerCase();
  return n(a) === n(b);
}
