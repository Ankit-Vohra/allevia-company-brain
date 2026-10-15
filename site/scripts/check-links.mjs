// Link check for the built site (dist/): every internal link, image, script, stylesheet, poster and srcset candidate must
// point at a file that exists, and every #fragment at an id on the page it names. Also checks that each page is in
// sitemap.xml and the other way round. With --external it also requests every external http(s) link (slow, needs the
// network; a site that blocks bots can fail it, so read the list before believing it).
//
//   npm run build && npm run check:links [-- --external]
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = join(fileURLToPath(new URL("..", import.meta.url)), "dist");
if (!existsSync(DIST)) { console.error("dist/ not found: run `npm run build` first"); process.exit(2); }
const external = process.argv.includes("--external");

const walk = (dir) => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const htmlFiles = walk(DIST).filter((f) => f.endsWith(".html"));
const urlOf = (file) => { const rel = file.slice(DIST.length).replaceAll("\\", "/"); return rel.replace(/index\.html$/, ""); };
const pages = new Map(htmlFiles.map((f) => [urlOf(f), readFileSync(f, "utf8")]));
const ids = new Map([...pages].map(([u, html]) => [u, new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))]));

const errors = [];
const externals = new Map();
const fileFor = (path) => {
  const p = join(DIST, path);
  if (existsSync(p) && statSync(p).isFile()) return p;
  const idx = join(p, "index.html");
  return existsSync(idx) ? idx : null;
};

for (const [pageUrl, html] of pages) {
  const refs = [];
  for (const m of html.matchAll(/<(a|link|script|img|source|video|iframe)\b[^>]*>/gi)) {
    const tag = m[0];
    for (const a of tag.matchAll(/\s(href|src|poster|data-mp4)="([^"]*)"/gi)) refs.push(a[2]);
    for (const a of tag.matchAll(/\s(?:srcset|imagesrcset)="([^"]*)"/gi)) for (const c of a[1].split(",")) refs.push(c.trim().split(/\s+/)[0]);
  }
  for (const raw of refs) {
    const ref = raw.replaceAll("&amp;", "&");
    if (!ref || /^(mailto:|tel:|data:|javascript:)/i.test(ref)) continue;
    if (/^https?:\/\//i.test(ref)) {
      if (ref.startsWith("https://allevia-ai.in") || ref.startsWith("http://localhost")) { /* the site's own absolute address: checked as internal below */ }
      else { externals.set(ref, pageUrl); continue; }
    }
    const local = ref.replace(/^https?:\/\/[^/]+/, "");
    const [pathPart, frag] = local.split("#");
    const path = pathPart === "" ? pageUrl : pathPart.startsWith("/") ? pathPart : posix.join(pageUrl, pathPart);
    const file = fileFor(path.split("?")[0]);
    if (!file) { errors.push(`${pageUrl}: ${ref} does not exist in dist`); continue; }
    if (frag && file.endsWith(".html")) {
      const set = ids.get(urlOf(file));
      if (!set?.has(decodeURIComponent(frag))) errors.push(`${pageUrl}: ${ref} names an id that is not on ${urlOf(file)}`);
    }
  }
}

// sitemap and pages agree
const sitemap = existsSync(join(DIST, "sitemap.xml")) ? readFileSync(join(DIST, "sitemap.xml"), "utf8") : "";
const inMap = new Set([...sitemap.matchAll(/<loc>https?:\/\/[^/]+(\/[^<]*)<\/loc>/g)].map((m) => m[1]));
for (const u of pages.keys()) if (!inMap.has(u)) errors.push(`${u} is a page but not in sitemap.xml`);
for (const u of inMap) if (!pages.has(u)) errors.push(`${u} is in sitemap.xml but there is no such page`);
if (!existsSync(join(DIST, "robots.txt"))) errors.push("robots.txt is missing");

if (external) {
  const list = [...externals.keys()];
  console.log(`checking ${list.length} external links...`);
  await Promise.all(list.map(async (url) => {
    for (const method of ["HEAD", "GET"]) {
      try {
        const r = await fetch(url, { method, redirect: "follow", signal: AbortSignal.timeout(15000), headers: { "user-agent": "Mozilla/5.0 (link check)" } });
        if (r.ok) return;
        if (method === "GET" || ![403, 405, 429].includes(r.status)) {
          // 403/429 from a big site is usually bot protection, not a dead link: report it as a note, not an error
          if ([403, 429].includes(r.status)) { console.log(`note: ${url} answered ${r.status} (bot protection?), linked from ${externals.get(url)}`); return; }
          errors.push(`${externals.get(url)}: ${url} answered ${r.status}`);
          return;
        }
      } catch (e) {
        if (method === "GET") errors.push(`${externals.get(url)}: ${url} failed (${e.cause?.code ?? e.message})`);
      }
    }
  }));
}

console.log(`${pages.size} pages, ${externals.size} external links${external ? " (checked)" : " (not checked: pass --external)"}`);
if (errors.length) { console.error(errors.map((e) => `  ${e}`).join("\n")); console.error(`${errors.length} problem(s)`); process.exit(1); }
console.log("no dead links");
