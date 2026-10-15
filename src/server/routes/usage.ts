// Plan and usage (product design §4.1, §4.2), read-only:
//   GET /api/:t/usage?month=YYYY-MM   this month's Studio credits (credits_charged Observations, spent on approval),
//                                     what that work cost to make (usd_cost), the answers the team gave, and two honest
//                                     flags: billing is not connected yet, and whether approved actions run live.
// Months are UTC calendar months, like the asOf dates the Studio writes on its Observations; the default is the
// current one. Sums are done here, not in Cypher (no float math in a query).
import type { Hono } from "hono";
import type { GraphHandle } from "../../graph/client.js";
import { HttpError, type RouteCtx } from "../http.js";

export interface UsageItem { subject: string; name: string; credits: number; date: string }

export interface UsageDto {
  month: string;                                   // "2026-10"
  credits: { used: number; items: UsageItem[] };   // newest first
  costUsd: number;                                 // what the month's Studio work cost to make; covered by the plan
  answers: number;                                 // questions the team answered (finished turns)
  actionsLive: boolean;                            // false: approved GitHub issues and Discord posts are dry runs
  billingConnected: false;                         // no billing yet: the plan page shows what a plan would include
}

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const ITEMS = 500;
const READ_MS = 10_000;

export async function monthUsage(g: GraphHandle, month: string): Promise<Omit<UsageDto, "actionsLive" | "billingConnected">> {
  const m = MONTH.exec(month);
  if (!m) throw new Error(`not a month: ${month}`);
  const from = Date.UTC(Number(m[1]), Number(m[2]) - 1, 1);
  const to = Date.UTC(Number(m[1]), Number(m[2]), 1);
  const [obs, turns] = await Promise.all([
    g.roQuery<{ metric: string; value: number | null; asOf: string | null; subject: string | null; name: string | null }>(
      `MATCH (o:Observation) WHERE o.metric IN ['credits_charged', 'usd_cost'] AND o.asOf STARTS WITH $month
       OPTIONAL MATCH (s:Entity {id: o.subject})
       RETURN o.metric AS metric, o.value AS value, o.asOf AS asOf, o.subject AS subject, s.name AS name
       ORDER BY o.asOf DESC, o.id LIMIT $limit`,
      { month: `${month}-`, limit: ITEMS * 2 }, { timeoutMs: READ_MS }),
    g.roQuery<{ n: number }>(
      "MATCH (t:Turn) WHERE t.at >= $from AND t.at < $to AND coalesce(t.status, 'ok') = 'ok' RETURN count(t) AS n",
      { from, to }, { timeoutMs: READ_MS }),
  ]);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const items: UsageItem[] = obs.filter((o) => o.metric === "credits_charged" && num(o.value) > 0).map((o) => ({
    subject: o.subject ?? "", name: o.name ?? o.subject ?? "Studio work", credits: num(o.value), date: (o.asOf ?? "").slice(0, 10),
  }));
  const cents = obs.filter((o) => o.metric === "usd_cost").reduce((s, o) => s + Math.round(num(o.value) * 100), 0);
  return { month, credits: { used: items.reduce((s, i) => s + i.credits, 0), items }, costUsd: cents / 100, answers: turns[0]?.n ?? 0 };
}

export function registerUsageRoutes(app: Hono, ctx: RouteCtx, o: { actionsLive: () => boolean }): void {
  app.get("/api/:t/usage", async (c) => {
    const { g } = await ctx.tenantOf(c);
    const month = c.req.query("month") ?? new Date(ctx.now()).toISOString().slice(0, 7);
    if (!MONTH.test(month)) throw new HttpError(400, "month must look like 2026-10.");
    const dto: UsageDto = { ...(await monthUsage(g, month)), actionsLive: o.actionsLive(), billingConnected: false };
    return c.json(dto);
  });
}
