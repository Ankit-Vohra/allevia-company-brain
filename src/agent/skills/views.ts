// What the Team page shows for each person: their skills in plain words (name, one line, what they can make), the
// business's own rules on each, and what the team learned from the owner's edits.
import type { SkillView } from "../../../shared/contracts.js";
import type { GraphHandle } from "../../graph/client.js";
import { codeCatalog, type SkillCatalog } from "./catalog.js";
import { loadBusinessSkills } from "./business.js";

type Read = Pick<GraphHandle, "roQuery">;

// Active learned rules by the skill they belong to (Rule.skills), most confident first.
export async function learnedBySkill(g: Read): Promise<Map<string, string[]>> {
  const rows = await g.roQuery<{ text: string | null; name: string | null; skills: string[] | null }>(
    `MATCH (r:Rule) WHERE r.kind = 'learned' AND r.status = 'active' AND r.skills IS NOT NULL
     RETURN r.text AS text, r.name AS name, r.skills AS skills ORDER BY coalesce(r.confidence, 0) DESC, r.id LIMIT 200`);
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const text = (r.text ?? r.name ?? "").trim();
    if (text) for (const s of r.skills ?? []) out.set(s, [...(out.get(s) ?? []), text]);
  }
  return out;
}

export function skillViewsFor(catalog: SkillCatalog, agentId: string, learned: ReadonlyMap<string, string[]>): SkillView[] {
  return catalog.forAgent(agentId).map((s) => ({
    id: s.id, name: s.name, when: s.when, ...(s.makes ? { makes: s.makes } : {}), needsOk: s.needsOk, source: s.source,
    rules: catalog.rulesFor(agentId, s.id).map((r) => ({ id: r.id, text: r.text, ...(r.channel ? { channel: r.channel.name } : {}) })),
    learned: learned.get(s.id) ?? [],
  }));
}

/** This business's catalog (the shipped skills with its own laid over them) and what its edits taught the team. */
export async function businessCatalog(g: Read): Promise<{ catalog: SkillCatalog; learned: Map<string, string[]> }> {
  const [mine, learned] = await Promise.all([loadBusinessSkills(g), learnedBySkill(g).catch(() => new Map<string, string[]>())]);
  return { catalog: codeCatalog().withBusiness(mine), learned };
}
