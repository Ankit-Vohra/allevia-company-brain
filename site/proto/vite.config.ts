// The prototypes' own Vite config (issue #37): site/proto/ is served and built on its own, so the live site's build is untouched.
//   dev:     npx vite --config proto/vite.config.ts            (port 5191)
//   build:   npx vite build --config proto/vite.config.ts      (to site/dist-proto)
//   preview: npx vite preview --config proto/vite.config.ts    (port 4191)
// Pages: / (goes to /a/), /a/ (home with the 3D brain), /product/, /integrations/, /team/, /pricing/,
// /security/, /faq/, /contact/. `<!-- @section name -->` in a page is
// replaced at build time by the shared section (shared/sections.ts), so every page is complete HTML before any script runs.
// Tool logos are Simple Icons (CC0) drawn inline, plus Slack's local picture (shared/logos.ts). logo.dev is off unless a build sets ALLEVIA_SITE_LOGO_DEV=1
// and LOGO_DEV_KEY (environment, never committed); it needs a visible credit, so the site does not use it.
import "./env.ts"; // first: it sets LOGO_DEV_KEY before the shared modules read it
import { defineConfig, type Plugin } from "vite";
import { fileURLToPath } from "node:url";
import { mainSite } from "./main-site.ts";
import { SECTIONS } from "./shared/sections.ts";

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

export default defineConfig({
  root: here("."),
  base: "./",
  publicDir: here("../public"),
  appType: "mpa",
  plugins: [sections(), mainSite()],
  define: { __LOGO_DEV_KEY__: JSON.stringify(process.env.ALLEVIA_SITE_LOGO_DEV === "1" ? (process.env.LOGO_DEV_KEY ?? "") : "") },
  server: { port: 5191, strictPort: true, fs: { allow: [here("../..")] } },
  preview: { port: 4191, strictPort: true },
  build: {
    outDir: here("../dist-proto"),
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: { input: Object.fromEntries(["index", "a", "product", "integrations", "team", "pricing", "security", "faq", "contact"].map((k) => [k, here(k === "index" ? "index.html" : `${k}/index.html`)])) },
  },
});
