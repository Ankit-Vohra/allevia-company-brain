// Every tool and the query modules behind the app (server reads, insights, memory, actions, capabilities, the librarian,
// the privacy scan) run over a graph built to break what sorts: 24 identical neighbours on every relationship the
// ontology allows, identical vectors, closed and live edges with the same dates, zero spend / impressions / clicks (so
// every ratio is 0 / 0), subjects with no numbers, hubs with nothing attached (tests/fixtures/degenerate-graph.ts).
// FalkorDB 6.0.2 panics, restarts and drops every unsaved write when it sorts tied rows or a NaN, so the one thing
// asserted everywhere is that the server is still there, and has the same graph, after each call.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { GraphHandle } from "../../src/graph/client.js";
import { closeAll } from "../../src/graph/client.js";
import { UnsafeQuery } from "../../src/graph/errors.js";
import { SEARCHABLE } from "../../src/graph/schema.js";
import { ALL_TOOLS } from "../../src/agent/tools/index.js";
import { ensureRoster, getSession, listSessions, recallBrief } from "../../src/agent/memory.js";
import { AGENTS } from "../../shared/roster.js";
import * as reads from "../../src/server/reads.js";
import { goalPulse, writeBrief } from "../../src/insights/brief.js";
import { insightRecId, writeRecommendation } from "../../src/insights/recommend.js";
import { runDetectors } from "../../src/insights/detectors.js";
import { deriveCapabilities } from "../../src/capabilities/ladder.js";
import { activeRules, learningMetrics } from "../../src/actions/learning.js";
import { getApproval, listApprovals } from "../../src/actions/approvals.js";
import { runLibrarian } from "../../src/ingest/librarian.js";
import { scanGraph } from "../../src/ingest/privacy.js";
import { listAgentsWithSettings, loadTeamSettings } from "../../src/settings/team.js";
import { fakeEmbed, SEED_NOW } from "../fixtures/seed-graph.js";
import { SWARM, SWARM_TYPES, hubId, satId, seedDegenerate } from "../fixtures/degenerate-graph.js";
import { call, makeCtx, whenFree } from "../helpers/tools.js";
import { testGraph } from "../helpers/graph.js";

// What a client sees when the server dies under a query, and what is left after it restarts empty.
const CRASHED = /socket closed|econnrefused|econnreset|server closed|connection.*closed|client is closed|empty key|reconnect|disconnected|panic/i;

describe("every tool and query over a graph of ties, zeros and gaps (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  let nodesBefore = 0;
  const crashes: string[] = [];
  const problems: string[] = [];

  const count = async (): Promise<number> => (await g.roQuery<{ c: number }>("MATCH (n) RETURN count(n) AS c"))[0]!.c;

  // Runs one call and records how it ended. Anything but a crash is reported separately, so one failure does not
  // hide the rest; after a crash the server has lost the graph and nothing further is meaningful, so the run stops.
  async function probe(name: string, fn: () => Promise<unknown>): Promise<void> {
    if (crashes.length) return;
    const t0 = Date.now();
    try {
      await fn();
      if (process.env.DEGENERATE_VERBOSE && Date.now() - t0 > 500) console.log(`[slow ${Date.now() - t0} ms] ${name}`);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      (CRASHED.test(msg) ? crashes : problems).push(`${name}: ${msg.slice(0, 200)}`);
    }
    if (!crashes.length) {
      try {
        await g.roQuery("RETURN 1 AS ok");
      } catch (e) {
        crashes.push(`${name}: server gone afterwards (${String((e as Error).message).slice(0, 100)})`);
      }
    }
  }

  const ctx = () => makeCtx(g);
  const tool = (name: string) => ALL_TOOLS.find((t) => t.name === name)!;
  const run = (name: string, args: Record<string, unknown>) => probe(`${name} ${JSON.stringify(args).slice(0, 90)}`, () => call(tool(name), args, ctx()));

  beforeAll(async () => {
    ({ g, cleanup } = await whenFree(async () => {
      const t = await testGraph();
      try {
        await seedDegenerate(t.g);
        await ensureRoster(t.g, {}, SEED_NOW);
      } catch (e) {
        await t.cleanup().catch(() => undefined);
        throw e;
      }
      return t;
    }));
    nodesBefore = await count();
  }, 240_000);
  afterAll(async () => {
    await cleanup?.();
    await closeAll();
  });

  it("is a graph that ties: 24 identical neighbours on a hub, in every direction, live and closed", async () => {
    const [r] = await g.roQuery<{ live: number; closed: number; names: number }>(
      `MATCH (h:Entity {id:$hub})-[r]-(m:Entity) WHERE type(r) = 'DEPENDS_ON'
       RETURN count(CASE WHEN r.until IS NULL THEN 1 END) AS live, count(CASE WHEN r.until IS NOT NULL THEN 1 END) AS closed, count(DISTINCT m.name) AS names`,
      { hub: hubId("System") });
    expect(r!.live).toBeGreaterThanOrEqual(SWARM);
    expect(r!.closed).toBeGreaterThanOrEqual(SWARM);
    expect(r!.names).toBeLessThanOrEqual(4); // "Swarm item 0..2" and "Swarm hub"
    for (const t of SWARM_TYPES) expect((await g.roQuery("MATCH (n:Entity {id:$id}) RETURN n.id AS id", { id: hubId(t) })), t).toHaveLength(1);
  });

  // The shapes that crash FalkorDB 6.0.2 (docs/notes/falkordb-nan-crash.md), each beside the form that sorts the same
  // rows and does not. On a throwaway 6.0.2 server the unsafe forms kill it over this very graph; here they are never
  // sent (GraphHandle refuses them), and the safe forms must run. This test never sends an unsafe one to the shared server.
  const NODE = "{id: n.id, labels: labels(n), name: n.name, asOf: n.asOf, simulated: n.simulated}";
  const SHAPES: Array<{ name: string; unsafe: string; safe: string }> = [
    {
      name: "a constant sort key over rows that differ in other columns",
      unsafe: `MATCH (n:Entity) WHERE NOT n:Chunk WITH n, 1.0 AS score RETURN ${NODE} AS n, n.summary AS summary, score ORDER BY score ASC`,
      safe: `MATCH (n:Entity) WHERE NOT n:Chunk WITH n, 1.0 AS score RETURN ${NODE} AS n, n.summary AS summary, score ORDER BY score ASC, n.id`,
    },
    {
      name: "a function of the row as the sort key",
      unsafe: `MATCH (n:Entity) WHERE NOT n:Chunk RETURN ${NODE} AS n, n.summary AS summary, size(labels(n)) AS nl ORDER BY nl ASC`,
      safe: `MATCH (n:Entity) WHERE NOT n:Chunk RETURN ${NODE} AS n, n.summary AS summary, size(labels(n)) AS nl ORDER BY nl ASC, n.id`,
    },
    {
      name: "vector scores that tie",
      unsafe: `CALL db.idx.vector.queryNodes('Entity', 'embedding', 50, vecf32($v)) YIELD node, score RETURN {id: node.id, labels: labels(node), name: node.name, asOf: node.asOf, simulated: node.simulated} AS n, node.summary AS summary, score ORDER BY score ASC`,
      safe: `CALL db.idx.vector.queryNodes('Entity', 'embedding', 50, vecf32($v)) YIELD node, score RETURN {id: node.id, labels: labels(node), name: node.name, asOf: node.asOf, simulated: node.simulated} AS n, node.summary AS summary, score ORDER BY score ASC, node.id`,
    },
    {
      name: "NaN (0 / 0) mixed with numbers in the sort key",
      unsafe: "UNWIND range(0, 49) AS i WITH {id: 'n' + toString(i)} AS n, toFloat(0) / toFloat(i % 5) AS g RETURN n.id AS id, g ORDER BY g ASC, id",
      safe: "UNWIND range(0, 49) AS i WITH {id: 'n' + toString(i)} AS n, CASE WHEN i % 5 = 0 THEN null ELSE toFloat(0) / toFloat(i % 5) END AS g RETURN n.id AS id, g ORDER BY g ASC, id",
    },
  ];

  it("refuses each known crash shape before it is sent, and runs its safe form over the swarm", async () => {
    const params = { v: fakeEmbed("swarm item") };
    for (const s of SHAPES) {
      await expect(g.roQuery(s.unsafe, params), s.name).rejects.toThrow(UnsafeQuery);
      const rows = await g.roQuery(s.safe, params);
      expect(rows.length, s.name).toBeGreaterThan(0);
      await probe(s.name, async () => undefined); // and the server is still up
    }
    expect(crashes).toEqual([]);
  });

  it("answers every tool about every hub, including hubs with nothing useful attached", async () => {
    for (const t of SWARM_TYPES) {
      const id = hubId(t);
      await run("get_entity", { id });
      await run("get_entity", { id, asOf: "2026-10-01" });
      await run("neighbors", { id });
      await run("neighbors", { id, direction: "in", limit: 25 });
      await run("history", { id });
      await run("who_owns", { id });
      await run("who_knows", { id });
      await run("impact_of", { id, depth: 1 });
      await run("trace_decision", { id });
      await run("recall", { ids: [id] });
    }
    expect(crashes).toEqual([]);
  }, 300_000);

  // Expanding two hops across thousands of edges, and searching paths, are slow by nature: on the types with the
  // most relationships only, and between hubs that are one edge apart (a far pair would just spend its time budget).
  it("expands and traces paths from the busiest hubs", async () => {
    for (const t of ["Task", "System", "Channel", "Decision", "Person", "Business"] as const) {
      const id = hubId(t);
      await run("neighbors", { id, direction: "in", depth: 2 });
      await run("neighbors", { id, direction: "out", depth: 2, limit: 25 });
      await run("impact_of", { id, depth: 2 });
    }
    for (const t of ["Task", "System", "Page"] as const) {
      await run("find_paths", { from: hubId(t), to: satId(t, 3), maxPaths: 5 });
      await run("show_path", { ids: [hubId(t), satId(t, 1)] });
    }
    expect(crashes).toEqual([]);
  }, 300_000);

  it("answers the questions that sweep the whole graph", async () => {
    for (const q of ["swarm item", "swarm", "instagram", "swarm hub fact"]) {
      await run("search", { query: q, limit: 25 });
      await run("search", { query: q });
      await run("recall", { query: q });
      await run("who_knows", { query: q });
      await run("who_owns", { query: q });
      await run("trace_decision", { query: q });
    }
    for (const t of SEARCHABLE) {
      await run("search", { query: "swarm item", types: [t], limit: 25 });
      await run("important", { label: t, limit: 25 });
    }
    await run("important", {});
    await run("topics", {});
    await run("topics", { limit: 20 });
    for (const metric of ["spend", "impressions", "clicks", "conversions", "signups", "views", "followers", "ctr"]) {
      await run("metric_trend", { metric });
      await run("metric_trend", { metric, groupBy: "week" });
      await run("metric_trend", { metric, subject: hubId("Campaign") });
      await run("metric_trend", { metric, subject: satId("Campaign", 2), from: "2026-10-09" });
      await run("metric_trend", { metric, subject: satId("Campaign", SWARM - 1) }); // a subject with no numbers
    }
    await run("content_performance", {});
    await run("content_performance", { channel: "instagram", days: 60 });
    await run("content_performance", { limit: 25 });
    await run("seo_report", {});
    await run("seo_report", { limit: 25 });
    await run("ad_report", {});
    await run("ad_report", { days: 3 });
    await run("playbook", {});
    await run("playbook", { topic: "swarm" });
    await run("playbook", { kind: "hook" });
    await run("playbook", { channel: "instagram" });
    expect(crashes).toEqual([]);
  }, 240_000);

  it("runs the cypher tool's escape hatch over tied rows, with a unique last key", async () => {
    for (const query of [
      "MATCH (n:Entity) WHERE n.name = 'Swarm item' RETURN n.id AS id, n.asOf AS asOf ORDER BY asOf DESC, id",
      "MATCH (n:Entity)-[r]->(m:Entity) RETURN n.id AS a, type(r) AS t, m.id AS b ORDER BY t, a, b LIMIT 300",
      "MATCH (n:Entity) RETURN n.asOf AS d, count(*) AS c ORDER BY c DESC, d",
      "MATCH (o:Observation) RETURN o.id AS id, o.value AS v ORDER BY v, id",
      "MATCH (o:Observation) RETURN o.metric AS m, sum(o.value) AS total ORDER BY total DESC, m",
      "MATCH (o:Observation) WITH o.metric AS m, CASE WHEN sum(o.value) = 0 THEN null ELSE count(o) / sum(o.value) END AS r RETURN m, r ORDER BY r, m",
    ]) await run("cypher", { query });
    expect(crashes).toEqual([]);
  });

  it("writes through the tools without hurting the server", async () => {
    await run("remember", { text: "Swarm note", kind: "fact", about: [hubId("Task"), hubId("Channel")] });
    await run("propose_action", {
      title: "Pause a swarm campaign", why: "Zero conversions.", kind: "pause_ad", payload: { title: "Pause" }, evidence: [satId("Campaign", 1), hubId("Campaign")], area: "ads", confidence: 0.5,
    });
    expect(crashes).toEqual([]);
  });

  it("answers every read the app makes", async () => {
    await probe("labelCounts", () => reads.labelCounts(g));
    await probe("freshness", () => reads.freshness(g, SEED_NOW));
    await probe("latestBrief", () => reads.latestBrief(g));
    await probe("sessions", () => reads.sessions(g, { showcaseOnly: false }));
    await probe("sessionDetail", () => reads.sessionDetail(g, hubId("Session"), { showcaseOnly: false })); // the hub has 24 turns
    await probe("turnEvents", () => reads.turnEvents(g, satId("Turn", 0), { showcaseOnly: false }));
    await probe("findShowcaseTurn", () => reads.findShowcaseTurn(g, { question: "Swarm question?" }));
    await probe("searchGraph", () => reads.searchGraph(g, "swarm", "swarm item", async (t) => fakeEmbed(t), SEED_NOW));
    await probe("overviewGraph", () => reads.overviewGraph(g));
    await probe("agentStats", () => reads.agentStats(g));
    await probe("agentSummaries", () => reads.agentSummaries(g));
    for (const a of AGENTS) await probe(`agentDetail ${a.id}`, () => reads.agentDetail(g, a.id));
    await probe("recommendations", () => reads.recommendations(g));
    await probe("approvals", () => reads.approvals(g));
    await probe("pendingApprovals", () => reads.pendingApprovals(g));
    for (const t of SWARM_TYPES) {
      await probe(`nodeDetail ${t}`, () => reads.nodeDetail(g, hubId(t)));
      await probe(`focusGraph ${t}`, () => reads.focusGraph(g, hubId(t), 2));
    }
    expect(crashes).toEqual([]);
  }, 240_000);

  it("runs the insight detectors, the goal pulse, the capability ladder, memory and approvals", async () => {
    await probe("runDetectors", async () => {
      const r = await runDetectors(g, { now: SEED_NOW });
      // A detector that throws is reported in `errors`: that is a failure here too (a NaN written, a bad division).
      expect(r.errors).toEqual([]);
    });
    await probe("goalPulse", () => goalPulse(g, SEED_NOW, hubId("Business")));
    await probe("deriveCapabilities", () => deriveCapabilities(g, { now: SEED_NOW }));
    await probe("activeRules", () => activeRules(g, {}));
    await probe("learningMetrics", () => learningMetrics(g, SEED_NOW));
    await probe("listApprovals", () => listApprovals(g, {}));
    await probe("getApproval", () => getApproval(g, satId("Approval", 0)));
    await probe("listSessions", () => listSessions(g));
    await probe("getSession", () => getSession(g, hubId("Session"))); // 24 turns, all at the same time
    await probe("recallBrief", () => recallBrief(g, { question: "swarm item", seedIds: [hubId("Task"), hubId("Channel"), satId("Decision", 1)], sessionId: satId("Session", 0) }));
    await probe("writeBrief", () => writeBrief("swarm", { graph: g, now: SEED_NOW, since: 0 })); // every observation has earlier ones to compare with
    await probe("writeRecommendation", async () => {
      // A recommendation with 24 approvals, all created at the same time: the sort that picks the newest of them ties.
      const t = SEED_NOW;
      const rid = insightRecId("swarm.recommendation");
      await g.query(
        `MERGE (r:Entity:Recommendation {id:$rid}) ON CREATE SET r.name = 'Swarm recommendation', r.status = 'open', r.createdAt = $t, r.updatedAt = $t, r.stateSince = $t, r.rev = 1`, { rid, t });
      await g.query(
        `MATCH (r:Entity:Recommendation {id:$rid}), (a:Entity:Approval) WHERE a.id STARTS WITH 'approval:swarm-' CREATE (r)-[:PROPOSES {since: $t, recordedAt: $t}]->(a)`, { rid, t });
      await writeRecommendation(g, {
        key: "swarm.recommendation", detector: "ads.high_cpa", area: "ads", agent: "growth-marketer", title: "Swarm", why: "Swarm.", evidence: [satId("Campaign", 1)],
        numbers: { spend: 0 }, score: 0.5, confidence: 0.5,
      }, { now: SEED_NOW });
    });
    await probe("listAgentsWithSettings", () => listAgentsWithSettings(g));
    await probe("loadTeamSettings", () => loadTeamSettings(g));
    expect(crashes).toEqual([]);
  }, 240_000);

  it("runs the librarian (PageRank, communities, KNOWS_ABOUT) and the privacy scan over it", async () => {
    await probe("runLibrarian", () => runLibrarian(g, { now: SEED_NOW }));
    await probe("scanGraph", () => scanGraph(g, { pageSize: 500 }));
    expect(crashes).toEqual([]);
  }, 240_000);

  it("never crashed the server, hit an unexpected error, or lost the graph", async () => {
    expect(crashes).toEqual([]);
    expect(problems).toEqual([]);
    expect(await count()).toBeGreaterThanOrEqual(nodesBefore); // the write tools add nodes; nothing was dropped
  });
});
