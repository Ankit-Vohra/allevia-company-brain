// db:health's parts (src/graph/health.ts): the size budget, the slow log and its plans, persistence read from INFO, and on
// a small graph the best-linked nodes (a supernode flagged) and the indexes the schema wants. All read-only.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { closeAll, connect, type GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes, wantedIndexes } from "../../src/graph/indexes.js";
import { upsertEdge, upsertNode } from "../../src/graph/upsert.js";
import {
  assessBudget, brainBudget, BRAIN_BUDGET, graphCounts, graphMemoryMb, isSupernode, missingIndexes, parseSlowlog, persistence, planScans,
  slowQueries, topHubs,
} from "../../src/graph/health.js";
import { testGraph } from "../helpers/graph.js";

describe("size budget", () => {
  it("warns from 80 percent and is over from 100; an unknown size says so", () => {
    const b = { nodes: 100, edges: 100, mb: 10 };
    expect(assessBudget({ nodes: 79, edges: 80, mb: null }, b).map((x) => x.level)).toEqual(["ok", "warning", "unknown"]);
    expect(assessBudget({ nodes: 100, edges: 0, mb: 12 }, b).map((x) => x.level)).toEqual(["over", "ok", "over"]);
  });

  it("takes each part from the environment, and refuses nonsense", () => {
    expect(brainBudget({})).toEqual(BRAIN_BUDGET);
    expect(brainBudget({ ALLEVIA_BRAIN_BUDGET_NODES: "500", ALLEVIA_BRAIN_BUDGET_MB: "" })).toEqual({ ...BRAIN_BUDGET, nodes: 500 });
    expect(() => brainBudget({ ALLEVIA_BRAIN_BUDGET_EDGES: "lots" })).toThrow(/ALLEVIA_BRAIN_BUDGET_EDGES/);
  });
});

describe("slow log", () => {
  it("reads GRAPH.SLOWLOG's entries, slowest first, without their params", () => {
    const e = parseSlowlog([
      ["1792232368", "GRAPH.QUERY", "CREATE INDEX FOR (n:Entity) ON (n.id)", "12.5"],
      ["1792239718", "GRAPH.RO_QUERY", "MATCH (n:Entity {id:$id}) RETURN n", "1890.7", "CYPHER id=\"person:ada@example.com\""],
      "junk",
    ]);
    expect(e).toEqual([
      { at: 1792239718000, command: "GRAPH.RO_QUERY", query: "MATCH (n:Entity {id:$id}) RETURN n", ms: 1890.7 },
      { at: 1792232368000, command: "GRAPH.QUERY", query: "CREATE INDEX FOR (n:Entity) ON (n.id)", ms: 12.5 },
    ]);
    expect(JSON.stringify(e)).not.toMatch(/example\.com/);
  });

  it("names the operators that scan a label or every node", () => {
    expect(planScans(["Results", "    Project", "        Node By Label Scan | (n:Entity)"])).toEqual(["Node By Label Scan | (n:Entity)"]);
    expect(planScans(["Results", "    All Node Scan | (n)"])).toEqual(["All Node Scan | (n)"]);
    expect(planScans(["Results", "    Node By Index Scan | (n:Entity)"])).toEqual([]);
  });
});

describe("persistence", () => {
  const NOW = 1_792_300_000_000;
  const info = (o: Record<string, string | number>) => Object.entries(o).map(([k, v]) => `${k}:${v}`).join("\r\n");
  it("is quiet when the append log is on and compacted and the last snapshot is recent and ok", () => {
    const p = persistence(info({ aof_enabled: 1, aof_current_size: 30 * 1048576, aof_base_size: 20 * 1048576, rdb_last_bgsave_status: "ok", rdb_last_save_time: NOW / 1000 - 600, rdb_changes_since_last_save: 3 }), NOW);
    expect(p.warnings).toEqual([]);
    expect(p).toMatchObject({ aof: true, rdbOk: true, unsaved: 3 });
  });

  it("warns about an append log that was never compacted, a failed or stale snapshot, and no append log", () => {
    const p = persistence(info({ aof_enabled: 1, aof_current_size: 26 * 1048576, aof_base_size: 119, rdb_last_bgsave_status: "err", rdb_last_save_time: NOW / 1000 - 2 * 86400 }), NOW);
    expect(p.warnings.join(" | ")).toMatch(/snapshot failed.* \| .*replays every write.*BGREWRITEAOF.* \| no snapshot in over a day/);
    expect(persistence(info({ aof_enabled: 0, rdb_last_bgsave_status: "ok", rdb_last_save_time: NOW / 1000 }), NOW).warnings).toEqual([
      "no append log: a crash loses every write since the last snapshot",
    ]);
  });
});

describe("graph health (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  const AS = { src: "document:seed", asOf: "2026-10-01" };
  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await upsertNode(g, { type: "Business", id: "business:cafe", name: "Cafe", ...AS });
    for (let i = 0; i < 12; i++) {
      await upsertNode(g, { type: "Task", id: `task:t${i}`, name: `Task ${i}`, ...AS });
      await upsertEdge(g, { from: "business:cafe", type: "OWNS", to: `task:t${i}`, ...AS });
    }
    await upsertEdge(g, { from: "task:t0", type: "DEPENDS_ON", to: "task:t1", ...AS });
  });
  afterAll(async () => { await cleanup(); await closeAll(); });

  it("counts things and links, and finds the best-linked nodes with their links by type", async () => {
    expect(await graphCounts(g)).toEqual({ nodes: 13, edges: 13 });
    const hubs = await topHubs(g, 2);
    expect(hubs.map((h) => [h.id, h.degree])).toEqual([["business:cafe", 12], ["task:t0", 2]]);
    expect(hubs[0]!.byType).toEqual({ OWNS: 12 });
    expect(isSupernode(hubs[0]!, 13)).toBe(false); // too small a graph to judge by share
    expect(isSupernode({ ...hubs[0]!, degree: 1_000 }, 13)).toBe(true);
    expect(isSupernode({ ...hubs[0]!, degree: 150 }, 1_400)).toBe(true);
  });

  it("lists the indexes the schema wants and the graph lacks", async () => {
    expect((await missingIndexes(g)).length).toBe(wantedIndexes().length);
    await ensureIndexes(g);
    expect(await missingIndexes(g)).toEqual([]);
  });

  it("reads the graph's memory and its slow log, each query planned", async () => {
    const db = await connect();
    expect(typeof (await graphMemoryMb(db, g.name))).toBe("number");
    const slow = await slowQueries(db, g);
    expect(Array.isArray(slow)).toBe(true);
    for (const q of slow) expect(q.scans === null || Array.isArray(q.scans)).toBe(true);
  });
});
