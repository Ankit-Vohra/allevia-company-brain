// The learning feed (product design §8 GET /api/:t/learning, DELETE /api/:t/learning/:ruleId): every rule the team
// learned from the owner's edits, newest first, with the approvals it came from and the desks it applies to; and
// retiring one. Retiring sets status 'retired' (Rule.status is TRACKED, so the active state is kept as a Version);
// activeRules() no longer returns it, so the next draft stops applying it. Nothing is deleted.
import type { AgentId, LearnedRuleDto } from "../../shared/contracts.js";
import type { GraphHandle } from "../graph/client.js";
import { upsertNode } from "../graph/upsert.js";

type Read = Pick<GraphHandle, "roQuery">;

const iso = (v: unknown): string | null => (typeof v === "number" && Number.isFinite(v) ? new Date(v).toISOString() : null);

interface RuleRow { id: string; text: string | null; op: string | null; status: string | null; confidence: number | null; applied: number | null; at: number | null; retiredAt: number | null }

async function toDtos(g: Read, rows: RuleRow[]): Promise<LearnedRuleDto[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [from, agents] = await Promise.all([
    g.roQuery<{ id: string; a: string }>("UNWIND $ids AS id MATCH (r:Rule {id:id})-[:LEARNED_FROM]->(a:Approval) RETURN r.id AS id, a.id AS a ORDER BY a, id", { ids }),
    g.roQuery<{ id: string; agent: string | null }>(
      "UNWIND $ids AS id MATCH (r:Rule {id:id})-[e:APPLIES_TO]->(ag:Agent) WHERE e.until IS NULL RETURN r.id AS id, ag.rosterId AS agent ORDER BY agent, id", { ids }),
  ]);
  return rows.map((r) => ({
    id: r.id, text: r.text ?? r.id, op: r.op ?? "instruction", status: r.status === "retired" ? "retired" : "active",
    confidence: r.confidence ?? 0.5, appliedCount: r.applied ?? 0, learnedAt: iso(r.at), retiredAt: iso(r.retiredAt),
    fromApprovalIds: [...new Set(from.filter((x) => x.id === r.id).map((x) => x.a))],
    agents: [...new Set(agents.filter((x) => x.id === r.id && x.agent).map((x) => x.agent as AgentId))],
  }));
}

const RULE_FIELDS = `r.id AS id, coalesce(r.text, r.name) AS text, r.op AS op, r.status AS status, r.confidence AS confidence,
  r.appliedCount AS applied, coalesce(r.learnedAt, r.createdAt) AS at, r.retiredAt AS retiredAt`;

// Learned rules learned (or re-learned) at or after `since` (epoch ms), newest first.
export async function learnedRules(g: Read, since = 0, limit = 200): Promise<LearnedRuleDto[]> {
  const rows = await g.roQuery<RuleRow>(
    `MATCH (r:Rule) WHERE r.kind = 'learned' AND coalesce(r.learnedAt, r.createdAt, 0) >= $since
     RETURN ${RULE_FIELDS} ORDER BY at DESC, r.id LIMIT $limit`, { since, limit: Math.max(1, Math.min(500, limit)) });
  return toDtos(g, rows);
}

export async function learnedRule(g: Read, id: string): Promise<LearnedRuleDto | null> {
  const rows = await g.roQuery<RuleRow>(`MATCH (r:Rule {id:$id}) WHERE r.kind = 'learned' RETURN ${RULE_FIELDS}`, { id });
  return (await toDtos(g, rows))[0] ?? null;
}

// null when there is no such learned rule; retiring a retired rule changes nothing.
export async function retireLearnedRule(g: GraphHandle, id: string, o: { now?: number; actor?: string } = {}): Promise<LearnedRuleDto | null> {
  const [r] = await g.roQuery<{ name: string; status: string | null }>("MATCH (r:Rule {id:$id}) WHERE r.kind = 'learned' RETURN r.name AS name, r.status AS status", { id });
  if (!r) return null;
  if (r.status !== "retired") {
    const now = o.now ?? Date.now();
    await upsertNode(g, { type: "Rule", id, name: r.name, props: { status: "retired", retiredAt: now, retiredBy: o.actor ?? "person:owner" } }, now);
  }
  return learnedRule(g, id);
}
