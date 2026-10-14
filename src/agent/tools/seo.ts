// seo_report: website problems, worst first. Pages with the SEO rules they FAIL (severity, evidence, how to fix),
// their latest Search Console / GA4 numbers (clicks, impressions, CTR, position, sessions) and the queries they rank
// for. A page's problem score is its failed-rule severity (plus low CTR: >= 100 impressions under 1%) scaled by
// log impressions, so a broken page people actually see comes first.
import { z } from "zod";
import type { ToolContext } from "../tool.js";
import {
  Collector, EDGE, NODE, brief, clamp, clip, defineTool, ro, round, type Brief, type EdgeRow, type NodeRow,
} from "./common.js";
import { ALIASES, pick, type ObsRow } from "./observations.js";

const SEVERITY: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0.5 };
const severityWeight = (s: unknown): number => (typeof s === "number" ? s : SEVERITY[String(s ?? "").toLowerCase()] ?? 1);

interface FailRow { p: NodeRow; r: NodeRow; e: EdgeRow; severity: string | number | null; evidence: string | null; howToFix: string | null }
interface PageObs extends Omit<ObsRow, "s"> { p: NodeRow }
interface Page { node: NodeRow; fails: FailRow[]; obs: Map<string, PageObs>; queries: Array<{ q: NodeRow; e: EdgeRow; position: number | null; text: string | null }> }

async function runSeo(args: { limit?: number }, ctx: ToolContext) {
  const limit = clamp(args.limit, 10, 1, 25);
  const [fails, obs, ranks] = await Promise.all([
    ro<FailRow>(ctx,
      `MATCH (p:Page)-[f:FAILS]->(r:Entity) WHERE f.until IS NULL
       RETURN ${NODE("p")} AS p, ${NODE("r")} AS r, ${EDGE("f")} AS e, r.severity AS severity, f.evidence AS evidence, r.howToFix AS howToFix LIMIT 2000`),
    ro<PageObs>(ctx,
      `MATCH (o:Observation)-[r:MEASURES]->(p:Page) WITH p, o, r, coalesce(o.windowEnd, o.asOf) AS at
       RETURN ${NODE("p")} AS p, ${NODE("o")} AS o, ${EDGE("r")} AS e, o.metric AS metric, o.value AS value, o.unit AS unit,
         o.windowStart AS ws, o.windowEnd AS we, at ORDER BY at DESC, o.id LIMIT 5000`),
    ro<{ pid: string; q: NodeRow; e: EdgeRow; position: number | null; text: string | null }>(ctx,
      `MATCH (p:Page)-[rk:RANKS_FOR]->(q:Entity) WHERE rk.until IS NULL
       RETURN p.id AS pid, ${NODE("q")} AS q, ${EDGE("rk")} AS e, rk.position AS position, coalesce(q.text, q.name) AS text LIMIT 2000`),
  ]);
  const urls = new Map<string, string | null>();
  const pages = new Map<string, Page>();
  const page = (n: NodeRow) => {
    const pg: Page = pages.get(n.id) ?? { node: n, fails: [], obs: new Map(), queries: [] };
    pages.set(n.id, pg);
    return pg;
  };
  for (const f of fails) page(f.p).fails.push(f);
  for (const o of obs) {
    const pg = page(o.p);
    if (!pg.obs.has(o.metric.toLowerCase())) pg.obs.set(o.metric.toLowerCase(), o);
  }
  for (const r of ranks) pages.get(r.pid)?.queries.push(r);
  if (pages.size) {
    for (const r of await ro<{ id: string; url: string | null }>(ctx, "UNWIND $ids AS id MATCH (p:Entity {id:id}) RETURN p.id AS id, p.url AS url", { ids: [...pages.keys()] })) urls.set(r.id, r.url);
  }

  const scored = [...pages.values()].map((pg) => {
    const val = (aliases: readonly string[]) => pick(pg.obs, aliases)?.value ?? null;
    const clicks = val(ALIASES.clicks);
    const impressions = val(ALIASES.impressions);
    const rawCtr = val(ALIASES.ctr);
    const ctrPct = rawCtr !== null ? round(rawCtr <= 1 ? rawCtr * 100 : rawCtr, 2)
      : clicks !== null && impressions ? round((clicks / impressions) * 100, 2) : null;
    const lowCtr = impressions !== null && impressions >= 100 && ctrPct !== null && ctrPct < 1;
    const severity = pg.fails.reduce((s, f) => s + severityWeight(f.severity), 0) + (lowCtr ? 2 : 0);
    const score = round(severity * (1 + Math.log10(1 + (impressions ?? 0))), 2);
    const metrics = Object.fromEntries(Object.entries({ clicks, impressions, ctrPct, position: val(ALIASES.position), sessions: val(ALIASES.sessions) })
      .filter(([, v]) => v !== null));
    return { pg, score, lowCtr, metrics, impressions: impressions ?? 0 };
  }).sort((a, b) => b.score - a.score || b.impressions - a.impressions || a.pg.node.id.localeCompare(b.pg.node.id));

  const col = new Collector();
  const out = scored.slice(0, limit).map(({ pg, score, lowCtr, metrics }) => {
    col.node(pg.node);
    const problems = pg.fails.sort((a, b) => severityWeight(b.severity) - severityWeight(a.severity)).map((f) => {
      col.node(f.r);
      col.edge(f.e);
      return {
        ...brief(f.r), severity: f.severity ?? null, ...(f.evidence ? { evidence: clip(f.evidence, 200) } : {}),
        ...(f.howToFix ? { howToFix: clip(f.howToFix, 300) } : {}),
      };
    });
    for (const o of pg.obs.values()) {
      col.node(o.o);
      col.edge(o.e);
    }
    const queries = pg.queries.slice(0, 5).map((q) => {
      col.node(q.q);
      col.edge(q.e);
      return { id: q.q.id, text: q.text ?? q.q.name, ...(q.position !== null ? { position: q.position } : {}) };
    });
    return {
      id: pg.node.id, name: pg.node.name, url: urls.get(pg.node.id) ?? null, score, problems, ...(lowCtr ? { lowCtr: true } : {}),
      metrics, queries,
    };
  });

  const bySeverity: Record<string, number> = {};
  const byRule = new Map<string, { rule: Brief; pages: number }>();
  for (const f of fails) {
    const s = String(f.severity ?? "unrated");
    bySeverity[s] = (bySeverity[s] ?? 0) + 1;
    const r = byRule.get(f.r.id) ?? { rule: brief(f.r), pages: 0 };
    r.pages++;
    byRule.set(f.r.id, r);
  }
  const summary = {
    pages: pages.size, pagesWithIssues: scored.filter((s) => s.score > 0).length, failsBySeverity: bySeverity,
    topRules: [...byRule.values()].sort((a, b) => b.pages - a.pages).slice(0, 5).map((r) => ({ ...r.rule, pages: r.pages })),
    lowCtrPages: scored.filter((s) => s.lowCtr).length,
  };
  const simulated = obs.some((o) => o.o.simulated === true);
  const notes = [
    ...(simulated ? ["Includes simulated data."] : []),
    ...(pages.size ? [] : ["No pages with failed checks or Search Console/GA4 numbers yet."]),
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
