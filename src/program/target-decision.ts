// Why a goal's number is what it is. When the owner changes a goal's target, or says OK to the team's suggestion, that is a decision about
// the business, and "why is the target 150?" must have an answer in the graph, not in the change log of a web page:
//   (Person owner)-[:DECIDED]->(Decision {kind:'goal_target', target, previousTarget})-[:AFFECTS]->(Goal)
//                              (Decision)-[:BASED_ON]->(the Observation the goal's starting number was locked from), when there is one
//                              (Decision)-[:SUPERSEDES]->(the decision about the same goal's target before it; that one becomes 'superseded')
// The Goal's own update carries the Decision as its source and the time as its date, so the old target stays a Version with where it came
// from. trace_decision answers {id: goal} with the latest decision that affects it: this one.
import type { GraphHandle } from "../graph/client.js";
import { upsertEdge, upsertNode } from "../graph/upsert.js";
import { fmt } from "../insights/text.js";
import { entityId } from "../util/ids.js";
import { toIso } from "../util/time.js";

type Read = Pick<GraphHandle, "roQuery">;

export interface TargetDecisionInput {
  goalId: string;
  goalName: string;
  unit: string | null;
  period: "week" | "month";
  metricKey: string;
  target: number;                         // the number now
  previous: number | null;                // the number before (the team's suggestion, or the owner's last choice)
  baseline: number | null;                // where the business started, when it was measured
  baselineObs: string | null;             // the Observation that number was locked from, when there is one
  basis: "baseline" | "template" | null;  // how the team's suggestion was made
  changed: boolean;                       // the owner's own number (true) or OK to the suggestion (false)
  owner: string;                          // the owner's Person node
  now: number;
}

const per = (p: "week" | "month"): string => (p === "week" ? "a week" : "a month");
const withUnit = (n: number, unit: string | null, p: "week" | "month"): string => `${fmt(n)}${unit ? ` ${unit}` : ""} ${per(p)}`;

/** Who the owner is in this graph: the founder or owner Person, else `person:owner` (made when it is not there). */
export async function ownerPerson(g: Read): Promise<string | null> {
  const [p] = await g.roQuery<{ id: string }>(
    "MATCH (p:Entity:Person) WHERE p.id = 'person:founder' OR p.role IN ['founder', 'owner'] RETURN p.id AS id ORDER BY CASE WHEN p.id = 'person:founder' THEN 0 ELSE 1 END, id LIMIT 1");
  return p?.id ?? null;
}

// The decision about this goal's target that is current now, if any. The kind and status are read here: put on the pattern they make the
// planner scan every Decision instead of starting at the goal.
async function currentTargetDecision(g: Read, goalId: string): Promise<string | null> {
  const rows = await g.roQuery<{ id: string; kind: string | null; status: string | null }>(
    `MATCH (:Entity {id:$id})<-[a:AFFECTS]-(d:Decision) WHERE a.until IS NULL
     RETURN d.id AS id, d.kind AS kind, d.status AS status ORDER BY d.decidedAt DESC, d.id LIMIT 20`, { id: goalId });
  return rows.find((r) => r.kind === "goal_target" && r.status !== "superseded")?.id ?? null;
}

export function targetSummary(i: Pick<TargetDecisionInput, "goalName" | "unit" | "period" | "target" | "previous" | "baseline" | "basis" | "changed">): string {
  const now = withUnit(i.target, i.unit, i.period);
  const from = i.baseline !== null ? ` You started at ${withUnit(i.baseline, i.unit, i.period)}.` : "";
  if (i.changed) {
    return `You set the target for "${i.goalName}" to ${now}${i.previous !== null ? `, instead of the ${fmt(i.previous)} your team suggested` : ""}.${from}`;
  }
  const how = i.basis === "baseline" ? "worked out from where you started" : i.basis === "template" ? "a usual starting figure for a business like yours, because there was nothing to measure from yet" : "chosen by your team";
  return `You said OK to the target for "${i.goalName}": ${now}, ${how}.${from}`;
}

/** Writes the decision and returns its id. The caller then updates the Goal with this id as the update's source. */
export async function recordTargetDecision(g: GraphHandle, i: TargetDecisionInput): Promise<string> {
  const id = entityId("Decision", `target ${i.goalId} ${i.now}`);
  const asOf = toIso(i.now);
  const before = await currentTargetDecision(g, i.goalId);
  await upsertNode(g, {
    type: "Decision", id, name: `Target for "${i.goalName}": ${withUnit(i.target, i.unit, i.period)}`, summary: targetSummary(i),
    props: {
      kind: "goal_target", status: "accepted", decidedAt: asOf, goal: i.goalId, metric: i.metricKey, target: i.target, ...(i.previous !== null ? { previousTarget: i.previous } : {}),
      by: i.owner, owner: true, chose: i.changed ? "own number" : "the suggestion",
    },
    src: i.owner, asOf,
  }, i.now);
  const edge = (from: string, type: "DECIDED" | "AFFECTS" | "BASED_ON" | "SUPERSEDES", to: string) => upsertEdge(g, { from, type, to, src: i.owner, asOf, since: i.now }, i.now);
  await edge(i.owner, "DECIDED", id);
  await edge(id, "AFFECTS", i.goalId);
  if (i.baselineObs) await edge(id, "BASED_ON", i.baselineObs);
  if (before && before !== id) {
    await edge(id, "SUPERSEDES", before);
    const [old] = await g.roQuery<{ name: string }>("MATCH (d:Entity:Decision {id:$id}) RETURN d.name AS name", { id: before });
    if (old) await upsertNode(g, { type: "Decision", id: before, name: old.name, props: { status: "superseded" }, src: i.owner, asOf }, i.now);
  }
  return id;
}
