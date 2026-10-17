// Copies the built site (site/dist-proto) into a folder that GitHub Pages serves as it is, and makes it work under any path.
//   node site/proto/scripts/publish-pages.mjs <out-dir>        (build first: npx vite build --config proto/vite.config.ts, in site/)
// The pages link with root paths ("/product/"). A GitHub Pages project site lives under /<repo>/, so each root link becomes a relative one
// ("../product/" from a page one folder deep). Assets are already relative (Vite base "./"). Adds .nojekyll so every file is served.
// Refuses to copy a page that still has a TODO mark, a Pricing link while pricing is hidden, or anything shaped like a secret key.
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const src = join(dirname(fileURLToPath(import.meta.url)), "../../dist-proto");
const out = process.argv[2];
if (!out) { console.error("usage: node site/proto/scripts/publish-pages.mjs <out-dir>"); process.exit(1); }
if (!existsSync(join(src, "a/index.html"))) { console.error(`no build in ${src}; run npx vite build --config proto/vite.config.ts in site/`); process.exit(1); }

const walk = (dir) => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });

// Keep the target's git folder and its own files (README, CNAME); replace everything the build makes.
for (const n of existsSync(out) ? readdirSync(out) : []) if (![".git", "README.md", "CNAME"].includes(n)) rmSync(join(out, n), { recursive: true, force: true });
cpSync(src, out, { recursive: true });
writeFileSync(join(out, ".nojekyll"), "");

const SECRET = /\b(?:sk|pk|rk)_(?:live|test)?_?[A-Za-z0-9]{16,}|\bapify_api_[A-Za-z0-9]{20,}|\bghp_[A-Za-z0-9]{30,}|\bAKIA[0-9A-Z]{16}\b|\bak_[A-Za-z0-9]{20,}/;
const problems = [];
let pages = 0;
for (const file of walk(out)) {
  const rel = relative(out, file);
  if (rel.startsWith(`.git${sep}`)) continue;
  if (/\.(?:html|js|css|json|webmanifest|txt|svg)$/.test(file)) {
    const text = readFileSync(file, "utf8");
    const key = text.match(SECRET);
    if (key) problems.push(`${rel}: looks like a secret key (${key[0].slice(0, 8)}...)`);
  }
  if (file.endsWith(".webmanifest")) {
    writeFileSync(file, readFileSync(file, "utf8").replace(/"start_url":\s*"\/"/, '"start_url": "./a/"').replace(/"src":\s*"\/(?!\/)/g, '"src": "./'));
    continue;
  }
  if (!file.endsWith(".html")) continue;
  pages++;
  const depth = rel.split(sep).length - 1;
  const up = depth ? "../".repeat(depth) : "./";
  let html = readFileSync(file, "utf8").replace(/\b(href|src|action)="\/(?!\/)([^"]*)"/g, (_m, attr, path) => `${attr}="${up}${path}"`);
  if (/TODO\(founder\)/.test(html)) problems.push(`${rel}: a TODO(founder) mark`);
  if (!process.env.ALLEVIA_SITE_PRICING && /href="[^"]*pricing\//.test(html)) problems.push(`${rel}: a link to the hidden Pricing page`);
  const left = html.match(/\b(?:href|src|action)="\/(?!\/)[^"]*"/);
  if (left) problems.push(`${rel}: a root link is left (${left[0]})`);
  writeFileSync(file, html);
}

if (problems.length) { console.error(`not ready to publish:\n  ${problems.join("\n  ")}`); process.exit(1); }
console.log(`ready: ${pages} pages in ${out}`);
