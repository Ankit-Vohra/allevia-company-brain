// The skill format: what parses, what the lint refuses, and how a business's own skills lay over the shipped ones.
import { describe, it, expect } from "vitest";
import { SkillCatalog } from "../../src/agent/skills/catalog.js";
import { lintBusinessSkill, lintSkill, parseSkill, splitSections, toolMentions, type LintEnv, type Skill } from "../../src/agent/skills/format.js";
import { ALL_TOOLS } from "../../src/agent/tools/index.js";
import { AGENTS } from "../../shared/roster.js";

const env: LintEnv = {
  toolNames: new Set(ALL_TOOLS.map((t) => t.name)),
  agentTools: (id) => AGENTS.find((a) => a.id === id)?.tools,
};

const filler = (n: number) => Array.from({ length: n }, (_, i) => `Step detail ${i} keeps the body long enough to carry real know-how for the check.`).join(" ");

function doc(over: Record<string, string | null> = {}, body?: string): string {
  const fm: Record<string, string | null> = {
    id: "instagram-post", name: "Instagram post craft", when: "A post for Instagram that sounds like the brand",
    agents: "[content-strategist]", tools: "[playbook, propose_action]", output: "creates", makes: "a post draft", needs_ok: "true", ...over,
  };
  const head = Object.entries(fm).filter(([, v]) => v !== null).map(([k, v]) => `${k}: ${v}`).join("\n");
  return `---\n${head}\n---\n${body ?? `## Method
1. Look up the hook rules with \`playbook\`.
2. Pick one hook and write the caption. ${filler(8)}
3. Hand the draft over with \`propose_action\`.

## House style
Write the caption the way a person would say it out loud, in two or three short sentences, then one question. Example: "We finished the kitchen in six weeks. Want to see how?" ${filler(2)}

## Done well
- [ ] The first line stops the scroll.
- [ ] Every fact is one the record holds.
- [ ] It ends the way the brand ends.

## Common mistakes
- A caption that is only a label.
- Hashtags in the middle of a sentence.
`}`;
}

const parsed = (text: string, folder = "content-strategist") => parseSkill(text, { folder, source: "code" });

describe("parseSkill", () => {
  it("reads the frontmatter and the four sections", () => {
    const { skill, problems } = parsed(doc());
    expect(problems).toEqual([]);
    expect(skill).toMatchObject({
      id: "instagram-post", name: "Instagram post craft", agents: ["content-strategist"], tools: ["playbook", "propose_action"],
      output: "creates", makes: "a post draft", needsOk: true, source: "code",
    });
    expect(skill!.sections.method).toMatch(/^1\. Look up the hook rules/);
    expect(skill!.sections.mistakes).toMatch(/only a label/);
  });

  it("an agent's own folder supplies agents; shared must say who", () => {
    expect(parsed(doc({ agents: null })).skill!.agents).toEqual(["content-strategist"]);
    expect(parsed(doc({ agents: null }), "shared").problems.join()).toMatch(/shared skill must list its agents/);
    expect(parsed(doc({ agents: "[copy-editor, fact-checker]" }), "shared").skill!.agents).toEqual(["copy-editor", "fact-checker"]);
  });

  it("names every structural problem it finds", () => {
    expect(parsed("no frontmatter here").problems.join()).toMatch(/no frontmatter/);
    expect(parsed("---\nid: [unclosed\n---\nbody").problems.join()).toMatch(/not valid YAML/);
    const p = parsed(doc({ id: "Bad Id", when: null, output: "writes", needs_ok: "maybe" }, "## Method\n1. only\n\n## Extras\nnope")).problems.join("\n");
    expect(p).toMatch(/id "Bad Id"/);
    expect(p).toMatch(/when is missing/);
    expect(p).toMatch(/output must be/);
    expect(p).toMatch(/needs_ok must be true or false/);
    expect(p).toMatch(/"## House style" section is missing/);
    expect(p).toMatch(/unknown section "## Extras"/);
  });

  it("a one-line when, at most 140 characters", () => {
    expect(parsed(doc({ when: `"${"x".repeat(150)}"` })).problems.join()).toMatch(/when is 150 characters/);
  });

  it("headings inside a fenced block are not sections", () => {
    const s = splitSections("## Method\n1. a\n```\n## House style\n```\n## House style\nreal");
    expect(s.sections.style).toBe("real");
    expect(s.unknown).toEqual([]);
  });
});

describe("lintSkill", () => {
  const lint = (text: string, folder = "content-strategist") => {
    const { skill, problems } = parsed(text, folder);
    expect(problems).toEqual([]);
    return lintSkill(skill!, env, folder);
  };

  it("a well-formed skill is clean", () => {
    expect(lint(doc())).toEqual([]);
  });

  it("every tool it lists exists and belongs to the agent", () => {
    expect(lint(doc({ tools: "[playbook, propose_action, nothing_here]" })).join()).toMatch(/unknown tool: nothing_here/);
    expect(lint(doc({ tools: "[playbook, propose_action, seo_report]" }, doc().split("---\n")[2])).join()).toMatch(/content-strategist does not have seo_report/);
  });

  it("creating something needs the owner's OK and propose_action", () => {
    expect(lint(doc({ needs_ok: "false" })).join()).toMatch(/must have needs_ok: true/);
    expect(lint(doc({ tools: "[playbook]", needs_ok: "true" }, doc().split("---\n")[2]!.replace("`propose_action`", "the proposal"))).join()).toMatch(/must include propose_action/);
    expect(lint(doc({ makes: null })).join()).toMatch(/needs makes/);
    expect(lint(doc({ output: "reads", needs_ok: "false", tools: "[playbook]" }, doc().split("---\n")[2]!.replace("`propose_action`", "the proposal"))).join()).toMatch(/must not have makes/);
  });

  it("the body must use the tools it lists and list the tools it uses", () => {
    const body = doc().split("---\n")[2]!;
    expect(lint(doc({}, body.replace("`playbook`", "the hook rules"))).join()).toMatch(/never uses it/);
    expect(lint(doc({}, `${body}\nAlso run \`seo_report\`.`)).join()).toMatch(/body names seo_report/);
  });

  it("refuses thin sections, a thin body, placeholders and anything that looks like a citation", () => {
    const body = doc().split("---\n")[2]!;
    expect(lint(doc({}, body.replace(/## Done well[\s\S]*?## Common/, "## Done well\n- [ ] one\n\n## Common")).replace("- [ ] one", "- [ ] one")).join()).toMatch(/Done well needs at least 3/);
    expect(lint(doc({}, body.replace(filler(8), "short"))).join()).toMatch(/too thin/);
    expect(lint(doc({}, `${body}\nTODO: finish`)).join()).toMatch(/placeholder/);
    expect(lint(doc({}, `${body}\nCite [[metric:x]]`)).join()).toMatch(/\[\[ \]\]/);
  });

  it("keeps the words the owner never reads out of what the owner reads", () => {
    expect(lint(doc({ name: "Agent finding craft" })).join()).toMatch(/name uses words the owner never reads/);
    expect(lint(doc({ makes: "a graph node" })).join()).toMatch(/makes uses words/);
    const body = doc().split("---\n")[2]!;
    expect(lint(doc({}, body.replace("in two or three short sentences", "like a finding"))).join()).toMatch(/House style uses words the owner never reads \(finding\)/);
  });

  it("a skill in the wrong folder, or a shared one with a single agent, is flagged", () => {
    expect(lint(doc({ agents: "[copy-editor]", tools: "[playbook]", output: "reads", makes: null, needs_ok: "false" }, doc().split("---\n")[2]!.replace("`propose_action`", "the proposal"))).join()).toMatch(/does not list content-strategist/);
    expect(lint(doc({ agents: "[content-strategist]" }), "shared").join()).toMatch(/at least two agents/);
  });
});

describe("toolMentions", () => {
  it("finds registry tools named in backticks and nothing else", () => {
    expect(toolMentions("Run `playbook` then `show_path`; not `foo_bar` or playbook.", env.toolNames).sort()).toEqual(["playbook", "show_path"]);
  });
});

describe("lintBusinessSkill", () => {
  const ok = { id: "festival-post", name: "Our festival posts", when: "Any post for a festival", body: "Always open with the greeting in Hindi, then the offer.", agents: ["content-strategist"] };
  it("a few plain lines are enough", () => {
    expect(lintBusinessSkill(ok, env.agentTools)).toEqual([]);
  });
  it("refuses an empty text, a made-up agent, a citation lookalike and technical words in the name", () => {
    expect(lintBusinessSkill({ ...ok, body: " " }, env.agentTools).join()).toMatch(/empty/);
    expect(lintBusinessSkill({ ...ok, agents: ["nobody"] }, env.agentTools).join()).toMatch(/not on the team/);
    expect(lintBusinessSkill({ ...ok, body: "see [[x]]" }, env.agentTools).join()).toMatch(/\[\[ \]\]/);
    expect(lintBusinessSkill({ ...ok, name: "The graph rule" }, env.agentTools).join()).toMatch(/words the owner never reads/);
    expect(lintBusinessSkill({ ...ok, id: "Not An Id" }, env.agentTools).join()).toMatch(/lowercase words/);
  });
});

describe("SkillCatalog", () => {
  const mk = (id: string, agents: string[], over: Partial<Skill> = {}): Skill => ({
    id, name: `Name of ${id}`, when: "when", agents, tools: [], output: "reads", needsOk: false,
    sections: { method: "m", style: "s", done: "d", mistakes: "x" }, body: `body of ${id}`, source: "code", ...over,
  });
  const code = new SkillCatalog([mk("a-one", ["content-strategist"]), mk("b-two", ["content-strategist", "copy-editor"]), mk("c-three", ["fact-checker"])]);

  it("lists an agent's skills, shared ones for each agent that has them", () => {
    expect(code.forAgent("content-strategist").map((s) => s.id)).toEqual(["a-one", "b-two"]);
    expect(code.forAgent("copy-editor").map((s) => s.id)).toEqual(["b-two"]);
    expect(code.forAgent("librarian")).toEqual([]);
    expect(code.get("fact-checker", "c-three")?.body).toBe("body of c-three");
    expect(code.get("fact-checker", "a-one")).toBeUndefined();
  });

  it("a business skill with a code id replaces it for the agents it names, and keeps the code name when it gives none", () => {
    const mine = code.withBusiness({ skills: [mk("a-one", ["content-strategist"], { source: "business", name: "", body: "our way" })], rules: [] });
    expect(mine.get("content-strategist", "a-one")).toMatchObject({ body: "our way", source: "business", name: "Name of a-one" });
    expect(code.get("content-strategist", "a-one")?.body).toBe("body of a-one"); // the code catalog is untouched
  });

  it("an override for one agent leaves the shared skill as it was for the other", () => {
    const mine = code.withBusiness({ skills: [mk("b-two", ["copy-editor"], { source: "business", body: "editor's own" })], rules: [] });
    expect(mine.get("copy-editor", "b-two")?.body).toBe("editor's own");
    expect(mine.get("content-strategist", "b-two")?.body).toBe("body of b-two");
  });

  it("adds a new business skill and scopes rules to a skill and the agents they name", () => {
    const mine = code.withBusiness({
      skills: [mk("our-poster", ["content-strategist"], { source: "business" })],
      rules: [{ id: "memory:r1", skillId: "a-one", agents: ["content-strategist"], text: "End with a question." }],
    });
    expect(mine.forAgent("content-strategist").map((s) => s.id)).toEqual(["a-one", "b-two", "our-poster"]);
    expect(mine.rulesFor("content-strategist", "a-one").map((r) => r.text)).toEqual(["End with a question."]);
    expect(mine.rulesFor("content-strategist", "b-two")).toEqual([]);
    expect(mine.rulesFor("copy-editor", "a-one")).toEqual([]);
    expect(code.rules).toEqual([]);
  });
});
