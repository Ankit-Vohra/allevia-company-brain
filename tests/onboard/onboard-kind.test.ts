// What the website says the business is picks the goals, when the owner typed no industry (the web form never does).
// Same setup as onboard.test.ts: the fixture site, a fake model, a throwaway graph.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeAll, openGraphByName, type GraphHandle } from "../../src/graph/client.js";
import { getTenant } from "../../src/graph/tenants.js";
import { onboard, type OnboardResult } from "../../src/onboard/onboard.js";
import { testGraph } from "../helpers/graph.js";
import { FakeLlm, FIXTURE_PROFILE } from "../helpers/fake-llm.js";
import { startSite, type SiteServer } from "../fixtures/website/server.js";

describe("onboard: the website's own profile picks the template", () => {
  let site: SiteServer;
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  let slug: string;
  let metaGraph: string;
  let dataDir: string;
  let run: OnboardResult;

  beforeAll(async () => {
    site = await startSite();
    ({ g, cleanup } = await testGraph());
    slug = g.name.replace(/^allevia_/, "");
    metaGraph = `allevia_test_meta_${slug.slice(5)}`;
    dataDir = mkdtempSync(join(tmpdir(), "allevia-onboard-kind-"));
    const llm = new FakeLlm({ profile: { ...FIXTURE_PROFILE, summary: "A family dental practice in Bristol.", industry: "family dental practice", kind: "health_and_beauty" } });
    // what the web form sends: name, URL, country and its money, time zone and spelling; no industry, no vertical
    run = await onboard(
      { name: "Kestrel Dental", slug, url: `${site.origin}/`, country: "United Kingdom", currency: "GBP", locale: "en-GB", timeZone: "Europe/London" },
      () => {},
      {
        runner: llm, model: "haiku", dataDir, tenantOpts: { metaGraph }, now: () => Date.parse("2026-10-15T09:00:00.000Z"),
        embed: async (texts) => texts.map(() => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0))),
        crawlOptions: { allowHosts: [`127.0.0.1:${site.port}`], minDelayMs: 0, maxLinkChecks: 0, maxPages: 6 },
      },
    );
  }, 120_000);

  afterAll(async () => {
    await cleanup();
    await (await openGraphByName(metaGraph)).drop();
    await closeAll();
    await site.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("uses the clinic template, with no Instagram goal, and keeps the industry the site gave", async () => {
    expect(run.errors).toEqual([]);
    expect(run.templateKey).toBe("health_and_beauty");
    const goals = await g.roQuery<{ name: string }>("MATCH (:Business)-[:PURSUES]->(gl:Goal) RETURN gl.name AS name ORDER BY gl.priority, gl.id");
    expect(goals.map((x) => x.name)).toEqual(["New booking enquiries per month", "Search clicks", "Calls and directions from Google"]);
    const [b] = await g.roQuery<{ industry: string; vertical: string; tk: string }>("MATCH (b:Business) WHERE b.templateKey IS NOT NULL RETURN b.industry AS industry, b.vertical AS vertical, b.templateKey AS tk");
    expect(b).toEqual({ industry: "family dental practice", vertical: "family dental practice", tk: "health_and_beauty" });
    expect((await getTenant(slug, { metaGraph }))!.industry).toBe("family dental practice");
  });
});
