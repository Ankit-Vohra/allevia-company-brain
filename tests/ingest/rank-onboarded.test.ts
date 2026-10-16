// A business read from a website never goes through ingest, so the librarian never ran for it: no `rank`, no `community`.
// rankAndCommunities() is the librarian's graph-only second step, called at the end of onboarding. On an onboarding-shaped
// graph (a Business, the website Channel, Pages that link to each other) it stores both props, a site's link structure
// (LINKS_TO_PAGE) forms the groups, and the Brain map's overview (src/server/reads.ts) uses the stored values.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { writeBatch, type EdgeInput, type NodeInput } from "../../src/graph/upsert.js";
import { rankAndCommunities, COMMUNITY_RELS } from "../../src/ingest/librarian.js";
import { overviewGraph } from "../../src/server/reads.js";
import { testGraph } from "../helpers/graph.js";

const page = (slug: string): NodeInput => ({ type: "Page", id: `page:${slug}`, name: slug, props: { path: `/${slug}` } });
const link = (a: string, b: string): EdgeInput => ({ from: `page:${a}`, type: "LINKS_TO_PAGE", to: `page:${b}`, src: `document:${a}`, asOf: "2026-10-15" });
const clique = (names: string[]): EdgeInput[] => names.flatMap((a) => names.filter((b) => b !== a).map((b) => link(a, b)));

const MAIN = ["home", "about", "services", "contact"];
const BLOG = ["blog-one", "blog-two", "blog-three"];

describe("rankAndCommunities on an onboarding-shaped graph", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    const nodes: NodeInput[] = [
      { type: "Business", id: "business:kestrel", name: "Kestrel" },
      { type: "Channel", id: "channel:website", name: "Website" },
      ...[...MAIN, ...BLOG].map(page),
      ...[...MAIN, ...BLOG].map((s): NodeInput => ({ type: "Document", id: `document:${s}`, name: `Page: ${s}`, props: { kind: "webpage" } })),
    ];
    const edges: EdgeInput[] = [
      { from: "channel:website", type: "PART_OF", to: "business:kestrel" },
      ...[...MAIN, ...BLOG].map((s): EdgeInput => ({ from: `page:${s}`, type: "PART_OF", to: "channel:website" })),
      ...[...MAIN, ...BLOG].map((s): EdgeInput => ({ from: `page:${s}`, type: "SOURCED_FROM", to: `document:${s}` })),
      ...clique(MAIN), ...clique(BLOG),
    ];
    const s = await writeBatch(g, { nodes, edges, observations: [] }, Date.parse("2026-10-15T09:00:00Z"));
    expect(s.errors).toEqual([]);
  });
  afterAll(async () => {
    await cleanup();
    await closeAll();
  });

  it("uses the site's page links for the groups", () => {
    expect(COMMUNITY_RELS).toContain("LINKS_TO_PAGE");
  });

  it("stores rank on every searchable node and one community per group of linked pages", async () => {
    const before = await g.roQuery<{ c: number }>("MATCH (n:Entity) WHERE n.rank IS NOT NULL OR n.community IS NOT NULL RETURN count(n) AS c");
    expect(before[0]!.c).toBe(0);

    const rep = await rankAndCommunities(g);
    expect(rep.rank.nodes).toBeGreaterThanOrEqual(2 + MAIN.length + BLOG.length);
    expect(rep.community.communities).toBeGreaterThanOrEqual(2);

    const rows = await g.roQuery<{ id: string; rank: number | null; community: number | null }>(
      "MATCH (n:Page) RETURN n.id AS id, n.rank AS rank, n.community AS community ORDER BY n.id");
    expect(rows).toHaveLength(MAIN.length + BLOG.length);
    for (const r of rows) {
      expect(typeof r.rank, r.id).toBe("number");
      expect(typeof r.community, r.id).toBe("number");
    }
    const community = new Map(rows.map((r) => [r.id.replace("page:", ""), r.community]));
    // the pages that link to each other are one group; the blog is another
    expect(new Set(MAIN.map((s) => community.get(s))).size).toBe(1);
    expect(new Set(BLOG.map((s) => community.get(s))).size).toBe(1);
    expect(community.get("home")).not.toBe(community.get("blog-one"));
  });

  it("is a no-op to run again: same props, nothing else touched", async () => {
    const read = () => g.roQuery<{ id: string; rank: number; community: number }>(
      "MATCH (n:Entity) WHERE n.rank IS NOT NULL RETURN n.id AS id, n.rank AS rank, n.community AS community ORDER BY n.id");
    const a = await read();
    await rankAndCommunities(g);
    expect(await read()).toEqual(a);
    expect((await g.roQuery<{ c: number }>("MATCH (v:Version) RETURN count(v) AS c"))[0]!.c).toBe(0);
  });

  it("the Brain overview shows the stored rank (scaled to the top node) and the stored community, not a rough ranking of its own", async () => {
    const stored = await g.roQuery<{ id: string; rank: number; community: number }>(
      "MATCH (n:Entity) WHERE n.rank IS NOT NULL RETURN n.id AS id, n.rank AS rank, n.community AS community ORDER BY n.id");
    const top = Math.max(...stored.map((r) => r.rank));
    const by = new Map(stored.map((r) => [r.id, r]));
    const view = await overviewGraph(g);
    expect(view.nodes.length).toBeGreaterThanOrEqual(MAIN.length + BLOG.length);
    for (const n of view.nodes) {
      const s = by.get(n.id)!;
      expect(n.rank, n.id).toBeCloseTo(Math.round((s.rank / top) * 1000) / 1000, 6);
      expect(n.community, n.id).toBe(s.community);
    }
    expect(Math.max(...view.nodes.map((n) => n.rank ?? 0))).toBe(1);
  });
});
