import { defineConfig, type Plugin } from "vite";
import { fileURLToPath } from "node:url";
import { BLOCKS } from "./src/render/blocks.ts";
import { CONTACT_URL } from "./src/content.ts";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Swaps `<!-- @render name -->` in the pages for HTML built from shared/plans.ts and shared/roster.ts.
function renderBlocks(): Plugin {
  return {
    name: "allevia-render-blocks",
    transformIndexHtml(html) {
      return html
        .replace(/<!--\s*@render\s+([\w-]+)\s*-->/g, (_m, name: string) => {
          const block = BLOCKS[name];
          if (!block) throw new Error(`site: no render block named "${name}"`);
          return block();
        })
        .replaceAll("__CONTACT_URL__", CONTACT_URL);
    },
  };
}

export default defineConfig({
  appType: "mpa",
  plugins: [renderBlocks()],
  server: { port: 5180, fs: { allow: [here("..")] } },
  preview: { port: 4180 },
  build: {
    target: "es2022",
    rollupOptions: { input: { home: here("index.html"), pricing: here("pricing/index.html") } },
  },
});
