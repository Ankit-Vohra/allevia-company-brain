// Lists every TODO(founder) the built site still shows (company.ts, config.ts, the demo address). Run after a build.
//   npm run check:placeholders            # a list, always exits 0
//   npm run check:placeholders -- --strict   # exits 1 while any remain: the last check before publishing
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(SITE, "dist");
if (!existsSync(DIST)) { console.error("dist/ not found: run `npm run build` first"); process.exit(2); }
const strict = process.argv.includes("--strict");

const walk = (dir) => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const found = new Map();
for (const f of walk(DIST).filter((x) => x.endsWith(".html"))) {
  const html = readFileSync(f, "utf8");
  for (const m of html.matchAll(/<mark class="todo">TODO\(founder\): ([^<]*)<\/mark>/g)) {
    const what = m[1].trim();
    const page = f.slice(DIST.length).replace(/index\.html$/, "");
    if (!found.has(what)) found.set(what, new Set());
    found.get(what).add(page);
  }
}
const config = readFileSync(join(SITE, "src", "config.ts"), "utf8");
const demoEmpty = /export const DEMO_URL = "";/.test(config);

if (!found.size) console.log("no TODO(founder) marks on any page");
for (const [what, where] of found) console.log(`- ${what}\n    on: ${[...where].join(", ")}`);
if (demoEmpty) console.log("- config.ts DEMO_URL is empty: \"Try the live demo\" buttons are hidden (fine until the demo is hosted)");
console.log(`\n${found.size} distinct placeholder(s)`);
if (strict && found.size) process.exit(1);
