// The skill format. A skill is how one member of the team does one kind of job here: a folder
// skills/<agent-id | shared>/<skill-id>/SKILL.md with frontmatter and a body.
//
//   ---
//   id: instagram-post                      the folder name; lowercase words joined by dashes
//   name: Instagram post craft              what the owner reads ("Miss Influencer is using: Instagram post craft")
//   when: A post for Instagram that sounds like the brand      one line, plain words, when to reach for it
//   agents: [content-strategist]            roster ids; optional in an agent's own folder, two or more in shared/
//   tools: [content_performance, playbook]  the tools the method uses; each must be one of those agents' tools
//   output: creates                         creates (makes something) | reads (only looks things up)
//   makes: a post draft with caption        plain words, what it creates (only with output: creates)
//   needs_ok: true                          true when what it makes waits for the owner's OK (propose_action)
//   ---
//   ## Method           numbered steps: what to look up, in what order, what to decide
//   ## House style      the shape of the output the owner reads, with an example
//   ## Done well        a checklist: what a strong result has
//   ## Common mistakes  what weak work looks like
//
// Progressive disclosure: an agent's prompt lists only each skill's id, name and `when`; the use_skill tool loads the whole
// text when the agent decides the request matches. Skills are data for the agent that loads them, never citations: nothing
// in a skill is evidence (the tool returns it as `guidance`, which the citation and number checks never see).
import { parse as parseYaml } from "yaml";
import { toolMeta } from "../../../shared/toolkits.js";
import { ownerJargon } from "../style.js";

export type SkillSource = "code" | "business";

export interface SkillSections { method: string; style: string; done: string; mistakes: string }

export interface Skill {
  id: string;
  name: string;
  when: string;
  agents: string[];          // roster ids that can use it
  tools: string[];           // tool names the method uses
  output: "creates" | "reads";
  makes?: string;            // plain words: what it creates
  needsOk: boolean;          // what it makes waits for the owner's OK
  sections: SkillSections;
  body: string;              // the markdown after the frontmatter (what use_skill returns)
  source: SkillSource;
  base?: string;             // a business's own version of a shipped skill (aamdani-reel -> reel-script): rules on the base reach it
  path?: string;             // where a code skill lives, for lint messages
}

export const SKILL_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/;
export const SHARED = "shared";
export const MAX_NAME = 60;
export const MAX_WHEN = 140;
export const MAX_BODY = 9_000;
export const MIN_CODE_BODY = 1_200;
export const MAX_BUSINESS_BODY = 8_000;

// Heading words that open each required section ("## Method", "## House style and output", "## Done well checklist"…).
const SECTION_HEADS: Array<[keyof SkillSections, RegExp]> = [
  ["method", /^method\b/i], ["style", /^house style\b/i], ["done", /^done well\b/i], ["mistakes", /^common mistakes\b/i],
];

const SECTION_LABEL: Record<keyof SkillSections, string> = { method: "Method", style: "House style", done: "Done well", mistakes: "Common mistakes" };

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;

const str = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
const strList = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every((x) => typeof x === "string") ? v.map((x) => x.trim()).filter(Boolean) : undefined);

// The body split at its "## " headings (fenced code is not scanned for headings).
export function splitSections(body: string): { sections: Partial<SkillSections>; unknown: string[] } {
  const found: Partial<SkillSections> = {};
  const unknown: string[] = [];
  let key: keyof SkillSections | "other" | undefined;
  let buf: string[] = [];
  let fenced = false;
  const flush = () => {
    if (key && key !== "other") found[key] = [found[key], buf.join("\n").trim()].filter(Boolean).join("\n");
    buf = [];
  };
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const h = !fenced ? /^##\s+(.+?)\s*$/.exec(line) : null;
    if (h) {
      flush();
      const title = h[1]!;
      const hit = SECTION_HEADS.find(([, re]) => re.test(title));
      if (hit) key = hit[0]; else { key = "other"; unknown.push(title); }
      continue;
    }
    if (key) buf.push(line);
  }
  flush();
  return { sections: found, unknown };
}

export interface ParseContext { folder: string; source: SkillSource; path?: string }
export interface Parsed { skill?: Skill; problems: string[] }

// SKILL.md text -> a Skill, or the structural problems that stop it from being one. `folder` is the agent id the file sits
// under (or "shared"); it supplies `agents` when the frontmatter leaves it out in an agent's own folder.
export function parseSkill(text: string, ctx: ParseContext): Parsed {
  const problems: string[] = [];
  const m = FRONTMATTER.exec(text.replace(/^﻿/, ""));
  if (!m) return { problems: ["no frontmatter: the file must open with --- … ---"] };
  let fm: Record<string, unknown>;
  try {
    const v = parseYaml(m[1]!) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not a mapping");
    fm = v as Record<string, unknown>;
  } catch (e) {
    return { problems: [`frontmatter is not valid YAML: ${e instanceof Error ? e.message : String(e)}`] };
  }
  const body = m[2]!.trim();

  const id = str(fm.id);
  if (!SKILL_ID.test(id)) problems.push(`id "${id}" must be lowercase words joined by dashes, like instagram-post`);
  const name = str(fm.name);
  if (!name) problems.push("name is missing");
  else if (name.length > MAX_NAME) problems.push(`name is ${name.length} characters (at most ${MAX_NAME})`);
  const when = str(fm.when);
  if (!when) problems.push("when is missing: one plain line saying when to use it");
  else if (when.length > MAX_WHEN) problems.push(`when is ${when.length} characters (at most ${MAX_WHEN})`);
  if (typeof fm.when === "string" && fm.when.trim().includes("\n")) problems.push("when must be a single line");

  let agents = fm.agents === undefined ? undefined : strList(fm.agents);
  if (fm.agents !== undefined && !agents) problems.push("agents must be a list of roster ids");
  if (!agents && ctx.folder !== SHARED) agents = [ctx.folder];
  if (!agents?.length) problems.push(ctx.folder === SHARED ? "a shared skill must list its agents" : "agents is empty");

  const tools = fm.tools === undefined ? [] : strList(fm.tools);
  if (!tools) problems.push("tools must be a list of tool names");

  const output = fm.output === "creates" || fm.output === "reads" ? fm.output : undefined;
  if (!output) problems.push('output must be "creates" or "reads"');
  const makes = str(fm.makes);
  if (typeof fm.needs_ok !== "boolean") problems.push("needs_ok must be true or false");

  const { sections, unknown } = splitSections(body);
  for (const [key, label] of Object.entries(SECTION_LABEL)) if (!sections[key as keyof SkillSections]?.trim()) problems.push(`the "## ${label}" section is missing or empty`);
  for (const u of unknown) problems.push(`unknown section "## ${u}" (use Method, House style, Done well, Common mistakes)`);

  if (problems.length) return { problems };
  return {
    problems,
    skill: {
      id, name, when, agents: agents!, tools: tools!, output: output!, ...(makes ? { makes } : {}), needsOk: fm.needs_ok as boolean,
      sections: sections as SkillSections, body, source: ctx.source, ...(ctx.path ? { path: ctx.path } : {}),
    },
  };
}

// ---------- lint ----------

export interface LintEnv {
  toolNames: ReadonlySet<string>;                         // every tool the registry has
  agentTools: (agentId: string) => readonly string[] | undefined; // a roster agent's tools; undefined = no such agent
}

const FILLER = /\b(?:todo|tbd|lorem ipsum|fill (?:this )?in|to be written|coming soon)\b/i;
const numbered = (s: string): number => (s.match(/^\s*\d+[.)]\s+\S/gm) ?? []).length;
const bullets = (s: string): number => (s.match(/^\s*[-*]\s+(?:\[[ xX]\]\s+)?\S/gm) ?? []).length;
const checks = (s: string): number => (s.match(/^\s*[-*]\s+\[[ xX]\]\s+\S/gm) ?? []).length;

// The tool names a body mentions in backticks.
export function toolMentions(body: string, toolNames: ReadonlySet<string>): string[] {
  return [...new Set([...body.matchAll(/`([a-z][a-z_]*)`/g)].map((x) => x[1]!).filter((n) => toolNames.has(n)))];
}

// Everything wrong with a code skill that parsing does not catch. Empty means it is fit to ship.
export function lintSkill(s: Skill, env: LintEnv, folder: string): string[] {
  const out: string[] = [];
  const fail = (m: string) => out.push(m);

  if (folder !== SHARED && !s.agents.includes(folder)) fail(`it sits in skills/${folder}/ but does not list ${folder} in agents`);
  if (folder === SHARED && s.agents.length < 2) fail("a shared skill needs at least two agents (otherwise move it into that agent's folder)");
  if (new Set(s.agents).size !== s.agents.length) fail("agents lists someone twice");
  for (const a of s.agents) {
    const have = env.agentTools(a);
    if (!have) { fail(`agent "${a}" is not on the roster`); continue; }
    const missing = s.tools.filter((t) => !have.includes(t));
    if (missing.length) fail(`${a} does not have ${missing.join(", ")} (its tools: ${have.join(", ")})`);
  }
  const unknown = s.tools.filter((t) => !env.toolNames.has(t));
  if (unknown.length) fail(`unknown tool${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`);
  if (new Set(s.tools).size !== s.tools.length) fail("tools lists a tool twice");

  if (s.output === "creates" && !s.makes) fail('output "creates" needs makes: what it creates, in plain words');
  if (s.output === "reads" && s.makes) fail('output "reads" must not have makes');
  if (s.output === "creates" && !s.needsOk) fail("a skill that creates something must have needs_ok: true (nothing the team makes goes out without the owner's OK)");
  // what proposes for the owner's OK: propose_action itself, or a tool tagged as waiting for the OK (gmail_send, calendar_book ...)
  const proposes = s.tools.filter((t) => t === "propose_action" || toolMeta(t)?.needsOk === true);
  if (s.needsOk && !proposes.length) fail("needs_ok: true means the owner approves what it makes, so tools must include propose_action (or a tool that waits for the OK, like gmail_send)");
  if (!s.needsOk && proposes.length) fail(`it lists ${proposes.join(", ")} but says needs_ok: false`);

  const { method, style, done, mistakes } = s.sections;
  if (numbered(method) < 3) fail(`the Method needs at least 3 numbered steps (it has ${numbered(method)})`);
  if (style.replace(/\s+/g, " ").length < 150) fail("the House style section is too thin: say the shape of the output and show an example");
  if (checks(done) < 3) fail(`Done well needs at least 3 checklist lines like "- [ ] …" (it has ${checks(done)})`);
  if (bullets(mistakes) < 2) fail(`Common mistakes needs at least 2 bullets (it has ${bullets(mistakes)})`);

  if (s.body.length < MIN_CODE_BODY) fail(`the body is ${s.body.length} characters: too thin to carry real know-how (at least ${MIN_CODE_BODY})`);
  if (s.body.length > MAX_BODY) fail(`the body is ${s.body.length} characters: too long to load into a working context (at most ${MAX_BODY})`);
  if (s.body.includes("[[")) fail("the body contains [[ ]]: a skill is not evidence and must never look like a citation");
  if (FILLER.test(s.body)) fail("the body has a placeholder (TODO, TBD, lorem ipsum, fill in)");

  const mentioned = toolMentions(s.body, env.toolNames).filter((t) => t !== "use_skill");
  const undeclared = mentioned.filter((t) => !s.tools.includes(t));
  if (undeclared.length) fail(`the body names ${undeclared.join(", ")} but tools does not list ${undeclared.length > 1 ? "them" : "it"}`);
  const unused = s.tools.filter((t) => !mentioned.includes(t));
  if (unused.length) fail(`tools lists ${unused.join(", ")} but the body never uses ${unused.length > 1 ? "them" : "it"} (name a tool in backticks where the method calls it)`);

  // Plain words: what the owner reads (the name, when, what it makes, and the house style the output follows).
  for (const [where, text] of [["name", s.name], ["when", s.when], ["makes", s.makes ?? ""], ["House style", style]] as const) {
    const bad = ownerJargon(text);
    if (bad.length) fail(`${where} uses words the owner never reads (${bad.join(", ")}); see docs/owner-words.md`);
  }
  return out;
}

// Looser checks for a skill the owner or the team wrote for their own business (a few plain lines are enough).
export function lintBusinessSkill(s: { id: string; name: string; when: string; body: string; agents: string[] }, agentTools: LintEnv["agentTools"]): string[] {
  const out: string[] = [];
  if (!SKILL_ID.test(s.id)) out.push(`id "${s.id}" must be lowercase words joined by dashes`);
  if (!s.name.trim()) out.push("name is missing");
  if (s.name.length > MAX_NAME) out.push(`name is longer than ${MAX_NAME} characters`);
  if (!s.when.trim()) out.push("when is missing");
  if (s.when.length > MAX_WHEN) out.push(`when is longer than ${MAX_WHEN} characters`);
  if (!s.body.trim()) out.push("the skill text is empty");
  if (s.body.length > MAX_BUSINESS_BODY) out.push(`the skill text is ${s.body.length} characters (at most ${MAX_BUSINESS_BODY})`);
  if (s.body.includes("[[")) out.push("the skill text contains [[ ]]");
  if (!s.agents.length) out.push("no one is named to use it");
  for (const a of s.agents) if (!agentTools(a)) out.push(`"${a}" is not on the team`);
  for (const [where, text] of [["name", s.name], ["when", s.when]] as const) {
    const bad = ownerJargon(text);
    if (bad.length) out.push(`${where} uses words the owner never reads (${bad.join(", ")})`);
  }
  return out;
}
