// What the crawler keeps about one page, and the scripts that read it out of the rendered DOM. The scripts are plain
// strings run with page.evaluate: TypeScript here has no DOM types, and a transpiled function could carry helper calls
// (esbuild's __name) that do not exist in the page. Everything a page says is untrusted data: it is stored and
// measured, never obeyed.
import { cutText } from "../../extract-schema.js";
import { redact } from "../../privacy.js";
import { normalizeUrl, toSiteUrl } from "./urls.js";

export const MAX_TEXT_CHARS = 8_000;

export interface ImageInfo { src: string; alt: string | null; width: number; height: number; naturalWidth: number; naturalHeight: number }

export interface LogoCandidate { kind: "img" | "svg"; src?: string; svg?: string; alt?: string; inHeader: boolean; keyword: boolean; width: number; height: number }

export interface StyleSample {
  kind: "bg" | "text" | "border";
  color: string;              // computed CSS colour, e.g. "rgb(17, 17, 17)"
  weight: number;             // px² for backgrounds, characters for text, px of edge for borders
  role: "button" | "link" | "heading" | "other";
  font?: string;              // computed font-family (text samples)
}

export interface PageTiming { responseMs: number; fetchMs: number; loadMs?: number }

export interface PageData {
  url: string;                // the URL the crawler asked for (normalised)
  finalUrl: string;           // after redirects; the page's identity
  redirects: string[];
  status: number;
  contentType?: string;
  fetchedAt: string;          // ISO timestamp
  bytes: number;
  truncated?: boolean;
  title?: string;
  titleCount: number;
  metaDescription?: string;
  metaDescriptionCount: number;
  canonical?: string;
  robotsMeta?: string;        // meta robots/googlebot content plus any X-Robots-Tag header
  h1: string[];
  h2: string[];
  text: string;               // main visible text, at most MAX_TEXT_CHARS
  wordCount: number;          // of the whole main text, before the cut
  internalLinks: string[];    // normalised, same site, deduplicated
  externalLinks: string[];
  images: ImageInfo[];
  jsonLd: unknown[];          // parsed blocks (invalid ones are counted in jsonLdErrors)
  jsonLdTypes: string[];
  jsonLdErrors: number;
  og: Record<string, string>;
  lang?: string;
  viewport?: string;
  timing: PageTiming;
  mixedContent: string[];     // http:// resources on an https page
  favicon?: string;
  logo?: LogoCandidate;
  styles?: StyleSample[];     // only on brand pages (home plus a few key pages)
  error?: string;
}

// Runs in the page. Returns plain JSON.
export const CAPTURE_SCRIPT = String.raw`(() => {
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const abs = (u) => { try { return u ? new URL(u, document.baseURI).href : null; } catch { return null; } };
  const attr = (sel, a) => { const e = document.querySelector(sel); return e ? e.getAttribute(a) : null; };
  const metas = (name) => [...document.querySelectorAll("meta[name]")].filter((m) => (m.getAttribute("name") || "").toLowerCase() === name);
  const titles = [...document.querySelectorAll("title")].filter((t) => !t.closest("svg"));
  const desc = metas("description");
  const robots = [...metas("robots"), ...metas("googlebot")].map((m) => m.getAttribute("content") || "").join(", ");
  const og = {};
  for (const m of document.querySelectorAll("meta[property^='og:'], meta[name^='og:']")) {
    const k = (m.getAttribute("property") || m.getAttribute("name") || "").toLowerCase();
    if (k && !(k in og)) og[k] = clean(m.getAttribute("content")).slice(0, 500);
  }
  const heads = (tag) => [...document.querySelectorAll(tag)].map((e) => clean(e.textContent).slice(0, 300)).filter(Boolean);
  const links = [...document.querySelectorAll("a[href]")].slice(0, 2000).map((a) => a.getAttribute("href"));
  const images = [...document.querySelectorAll("img")].slice(0, 300).map((i) => ({
    src: i.currentSrc || abs(i.getAttribute("src") || i.getAttribute("data-src") || "") || "",
    alt: i.hasAttribute("alt") ? i.getAttribute("alt") : null,
    width: Math.round(i.getBoundingClientRect().width), height: Math.round(i.getBoundingClientRect().height),
    naturalWidth: i.naturalWidth || 0, naturalHeight: i.naturalHeight || 0,
  }));
  const jsonLd = [...document.querySelectorAll("script[type='application/ld+json' i]")].slice(0, 30).map((s) => (s.textContent || "").slice(0, 100000));
  const mixed = [];
  if (location.protocol === "https:") {
    for (const e of document.querySelectorAll("img[src], script[src], iframe[src], video[src], audio[src], source[src], link[rel~='stylesheet' i][href]")) {
      const u = e.getAttribute("src") || e.getAttribute("href") || "";
      if (/^http:\/\//i.test(u)) mixed.push(u.slice(0, 300));
    }
  }
  const icon = [...document.querySelectorAll("link[rel]")].find((l) => /(^|\s)(icon|shortcut icon|apple-touch-icon)(\s|$)/i.test(l.getAttribute("rel") || ""));
  // logo: an image or svg named "logo"/"brand", or one inside the header's link to the home page; never an icon (small,
  // inside a button, or in some other link such as a call to action)
  const header = document.querySelector("header, [role='banner'], #header, .header, .site-header");
  const visible = (e) => { const r = e.getBoundingClientRect(); return r.width >= 20 && r.height >= 12 && !e.closest("button"); };
  const logoCands = [...document.querySelectorAll("img, svg")].slice(0, 400).filter((e) => !e.closest("svg") || e.tagName.toLowerCase() === "svg").map((e) => {
    const tag = e.tagName.toLowerCase();
    const hay = [e.getAttribute("class"), e.getAttribute("id"), e.getAttribute("alt"), e.getAttribute("src"), e.getAttribute("aria-label"),
      e.parentElement && e.parentElement.getAttribute("class"), e.closest("a") && e.closest("a").getAttribute("class")].join(" ");
    const home = e.closest("a") && /^(\/|\.\/|index\.html?|#?)$/.test((e.closest("a").getAttribute("href") || "").replace(location.origin, ""));
    return { e, tag, home: !!home, keyword: /logo|brand/i.test(hay), inHeader: !!(header && header.contains(e)) || !!e.closest("nav") || !!home };
  }).filter((c) => (c.keyword || c.home) && visible(c.e));
  const best = logoCands.find((c) => c.keyword && c.inHeader) || logoCands.find((c) => c.home && c.inHeader) || logoCands.find((c) => c.keyword) || logoCands.find((c) => c.home);
  let logo = null;
  if (best) {
    const r = best.e.getBoundingClientRect();
    logo = best.tag === "img"
      ? { kind: "img", src: best.e.currentSrc || abs(best.e.getAttribute("src")), alt: best.e.getAttribute("alt") || undefined, inHeader: best.inHeader, keyword: best.keyword, width: Math.round(r.width), height: Math.round(r.height) }
      : { kind: "svg", svg: best.e.outerHTML.slice(0, 20000), alt: best.e.getAttribute("aria-label") || undefined, inHeader: best.inHeader, keyword: best.keyword, width: Math.round(r.width), height: Math.round(r.height) };
  }
  // main text: <main> if there is one, else the body without site navigation and footer
  const main = document.querySelector("main, [role='main']");
  let text = "";
  if (main) text = main.innerText || "";
  else {
    const hide = [...document.querySelectorAll("nav, footer, [role='navigation'], [role='contentinfo'], body > header, [role='banner']")];
    const prev = hide.map((e) => e.style.display);
    hide.forEach((e) => { e.style.display = "none"; });
    text = document.body ? document.body.innerText || "" : "";
    hide.forEach((e, i) => { e.style.display = prev[i]; });
  }
  return {
    title: titles.length ? clean(titles[0].textContent) : null, titleCount: titles.length,
    metaDescription: desc.length ? clean(desc[0].getAttribute("content")) : null, metaDescriptionCount: desc.length,
    canonical: abs(attr("link[rel~='canonical' i]", "href")), robotsMeta: robots || null,
    h1: heads("h1"), h2: heads("h2").slice(0, 40), links, images, jsonLd, og,
    lang: document.documentElement.getAttribute("lang") || null, viewport: (metas("viewport")[0] || { getAttribute: () => null }).getAttribute("content"),
    mixed: [...new Set(mixed)].slice(0, 50), favicon: icon ? abs(icon.getAttribute("href")) : null, logo,
    text: text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(),
  };
})()`;

// Runs in the page (brand pages only): computed colours and fonts of visible elements, weighted by how much of the
// page they cover. Capped so a huge DOM cannot stall the crawl.
export const STYLE_SCRIPT = String.raw`(() => {
  const out = [];
  const vw = Math.max(document.documentElement.clientWidth, 1), vh = 4 * Math.max(document.documentElement.clientHeight, 1);
  const transparent = (c) => !c || c === "transparent" || /rgba\([^)]*,\s*0(\.0+)?\)$/.test(c);
  const own = (el) => { let n = 0; for (const c of el.childNodes) if (c.nodeType === 3) n += c.textContent.trim().length; return n; };
  const roleOf = (el) => {
    const tag = el.tagName.toLowerCase();
    const cls = typeof el.className === "string" ? el.className : "";
    if (tag === "button" || el.getAttribute("role") === "button" || /\b(btn|button|cta)\b/i.test(cls) || (tag === "input" && /submit|button/.test(el.type))) return "button";
    if (tag === "a") return "link";
    if (/^h[1-6]$/.test(tag)) return "heading";
    return "other";
  };
  const root = getComputedStyle(document.documentElement).backgroundColor;
  const body = document.body ? getComputedStyle(document.body).backgroundColor : "";
  const page = !transparent(body) ? body : !transparent(root) ? root : "rgb(255, 255, 255)";
  out.push({ kind: "bg", color: page, weight: vw * vh * 0.5, role: "other" });
  let n = 0;
  for (const el of document.querySelectorAll("body *")) {
    if (++n > 3000 || out.length > 4000) break;
    const tag = el.tagName.toLowerCase();
    if (["script", "style", "noscript", "template", "svg", "path", "img", "video", "iframe", "br", "meta", "link"].includes(tag)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > vh) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) < 0.3) continue;
    const role = roleOf(el.closest("a, button, [role='button'], .btn, .button") || el);
    const area = Math.min(r.width, vw) * Math.min(r.height, vh);
    if (!transparent(cs.backgroundColor) && cs.backgroundImage === "none") out.push({ kind: "bg", color: cs.backgroundColor, weight: Math.round(area), role });
    const len = own(el);
    if (len > 0) out.push({ kind: "text", color: cs.color, weight: Math.min(len, 2000), role: /^h[1-6]$/.test(tag) ? "heading" : role, font: cs.fontFamily });
    if ((role === "button" || role === "link") && parseFloat(cs.borderTopWidth) >= 1 && cs.borderTopStyle !== "none" && !transparent(cs.borderTopColor)) {
      out.push({ kind: "border", color: cs.borderTopColor, weight: Math.round(2 * (r.width + r.height)), role });
    }
  }
  return out;
})()`;

// What the capture script returns.
export interface Captured {
  title: string | null; titleCount: number; metaDescription: string | null; metaDescriptionCount: number;
  canonical: string | null; robotsMeta: string | null; h1: string[]; h2: string[]; links: Array<string | null>;
  images: ImageInfo[]; jsonLd: string[]; og: Record<string, string>; lang: string | null; viewport: string | null;
  mixed: string[]; favicon: string | null; logo: LogoCandidate | null; text: string;
}

export const countWords = (s: string): number => (s.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;

// "@type" values anywhere in a JSON-LD block (including inside @graph and nested objects).
export function jsonLdTypes(blocks: unknown[]): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, depth: number): void => {
    if (depth > 8 || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) return v.slice(0, 200).forEach((x) => walk(x, depth + 1));
    const o = v as Record<string, unknown>;
    const t = o["@type"];
    for (const x of Array.isArray(t) ? t : [t]) if (typeof x === "string" && x.length < 80) out.add(x);
    for (const x of Object.values(o)) walk(x, depth + 1);
  };
  walk(blocks, 0);
  return [...out];
}

// ---------- privacy ----------
// Everything a page says in words goes through the privacy filter (redact, spec 6.3) before it is kept: the business's
// own email and phone on its contact page, an address in a title or a JSON-LD block, a key pasted into a page. The filter
// runs once, where the crawler builds PageData (fromCapture), so the text that becomes a Page, Document or Chunk, the
// text a model reads, and the evidence an SEO check quotes are all the redacted text. onboard() runs `redactPage` over
// whatever a crawler hands it as well (it is idempotent), so a crawler that did not filter is no way round it.
// Not filtered, on purpose: URLs (page, canonical, links, og:image, redirects) are identifiers, not prose, and a
// profile link such as instagram.com/<handle> must reach findSocials intact; JSON-LD `sameAs` is the same list of links.
// Counts (wordCount, links, images) measure the real page and stay as they were.

const scrub = (s: string): string => redact(s).text;
const isUrl = (s: string): boolean => /^https?:\/\/\S+$/i.test(s);

// Every string in a JSON-LD block except the sameAs profile links. Deeper than 16 levels is dropped: no real block is.
function redactJsonLd(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return scrub(v);
  if (v === null || typeof v !== "object") return v;
  if (depth > 16) return null;
  if (Array.isArray(v)) return v.map((x) => redactJsonLd(x, depth + 1));
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, k === "sameAs" ? x : redactJsonLd(x, depth + 1)]));
}

// A copy of the page whose prose is redacted: main text, title, meta description, headings, Open Graph text (not its
// URLs), JSON-LD strings and the error line.
export function redactPage(p: PageData): PageData {
  return {
    ...p,
    ...(p.title !== undefined ? { title: scrub(p.title) } : {}),
    ...(p.metaDescription !== undefined ? { metaDescription: scrub(p.metaDescription) } : {}),
    ...(p.error !== undefined ? { error: scrub(p.error) } : {}),
    h1: p.h1.map(scrub),
    h2: p.h2.map(scrub),
    text: scrub(p.text),
    jsonLd: p.jsonLd.map((b) => redactJsonLd(b)),
    og: Object.fromEntries(Object.entries(p.og).map(([k, v]) => [k, isUrl(v) ? v : scrub(v)])),
  };
}

// Turn the capture into PageData's DOM fields. Links are normalised and split into this site's and everyone else's.
// The prose is redacted here (see above): the main text before it is cut to MAX_TEXT_CHARS, so an address that straddles
// the limit never leaves a fragment, and the word count is of the page as it was.
export function fromCapture(c: Captured, origin: string): Pick<PageData,
  "title" | "titleCount" | "metaDescription" | "metaDescriptionCount" | "canonical" | "robotsMeta" | "h1" | "h2" | "text" |
  "wordCount" | "internalLinks" | "externalLinks" | "images" | "jsonLd" | "jsonLdTypes" | "jsonLdErrors" | "og" | "lang" |
  "viewport" | "mixedContent" | "favicon" | "logo"> {
  const internal = new Set<string>();
  const external = new Set<string>();
  for (const href of c.links) {
    const n = href ? normalizeUrl(href, origin) : null;
    if (!n) continue;
    const site = toSiteUrl(n, origin);
    if (site) internal.add(site);
    else external.add(n);
  }
  const jsonLd: unknown[] = [];
  let jsonLdErrors = 0;
  for (const s of c.jsonLd) {
    try {
      jsonLd.push(redactJsonLd(JSON.parse(s)));
    } catch {
      jsonLdErrors++;
    }
  }
  const text = c.text ?? "";
  const opt = <T>(v: T | null | undefined): T | undefined => (v === null || v === undefined || v === "" ? undefined : v);
  const prose = (v: string | null | undefined): string | undefined => opt(v === null || v === undefined ? v : scrub(v));
  return {
    title: prose(c.title), titleCount: c.titleCount, metaDescription: prose(c.metaDescription), metaDescriptionCount: c.metaDescriptionCount,
    canonical: opt(c.canonical), robotsMeta: opt(c.robotsMeta), h1: c.h1.map(scrub), h2: c.h2.map(scrub),
    text: cutText(scrub(text), MAX_TEXT_CHARS), wordCount: countWords(text),
    internalLinks: [...internal].slice(0, 500), externalLinks: [...external].slice(0, 300),
    images: c.images, jsonLd, jsonLdTypes: jsonLdTypes(jsonLd), jsonLdErrors, og: Object.fromEntries(Object.entries(c.og).map(([k, v]) => [k, isUrl(v) ? v : scrub(v)])),
    lang: opt(c.lang), viewport: opt(c.viewport),
    mixedContent: c.mixed, favicon: opt(c.favicon), logo: c.logo ?? undefined,
  };
}

// ~800-character passages on paragraph boundaries, at most `max` of them.
export function chunkText(text: string, size = 800, max = 10): string[] {
  const paras = text.split(/\n{2,}|\n/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  for (const p of paras) {
    if (cur && cur.length + p.length + 1 > size) {
      out.push(cur);
      cur = "";
      if (out.length >= max) return out;
    }
    cur = cur ? `${cur}\n${p}` : p.length > size * 2 ? cutText(p, size * 2) : p;
  }
  if (cur && out.length < max) out.push(cur);
  return out;
}
