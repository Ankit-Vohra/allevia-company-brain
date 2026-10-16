// "What worked here" in a business's own skills (Aamdani, issue #25): the posts' numbers were in the records but the skill
// listed none, because the year window dropped every post whose date was never recorded, and one post shows up as several
// nodes that carry one reading.
import { afterAll, describe, expect, it } from "vitest";
import { companyFacts, companySkills, distinctPosts } from "../../src/agent/skills/company.js";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { writeBatch } from "../../src/graph/upsert.js";
import { testGraph } from "../helpers/graph.js";
import { NOW } from "../helpers/agent.js";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => { for (const c of cleanups) await c(); await closeAll(); });

const post = (id: string, name: string, format: string, views: number, props: Record<string, string> = {}) => ({
  node: { type: "Content" as const, id, name, props: { format, ...props } },
  obs: { subject: id, metric: "views", value: views, unit: "count", windowEnd: "2026-10-10", asOf: "2026-10-10", src: "document:insights" },
});

async function withPosts(posts: ReturnType<typeof post>[]): Promise<GraphHandle> {
  const { g, cleanup } = await testGraph();
  cleanups.push(cleanup);
  await ensureIndexes(g);
  const s = await writeBatch(g, {
    nodes: [{ type: "Business", id: "business:shop", name: "Shop" }, { type: "Document", id: "document:insights", name: "Insights" }, ...posts.map((p) => p.node)],
    observations: posts.map((p) => p.obs),
  }, NOW);
  expect(s.errors).toEqual([]);
  return g;
}

describe("distinctPosts", () => {
  it("keeps the first of posts of one format whose views are within 1%, and every post of another format or number", () => {
    const rows = [{ views: 1282, format: "reel" }, { views: 1280, format: "reel" }, { views: 1281, format: "short" }, { views: 1100, format: "reel" }, { views: 1100, format: "reel" }];
    expect(distinctPosts(rows)).toEqual([{ views: 1282, format: "reel" }, { views: 1281, format: "short" }, { views: 1100, format: "reel" }]);
    expect(distinctPosts([])).toEqual([]);
  });
});

describe("what performed, from the posts' numbers (integration)", () => {
  it("counts posts whose date was never recorded, lists each post once, and leaves out a reading of zero", async () => {
    const g = await withPosts([
      post("content:reel-a", "Reel A", "reel", 1282),
      post("content:reel-a-note", "Note on reel A", "reel", 1280),      // the same post under another name
      post("content:short-d", "Short D", "short", 1281),                // the same number in another format: a different post
      post("content:reel-b", "Reel B", "reel", 600),
      post("content:reel-c", "Reel C", "reel", 150),
      post("content:reel-e", "Reel E", "reel", 90),
      post("content:reel-f", "Reel F", "reel", 40),
      post("content:reel-zero", "Reel zero", "reel", 0),                // a placeholder before the first numbers
    ]);
    const f = await companyFacts(g, "shop", NOW);
    expect(f.worked.map((l) => l.split(":")[0])).toEqual(["Reel A (reel)", "Short D (short)", "Reel B (reel)", "Reel C (reel)"]);
    expect(f.worked[0]).toMatch(/1282 views/);
    expect(f.weakest.map((l) => l.split(":")[0])).toEqual(["Reel E (reel)", "Reel F (reel)"]);
    expect([...f.worked, ...f.weakest].join()).not.toMatch(/Note on reel A|Reel zero/);
    // and the skill says so instead of "no reel or post numbers recorded yet"
    const reel = companySkills(f).find((s) => s.id.endsWith("-reel"))!;
    expect(reel.text).toMatch(/Reel A \(reel\): 1282 views/);
    expect(reel.text).not.toMatch(/No reel or post numbers recorded yet/);
  }, 60_000);

  it("still looks at the last year first: dated posts win when there are any", async () => {
    const g = await withPosts([
      post("content:dated", "Dated reel", "reel", 300, { publishedAt: "2026-09-20" }),
      post("content:undated", "Undated reel", "reel", 9000),
    ]);
    const f = await companyFacts(g, "shop", NOW);
    expect(f.worked.map((l) => l.split(":")[0])).toEqual(["Dated reel (reel)"]);
  }, 60_000);

  it("a business with no numbers at all says so", async () => {
    const g = await withPosts([]);
    const f = await companyFacts(g, "shop", NOW);
    expect(f.worked).toEqual([]);
    expect(companySkills(f).find((s) => s.id.endsWith("-reel"))!.text).toMatch(/No reel or post numbers recorded yet/);
  }, 60_000);
});
