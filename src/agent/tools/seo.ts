// seo_report: website problems, worst first. Pages with the SEO rules they FAIL (severity, evidence, how to fix),
// their latest Search Console / GA4 numbers (clicks, impressions, CTR, position, sessions) and the queries they rank
// for. A page's problem score is its failed-rule severity (plus low CTR: >= 100 impressions under 1%) scaled by log
// impressions, so a broken page people actually see comes first. Every page counts toward the ranking and the summary
// (read compactly on the server); details are read only for the pages shown.
import { z } from "zod";
import type { ToolContext } from "../tool.js";
import {
  Collector, EDGE, NODE, brief, clamp, clip, defineTool, getNodes, packed, ro, round, type Brief, type EdgeRow, type NodeRow,
} from "./common.js";
import { ALIASES, pick } from "./observations.js";

const SEVERITY: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0.5 };
const severityWeight = (s: unknown): number => (typeof s === "number" ? s : SEVERITY[String(s ?? "").toLowerCase()] ?? 1);
const SEO_METRICS = [...ALIASES.clicks, ...ALIASES.impressions, ...ALIASES.ctr, ...ALIASES.position, ...ALIASES.sessions];
const PROBLEMS_PER_PAGE = 6;
const QUERIES_PER_PAGE = 3;
const OBS_NODE_CAP = 30;

interface PageFails { pid: string; fails: Array<{ r: string; s: string | number | null }> }
interface PageObs { pid: string; m: string; v: number; id: string; sim: boolean | null }
interface FailRow { pid: string; r: NodeRow; e: EdgeRow; severity: string | number | null; evidence: string | null; howToFix: string | null }

async function runSeo(args: { limit?: number }, ctx: ToolContext) {
  const limit = clamp(args.limit, 10, 1, 25);
  // Whole-site figures from compact per-page rows, packed so a site with thousands of pages is never cut at FalkorDB's
  // 10,000-row result: each page's failed rules, and its newest number per SEO metric.
  const [fails, obs] = await Promise.all([
    packed<PageFails>(ctx, "MATCH (p:Page)-[f:FAILS]->(r:Entity) WHERE f.until IS NULL WITH p, collect({r: r.id, s: r.severity}) AS fails",
      "{pid: p.id, fails: fails}"),
    packed<PageObs>(ctx,
      `MATCH (o:Observation)-[:MEASURES]->(p:Page) WHERE toLower(o.metric) IN $metrics
       WITH p, toLower(o.metric) AS m, o ORDER BY coalesce(o.windowEnd, o.asOf) DESC, o.id DESC
       WITH p, m, head(collect(o)) AS o`,
      "{pid: p.id, m: m, v: o.value, id: o.id, sim: o.simulated}", { metrics: SEO_METRICS }),
  ]);
  const pages = new Map<string, { fails: PageFails["fails"]; obs: Map<string, PageObs> }>();
  const page = (pid: string) => {
    const pg = pages.get(pid) ?? { fails: [], obs: new Map<string, PageObs>() };
    pages.set(pid, pg);
    return pg;
  };
  for (const f of fails.rows) page(f.pid).fails = f.fails;
  for (const o of obs.rows) page(o.pid).obs.set(o.m, o);

  const scored = [...pages.entries()].map(([pid, pg]) => {
    const val = (aliases: readonly string[]) => pick(pg.obs, aliases)?.v ?? null;
    const clicks = val(ALIASES.clicks);
    const impressions = val(ALIASES.impressions);
    const rawCtr = val(ALIASES.ctr);
    const ctrPct = rawCtr !== null ? round(rawCtr <= 1 ? rawCtr * 100 : rawCtr, 2)
      : clicks !== null && impressions ? round((clicks / impressions) * 100, 2) : null;
    const lowCtr = impressions !== null && impressions >= 100 && ctrPct !== null && ctrPct < 1;
    const severity = pg.fails.reduce((s, f) => s + severityWeight(f.s), 0) + (lowCtr ? 2 : 0);
    const score = round(severity * (1 + Math.log10(1 + (impressions ?? 0))), 2);
    const metrics = Object.fromEntries(Object.entries({ clicks, impressions, ctrPct, position: val(ALIASES.position), sessions: val(ALIASES.sessions) })
      .filter(([, v]) => v !== null));
    return { pid, pg, score, lowCtr, metrics, impressions: impressions ?? 0 };
  }).sort((a, b) => b.score - a.score || b.impressions - a.impressions || a.pid.localeCompare(b.pid));

  // Details only for the pages shown: their nodes, failed rules with evidence, top queries, and the observations.
  const top = scored.slice(0, limit);
  const ids = top.map((t) => t.pid);
  const bySeverity: Record<string, number> = {};
  const byRule = new Map<string, number>();
  for (const f of fails.rows.flatMap((x) => x.fails)) {
    const s = String(f.s ?? "unrated");
    bySeverity[s] = (bySeverity[s] ?? 0) + 1;
    byRule.set(f.r, (byRule.get(f.r) ?? 0) + 1);
  }
  const topRules = [...byRule.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5);
  const [nodes, failRows, queryRows, obsRows] = ids.length ? await Promise.all([
    getNodes(ctx, [...ids, ...topRules.map(([r]) => r)]),
    ro<FailRow>(ctx,
      `UNWIND $ids AS pid MATCH (p:Entity {id:pid}) WITH pid, p MATCH (p)-[f:FAILS]->(r:Entity) WHERE f.until IS NULL
       RETURN pid, ${NODE("r")} AS r, ${EDGE("f")} AS e, r.severity AS severity, f.evidence AS evidence, r.howToFix AS howToFix LIMIT 2000`, { ids }),
    ro<{ pid: string; url: string | null; qs: Array<{ q: NodeRow; e: EdgeRow; position: number | null; text: string | null }> }>(ctx,
      `UNWIND $ids AS pid MATCH (p:Entity {id:pid}) OPTIONAL MATCH (p)-[rk:RANKS_FOR]->(q:Entity) WHERE rk.until IS NULL
       WITH pid, p, q, rk ORDER BY coalesce(rk.position, 1000000), q.id
       WITH pid, p, collect(CASE WHEN q IS NULL THEN NULL ELSE {q: ${NODE("q")}, e: ${EDGE("rk")}, position: rk.position, text: coalesce(q.text, q.name)} END) AS qs
       RETURN pid, p.url AS url, qs[0..$per] AS qs`, { ids, per: QUERIES_PER_PAGE }),
    ro<{ o: NodeRow; e: EdgeRow }>(ctx,
      `UNWIND $oids AS oid MATCH (o:Entity {id:oid}) WITH o MATCH (o)-[r:MEASURES]->(:Entity) RETURN ${NODE("o")} AS o, ${EDGE("r")} AS e`,
      { oids: top.flatMap((t) => [...t.pg.obs.values()].map((o) => o.id)) }),
  ]) : [new Map<string, NodeRow>(), [], [], []];
  const details = new Map(queryRows.map((q) => [q.pid, q]));
  const obsById = new Map(obsRows.map((o) => [o.o.id, o]));

  const col = new Collector();
  let obsNodes = 0;
  const out = top.map(({ pid, pg, score, lowCtr, metrics }) => {
    col.node(nodes.get(pid));
    const problems = failRows.filter((f) => f.pid === pid).sort((a, b) => severityWeight(b.severity) - severityWeight(a.severity) || a.r.id.localeCompare(b.r.id))
      .slice(0, PROBLEMS_PER_PAGE).map((f) => {
        col.node(f.r);
        col.edge(f.e);
        return {
          ...brief(f.r), severity: f.severity ?? null, ...(f.evidence ? { evidence: clip(f.evidence, 200) } : {}),
          ...(f.howToFix ? { howToFix: clip(f.howToFix, 300) } : {}),
        };
      });
    const queries = (details.get(pid)?.qs ?? []).map((q) => {
      col.node(q.q);
      col.edge(q.e);
      return { id: q.q.id, text: q.text ?? q.q.name, ...(q.position !== null ? { position: q.position } : {}) };
    });
    for (const o of pg.obs.values()) {
      const row = obsById.get(o.id);
      if (row && obsNodes < OBS_NODE_CAP) {
        col.node(row.o);
        col.edge(row.e);
        obsNodes++;
      } else col.provenance([o.id]);
    }
    const n = nodes.get(pid);
    return {
      id: pid, name: n?.name ?? pid, url: details.get(pid)?.url ?? null, score, problems,
      ...(pg.fails.length > problems.length ? { problemsTotal: pg.fails.length } : {}), ...(lowCtr ? { lowCtr: true } : {}), metrics, queries,
    };
  });

  const rule = (id: string): Brief => {
    const n = nodes.get(id);
    return n ? brief(n) : { id, type: "Rule", name: id };
  };
  const summary = {
    pages: pages.size, pagesWithIssues: scored.filter((s) => s.score > 0).length, failsBySeverity: bySeverity,
    topRules: topRules.map(([id, n]) => ({ ...rule(id), pages: n })),
    lowCtrPages: scored.filter((s) => s.lowCtr).length,
  };
  for (const [id] of topRules) col.node(nodes.get(id));
  const simulated = obs.rows.some((o) => o.sim === true);
  const notes = [
    ...(simulated ? ["Includes simulated data."] : []),
    ...(pages.size ? [] : ["No pages with failed checks or Search Console/GA4 numbers yet."]),
    ...(fails.total > fails.rows.length || obs.total > obs.rows.length ? ["The site is larger than one report reads; the summary covers the first 50,000 pages."] : []),
  ];
  return col.result(ctx, { summary, pages: out, ...(simulated ? { simulated: true } : {}) }, notes.join(" ") || undefined);
}

export const seoReport = defineTool({
  name: "seo_report",
  description:
    "Website/SEO problems worst first: pages with the rules they fail (severity, evidence, how to fix), their latest Search Console and GA4 numbers (clicks, impressions, CTR %, position, sessions), low-CTR flags and the queries they rank for; plus a summary by severity and rule. Example: {\"limit\":5}",
  input: { limit: z.number().int().optional().describe("Pages to return, default 10, max 25") },
  run: runSeo,
});
