// Files and folders built from a tenant's name: no source file builds a cache path by hand (they all go through
// util/cache.ts), onboarding with a crafted slug writes nothing anywhere, and the per-tenant config table cannot be
// reached through object-prototype names.
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { onboard } from "../../src/onboard/onboard.js";
import { tenantConfig } from "../../src/tenant-config.js";
import { readSource, sourceFiles, stringLiterals } from "../helpers/ts-strings.js";
import { CRAFTED_SLUGS } from "./crafted.js";

const roots: string[] = [];
const scratch = (): string => { const d = mkdtempSync(join(tmpdir(), "allevia-paths-")); roots.push(d); return d; };
afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });

describe("source scan", () => {
  it("only util/cache.ts (and the studio's base folder) names a cache folder under the data directory", () => {
    const allowed = new Set(["src/util/cache.ts", "src/studio/wiring.ts"]);
    const found: string[] = [];
    for (const file of sourceFiles("src")) {
      if (allowed.has(file)) continue;
      const text = readSource(file);
      if (/join\([^)]*dataDir[^)]*"cache"/.test(text) || /join\([^)]*"cache"\s*,\s*"(extract|onboard|studio)"/.test(text)) found.push(file);
      for (const lit of stringLiterals(text)) if (/cache\/(extract|onboard|studio)\b/.test(lit.text) && !/^\s*(\/\/|\*)/.test(lit.text)) found.push(`${file}:${lit.line}`);
    }
    expect(found).toEqual([]);
  });
});

describe("onboarding with a crafted slug", () => {
  it("fails before it creates any folder or file, anywhere", async () => {
    const dataDir = scratch();
    const events: string[] = [];
    for (const [what, slug] of [...CRAFTED_SLUGS, ["the registry", "meta"] as [string, string]]) {
      const r = await onboard({ name: `Evil ${what}`, slug, website: false }, (e) => { events.push(e.type); }, { dataDir, model: "haiku", tenantOpts: { metaGraph: "allevia_test_never_created" } });
      expect(r.ok, what).toBe(false);
      expect(r.errors.join(" "), what).toMatch(/tenant slug/);
    }
    expect(readdirSync(dataDir)).toEqual([]);
    expect(existsSync(join(dataDir, "..", "escape"))).toBe(false);
  });
});

describe("the per-tenant config table", () => {
  it("knows only its own tenants, not the names every object has", () => {
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "prototype", ...CRAFTED_SLUGS.map(([, s]) => s)]) {
      expect(() => tenantConfig(name), JSON.stringify(name)).toThrow(/unknown tenant/);
    }
    expect(tenantConfig("aamdani").name).toBe("Aamdani");
  });
});
