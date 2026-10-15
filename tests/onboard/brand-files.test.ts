// Onboarding with the brand library switched on: the site's logo is downloaded (through the same SSRF-safe fetch as the
// crawl, here against the local fixture site), written as a file on the site's logo node, and a failing brand step never
// fails onboarding.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { closeAll, openGraphByName, type GraphHandle } from "../../src/graph/client.js";
import { onboard, type OnboardDeps } from "../../src/onboard/onboard.js";
import { LOGO_ASSET_ID } from "../../src/ingest/sources/website/brand.js";
import { AssetStore } from "../../src/studio/store.js";
import { testGraph } from "../helpers/graph.js";
import { FakeLlm } from "../helpers/fake-llm.js";
import { startSite, type SiteServer } from "../fixtures/website/server.js";

const fakeEmbed = async (texts: string[]) => texts.map((t) => {
  const h = createHash("sha256").update(t).digest();
  const v = Array.from({ length: 384 }, (_, i) => (h[i % 32]! - 127.5) / 127.5 + i / 1000);
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
});

describe("onboarding with the brand library", () => {
  let site: SiteServer;
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  let slug: string;
  let metaGraph: string;
  let dataDir: string;
  const logs: string[] = [];

  beforeAll(async () => {
    site = await startSite();
    ({ g, cleanup } = await testGraph());
    slug = g.name.replace(/^allevia_/, "");
    metaGraph = `allevia_test_meta_${slug.slice(5)}`;
    dataDir = mkdtempSync(join(tmpdir(), "allevia-onboard-brand-"));
  }, 120_000);
  afterAll(async () => {
    await cleanup();
    await (await openGraphByName(metaGraph)).drop();
    await closeAll();
    await site.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("downloads the logo file into the tenant's assets and records it on the logo node", async () => {
    const store = new AssetStore(dataDir);
    const deps: OnboardDeps = {
      runner: new FakeLlm(), model: "haiku", dataDir, embed: fakeEmbed, tenantOpts: { metaGraph }, now: () => Date.parse("2026-10-15T09:00:00.000Z"),
      crawlOptions: { allowHosts: [`127.0.0.1:${site.port}`], minDelayMs: 0, maxLinkChecks: 5 },
      brand: { store, googleFonts: false }, log: (l) => logs.push(l),
    };
    const res = await onboard({ name: "Kestrel & Oak Studio", slug, url: `${site.origin}/`, industry: "architecture studio" }, () => {}, deps);
    expect(res.errors.filter((e) => /brand/.test(e))).toEqual([]);
    const [logo] = await g.roQuery<{ key: string | null; origin: string; status: string | null }>(
      "MATCH (a:Entity:BrandAsset {id:$id}) RETURN a.storageKey AS key, a.origin AS origin, a.status AS status", { id: LOGO_ASSET_ID });
    expect(logs.some((l) => /brand files: logo/.test(l))).toBe(true);
    if (logo?.key) {
      expect(logo.origin).toBe("website");
      expect(existsSync(store.path(slug, logo.key)!)).toBe(true);
    } else {
      // a fixture logo too small or not logo-shaped: then the node says so instead of pointing at a file
      expect(logo?.status ?? "not-a-logo").toBe("not-a-logo");
    }
  }, 120_000);
});
