// Reading a page without a browser: what the server sent, as text. The crawler uses it when Chromium cannot start (or a
// page's render fails), so a site whose words are in its HTML (most small-business sites) is still read, instead of
// every page coming back empty. No scripts run, so a site that builds its content in the browser reads thin here; the
// crawl's own checks (selectKeyPages, whyUnreadable) say so then. Same output shape as the in-page capture script.
import type { Captured, ImageInfo } from "./page.js";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", middot: "·", pound: "£", euro: "€", copy: "©" };
const decode = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });

const clean = (s: string): string => decode(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][-\w:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    const k = m[1]!.toLowerCase();
    if (!(k in out)) out[k] = decode(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

const BLOCKS = /<\/?(?:p|div|section|article|header|footer|main|nav|aside|ul|ol|li|h[1-6]|br|tr|table|blockquote|figure|figcaption|form|dl|dt|dd|hr)\b[^>]*>/gi;

export function staticCapture(html: string, baseUrl: string): Captured {
  const head = html.slice(0, 400_000);
  const body = html.length > 2_000_000 ? html.slice(0, 2_000_000) : html;
  const metas = [...head.matchAll(/<meta\b[^>]*>/gi)].map((m) => attrs(m[0]));
  const meta = (key: string, by: "name" | "property" = "name") => metas.filter((m) => (m[by] ?? "").toLowerCase() === key);
  const titles = [...head.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title>/gi)].map((m) => clean(m[1]!));
  const descs = meta("description");
  const og: Record<string, string> = {};
  for (const m of metas) {
    const p = (m["property"] ?? "").toLowerCase();
    if (p.startsWith("og:") && m["content"]) og[p] ??= m["content"];
  }
  const links = [...head.matchAll(/<link\b[^>]*>/gi)].map((m) => attrs(m[0]));
  const canonical = links.find((l) => (l["rel"] ?? "").toLowerCase() === "canonical")?.["href"] ?? null;
  const iconLinks = links.filter((l) => /\bicon\b/i.test(l["rel"] ?? "") && l["href"])
    .map((l) => ({ href: l["href"]!, ...(l["sizes"] ? { sizes: l["sizes"] } : {}), rel: l["rel"]! })).slice(0, 12);

  const headings = (n: 1 | 2): string[] => [...body.matchAll(new RegExp(`<h${n}\\b[^>]*>([\\s\\S]*?)</h${n}>`, "gi"))].map((m) => clean(m[1]!)).filter(Boolean).slice(0, 60);

  const anchors = [...body.matchAll(/<a\b[^>]*>/gi)].map((m) => attrs(m[0])["href"] ?? null)
    .map((h) => (h && !/^(?:#|javascript:|mailto:|tel:)/i.test(h) ? h : null)).map((h) => { try { return h ? new URL(h, baseUrl).toString() : null; } catch { return null; } });

  const images: ImageInfo[] = [...body.matchAll(/<img\b[^>]*>/gi)].map((m) => attrs(m[0])).filter((a) => a["src"] || a["data-src"]).slice(0, 80).map((a) => {
    const w = Number.parseInt(a["width"] ?? "", 10) || 0;
    const h = Number.parseInt(a["height"] ?? "", 10) || 0;
    let src = a["src"] || a["data-src"]!;
    try { src = new URL(src, baseUrl).toString(); } catch { /* keep as written */ }
    return { src, alt: a["alt"] ?? null, width: w, height: h, naturalWidth: w, naturalHeight: h };
  });

  const jsonLd = [...body.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]!.trim()).filter(Boolean);

  const noScripts = body
    .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const footerHtml = /<footer\b[\s\S]*?<\/footer>/i.exec(noScripts)?.[0];
  const main = noScripts.replace(/<(nav|footer)\b[\s\S]*?<\/\1>/gi, " ");
  const toText = (h: string): string => decode(h.replace(BLOCKS, "\n").replace(/<[^>]*>/g, " ")).split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
  const html5 = /<html\b[^>]*>/i.exec(head)?.[0];

  return {
    title: titles[0] || null, titleCount: titles.length,
    metaDescription: descs[0]?.["content"]?.trim() || null, metaDescriptionCount: descs.length,
    canonical, robotsMeta: meta("robots")[0]?.["content"] ?? null,
    h1: headings(1), h2: headings(2), links: anchors, images, jsonLd, og,
    lang: html5 ? attrs(html5)["lang"] ?? null : null, viewport: meta("viewport")[0]?.["content"] ?? null,
    mixed: [], favicon: iconLinks[0]?.href ?? null, ...(iconLinks.length ? { iconLinks } : {}), logo: null,
    text: toText(main), ...(footerHtml ? { footer: toText(footerHtml) } : {}),
  };
}
