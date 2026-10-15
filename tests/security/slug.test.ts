// Tenant isolation, layer 1: a graph name is built from a validated slug only. Every crafted slug (path tricks, quotes,
// the registry's own name, upper case, look-alike unicode, control characters, over-long) is refused before any graph,
// folder or file name is made from it. No database needed for most of these; the registry test uses a throwaway one.
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { META_GRAPH } from "../../src/graph/tenants.js";
import { closeAll, graphName, openGraph, openGraphByName } from "../../src/graph/client.js";
import { ensureTenant, listTenants } from "../../src/graph/tenants.js";
import { MAX_SLUG_LENGTH, RESERVED_SLUGS, isTenantSlug } from "../../src/graph/slug.js";
import { CRAFTED_SLUGS } from "./crafted.js";
import { AssetStore } from "../../src/studio/store.js";
import { studioSample } from "../../src/studio/wiring.js";
import { tenantGraph } from "../../src/agent/wiring.js";
import { testGraphName } from "../helpers/graph.js";

describe("tenant slugs", () => {
  it("accepts ordinary slugs, up to the length limit", () => {
    for (const ok of ["aamdani", "avs_atelier", "demo_seed", "shop2", "a", "a".repeat(MAX_SLUG_LENGTH)]) {
      expect(isTenantSlug(ok), ok).toBe(true);
      expect(graphName(ok)).toBe(`allevia_${ok}`);
    }
  });

  it.each(CRAFTED_SLUGS)("refuses %s", (_what, slug) => {
    expect(isTenantSlug(slug)).toBe(false);
    expect(() => graphName(slug)).toThrow(/tenant slug/);
  });

  it("refuses the names the registry and the API use, so no tenant can be called allevia_meta", () => {
    expect(`allevia_meta`).toBe(META_GRAPH); // what graphName("meta") used to return: the registry itself
    for (const reserved of RESERVED_SLUGS) {
      expect(isTenantSlug(reserved), reserved).toBe(false);
      expect(() => graphName(reserved), reserved).toThrow(/tenant slug/);
    }
    expect(RESERVED_SLUGS).toEqual(expect.arrayContaining(["meta", "operator", "health", "tenants", "plans", "onboard", "auth"]));
    // a slug that merely contains the word is fine, and its graph is not the registry
    expect(graphName("allevia_meta")).not.toBe(META_GRAPH);
    expect(graphName("meta_shop")).toBe("allevia_meta_shop");
  });

  it("openGraph and tenantGraph never reach the registry through a slug", async () => {
    await expect(openGraph("meta")).rejects.toThrow(/tenant slug/);
    await expect(tenantGraph("meta")).rejects.toThrow(/tenant slug/);
    await expect(openGraph("../meta")).rejects.toThrow(/tenant slug/);
  });

  it("openGraphByName refuses a name that is not plain letters, digits and underscores", async () => {
    for (const bad of ["allevia_x; GRAPH.DELETE y", "allevia x", "allevia_x\n", "../allevia_meta", "allevia-x", ""]) {
      await expect(openGraphByName(bad), bad).rejects.toThrow(/bad graph name/);
    }
  });
});

describe("registering a tenant", () => {
  const metaGraph = testGraphName();
  afterAll(async () => {
    await (await openGraphByName(metaGraph)).drop();
    await closeAll();
  });

  it("ensureTenant refuses crafted slugs, and writes nothing", async () => {
    for (const [what, slug] of CRAFTED_SLUGS.slice(0, 12)) {
      await expect(ensureTenant({ slug, name: `Evil ${what}` }, { metaGraph }), what).rejects.toThrow(/tenant slug/);
    }
    await expect(ensureTenant({ slug: "meta", name: "Evil" }, { metaGraph })).rejects.toThrow(/tenant slug/);
    expect(await listTenants({ metaGraph })).toEqual([]); // nothing was registered
  });
});

describe("folders and files built from a slug", () => {
  it("the asset store only makes folders inside its own root, one per valid slug", () => {
    const root = mkdtempSync(join(tmpdir(), "allevia-slug-"));
    try {
      const store = new AssetStore(root);
      for (const [what, slug] of CRAFTED_SLUGS) expect(() => store.dir(slug), what).toThrow(/bad tenant slug/);
      expect(() => store.dir("meta")).toThrow(/bad tenant slug/);
      const sha = "a".repeat(64);
      for (const key of [`../${sha}.jpg`, `${sha}.jpg/../../x`, `${sha}.jpg\u0000.png`, "/etc/passwd", `${sha}.svg`, `${sha}.JPG`, `..\\${sha}.jpg`, `${sha}.jpg\n`]) {
        expect(store.path("aamdani", key), key).toBeNull();
        expect(store.get("aamdani", key), key).toBeNull();
      }
      expect(() => store.put("aamdani", "../../../../tmp/evil", Buffer.from("x"))).toThrow(/bad storage key/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the demo sample lookup refuses a crafted slug", () => {
    for (const [, slug] of CRAFTED_SLUGS) expect(studioSample("/nonexistent", slug)).toBeNull();
    expect(studioSample("/nonexistent", "meta")).toBeNull();
  });
});
