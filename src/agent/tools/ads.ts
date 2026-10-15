// ad_report: paid campaigns over the last N days. Per campaign: spend, impressions, clicks, signups (flows sum over
// the window; lifetime snapshots take the latest), CPA = spend / signups, CTR, and CPA against the median campaign
// (>= 1.5x is flagged, the spec's ads detector). Ad data in the demo is simulated, and the result always says so.
// One metric per quantity: a campaign that records both `signups` and `conversions` (simads writes its conversion
// metric and the unified one, same values) is counted once, from the first alias it has. Spend carries its currency
// (the spend observations' unit), so totals never mix currencies silently.
import { z } from "zod";
import type { ToolContext } from "../tool.js";
import { isoDate } from "../../util/time.js";
import { Collector, EDGE, NODE, brief, clamp, defineTool, median, ro, round, type EdgeRow, type NodeRow } from "./common.js";
import { ALIASES, totalOf, totalsFor, type ObsTotal } from "./observations.js";

const OBS_NODE_CAP = 40;
const CAMPAIGN_CAP = 25;
const CAMPAIGNS_READ = 200;

async function runAds(args: { days?: number }, ctx: ToolContext) {
  const days = clamp(args.days, 30, 1, 365);
  const from = isoDate(ctx.now - days * 86_400_000);
  const [camps, [count]] = await Promise.all([
    ro<{ c: NodeRow; status: string | null; objective: string | null }>(ctx,
      `MATCH (c:Campaign) RETURN ${NODE("c")} AS c, c.status AS status, c.objective AS objective ORDER BY c.name, c.id LIMIT $cap`, { cap: CAMPAIGNS_READ }),
    ro<{ n: number }>(ctx, "MATCH (c:Campaign) RETURN count(c) AS n"),
  ]);
  const col = new Collector();
  if (!camps.length) return col.result(ctx, { days, from, campaigns: [] }, "No campaigns in the graph.");
  const ids = camps.map((c) => c.c.id);
  // Totals per campaign and metric are summed on the server: 200 campaigns x 365 days x 6 metrics is far past the
  // 10,000 rows FalkorDB returns.
  const [channels, totals] = await Promise.all([
    ro<{ cid: string; ch: NodeRow; e: EdgeRow }>(ctx,
      `UNWIND $ids AS cid MATCH (c:Entity {id:cid}) WITH cid, c MATCH (c)-[r:PUBLISHED_ON]->(ch:Entity) WHERE r.until IS NULL
       WITH cid, head(collect({ch: ${NODE("ch")}, e: ${EDGE("r")}})) AS x RETURN cid, x.ch AS ch, x.e AS e`, { ids }),
    totalsFor(ctx, ids, { from, metrics: [...ALIASES.spend, ...ALIASES.signups, "impressions", "clicks"] }),
  ]);

  // The first alias the campaign has data for, and only that metric (never the sum of two names for one number).
  const byCamp = new Map<string, ObsTotal[]>();
  for (const t of totals) byCamp.set(t.s, [...(byCamp.get(t.s) ?? []), t]);
  const metricOf = (ts: ObsTotal[], aliases: readonly string[]): ObsTotal | undefined => {
    for (const a of aliases) {
      const hit = ts.find((t) => t.metric === a);
      if (hit) return hit;
    }
    return undefined;
  };
  const total = (t: ObsTotal | undefined): number | null => (t ? round(totalOf(t), 2) : null);
  const rows = camps.map(({ c, status, objective }) => {
    const ts = byCamp.get(c.id) ?? [];
    const [spendT, signupsT, impressionsT, clicksT] = [metricOf(ts, ALIASES.spend), metricOf(ts, ALIASES.signups), metricOf(ts, ["impressions"]), metricOf(ts, ["clicks"])];
    const used = [spendT, signupsT, impressionsT, clicksT].filter((t): t is ObsTotal => !!t);
    const [spend, signups, impressions, clicks] = [total(spendT), total(signupsT), total(impressionsT), total(clicksT)];
    return {
      c, status, objective, spend, signups, impressions, clicks, used, currency: spendT?.unit ?? null,
      simulated: c.simulated === true || used.some((t) => t.simulated),
      cpa: spend !== null && signups ? round(spend / signups, 2) : null,
      ctrPct: clicks !== null && impressions ? round((clicks / impressions) * 100, 2) : null,
    };
  });
  const med = median(rows.map((r) => r.cpa).filter((v): v is number => v !== null));
  const chByCamp = new Map(channels.map((c) => [c.cid, c]));
  let obsNodes = 0;
  const currencies = new Set(rows.filter((r) => r.spend !== null && r.currency).map((r) => r.currency!));
  const mixed = currencies.size > 1;
  const shown = [...rows].sort((a, b) => (b.spend ?? 0) - (a.spend ?? 0) || a.c.id.localeCompare(b.c.id)).slice(0, CAMPAIGN_CAP);
  const shownIds = new Set(shown.map((r) => r.c.id));
  // In the totals but not shown: their newest observations still count as provenance.
  for (const r of rows) if (!shownIds.has(r.c.id)) col.provenance(r.used.flatMap((t) => t.newest.map((x) => x.o.id)));
  const campaigns = shown.map((r) => {
    col.node(r.c);
    const ch = chByCamp.get(r.c.id);
    if (ch) {
      col.node(ch.ch);
      col.edge(ch.e);
    }
    for (const { o, e } of r.used.flatMap((t) => t.newest)) {
      if (obsNodes < OBS_NODE_CAP) {
        col.node(o);
        col.edge(e);
        obsNodes++;
      } else col.provenance([o.id]);
    }
    const vs = r.cpa !== null && med ? round(r.cpa / med, 2) : null;
    return {
      ...brief(r.c), ...(r.status ? { status: r.status } : {}), ...(r.objective ? { objective: r.objective } : {}),
      ...(ch ? { channel: ch.ch.id } : {}), spend: r.spend, ...(mixed && r.currency ? { currency: r.currency } : {}),
      impressions: r.impressions, clicks: r.clicks, signups: r.signups,
      cpa: r.cpa, ctrPct: r.ctrPct, cpaVsMedian: vs, ...(vs !== null && vs >= 1.5 ? { flag: "cpa_high" } : vs !== null && vs <= 0.67 ? { flag: "cpa_low" } : {}),
      ...(r.simulated ? { simulated: true } : {}),
    };
  });
  const spend = round(rows.reduce((s, r) => s + (r.spend ?? 0), 0), 2);
  const signups = round(rows.reduce((s, r) => s + (r.signups ?? 0), 0), 2);
  const simulated = rows.some((r) => r.simulated);
  const all = count?.n ?? rows.length;
  const notes = [
    ...(simulated ? ["Ad data is simulated"] : []),
    ...(totals.length ? [] : [`No ad numbers since ${from}`]),
    ...(mixed ? [`Spend is in several currencies (${[...currencies].join(", ")}), so there is no spend or CPA total`] : []),
    ...(rows.length > CAMPAIGN_CAP ? [`Showing the ${CAMPAIGN_CAP} biggest spenders of ${rows.length} campaigns; totals cover all${all > rows.length ? ` ${rows.length} read` : ""}`] : []),
    ...(all > rows.length ? [`Read the first ${rows.length} of ${all} campaigns by name`] : []),
  ];
  return col.result(ctx, {
    days, from, medianCpa: med === null ? null : round(med, 2),
    totals: mixed ? { spend: null, signups, cpa: null, currency: null }
      : { spend, signups, cpa: signups ? round(spend / signups, 2) : null, currency: [...currencies][0] ?? null },
    campaigns, ...(simulated ? { simulated: true } : {}),
  }, notes.join(". ") || undefined);
}

export const adReport = defineTool({
  name: "ad_report",
  description:
    "How are our ads doing: per campaign over the last N days (default 30) spend with currency, impressions, clicks, signups, CPA, CTR and CPA vs the median campaign (flag cpa_high at >= 1.5x), plus totals. Says 'Ad data is simulated' when it is; repeat that in your answer. Example: {\"days\":14}",
  input: { days: z.number().int().optional().describe("Window in days, default 30") },
  run: runAds,
});
