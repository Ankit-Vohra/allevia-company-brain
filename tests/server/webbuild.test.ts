// The server warns at start when the built web app is older than its source (a restart does not rebuild web/dist).
import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staleWebBuild } from "../../src/server/webbuild.js";

describe("server: a stale web build", () => {
  const dir = mkdtempSync(join(tmpdir(), "allevia-webbuild-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const dist = join(dir, "dist");
  const src = join(dir, "src");
  mkdirSync(dist);
  mkdirSync(join(src, "pages"), { recursive: true });
  writeFileSync(join(dist, "index.html"), "<html></html>");
  writeFileSync(join(src, "pages", "Home.tsx"), "export {}");
  const at = (p: string, s: number) => utimesSync(p, s, s);

  it("is quiet when the build is newer than the source, or there is no build", () => {
    at(join(src, "pages", "Home.tsx"), 1_000_000);
    at(join(dist, "index.html"), 1_000_100);
    expect(staleWebBuild(dist, [src])).toBeNull();
    expect(staleWebBuild(join(dir, "nope"), [src])).toBeNull();
  });
  it("says so, with the command, when a source file changed after the build", () => {
    at(join(src, "pages", "Home.tsx"), 1_010_000);
    expect(staleWebBuild(dist, [src])).toMatch(/built before its latest source change.*npm --prefix web run build/);
  });
});
