// Lists the relative links in README.md and docs/**/*.md (markdown links and img src) whose target is not in the tree.
// Used by scripts/export-public.sh on the public copy, where left-out material would otherwise leave dead links.
//   node scripts/maint/check-links.mjs [dir]      (default: the current directory; prints "file -> target" lines)
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const files = ["README.md"];
const walk = (d) => {
  for (const f of readdirSync(join(root, d))) {
    const rel = join(d, f);
    if (statSync(join(root, rel)).isDirectory()) walk(rel);
    else if (f.endsWith(".md")) files.push(rel);
  }
};
if (existsSync(join(root, "docs"))) walk("docs");

const out = [];
for (const f of files) {
  if (!existsSync(join(root, f))) continue;
  const text = readFileSync(join(root, f), "utf8").replace(/```[\s\S]*?```/g, "");
  for (const m of text.matchAll(/\]\(([^)\s]+)\)|src="([^"]+)"/g)) {
    let t = m[1] ?? m[2];
    if (/^(https?:|mailto:|#)/.test(t)) continue;
    try { t = decodeURIComponent(t.split("#")[0]); } catch { continue; }
    if (t && !existsSync(resolve(root, dirname(f), t))) out.push(`${f} -> ${t}`);
  }
}
if (out.length) console.log(out.join("\n"));
