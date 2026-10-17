// What your team did this week (Home), read-only:
//   GET /api/:t/week   counts over the last 7 days from the business's graph: drafts the owner approved, things sent or
//                      booked, fixes and tasks filed, new things learned, questions answered (shared/week.ts).
// Practice runs (approved actions while actions are not live: Action.status 'dry_run') are counted apart, never as sent.
// Every query only counts: no ORDER BY, no float math, and each RETURN holds aggregates only (src/graph/safety.ts).
import type { Hono } from "hono";
import type { GraphHandle } from "../../graph/client.js";
import { WEEK_DAYS, type WeekDto } from "../../../shared/week.js";
import type { RouteCtx } from "../http.js";

const READ_MS = 10_000;
const DAY_MS = 86_400_000;

// What reaches someone outside: an email, a meeting invite, a post.
const SENT_KINDS = ["email_send", "calendar_event", "discord_post", "publish_post"];
// What the team learns about the business, as opposed to its own bookkeeping (turns, cards, versions, chunks) and the
// sources it reads (documents, pages) or the numbers it measures (observations).
const LEARNED_LABELS = [
  "Memory", "Rule", "Decision", "Person", "Product", "Feature", "Audience", "Need", "BrandRule", "Campaign", "Event",
  "Competitor", "Supplier", "Partner", "Client", "Lead", "Playbook",
] as const;

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export async function weekCounts(g: GraphHandle, now: number): Promise<WeekDto> {
  const since = now - WEEK_DAYS * DAY_MS;
  const p = { since };
  const o = { timeoutMs: READ_MS };
  const learnedQuery = LEARNED_LABELS
    .map((l) => `MATCH (x:${l}) WHERE x.createdAt >= $since AND coalesce(x.status, '') <> 'retired' RETURN count(x) AS n`)
    .join(" UNION ALL ");
  const [approved, actions, followUps, learned, answered] = await Promise.all([
    g.roQuery<{ n: number }>("MATCH (a:Approval) WHERE a.decidedAt >= $since AND a.decision = 'approve' RETURN count(a) AS n", p, o),
    g.roQuery<{ sent: number; sentPractice: number; filed: number; filedPractice: number }>(
      `MATCH (x:Action) WHERE x.at >= $since AND x.status IN ['done', 'dry_run']
       RETURN sum(CASE WHEN x.kind IN $sent AND x.status = 'done' THEN 1 ELSE 0 END) AS sent,
              sum(CASE WHEN x.kind IN $sent AND x.status = 'dry_run' THEN 1 ELSE 0 END) AS sentPractice,
              sum(CASE WHEN x.kind = 'github_issue' AND x.status = 'done' THEN 1 ELSE 0 END) AS filed,
              sum(CASE WHEN x.kind = 'github_issue' AND x.status = 'dry_run' THEN 1 ELSE 0 END) AS filedPractice`,
      { ...p, sent: SENT_KINDS }, o),
    // follow-ups the sales team set itself (src/sales/graph.ts); an approved fix is counted by its Action above
    g.roQuery<{ n: number }>("MATCH (t:Task) WHERE t.createdAt >= $since AND t.kind = 'follow_up' RETURN count(t) AS n", p, o),
    g.roQuery<{ n: number }>(learnedQuery, p, o),
    g.roQuery<{ n: number }>("MATCH (t:Turn) WHERE t.at >= $since AND coalesce(t.status, 'ok') = 'ok' RETURN count(t) AS n", p, o),
  ]);
  const a = actions[0];
  return {
    since: new Date(since).toISOString(),
    days: WEEK_DAYS,
    approved: n(approved[0]?.n),
    sent: { done: n(a?.sent), practice: n(a?.sentPractice) },
    filed: { done: n(a?.filed) + n(followUps[0]?.n), practice: n(a?.filedPractice) },
    learned: learned.reduce((s, r) => s + n(r.n), 0),
    answered: n(answered[0]?.n),
  };
}

export function registerWeekRoutes(app: Hono, ctx: RouteCtx): void {
  app.get("/api/:t/week", async (c) => {
    const { g } = await ctx.tenantOf(c);
    return c.json(await weekCounts(g, ctx.now()));
  });
}
