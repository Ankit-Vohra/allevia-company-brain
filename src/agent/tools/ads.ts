// ad_report: paid campaigns over the last N days. Per campaign: spend, impressions, clicks, signups (flows sum over
// the window; lifetime snapshots take the latest), CPA = spend / signups, CTR, and CPA against the median campaign
// (>= 1.5x is flagged, the spec's ads detector). Ad data in the demo is simulated, and the result always says so.
import { z } from "zod";
import type { ToolContext } from "../tool.js";
import { isoDate } from "../../util/time.js";
import { Collector, EDGE, NODE, brief, clamp, defineTool, median, ro, round, type EdgeRow, type NodeRow } from "./common.js";
import { ALIASES, aggregate, aggregateFor, observationsFor, type ObsRow } from "./observations.js";

const OBS_NODE_CAP = 40;

async function runAds(args: { days?: number }, ctx: ToolContext) {
  const days = clamp(args.days, 30, 1, 365);
  const from = isoDate(ctx.now - days * 86_400_000);
  const camps = await ro<{ c: NodeRow; status: string | null; objective: string | null }>(ctx,
    `MATCH (c:Campaign) RETURN ${NODE("c")} AS c, c.status AS status, c.objective AS objective ORDER BY c.name LIMIT 200`);
  const col = new Collector();
  if (!camps.length) return col.result(ctx, { days, from, campaigns: [] }, "No campaigns in the graph.");
  const ids = camps.map((c) => c.c.id);
  const [channels, obs] = await Promise.all([
    ro<{ cid: string; ch: NodeRow; e: EdgeRow }>(ctx,
      `UNWIND $ids AS cid MATCH (:Entity {id:cid})-[r:PUBLISHED_ON]->(ch:Entity) WHERE r.until IS NULL RETURN cid, ${NODE("ch")} AS ch, ${EDGE("r")} AS e`, { ids }),
    observationsFor(ctx, ids, { from, metrics: [...ALIASES.spend, ...ALIASES.signups, "impressions", "clicks"] }),
  ]);

  const total = (rows: ObsRow[], aliases: readonly string[]): number | null => {
    const hit = rows.filter((r) => aliases.includes(r.metric.toLowerCase())).reverse(); // oldest first
    if (!hit.length) return null;
    return round(aggregate(aggregateFor(hit[0]!.metric, hit[0]!.unit, hit), hit), 2);
  };
  const byCamp = new Map<string, ObsRow[]>();
  for (const o of obs) byCamp.set(o.s, [...(byCamp.get(o.s) ?? []), o]);
  const rows = camps.map(({ c, status, objective }) => {
    const rs = byCamp.get(c.id) ?? [];
    const spend = total(rs, ALIASES.spend);
    const signups = total(rs, ALIASES.signups);
    const impressions = total(rs, ["impressions"]);
    const clicks = total(rs, ["clicks"]);
    return {
      c, rs, status, objective, spend, signups, impressions, clicks,
      cpa: spend !== null && signups ? round(spend / signups, 2) : null,
      ctrPct: clicks !== null && impressions ? round((clicks / impressions) * 100, 2) : null,
    };
  });
  const med = median(rows.map((r) => r.cpa).filter((v): v is number => v !== null));
  const chByCamp = new Map(channels.map((c) => [c.cid, c]));
  let obsNodes = 0;
  const campaigns = rows.map((r) => {
    col.node(r.c);
    const ch = chByCamp.get(r.c.id);
    if (ch) {
      col.node(ch.ch);
      col.edge(ch.e);
    }
    for (const o of r.rs) {
      if (obsNodes < OBS_NODE_CAP) {
        col.node(o.o);
        col.edge(o.e);
        obsNodes++;
      } else col.provenance([o.o.id]);
    }
    const vs = r.cpa !== null && med ? round(r.cpa / med, 2) : null;
    return {
      ...brief(r.c), ...(r.status ? { status: r.status } : {}), ...(r.objective ? { objective: r.objective } : {}),
      ...(ch ? { channel: ch.ch.id } : {}), spend: r.spend, impressions: r.impressions, clicks: r.clicks, signups: r.signups,
      cpa: r.cpa, ctrPct: r.ctrPct, cpaVsMedian: vs, ...(vs !== null && vs >= 1.5 ? { flag: "cpa_high" } : vs !== null && vs <= 0.67 ? { flag: "cpa_low" } : {}),
      ...(r.c.simulated || r.rs.some((o) => o.o.simulated) ? { simulated: true } : {}),
    };
  }).sort((a, b) => (b.spend ?? 0) - (a.spend ?? 0));
  const spend = round(rows.reduce((s, r) => s + (r.spend ?? 0), 0), 2);
  const signups = round(rows.reduce((s, r) => s + (r.signups ?? 0), 0), 2);
  const simulated = campaigns.some((c) => c.simulated === true);
  const notes = [
    ...(simulated ? ["Ad data is simulated"] : []),
    ...(obs.length ? [] : [`No ad numbers since ${from}.`]),
  ];
  return col.result(ctx, {
    days, from, medianCpa: med === null ? null : round(med, 2),
    totals: { spend, signups, cpa: signups ? round(spend / signups, 2) : null }, campaigns, ...(simulated ? { simulated: true } : {}),
  }, notes.join(". ") || undefined);
}

export const adReport = defineTool({
  name: "ad_report",
  description:
    "Paid ads over the last N days (default 30): per campaign spend, impressions, clicks, signups, CPA, CTR and CPA vs the median campaign (flag cpa_high at >= 1.5x), plus totals. Says 'Ad data is simulated' when it is; repeat that in your answer. Example: {\"days\":14}",
  input: { days: z.number().int().optional().describe("Window in days, default 30") },
  run: runAds,
});
