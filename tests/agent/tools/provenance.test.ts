// Provenance: no tool returns a node without one of its sources when it has any, and an edge's `src` document always
// comes back as a source. Checked over every read tool on the seed graph.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { GraphHandle } from "../../../src/graph/client.js";
import type { AlleviaTool } from "../../../src/agent/tool.js";
import { sourceRows } from "../../../src/agent/tools/common.js";
import { ALL_TOOLS } from "../../../src/agent/tools/index.js";
import { call, makeCtx, seededGraph } from "../../helpers/tools.js";

const CALLS: Array<[string, Record<string, unknown>]> = [
  ["search", { query: "instagram stories reels" }], ["get_entity", { id: "decision:007-pause-daily-stories" }],
  ["get_entity", { id: "system:ig-connector", asOf: "2026-09-15" }], ["neighbors", { id: "channel:instagram", depth: 2 }],
  ["find_paths", { from: "person:founder", to: "system:ig-connector" }], ["trace_decision", { query: "pause daily stories" }],
  ["who_owns", { id: "system:ig-connector" }], ["who_knows", { id: "channel:instagram" }], ["impact_of", { id: "system:ig-connector" }],
  ["important", {}], ["topics", {}], ["metric_trend", { metric: "followers", subject: "channel:instagram" }], ["metric_trend", { metric: "signups" }],
  ["content_performance", {}], ["seo_report", {}], ["ad_report", {}], ["playbook", { topic: "hooks" }], ["history", { id: "task:fix-ig-token" }],
  ["recall", { ids: ["decision:007-pause-daily-stories"] }], ["cypher", { query: "MATCH (t:Task)<-[r:OWNS]-(o) RETURN t, r, o" }],
  ["get_brand_asset", {}], ["crm_read", { view: "pipeline" }], ["publish_status", {}], ["website_checkup", { all: true }], ["ai_visibility", {}], ["meetings_read", {}],["show_path", { ids: ["decision:007-pause-daily-stories", "channel:instagram", "system:ig-connector"] }],
];

describe("provenance (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeAll(async () => ({ g, cleanup } = await seededGraph()), 60_000);
  afterAll(async () => cleanup());

  it("covers every read tool", () => {
    const named = new Set(CALLS.map(([n]) => n));
    // use_skill opens a skill (a way of working), not the graph: it returns no nodes, edges or sources to attribute.
    expect(ALL_TOOLS.filter((t) => !t.writes && !t.external && t.name !== "use_skill" && !named.has(t.name)).map((t) => t.name)).toEqual([]);
  });

  it("every returned node with a source brings one, and every edge's src document comes back", async () => {
    const byName = new Map<string, AlleviaTool>(ALL_TOOLS.map((t) => [t.name, t]));
    for (const [name, args] of CALLS) {
      const ctx = makeCtx(g);
      const r = await call(byName.get(name)!, args, ctx);
      const label = `${name} ${JSON.stringify(args)}`;
      expect(r.data.error, label).toBeUndefined();
      const have = new Set(r.sources.map((s: { id: string }) => s.id));
      const behind = new Map<string, string[]>();
      for (const row of await sourceRows(ctx, r.nodes.map((n: { id: string }) => n.id))) behind.set(row.of, [...(behind.get(row.of) ?? []), row.id]);
      for (const [id, docs] of behind) expect(docs.some((d) => have.has(d)), `${label}: ${id} has sources ${docs.join(", ")}`).toBe(true);
      const srcs = await g.roQuery<{ src: string }>(
        `UNWIND $es AS e MATCH (:Entity {id:e.from})-[r]->(:Entity {id:e.to}) WHERE type(r) = e.type AND r.src IS NOT NULL
         MATCH (d:Document {id:r.src}) RETURN DISTINCT d.id AS src`,
        { es: r.edges.map((e: { from: string; type: string; to: string }) => ({ from: e.from, type: e.type, to: e.to })) });
      for (const { src } of srcs) expect(have.has(src), `${label}: edge src ${src}`).toBe(true);
    }
  }, 60_000);
});
