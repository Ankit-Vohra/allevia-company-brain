// use_skill: load one of the agent's skills (src/agent/skills). The prompt lists only each skill's name and when to use it;
// this returns the whole text (method, house style, checklist, mistakes) plus the business's own rules for that skill.
// The text goes back as `guidance`, never as data or nodes: a skill is a way of working, not evidence, so no citation or
// number check counts anything in it.
import { z } from "zod";
import { agentById } from "../../../shared/roster.js";
import { upsertEdge, upsertNode } from "../../graph/upsert.js";
import { isoDate } from "../../util/time.js";
import type { ToolContext } from "../tool.js";
import { agentNodeId, skillNodeId } from "../memory.js";
import type { SkillCatalog } from "../skills/catalog.js";
import type { Skill } from "../skills/format.js";
import { learnedRuleRefsForSkill } from "../skills/business.js";
import { skillGuidance } from "../skills/render.js";
import { InputError, defineTool, getNode } from "./common.js";

// The skill as a node in this business's graph (Playbook{kind:'skill'}, id playbook:skill-<id>), and the agent that opened it
// USES it. Best effort and never in read-only mode: opening a skill must not fail on the graph. saveTurn adds the Turn's TOUCHED
// and the Finding's GUIDED_BY. Search leaves these out (search.ts): a skill is a way of working, not evidence.
async function recordSkill(skill: Skill, ctx: ToolContext): Promise<void> {
  if (ctx.readOnly || ctx.signal?.aborted) return;
  try {
    const id = skillNodeId(skill.id);
    await upsertNode(ctx.graph, {
      type: "Playbook", id, name: skill.name, summary: skill.when,
      props: { kind: "skill", skillId: skill.id, source: skill.source, agents: skill.agents, ...(skill.base ? { base: skill.base } : {}) },
    }, ctx.now);
    const agent = agentNodeId(ctx.agentId);
    if (await getNode(ctx, agent)) await upsertEdge(ctx.graph, { from: agent, type: "USES", to: id, src: ctx.turnId, asOf: isoDate(ctx.now), since: ctx.now }, ctx.now);
  } catch {
    // the skill still opens
  }
}

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
  const refs = [...await learnedRuleRefsForSkill(ctx.graph, skill.id), ...(skill.base ? await learnedRuleRefsForSkill(ctx.graph, skill.base) : [])];
  const learned = [...new Map(refs.map((r) => [r.id, r] as const)).values()];
  const guidance = await skillGuidance(skill, ctx, catalog, learned.map((r) => r.text).filter((t, i, a) => a.indexOf(t) === i));
  await recordSkill(skill, ctx);
  // The rules it showed: the business's own rules for this skill (a rule on one channel says which) and the lessons learned from
  // the owner's edits. The turn is GUIDED_BY the ones that applied (orchestrator.ts), so the answer's path can show them.
  const rules = catalog.rulesFor(ctx.agentId, skill.id).map((r) => ({ id: r.id, ...(r.channel ? { channel: r.channel } : {}) }));
  return {
    data: { skill: skill.id, name: skill.name, source: skill.source, ...(rules.length ? { rules } : {}), ...(learned.length ? { learned: learned.map((r) => r.id) } : {}) },
    nodes: [], edges: [], sources: [], note: `Opened ${skill.name}`, guidance,
  };
}

export const useSkill = defineTool({
  name: "use_skill",
  description:
    "Open one of your skills: the method, house style, checklist and common mistakes for a kind of job here, plus this business's own rules for it. Use the id from your skills list when the request matches; open it in your first round. It is a way of working, not evidence: never cite it. Example: {\"id\":\"instagram-post\"}",
  input: { id: z.string().describe("A skill id from your skills list") },
  run: runUseSkill,
});
