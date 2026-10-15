// The librarian's merge pass: System/Channel/Product nodes that name the same thing become one (eval 2026-10-15,
// ig-token-impact: the Instagram connector and its token were four nodes), conservatively and reversibly; a token is
// linked to the one connector it unlocks.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { writeBatch, type EdgeInput, type NodeInput } from "../../src/graph/upsert.js";
import { credentialBase, loadMergeNodes, mergeDuplicates, nameKey, planMerges, unmerge, type MergeNode } from "../../src/ingest/merge.js";
import { runLibrarian } from "../../src/ingest/librarian.js";
import { impactOf } from "../../src/agent/tools/impact.js";
import { search } from "../../src/agent/tools/search.js";
import { getEntity } from "../../src/agent/tools/entity.js";
import { TouchedSet, type ToolContext } from "../../src/agent/tool.js";
import { testGraph } from "../helpers/graph.js";

const NOW = Date.parse("2026-10-15T06:00:00Z");
const n = (id: string, name: string, extra: Partial<MergeNode> = {}): MergeNode =>
  ({ id, type: (id.startsWith("channel:") ? "Channel" : id.startsWith("product:") ? "Product" : "System"), name, aliases: [], registry: false, degree: 1, ...extra });

describe("names", () => {
  it("normalises case, punctuation and abbreviations; file names never match", () => {
    expect(nameKey("Instagram (API with Instagram Login)")).toBe("instagram api with instagram login");
    expect(nameKey("IG token")).toBe("instagram token");
    expect(nameKey("ig-token.ts")).toBeUndefined();
    expect(nameKey("scripts/ig-token.ts")).toBeUndefined();
  });
  it("reads the connector a credential is for", () => {
    expect(credentialBase("instagram api token")).toBe("instagram");
    expect(credentialBase("instagram access token")).toBe("instagram");
    expect(credentialBase("stripe secret")).toBe("stripe");
    expect(credentialBase("instagram token keeper")).toBeUndefined();
    expect(credentialBase("token")).toBeUndefined();
  });
});

describe("planMerges", () => {
  const aamdani = [
    n("system:instagram", "Instagram (API with Instagram Login)", { registry: true, degree: 20 }),
    n("system:instagram-api-with-instagram-login", "Instagram API with Instagram Login", { aliases: ["graph.instagram.com"], degree: 4 }),
    n("system:ig-token", "IG token", { aliases: ["ig-token.ts"], degree: 3 }),
    n("system:instagram-api-token", "Instagram API token", { aliases: ["Instagram token"], degree: 3 }),
    n("system:ig-token-keeper", "ig-token keeper", { aliases: ["scripts/ig-token.ts"], degree: 2 }),
    n("channel:instagram", "Instagram", { degree: 9 }),
  ];

  it("merges same-named nodes of one type into the registry's, and links the token to its connector", () => {
    const p = planMerges(aamdani);
    expect(p.groups).toEqual([
      // "Instagram API token" is written out in full, so it is canonical over "IG token"
      { type: "System", canonical: "system:instagram-api-token", members: [{ id: "system:ig-token", key: "instagram token" }] },
      { type: "System", canonical: "system:instagram", members: [{ id: "system:instagram-api-with-instagram-login", key: "instagram api with instagram login" }] },
    ]);
    expect(p.links).toEqual([{ connector: "system:instagram", credential: "system:instagram-api-token", key: "instagram" }]);
  });

  it("never merges across types, a script with the thing it maintains, or two registry entries", () => {
    const p = planMerges([
      ...aamdani,
      n("system:gsc", "Google Search Console", { registry: true }), n("system:search-console", "Google Search Console", { registry: true }),
    ]);
    const all = p.groups.flatMap((g) => [g.canonical, ...g.members.map((m) => m.id)]);
    expect(all).not.toContain("channel:instagram");
    expect(all).not.toContain("system:ig-token-keeper");
    expect(all).not.toContain("system:gsc");
    expect(p.skipped).toContainEqual({ ids: ["system:gsc", "system:search-console"], why: "two registry entries: the registry lists distinct things" });
  });

  it("never merges on extraction's noisy aliases alone (aamdani's graph, 2026-10-15)", () => {
    const p = planMerges([
      n("system:publish-due-cron", "publish-due cron", { aliases: ["AWS publish-due cron", "Cron jobs", "insights cron", "token jobs"] }),
      n("system:insights-cron", "insights cron"),
      n("channel:discord-jarvis", "Discord #jarvis", { aliases: ["Discord", "#marketing", "#marketing-staging"] }),
      n("channel:marketing-staging", "#marketing-staging"),
      n("channel:google-ads", "Google Ads", { aliases: ["Google"] }), n("channel:google-search", "Google Search", { aliases: ["Google"] }),
      n("system:prod-db", "prod_db"), n("system:supabase", "Supabase", { aliases: ["prod DB"] }), n("system:supabase-prod", "Supabase prod project", { aliases: ["prod DB"] }),
      n("system:brain", "brain"), n("system:aamdani-brain", "aamdani-brain", { aliases: ["the brain"] }),
      // these do name the same thing
      n("system:skill-reel-publish", "reel-publish", { registry: true }), n("system:reel-publish-skill", "reel-publish skill", { aliases: ["reel-publish"] }),
      n("product:featured-pro", "featured_pro"), n("product:employer-featured-pro", "Employer Featured Pro", { aliases: ["Featured Pro"], degree: 3 }),
    ]);
    expect(p.groups.map((g) => [g.canonical, g.members.map((m) => m.id)])).toEqual([
      ["system:skill-reel-publish", ["system:reel-publish-skill"]],
      ["product:employer-featured-pro", ["product:featured-pro"]],
    ]);
  });

  it("leaves simulated and real apart, and a pair the owner unmerged", () => {
    expect(planMerges([n("product:app", "Aamdani app"), n("product:app-sim", "Aamdani App", { simulated: true })]).groups).toEqual([]);
    expect(planMerges([n("system:a", "Meta Ads", { notSameAs: ["system:b"] }), n("system:b", "Meta ads", { degree: 5 })]).groups).toEqual([]);
  });

  it("links a credential only to exactly one connector", () => {
    const p = planMerges([n("system:x-token", "Stripe token"), n("system:stripe", "Stripe"), n("system:stripe-2", "Stripe (payments)")]);
    expect(p.links).toEqual([]);
    expect(p.skipped[0]!.why).toMatch(/more than one connector/);
  });
});

describe("mergeDuplicates (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  const ctx = (): ToolContext => ({ graph: g, tenant: "test", turnId: "turn:t", agentId: "tech-lead", asker: "person:founder", touched: new TouchedSet(), now: NOW });

  const nodes: NodeInput[] = [
    { type: "Document", id: "document:registry-connectors-instagram-yaml", name: "registry/connectors/instagram.yaml", props: { kind: "registry" } },
    { type: "Document", id: "document:ig-note", name: "Instagram note", props: { kind: "note" } },
    { type: "Document", id: "document:ideas", name: "Content ideas", props: { kind: "note" } },
    { type: "System", id: "system:instagram", name: "Instagram (API with Instagram Login)" },
    { type: "System", id: "system:instagram-api-with-instagram-login", name: "Instagram API with Instagram Login", props: { aliases: ["graph.instagram.com"] } },
    { type: "System", id: "system:ig-token", name: "IG token", props: { aliases: ["ig-token.ts"] } },
    { type: "System", id: "system:instagram-api-token", name: "Instagram API token", props: { aliases: ["Instagram token"] } },
    { type: "System", id: "system:publish-due-cron", name: "publish-due cron" },
    { type: "System", id: "system:script-fetch-insights", name: "fetch insights" },
    { type: "Channel", id: "channel:instagram", name: "Instagram" },
    { type: "Feature", id: "feature:comment-to-dm", name: "Comment to DM auto-reply" },
    { type: "Person", id: "person:founder", name: "Founder" },
    { type: "Turn", id: "turn:old", name: "What breaks?" },
  ];
  const edges: EdgeInput[] = [
    { from: "system:instagram", type: "SOURCED_FROM", to: "document:registry-connectors-instagram-yaml" },
    { from: "system:script-fetch-insights", type: "DEPENDS_ON", to: "system:instagram" },
    { from: "channel:instagram", type: "DEPENDS_ON", to: "system:instagram-api-with-instagram-login", src: "document:ig-note" },
    { from: "system:publish-due-cron", type: "DEPENDS_ON", to: "system:instagram-api-with-instagram-login", src: "document:ig-note" },
    { from: "channel:instagram", type: "DEPENDS_ON", to: "system:ig-token", src: "document:ig-note" },
    { from: "feature:comment-to-dm", type: "DEPENDS_ON", to: "system:instagram-api-token", src: "document:ideas" },
    { from: "document:ig-note", type: "MENTIONS", to: "system:ig-token" },
    { from: "person:founder", type: "OWNS", to: "system:ig-token" },
    { from: "turn:old", type: "TOUCHED", to: "system:ig-token" },
  ];

  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await ensureIndexes(g);
    const s = await writeBatch(g, { nodes, edges }, NOW - 86_400_000);
    expect(s.errors).toEqual([]);
  });
  afterAll(async () => {
    await cleanup();
    await closeAll();
  });

  const current = async (id: string) => (await g.roQuery<{ k: string }>(
    `MATCH (a:Entity)-[r]->(b:Entity) WHERE (a.id = $id OR b.id = $id) AND r.until IS NULL RETURN a.id + ' ' + type(r) + ' ' + b.id AS k ORDER BY k, id(r)`, { id })).map((r) => r.k);

  it("reads the graph's candidates: names, aliases, registry, degree", async () => {
    const ns = await loadMergeNodes(g);
    expect(ns.find((x) => x.id === "system:instagram")).toMatchObject({ registry: true, type: "System" });
    expect(ns.find((x) => x.id === "system:instagram-api-with-instagram-login")).toMatchObject({ registry: false, aliases: ["graph.instagram.com"], degree: 2 });
  });

  it("merges the duplicates: one connector node and one token node with every edge, and the token linked to the connector", async () => {
    const r = await mergeDuplicates(g, NOW);
    expect(r).toMatchObject({ groups: 2, merged: 2, credentialLinks: 1, errors: [] });
    expect(await current("system:instagram-api-with-instagram-login")).toEqual(["system:instagram-api-with-instagram-login SAME_AS system:instagram"]);
    expect(await current("system:ig-token")).toEqual(["system:ig-token SAME_AS system:instagram-api-token", "turn:old TOUCHED system:ig-token"]); // history stays
    expect(await current("system:instagram")).toEqual(expect.arrayContaining([
      "channel:instagram DEPENDS_ON system:instagram", "system:publish-due-cron DEPENDS_ON system:instagram",
      "system:instagram DEPENDS_ON system:instagram-api-token", "system:script-fetch-insights DEPENDS_ON system:instagram",
    ]));
    expect(await current("system:instagram-api-token")).toEqual(expect.arrayContaining([
      "channel:instagram DEPENDS_ON system:instagram-api-token", "document:ig-note MENTIONS system:instagram-api-token",
      "feature:comment-to-dm DEPENDS_ON system:instagram-api-token", "person:founder OWNS system:instagram-api-token",
    ]));
    const [c] = await g.roQuery<{ aliases: string[]; merged: string | null }>(
      "MATCH (c:System {id:'system:instagram'}), (d:System {id:'system:instagram-api-with-instagram-login'}) RETURN c.aliases AS aliases, d.mergedInto AS merged");
    expect(c).toEqual({ aliases: ["graph.instagram.com"], merged: "system:instagram" }); // its name is the same as the canonical one
  });

  it("is idempotent", async () => {
    const before = await current("system:instagram");
    const r = await mergeDuplicates(g, NOW + 1000);
    expect(r).toMatchObject({ merged: 2, edgesMoved: 0, credentialLinks: 0, linksClosed: 0, errors: [] });
    expect(await current("system:instagram")).toEqual(before);
  });

  it("impact_of on the token, or on its old duplicate id, lists everything that breaks", async () => {
    for (const id of ["system:instagram-api-token", "system:ig-token"]) {
      const r = await impactOf.run({ id }, ctx());
      const ids = r.nodes.map((x) => x.id);
      expect(ids[0]).toBe("system:instagram-api-token");
      expect(ids).toEqual(expect.arrayContaining(["system:instagram", "channel:instagram", "feature:comment-to-dm", "system:publish-due-cron", "system:script-fetch-insights"]));
    }
  });

  it("search and get_entity land on the canonical node", async () => {
    const s = await search.run({ query: "IG token" }, ctx());
    expect(s.nodes.map((x) => x.id)).toContain("system:instagram-api-token");
    expect(s.nodes.map((x) => x.id)).not.toContain("system:ig-token");
    const e = await getEntity.run({ id: "system:instagram-api-with-instagram-login" }, ctx());
    expect((e.data as { id: string }).id).toBe("system:instagram");
  });

  it("the librarian runs it first, so KNOWS_ABOUT follows the moved mentions", async () => {
    const rep = await runLibrarian(g, { now: NOW + 2000 });
    expect(rep.merge).toMatchObject({ groups: 2, errors: [] });
  });

  it("unmerge puts everything back and keeps the pair apart afterwards", async () => {
    expect(await unmerge(g, "system:ig-token", NOW + 3000)).toBe("system:instagram-api-token");
    expect(await current("system:ig-token")).toEqual(expect.arrayContaining([
      "channel:instagram DEPENDS_ON system:ig-token", "document:ig-note MENTIONS system:ig-token", "person:founder OWNS system:ig-token",
    ]));
    expect(await current("system:instagram-api-token")).not.toContain("person:founder OWNS system:instagram-api-token");
    expect(await current("system:instagram-api-token")).toContain("feature:comment-to-dm DEPENDS_ON system:instagram-api-token"); // its own
    const [t] = await g.roQuery<{ aliases: string[] | null; merged: string | null }>(
      "MATCH (c:System {id:'system:instagram-api-token'}), (d:System {id:'system:ig-token'}) RETURN c.aliases AS aliases, d.mergedInto AS merged");
    expect(t).toEqual({ aliases: ["Instagram token"], merged: null });
    const again = await mergeDuplicates(g, NOW + 4000);
    expect(again.merged).toBe(1); // only the connector pair
    expect(await current("system:ig-token")).toContain("person:founder OWNS system:ig-token");
  });
});
