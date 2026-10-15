// The mapped ops snapshot (synthetic fixture) applies to a real graph with no errors, and applying it twice changes
// nothing: the ids are deterministic, so re-ingesting a snapshot is idempotent. Talks to the local FalkorDB.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { upsertNode, writeBatch } from "../../src/graph/upsert.js";
import { scanGraph } from "../../src/ingest/privacy.js";
import { mapSnapshot } from "../../src/ingest/sources/ops-map/index.js";
import { testGraph } from "../helpers/graph.js";

const DIR = fileURLToPath(new URL("../fixtures/ops/snapshot/2026-10-15", import.meta.url));
const T0 = 1_760_500_000_000;

describe("ops snapshot -> graph (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await ensureIndexes(g);
    await upsertNode(g, { type: "Business", id: "business:aamdani", name: "Aamdani" }, T0); // what ensureTenant creates
  });
  afterAll(async () => {
    await cleanup();
    await closeAll();
  });

  it("writes every node, edge and observation, then re-applies as a no-op", async () => {
    const { write } = mapSnapshot(DIR, { tenantSlug: "aamdani", asOf: "2026-10-15" });
    const first = await writeBatch(g, write, T0);
    expect(first.errors.map((e) => `${e.kind}: ${e.error}`)).toEqual([]);
    expect(first.nodesCreated).toBe(write.nodes.length);
    expect(first.edgesCreated).toBe(write.edges.length);
    expect(first.observations).toBe(write.observations.length);

    const sourced = await g.roQuery<{ c: number }>(
      "MATCH (o:Observation)-[:SOURCED_FROM]->(d:Document {kind:'snapshot'}) RETURN count(o) AS c");
    expect(sourced[0]!.c).toBe(write.observations.length);

    expect(await scanGraph(g)).toEqual([]); // the audit finds nothing the redaction engine would still remove

    const again = await writeBatch(g, write, T0 + 60_000);
    expect(again.errors).toEqual([]);
    expect(again.nodesCreated).toBe(0);
    expect(again.edgesCreated).toBe(0);
    expect(again.versions).toBe(0);
  }, 60_000);
});
