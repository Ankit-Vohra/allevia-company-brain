// Live smoke test of the agent company on the founder's subscription: ClaudeAgentSdkRuntime (haiku for every agent),
// two small read-only tools (search, metric_trend) plus show_path over a tiny throwaway graph, the real orchestrator,
// checks and memory. Prints the work log, then the event-type counts. Usage: npx tsx scripts/smoke/agent-company.ts
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { AgentEvent, NodeRef, ToolResult } from "../../shared/contracts.js";
import { closeAll, openGraphByName, type GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { addObservation, writeBatch } from "../../src/graph/upsert.js";
import { SEARCHABLE, typeOfLabels } from "../../src/graph/schema.js";
import { ask } from "../../src/agent/ask.js";
import { ClaudeAgentSdkRuntime } from "../../src/agent/runtime.js";
import type { AlleviaTool } from "../../src/agent/tool.js";
import { workLog } from "../../src/cli/_worklog.js";

const NOW = Date.parse("2026-10-15T06:00:00Z");

async function seed(g: GraphHandle): Promise<void> {
  await ensureIndexes(g);
  const s = await writeBatch(g, {
    nodes: [
      { type: "Business", id: "business:smoke", name: "Aamdani (smoke)" },
      { type: "Metric", id: "metric:signups", name: "Weekly employer signups", summary: "Employers who completed signup per week (GA4)." },
      { type: "Decision", id: "decision:pause-daily-stories", name: "Pause daily Instagram stories", summary: "Paused daily stories on 2026-10-06 to put the time into reels.", asOf: "2026-10-06" },
      { type: "Event", id: "event:sitemap-404", name: "Sitemap started returning 404", summary: "sitemap.xml returned 404 from 2026-10-07 after the site deploy.", asOf: "2026-10-07" },
      { type: "Document", id: "document:ga4-export", name: "GA4 weekly export", asOf: "2026-10-13" },
    ],
    edges: [
      { from: "decision:pause-daily-stories", type: "AFFECTS", to: "metric:signups" },
      { from: "event:sitemap-404", type: "AFFECTS", to: "metric:signups" },
    ],
  }, NOW);
  if (s.errors.length) throw new Error(JSON.stringify(s.errors));
  for (const [end, value] of [["2026-09-28", 61], ["2026-10-05", 58], ["2026-10-12", 41]] as const) {
    await addObservation(g, { subject: "metric:signups", metric: "signups", value, windowEnd: end, asOf: "2026-10-13", src: "document:ga4-export" }, NOW);
  }
}

type Row = { id: string; labels: string[]; name: string; summary: string | null; asOf: string | null };
const ref = (r: Row): NodeRef => ({ id: r.id, label: typeOfLabels(r.labels) ?? "Entity", name: r.name, ...(r.asOf ? { asOf: r.asOf } : {}) });

function tools(): AlleviaTool[] {
  const search: AlleviaTool = {
    name: "search", description: "Find entities (metrics, decisions, events, pages…) by words in their name or summary.",
    input: { query: z.string().describe("words to look for") },
    async run(args, ctx): Promise<ToolResult> {
      const words = String(args.query).toLowerCase().split(/\W+/).filter((w) => w.length > 3);
      const rows = await ctx.graph.roQuery<Row>(
        `MATCH (n:Entity) WHERE any(l IN labels(n) WHERE l IN $types) AND any(w IN $w WHERE toLower(n.name) CONTAINS w OR toLower(coalesce(n.summary, '')) CONTAINS w)
         RETURN n.id AS id, labels(n) AS labels, n.name AS name, n.summary AS summary, n.asOf AS asOf LIMIT 8`, { w: words, types: SEARCHABLE });
      return { data: rows.map((r) => ({ id: r.id, name: r.name, summary: r.summary, asOf: r.asOf })), nodes: rows.map(ref), edges: [], sources: [] };
    },
  };
  const metricTrend: AlleviaTool = {
    name: "metric_trend", description: "Weekly values of a metric (e.g. signups) with week-on-week deltas.",
    input: { metric: z.string().describe("metric name, e.g. signups") },
    async run(args, ctx): Promise<ToolResult> {
      const rows = await ctx.graph.roQuery<{ id: string; value: number; week: string; asOf: string }>(
        "MATCH (o:Observation)-[:MEASURES]->(m:Metric) WHERE o.metric = $m RETURN o.id AS id, o.value AS value, o.windowEnd AS week, o.asOf AS asOf ORDER BY week, id",
        { m: String(args.metric).toLowerCase() });
      const points = rows.map((r, i) => ({ week: r.week, value: r.value, delta: i ? r.value - rows[i - 1]!.value : null }));
      return {
        data: { metric: args.metric, points },
        nodes: [{ id: "metric:signups", label: "Metric", name: "Weekly employer signups" }, ...rows.map((r) => ({ id: r.id, label: "Observation", name: `signups week to ${r.week}`, asOf: r.asOf }))],
        edges: rows.map((r) => ({ from: r.id, type: "MEASURES", to: "metric:signups" })),
        sources: [{ id: "document:ga4-export", title: "GA4 weekly export", asOf: "2026-10-13" }],
      };
    },
  };
  const showPath: AlleviaTool = {
    name: "show_path", description: "Final step: pass the ordered node ids that explain the answer; returns the path for the owner's graph view.",
    input: { ids: z.array(z.string()).describe("ordered node ids, cause to effect") },
    async run(args, ctx): Promise<ToolResult> {
      const ids = args.ids as string[];
      const rows = await ctx.graph.roQuery<Row>("UNWIND $ids AS id MATCH (n:Entity {id:id}) RETURN n.id AS id, labels(n) AS labels, n.name AS name, n.summary AS summary, n.asOf AS asOf", { ids });
      const nodes = ids.map((id) => rows.find((r) => r.id === id)).filter((r): r is Row => !!r).map(ref);
      return { data: { found: nodes.map((n) => n.id), missing: ids.filter((id) => !nodes.some((n) => n.id === id)) }, nodes, edges: [], sources: [] };
    },
  };
  return [search, metricTrend, showPath];
}

async function main(): Promise<void> {
  const g = await openGraphByName(`allevia_smoke_${randomBytes(4).toString("hex")}`);
  try {
    await seed(g);
    const all = tools();
    const counts: Record<string, number> = {};
    const print = workLog();
    const emit = (e: AgentEvent) => { counts[e.type] = (counts[e.type] ?? 0) + 1; print(e); };
    const t0 = Date.now();
    const r = await ask(
      { tenant: "smoke", question: process.argv[2] ?? "Why did employer signups drop last week?", channel: "cli" },
      {
        runtime: new ClaudeAgentSdkRuntime(), graph: g, model: "haiku", now: () => NOW,
        getTools: (names) => all.filter((t) => names.includes(t.name)),
        seedSearch: async () => ["metric:signups"],
      },
      emit);
    console.log(`\n--- smoke: ok=${r.ok} in ${((Date.now() - t0) / 1000).toFixed(1)}s, agents ${r.agents.join(", ")}`);
    console.log("event types:", JSON.stringify(counts));
    console.log("tool calls by agent:", JSON.stringify(r.outcome?.findings.map((f) => f.agent)), "plan:", JSON.stringify(r.outcome?.plan.steps));
    const [turn] = await g.roQuery<{ status: string; n: number }>("MATCH (t:Turn {id:$id}) OPTIONAL MATCH (t)-[r]->() RETURN t.status AS status, count(r) AS n", { id: r.turnId });
    console.log("persisted turn:", JSON.stringify(turn));
  } finally {
    await g.drop();
    await closeAll();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
