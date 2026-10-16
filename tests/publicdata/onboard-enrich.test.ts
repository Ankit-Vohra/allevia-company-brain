// Onboarding with public data switched on: a site that turns our reader away (HTTP 429) is read through the public-data
// reader instead and the business is set up from its own words (no SEO checks on those pages: they would be about the
// reader), and the business's Google Maps listing lands on day one with a rating and a reviews number. Off, nothing
// changes (tests/onboard/onboard-unreadable.test.ts still holds).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OnboardEvent } from "../../shared/contracts.js";
import { closeAll, openGraphByName, type GraphHandle } from "../../src/graph/client.js";
import { onboard, type OnboardDeps } from "../../src/onboard/onboard.js";
import type { CrawlResult, PageData } from "../../src/ingest/sources/website/index.js";
import { scanGraph } from "../../src/ingest/privacy.js";
import { testGraph } from "../helpers/graph.js";
import { FakeLlm } from "../helpers/fake-llm.js";
import { fakeEmbed } from "../fixtures/seed-graph.js";
import { FakePublicData, placeItem } from "./fakes.js";

const blocked: PageData = {
  url: "https://closed.example/", finalUrl: "https://closed.example/", redirects: [], status: 429, fetchedAt: "2026-10-15T09:00:00.000Z", bytes: 10,
  titleCount: 0, metaDescriptionCount: 0, h1: [], h2: [], text: "", wordCount: 0, internalLinks: [], externalLinks: [], images: [], jsonLd: [],
  jsonLdTypes: [], jsonLdErrors: 0, og: {}, timing: { responseMs: 1, fetchMs: 1 }, mixedContent: [],
};
const crawl = async (): Promise<CrawlResult> => ({
  startUrl: "https://closed.example/", origin: "https://closed.example", pages: [blocked], skipped: [], robots: { status: 200, disallowAll: false, sitemaps: [] },
  sitemapUrls: 0, linkStatus: {}, screenshots: {}, requests: 1, startedAt: "2026-10-15T09:00:00.000Z", finishedAt: "2026-10-15T09:00:01.000Z",
});
const crawlerItems = () => [
  { url: "https://closed.example/", text: "Kestrel & Oak Studio. We design calm, light-filled homes and workplaces for people who plan to stay. Residential architecture and interior design for homeowners in Bristol and Bath. Over 120 homes completed since 2014.", metadata: { title: "Kestrel & Oak Studio", description: "Architecture and interiors in Bristol", languageCode: "en" } },
  { url: "https://closed.example/services", text: "Interior design: joinery, lighting and material palettes. Planning applications: drawings and statements for planning permission.", metadata: { title: "Services" } },
  { url: "https://elsewhere.example/ad", text: "An unrelated page the reader wandered onto.", metadata: { title: "Ad" } },
];

describe("onboarding with public data on", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  let slug: string;
  let metaGraph: string;
  let dataDir: string;
  const events: OnboardEvent[] = [];
  let pd: FakePublicData;
  let result: Awaited<ReturnType<typeof onboard>>;

  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    slug = g.name.replace(/^allevia_/, "");
    metaGraph = `allevia_test_meta_${slug.slice(5)}`;
    dataDir = mkdtempSync(join(tmpdir(), "allevia-onboard-enrich-"));
    pd = new FakePublicData({
      "apify/website-content-crawler": () => crawlerItems(),
      "compass/crawler-google-places": () => [placeItem({ title: "Kestrel & Oak Studio", website: "https://closed.example/" })],
    });
    const deps: OnboardDeps = {
      runner: new FakeLlm(), model: "haiku", dataDir, embed: async (texts: string[]) => texts.map((t) => fakeEmbed(t)), tenantOpts: { metaGraph }, now: () => Date.parse("2026-10-15T09:00:00.000Z"),
      crawl, publicData: pd,
    };
    result = await onboard({ name: "Kestrel & Oak Studio", slug, url: "https://closed.example/", country: "United Kingdom" }, (e) => events.push(e), deps);
  }, 120_000);
  afterAll(async () => {
    await cleanup();
    await (await openGraphByName(metaGraph)).drop();
    await closeAll();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("reads a blocked site through the public-data reader, only its own pages, and finishes", async () => {
    expect(result.ok).toBe(true);
    expect(pd.runs[0]!.actor).toBe("apify/website-content-crawler");
    expect(pd.runs[0]!.input).toEqual(expect.objectContaining({ startUrls: [{ url: "https://closed.example/" }] }));
    expect(result.pages).toBe(2);
    const pages = await g.roQuery<{ id: string }>("MATCH (p:Page) RETURN p.id AS id ORDER BY id");
    expect(pages.map((p) => p.id)).toEqual(["page:closed.example", "page:closed.example/services"]);
    // no SEO checks on pages read that way
    expect((await g.roQuery<{ c: number }>("MATCH (:Page)-[f:FAILS|PASSES]->(:Rule) RETURN count(f) AS c"))[0]!.c).toBe(0);
    expect(events.some((e) => e.type === "stage" && /turned away/.test(e.text))).toBe(true);
  });

  it("reads the business's own Google listing: day one has hours, a rating and a reviews number, and the ladder says public", async () => {
    const listing = pd.runs.find((r) => r.actor === "compass/crawler-google-places")!;
    expect((listing.input.searchStringsArray as string[])[0]).toMatch(/^Kestrel & Oak Studio/);
    const [ch] = await g.roQuery<{ hours: string[]; rating: number }>("MATCH (c:Entity {id:'channel:google-maps'}) RETURN c.hours AS hours, c.rating AS rating");
    expect(ch).toEqual({ hours: ["Monday: 8 AM to 5 PM", "Sunday: Closed"], rating: 4.6 });
    const obs = await g.roQuery<{ metric: string; value: number }>("MATCH (o:Observation)-[:MEASURES]->(:Entity {id:'channel:google-maps'}) RETURN o.metric AS metric, o.value AS value ORDER BY metric, o.id");
    expect(obs).toEqual([{ metric: "rating", value: 4.6 }, { metric: "review_count", value: 132 }]);
    const caps = Object.fromEntries((result.capabilities ?? []).map((c) => [c.key, c.accessMode]));
    expect(caps.gbp).toBe("public");
    expect(caps.reviews).toBe("public");
    expect(await scanGraph(g)).toEqual([]);
  });
});
