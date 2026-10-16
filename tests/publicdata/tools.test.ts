// The public-data tools against a fake Apify door on a throwaway graph: off and read-only say so and change nothing; the
// business's own listing and Instagram land in its graph with source and date, privacy-filtered, and move the capability
// ladder to "public" (never "live"); competitors become Competitor nodes whose readings build a trend; the ad libraries
// are read with their limits said; a repeat within three days is served from the graph and costs nothing.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GraphHandle } from "../../src/graph/client.js";
import { closeAll } from "../../src/graph/client.js";
import { writeBatch } from "../../src/graph/upsert.js";
import { scanGraph } from "../../src/ingest/privacy.js";
import { deriveCapabilities } from "../../src/capabilities/ladder.js";
import { adLibrary, competitorWatch, googleListing, instagramPublic } from "../../src/agent/tools/publicdata.js";
import { OFF_WORDS } from "../../src/publicdata/service.js";
import { testGraph } from "../helpers/graph.js";
import { call, makeCtx } from "../helpers/tools.js";
import { FakePublicData, googleAds, igItem, metaAds, placeItem } from "./fakes.js";

const NOW = Date.parse("2026-10-15T09:00:00Z");
const DAY = 86_400_000;
let g: GraphHandle;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  ({ g, cleanup } = await testGraph());
  await writeBatch(g, {
    nodes: [{ type: "Business", id: "business:kestrel-bakes", name: "Kestrel Bakes", props: { city: "Leeds", country: "United Kingdom", domain: "kestrelbakes.example" } }],
  }, NOW);
});
afterAll(async () => { await cleanup(); await closeAll(); });

const ctxWith = (pd: FakePublicData | undefined, over: Record<string, unknown> = {}) =>
  makeCtx(g, { tenant: "kestrel_bakes", agentId: "growth-marketer", now: NOW, ...(pd ? { publicData: pd } : {}), ...over });
const count = async (cypher: string, params: Record<string, unknown> = {}): Promise<number> => (await g.roQuery<{ c: number }>(cypher, params))[0]?.c ?? 0;

describe("public-data tools, switched off or read-only", () => {
  it("without lookups switched on, each tool says so plainly and writes nothing", async () => {
    const before = await count("MATCH (n) RETURN count(n) AS c");
    for (const [tool, args] of [[googleListing, {}], [instagramPublic, { handle: "kestrelbakes" }], [competitorWatch, { competitors: [{ name: "Rival Rolls" }] }], [adLibrary, { brand: "Rival Rolls" }]] as const) {
      const r = await call(tool, args, ctxWith(undefined));
      expect(r.data.found, tool.name).toBe(false);
      expect(r.data.why).toBe(OFF_WORDS);
    }
    expect(await count("MATCH (n) RETURN count(n) AS c")).toBe(before);
  });

  it("in read-only mode they refuse (a lookup spends money and writes)", async () => {
    const pd = new FakePublicData({ "compass/crawler-google-places": () => [placeItem()] });
    const r = await call(googleListing, {}, ctxWith(pd, { readOnly: true }));
    expect(JSON.stringify(r.data)).toMatch(/read-only/);
    expect(pd.runs).toHaveLength(0);
  });

  it("a budget refusal reaches the owner in the door's own words", async () => {
    const why = "This lookup would cost about $0.05, and this month's budget for public lookups ($2.00) has under 1 cent left. It starts again on 1 Nov.";
    const pd = new FakePublicData({ "apify/instagram-profile-scraper": () => ({ ok: false, reason: "month", why }) });
    const r = await call(instagramPublic, { handle: "@someone_else" }, ctxWith(pd));
    expect(r.data).toEqual(expect.objectContaining({ found: false, why }));
  });
});

describe("google_listing", () => {
  it("reads the business's own listing: facts on the Maps channel, numbers as public Observations, reviews kept with a first name at most", async () => {
    const pd = new FakePublicData({ "compass/crawler-google-places": () => [placeItem()] });
    const r = await call(googleListing, {}, ctxWith(pd));
    expect(pd.runs[0]!.input).toEqual(expect.objectContaining({ searchStringsArray: ["Kestrel Bakes Leeds"], scrapeReviewsPersonalData: false, maxReviews: 10 }));
    expect(pd.runs[0]!.units).toBe(11);
    expect(r.data).toEqual(expect.objectContaining({
      found: true, whose: "ours", address: "12 Mill Lane, Leeds LS1 4AB, United Kingdom", rating: 4.6, reviewCount: 132,
      hours: ["Monday: 8 AM to 5 PM", "Sunday: Closed"], asOf: "2026-10-15", fromCache: false,
    }));
    expect(r.data.recentReviews[0]).toEqual({ stars: 5, by: "Jane", when: "2026-10-10", text: "Best sourdough in Leeds. Ask for Sam, or mail [redacted:email]", ownerReplied: true });
    expect(r.data.recentReviews[1].by).toBeNull(); // "M" is not a first name
    expect(r.sources[0]).toEqual(expect.objectContaining({ id: "document:public-listing-business-kestrel-bakes-own" }));

    // (no list-valued property next to an aggregate in one RETURN: FalkorDB 6.0.2 panics on `c.hours … count(p)`)
    const [ch] = await g.roQuery<{ address: string; hours: string[]; phone: unknown; phoneListed: boolean }>(
      "MATCH (c:Entity {id:'channel:google-maps'}) RETURN c.address AS address, c.hours AS hours, c.phone AS phone, c.phoneListed AS phoneListed");
    expect(ch).toEqual({ address: "12 Mill Lane, Leeds LS1 4AB, United Kingdom", hours: ["Monday: 8 AM to 5 PM", "Sunday: Closed"], phone: null, phoneListed: true });
    expect(await count("MATCH (:Entity {id:'channel:google-maps'})-[p:PART_OF]->(:Business {id:'business:kestrel-bakes'}) RETURN count(p) AS c")).toBe(1);
    const obs = await g.roQuery<{ metric: string; value: number; src: string; conf: number }>(
      "MATCH (o:Observation)-[:MEASURES]->(:Entity {id:'channel:google-maps'}) RETURN o.metric AS metric, o.value AS value, o.src AS src, o.conf AS conf ORDER BY metric, o.id");
    expect(obs).toEqual([
      { metric: "rating", value: 4.6, src: "document:public-listing-business-kestrel-bakes-own", conf: 0.9 },
      { metric: "review_count", value: 132, src: "document:public-listing-business-kestrel-bakes-own", conf: 0.9 },
    ]);
    const reviews = await g.roQuery<{ author: string | null; stars: number; summary: string }>(
      "MATCH (d:Document {kind:'review'}) RETURN d.author AS author, d.stars AS stars, d.summary AS summary, d.id AS id ORDER BY id");
    expect(reviews).toHaveLength(3);
    const all = JSON.stringify(reviews);
    expect(all).not.toMatch(/Doe|1234567890|contrib|example\.com|7700/);
    expect(reviews.map((x) => x.author).sort()).toEqual(["Jane", "Ravi", null].sort());
    // nothing personal anywhere in the graph, and the ladder reads it as public, not live
    expect(await scanGraph(g)).toEqual([]);
    const caps = Object.fromEntries((await deriveCapabilities(g, { now: NOW })).map((c) => [c.key, c.accessMode]));
    expect(caps.gbp).toBe("public");
    expect(caps.reviews).toBe("public");
  });

  it("a repeat within three days is read from the records and costs nothing; refresh pays again", async () => {
    const pd = new FakePublicData({ "compass/crawler-google-places": () => [placeItem()] });
    const again = await call(googleListing, {}, ctxWith(pd, { now: NOW + 2 * DAY }));
    expect(again.data).toEqual(expect.objectContaining({ found: true, fromCache: true, costUsd: 0, rating: 4.6 }));
    expect(pd.runs).toHaveLength(0);
    await call(googleListing, { refresh: true }, ctxWith(pd, { now: NOW + 2 * DAY }));
    expect(pd.runs).toHaveLength(1);
  });

  it("does not take a listing with someone else's website as the business's own", async () => {
    const pd = new FakePublicData({ "compass/crawler-google-places": () => [placeItem({ website: "https://otherbakery.example/", title: "Kestrel Bakery & Co" })] });
    const r = await call(googleListing, { whose: "ours", refresh: true }, ctxWith(pd));
    expect(r.data.found).toBe(false);
    expect(r.data.why).toMatch(/not kestrelbakes\.example/);
  });

  it("a rival's listing becomes a Competitor with its rating, and none of its reviews", async () => {
    const pd = new FakePublicData({ "compass/crawler-google-places": () => [placeItem({ title: "Rival Rolls", website: "https://rivalrolls.example/" })] });
    const r = await call(googleListing, { name: "Rival Rolls", city: "Leeds" }, ctxWith(pd));
    expect(r.data).toEqual(expect.objectContaining({ found: true, whose: "competitor", recentReviews: [] }));
    expect(pd.runs[0]!.input).toEqual(expect.objectContaining({ maxReviews: 0 }));
    expect(await count("MATCH (:Competitor {id:'competitor:rival-rolls'})-[r:COMPETES_WITH]->(:Business {id:'business:kestrel-bakes'}) RETURN count(r) AS c")).toBe(1);
    expect(await count("MATCH (o:Observation)-[:MEASURES]->(:Entity {id:'competitor:rival-rolls'}) WHERE o.metric = 'gmaps_rating' RETURN count(o) AS c")).toBe(1);
  });
});

describe("instagram_public", () => {
  it("reads the business's own public profile: numbers, engagement, top posts; the channel and the ladder say public", async () => {
    const pd = new FakePublicData({ "apify/instagram-profile-scraper": (req) => [igItem((req.input.usernames as string[])[0]!)] });
    const r = await call(instagramPublic, { handle: "@KestrelBakes", whose: "ours" }, ctxWith(pd));
    expect(r.data).toEqual(expect.objectContaining({ found: true, whose: "ours", handle: "kestrelbakes", followers: 2000, posts: 240, postsLooked: 6, avgViewsPerVideo: 12000 }));
    expect(r.data.postsPerWeek).toBe(3.5); // 6 posts two days apart: 5 gaps over 10 days
    expect(r.data.avgLikes).toBe(262);     // the post with hidden likes (-1) is left out of the average
    expect(r.data.engagementRatePct).toBeGreaterThan(13);
    expect(r.data.topPosts[0]).toEqual(expect.objectContaining({ likes: 900, comments: 40, kind: "video" }));
    expect(r.data.limits).toMatch(/Reach, saves/);
    expect(await count("MATCH (c:Entity {id:'channel:instagram'})-[:PART_OF]->(:Business) WHERE c.handle = 'kestrelbakes' RETURN count(c) AS c")).toBe(1);
    const caps = Object.fromEntries((await deriveCapabilities(g, { now: NOW })).map((c) => [c.key, c.accessMode]));
    expect(caps.instagram_insights).toBe("public");
    expect(await scanGraph(g)).toEqual([]); // the bio's e-mail never landed
  });

  it("a private account gives nothing and nothing is written", async () => {
    const pd = new FakePublicData({ "apify/instagram-profile-scraper": () => [igItem("someone_private", { private: true })] });
    const r = await call(instagramPublic, { handle: "someone_private" }, ctxWith(pd));
    expect(r.data).toEqual(expect.objectContaining({ found: false }));
    expect(r.data.why).toMatch(/private account/);
    expect(await count("MATCH (d:Entity {id:'document:public-instagram-someone-private'}) RETURN count(d) AS c")).toBe(0);
  });

  it("refuses a handle that is not one", async () => {
    const pd = new FakePublicData({});
    const r = await call(instagramPublic, { handle: "not a handle!" }, ctxWith(pd));
    expect(JSON.stringify(r.data)).toMatch(/not an Instagram handle/);
    expect(pd.runs).toHaveLength(0);
  });
});

describe("competitor_watch and ad_library", () => {
  const script = (followers: number) => ({
    "apify/instagram-profile-scraper": () => [igItem("rivalrolls", { followers })],
    "apify/facebook-ads-scraper": () => metaAds(),
    "s-r/google-ads-transparency": () => googleAds(),
  });

  it("files each rival as a Competitor with its public numbers and ads; a later reading shows the trend", async () => {
    const pd = new FakePublicData(script(1500));
    const comp = { name: "Rival Rolls", instagram: "rivalrolls", domain: "https://www.rivalrolls.example/menu" };
    const r = await call(competitorWatch, { competitors: [comp] }, ctxWith(pd));
    expect(r.data.found).toBe(true);
    const row = r.data.competitors[0];
    expect(row.instagram).toEqual(expect.objectContaining({ found: true, followers: 1500 }));
    expect(row.ads.map((x: { platform: string; found: number }) => [x.platform, x.found])).toEqual([["meta", 2], ["google", 1]]);
    expect(row.ads[0].runningNow).toBe(1);
    expect(row.ads[0].ads[0].line).toMatch(/^Meta ad, running since 2025-10-01 · image · Order now · "Croissant week"/);
    expect(pd.runs.find((x) => x.actor === "s-r/google-ads-transparency")!.input).toEqual(expect.objectContaining({ domains: ["rivalrolls.example"] }));
    expect(await count("MATCH (:Competitor {id:'competitor:rival-rolls'})-[r:COMPETES_WITH]->(:Business) RETURN count(r) AS c")).toBe(1);
    expect(await count("MATCH (o:Observation)-[:MEASURES]->(:Entity {id:'competitor:rival-rolls'}) WHERE o.metric IN ['followers', 'ads_meta_running', 'ads_google_seen'] RETURN count(o) AS c")).toBe(3);

    // four days later, a new reading: the earlier one is still there, and the answer carries the change
    const later = new FakePublicData(script(1620), new Date(NOW + 4 * DAY).toISOString());
    const r2 = await call(competitorWatch, { competitors: [comp], ads: false }, ctxWith(later, { now: NOW + 4 * DAY }));
    expect(r2.data.competitors[0].instagram).toEqual(expect.objectContaining({ followers: 1620, followersBefore: 1500, followersBeforeAsOf: "2026-10-15" }));
    expect(await count("MATCH (o:Observation)-[:MEASURES]->(:Entity {id:'competitor:rival-rolls'}) WHERE o.metric = 'followers' RETURN count(o) AS c")).toBe(2);
    // a competitor's numbers never move the business's own capabilities
    const caps = Object.fromEntries((await deriveCapabilities(g, { now: NOW + 4 * DAY })).map((c) => [c.key, c.accessMode]));
    expect(caps.ads).not.toBe("public");
    expect(await scanGraph(g)).toEqual([]);
  });

  it("refuses to watch the business itself as a competitor", async () => {
    const pd = new FakePublicData(script(1));
    const r = await call(competitorWatch, { competitors: [{ name: "Kestrel Bakes", instagram: "kestrelbakes" }] }, ctxWith(pd));
    expect(r.data.found).toBe(false);
    expect(pd.runs).toHaveLength(0);
  });

  it("ad_library reads both libraries, says what they hide, and serves a repeat from the records", async () => {
    const pd = new FakePublicData(script(1));
    const r = await call(adLibrary, { brand: "Rival Rolls", domain: "rivalrolls.example", refresh: true }, ctxWith(pd));
    expect(r.data).toEqual(expect.objectContaining({ found: true, whose: "competitor", who: "Rival Rolls" }));
    expect(r.data.limits).toMatch(/hidden, except for ads shown in the EU or UK and political ads/);
    expect(r.sources.map((s) => s.id).sort()).toEqual(["document:public-ads-google-rivalrolls-example", "document:public-ads-meta-rival-rolls"]);
    const again = new FakePublicData(script(1));
    const r2 = await call(adLibrary, { brand: "Rival Rolls" }, ctxWith(again));
    expect(r2.data.libraries[0]).toEqual(expect.objectContaining({ platform: "meta", found: 2, fromCache: true }));
    expect(again.runs).toHaveLength(0);
  });

  it("ad_library needs a brand or a website, and never sends a contact detail", async () => {
    const pd = new FakePublicData(script(1));
    expect(JSON.stringify((await call(adLibrary, {}, ctxWith(pd))).data)).toMatch(/brand name/);
    expect(JSON.stringify((await call(adLibrary, { brand: "mail jane.doe@example.com" }, ctxWith(pd))).data)).toMatch(/private detail/);
    expect(pd.runs).toHaveLength(0);
  });
});
