// The team's routine work on demand (spec §9, product design §3.2):
//   POST /api/:t/insights/run   run the detectors; write Recommendations and approval cards (numbers from the graph)
//   POST /api/:t/brief/run      bring the goals' readings up to date, then write today's morning brief (a
//                               Document{kind:'brief'} that GET /api/:t/brief serves)
// Neither calls a language model.
import type { Hono } from "hono";
import { runInsights } from "../../insights/recommend.js";
import { writeBrief } from "../../insights/brief.js";
import { refreshGoalReadings } from "../../program/scorecard.js";
import { HttpError, type RouteCtx } from "../http.js";

export function registerWorkRoutes(app: Hono, ctx: RouteCtx): void {
  const running = new Set<string>();
  const once = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    if (running.has(key)) throw new HttpError(429, "That is already running for this business. Try again in a minute.");
    running.add(key);
    try {
      return await fn();
    } finally {
      running.delete(key);
    }
  };

  app.post("/api/:t/insights/run", async (c) => {
    const { reg, g } = await ctx.tenantOf(c);
    ctx.refuseInPublicMode();
    const r = await once(`insights:${reg.slug}`, () => runInsights(reg.slug, { graph: g, now: ctx.now(), log: ctx.log }));
    return c.json({
      tenant: r.tenant,
      findings: r.candidates.length,
      created: r.recommendations.filter((x) => x.created).length,
      cards: r.recommendations.filter((x) => x.approvalId).length,
      resolved: r.resolved,
      errors: r.errors,
      recommendations: r.recommendations.map((x) => ({ id: x.id, title: x.title, area: x.area, by: x.by, created: x.created, goals: x.goals, ...(x.approvalId ? { approvalId: x.approvalId } : {}) })),
    });
  });

  app.post("/api/:t/brief/run", async (c) => {
    const { reg, g } = await ctx.tenantOf(c);
    ctx.refuseInPublicMode();
    const b = await once(`brief:${reg.slug}`, async () => {
      await refreshGoalReadings(g, { now: ctx.now(), businessId: reg.businessId });
      return writeBrief(reg.slug, { graph: g, now: ctx.now() });
    });
    return c.json(b);
  });

}
