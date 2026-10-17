// "Your team suggests these goals" (owner words: we set it up, you steer). Onboarding already proposed the goals, each
// with where the business started (its baseline) and a suggested target; the owner taps OK, or changes the number:
//   GET  /api/:t/goals/setup   the program's goals, each with whether the owner has said OK yet; [] before enrolment
//   POST /api/:t/goals/:id     { confirm: true } keeps the suggested target; { target } sets the owner's own number.
//                              Either way the goal is confirmed. Refused in public mode.
// The target is written with upsertNode on the Goal, the same write the day-0 baseline uses (program.ts baselinesWrite),
// so the scorecard's progress follows it and the old target stays a Version. `confirmedAt` is the only new property.
// The owner's choice is also a decision about the business: a Decision {kind:'goal_target'} DECIDED by the owner, AFFECTing the goal and
// BASED_ON the Observation its starting number was locked from (src/program/target-decision.ts), and the Goal's update names that decision
// as its source, with the time, so trace_decision answers "why is the target 150?". A change of number, or the first OK, writes one; saying
// OK again changes nothing.
import type { Hono } from "hono";
import { z } from "zod";
import { ensureActor } from "../../actions/shared.js";
import type { GraphHandle } from "../../graph/client.js";
import { upsertNode } from "../../graph/upsert.js";
import { baselineObsId, currentProgram, programGoals, type GoalRow } from "../../program/program.js";
import { ownerPerson, recordTargetDecision } from "../../program/target-decision.js";
import { toIso } from "../../util/time.js";
import { HttpError, readBody, type RouteCtx } from "../http.js";

export interface GoalSetupDto {
  id: string;
  name: string;
  unit: string | null;
  period: "week" | "month";
  baseline: number | null;   // where the business started; null when there was no data
  target: number | null;     // the suggestion, or the owner's own number once changed
  why: string | null;        // one line on what the goal is
  confirmed: boolean;
  decisionId?: string;       // the decision behind the number, when this answer wrote one
}

const Body = z.object({ confirm: z.literal(true).optional(), target: z.number().finite().positive().max(1_000_000_000).optional() })
  .refine((b) => b.confirm === true || b.target !== undefined, { message: "say OK (confirm: true) or give a target" });

async function setupGoals(g: GraphHandle, businessId: string): Promise<GoalSetupDto[]> {
  const program = await currentProgram(g, businessId);
  if (!program) return [];
  const [goals, marks] = await Promise.all([
    programGoals(g, program.id),
    g.roQuery<{ id: string; at: number | null }>(
      `MATCH (pr:Entity:Program {id:$p}) WITH pr MATCH (gl:Goal)-[pp:PART_OF]->(pr) WHERE pp.until IS NULL RETURN gl.id AS id, gl.confirmedAt AS at ORDER BY gl.id`, { p: program.id }),
  ]);
  const confirmed = new Set(marks.filter((m) => m.at !== null && m.at !== undefined).map((m) => m.id));
  return goals.map((x: GoalRow): GoalSetupDto => ({
    id: x.id, name: x.name, unit: x.unit, period: x.period, baseline: x.baseline, target: x.target, why: x.why, confirmed: confirmed.has(x.id),
  }));
}

export function registerGoalRoutes(app: Hono, ctx: RouteCtx): void {
  app.get("/api/:t/goals/setup", async (c) => {
    const { reg, g } = await ctx.tenantOf(c);
    return c.json({ goals: await setupGoals(g, reg.businessId) });
  });

  app.post("/api/:t/goals/:id", async (c) => {
    const { reg, g } = await ctx.tenantOf(c);
    ctx.refuseInPublicMode();
    const body = await readBody(c, Body);
    const id = c.req.param("id");
    const goal = (await setupGoals(g, reg.businessId)).find((x) => x.id === id);
    if (!goal) throw new HttpError(404, "No such goal in your growth plan.");
    const target = body.target ?? goal.target;
    const now = ctx.now();
    const changed = body.target !== undefined && body.target !== goal.target;
    if (!changed && goal.confirmed) return c.json({ ...goal, confirmed: true } satisfies GoalSetupDto); // saying OK again changes nothing
    const owner = (await ownerPerson(g)) ?? (await ensureActor(g, "person:owner", now));
    let decisionId: string | undefined;
    if (target !== null) {
      const program = await currentProgram(g, reg.businessId);
      const row = program ? (await programGoals(g, program.id)).find((x) => x.id === id) : undefined;
      // the Observation the starting number was locked from, when there is one
      const obs = row && row.baseline !== null && row.metricKey ? baselineObsId(row.metricKey, id) : null;
      const found = obs ? await g.roQuery<{ id: string }>("MATCH (x:Entity:Observation {id:$id}) RETURN x.id AS id", { id: obs }) : [];
      decisionId = await recordTargetDecision(g, {
        goalId: id, goalName: goal.name, unit: goal.unit, period: goal.period, metricKey: row?.metricKey ?? "", target, previous: goal.target, baseline: goal.baseline,
        baselineObs: found.length ? obs : null, basis: row?.targetBasis === "baseline" || row?.targetBasis === "template" ? row.targetBasis : null, changed, owner, now,
      });
    }
    await upsertNode(g, {
      type: "Goal", id, name: goal.name, props: { ...(target !== null ? { target } : {}), confirmedAt: now },
      src: decisionId ?? owner, asOf: toIso(now),
    }, now);
    return c.json({ ...goal, target, confirmed: true, ...(decisionId ? { decisionId } : {}) } satisfies GoalSetupDto);
  });
}
