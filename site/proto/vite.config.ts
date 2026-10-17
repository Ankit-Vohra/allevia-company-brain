// The prototypes' own Vite config (issue #37): site/proto/ is served and built on its own, so the live site's build is untouched.
//   dev:     npx vite --config proto/vite.config.ts            (port 5191)
//   build:   npx vite build --config proto/vite.config.ts      (to site/dist-proto)
//   preview: npx vite preview --config proto/vite.config.ts    (port 4191)
// Pages: / (goes to /a/), /a/ (home with the 3D brain), /product/, /integrations/, /team/,
// /security/, /faq/, /contact/. /pricing/ is hidden for now: it is built, linked and served only with ALLEVIA_SITE_PRICING=1 (shared/flags.ts).
// `<!-- @section name -->` in a page is
// replaced at build time by the shared section (shared/sections.ts), so every page is complete HTML before any script runs.
// Tool logos are Simple Icons (CC0) drawn inline, plus Slack's local picture (shared/logos.ts). logo.dev is off unless a build sets ALLEVIA_SITE_LOGO_DEV=1
// and LOGO_DEV_KEY (environment, never committed); it needs a visible credit, so the site does not use it.
import "./env.ts"; // first: it sets LOGO_DEV_KEY before the shared modules read it
import { defineConfig, type Connect, type Plugin } from "vite";
import { fileURLToPath } from "node:url";
import { mainSite } from "./main-site.ts";
import { SECTIONS } from "./shared/sections.ts";
import { pricingVisible } from "./shared/flags.ts";
import { protoPages } from "./pages.ts";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

function sections(): Plugin {
  return {
    name: "proto-sections",
    transformIndexHtml: {
      order: "pre",
      handler(html, ctx) {
        const page = ctx.path.split("/").filter((x) => x && !x.endsWith(".html"))[0] ?? "index";
        return html.replace(/<!--\s*@section\s+([\w-]+)\s*-->/g, (_m, name: string) => {
          const make = SECTIONS[name];
          if (!make) throw new Error(`proto: no section named "${name}"`);
          return make(page);
        });
      },
    },
  };
}

/** While pricing is hidden, /pricing/ is a 404 in the dev and preview servers too (the page's source stays in pricing/index.html). */
function hidePricing(): Plugin {
  const refuse: Connect.NextHandleFunction = (req, res, next) => {
    if (!pricingVisible() && /^\/pricing(?:\/|\/index\.html)?(?:[?#].*)?$/.test(req.url ?? "")) {
      res.statusCode = 404;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("Not found");
      return;
    }
    next();
  };
  return { name: "proto-hide-pricing", configureServer(server) { server.middlewares.use(refuse); }, configurePreviewServer(server) { server.middlewares.use(refuse); } };
}

export default defineConfig({
  root: here("."),
  base: "./",
  publicDir: here("../public"),
  appType: "mpa",
  plugins: [hidePricing(), sections(), mainSite()],
  define: { __LOGO_DEV_KEY__: JSON.stringify(process.env.ALLEVIA_SITE_LOGO_DEV === "1" ? (process.env.LOGO_DEV_KEY ?? "") : "") },
  server: { port: 5191, strictPort: true, fs: { allow: [here("../..")] } },
  preview: { port: 4191, strictPort: true },
  build: {
    outDir: here("../dist-proto"),
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: { input: Object.fromEntries(protoPages().map((k) => [k, here(k === "index" ? "index.html" : `${k}/index.html`)])) },
  },
});
