import { defineConfig, type Plugin } from "vite";
import { fileURLToPath } from "node:url";
import { BLOCKS, PAGE_TOKENS } from "./src/render/blocks.ts";
import { head, pageForRequest } from "./src/render/head.ts";
import { CONTACT_URL, SITE_URL } from "./src/config.ts";
import { PAGES, pageFile } from "./src/pages.ts";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Typographer's quotes and apostrophes in text (never inside tags, attributes, scripts or styles).
function smartQuotes(html: string): string {
  let raw = false;
  return html
    .split(/(<[^>]*>)/)
    .map((part) => {
      if (part.startsWith("<")) {
        if (/^<(script|style)\b/i.test(part)) raw = true;
        else if (/^<\/(script|style)>/i.test(part)) raw = false;
        return part;
      }
      if (raw) return part;
      return part
        .replace(/&quot;/g, '"')
        .replace(/(^|[\s(\[—–])"/g, "$1“")
        .replace(/"/g, "”")
        .replace(/(\w)'(\w)/g, "$1’$2")
        .replace(/(^|[\s(\[])'/g, "$1‘")
        .replace(/'/g, "’");
    })
    .join("");
}

// Swaps `<!-- @head -->` for the page's head (title, cards, structured data, the script tag). It runs before Vite reads the
// page so the script it adds is bundled like any other.
function renderHead(): Plugin {
  return {
    name: "allevia-render-head",
    transformIndexHtml: {
      order: "pre",
      handler(html, ctx) {
        return html.replace(/<!--\s*@head\s*-->/, () => {
          const page = pageForRequest(ctx.path);
          if (!page) throw new Error(`site: no page in src/pages.ts for ${ctx.path}`);
          return head(page);
        });
      },
    },
  };
}

// Swaps `<!-- @render name -->` in the pages for HTML built from shared/plans.ts, shared/roster.ts and the copy in
// src/render, and the team-size tokens (__STAFF_WORD__ and the rest, see PAGE_TOKENS) for the roster's counts.
function renderBlocks(): Plugin {
  return {
    name: "allevia-render-blocks",
    transformIndexHtml(html, ctx) {
      const page = pageForRequest(ctx.path);
      const current = page?.path ?? "/";
      const out = html
        .replace(/<!--\s*@render\s+([\w-]+)\s*-->/g, (_m, name: string) => {
          const block = BLOCKS[name];
          if (!block) throw new Error(`site: no render block named "${name}"`);
          return block(current);
        })
        .replaceAll("__CONTACT_URL__", CONTACT_URL);
      const sized = Object.entries(PAGE_TOKENS).reduce((h, [token, value]) => h.replaceAll(token, value), out);
      return smartQuotes(sized);
    },
  };
}

// sitemap.xml and robots.txt, from the page registry and SITE_URL.
function seoFiles(): Plugin {
  return {
    name: "allevia-seo-files",
    generateBundle() {
      const day = new Date().toISOString().slice(0, 10);
      const urls = PAGES.map(
        (p) => `  <url>\n    <loc>${SITE_URL}${p.path}</loc>\n    <lastmod>${day}</lastmod>\n    <changefreq>${p.changefreq}</changefreq>\n    <priority>${p.priority.toFixed(1)}</priority>\n  </url>`,
      ).join("\n");
      this.emitFile({ type: "asset", fileName: "sitemap.xml", source: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n` });
      this.emitFile({ type: "asset", fileName: "robots.txt", source: `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n` });
    },
  };
}

export default defineConfig({
  appType: "mpa",
  plugins: [renderHead(), renderBlocks(), seoFiles()],
  server: { port: 5180, fs: { allow: [here("..")] } },
  preview: { port: 4180 },
  build: {
    target: "es2022",
    rollupOptions: {
      input: Object.fromEntries(PAGES.map((p) => [p.path === "/" ? "home" : p.path.replaceAll("/", ""), here(pageFile(p.path))])),
    },
  },
});
