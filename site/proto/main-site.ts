// Preview only: the prototype's footer links to the pages that stay on the main site (About and the legal pages). So those links work when
// you click through the built prototypes, the preview server serves them from a local build of the main site (site/dist-main, made with
// `npx vite build --outDir dist-main` in site/). Nothing here is part of the prototype pages or of what would be published.
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Connect, Plugin } from "vite";

const MAIN_PAGES = new Set(["about", "privacy", "terms", "cookies", "data-deletion"]);
const TYPES: Record<string, string> = { ".css": "text/css", ".js": "text/javascript", ".woff2": "font/woff2", ".woff": "font/woff", ".webp": "image/webp", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".mp4": "video/mp4", ".json": "application/json" };

export function mainSite(): Plugin {
  const main = fileURLToPath(new URL("../dist-main", import.meta.url));
  const proto = fileURLToPath(new URL("../dist-proto", import.meta.url));
  const serve: Connect.NextHandleFunction = (req, res, next) => {
    const url = (req.url ?? "/").split("?")[0]!;
    const page = url.match(/^\/([\w-]+)\/?(?:index\.html)?$/)?.[1];
    if (page && MAIN_PAGES.has(page)) {
      const file = `${main}/${page}/index.html`;
      if (existsSync(file)) { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(readFileSync(file)); return; }
    }
    if (url.startsWith("/assets/") && !existsSync(`${proto}${url}`)) {
      const file = `${main}${url}`;
      if (existsSync(file) && statSync(file).isFile()) { res.setHeader("content-type", TYPES[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream"); res.end(readFileSync(file)); return; }
    }
    next();
  };
  return { name: "proto-main-site", configurePreviewServer(server) { server.middlewares.use(serve); } };
}
