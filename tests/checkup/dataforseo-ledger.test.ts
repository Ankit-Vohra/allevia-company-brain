// The month's DataForSEO spend kept in the business's own graph: each paid call is a reading on the Business, and a
// new month starts from zero.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GraphHandle } from "../../src/graph/client.js";
import { upsertNode, writeBatch } from "../../src/graph/upsert.js";
import { graphLedger } from "../../src/checkup/dataforseo.js";
import { testGraph } from "../helpers/graph.js";

describe("graphLedger", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await upsertNode(g, { type: "Business", id: "business:avs", name: "AV's Atelier" }, Date.now());
  });
  afterAll(async () => { await cleanup(); });

  it("adds up this month's calls only", async () => {
    const l = graphLedger(g, "business:avs", async (w) => { const s = await writeBatch(g, w, Date.now()); expect(s.errors).toEqual([]); });
    await l.record(0.02, "keyword_ideas", Date.parse("2026-09-30T10:00:00Z"));
    await l.record(0.0156, "keyword_ideas", Date.parse("2026-10-02T10:00:00Z"));
    await l.record(0.024, "backlinks", Date.parse("2026-10-16T10:00:00Z"));
    expect(await l.spentThisMonth(Date.parse("2026-10-16T12:00:00Z"))).toBeCloseTo(0.0396, 4);
    expect(await l.spentThisMonth(Date.parse("2026-11-01T00:00:00Z"))).toBe(0);
  });
});
