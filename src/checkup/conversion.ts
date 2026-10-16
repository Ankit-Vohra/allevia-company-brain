// Conversion checks for a small business: can a visitor who is ready to buy do it from the first screen, and does the
// page give them reasons to? Read from the rendered page (CONVERSION_SCRIPT, run by the crawler on the home and key
// pages, at desktop and phone size) and judged here, deterministically.
//   - a way to get in touch (call, WhatsApp, book, enquire, sign up) visible on the first screen, on a phone
//   - a clear offer: a headline that says what the business does, not "Welcome" or just its name
//   - proof: reviews, ratings, testimonials, client logos or numbers
//   - for a local business: opening hours and where it is
//   - tap targets big enough for a thumb (WCAG 2.2 target size, 24 x 24 CSS px)
// Everything a page says is untrusted data, measured and never obeyed. Phone numbers and e-mail addresses are never
// kept: a contact link is kept as its kind and its visible words, redacted.
import { redact } from "../ingest/privacy.js";

export type CtaKind = "call" | "whatsapp" | "book" | "enquire" | "signup" | "email" | "form";

export interface CtaSeen { kind: CtaKind; text: string; top: number; height: number; fixed: boolean; aboveFold: boolean }

// What the script returns for one page at one size.
export interface ConversionCapture {
  viewport: { width: number; height: number };
  ctas: CtaSeen[];
  forms: number;                 // forms with at least one text field (search boxes left out)
  firstScreenText: string;       // visible text in the first screen, at most 600 characters
  firstHeading: string | null;   // the first h1 (or the biggest heading) in the first screen
  proof: { testimonials: boolean; rating: boolean; reviewWidget: boolean; clientLogos: boolean; numbers: boolean; press?: boolean; snippet?: string };
  hours: { found: boolean; snippet?: string };
  location: { map: boolean; address: boolean; snippet?: string };
  smallTargets: { count: number; total: number; examples: string[] };
}

export interface PageConversion { url: string; desktop?: ConversionCapture; mobile?: ConversionCapture }

// Runs in the page; returns plain JSON. A string so no transpiled helpers reach the page (see website/page.ts).
export const CONVERSION_SCRIPT = String.raw`(() => {
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const vw = window.innerWidth, vh = window.innerHeight;
  const shown = (e) => {
    const r = e.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const cs = getComputedStyle(e);
    return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.1;
  };
  const isFixed = (e) => { for (let n = e; n && n !== document.body; n = n.parentElement) { const p = getComputedStyle(n).position; if (p === "fixed" || p === "sticky") return true; } return false; };
  const kindOf = (e) => {
    const href = (e.getAttribute("href") || "").trim().toLowerCase();
    const words = clean([e.innerText, e.getAttribute("aria-label"), e.getAttribute("title"), e.value].join(" ")).toLowerCase();
    if (href.startsWith("tel:")) return "call";
    if (/wa\.me\/|api\.whatsapp\.com|whatsapp:\/\/|web\.whatsapp\.com/.test(href) || /\bwhats ?app\b/.test(words)) return "whatsapp";
    if (/calendly\.com|cal\.com\/|booksy|fresha|setmore|acuityscheduling|simplybook|zcal|tidycal|opentable|resy\.com|zomato\.com\/.*book|practo/.test(href)) return "book";
    if (/\b(book|schedule|reserve|appointment|consultation|book a (call|demo|visit)|get a quote|request a quote|free quote|site visit)\b/.test(words)) return "book";
    if (/\b(sign ?up|get started|start (free|now|your)|try (it )?free|create (an )?account|join (now|free|us)|download (the )?app)\b/.test(words)) return "signup";
    if (/\b(call( us| now)?|phone)\b/.test(words) && words.length < 40) return "call";
    if (/\b(contact|enquire|enquiry|inquire|inquiry|get in touch|talk to us|message us|let'?s talk|write to us)\b/.test(words) || /\/(contact|enquir|inquir)/.test(href)) return "enquire";
    if (href.startsWith("mailto:")) return "email";
    return null;
  };
  const ctas = [];
  for (const e of [...document.querySelectorAll("a[href], button, input[type=submit], [role=button]")].slice(0, 1500)) {
    if (!shown(e)) continue;
    const kind = kindOf(e);
    if (!kind) continue;
    const r = e.getBoundingClientRect();
    const fixed = isFixed(e);
    const text = clean(e.innerText || e.getAttribute("aria-label") || e.getAttribute("title") || e.value || "").slice(0, 60);
    ctas.push({ kind, text, top: Math.round(r.top + (fixed ? 0 : window.scrollY)), height: Math.round(r.height), fixed, aboveFold: r.top < vh && r.bottom > 0 && r.left < vw });
    if (ctas.length >= 40) break;
  }
  const forms = [...document.querySelectorAll("form")].filter((f) => shown(f) && [...f.querySelectorAll("input, textarea")].some((i) => /^(text|email|tel|number|)$/i.test(i.getAttribute("type") || "") || i.tagName === "TEXTAREA") && !/search/i.test((f.getAttribute("role") || "") + (f.getAttribute("action") || "") + (f.className || ""))).length;
  // first screen: the visible text of elements that start inside it
  const parts = [];
  let firstHeading = null;
  let headSize = 0;
  for (const e of [...document.querySelectorAll("h1, h2, h3, p, span, div, a, li, strong")].slice(0, 3000)) {
    const r = e.getBoundingClientRect();
    if (r.top >= vh || r.bottom <= 0 || !shown(e)) continue;
    const own = [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" ");
    const t = clean(own);
    if (t) parts.push(t);
    if (/^H[1-3]$/.test(e.tagName) && clean(e.innerText)) {
      const size = parseFloat(getComputedStyle(e).fontSize) + (e.tagName === "H1" ? 100 : 0);
      if (size > headSize) { headSize = size; firstHeading = clean(e.innerText).slice(0, 160); }
    }
  }
  const all = clean(document.body ? document.body.innerText : "");
  const lower = all.toLowerCase();
  const hay = [...document.querySelectorAll("[class], [id]")].slice(0, 4000).map((e) => ((typeof e.className === "string" ? e.className : "") + " " + e.id).toLowerCase()).join(" ");
  const around = (re) => { const m = re.exec(all); return m ? all.slice(Math.max(0, m.index - 40), m.index + 80) : undefined; };
  const srcs = [...document.querySelectorAll("iframe[src], script[src], a[href]")].slice(0, 3000).map((e) => (e.getAttribute("src") || e.getAttribute("href") || "").toLowerCase());
  const ratingRe = /(\b[3-5][.,]\d\s*(\/\s*5|out of 5|stars?|★)|★★★★|\b\d{2,}\+?\s*(google )?reviews\b|rated\s+[3-5][.,]\d)/i;
  const testiRe = /\b(testimonials?|what (our )?(clients|customers|patients|guests|people) (say|said)|client stories|reviews|kind words|happy (clients|customers))\b/i;
  const numbersRe = /\b\d{2,}[+k]?\s*(\+\s*)?(happy |satisfied )?(clients|customers|projects|homes|years|families|students|businesses|users|patients|orders)\b/i;
  const hoursRe = /\b(mon(day)?|tue(sday)?|wed(nesday)?|thu(rsday)?|fri(day)?|sat(urday)?|sun(day)?)\b[^.\n]{0,40}\b\d{1,2}(:\d{2})?\s*(am|pm|a\.m\.|p\.m\.|hrs|:00)|\b(opening hours|business hours|open (daily|every day|24 ?(hours|\/7))|timings?)\b/i;
  const addressRe = /\b\d{6}\b|\b[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}\b|\b\d{5}(-\d{4})?\b(?=[^\d]{0,40}(usa|united states|[A-Z]{2}\b))|\b(road|street|st\.|nagar|marg|avenue|lane|sector|floor|plot|block|colony|chowk)\b/i;
  const hasClientLogos = /\b(clients|partners|trusted by|as seen in|featured in|our brands)\b/i.test(all) && document.querySelectorAll("img").length >= 6;
  // tap targets (phone only matters, but measured at every size): interactive elements smaller than 24x24 CSS px,
  // except links inside a sentence (WCAG 2.2's inline exception)
  let small = 0, total = 0;
  const examples = [];
  for (const e of [...document.querySelectorAll("a[href], button, input:not([type=hidden]), select, [role=button]")].slice(0, 1500)) {
    if (!shown(e)) continue;
    const r = e.getBoundingClientRect();
    if (e.tagName === "A") {
      const p = e.parentElement;
      const inline = getComputedStyle(e).display === "inline" && p && clean(p.innerText).length > clean(e.innerText).length + 20;
      if (inline) continue;
    }
    total++;
    if (r.width < 24 || r.height < 24) {
      small++;
      if (examples.length < 5) examples.push(clean(e.innerText || e.getAttribute("aria-label") || e.tagName.toLowerCase()).slice(0, 40) || e.tagName.toLowerCase());
    }
  }
  return {
    viewport: { width: vw, height: vh }, ctas, forms,
    firstScreenText: clean(parts.join(" ")).slice(0, 600), firstHeading,
    proof: {
      testimonials: testiRe.test(all) || /testimonial|review/.test(hay), rating: ratingRe.test(all),
      reviewWidget: srcs.some((s) => /elfsight|trustindex|trustpilot|reviews\.io|yotpo|judge\.me|google\.com\/maps\/.*review|featurable|embedsocial|birdeye/.test(s)),
      clientLogos: hasClientLogos, numbers: numbersRe.test(all), press: /\b(awards?|award-winning|featured in|as seen in|press|published in|recogni[sz]ed by)\b/i.test(all), snippet: around(ratingRe) || around(testiRe) || around(numbersRe),
    },
    hours: { found: hoursRe.test(all), snippet: around(hoursRe) },
    location: {
      map: srcs.some((s) => /google\.[a-z.]+\/maps|maps\.google\.|goo\.gl\/maps|maps\.app\.goo\.gl|openstreetmap|apple\.com\/maps|bing\.com\/maps/.test(s)),
      address: addressRe.test(all), snippet: around(addressRe),
    },
    smallTargets: { count: small, total, examples },
  };
})()`;

const scrub = (s: string | undefined): string | undefined => (s === undefined ? undefined : redact(s).text);

// The capture with its prose redacted (a phone number in a button's words or an address in a snippet).
export function redactCapture(c: ConversionCapture): ConversionCapture {
  return {
    ...c,
    ctas: c.ctas.map((x) => ({ ...x, text: scrub(x.text) ?? "" })),
    firstScreenText: scrub(c.firstScreenText) ?? "",
    firstHeading: c.firstHeading === null ? null : scrub(c.firstHeading) ?? null,
    proof: { ...c.proof, ...(c.proof.snippet ? { snippet: scrub(c.proof.snippet) } : {}) },
    hours: { ...c.hours, ...(c.hours.snippet ? { snippet: scrub(c.hours.snippet) } : {}) },
    location: { ...c.location, ...(c.location.snippet ? { snippet: scrub(c.location.snippet) } : {}) },
  };
}

// ---------- judging ----------

export type BusinessKind = "local" | "online";

export interface ConversionFinding {
  check: ConversionCheck;
  pass: boolean;
  base?: number;             // a weaker failure than the check's usual one (proof: numbers or awards but no reviews)
  page: string;
  evidence: string;          // plain, specific: what was seen
}

export const CONVERSION_CHECKS = [
  "contact-above-fold-mobile", "contact-path", "clear-offer", "proof", "opening-hours", "location", "tap-targets",
] as const;
export type ConversionCheck = (typeof CONVERSION_CHECKS)[number];

const WEAK_HEADLINE = /^(welcome( to)?|home|hello|hi|about( us)?|untitled|coming soon|menu)\b/i;
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const KIND_WORD: Record<CtaKind, string> = {
  call: "a call button", whatsapp: "a WhatsApp button", book: "a booking button", enquire: "an enquiry button",
  signup: "a sign-up button", email: "an e-mail link", form: "a form",
};

// Is the headline a promise ("Interiors for homes in Raipur") or a greeting / just the name ("Welcome to AVS")?
export function headlineSaysWhat(headline: string | null, businessName?: string): boolean {
  if (!headline) return false;
  const h = headline.trim();
  if (WEAK_HEADLINE.test(h)) return false;
  if (businessName) {
    const strip = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const rest = strip(h).replace(strip(businessName), "").trim();
    if (words(rest) < 2) return false;
  }
  return words(h) >= 3;
}

const KEY_CTA: CtaKind[] = ["call", "whatsapp", "book", "enquire", "signup"];

// One page's conversion results. The home page carries the first-screen checks; hours and location are judged on
// the site as a whole (judgeSite) because they often live on the contact page.
export function judgePage(p: PageConversion, opts: { home: boolean; businessName?: string }): ConversionFinding[] {
  const out: ConversionFinding[] = [];
  const m = p.mobile;
  const d = p.desktop;
  if (opts.home && m) {
    const first = m.ctas.filter((c) => c.aboveFold && KEY_CTA.includes(c.kind));
    const anyKey = m.ctas.filter((c) => KEY_CTA.includes(c.kind));
    out.push({
      check: "contact-above-fold-mobile", page: p.url, pass: first.length > 0,
      evidence: first.length
        ? `On a phone the first screen shows ${KIND_WORD[first[0]!.kind]}${first[0]!.text ? ` ("${first[0]!.text}")` : ""}.`
        : anyKey.length
          ? `On a phone the first screen has no call, WhatsApp, booking, sign-up or enquiry button; the first one (${!anyKey[0]!.text || anyKey[0]!.text.includes("[redacted") ? KIND_WORD[anyKey[0]!.kind] : `"${anyKey[0]!.text}"`}) is ${Math.max(1, Math.round(anyKey[0]!.top / m.viewport.height))} screens down.`
          : "On a phone there is no call, WhatsApp, booking or enquiry button anywhere on the home page.",
    });
  }
  if (opts.home) {
    const shot = d ?? m;
    if (shot) {
      const ok = headlineSaysWhat(shot.firstHeading, opts.businessName);
      out.push({
        check: "clear-offer", page: p.url, pass: ok,
        evidence: shot.firstHeading ? `The first screen's headline is "${shot.firstHeading}".` : "The first screen has no headline.",
      });
    }
  }
  const small = m?.smallTargets;
  if (small && small.total >= 5) {
    const share = small.count / small.total;
    out.push({
      check: "tap-targets", page: p.url, pass: small.count < 3 || share < 0.15,
      evidence: `${small.count} of ${small.total} buttons and links are smaller than a fingertip (24 px) on a phone${small.examples.length ? `, e.g. ${small.examples.slice(0, 3).map((e) => `"${e}"`).join(", ")}` : ""}.`,
    });
  }
  return out;
}

export interface SiteSignals {
  kind: BusinessKind;
  jsonLdTypes: string[];          // across the crawl
  jsonLdHasHours: boolean;
  jsonLdHasAddress: boolean;
  jsonLdHasRating: boolean;
  contactPageFound: boolean;      // a crawled /contact-like page
}

// Site-wide: is there any way to get in touch, proof, hours and location (local businesses only).
export function judgeSite(pages: PageConversion[], home: string, s: SiteSignals): ConversionFinding[] {
  const caps = pages.flatMap((p) => [p.desktop, p.mobile].filter((c): c is ConversionCapture => !!c).map((c) => ({ p, c })));
  if (!caps.length) return [];
  const out: ConversionFinding[] = [];
  const keyCtas = caps.flatMap(({ c }) => c.ctas.filter((x) => KEY_CTA.includes(x.kind)));
  const forms = caps.some(({ c }) => c.forms > 0);
  const kinds = [...new Set(keyCtas.map((x) => x.kind))];
  out.push({
    check: "contact-path", page: home, pass: kinds.length > 0 || forms || s.contactPageFound,
    evidence: kinds.length || forms
      ? `Ways to get in touch found: ${[...kinds.map((k) => KIND_WORD[k]), ...(forms ? ["a form"] : [])].join(", ")}.`
      : s.contactPageFound ? "There is a contact page, but no call, WhatsApp, booking or enquiry button on the pages checked."
        : "No call, WhatsApp, booking or enquiry button, form or contact page was found on the pages checked.",
  });
  const proofHit = caps.find(({ c }) => c.proof.rating || c.proof.testimonials || c.proof.reviewWidget);
  const softProof = caps.find(({ c }) => c.proof.numbers || c.proof.clientLogos || c.proof.press);
  out.push({
    check: "proof", page: home, pass: !!proofHit || s.jsonLdHasRating, ...(!proofHit && !s.jsonLdHasRating && softProof ? { base: 45 } : {}),
    evidence: proofHit ? `Found reviews or testimonials${proofHit.c.proof.snippet ? `: "${proofHit.c.proof.snippet.trim()}"` : ""} (${new URL(proofHit.p.url).pathname}).`
      : s.jsonLdHasRating ? "A rating is in the page's structured data."
        : softProof ? `No customer reviews or testimonials on the pages checked; only numbers, awards or client names${softProof.c.proof.snippet ? ` ("${softProof.c.proof.snippet.trim()}")` : ""}.`
          : "No reviews, ratings or testimonials on the pages checked.",
  });
  if (s.kind === "local") {
    const hrs = caps.find(({ c }) => c.hours.found);
    out.push({
      check: "opening-hours", page: home, pass: !!hrs || s.jsonLdHasHours,
      evidence: hrs ? `Opening hours found${hrs.c.hours.snippet ? `: "${hrs.c.hours.snippet.trim()}"` : ""}.` : s.jsonLdHasHours ? "Hours are in the structured data only, not on the page." : "No opening hours on the pages checked.",
    });
    const map = caps.find(({ c }) => c.location.map);
    const addr = caps.find(({ c }) => c.location.address);
    out.push({
      check: "location", page: home, pass: !!map || !!addr || s.jsonLdHasAddress,
      evidence: map ? "A map or map link is on the site." : addr ? `An address is on the site${addr.c.location.snippet ? ` ("${addr.c.location.snippet.trim()}")` : ""}.`
        : s.jsonLdHasAddress ? "The address is in the structured data only." : "No address or map on the pages checked.",
    });
  }
  return out;
}

const LOCAL_TYPES = /LocalBusiness|Store|Restaurant|Cafe|Dentist|Physician|MedicalClinic|HomeAndConstructionBusiness|ProfessionalService|BeautySalon|HealthAndBeautyBusiness|LodgingBusiness|AutoRepair|RealEstateAgent|LegalService|Plumber|Electrician|GeneralContractor|InteriorDesign|FoodEstablishment/;

// Local (people visit, call or are visited) or online (sign up, buy online), from what the site shows.
export function guessKind(pages: PageConversion[], jsonLdTypes: string[]): BusinessKind {
  if (jsonLdTypes.some((t) => LOCAL_TYPES.test(t))) return "local";
  const caps = pages.flatMap((p) => [p.desktop, p.mobile].filter((c): c is ConversionCapture => !!c));
  const signup = caps.some((c) => c.ctas.some((x) => x.kind === "signup"));
  const local = caps.some((c) => c.location.map || c.ctas.some((x) => x.kind === "call" || x.kind === "whatsapp"));
  return signup && !local ? "online" : "local";
}
