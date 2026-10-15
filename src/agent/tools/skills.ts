// use_skill: load one of the agent's skills (src/agent/skills). The prompt lists only each skill's name and when to use it;
// this returns the whole text (method, house style, checklist, mistakes) plus the business's own rules for that skill.
// The text goes back as `guidance`, never as data or nodes: a skill is a way of working, not evidence, so no citation or
// number check counts anything in it.
import { z } from "zod";
import { agentById } from "../../../shared/roster.js";
import type { ToolContext } from "../tool.js";
import type { SkillCatalog } from "../skills/catalog.js";
import type { Skill } from "../skills/format.js";
import { learnedRulesForSkill } from "../skills/business.js";
import { skillGuidance } from "../skills/render.js";
import { InputError, defineTool } from "./common.js";

async function runUseSkill(args: { id: string }, ctx: ToolContext) {
  const catalog: SkillCatalog | undefined = ctx.skills;
  const me = agentById(ctx.agentId)?.name ?? ctx.agentId;
  if (!catalog) throw new InputError("No skills are set up for this run. Work from your tools and the house rules.");
  const id = args.id.trim();
  const skill: Skill | undefined = catalog.get(ctx.agentId, id);
  if (!skill) {
    const mine = catalog.forAgent(ctx.agentId).map((s) => s.id);
    throw new InputError(`${me} has no skill "${id}".${mine.length ? ` Yours: ${mine.join(", ")}.` : " You have no skills."}`);
  }
  const learned = [...new Set([...(await learnedRulesForSkill(ctx.graph, skill.id)), ...(skill.base ? await learnedRulesForSkill(ctx.graph, skill.base) : [])])];
  const guidance = await skillGuidance(skill, ctx, catalog, learned);
  return { data: { skill: skill.id, name: skill.name, source: skill.source }, nodes: [], edges: [], sources: [], note: `Opened ${skill.name}`, guidance };
}

export const useSkill = defineTool({
  name: "use_skill",
  description:
    "Open one of your skills: the method, house style, checklist and common mistakes for a kind of job here, plus this business's own rules for it. Use the id from your skills list when the request matches; open it in your first round. It is a way of working, not evidence: never cite it. Example: {\"id\":\"instagram-post\"}",
  input: { id: z.string().describe("A skill id from your skills list") },
  run: runUseSkill,
});
