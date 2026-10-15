import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { writeBatch } from "../../src/graph/upsert.js";
import { capabilityModes, deriveCapabilities, getCapabilities, syncCapabilities, upgradeHint } from "../../src/capabilities/ladder.js";
import { capabilitiesOf, modeCheck, modesUsed, parseObservationId } from "../../src/capabilities/modes.js";
import { testGraph } from "../helpers/graph.js";
import { NOW } from "../helpers/agent.js";

const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString().slice(0, 10);

// A synthetic tenant (Kestrel & Oak Studio): one capability on each rung of the ladder.
async function seed(g: GraphHandle): Promise<void> {
  const biz = "business:kestrel-oak";
  const s = await writeBatch(g, {
    nodes: [
      { type: "Business", id: biz, name: "Kestrel & Oak Studio" },
      { type: "Business", id: "business:a-competitor", name: "A competitor" },
      { type: "Channel", id: "channel:website", name: "Website" },
      { type: "Channel", id: "channel:instagram", name: "Instagram", props: { handle: "kestrel.example" } },
      { type: "Channel", id: "channel:google-business", name: "Google Business Profile" },
      { type: "Channel", id: "channel:google-search", name: "Google Search" },
      { type: "Channel", id: "channel:meta-ads", name: "Meta Ads", props: { status: "not_connected", dataSimulated: true } },
      { type: "System", id: "system:ga4", name: "ga4", props: { kind: "connector", status: "ok", access: "delegated" } },
      { type: "System", id: "system:search-console", name: "search_console", props: { kind: "connector", status: "ok" } },
      { type: "System", id: "system:instagram", name: "instagram", props: { kind: "connector", status: "error" } },
      { type: "System", id: "system:meta-ads", name: "meta_ads", props: { kind: "connector", status: "planned" } },
      { type: "Page", id: "page:kestrel.example/services", name: "Services" },
      { type: "Rule", id: "rule:seo-check-meta-description", name: "Has a meta description", props: { kind: "seo-check" } },
      { type: "Rule", id: "rule:benchmark-meta-ads-ctr", name: "Meta Ads benchmark: CTR", props: { kind: "benchmark" } },
      { type: "BrandAsset", id: "brand-asset:logo", name: "Logo" },
      { type: "Campaign", id: "campaign:spring-leads", name: "Spring leads", simulated: true },
      { type: "Document", id: "document:ops-snapshot", name: "connector snapshot", props: { kind: "snapshot" } },
      { type: "Document", id: "document:reviews-screenshot", name: "reviews screenshot", props: { kind: "screenshot" } },
    ],
    observations: [
      { subject: "channel:website", metric: "ga4_sessions", value: 812, asOf: day(2), src: "document:ops-snapshot" },
      { subject: "channel:google-search", metric: "gsc_clicks", value: 140, asOf: day(20), src: "document:ops-snapshot" },
      { subject: "channel:instagram", metric: "followers", value: 2300, asOf: day(1), src: "document:ops-snapshot" },
      { subject: "channel:google-business", metric: "review_rating", value: 4.8, asOf: day(3), src: "document:reviews-screenshot", conf: 0.7 },
      { subject: "campaign:spring-leads", metric: "spend", value: 900, asOf: day(1), src: "document:simads", simulated: true },
      { subject: biz, metric: "review_cards_awaiting_approval", value: 5, asOf: day(1), src: "document:ops-snapshot" }, // not customer reviews
    ],
    edges: [
      { from: "channel:website", type: "PART_OF", to: biz },
      { from: "channel:instagram", type: "PART_OF", to: biz },
      { from: "channel:google-business", type: "PART_OF", to: biz },
      { from: "page:kestrel.example/services", type: "PART_OF", to: "channel:website" },
      { from: "page:kestrel.example/services", type: "FAILS", to: "rule:seo-check-meta-description" },
      { from: "rule:benchmark-meta-ads-ctr", type: "APPLIES_TO", to: "channel:meta-ads" },
    ],
  }, NOW);
  expect(s.errors).toEqual([]);
}

describe("capability ladder (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  const count = async (cypher: string) => (await g.roQuery<{ c: number }>(cypher))[0]!.c;

  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await ensureIndexes(g);
    await seed(g);
  });
  afterAll(async () => {
    await cleanup();
    await closeAll();
  });

  it("derives each capability's mode, status and lastOkAt from Channels, Systems and Observation freshness", async () => {
    const caps = await deriveCapabilities(g, { now: NOW });
    const by = Object.fromEntries(caps.map((c) => [c.key, c]));
    const brief = (k: string) => ({ mode: by[k]!.accessMode, status: by[k]!.status });
    expect(caps.map((c) => c.key)).toEqual(["ga4", "search_console", "gbp", "instagram_insights", "reviews", "studio", "ads"]);
    expect(brief("ga4")).toEqual({ mode: "delegated", status: "ok" });                 // fresh data through delegated access
    expect(brief("search_console")).toEqual({ mode: "public", status: "stale" });      // 20-day-old data: falls back to the crawl
    expect(brief("gbp")).toEqual({ mode: "public", status: "not_connected" });         // only the public listing
    expect(brief("instagram_insights")).toEqual({ mode: "public", status: "down" });   // fresh data, but the connector errors
    expect(brief("reviews")).toEqual({ mode: "upload", status: "not_connected" });     // read off a screenshot
    expect(brief("studio")).toEqual({ mode: "public", status: "not_connected" });      // the brand assets on the site
    expect(brief("ads")).toEqual({ mode: "benchmark", status: "not_connected" });      // simulated + playbook benchmarks
    expect(by.ga4!.lastOkAt).toBe(Date.parse(day(2)));
    expect(by.search_console!.lastOkAt).toBe(Date.parse(day(20)));
    expect(by.gbp!.lastOkAt).toBeNull();
    expect(by.search_console!.dependsOn).toEqual(["channel:google-search", "system:search-console"]);
    expect(by.search_console!.upgradeHint).toContain(`from ${day(20)}`);
    expect(by.instagram_insights!.upgradeHint).toMatch(/^The connection stopped working/);
    expect(by.gbp!.upgradeHint).toMatch(/^Reading your public Google listing only\. Add Allevia's ops account/);
  });

  it("writes Capability nodes PART_OF the Business and DEPENDS_ON their sources, idempotently", async () => {
    const first = await syncCapabilities(g, { now: NOW });
    expect(first.errors).toEqual([]);
    expect(await count("MATCH (c:Capability) RETURN count(c) AS c")).toBe(7);
    expect(await count("MATCH (:Capability)-[r:PART_OF]->(:Business {id:'business:kestrel-oak'}) WHERE r.until IS NULL RETURN count(r) AS c")).toBe(7);
    expect(await count("MATCH (:Capability {id:'capability:instagram-insights'})-[r:DEPENDS_ON]->(x) WHERE x.id IN ['channel:instagram','system:instagram'] RETURN count(r) AS c")).toBe(2);
    const [ig] = await g.roQuery<{ mode: string; status: string; key: string }>("MATCH (c:Capability {id:'capability:instagram-insights'}) RETURN c.accessMode AS mode, c.status AS status, c.key AS key");
    expect(ig).toEqual({ mode: "public", status: "down", key: "instagram_insights" });

    const snapshot = async () => [
      await count("MATCH (n) RETURN count(n) AS c"), await count("MATCH ()-[r]->() RETURN count(r) AS c"), await count("MATCH (v:Version) RETURN count(v) AS c"),
    ];
    const before = await snapshot();
    await syncCapabilities(g, { now: NOW });
    expect(await snapshot()).toEqual(before);
  });

  it("moves up a rung when fresh connector data arrives, keeping the old mode as a Version", async () => {
    const s = await writeBatch(g, { observations: [{ subject: "channel:google-search", metric: "gsc_clicks", value: 151, asOf: day(1), src: "document:ops-snapshot" }] }, NOW);
    expect(s.errors).toEqual([]);
    const caps = await getCapabilities(g, { now: NOW + 1000 });
    const sc = caps.find((c) => c.key === "search_console")!;
    expect(sc).toMatchObject({ accessMode: "api", status: "ok", lastOkAt: Date.parse(day(1)) });
    expect(sc.upgradeHint).toBe(`Connected and current (newest data ${day(1)}). Nothing to do.`);
    const [v] = await g.roQuery<{ props: string }>("MATCH (:Capability {id:'capability:search-console'})-[:HAD_VERSION]->(v:Version) RETURN v.props AS props");
    expect(JSON.parse(v!.props)).toMatchObject({ accessMode: "public", status: "stale" });
    expect((await capabilityModes(g, NOW)).find((c) => c.key === "search_console")).toEqual({ key: "search_console", name: "Google Search Console", accessMode: "api" });
  });
});

describe("capability evidence and disclosure (pure)", () => {
  const caps = [
    { key: "instagram_insights" as const, name: "Instagram insights", accessMode: "public" as const },
    { key: "ads" as const, name: "Ads", accessMode: "benchmark" as const },
    { key: "ga4" as const, name: "GA4", accessMode: "api" as const },
    { key: "search_console" as const, name: "Search Console", accessMode: "public" as const },
    { key: "reviews" as const, name: "Reviews", accessMode: "upload" as const },
  ];

  it("reads an observation id's metric and subject, and maps ids to capabilities", () => {
    expect(parseObservationId("obs:followers:channel:instagram:2026-10-14")).toEqual({ metric: "followers", subject: "channel:instagram" });
    expect(parseObservationId("metric:signups")).toBeUndefined();
    expect(capabilitiesOf("obs:followers:channel:instagram:2026-10-14")).toEqual([{ key: "instagram_insights", kind: "data" }]);
    expect(capabilitiesOf("obs:ga4_sessions:channel:website:2026-10-13")).toEqual([{ key: "ga4", kind: "data" }]);
    expect(capabilitiesOf("channel:instagram")).toEqual([{ key: "instagram_insights", kind: "source" }]);
    expect(capabilitiesOf("system:gbp")).toEqual([{ key: "gbp", kind: "source" }, { key: "reviews", kind: "source" }]);
    expect(capabilitiesOf("campaign:spring-leads")).toEqual([{ key: "ads", kind: "data" }]);
    expect(capabilitiesOf("rule:seo-check-meta-description")).toEqual([{ key: "search_console", kind: "profile" }]);
    expect(capabilitiesOf("capability:reviews")).toEqual([{ key: "reviews", kind: "capability" }]);
    expect(capabilitiesOf("channel:website")).toEqual([]);
    expect(capabilitiesOf("obs:review_rating:channel:google-business:2026-10-12")).toEqual([{ key: "reviews", kind: "data" }]);
    expect(capabilitiesOf("obs:review_cards_awaiting_approval:business:x:2026-10-12")).toEqual([]); // the content approval queue
    expect(capabilitiesOf("obs:followers:channel:youtube:2026-10-14")).toEqual([]);
  });

  it("asks for the mode only where the cited evidence rests on it", () => {
    // a channel is a source, not data: the check leaves it alone, the Chief's prompt still hears about it
    expect(modesUsed(["channel:instagram", "obs:ga4_sessions:channel:website:2026-10-13"], caps)).toEqual([]);
    expect(modesUsed(["channel:instagram", "obs:ga4_sessions:channel:website:2026-10-13"], caps, "prompt").map((c) => c.key)).toEqual(["instagram_insights"]);
    // stale connector data under a public mode: the freshness check covers it, not this one
    expect(modesUsed(["obs:gsc_clicks:channel:google-search:2026-09-25"], caps)).toEqual([]);
    expect(modesUsed(["obs:review_rating:channel:google-business:2026-10-12"], caps).map((c) => c.accessMode)).toEqual(["upload"]);
    expect(modesUsed(["rule:seo-check-meta-description", "capability:ga4"], caps).map((c) => c.key)).toEqual(["search_console"]);
  });

  it("passes only when every non-api mode is said, outside the citations themselves", () => {
    const ids = ["rule:seo-check-meta-description", "campaign:spring-leads"];
    expect(modeCheck("Two pages lack a description [[rule:seo-check-meta-description]]; ads are steady [[campaign:spring-leads]].", ids, caps))
      .toEqual({ ok: false, missing: [caps[3], caps[1]] });
    expect(modeCheck("From a crawl of your site [[rule:seo-check-meta-description]]; the simulated campaign [[campaign:spring-leads]] is steady.", ids, caps).ok).toBe(true);
    expect(modeCheck("Per the benchmark, ads [[campaign:spring-leads]] look fine; your public pages [[rule:seo-check-meta-description]].", ids, caps).ok).toBe(true);
    expect(modeCheck("A good CTR [[rule:benchmark-meta-ads-ctr]].", ["rule:benchmark-meta-ads-ctr"], caps).ok).toBe(false);
    expect(modeCheck("Sessions rose [[obs:ga4_sessions:channel:website:2026-10-13]].", ["obs:ga4_sessions:channel:website:2026-10-13"], caps).ok).toBe(true);
    expect(modeCheck("Instagram breaks [[channel:instagram]].", ["channel:instagram"], caps).ok).toBe(true);
    expect(modeCheck("Nothing cited.", [], caps).ok).toBe(true);
  });

  it("writes plain-language upgrade hints", () => {
    expect(upgradeHint("instagram_insights", "public", "not_connected", null))
      .toBe("Reading your public Instagram profile only. Give Allevia partner access in your Meta business portfolio to read reach, saves and follower growth.");
    expect(upgradeHint("ga4", "none", "not_connected", null)).toMatch(/^Not connected yet\. Add Allevia's service account as a Viewer/);
    expect(upgradeHint("ads", "benchmark", "not_connected", null)).toMatch(/^Using industry benchmarks, not your own numbers\. Share your Meta or Google Ads/);
  });
});
