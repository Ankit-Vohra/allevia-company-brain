// Where an approved fix lands for this business (src/actions/target.ts):
//   GET  /api/:t/actions/target   { target: 'app' | 'github', repo?, label }  the default is tasks inside the app and on Discord
//   POST /api/:t/actions/target   { target: 'app' } or { target: 'github', repo: 'owner/name' }; refused in public mode
// A business can never choose Allevia's own repo (setActionTarget refuses it); only the operator's CLI can.
import type { Hono } from "hono";
import { z } from "zod";
import { usesFoundersAccounts } from "../../actions/executors.js";
import { ActionTargetError, APP_TARGET_LABEL, getActionTarget, setActionTarget, type ActionTarget } from "../../actions/target.js";
import { loadConfig } from "../../config.js";
import { HttpError, readBody, type RouteCtx } from "../http.js";

const Body = z.discriminatedUnion("target", [
  z.object({ target: z.literal("app") }),
  z.object({ target: z.literal("github"), repo: z.string().trim().min(3).max(140) }),
]);

export interface ActionTargetDto { target: "app" | "github"; repo?: string; label: string; note?: string }

const dto = (t: ActionTarget): ActionTargetDto =>
  t.kind === "github"
    ? { target: "github", repo: t.repo, label: `GitHub issues on ${t.repo}` }
    : { target: "app", label: APP_TARGET_LABEL, ...(t.reason ? { note: t.reason } : {}) };

export function registerActionRoutes(app: Hono, ctx: RouteCtx): void {
  const serverRepo = () => loadConfig().githubActionRepo; // Allevia's own tracker: what a business may not choose

  app.get("/api/:t/actions/target", async (c) => {
    const { reg, g } = await ctx.tenantOf(c);
    return c.json(dto(await getActionTarget(g, reg.slug, { serverRepo: serverRepo(), businessId: reg.businessId, founders: usesFoundersAccounts(reg.slug) })));
  });

  app.post("/api/:t/actions/target", async (c) => {
    const { reg, g } = await ctx.tenantOf(c);
    ctx.refuseInPublicMode();
    const body = await readBody(c, Body);
    try {
      return c.json(dto(await setActionTarget(g, body, { now: ctx.now(), tenant: reg.slug, businessId: reg.businessId, serverRepo: serverRepo() })));
    } catch (e) {
      if (e instanceof ActionTargetError) throw new HttpError(400, e.message);
      throw e;
    }
  });
}
