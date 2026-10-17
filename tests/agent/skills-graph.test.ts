// Skills and rules as edges (graph audit G2): a skill a turn opens is a Playbook{kind:'skill'} node, the agent USES it, the Turn
// TOUCHED it and the Finding of its desk is GUIDED_BY it; the rules use_skill showed (the business's own rules for the skill, the
// lessons learned from edits) are GUIDED_BY edges from the Turn and the Finding; search never returns a skill.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { z } from "zod";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { writeBatch } from "../../src/graph/upsert.js";
import { ask, type AskDeps } from "../../src/agent/ask.js";
import { ensureRoster } from "../../src/agent/memory.js";
import { skillRulesShown } from "../../src/agent/orchestrator.js";
import { FakeRuntime, type FakeScript } from "../../src/agent/runtime.js";
import { SkillCatalog } from "../../src/agent/skills/catalog.js";
import type { Skill } from "../../src/agent/skills/format.js";
import type { AlleviaTool } from "../../src/agent/tool.js";
import { search } from "../../src/agent/tools/search.js";
import { useSkill } from "../../src/agent/tools/skills.js";
import { testGraph } from "../helpers/graph.js";
import { fakeTool, result, NOW } from "../helpers/agent.js";
import { call, makeCtx } from "../helpers/tools.js";

const mk = (id: string, agents: string[], over: Partial<Skill> = {}): Skill => ({
  id, name: `Craft of ${id}`, when: `When someone wants ${id}`, agents, tools: ["playbook"], output: "reads", needsOk: false,
  sections: { method: "1. a", style: "s", done: "- [ ] a", mistakes: "- x" }, body: "## Method\n1. Open the playbook.", source: "code", ...over,
});

describe("skillRulesShown reads use_skill's data", () => {
  it("takes the rule ids (with the channel one is scoped to) and the learned rule ids, and ignores anything else", () => {
    expect(skillRulesShown("content-strategist", {
      skill: "instagram-post", rules: [{ id: "memory:a" }, { id: "memory:b", channel: { id: "channel:linkedin", name: "LinkedIn" } }, { nope: 1 }, "x"], learned: ["rule:l", 7, ""],
    })).toEqual([
      { agent: "content-strategist", id: "memory:a" },
      { agent: "content-strategist", id: "memory:b", channel: { id: "channel:linkedin", name: "LinkedIn" } },
      { agent: "content-strategist", id: "rule:l" },
    ]);
    expect(skillRulesShown("a", { skill: "x" })).toEqual([]);
  });
});

describe("a skill a turn opens is in the graph, and what guided the turn are edges", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  const rows = <T>(q: string, p: Record<string, unknown> = {}) => g.roQuery<T>(q, p);

  // the business's own rules for the skill: one for every channel, one only for LinkedIn (not touched or named by the turn)
  const CATALOG = new SkillCatalog([mk("instagram-post", ["content-strategist"])]).withBusiness({ skills: [], rules: [
    { id: "memory:skill-rule-question", skillId: "instagram-post", agents: ["content-strategist"], text: "End every post with a question." },
    { id: "memory:skill-rule-linkedin", skillId: "instagram-post", agents: ["content-strategist"], text: "No hashtags.", channel: { id: "channel:linkedin", name: "LinkedIn" } },
  ] });

  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await ensureIndexes(g);
    await ensureRoster(g, {}, NOW - 86_400_000);
    const s = await writeBatch(g, { nodes: [
      { type: "Channel", id: "channel:instagram", name: "Instagram" },
      { type: "Channel", id: "channel:linkedin", name: "LinkedIn" },
      { type: "Memory", id: "memory:skill-rule-question", name: "End every post with a question.", props: { kind: "skill_rule", skillId: "instagram-post", text: "End every post with a question.", status: "active" } },
      { type: "Memory", id: "memory:skill-rule-linkedin", name: "No hashtags.", props: { kind: "skill_rule", skillId: "instagram-post", text: "No hashtags.", status: "active" } },
      { type: "Rule", id: "rule:learned-say-home-not-villa", name: 'Say "home", not "villa".', props: { kind: "learned", text: 'Say "home", not "villa".', status: "active", op: "replace", find: "villa", replace: "home", confidence: 0.7, skills: ["instagram-post"] } },
      { type: "Rule", id: "rule:learned-other-skill", name: "Another skill's lesson", props: { kind: "learned", text: "Another skill's lesson.", status: "active", op: "instruction", confidence: 0.6, skills: ["reel-script"] } },
    ] }, NOW - 86_400_000);
    expect(s.errors).toEqual([]);
  });
  afterAll(async () => { await cleanup(); await closeAll(); });

  const tools: Record<string, AlleviaTool> = {
    use_skill: useSkill,
    playbook: fakeTool("playbook", result({ data: { rules: [] }, nodes: [{ id: "channel:instagram", label: "Channel", name: "Instagram" }] })),
    show_path: fakeTool("show_path", (a) => result({ data: {}, nodes: (a.ids as string[]).map((id) => ({ id, label: "Entity", name: id })) }), { ids: z.array(z.string()) }),
  };
  const getTools = (names: string[]) => names.map((n) => tools[n]).filter((t): t is AlleviaTool => !!t);
  const ok: FakeScript = { structured: { verdict: "ok", note: "ok" } };
  const scripts: Record<string, FakeScript> = {
    "chief-of-staff:plan": { structured: { steps: [{ agent: "content-strategist", task: "Write the Instagram post" }], rationale: "content" } },
    "content-strategist": {
      calls: [{ name: "use_skill", args: { id: "instagram-post" } }, { name: "playbook", args: {} }],
      structured: { text: "Post draft for Instagram [[channel:instagram]].", citations: ["channel:instagram"] },
    },
    "copy-editor": ok, "fact-checker": ok, "coe-lead": ok,
    "chief-of-staff:synthesis": { calls: [{ name: "show_path", args: { ids: ["channel:instagram"] } }], text: "Here is the post for Instagram [[channel:instagram]]." },
  };
  let turnId = "";

  it("the Playbook node, who USES it, what the Turn TOUCHED, what the Finding was GUIDED_BY", async () => {
    const deps: AskDeps = { runtime: new FakeRuntime(scripts), getTools, graph: g, now: () => NOW, skills: CATALOG };
    const r = await ask({ tenant: "t", question: "Write an Instagram post about the harbour house", channel: "cli" }, deps, () => {});
    expect(r.ok).toBe(true);
    turnId = r.turnId;
    expect(r.outcome?.skills.map((s) => s.skillId)).toEqual(["instagram-post"]);

    const [pb] = await rows<Record<string, unknown>>("MATCH (p:Playbook {id:'playbook:skill-instagram-post'}) RETURN p.kind AS kind, p.skillId AS skillId, p.source AS source, p.name AS name");
    expect(pb).toEqual({ kind: "skill", skillId: "instagram-post", source: "code", name: "Craft of instagram-post" });
    const [uses] = await rows<{ src: string; asOf: string }>("MATCH (:Agent {id:'agent:allevia-content-strategist'})-[e:USES]->(:Playbook {id:'playbook:skill-instagram-post'}) RETURN e.src AS src, e.asOf AS asOf");
    expect(uses).toEqual({ src: turnId, asOf: "2026-10-15" });
    expect((await rows("MATCH (:Turn {id:$t})-[e:TOUCHED]->(:Playbook {id:'playbook:skill-instagram-post'}) RETURN e.src AS src", { t: turnId }))).toEqual([{ src: turnId }]);
    // "which turns used this skill" is a traversal, and so is "what did this desk's finding follow"
    expect((await rows<{ id: string }>("MATCH (t:Turn)-[:TOUCHED]->(:Playbook {id:'playbook:skill-instagram-post'}) RETURN t.id AS id ORDER BY id")).map((x) => x.id)).toEqual([turnId]);
    const guided = await rows<{ id: string }>(
      "MATCH (f:Finding)-[:PART_OF]->(:Turn {id:$t}) WITH f MATCH (f)-[e:GUIDED_BY]->(x:Entity) WHERE e.until IS NULL RETURN x.id AS id ORDER BY id", { t: turnId });
    expect(guided.map((x) => x.id)).toEqual(["memory:skill-rule-question", "playbook:skill-instagram-post", "rule:learned-say-home-not-villa"]);
  });

  it("the rules use_skill showed are GUIDED_BY the Turn; a rule scoped to a channel the turn never touched is not; another skill's lesson is not", async () => {
    const turnGuides = await rows<{ id: string; src: string; asOf: string }>("MATCH (:Turn {id:$t})-[e:GUIDED_BY]->(x:Entity) WHERE e.until IS NULL RETURN x.id AS id, e.src AS src, e.asOf AS asOf ORDER BY id", { t: turnId });
    expect(turnGuides.map((x) => x.id)).toEqual(["memory:skill-rule-question", "rule:learned-say-home-not-villa"]);
    expect(turnGuides.every((x) => x.src === turnId && x.asOf === "2026-10-15")).toBe(true);
  });

  it("the data use_skill returns names the rule ids (and nothing a citation could use)", async () => {
    const ctx = makeCtx(g, { agentId: "content-strategist", skills: CATALOG, readOnly: true });
    const r = await call(useSkill, { id: "instagram-post" }, ctx);
    expect(r.data).toEqual({
      skill: "instagram-post", name: "Craft of instagram-post", source: "code",
      rules: [{ id: "memory:skill-rule-question" }, { id: "memory:skill-rule-linkedin", channel: { id: "channel:linkedin", name: "LinkedIn" } }],
      learned: ["rule:learned-say-home-not-villa"],
    });
    expect(r.nodes).toEqual([]);
  });

  it("a business's own version of the skill is the same node, marked source business; read-only opens write nothing", async () => {
    const mine = new SkillCatalog([mk("instagram-post", ["content-strategist"], { source: "business" })]);
    await call(useSkill, { id: "instagram-post" }, makeCtx(g, { agentId: "content-strategist", skills: mine }));
    expect((await rows<{ source: string }>("MATCH (p:Playbook {id:'playbook:skill-instagram-post'}) RETURN p.source AS source"))[0]!.source).toBe("business");
    // a read-only caller (the MCP server, a benchmark) opens a skill without leaving a node behind
    const readOnly = new SkillCatalog([mk("reel-script", ["content-strategist"])]);
    await call(useSkill, { id: "reel-script" }, makeCtx(g, { agentId: "content-strategist", skills: readOnly, readOnly: true }));
    expect(await rows("MATCH (p:Playbook {id:'playbook:skill-reel-script'}) RETURN p.id AS id")).toEqual([]);
  });

  it("search never returns a skill, by its name or by what it is for", async () => {
    const byName = await call(search, { query: "Craft of instagram-post" }, makeCtx(g));
    const byWhen = await call(search, { query: "When someone wants instagram-post", types: ["Playbook"] }, makeCtx(g));
    for (const r of [byName, byWhen]) {
      expect((r.data.hits as Array<{ id: string }>).map((h) => h.id)).not.toContain("playbook:skill-instagram-post");
      expect(r.nodes.map((n: { id: string }) => n.id)).not.toContain("playbook:skill-instagram-post");
    }
  });
});
