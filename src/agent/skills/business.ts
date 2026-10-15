// One business's own skills and skill rules, kept in that business's own graph (so isolation between businesses is the
// graph's: a new business starts with the shipped packs only).
//   Memory{kind:'skill_rule', skillId, text, status:'active'}  -ABOUT-> Agent   a rule for one skill ("end every post with a
//                                                                                question"); skillId '*' = every skill of the agent
//   Memory{kind:'skill', skillId, name, when, body}            -ABOUT-> Agent   the business's own skill, or one that replaces
//                                                                                the shipped skill with the same id
// Both are STATED by the owner and SOURCED_FROM the directive that made them (src/settings/directives.ts), and retired by
// setting status 'retired' (nothing is deleted). Rules learned from the owner's edits are Rule nodes; those carry the ids of
// the skills they belong to (Rule.skills), and use_skill shows them with the skill.
import { AGENTS, agentById } from "../../../shared/roster.js";
import type { GraphHandle } from "../../graph/client.js";
import { upsertNode, type EdgeInput, type NodeInput, type Prim } from "../../graph/upsert.js";
import { agentNodeId } from "../memory.js";
import type { BusinessSkills, SkillRule } from "./catalog.js";
import type { Skill } from "./format.js";
import { targetsIn } from "./targets.js";

type Read = Pick<GraphHandle, "roQuery">;

export const ALL_SKILLS = "*";
const rosterIdOf = (nodeId: string): string => nodeId.replace(/^agent:allevia-/, "");
const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

interface Row {
  agent: string; id: string; kind: string; skillId: string | null; name: string | null; when: string | null;
  body: string | null; text: string | null; at: number | null; channel: string | null; channelName: string | null;
}

// Every active skill and skill rule of this business, grouped by the memory that made them (one memory can be about
// several agents). Plain reads, like the owner's instructions (settings/team.ts): no OPTIONAL MATCH over aggregates.
export async function loadBusinessSkills(g: Read): Promise<BusinessSkills> {
  const rows = await g.roQuery<Row>(
    `MATCH (a:Entity:Agent) WHERE a.id IN $ids WITH a
     MATCH (m:Memory)-[r:ABOUT]->(a)
     WHERE r.until IS NULL AND m.kind IN ['skill', 'skill_rule'] AND coalesce(m.status, 'active') = 'active'
     RETURN a.id AS agent, m.id AS id, m.kind AS kind, m.skillId AS skillId, m.skillName AS name, m.skillWhen AS when, m.body AS body,
            m.text AS text, m.at AS at, m.channel AS channel, m.channelName AS channelName
     ORDER BY m.at, m.id, a.id`, { ids: AGENTS.map((a) => agentNodeId(a.id)) });
  const byId = new Map<string, { row: Row; agents: string[] }>();
  for (const r of rows) {
    const agent = rosterIdOf(r.agent);
    if (!agentById(agent) || !r.skillId) continue;
    const have = byId.get(r.id);
    if (have) { if (!have.agents.includes(agent)) have.agents.push(agent); } else byId.set(r.id, { row: r, agents: [agent] });
  }
  const skills: Skill[] = [];
  const rules: SkillRule[] = [];
  for (const { row, agents } of byId.values()) {
    if (row.kind === "skill_rule" && row.text) {
      rules.push({
        id: row.id, skillId: row.skillId!, agents, text: row.text,
        ...(row.channel ? { channel: { id: row.channel, name: row.channelName || row.channel.replace(/^channel:/, "") } } : {}),
      });
    } else if (row.kind === "skill" && row.body) {
      const body = row.body;
      skills.push({
        id: row.skillId!, name: row.name || row.skillId!, when: row.when || "", agents, tools: [], output: "reads", needsOk: false,
        sections: { method: body, style: body, done: body, mistakes: body }, body, source: "business",
      });
    }
  }
  return { skills, rules };
}

// The writes for a rule or a skill (applyDirective runs them through writeBatch).
export function skillRuleWrite(
  p: { agents: string[]; skill: string; text: string; channel?: { id: string; name: string } | undefined; channelExists?: boolean },
  id: string, src: string, actor: string | undefined, now: number, asOf: string,
): { nodes: NodeInput[]; edges: EdgeInput[] } {
  const props: Record<string, Prim> = {
    kind: "skill_rule", skillId: p.skill, text: p.text, status: "active", at: now,
    ...(p.channel ? { channel: p.channel.id, channelName: p.channel.name } : {}),
  };
  return {
    nodes: [{ type: "Memory", id, name: clip(p.text, 80), summary: p.text, src, asOf, props }],
    edges: [
      ...p.agents.map((a): EdgeInput => ({ from: id, type: "ABOUT", to: agentNodeId(a), src })),
      ...(p.channel && p.channelExists ? [{ from: id, type: "ABOUT" as const, to: p.channel.id, src }] : []),
      ...(actor ? [{ from: actor, type: "STATED" as const, to: id, src }] : []),
      { from: id, type: "SOURCED_FROM", to: src, src },
    ],
  };
}

export function skillWrite(
  p: { agents: string[]; id: string; name: string; when: string; text: string },
  memoryId: string, src: string, actor: string | undefined, now: number, asOf: string,
): { nodes: NodeInput[]; edges: EdgeInput[] } {
  const props: Record<string, Prim> = { kind: "skill", skillId: p.id, skillName: p.name, skillWhen: p.when, body: p.text, status: "active", at: now, origin: "owner" };
  return {
    nodes: [{ type: "Memory", id: memoryId, name: clip(`Skill: ${p.name}`, 80), summary: clip(p.text, 400), src, asOf, props }],
    edges: [
      ...p.agents.map((a): EdgeInput => ({ from: memoryId, type: "ABOUT", to: agentNodeId(a), src })),
      ...(actor ? [{ from: actor, type: "STATED" as const, to: memoryId, src }] : []),
      { from: memoryId, type: "SOURCED_FROM", to: src, src },
    ],
  };
}

// Takes a rule or a skill out of use (Memory.status 'retired'); false when there is no such skill note.
export async function retireSkillNote(g: GraphHandle, id: string, now: number): Promise<boolean> {
  const [m] = await g.roQuery<{ name: string }>("MATCH (m:Entity:Memory {id:$id}) WHERE m.kind IN ['skill', 'skill_rule'] RETURN m.name AS name", { id });
  if (!m) return false;
  await upsertNode(g, { type: "Memory", id, name: m.name, props: { status: "retired", retiredAt: now } }, now);
  return true;
}

// ---------- learned rules attach to the right skill ----------

const STYLE_OPS = new Set(["replace", "remove_emoji", "no_exclaim", "avoid_words"]);

// The skills a rule learned from an edit belongs to: the skill the edited draft came from, and, for a style rule (a word,
// an emoji, hype words), Dev's voice check, which holds every draft to those.
export function skillsForLearnedRule(o: { agentId?: string | undefined; draft: string; op: string }): string[] {
  const out: string[] = [];
  if (o.agentId) {
    const hit = targetsIn(o.draft, [o.agentId])[0];
    if (hit) out.push(hit.skill);
    else if (o.agentId === "content-strategist") out.push("instagram-post");
  }
  if (STYLE_OPS.has(o.op) && !out.includes("brand-voice-check")) out.push("brand-voice-check");
  return out;
}

// The things this business's edits taught the team that belong to one skill, most confident first.
export async function learnedRulesForSkill(g: Read, skillId: string): Promise<string[]> {
  try {
    const rows = await g.roQuery<{ text: string | null; name: string | null }>(
      `MATCH (r:Rule) WHERE r.kind = 'learned' AND r.status = 'active' AND $skill IN coalesce(r.skills, [])
       RETURN r.text AS text, r.name AS name ORDER BY coalesce(r.confidence, 0) DESC, r.id LIMIT 8`, { skill: skillId });
    return rows.map((r) => (r.text ?? r.name ?? "").trim()).filter(Boolean);
  } catch {
    return []; // a skill still opens without them
  }
}
