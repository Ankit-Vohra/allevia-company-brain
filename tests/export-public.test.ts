// scripts/export-public.sh builds the public copy: one commit, no history, no remote, no real business data, a LICENSE,
// and it leaves the source repository exactly as it was. (The hygiene test inside the export is skipped here with
// --no-tests: this suite runs it on the repo itself.)
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const REPO = new URL("../", import.meta.url).pathname;
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

describe("scripts/export-public.sh", () => {
  it("makes one clean commit outside the repo and touches nothing in it", () => {
    const before = [git(REPO, "rev-parse", "HEAD"), git(REPO, "status", "--porcelain"), git(REPO, "rev-list", "--count", "HEAD")];
    const parent = mkdtempSync(join(tmpdir(), "allevia-export-test-"));
    const out = join(parent, "copy");
    try {
      const log = execFileSync("bash", [join(REPO, "scripts/export-public.sh"), "--out", out, "--no-tests"], { encoding: "utf8" });
      expect(log).toMatch(/Nothing was pushed/);
      expect(git(out, "rev-list", "--count", "HEAD")).toBe("1");
      expect(git(out, "remote")).toBe("");
      const files = git(out, "ls-files").split("\n");
      for (const gone of ["docs/evals/2026-10-15-aamdani.md", "evals/aamdani.yaml", "evals/avs.yaml", "docs/content-trials.md"]) expect(files).not.toContain(gone);
      expect(files.some((f) => f.startsWith("data/") || f.startsWith("models/") || /(^|\/)\.env(?!\.example$)/.test(f))).toBe(false);
      expect(files).toContain("scripts/seed-demo.ts");
      expect(files).toContain("tests/fixtures/seed-graph.ts");
      expect(readFileSync(join(out, "LICENSE"), "utf8")).toMatch(/^MIT License/);
      expect(existsSync(join(out, "node_modules"))).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
    expect([git(REPO, "rev-parse", "HEAD"), git(REPO, "status", "--porcelain"), git(REPO, "rev-list", "--count", "HEAD")]).toEqual(before);
  }, 60_000);

  it("refuses to write inside the repository", () => {
    expect(() => execFileSync("bash", [join(REPO, "scripts/export-public.sh"), "--out", join(REPO, "export-here"), "--no-tests"], { stdio: "pipe" })).toThrow();
    expect(existsSync(join(REPO, "export-here"))).toBe(false);
  });
});
