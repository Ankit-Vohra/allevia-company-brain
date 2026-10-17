// A business's own skills and skill rules: said in plain words (parsed deterministically), previewed and applied through
// the directives flow, kept in that business's own graph, laid over the shipped skills, shown with the skill when it is
// opened, and attached to the right skill when the team learns from the owner's edits.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { writeBatch } from "../../src/graph/upsert.js";
import { learnFromEdit } from "../../src/actions/learning.js";
import { ensureRoster } from "../../src/agent/memory.js";
import { loadBusinessSkills, retireSkillNote, skillsForLearnedRule } from "../../src/agent/skills/business.js";
import { codeCatalog } from "../../src/agent/skills/catalog.js";
import { SKILL_TARGETS, targetsIn } from "../../src/agent/skills/targets.js";
import { useSkill } from "../../src/agent/tools/skills.js";
import { applyDirective, parseDirective, patchesFromModel, previewDirective, skillIdFor } from "../../src/settings/directives.js";
import { testGraph } from "../helpers/graph.js";
import { NOW, stubCtx } from "../helpers/agent.js";

describe("what the owner's words are about", () => {
  it("every target names a shipped skill and one of its agents", () => {
    const code = codeCatalog();
    for (const t of SKILL_TARGETS) {
      const s = code.skills.find((k) => k.id === t.skill);
      expect(s, t.skill).toBeDefined();
      for (const a of t.agents) expect(s!.agents, `${t.skill} / ${a}`).toContain(a);
    }
  });

  it("posts, reels and carousels each point at their own skill; a narrower word beats 'Instagram'", () => {
    expect(targetsIn("our posts always end with a question")).toEqual([{ skill: "instagram-post", agents: ["content-strategist"] }]);
    expect(targetsIn("Instagram reels never use music").map((t) => t.skill)).toEqual(["reel-script"]);
    expect(targetsIn("carousels start with a number").map((t) => t.skill)).toEqual(["carousel-post"]);
    expect(targetsIn("our posts end with a question", ["growth-marketer"])).toEqual([]);
  });
});

describe("parseDirective: skill rules and skills", () => {
  it("'our posts always end with a question' is a rule for Miss Influencer's post craft, and Wordsmith's voice check holds it too", () => {
    const r = parseDirective("Our posts always end with a question");
    expect(r.unparsed).toEqual([]);
    expect(r.patches).toEqual([
      { kind: "skill.rule", agents: ["content-strategist"], skill: "instagram-post", text: "Our posts always end with a question." },
      { kind: "skill.rule", agents: ["copy-editor"], skill: "brand-voice-check", text: "Our posts always end with a question." },
    ]);
  });

  it("a rule addressed to someone who does not own that work is not a skill rule", () => {
    expect(parseDirective("Growth Hacker, our posts always end with a question").patches.some((p) => p.kind === "skill.rule" && p.skill === "instagram-post")).toBe(false);
  });

  it("a way of writing with no particular work goes on all of the writers' skills; a rule scoped to a channel stays an instruction", () => {
    expect(parseDirective("Quote prices in AED").patches).toEqual([
      { kind: "skill.rule", agents: ["content-strategist", "copy-editor", "growth-marketer"], skill: "*", text: "Quote prices in AED." },
    ]);
    expect(parseDirective("Miss Influencer, never use emojis").patches).toEqual([{ kind: "skill.rule", agents: ["content-strategist"], skill: "*", text: "Never use emojis." }]);
    expect(parseDirective("No emojis on LinkedIn posts").patches.map((p) => p.kind)).toEqual(["memory.instruction"]);
    expect(parseDirective("make the captions punchier").unparsed).toEqual(["make the captions punchier"]);
  });

  it("'Miss Influencer, add a skill called Festival post: …' is a skill of this business's own", () => {
    const r = parseDirective("Miss Influencer, add a skill called Festival post: open with the greeting in Hindi, then the offer, then the last date");
    expect(r.patches).toEqual([{
      kind: "skill.add", agents: ["content-strategist"], id: "festival-post", name: "Festival post",
      when: "When the request is about festival post", text: "Open with the greeting in Hindi, then the offer, then the last date.",
    }]);
    expect(parseDirective("Add a skill called Festival post: open with the greeting in Hindi").notes[0]).toMatch(/Say who the skill is for/);
  });

  it("the model's skill patches are checked: an unknown skill id, no agent or no text is dropped", () => {
    const r = patchesFromModel({
      patches: [
        { kind: "skill.rule", agents: ["content-strategist"], skill: "reel-script", text: "no music" },
        { kind: "skill.rule", agents: ["content-strategist"], skill: "made-up-skill", text: "x" },
        { kind: "skill.rule", agents: [], skill: "reel-script", text: "x" },
        { kind: "skill.add", agents: ["copy-editor"], name: "Our sign-off", text: "End with the founder's first name", when: "When signing off" },
      ], unclear: [],
    });
    expect(r.patches.map((p) => p.kind)).toEqual(["skill.rule", "skill.add"]);
    expect(r.patches[1]).toMatchObject({ id: "our-sign-off", name: "Our sign-off" });
  });

  it("makes an id from any name, even one with no latin letters", () => {
    expect(skillIdFor("Festival post")).toBe("festival-post");
    expect(skillIdFor("Poster")).toBe("poster-skill");
    expect(skillIdFor("त्योहार")).toMatch(/^[a-z][a-z0-9-]*-[a-z0-9]+$/);
  });
});

describe("a business's skills in its own graph (integration)", () => {
  let a: GraphHandle, b: GraphHandle;
  const cleanups: Array<() => Promise<void>> = [];

  const setup = async (name: string): Promise<GraphHandle> => {
    const { g, cleanup } = await testGraph();
    cleanups.push(cleanup);
    await ensureIndexes(g);
    const s = await writeBatch(g, { nodes: [{ type: "Business", id: `business:${name}`, name }, { type: "Person", id: "person:founder", name: "Founder" }] }, NOW);
    expect(s.errors).toEqual([]);
    await ensureRoster(g, { businessId: `business:${name}` }, NOW);
    return g;
  };

  beforeAll(async () => { a = await setup("kestrel-oak"); b = await setup("harbour-bakery"); });
  afterAll(async () => { for (const c of cleanups) await c(); await closeAll(); });

  it("applying 'our posts always end with a question' writes rules that load for that business only", async () => {
    const pv = await previewDirective(a, { text: "Our posts always end with a question" }, { llm: null, now: NOW });
    expect(pv.diff.map((l) => [l.op, l.label])).toEqual([
      ["add", "Rule for Miss Influencer's Instagram post craft"], ["add", "Rule for Wordsmith's Brand voice check"],
    ]);
    const done = await applyDirective(a, pv.id, { now: NOW + 1 });
    expect(done.errors).toEqual([]);

    const mine = await loadBusinessSkills(a);
    expect(mine.skills).toEqual([]);
    expect(mine.rules.map((r) => [r.skillId, r.agents, r.text])).toEqual([
      ["instagram-post", ["content-strategist"], "Our posts always end with a question."],
      ["brand-voice-check", ["copy-editor"], "Our posts always end with a question."],
    ]);
    // another business has nothing, and starts from the shipped packs alone
    expect(await loadBusinessSkills(b)).toEqual({ skills: [], rules: [] });
  });

  it("saying it again changes nothing: the preview shows it as already set, and applying twice writes nothing more", async () => {
    const pv = await previewDirective(a, { text: "Our posts always end with a question" }, { llm: null, now: NOW + 2 });
    expect(pv.diff.map((l) => l.op)).toEqual(["same", "same"]);
    await applyDirective(a, pv.id, { now: NOW + 3 });
    await applyDirective(a, pv.id, { now: NOW + 4 });
    expect((await loadBusinessSkills(a)).rules).toHaveLength(2);
  });

  it("use_skill shows that business's rules with the skill, and another business's skill does not see them", async () => {
    const catalog = codeCatalog().withBusiness(await loadBusinessSkills(a));
    const r = await useSkill.run({ id: "instagram-post" }, stubCtx({ agentId: "content-strategist", graph: a, skills: catalog }));
    expect(r.guidance).toMatch(/This business's own rules for this skill[\s\S]*Our posts always end with a question\./);
    const other = codeCatalog().withBusiness(await loadBusinessSkills(b));
    const r2 = await useSkill.run({ id: "instagram-post" }, stubCtx({ agentId: "content-strategist", graph: b, skills: other }));
    expect(r2.guidance).not.toMatch(/always end with a question/);
  });

  it("a skill of its own is added, and one with a shipped id replaces it for that business only", async () => {
    const pv = await previewDirective(a, { text: "Miss Influencer, add a skill called Festival post: open with the greeting in Hindi, then the offer" }, { llm: null, now: NOW + 5 });
    expect(pv.diff[0]).toMatchObject({ op: "add", label: "New skill for Miss Influencer: Festival post" });
    await applyDirective(a, pv.id, { now: NOW + 6 });
    const mine = await loadBusinessSkills(a);
    expect(mine.skills.map((s) => [s.id, s.agents, s.source])).toEqual([["festival-post", ["content-strategist"], "business"]]);
    const catalog = codeCatalog().withBusiness(mine);
    expect(catalog.forAgent("content-strategist").map((s) => s.id)).toContain("festival-post");
    expect(codeCatalog().forAgent("content-strategist").map((s) => s.id)).not.toContain("festival-post");
    const r = await useSkill.run({ id: "festival-post" }, stubCtx({ agentId: "content-strategist", graph: a, skills: catalog }));
    expect(r.guidance).toMatch(/SKILL: Festival post \(set up for this business\)[\s\S]*open with the greeting in Hindi/i);
    expect(r.data).toMatchObject({ source: "business" });

    // replacing a shipped skill: same id, the business's text wins for Miss Influencer, and its name and when stay the shipped ones
    const over = catalog.withBusiness({ skills: [{ ...mine.skills[0]!, id: "reel-script", name: "", when: "", body: "Reels here are always 15 seconds." }], rules: [] });
    expect(over.get("content-strategist", "reel-script")).toMatchObject({ source: "business", body: "Reels here are always 15 seconds." });
    expect(over.get("content-strategist", "reel-script")!.name).toBe(codeCatalog().get("content-strategist", "reel-script")!.name);
  });

  it("a rule can be taken out of use, and then no longer loads", async () => {
    const [rule] = (await loadBusinessSkills(a)).rules;
    expect(await retireSkillNote(a, rule!.id, NOW + 7)).toBe(true);
    expect((await loadBusinessSkills(a)).rules.map((r) => r.id)).not.toContain(rule!.id);
    expect(await retireSkillNote(a, "memory:nope", NOW + 8)).toBe(false);
  });

  it("a rule learned from the owner's edit attaches to the skill the draft came from, and a style rule to Wordsmith's voice check", async () => {
    expect(skillsForLearnedRule({ agentId: "content-strategist", draft: "A new reel script for the launch", op: "replace" })).toEqual(["reel-script", "brand-voice-check"]);
    expect(skillsForLearnedRule({ agentId: "content-strategist", draft: "A caption", op: "max_words" })).toEqual(["instagram-post"]);
    await writeBatch(a, { nodes: [{ type: "Approval", id: "approval:t-001-1", name: "Launch post" }] }, NOW);
    const learned = await learnFromEdit(a, {
      approvalId: "approval:t-001-1", original: { title: "Launch", body: "Tour this stunning villa 🎉" }, edited: { title: "Launch", body: "Tour this home" },
      agentId: "content-strategist", now: NOW + 9,
    });
    expect(learned.length).toBeGreaterThan(0);
    const catalog = codeCatalog().withBusiness(await loadBusinessSkills(a));
    const post = await useSkill.run({ id: "instagram-post" }, stubCtx({ agentId: "content-strategist", graph: a, skills: catalog }));
    expect(post.guidance).toMatch(/Things the team learned from the owner's edits that apply here:[\s\S]*Say "home", not "villa"/);
    const voice = await useSkill.run({ id: "brand-voice-check" }, stubCtx({ agentId: "copy-editor", graph: a, skills: catalog }));
    expect(voice.guidance).toMatch(/Say "home", not "villa"/);
    const reel = await useSkill.run({ id: "reel-script" }, stubCtx({ agentId: "content-strategist", graph: a, skills: catalog }));
    expect(reel.guidance).not.toMatch(/Say "home", not "villa"/); // a different skill
    // and not another business's
    const other = await useSkill.run({ id: "instagram-post" }, stubCtx({ agentId: "content-strategist", graph: b, skills: codeCatalog() }));
    expect(other.guidance).not.toMatch(/Say "home"/);
  });
});
