// The team's routine work on demand (spec §9, product design §3.2):
//   POST /api/:t/insights/run   run the detectors; write Recommendations and approval cards (numbers from the graph)
//   POST /api/:t/brief/run      bring the goals' readings up to date, then write today's morning brief (a
//                               Document{kind:'brief'} that GET /api/:t/brief serves)
// Neither calls a language model.
//   GET  /api/:t/standup        today's team stand-up (src/proactive): what the team noticed and drafted, or that it was quiet;
//                               404 when it has not run today
//   POST /api/:t/standup/run    run it now (The Chief on the subscription; drafts wait for the owner's OK), then today's note
import type { Hono } from "hono";
import { runInsights } from "../../insights/recommend.js";
import { writeBrief } from "../../insights/brief.js";
import { refreshGoalReadings } from "../../program/scorecard.js";
import { HttpError, type RouteCtx } from "../http.js";
import { readStandup } from "../../proactive/note.js";
import { isoDate } from "../../util/time.js";
import type { GraphHandle } from "../../graph/client.js";

export function registerWorkRoutes(app: Hono, ctx: RouteCtx, standup?: (slug: string, g: GraphHandle, businessId: string) => Promise<{ standup: unknown; brief: unknown }>): void {
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

  app.get("/api/:t/standup", async (c) => {
    const { g } = await ctx.tenantOf(c);
    const s = await readStandup(g, c.req.query("date") ?? isoDate(ctx.now()));
    if (!s) throw new HttpError(404, "Your team has not met yet today.");
    return c.json(s);
  });

  app.post("/api/:t/standup/run", async (c) => {
    const { reg, g } = await ctx.tenantOf(c);
    ctx.refuseInPublicMode();
    if (!standup) throw new HttpError(501, "The daily stand-up is not set up on this server.");
    const r = await once(`standup:${reg.slug}`, () => standup(reg.slug, g, reg.businessId));
    return c.json(r);
  });
}
