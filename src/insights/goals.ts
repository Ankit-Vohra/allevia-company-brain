// Which goals a finding (or a proposal made in chat) moves. Shared by the detectors' cards (recommend.ts) and propose_action
// (agent/tools/actions.ts): Recommendation -ADVANCES-> Goal.
import type { GraphHandle } from "../graph/client.js";
import type { Area, Candidate } from "./detectors.js";

export interface GoalRef { id: string; name: string; metricKey: string | null }

// Which goals a finding moves: a goal tracking one of its metrics, else one whose metric belongs to the finding's area.
const AREA_METRICS: Record<Area, RegExp | null> = {
  seo: /gsc|search|organic|impression|click|ctr|seo|index|traffic|session/i,
  content: /view|reel|follower|reach|post|content|engagement|subscriber|play|story|short/i,
  funnel: /signup|setup|activat|conversion|funnel|otp|onboard|account|enquir|lead/i,
  ads: /cpa|^ads?_|_ads?$|ad_spend|spend|lead|conversion|roas|enquir/i,
  knowledge: null,
  tech: null,
};

export const isArea = (s: unknown): s is Area => typeof s === "string" && Object.hasOwn(AREA_METRICS, s);

export function relatedGoals(c: Pick<Candidate, "area" | "metrics">, goals: GoalRef[]): GoalRef[] {
  const exact = goals.filter((g) => g.metricKey && (c.metrics ?? []).includes(g.metricKey));
  if (exact.length) return exact;
  const re = AREA_METRICS[c.area];
  return re ? goals.filter((g) => g.metricKey && re.test(g.metricKey)) : [];
}

export async function loadGoals(g: Pick<GraphHandle, "roQuery">): Promise<GoalRef[]> {
  return g.roQuery<GoalRef>(
    `MATCH (gl:Goal) WHERE NOT coalesce(gl.status, '') IN ['retired', 'superseded', 'achieved']
     OPTIONAL MATCH (gl)-[t:TRACKS]->(m:Metric) WHERE t.until IS NULL
     RETURN gl.id AS id, gl.name AS name, coalesce(gl.metricKey, m.key) AS metricKey ORDER BY coalesce(gl.priority, 99), id`);
}
