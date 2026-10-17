// Skills in a turn: the prompt lists each skill by name and when to use it (never the body), use_skill opens the text as
// guidance that is not evidence, and each use is an event, an office status line and a record on the outcome.
import { describe, it, expect } from "vitest";
import { z } from "zod";
import type { GraphHandle } from "../../src/graph/client.js";
import { runTurn, toolsFor, type TurnDeps, type TurnInput } from "../../src/agent/orchestrator.js";
import { agentSystemPrompt, planSystemPrompt } from "../../src/agent/prompts.js";
import { FakeRuntime, forModel, type FakeScript } from "../../src/agent/runtime.js";
import { SkillCatalog } from "../../src/agent/skills/catalog.js";
import type { Skill } from "../../src/agent/skills/format.js";
import { TouchedSet, type AlleviaTool } from "../../src/agent/tool.js";
import { useSkill } from "../../src/agent/tools/skills.js";
import { agentById } from "../../shared/roster.js";
import { fakeTool, recorder, result, stubCtx, NOW } from "../helpers/agent.js";

const mk = (id: string, agents: string[], over: Partial<Skill> = {}): Skill => ({
  id, name: `Craft of ${id}`, when: `When someone wants ${id}`, agents, tools: ["playbook"], output: "reads", needsOk: false,
  sections: { method: "1. a\n2. b\n3. c", style: "s", done: "- [ ] a", mistakes: "- x" },
  body: `## Method\n1. Open the playbook.\n2. Keep captions under 125 characters.\n3. Use 3 hashtags.\n\n## House style\nShort.`, source: "code", ...over,
});
const CATALOG = new SkillCatalog([mk("instagram-post", ["content-strategist"]), mk("voice-check", ["copy-editor"]), mk("plan-across-desks", ["chief-of-staff"])]);

const tools: Record<string, AlleviaTool> = {
  playbook: fakeTool("playbook", result({ data: { rules: [] }, nodes: [{ id: "rule:hook-1", label: "Rule", name: "Hook 1" }] })),
  get_entity: fakeTool("get_entity", result({ data: { followers: 2300 }, nodes: [{ id: "channel:instagram", label: "Channel", name: "Instagram" }] })),
  search: fakeTool("search", result({ data: [], nodes: [{ id: "channel:instagram", label: "Channel", name: "Instagram" }] })),
  show_path: fakeTool("show_path", (a) => result({ data: {}, nodes: (a.ids as string[]).map((id) => ({ id, label: "Entity", name: id })) }), { ids: z.array(z.string()) }),
  use_skill: useSkill,
};
const getTools = (names: string[]) => names.map((n) => tools[n]).filter((t): t is AlleviaTool => !!t);

const INPUT: TurnInput = {
  tenant: "kestrel", question: "Write an Instagram post about the harbour house", sessionId: "session:s1", turnId: "turn:t1", asker: "person:founder", recall: { text: "", ids: [] },
};
const PLAN: FakeScript = { structured: { steps: [{ agent: "content-strategist", task: "Write the post" }], rationale: "content" } };

function setup(scripts: Record<string, FakeScript>, over: Partial<TurnDeps> = {}) {
  const runtime = new FakeRuntime({ "chief-of-staff:plan": PLAN, ...scripts });
  const rec = recorder();
  const deps: TurnDeps = { runtime, getTools, graph: {} as GraphHandle, now: NOW, ...over };
  return { runtime, ...rec, run: () => runTurn(INPUT, deps, rec.emit) };
}

describe("the prompt lists skills by name and when, never the body", () => {
  it("shows id, name and when for an agent that can open its skills", () => {
    const tara = agentById("content-strategist")!;
    const p = agentSystemPrompt(tara, [tools.use_skill!], { now: NOW, tenant: "t", skills: CATALOG.forAgent(tara.id) });
    expect(p).toContain("Your skills");
    expect(p).toContain("- instagram-post: Craft of instagram-post. Use it for: When someone wants instagram-post");
    expect(p).toContain("use_skill");
    expect(p).not.toContain("Keep captions under 125 characters");
    expect(p).not.toContain("voice-check");
  });

  it("no skills, no block (and a business's own skill is marked as theirs)", () => {
    const tara = agentById("content-strategist")!;
    expect(agentSystemPrompt(tara, [], { now: NOW, tenant: "t" })).not.toContain("Your skills");
    const mine = new SkillCatalog([mk("our-poster", ["content-strategist"], { source: "business" })]);
    expect(agentSystemPrompt(tara, [], { now: NOW, tenant: "t", skills: mine.forAgent(tara.id) })).toContain("(set up for this business)");
  });

  it("the planner sees each desk's skill names so it can route to the right desk", () => {
    const p = planSystemPrompt({ now: NOW, tenant: "t", skills: CATALOG });
    expect(p).toMatch(/content-strategist: Miss Influencer.*Skills: Craft of instagram-post\./);
    expect(p).toMatch(/copy-editor: Wordsmith.*Skills: Craft of voice-check\./);
    expect(p).not.toContain("Keep captions under 125 characters");
    expect(planSystemPrompt({ now: NOW, tenant: "t" })).not.toContain("Skills:");
  });

  it("keeps the owner's own week with the Chief, with time estimates (live trial: handing it on made it slower and lost them)", () => {
    expect(planSystemPrompt({ now: NOW, tenant: "t" })).toMatch(/"what do I do this week"[^\n]*plan only "chief-of-staff"[^\n]*what-do-i-do-this-week skill[^\n]*time estimate/);
  });
});

describe("toolsFor gives use_skill only to an agent that has skills", () => {
  const names = (agentId: string, phase: Parameters<typeof toolsFor>[1], skills?: SkillCatalog) =>
    toolsFor(agentById(agentId)!, phase, getTools, skills ? { skills } : {}).map((t) => t.name);

  it("adds it in work, review, revise and the Chief's answer; not without skills, not for an agent with none", () => {
    expect(names("content-strategist", "work", CATALOG)).toContain("use_skill");
    expect(names("copy-editor", "review", CATALOG)).toContain("use_skill");
    expect(names("content-strategist", "revise", CATALOG)).toContain("use_skill");
    expect(names("chief-of-staff", "synthesis", CATALOG)).toContain("use_skill");
    expect(names("content-strategist", "work")).not.toContain("use_skill");
    expect(names("fact-checker", "review", CATALOG)).not.toContain("use_skill");
    expect(names("content-strategist", "plan", CATALOG)).not.toContain("use_skill"); // only the Chief plans
  });
});

describe("use_skill", () => {
  const ctx = (agentId: string, skills: SkillCatalog | undefined = CATALOG) => stubCtx({ agentId, ...(skills ? { skills } : {}) });

  it("returns the whole text as guidance, and nothing a number or citation check could count", async () => {
    const r = await useSkill.run({ id: "instagram-post" }, ctx("content-strategist"));
    expect(r.guidance).toContain("Keep captions under 125 characters");
    expect(r.guidance).toContain("SKILL: Craft of instagram-post");
    expect(r.guidance).toMatch(/not evidence/);
    expect(r.data).toEqual({ skill: "instagram-post", name: "Craft of instagram-post", source: "code" });
    expect(r.nodes).toEqual([]);
    const touched = new TouchedSet();
    touched.add(r);
    expect([...touched.numbers()]).toEqual([]); // "125" and "3" in the skill do not ground a number in an answer
    expect(forModel(r)).toContain("Keep captions under 125 characters");
  });

  it("an agent can only open its own skills, and is told which it has", async () => {
    const r = await useSkill.run({ id: "voice-check" }, ctx("content-strategist"));
    expect((r.data as { error: string }).error).toBe('Miss Influencer has no skill "voice-check". Yours: instagram-post.');
    expect(((await useSkill.run({ id: "x-y" }, ctx("librarian"))).data as { error: string }).error).toMatch(/You have no skills/);
    expect(((await useSkill.run({ id: "x-y" }, ctx("librarian", null as never))).data as { error: string }).error).toMatch(/No skills are set up/);
  });

  it("puts the business's own rules for that skill into the text, before the closing reminder", async () => {
    const mine = CATALOG.withBusiness({ skills: [], rules: [{ id: "memory:r1", skillId: "instagram-post", agents: ["content-strategist"], text: "End every post with a question.", channel: { id: "channel:instagram", name: "Instagram" } }] });
    const r = await useSkill.run({ id: "instagram-post" }, ctx("content-strategist", mine));
    expect(r.guidance).toMatch(/This business's own rules for this skill[\s\S]*- End every post with a question\. \(on Instagram\)/);
    expect(r.guidance!.indexOf("End every post")).toBeLessThan(r.guidance!.indexOf("This is a way of working"));
  });
});

describe("a turn that opens a skill", () => {
  const scripts = (): Record<string, FakeScript> => ({
    "content-strategist": {
      calls: [{ name: "use_skill", args: { id: "instagram-post" } }, { name: "get_entity", args: { id: "channel:instagram" } }],
      structured: { text: "The account has a following [[channel:instagram]].", citations: ["channel:instagram"] },
    },
    "copy-editor": { calls: [{ name: "use_skill", args: { id: "voice-check" } }], structured: { verdict: "ok", note: "fine" } },
    "fact-checker": { structured: { verdict: "ok", note: "fine" } },
    "chief-of-staff:synthesis": { calls: [{ name: "show_path", args: { ids: ["channel:instagram"] } }], text: "Here is the post [[channel:instagram]]." },
  });

  it("emits skill_used and a plain status line, and records each skill once per agent on the outcome", async () => {
    const s = setup(scripts(), { skills: CATALOG });
    const out = await s.run();
    const used = s.events.filter((e) => e.type === "skill_used");
    expect(used).toEqual([
      { type: "skill_used", agent: "content-strategist", skillId: "instagram-post", name: "Craft of instagram-post", source: "code" },
      { type: "skill_used", agent: "copy-editor", skillId: "voice-check", name: "Craft of voice-check", source: "code" },
    ]);
    expect(s.events.some((e) => e.type === "agent_status" && e.agent === "content-strategist" && e.text === "Miss Influencer is using: Craft of instagram-post")).toBe(true);
    expect(out.skills.map((u) => `${u.agent}/${u.skillId}`)).toEqual(["content-strategist/instagram-post", "copy-editor/voice-check"]);
    expect(out.findings[0]!.skills).toEqual(["instagram-post"]);
  });

  it("the work prompt's system text lists the skills; the skill text is not in it", async () => {
    const s = setup(scripts(), { skills: CATALOG });
    await s.run();
    const work = s.runtime.runs.find((r) => r.agentId === "content-strategist" && r.phase === "work")!;
    expect(work.system).toContain("- instagram-post:");
    expect(work.system).not.toContain("Keep captions under 125 characters");
    expect(work.tools.map((t) => t.name)).toContain("use_skill");
    const review = s.runtime.runs.find((r) => r.agentId === "copy-editor" && r.phase === "review")!;
    expect(review.system).toContain("Open the one that fits the draft you are checking");
  });

  it("the skill's own numbers never ground a number in the answer", async () => {
    const s = setup({
      ...scripts(),
      "content-strategist": {
        calls: [{ name: "use_skill", args: { id: "instagram-post" } }],
        structured: { text: "The caption is under 125 characters [[rule:hook-1]].", citations: ["rule:hook-1"] },
      },
    }, { skills: CATALOG });
    const out = await s.run();
    const f = out.findings[0]!;
    expect([...out.touched.numbers()]).not.toContain("125");
    expect(f.citations).toEqual([]); // rule:hook-1 was never returned by a tool this turn
  });

  it("without a catalog nothing changes: no skills block, no use_skill, no event", async () => {
    const s = setup(scripts());
    const out = await s.run();
    const work = s.runtime.runs.find((r) => r.agentId === "content-strategist" && r.phase === "work")!;
    expect(work.system).not.toContain("Your skills");
    expect(work.tools.map((t) => t.name)).not.toContain("use_skill");
    expect(s.events.some((e) => e.type === "skill_used")).toBe(false);
    expect(out.skills).toEqual([]);
  });

  it("a skill the plan names is to be opened first; one it does not name is only listed", async () => {
    const named = setup({ ...scripts(), "chief-of-staff:plan": { structured: { steps: [{ agent: "content-strategist", task: "Write the post with the instagram-post skill" }], rationale: "content" } } }, { skills: CATALOG });
    await named.run();
    expect(named.runtime.runs.find((r) => r.phase === "work")!.prompt).toMatch(/Your plan names your skill instagram-post: open it with use_skill in your first round/);
    const plain = setup(scripts(), { skills: CATALOG });
    await plain.run();
    expect(plain.runtime.runs.find((r) => r.phase === "work")!.prompt).not.toMatch(/Your plan names your skill/);
  });

  it("the Chief may open its planning skill while planning", async () => {
    const s = setup({
      ...scripts(),
      "chief-of-staff:plan": { calls: [{ name: "use_skill", args: { id: "plan-across-desks" } }], structured: { steps: [{ agent: "content-strategist", task: "Write the post" }], rationale: "content" } },
    }, { skills: CATALOG });
    const out = await s.run();
    const plan = s.runtime.runs.find((r) => r.phase === "plan")!;
    expect(plan.tools.map((t) => t.name)).toEqual(["use_skill"]);
    expect(plan.system).toContain("Open one only when the request really needs it");
    expect(out.skills.map((u) => u.skillId)).toContain("plan-across-desks");
  });
});

describe("skills the owner switched off", () => {
  it("are left out of the agent's list and cannot be opened, while the others stay", () => {
    const two = new SkillCatalog([mk("instagram-post", ["content-strategist"]), mk("reel-script", ["content-strategist"]), mk("voice-check", ["copy-editor"])]);
    const off = two.restrict({ "content-strategist": ["instagram-post"] });
    expect(off.forAgent("content-strategist").map((s) => s.id)).toEqual(["reel-script"]);
    expect(off.get("content-strategist", "instagram-post")).toBeUndefined();
    expect(off.forAgent("copy-editor").map((s) => s.id)).toEqual(["voice-check"]);
    expect(off.allFor("content-strategist").map((s) => s.id)).toEqual(["instagram-post", "reel-script"]); // the header still lists it
    expect(two.restrict({}) === two).toBe(true);
    // a business's own skills laid over a restricted catalog keep the restriction
    expect(off.withBusiness({ skills: [], rules: [] }).forAgent("content-strategist").map((s) => s.id)).toEqual(["reel-script"]);
  });
});

