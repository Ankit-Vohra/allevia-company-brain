// Is the built web app older than its source? Restarting the server does not rebuild web/dist, so after a pull the owner
// sees yesterday's screens while the API is today's (the founder's Mac on 2026-10-17: Home looked different from the live
// site). The server says so at start, with the one command that fixes it.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** The newest modification time of any file under these folders (0 when none). */
function newestUnder(dirs: string[]): number {
  let newest = 0;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else newest = Math.max(newest, statSync(p).mtimeMs);
    }
  };
  for (const d of dirs) if (existsSync(d)) walk(d);
  return newest;
}

/** A warning when `distDir`'s index.html is older than the newest source file (by more than a minute), else null. */
export function staleWebBuild(distDir: string, sourceDirs: string[]): string | null {
  const index = join(distDir, "index.html");
  if (!existsSync(index)) return null;
  const built = statSync(index).mtimeMs;
  const newest = newestUnder(sourceDirs);
  if (newest <= built + 60_000) return null;
  return `the web app in ${distDir} was built before its latest source change, so pages show old screens: run \`npm --prefix web run build\` and reload`;
}
