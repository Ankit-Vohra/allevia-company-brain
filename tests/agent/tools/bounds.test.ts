// A tenant past FalkorDB's RESULTSET_SIZE: the server sends at most 10,000 rows and drops the rest silently, so any
// tool read that can produce more must aggregate on the server, page, or LIMIT in a way that keeps the answer right.
// Every bulk structure below is built so that a read cut at 10,000 rows (or at a smaller LIMIT) gives a wrong answer.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { GraphHandle } from "../../../src/graph/client.js";
import type { AlleviaTool } from "../../../src/agent/tool.js";
import { sourcesFor } from "../../../src/agent/tools/common.js";
import { getEntity, history, neighbors } from "../../../src/agent/tools/entity.js";
import { impactOf } from "../../../src/agent/tools/impact.js";
import { whoKnows, whoOwns } from "../../../src/agent/tools/people.js";
import { metricTrend } from "../../../src/agent/tools/metrics.js";
import { seoReport } from "../../../src/agent/tools/seo.js";
import { adReport } from "../../../src/agent/tools/ads.js";
import { contentPerformance } from "../../../src/agent/tools/content.js";
import { topics } from "../../../src/agent/tools/ranking.js";
import { traceDecision } from "../../../src/agent/tools/decisions.js";
import { recall } from "../../../src/agent/tools/memory.js";
import { playbook } from "../../../src/agent/tools/playbook.js";
import { search } from "../../../src/agent/tools/search.js";
import { call, ids, makeCtx, seededGraph, whenFree } from "../../helpers/tools.js";

const DOCS = 12_000;
const day = (base: string, i: number) => new Date(Date.parse(`${base}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);

describe("tools on a tenant bigger than one result set", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  let seoBase: { pages: number; pagesWithIssues: number };

  beforeAll(async () => {
    ({ g, cleanup } = await seededGraph());
    seoBase = (await call(seoReport, {}, makeCtx(g))).data.summary;
    const q = (cypher: string, params?: Record<string, unknown>) => whenFree(() => g.query(cypher, params));

    // 12,000 documents: 30 hubs SOURCED_FROM 400 each; all AUTHORED by one writer, MENTIONING one topic and DEPENDING_ON
    // one core (the alphabetically first dependent is created last); two stored communities of 6,000. Then a node whose
    // only source is its `src` prop, and Priya's 3 documents on the topic.
    await q(`CREATE (:Entity:Person {id:'person:bulk-writer', name:'Bulk writer'}), (:Entity:Product {id:'product:bulk-topic', name:'Bulk topic'}),
      (:Entity:System {id:'system:bulk-core', name:'Core'})`);
    await q(`UNWIND range(0, 29) AS h CREATE (:Entity:System {id:'system:bulk-hub-' + toString(h), name:'Hub ' + toString(h)})`);
    await q(`MATCH (w:Entity {id:'person:bulk-writer'}), (t:Entity {id:'product:bulk-topic'}), (c:Entity {id:'system:bulk-core'})
      UNWIND range(1, $n) AS i
      CREATE (d:Entity:Document {id:'document:bulk-' + toString(i), name:'Bulk doc ' + toString(i), community: 'bulk-' + toString(i % 2)})
      CREATE (w)-[:AUTHORED]->(d), (d)-[:MENTIONS]->(t), (d)-[:DEPENDS_ON]->(c)`, { n: DOCS });
    await q("MATCH (c:Entity {id:'system:bulk-core'}) CREATE (:Entity:System {id:'system:bulk-aaa', name:'AAA first'})-[:DEPENDS_ON]->(c)");
    await q(`UNWIND range(1, $n) AS i MATCH (d:Entity {id:'document:bulk-' + toString(i)}), (h:Entity {id:'system:bulk-hub-' + toString(i % 30)})
      CREATE (h)-[:SOURCED_FROM]->(d)`, { n: DOCS });
    await q("CREATE (:Entity:Task {id:'task:bulk-src', name:'Sourced by prop', src:'document:runbook'})");
    await q(`MATCH (p:Entity {id:'person:priya'}), (t:Entity {id:'product:bulk-topic'}) UNWIND range(1, 3) AS i
      CREATE (d:Entity:Document {id:'document:priya-' + toString(i), name:'Priya on the topic ' + toString(i)}), (p)-[:AUTHORED]->(d), (d)-[:MENTIONS]->(t)`);

    // A 2,500-day series, and a second subject whose numbers are the latest and biggest.
    await q("CREATE (:Entity:Channel {id:'channel:bulk-series', name:'Series'}), (:Entity:Channel {id:'channel:bulk-series-2', name:'Series 2'})");
    const series = Array.from({ length: 2500 }, (_, i) => ({ id: `obs:bulk_visits:channel:bulk-series:${day("2019-08-01", i)}`, at: day("2019-08-01", i), v: i }));
    await q(`MATCH (s:Entity {id:'channel:bulk-series'}) UNWIND $rows AS r
      CREATE (:Entity:Observation {id: r.id, name: r.id, metric:'bulk_visits', metricKey:'bulk_visits', subject:'channel:bulk-series', value: r.v, windowStart: r.at, windowEnd: r.at, asOf: r.at})-[:MEASURES]->(s)`, { rows: series });
    const series2 = Array.from({ length: 10 }, (_, i) => ({ id: `obs:bulk_visits:channel:bulk-series-2:${day("2026-10-01", i)}`, at: day("2026-10-01", i), v: 1e6 + i }));
    await q(`MATCH (s:Entity {id:'channel:bulk-series-2'}) UNWIND $rows AS r
      CREATE (:Entity:Observation {id: r.id, name: r.id, metric:'bulk_visits', metricKey:'bulk_visits', subject:'channel:bulk-series-2', value: r.v, windowStart: r.at, windowEnd: r.at, asOf: r.at})-[:MEASURES]->(s)`, { rows: series2 });

    // 3,000 pages failing one medium rule, then the worst page (two rules, 50,000 impressions), created last.
    await q(`MATCH (r:Entity {id:'rule:seo-h1'}) UNWIND range(1, 3000) AS i
      CREATE (:Entity:Page {id:'page:bulk.example/p' + toString(i), name:'P' + toString(i)})-[:FAILS {evidence:'no H1'}]->(r)`);
    await q(`MATCH (h:Entity {id:'rule:seo-h1'}), (m:Entity {id:'rule:seo-meta-description'})
      CREATE (p:Entity:Page {id:'page:bulk.example/worst', name:'Worst'}), (p)-[:FAILS]->(h), (p)-[:FAILS]->(m),
        (:Entity:Observation {id:'obs:impressions:page:bulk.example/worst:2026-10-09', name:'imp', metric:'impressions', metricKey:'impressions', subject:'page:bulk.example/worst', value: 50000,
          windowStart:'2026-09-12', windowEnd:'2026-10-09', asOf:'2026-10-10'})-[:MEASURES]->(p)`);

    // 40 campaigns x 30 days x 5 metrics = 6,000 observations inside ad_report's 30-day window.
    await q(`UNWIND range(1, 40) AS c CREATE (:Entity:Campaign {id:'campaign:bulk-' + toString(c), name:'Bulk campaign ' + toString(c)})`);
    const adDays = Array.from({ length: 30 }, (_, i) => day("2026-09-16", i));
    await q(`UNWIND range(1, 40) AS c MATCH (k:Entity {id:'campaign:bulk-' + toString(c)}) UNWIND $days AS d
      UNWIND [['spend', 10, 'INR'], ['signups', 1, 'count'], ['conversions', 1, 'count'], ['impressions', 100, 'count'], ['clicks', 5, 'count']] AS m
      CREATE (:Entity:Observation {id:'obs:' + m[0] + ':' + k.id + ':' + d, name: m[0], metric: m[0], metricKey: m[0], subject: k.id, value: m[1], unit: m[2], windowStart: d, windowEnd: d, asOf: d})-[:MEASURES]->(k)`,
      { days: adDays });

    // 600 reels on one hook (content_performance considers the newest 500), 10 daily view numbers each.
    await q(`CREATE (:Entity:Rule {id:'rule:bulk-hook', name:'Bulk hook', kind:'hook'})`);
    const reels = Array.from({ length: 600 }, (_, i) => ({ id: `content:bulk-${i + 1}`, at: day("2023-01-01", i + 1) }));
    await q(`MATCH (h:Entity {id:'rule:bulk-hook'}) UNWIND $rows AS r
      CREATE (:Entity:Content {id: r.id, name: 'Bulk reel ' + r.id, format:'reel', publishedAt: r.at})-[:USES_RULE]->(h)`, { rows: reels });
    const contentObs = reels.flatMap((r, i) => Array.from({ length: 10 }, (_, k) => ({ c: r.id, at: day("2023-01-01", i + 1 + k), v: 100 + k })));
    await q(`UNWIND $rows AS r MATCH (c:Entity {id: r.c})
      CREATE (:Entity:Observation {id:'obs:views:' + r.c + ':' + r.at, name:'views', metric:'views', metricKey:'views', subject: r.c, value: r.v, windowEnd: r.at, asOf: r.at})-[:MEASURES]->(c)`,
      { rows: contentObs });

    // A decision based on 300 documents and affecting 200 others; a task with 120 versions.
    await q(`CREATE (:Entity:Decision {id:'decision:bulk', name:'Bulk decision', status:'accepted'})`);
    await q(`MATCH (x:Entity {id:'decision:bulk'}) UNWIND range(1, 300) AS i MATCH (d:Entity {id:'document:bulk-' + toString(i)}) CREATE (x)-[:BASED_ON]->(d)`);
    await q(`MATCH (x:Entity {id:'decision:bulk'}) UNWIND range(301, 500) AS i MATCH (s:Entity {id:'document:bulk-' + toString(i)}) CREATE (x)-[:AFFECTS]->(s)`);
    await q(`CREATE (t:Entity:Task {id:'task:bulk-versions', name:'Versioned', status:'s120', createdAt: 0})
      WITH t UNWIND range(0, 119) AS i
      CREATE (t)-[:HAD_VERSION]->(:Entity:Version {id:'version:task:bulk-versions:' + toString(i), since: i * 1000, until: (i + 1) * 1000,
        changed: ['status'], props: '{"status":"s' + toString(i) + '"}'})`);
    // A task whose 60 versions each changed a 3,000-character summary.
    await q(`CREATE (t:Entity:Task {id:'task:bulk-long', name:'Long', summary: 'now', createdAt: 0}) WITH t UNWIND range(0, 59) AS i
      CREATE (t)-[:HAD_VERSION]->(:Entity:Version {id:'version:task:bulk-long:' + toString(i), since: i * 1000, until: (i + 1) * 1000,
        changed: ['summary'], props: '{"summary":"' + reduce(s = '', k IN range(1, 300) | s + 'ten chars ') + '"}'})`);

    // Seven past turns on the topic (recall shows the latest 5); three decisions affect hub 0, the newest with the last id.
    await q(`MATCH (t:Entity {id:'product:bulk-topic'}) UNWIND range(1, 7) AS i
      CREATE (:Entity:Turn {id:'turn:bulk-' + toString(i), name:'Q' + toString(i), question:'Q' + toString(i), at: i * 1000})-[:TOUCHED]->(t)`);
    await q(`MATCH (h:Entity {id:'system:bulk-hub-0'}) UNWIND [['a', '2026-01-01'], ['b', '2026-02-01'], ['c', '2026-03-01']] AS d
      CREATE (:Entity:Decision {id:'decision:bulk-' + d[0], name:'Decision ' + d[0], decidedAt: d[1]})-[:AFFECTS]->(h)`);
  }, 420_000); // 12,000 documents with the Entity.id constraint; ~160 s alone, longer while other suites share the server
  afterAll(async () => cleanup());

  it("recall and trace_decision pick the latest by date, not by storage order", async () => {
    const r = await call(recall, { ids: ["product:bulk-topic"] }, makeCtx(g));
    expect(ids(r.data.turns)).toEqual(["turn:bulk-7", "turn:bulk-6", "turn:bulk-5", "turn:bulk-4", "turn:bulk-3"]);
    const d = await call(traceDecision, { id: "system:bulk-hub-0" }, makeCtx(g));
    expect(d.data.decision.id).toBe("decision:bulk-c");
  });

  it("sources: every id gets its source even when other ids have thousands", async () => {
    const hubs = Array.from({ length: 30 }, (_, h) => `system:bulk-hub-${h}`);
    const sources = await sourcesFor(makeCtx(g), [...hubs, "task:bulk-src"]);
    expect(ids(sources)).toContain("document:runbook");
    expect(sources.length).toBeLessThanOrEqual(100);
  });

  it("who_knows ranks every author, however many documents another wrote", async () => {
    const r = await call(whoKnows, { id: "product:bulk-topic" }, makeCtx(g));
    expect(ids(r.data.people)).toEqual(["person:bulk-writer", "person:priya"]);
    expect(r.data.people[0]).toMatchObject({ documents: DOCS, score: 5 });
    expect(r.data.people[0].docs).toHaveLength(3);
    expect(r.nodes.length).toBeLessThan(20);
  });

  it("impact_of and neighbors see a hub's every dependent", async () => {
    const r = await call(impactOf, { id: "system:bulk-core", depth: 1 }, makeCtx(g));
    expect(r.data.impacted[0].items[0]).toMatchObject({ id: "system:bulk-aaa", name: "AAA first" });
    expect(r.note).toMatch(/Stopped at 60/);
    const n = await call(neighbors, { id: "system:bulk-core", rels: ["DEPENDS_ON"], direction: "in" }, makeCtx(g));
    expect(n.data.total).toBe(DOCS + 1);
    expect(n.data.neighbors[0]).toMatchObject({ id: "system:bulk-aaa", hop: 1 });
    expect(n.data.neighbors).toHaveLength(25);
  });

  it("metric_trend reads to the newest point, and summarises subjects by their latest numbers", async () => {
    const one = await call(metricTrend, { metric: "bulk_visits", subject: "channel:bulk-series" }, makeCtx(g));
    expect(one.data.stats.to).toBe(day("2019-08-01", 2499));
    expect(one.data.stats.last).toBe(2499);
    const all = await call(metricTrend, { metric: "bulk_visits" }, makeCtx(g));
    expect(ids(all.data.bySubject)).toEqual(["channel:bulk-series-2", "channel:bulk-series"]);
    expect(all.data.bySubject[1]).toMatchObject({ last: 2499, to: day("2019-08-01", 2499) });
  });

  it("seo_report counts every failing page and ranks the worst first", async () => {
    const r = await call(seoReport, { limit: 3 }, makeCtx(g));
    expect(r.data.summary.pages).toBe(seoBase.pages + 3001);
    expect(r.data.summary.pagesWithIssues).toBe(seoBase.pagesWithIssues + 3001);
    expect(r.data.pages[0].id).toBe("page:bulk.example/worst");
    expect(r.data.pages[0].metrics.impressions).toBe(50000);
    expect(r.data.pages).toHaveLength(3);
  });

  it("ad_report totals every observation in the window", async () => {
    const r = await call(adReport, {}, makeCtx(g));
    expect(r.data.totals).toMatchObject({ spend: 6500 + 40 * 30 * 10, signups: 60 + 40 * 30, currency: "INR" });
    expect(r.data.campaigns).toHaveLength(25);
    expect(r.note).toMatch(/25 biggest spenders of 43/);
  });

  it("content_performance considers the newest 500 items, each with its latest views", async () => {
    const r = await call(contentPerformance, { limit: 5 }, makeCtx(g));
    expect(r.data.considered).toBe(500);
    expect(r.note).toMatch(/newest 500 of 605/);
    expect(r.data.byHook.find((h: { id: string }) => h.id === "rule:bulk-hook")).toMatchObject({ items: 495, medianMultiple: 1 });
  });

  it("topics sizes stored communities in full", async () => {
    const r = await call(topics, { limit: 2 }, makeCtx(g));
    expect(r.data.method).toBe("stored");
    expect(r.data.topics.map((t: { size: number }) => t.size)).toEqual([6000, 6000]);
  });

  it("trace_decision lists a bounded share of a long evidence list and says how much there is", async () => {
    const r = await call(traceDecision, { id: "decision:bulk" }, makeCtx(g));
    expect(r.data.evidence.length).toBeLessThanOrEqual(25);
    expect(r.data.evidenceTotal).toBe(300);
    expect(r.data.affects.length).toBeLessThanOrEqual(25);
    expect(r.data.affectsTotal).toBe(200);
  });

  it("history shows the latest versions, each change with the right before and after", async () => {
    const r = await call(history, { id: "task:bulk-versions" }, makeCtx(g));
    expect(r.data.versions).toBe(120);
    const changes = r.data.events.filter((e: { event: string }) => e.event === "changed");
    expect(changes.at(-1)).toMatchObject({ before: { status: "s119" }, after: { status: "s120" } });
    expect(changes.at(-2)).toMatchObject({ before: { status: "s118" }, after: { status: "s119" } });
  });

  it("every result stays small: few nodes, a bounded JSON size", async () => {
    const calls: Array<[AlleviaTool, Record<string, unknown>]> = [
      [getEntity, { id: "product:bulk-topic" }], [getEntity, { id: "system:bulk-core" }], [neighbors, { id: "system:bulk-core", depth: 2, limit: 100 }],
      [neighbors, { id: "product:bulk-topic", depth: 2, limit: 100 }], [history, { id: "system:bulk-core" }], [history, { id: "task:bulk-long" }], [impactOf, { id: "system:bulk-core", depth: 4 }],
      [whoKnows, { id: "product:bulk-topic", limit: 25 }], [whoOwns, { id: "system:bulk-core" }], [metricTrend, { metric: "bulk_visits" }],
      [metricTrend, { metric: "bulk_visits", subject: "channel:bulk-series" }], [seoReport, { limit: 25 }], [adReport, {}], [contentPerformance, { limit: 25 }],
      [topics, { limit: 20 }], [traceDecision, { id: "decision:bulk" }], [recall, { ids: ["product:bulk-topic"] }], [playbook, { limit: 25 }],
      [search, { query: "bulk doc", limit: 25 }],
    ];
    for (const [tool, args] of calls) {
      const r = await call(tool, args, makeCtx(g));
      const label = `${tool.name} ${JSON.stringify(args)}`;
      expect(r.data.error, label).toBeUndefined();
      expect(r.nodes.length, label).toBeLessThanOrEqual(120);
      expect(r.sources.length, label).toBeLessThanOrEqual(120);
      expect(JSON.stringify(r).length, label).toBeLessThan(64_000);
    }
  }, 120_000);
});
