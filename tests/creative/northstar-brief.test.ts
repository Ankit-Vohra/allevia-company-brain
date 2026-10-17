// Briefs serve the business's main goal and are built from the brain. Offline: the brief is resolved against a throwaway graph
// (test DB 6391), no image engine and no model.
//   - Aamdani (goal: app downloads) gets "Download the app", even when the writer put "Visit app.aamdani.ai";
//   - AVS Atelier (goal: project enquiries) gets an enquiry call to action;
//   - Blue Tokai (goal: café visits and online orders) gets a visit or order call to action;
//   - the card says so: "For: more app downloads · CTA: Download the app";
//   - a reel brief for a business with top posts on record names them in "Built from" and in what the writer is told;
//   - with no post numbers on record, the brief says so in one line.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBrief } from "../../src/creative/brief.js";
import { readWhatWorked } from "../../src/creative/whatworked.js";
import { ownPostsWrite, publishedPosts } from "../../src/creative/postresults.js";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { writeBatch } from "../../src/graph/upsert.js";
import { ctaKindOf, saveNorthStar, type NorthStarInput } from "../../src/northstar/northstar.js";
import { BACKFILL } from "../../src/northstar/backfill.js";
import { testGraph } from "../helpers/graph.js";

const NOW = Date.parse("2026-10-17T06:00:00Z");
const opened: Array<() => Promise<void>> = [];
afterAll(async () => { for (const c of opened) await c(); await closeAll(); });

async function business(id: string, ns: NorthStarInput): Promise<GraphHandle> {
  const { g, cleanup } = await testGraph();
  opened.push(cleanup);
  await writeBatch(g, { nodes: [{ type: "Business", id, name: id }, { type: "Product", id: "product:main", name: "Main service" }] }, NOW);
  const r = await saveNorthStar(g, { ...ns, businessId: id, now: NOW });
  expect(r.errors).toEqual([]);
  return g;
}
const preset = (t: string, extra: Partial<NorthStarInput> = {}): NorthStarInput => ({
  outcome: "", outcomeKind: "sales", audiences: [], offer: "", cta: { kind: "buy", text: "Shop now" }, channel: "", source: "backfill",
  ...(BACKFILL[t]!.preset as Partial<NorthStarInput>), ...extra,
} as NorthStarInput);

describe("a poster brief takes its call to action from the main goal", () => {
  let aamdani: GraphHandle, avs: GraphHandle, cafe: GraphHandle;
  beforeAll(async () => {
    aamdani = await business("business:aamdani", preset("aamdani"));
    avs = await business("business:avs-atelier", preset("avs_atelier", { audiences: ["Homeowners in Raipur"], cta: { kind: "enquire", text: "Enquire on WhatsApp" } }));
    cafe = await business("business:bluetokai", preset("bluetokai", { audiences: ["Coffee lovers near our cafés"] }));
  }, 60_000);

  it("aamdani: download the app, said on the card", async () => {
    const r = await resolveBrief(aamdani, "poster", { promoting: "Main service", message: "Local jobs, one tap away" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(ctaKindOf(r.brief.cta)).toBe("download");
    expect(r.brief.audience).toBe("Job seekers looking for local work"); // the main goal's audience, never a silent guess
    expect(r.brief.basis.forLine).toBe("For: more app downloads and sign-ups · CTA: Download the app · Audience: Job seekers looking for local work");
    expect(r.brief.basis.ids[0]).toMatch(/^memory:north-star/);
  });

  it("aamdani: a website ask the owner never said becomes the download, and the card says why", async () => {
    const r = await resolveBrief(aamdani, "poster", { promoting: "Main service", message: "Local jobs, one tap away", cta: "Visit app.aamdani.ai" }, { question: "make a poster for the job feed" });
    if (!r.ok) throw new Error("brief not ok");
    expect(r.brief.cta).toBe("Download the app");
    expect(r.brief.basis.notes.join(" ")).toMatch(/changed the ask from "Visit app.aamdani.ai" to "Download the app"/);
    // the owner's own words win
    const own = await resolveBrief(aamdani, "poster", { promoting: "Main service", message: "Local jobs", cta: "Visit app.aamdani.ai" }, { question: "a poster that says visit app.aamdani.ai" });
    if (!own.ok) throw new Error("brief not ok");
    expect(own.brief.cta).toBe("Visit app.aamdani.ai");
  });

  it("avs_atelier: an enquiry", async () => {
    const r = await resolveBrief(avs, "poster", { promoting: "Main service", message: "Homes that feel like you" });
    if (!r.ok) throw new Error("brief not ok");
    expect(ctaKindOf(r.brief.cta)).toBe("enquire");
    expect(r.brief.basis.forLine).toMatch(/^For: more interior and architecture project enquiries · CTA: Enquire on WhatsApp/);
  });

  it("bluetokai: a visit or an order", async () => {
    const r = await resolveBrief(cafe, "poster", { promoting: "Main service", message: "Your morning pour, done right" });
    if (!r.ok) throw new Error("brief not ok");
    expect(["visit", "order"]).toContain(ctaKindOf(r.brief.cta));
    const order = await resolveBrief(cafe, "poster", { promoting: "Main service", message: "Beans at your door", cta: "Order online today" }, { question: "poster for home delivery" });
    if (!order.ok) throw new Error("brief not ok");
    expect(order.brief.cta).toBe("Order online today"); // the second way the goal is served is kept
  });
});

describe("a reel brief is built from the brain", () => {
  let g: GraphHandle, empty: GraphHandle;
  beforeAll(async () => {
    g = await business("business:aamdani", preset("aamdani"));
    empty = await business("business:aamdani", preset("aamdani"));
    const reels = [["content:reel-salary", "Salary in 7 days, not 30", 9000], ["content:reel-feed", "New jobs near you", 3000], ["content:reel-team", "Meet our team", 1000], ["content:reel-office", "Our new office", 2800]] as const;
    await writeBatch(g, {
      nodes: [
        ...reels.map(([id, name]) => ({ type: "Content" as const, id, name, props: { format: "reel", hook: name, publishedAt: "2026-10-01" } })),
        { type: "Channel", id: "channel:instagram", name: "Instagram" },
        { type: "Rule", id: "rule:learned-no-stock-smiles", name: "No stock smiles", props: { kind: "learned", status: "active", text: "No stock smiles", confidence: 0.8 } },
        { type: "Decision", id: "decision:hindi-first", name: "Hindi first on Instagram", props: { decidedAt: "2026-10-05" } },
        { type: "Document", id: "document:ig-insights", name: "Instagram insights" },
      ],
      observations: reels.map(([id, , reach]) => ({ subject: id, metric: "reach", value: reach, unit: "accounts", asOf: "2026-10-10", src: "document:ig-insights" })),
    }, NOW);
  }, 60_000);

  it("names the top posts in Built from and in what the writer is told", async () => {
    const r = await resolveBrief(g, "reel", { promoting: "Main service", message: "Get paid in 7 days" });
    if (!r.ok) throw new Error("brief not ok");
    const b = r.brief.basis;
    expect(b.noData).toBe(false);
    expect(b.builtFrom).toMatch(/^Built from: your top reel "Salary in 7 days, not 30" \(3\.1× your usual reach/);
    expect(b.builtFrom).toContain('the edit rule "No stock smiles"');
    expect(b.builtFrom).toContain('the decision "Hindi first on Instagram"');
    expect(b.builtFrom).toContain("goal: more app downloads and sign-ups");
    expect(b.learnings).toMatch(/What worked here: "Salary in 7 days, not 30"/);
    expect(b.learnings).toMatch(/What fell flat: "Meet our team"/);
    expect(b.ids).toEqual(expect.arrayContaining(["content:reel-salary", "rule:learned-no-stock-smiles", "decision:hindi-first"]));
    expect(r.brief.cta).toBe("Download the app");
  });

  it("with no post numbers, says so in one line and builds from the main goal", async () => {
    const r = await resolveBrief(empty, "reel", { promoting: "Main service", message: "Get paid in 7 days" });
    if (!r.ok) throw new Error("brief not ok");
    expect(r.brief.basis.noData).toBe(true);
    expect(r.brief.basis.notes.join(" ")).toMatch(/^No post numbers on record yet \(connect Instagram/);
    expect(r.brief.basis.builtFrom).toBe("Built from: goal: more app downloads and sign-ups");
  });

  it("closes the loop: a published post's numbers land on its own node, a new post becomes Content", async () => {
    await writeBatch(g, { nodes: [{ type: "Content", id: "content:publish-abc", name: "Diwali hiring reel", props: { platform: "instagram", postId: "1789", postUrl: "https://www.instagram.com/reel/AbC_1/" } }] }, NOW);
    const published = await publishedPosts(g);
    const w = ownPostsWrite([
      { url: "https://www.instagram.com/reel/AbC_1/", kind: "video", likes: 50, views: 20000 },
      { url: "https://www.instagram.com/p/NeW9/", kind: "image", likes: 10, caption: "Hiring now" },
    ], { published, asOf: "2026-10-16", src: "document:ig-insights", channel: "channel:instagram", evidence: "test" });
    expect(w.nodes!.map((n) => n.id)).toEqual(["content:instagram-post-new9"]);
    const s = await writeBatch(g, w, NOW);
    expect(s.errors).toEqual([]);
    const [pub] = await g.roQuery<{ id: string }>("MATCH (c:Content {id:'content:instagram-post-new9'})-[:PUBLISHED_ON]->(ch:Channel {id:'channel:instagram'}) RETURN c.id AS id");
    expect(pub?.id).toBe("content:instagram-post-new9");
    expect((await readWhatWorked(g)).considered).toBe(4); // compared on reach, which the four reels have
    const [o] = await g.roQuery<{ v: number }>("MATCH (o:Observation)-[:MEASURES]->(c:Content {id:'content:publish-abc'}) WHERE o.metricKey = 'plays' RETURN o.value AS v");
    expect(o?.v).toBe(20000);
  });
});
