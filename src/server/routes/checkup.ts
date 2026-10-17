// "Check my website": the owner starts the check-up from the web app and sees the top five when it is done.
//   GET  /api/:t/checkup            where it stands (idle, waiting, running, done, failed), the weekly setting, the website,
//                                   and the latest top five in owner words
//   POST /api/:t/checkup            start one now, in the background (`checkup --tenant`, src/checkup/jobs.ts); a run that is
//                                   already going is not started twice. Refused in public mode. It uses 10 credits
//                                   (CREDIT_PRICES website_checkup), held when it starts (a 402 when there are not 10 left)
//                                   and charged when it finishes, linked to its report; a run that fails costs nothing. The
//                                   weekly and monthly check-ups the team runs on its own are free.
//   PUT  /api/:t/checkup/schedule   { weekly: boolean }: the weekly check-up for this business. Refused in public mode.
// The business is the one in the path, as everywhere: its own graph, its own stored website.
import type { Hono } from "hono";
import { z } from "zod";
import type { CheckupJobs } from "../../checkup/jobs.js";
import { storedCheckups } from "../../checkup/run.js";
import type { Credits } from "../../credits/index.js";
import { latestCheckup, setCheckupWeekly, tenantSite, weeklyOn, type LatestCheckup } from "../../checkup/tenant.js";
import { HttpError, readBody, type RouteCtx } from "../http.js";

export interface CheckupStatusDto {
  status: "idle" | "waiting" | "running" | "done" | "failed";
  message: string;
  website: string | null;
  weekly: boolean;
  startedAt?: string;
  last: LatestCheckup | null;
}

const Schedule = z.object({ weekly: z.boolean() });
const RUNNING = "Checking your website now. It takes about 3 minutes; the top five fixes show here when it's done.";
export const CHECKUP_COST = "It uses 10 credits and takes about 3 minutes.";

export function registerCheckupRoutes(app: Hono, ctx: RouteCtx, o: { jobs: () => CheckupJobs; credits?: Credits; by?: () => string }): void {
  async function status(c: import("hono").Context): Promise<CheckupStatusDto> {
    const { reg, g } = await ctx.tenantOf(c);
    const site = await tenantSite(g, reg.slug, reg.businessId);
    const job = o.jobs().state(reg.slug);
    const last = await latestCheckup(g);
    const st: CheckupStatusDto["status"] = job?.status ?? (last ? "done" : "idle");
    const message = st === "waiting" || st === "running" ? RUNNING
      : st === "failed" ? job?.error ?? "The check-up couldn't finish this time."
      : last ? `Last checked on ${last.checkedOn}.`
      : site?.url ? `Your website hasn't been checked yet. ${CHECKUP_COST}`
      : "We don't have your website address yet.";
    return {
      status: st, message, website: site?.url ?? null, weekly: site ? weeklyOn(site, !!reg.demo) : false,
      ...(job?.startedAt ? { startedAt: new Date(job.startedAt).toISOString() } : {}), last,
    };
  }

  app.get("/api/:t/checkup", async (c) => c.json(await status(c)));

  app.post("/api/:t/checkup", async (c) => {
    const { reg, g } = await ctx.tenantOf(c);
    ctx.refuseInPublicMode();
    const site = await tenantSite(g, reg.slug, reg.businessId);
    if (!site?.url) throw new HttpError(400, "We don't have your website address yet, so there is nothing to check.");
    // a 402 before anything runs; joining a run that is already going costs nothing more
    const hold = o.credits && !o.jobs().busy(reg.slug) ? await o.credits.hold(reg.slug, "website_checkup", { g }) : undefined;
    const by = o.by?.() ?? "owner";
    let mine = false;
    const { started, job } = o.jobs().start(reg.slug, "owner", (done) => {
      if (!hold) return;
      if (!mine || !done.ok) { hold.release(); return; }
      void storedCheckups(g, 1).then((d) => d[0]?.docId, () => undefined)
        .then((doc) => hold.commit({ ref: `checkup:${reg.slug}:${job.queuedAt}`, by, ...(doc ? { for: [doc] } : {}) }))
        .catch((e) => ctx.log(`[checkup] ${reg.slug}: the check-up was not charged: ${e instanceof Error ? e.message : String(e)}`));
    });
    mine = started;
    if (!started) hold?.release(); // joined a run that was already going: that one is already paid for (or free)
    if (started) ctx.log(`[checkup] ${reg.slug}: started from the web app`);
    return c.json(await status(c), started ? 202 : 200);
  });

  app.put("/api/:t/checkup/schedule", async (c) => {
    const { reg, g } = await ctx.tenantOf(c);
    ctx.refuseInPublicMode();
    const body = await readBody(c, Schedule);
    await setCheckupWeekly(g, reg.slug, body.weekly, ctx.now(), reg.businessId);
    return c.json(await status(c));
  });
}
