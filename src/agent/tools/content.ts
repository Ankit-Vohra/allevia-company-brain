// content_performance: which posts and reels outperformed, and with which hook. Each Content item's latest
// observations (views, reach, average watch, skip rate, shares, saves), its hook Rule (USES_RULE) and Audience
// (TARGETS); the outlier multiple is its views over the median views of the items considered. Also rolls up by hook,
// which is what a content brief needs ("curiosity-gap hooks run at 4x median").
import { z } from "zod";
import type { ToolContext } from "../tool.js";
import { isoDate } from "../../util/time.js";
import {
  Collector, EDGE, NODE, brief, clamp, clip, defineTool, median, ro, round, type Brief, type EdgeRow, type NodeRow,
} from "./common.js";
import { ALIASES, latestByMetric, latestFor, resolveChannel } from "./observations.js";

const CONTENT_CAP = 500;  // newest items considered
const LINKS_PER_ITEM = 6; // hook rules and audiences per item

interface ContentRow { c: NodeRow; format: string | null; publishedAt: string | null; hook: string | null }

async function runContent(args: { channel?: string; days?: number; limit?: number }, ctx: ToolContext) {
  const limit = clamp(args.limit, 10, 1, 25);
  const channel = args.channel?.trim() ? await resolveChannel(ctx, args.channel) : null;
  const days = args.days === undefined ? null : clamp(args.days, 30, 1, 3650);
  const cutoff = days === null ? null : isoDate(ctx.now - days * 86_400_000);
  const match = `MATCH (c:Content) ${channel ? "MATCH (c)-[pr:PUBLISHED_ON]->(:Entity {id:$ch}) WHERE pr.until IS NULL" : ""}
     WITH DISTINCT c WHERE $cutoff IS NULL OR c.publishedAt >= $cutoff`;
  const p = { ch: channel?.id ?? null, cutoff, cap: CONTENT_CAP };
  const [items, [count]] = await Promise.all([
    ro<ContentRow>(ctx, `${match}
     RETURN ${NODE("c")} AS c, c.format AS format, c.publishedAt AS publishedAt, coalesce(c.hook, c.caption) AS hook
     ORDER BY publishedAt DESC, c.id LIMIT $cap`, p),
    ro<{ n: number }>(ctx, `${match} RETURN count(c) AS n`, p),
  ]);
  const col = new Collector();
  if (channel) col.node(channel);
  if (!items.length) return col.result(ctx, { channel: channel?.id ?? null, days, items: [], byHook: [] }, "No content found for that filter.");

  const ids = items.map((i) => i.c.id);
  const [links, obs] = await Promise.all([
    ro<{ cid: string; ls: Array<{ x: NodeRow; e: EdgeRow }> }>(ctx,
      `UNWIND $ids AS cid MATCH (c:Entity {id:cid}) WITH cid, c MATCH (c)-[r:USES_RULE|TARGETS]->(x:Entity) WHERE r.until IS NULL
       WITH cid, r, x ORDER BY type(r) DESC, x.id WITH cid, collect({x: ${NODE("x")}, e: ${EDGE("r")}})[0..$per] AS ls RETURN cid, ls`,
      { ids, per: LINKS_PER_ITEM }),
    latestFor(ctx, ids),
  ]);
  const latest = latestByMetric(obs);
  const viewMetric = ALIASES.views.find((m) => [...latest.values()].some((byM) => byM.has(m))) ?? null;
  const viewsOf = (id: string) => (viewMetric ? latest.get(id)?.get(viewMetric)?.value ?? null : null);
  const med = median(ids.map(viewsOf).filter((v): v is number => v !== null));

  const rules = new Map(links.map((l) => [l.cid, l.ls]));
  const rows = items.map((it) => {
    const views = viewsOf(it.c.id);
    return { it, views, multiple: views !== null && med ? round(views / med, 2) : null, links: rules.get(it.c.id) ?? [] };
  }).sort((a, b) => (b.multiple ?? -1) - (a.multiple ?? -1) || String(b.it.publishedAt).localeCompare(String(a.it.publishedAt)));

  const out = rows.slice(0, limit).map((r) => {
    col.node(r.it.c);
    const hook = r.links.find((l) => l.e.type === "USES_RULE");
    const audiences = r.links.filter((l) => l.e.type === "TARGETS");
    for (const l of r.links) {
      col.node(l.x);
      col.edge(l.e);
    }
    const byMetric = latest.get(r.it.c.id);
    const view = viewMetric ? byMetric?.get(viewMetric) : undefined;
    if (view) {
      col.node(view.o);
      col.edge(view.e);
    }
    col.provenance([...(byMetric?.values() ?? [])].map((o) => o.o.id));
    const metrics = Object.fromEntries([...(byMetric?.entries() ?? [])].slice(0, 8).map(([m, o]) => [m, o.value]));
    return {
      ...brief(r.it.c), ...(r.it.format ? { format: r.it.format } : {}), ...(r.it.publishedAt ? { publishedAt: r.it.publishedAt } : {}),
      views: r.views, multiple: r.multiple, metrics,
      hook: hook ? brief(hook.x) : null, ...(r.it.hook ? { caption: clip(r.it.hook, 160) } : {}),
      audiences: audiences.map((a) => brief(a.x)),
    };
  });

  // Hooks across every item considered (not just the shown ones), by median multiple.
  const hooks = new Map<string, { rule: Brief; multiples: number[] }>();
  for (const r of rows) {
    for (const l of r.links) {
      if (l.e.type !== "USES_RULE" || r.multiple === null) continue;
      const h = hooks.get(l.x.id) ?? { rule: brief(l.x), multiples: [] };
      h.multiples.push(r.multiple);
      hooks.set(l.x.id, h);
    }
  }
  const byHook = [...hooks.values()].map((h) => ({ ...h.rule, items: h.multiples.length, medianMultiple: round(median(h.multiples)!, 2) }))
    .sort((a, b) => b.medianMultiple - a.medianMultiple || b.items - a.items).slice(0, 15);
  const simulated = obs.some((o) => o.o.simulated === true);
  const notes = [
    ...(simulated ? ["Includes simulated data."] : []),
    ...(viewMetric ? [] : ["No view observations found, so no outlier multiples."]),
    ...(rows.length > limit ? [`Showing the top ${limit} of ${rows.length} items.`] : []),
    ...((count?.n ?? 0) > rows.length ? [`Considered the newest ${rows.length} of ${count!.n} items; narrow with days or channel.`] : []),
  ];
  return col.result(ctx, {
    channel: channel?.id ?? null, days, viewMetric, medianViews: med, considered: rows.length, items: out, byHook,
    ...(simulated ? { simulated: true } : {}),
  }, notes.join(" ") || undefined);
}

export const contentPerformance = defineTool({
  name: "content_performance",
  description:
    "Which posts and reels did best and why: each item's latest views/reach/watch/skip/shares/saves, its hook rule and audience, and its outlier multiple (views ÷ median views), best first; plus hooks ranked by median multiple. Filter by channel and by days since publishing. Example: {\"channel\":\"instagram\",\"days\":60,\"limit\":5}",
  input: {
    channel: z.string().optional().describe("Channel id or name, e.g. instagram"),
    days: z.number().int().optional().describe("Only content published in the last N days"),
    limit: z.number().int().optional().describe("Default 10, max 25"),
  },
  run: runContent,
});

