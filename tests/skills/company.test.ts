// Each business's own skills (<company>-brand-voice, -domain, -reel, -ad), written from its own graph at onboarding:
// every line from its records, kept in its graph only, versioned, never over the owner's own version, refined by rules
// on the shipped base skill, and opened first for a reel or an ad.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureRoster } from "../../src/agent/memory.js";
import { loadBusinessSkills } from "../../src/agent/skills/business.js";
import { codeCatalog, SkillCatalog } from "../../src/agent/skills/catalog.js";
import { companyFacts, companySkills, companySkillVersions, companySlug, writeCompanySkills } from "../../src/agent/skills/company.js";
import { lintBusinessSkill } from "../../src/agent/skills/format.js";
import { skillsBlock } from "../../src/agent/skills/render.js";
import { useSkill } from "../../src/agent/tools/skills.js";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { upsertNode, writeBatch } from "../../src/graph/upsert.js";
import { AGENTS } from "../../shared/roster.js";
import { testGraph } from "../helpers/graph.js";
import { NOW, stubCtx } from "../helpers/agent.js";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => { for (const c of cleanups) await c(); await closeAll(); });

async function business(): Promise<GraphHandle> {
  const { g, cleanup } = await testGraph();
  cleanups.push(cleanup);
  await ensureIndexes(g);
  return g;
}

describe("company skills from a business's own graph (integration)", () => {
  let g: GraphHandle;
  let other: GraphHandle;
  beforeAll(async () => {
    g = await business();
    other = await business();
    const s = await writeBatch(g, {
      nodes: [
        { type: "Business", id: "business:harbour-bakery", name: "Harbour Bakery", summary: "A sourdough bakery by the harbour, baking since 2019." },
        { type: "BrandRule", id: "brand-rule:tone", name: "Tone", props: { kind: "tone", text: "Warm, plain and unhurried." } },
        { type: "BrandRule", id: "brand-rule:no-hype", name: "No hype", props: { kind: "voice", text: "Don't use hype words like amazing." } },
        { type: "BrandRule", id: "brand-rule:colours", name: "Colours", props: { kind: "visual", text: "Cream background, deep blue text." } },
        { type: "Audience", id: "audience:neighbours", name: "Neighbours who walk to work" },
        { type: "Product", id: "product:sourdough", name: "Sourdough loaf", summary: "Baked every morning from 6." },
        { type: "Rule", id: "rule:hook-cost", name: "Cost hook", props: { kind: "hook", template: "{Amount} is what {one mistake} cost me." } },
        { type: "Rule", id: "rule:learned-say-loaf", name: "Say loaf", props: { kind: "learned", text: "Say \"loaf\", not \"bread\".", status: "active", confidence: 0.7 } },
      ],
    }, NOW);
    expect(s.errors).toEqual([]);
    await ensureRoster(g, { businessId: "business:harbour-bakery" }, NOW);
    await ensureRoster(other, {}, NOW);
  }, 60_000);

  it("gathers the facts from the records", async () => {
    const f = await companyFacts(g, "harbour_bakery", NOW);
    expect(f.slug).toBe("harbour-bakery");
    expect(f.name).toBe("Harbour Bakery");
    expect(f.tone.join()).toMatch(/Warm, plain/);
    expect(f.donts.join()).toMatch(/hype words/);
    expect(f.visual.join()).toMatch(/Cream background/);
    expect(f.sayInstead).toEqual(['Say "loaf", not "bread".']);
    expect(f.products.join()).toMatch(/Sourdough loaf: Baked every morning/);
    expect(f.hooks.join()).toMatch(/\{Amount\} is what/);
  });

  it("writes four skills for the right people, each fit to use, with the shipped base it refines", async () => {
    const r = await writeCompanySkills(g, { tenant: "harbour_bakery", now: NOW });
    expect(r.written.sort()).toEqual(["harbour-bakery-ad", "harbour-bakery-brand-voice", "harbour-bakery-domain", "harbour-bakery-reel"]);
    const mine = await loadBusinessSkills(g);
    const by = (id: string) => mine.skills.find((s) => s.id === id)!;
    expect(by("harbour-bakery-reel")).toMatchObject({ agents: ["content-strategist"], base: "reel-script", source: "business", name: "Harbour Bakery reels" });
    expect(by("harbour-bakery-ad").agents.sort()).toEqual(["content-strategist", "growth-marketer"]);
    expect(by("harbour-bakery-ad").base).toBe("photo-to-ad-brief");
    expect(by("harbour-bakery-brand-voice").base).toBe("brand-voice-check");
    expect(by("harbour-bakery-domain").agents).toContain("fact-checker");
    expect(by("harbour-bakery-brand-voice").body).toMatch(/Say "loaf", not "bread"/);
    expect(by("harbour-bakery-reel").body).toMatch(/Neighbours who walk to work/);
    for (const s of mine.skills) {
      expect(lintBusinessSkill({ id: s.id, name: s.name, when: s.when, body: s.body, agents: s.agents }, (a) => AGENTS.find((x) => x.id === a)?.tools), s.id).toEqual([]);
      expect(s.body).not.toContain("[[");
    }
    // another business has none: they live in this graph only
    expect((await loadBusinessSkills(other)).skills).toEqual([]);
  });

  it("writing again with nothing new changes nothing; a new fact makes a new version that replaces the old", async () => {
    expect((await writeCompanySkills(g, { tenant: "harbour_bakery", now: NOW + 1 })).written).toEqual([]);
    await upsertNode(g, { type: "BrandRule", id: "brand-rule:never-discount", name: "Never discount", props: { kind: "voice", text: "Never offer discounts." } }, NOW + 2);
    const r = await writeCompanySkills(g, { tenant: "harbour_bakery", now: NOW + 3 });
    expect(r.written).toContain("harbour-bakery-brand-voice");
    const versions = await companySkillVersions(g, "harbour-bakery-brand-voice");
    expect(versions.map((v) => [v.version, v.status])).toEqual([[2, "active"], [1, "superseded"]]);
    const [sup] = await g.roQuery<{ c: number }>("MATCH (:Memory {id:$a})-[:SUPERSEDES]->(:Memory {id:$b}) RETURN count(*) AS c", { a: versions[0]!.id, b: versions[1]!.id });
    expect(sup!.c).toBe(1);
    expect((await loadBusinessSkills(g)).skills.filter((s) => s.id === "harbour-bakery-brand-voice")).toHaveLength(1);
  });

  it("never overwrites a version the owner wrote", async () => {
    const [cur] = await g.roQuery<{ id: string }>("MATCH (m:Memory) WHERE m.skillId = 'harbour-bakery-ad' AND m.status = 'active' RETURN m.id AS id");
    await upsertNode(g, { type: "Memory", id: cur!.id, name: "Skill: our ads", props: { origin: "owner" } }, NOW + 4);
    await upsertNode(g, { type: "Product", id: "product:rye", name: "Rye loaf" }, NOW + 5);
    const r = await writeCompanySkills(g, { tenant: "harbour_bakery", now: NOW + 6 });
    expect(r.kept).toContain("harbour-bakery-ad");
  });

  it("is opened first for a reel, and the owner's and the edits' rules on the base skill reach it", async () => {
    const mine = await loadBusinessSkills(g);
    const catalog = codeCatalog().withBusiness({ ...mine, rules: [{ id: "memory:r", skillId: "reel-script", agents: ["content-strategist"], text: "No music under speech." }] });
    const block = skillsBlock(catalog.forAgent("content-strategist"));
    expect(block.indexOf("harbour-bakery-reel")).toBeLessThan(block.indexOf("- reel-script"));
    expect(block).toMatch(/open the business's own one first/);
    const r = await useSkill.run({ id: "harbour-bakery-reel" }, stubCtx({ agentId: "content-strategist", graph: g, skills: catalog }));
    expect(r.guidance).toMatch(/SKILL: Harbour Bakery reels \(set up for this business\)/);
    expect(r.guidance).toMatch(/No music under speech\./);
    expect(r.data).toMatchObject({ skill: "harbour-bakery-reel", source: "business" });
    // Rohan sees the ad skill first too
    expect(skillsBlock(catalog.forAgent("growth-marketer")).indexOf("harbour-bakery-ad")).toBeLessThan(skillsBlock(catalog.forAgent("growth-marketer")).indexOf("- ad-budget-check"));
  });

  it("a business with an empty graph still gets honest skills that say what is not recorded", () => {
    const s = companySkills({ slug: companySlug("New Shop!"), name: "New Shop", summary: "", tone: [], dos: [], donts: [], visual: [], sayInstead: [], audiences: [], needs: [], products: [], features: [], hooks: [], worked: [], weakest: [], channels: [] });
    expect(s.map((x) => x.id)).toEqual(["new-shop-brand-voice", "new-shop-domain", "new-shop-reel", "new-shop-ad"]);
    expect(s[1]!.text).toMatch(/No products or services recorded/);
    expect(new SkillCatalog().withBusiness({ skills: [], rules: [] }).skills).toEqual([]);
  });
});
