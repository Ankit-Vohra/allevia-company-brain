// "Your team suggests these goals" (owner words: we set it up, you steer). Onboarding already proposed the goals, each
// with where the business started (its baseline) and a suggested target; the owner taps OK, or changes the number:
//   GET  /api/:t/goals/setup   the program's goals, each with whether the owner has said OK yet; [] before enrolment
//   POST /api/:t/goals/:id     { confirm: true } keeps the suggested target; { target } sets the owner's own number.
//                              Either way the goal is confirmed. Refused in public mode.
// The target is written with upsertNode on the Goal, the same write the day-0 baseline uses (program.ts baselinesWrite),
// so the scorecard's progress follows it and the old target stays a Version. `confirmedAt` is the only new property.
import type { Hono } from "hono";
import { z } from "zod";
import type { GraphHandle } from "../../graph/client.js";
import { upsertNode } from "../../graph/upsert.js";
import { currentProgram, programGoals, type GoalRow } from "../../program/program.js";
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
}

const Body = z.object({ confirm: z.literal(true).optional(), target: z.number().finite().positive().max(1_000_000_000).optional() })
  .refine((b) => b.confirm === true || b.target !== undefined, { message: "say OK (confirm: true) or give a target" });

async function setupGoals(g: GraphHandle, businessId: string): Promise<GoalSetupDto[]> {
  const program = await currentProgram(g, businessId);
  if (!program) return [];
  const [goals, marks] = await Promise.all([
    programGoals(g, program.id),
    g.roQuery<{ id: string; at: number | null }>(
      `MATCH (gl:Goal)-[pp:PART_OF]->(:Program {id:$p}) WHERE pp.until IS NULL RETURN gl.id AS id, gl.confirmedAt AS at ORDER BY gl.id`, { p: program.id }),
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
    await upsertNode(g, { type: "Goal", id, name: goal.name, props: { ...(target !== null ? { target } : {}), confirmedAt: ctx.now() } }, ctx.now());
    return c.json({ ...goal, target, confirmed: true } satisfies GoalSetupDto);
  });
}
