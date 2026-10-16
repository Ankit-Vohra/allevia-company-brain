// Issue #24: a new business's graph, clean on day one. The pure rules (near-duplicates, canonical channels, other
// businesses, first names) on the trials' own examples (docs/onboarding-trials.md), then the read-only quality report on
// a small graph shaped like the trials' noise.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { writeBatch, type EdgeInput, type NodeInput } from "../../src/graph/upsert.js";
import {
  channelPlatform, findDuplicatePairs, groupPairs, judgePair, nameWords, stem, strongKey, type DedupeNode,
} from "../../src/ingest/dedupe.js";
import { cueKind, firstNameOnly, isSelf } from "../../src/ingest/retype.js";
import { formatQuality, graphQuality } from "../../src/ingest/quality.js";
import { testGraph } from "../helpers/graph.js";

const node = (id: string, name: string, extra: Partial<DedupeNode> = {}): DedupeNode => ({
  id, name, aliases: [], degree: 1,
  type: (id.split(":")[0]!.replace(/(^|-)(\w)/g, (_, _d, c: string) => c.toUpperCase())) as DedupeNode["type"], ...extra,
});

describe("names", () => {
  it("stems plurals, drops filler words and spells out abbreviations", () => {
    expect(["funnels", "journeys", "boxes", "categories", "analysis", "news", "bus"].map(stem)).toEqual(["funnel", "journey", "box", "category", "analysis", "new", "bus"]);
    expect(nameWords("Funnels and user journeys")).toEqual(["funnel", "journey", "user"]);
    expect(strongKey("Food & Drinks")).toBe(strongKey("Food and drink"));
    expect(strongKey("IG reels")).toBe("instagram reel");
    expect(strongKey("scripts/ig-token.ts")).toBeUndefined();
  });
  it("knows one platform by its many names, with the business's own name and 'profile' taken off", () => {
    expect(["X (Twitter)", "Twitter", "X", "twitter.com"].map((n) => channelPlatform(n))).toEqual(["x", "x", "x", "x"]);
    expect(channelPlatform("IG")).toBe("instagram");
    expect(channelPlatform("Café Central Online Shop", "Café Central")).toBe("online-shop");
    expect(channelPlatform("Onlineshop")).toBe("online-shop");
    expect(channelPlatform("Facebook page")).toBe("facebook");
    expect(channelPlatform("Google Business Profile")).toBe("google-maps");
    expect(channelPlatform("Instagram Ads")).toBe("meta-ads");
    expect(channelPlatform("Spring newsletter launch")).toBeUndefined();
  });
});

describe("near-duplicate pairs", () => {
  it("merges Twitter and X, never Instagram and Facebook, whatever the vectors say", () => {
    expect(judgePair(node("channel:x", "X (Twitter)", { platform: "x" }), node("channel:twitter", "Twitter"))).toMatchObject({ how: "same channel" });
    expect(judgePair(node("channel:instagram", "Instagram", { embedding: [1, 0] }), node("channel:facebook", "Facebook", { embedding: [1, 0.01] }))).toBeUndefined();
  });
  it("is certain of the same words and of names that agree; a version or a year is another piece of content", () => {
    expect(judgePair(node("product:food", "Food & drinks"), node("product:food-and-drink", "Food and drink"))).toMatchObject({ how: "same name" });
    expect(judgePair(node("system:sc", "Search Console", { embedding: [1, 0] }), node("system:gsc", "Google Search Console", { embedding: [1, 0.1] }))).toMatchObject({ how: "names agree" });
    expect(judgePair(node("content:a", "Employer launch reel"), node("content:b", "Employer launch reel v3"))?.how).not.toBe("names agree");
  });
  it("sends a contained name or a close vector to the model, and never a pair already judged distinct or unmerged", () => {
    const f = (id: string, name: string, e: number[]) => node(`feature:${id}`, name, { embedding: e });
    const funnels = f("funnels", "Funnels", [1, 0.2]);
    expect(judgePair(funnels, f("funnel-analysis", "Funnel analysis", [1, 0.25]))).toMatchObject({ how: "similar" });
    expect(judgePair(f("goals", "Goals", [1, 0]), f("revenue", "Revenue attribution", [0, 1]))).toBeUndefined();
    expect(judgePair({ ...funnels, distinctFrom: ["feature:funnel-analysis"] }, f("funnel-analysis", "Funnel analysis", [1, 0.25]))).toBeUndefined();
    expect(judgePair({ ...funnels, notSameAs: ["feature:funnel-analysis"] }, f("funnel-analysis", "Funnel analysis", [1, 0.25]))).toBeUndefined();
    expect(judgePair(funnels, node("product:funnels", "Funnels"))).toBeUndefined(); // never across types
  });
  it("finds the Plausible features (trials 2026-10-15) and keeps each node's candidates few", () => {
    const e = (x: number) => [1, x];
    const nodes = [
      node("feature:funnels", "Funnels", { embedding: e(0.1) }), node("feature:funnel-analysis", "Funnel analysis", { embedding: e(0.12) }),
      node("feature:funnels-and-user-journeys", "Funnels and user journeys", { embedding: e(0.14) }),
      node("feature:goal-conversions", "Goal conversions", { embedding: e(3) }),
      node("channel:x", "X (Twitter)", { platform: "x" }), node("channel:twitter", "Twitter"),
    ];
    const { certain, borderline } = findDuplicatePairs(nodes);
    expect(certain.map((p) => `${p.a}|${p.b}`)).toEqual(["channel:twitter|channel:x"]);
    expect(borderline.map((p) => `${p.a}|${p.b}`).sort()).toEqual([
      "feature:funnel-analysis|feature:funnels", "feature:funnel-analysis|feature:funnels-and-user-journeys", "feature:funnels|feature:funnels-and-user-journeys",
    ]);
  });
  it("groups accepted pairs, picks the socials' channel as canonical, and leaves a group with a pair judged different alone", () => {
    const nodes = [node("channel:x", "X (Twitter)", { platform: "x" }), node("channel:twitter", "Twitter", { degree: 5 }), node("channel:x-com", "x.com")];
    const pairs = findDuplicatePairs(nodes).certain;
    expect(groupPairs(nodes, pairs).groups).toEqual([{ type: "Channel", canonical: "channel:x", members: [{ id: "channel:twitter", basis: "same channel" }, { id: "channel:x-com", basis: "same channel" }] }]);
    expect(groupPairs(nodes, pairs, new Set(["channel:twitter|channel:x-com"])).skipped).toHaveLength(1);
  });
});

describe("other businesses and first names", () => {
  it("reads a supplier, a partner, a client or a competitor from the summary, only when it says one thing", () => {
    expect(cueKind("Coffee roaster that supplies the beans for the espresso bar.")).toBe("supplier");
    expect(cueKind("Interiors magazine that featured the studio's Neptune Glitz project.")).toBe("partner");
    expect(cueKind("Car dealership whose showroom the studio designed; a project for the client.")).toBe("client");
    expect(cueKind("A nearby cafe the owner sees as a competitor.")).toBe("competitor");
    expect(cueKind("A partner roastery that supplies the beans.")).toBeUndefined(); // two cues: the model decides
    expect(cueKind("Royal Mail")).toBeUndefined();
  });
  it("knows the business itself under its legal name or its domain", () => {
    expect(isSelf("Prufrock Coffee Ltd", { name: "Prufrock Coffee" })).toBe(true);
    expect(isSelf("prufrockcoffee", { name: "Prufrock", domain: "www.prufrockcoffee.com" })).toBe(true);
    expect(isSelf("Workshop Coffee", { name: "Prufrock Coffee" })).toBe(false);
  });
  it("retires a first name alone, keeps anyone with a surname, a role, a bio or an edge that says what they do", () => {
    const p = (name: string, summary = "", relTypes: string[] = []) => ({ id: `person:${name.toLowerCase()}`, name, summary, relTypes });
    expect(firstNameOnly(p("Sam", "Mentioned on the about page."))).toBeDefined();
    expect(firstNameOnly(p("Ruth", "Our nursery manager."))).toBeUndefined();
    expect(firstNameOnly(p("Dr. Weininger", "Dentist at the practice."))).toBeUndefined();
    expect(firstNameOnly(p("Mira Okafor"))).toBeUndefined();
    expect(firstNameOnly(p("Jo", "", ["MEMBER_OF"]))).toBeUndefined();
    expect(firstNameOnly({ ...p("Lena"), role: "head baker" })).toBeUndefined();
    expect(firstNameOnly({ id: "person:founder", name: "Founder", relTypes: [] })).toBeUndefined();
  });
});

describe("graph:quality (read-only, test graph)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  const AS_OF = "2026-10-15T09:00:00.000Z";
  const DOC = "document:web-cafe-example-com";

  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    const src = { src: DOC, asOf: AS_OF };
    const nodes: NodeInput[] = [
      { type: "Business", id: "business:cafe", name: "Cafe Example", props: { domain: "cafe.example.com", hours: ["Mon-Fri 08:00-17:00"] } },
      { type: "Document", id: DOC, name: "Home", props: { kind: "webpage" } },
      { type: "Document", id: "document:playbook-x", name: "A playbook", props: { kind: "playbook" } },
      { type: "Rule", id: "rule:x", name: "A rule", src: "document:playbook-x" },
      { type: "Channel", id: "channel:x", name: "X (Twitter)", props: { platform: "x" }, ...src },
      { type: "Channel", id: "channel:twitter", name: "Twitter", ...src },
      { type: "Channel", id: "channel:instagram", name: "Instagram" }, // a playbook's bare anchor
      { type: "Business", id: "business:square-mile-roasters", name: "Square Mile Roasters", summary: "Coffee roaster that supplies the beans.", ...src },
      { type: "Person", id: "person:sam", name: "Sam", summary: "Thanked on the about page.", ...src },
      { type: "Product", id: "product:filter-coffee", name: "Filter coffee", ...src },
      { type: "Feature", id: "feature:loyalty-card", name: "Loyalty card" },
    ];
    const edges: EdgeInput[] = [
      ...["channel:x", "channel:twitter", "business:square-mile-roasters", "person:sam", "product:filter-coffee"].map((id) => ({ from: id, type: "SOURCED_FROM" as const, to: DOC, ...src })),
      { from: "channel:x", type: "PART_OF", to: "business:cafe", ...src },
      { from: "product:filter-coffee", type: "PART_OF", to: "business:cafe" },        // no source
      { from: "feature:loyalty-card", type: "PART_OF", to: "product:filter-coffee", ...src },
      { from: "rule:x", type: "APPLIES_TO", to: "channel:instagram" },
    ];
    const s = await writeBatch(g, { nodes, edges, observations: [] }, Date.parse(AS_OF));
    expect(s.errors).toEqual([]);
  });
  afterAll(async () => {
    await cleanup();
    await closeAll();
  });

  it("counts duplicates, mistyped nodes, orphans and facts with no source, and leaves the shared anchors out", async () => {
    const before = await g.roQuery<{ c: number }>("MATCH (n) RETURN count(n) AS c");
    const r = await graphQuality(g, "business:cafe");
    expect(r.nodes.own).toBe(6);
    expect(r.nodes.byType).toEqual({ Business: 1, Channel: 2, Feature: 1, Person: 1, Product: 1 });
    expect(r.duplicates).toMatchObject({ certain: 1, nodes: 1 });
    expect(r.mistyped).toMatchObject({ otherBusinesses: 1, firstNamePeople: 1, total: 2 });
    expect(r.orphans.examples.sort()).toEqual(['Business "Square Mile Roasters"', 'Channel "Twitter"', 'Person "Sam"']);
    expect(r.unsourced).toMatchObject({ nodes: 1, edges: 1, facts: 1 }); // the loyalty card, filter coffee PART_OF, the hours
    expect(r.facts).toMatchObject({ hours: true, address: false, priceRange: false, pricedProducts: 0 });
    expect(r.noise).toBeCloseTo(4 / 6, 2);
    expect(formatQuality(r)).toMatch(/Duplicates: 1 certain pair/);
    expect(await g.roQuery<{ c: number }>("MATCH (n) RETURN count(n) AS c")).toEqual(before); // it wrote nothing
  });
});
