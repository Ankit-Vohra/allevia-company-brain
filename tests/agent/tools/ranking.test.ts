import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { listGraphs, type GraphHandle } from "../../../src/graph/client.js";
import { important, topics } from "../../../src/agent/tools/ranking.js";
import { call, ids, makeCtx, seededGraph } from "../../helpers/tools.js";

describe("important, topics (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeAll(async () => ({ g, cleanup } = await seededGraph()), 60_000);
  afterAll(async () => cleanup());

  it("important: PageRank over a label and relationship, current edges only", async () => {
    const r = await call(important, { label: "System", rel: "DEPENDS_ON", limit: 3 }, makeCtx(g));
    expect(r.data.method).toBe("pagerank");
    expect(r.data.items[0].id).toBe("system:ig-connector");
    expect(r.data.items).toHaveLength(3);
    expect(r.edges).toEqual(expect.arrayContaining([expect.objectContaining({ from: "system:reel-publisher", type: "DEPENDS_ON", to: "system:ig-connector" })]));
    expect(ids(r.sources)).toContain("document:systems-notes");
    expect((await listGraphs()).filter((n) => n.startsWith(`${g.name}__`))).toEqual([]);
  });

  it("important: a stored rank wins when most of the label has one; the default skips bookkeeping types", async () => {
    const rules = await call(important, { label: "Rule" }, makeCtx(g));
    expect(rules.data.method).toBe("stored");
    expect(rules.data.items.map((i: { id: string; score: number }) => [i.id, i.score])).toEqual([
      ["rule:hook-curiosity-gap", 0.9], ["rule:seo-meta-description", 0.6], ["rule:hook-listicle", 0.4], ["rule:seo-h1", 0.3],
    ]);
    const all = await call(important, {}, makeCtx(g));
    expect(all.data.method).toBe("pagerank");
    expect(all.data.items).toHaveLength(10);
    for (const t of ["Observation", "Chunk", "Version", "Turn", "Session"]) expect(all.data.items.some((i: { type: string }) => i.type === t)).toBe(false);
  });

  it("topics: document clusters with the things they mention, labelled by members", async () => {
    const r = await call(topics, {}, makeCtx(g));
    expect(r.data.method).toBe("label_propagation");
    const withMember = (id: string) => r.data.topics.find((t: { members: Array<{ id: string }> }) => t.members.some((m) => m.id === id));
    // Label propagation may split a graph in more than one valid way (ties break by arrival order, which depends on
    // the server's scheduling), so assert what holds for every split: a partition, each topic labelled from its own members.
    const ig = withMember("channel:instagram");
    const sys = withMember("system:ig-connector");
    expect(ig).toBeDefined();
    expect(sys).toBeDefined();
    const seen = r.data.topics.flatMap((t: { members: Array<{ id: string }> }) => t.members.map((m) => m.id));
    expect(new Set(seen).size).toBe(seen.length); // no thing is in two topics
    const docs = new Set(seen.filter((id: string) => id.startsWith("document:")));
    for (const d of ["document:adr-007", "document:adr-003", "document:systems-notes"]) expect(docs.has(d)).toBe(true);
    expect(ig.members.some((m: { id: string }) => m.id.startsWith("document:"))).toBe(true);
    expect(sys.members.some((m: { id: string }) => m.id.startsWith("document:"))).toBe(true);
    expect(ig.label.length).toBeGreaterThan(0);
    expect(r.edges.length).toBeGreaterThan(0);
    expect(r.edges.every((e: { type: string }) => e.type === "MENTIONS" || e.type === "LINKS_TO")).toBe(true);
    expect(r.sources.length).toBeGreaterThan(0);
  });
});
