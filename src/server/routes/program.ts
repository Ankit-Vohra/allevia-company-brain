// Allevia 90 and what the team learned (product design §8):
//   GET    /api/:t/program               the scorecard (src/program/scorecard.ts); 404 until the business is enrolled
//   GET    /api/:t/capabilities          the capability ladder
//   GET    /api/:t/learning?since=       learned rules, newest first (since: an ISO date or epoch ms), and the KPI
//   DELETE /api/:t/learning/:ruleId      retire a learned rule (status -> retired, the active state kept as a Version)
// The two GETs bring the graph up to date as they read (goal readings, due checkpoints, Capability nodes), except in
// public mode, where they compute the same answer read-only.
import type { Hono } from "hono";
import { deriveCapabilities, getCapabilities } from "../../capabilities/ladder.js";
import { learningMetrics } from "../../actions/learning.js";
import { learnedRules, retireLearnedRule } from "../../actions/feed.js";
import { getProgram } from "../../program/scorecard.js";
import { HttpError, type RouteCtx } from "../http.js";

function parseSince(raw: string | undefined): number {
  if (!raw) return 0;
  const ms = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  if (!Number.isFinite(ms)) throw new HttpError(400, "since must be a date (2026-10-15) or epoch milliseconds.");
  return ms;
}

export function registerProgramRoutes(app: Hono, ctx: RouteCtx): void {
  app.get("/api/:t/program", async (c) => {
    const { reg, g } = await ctx.tenantOf(c);
    const p = await getProgram(g, { now: ctx.now(), businessId: reg.businessId, write: !ctx.publicMode });
    if (!p) throw new HttpError(404, "This business is not in Allevia 90 yet.");
    return c.json(p);
  });

  app.get("/api/:t/capabilities", async (c) => {
    const { reg, g } = await ctx.tenantOf(c);
    const opts = { now: ctx.now(), businessId: reg.businessId };
    if (!ctx.publicMode) return c.json(await getCapabilities(g, opts));
    return c.json((await deriveCapabilities(g, opts)).map(({ spec: _spec, ...cap }) => cap));
  });

  app.get("/api/:t/learning", async (c) => {
    const { g } = await ctx.tenantOf(c);
    const since = parseSince(c.req.query("since"));
    const [rules, kpi] = await Promise.all([learnedRules(g, since), learningMetrics(g, ctx.now())]);
    return c.json({
      since: new Date(since).toISOString(),
      firstPass: { rate: kpi.firstPassRate, decided30d: kpi.decided30d, firstPass30d: kpi.firstPass30d },
      active: kpi.learnedRules,
      rules,
    });
  });

  app.delete("/api/:t/learning/:ruleId", async (c) => {
    const { g } = await ctx.tenantOf(c);
    ctx.refuseInPublicMode();
    const r = await retireLearnedRule(g, c.req.param("ruleId"), { now: ctx.now() });
    if (!r) throw new HttpError(404, "No such learned rule.");
    return c.json(r);
  });
}
