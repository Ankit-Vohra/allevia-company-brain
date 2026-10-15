// impact_of tells three empty answers apart, and resolves a name before any traversal runs (the hackathon blog's
// "not in the graph" vs "no impact"): an unknown name is "I don't have that in your records"; a known thing with no
// recorded dependencies is not_mapped (never "nothing breaks"); a mapped thing with nothing downstream is
// nothing_depends. Also: a dependency that ended and was asserted again (two parallel DEPENDS_ON edges, one closed) is
// one current dependent, and the past one is seen only as of a date when it held.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { GraphHandle } from "../../../src/graph/client.js";
import { closeEdge, upsertEdge, upsertNode } from "../../../src/graph/upsert.js";
import { impactOf } from "../../../src/agent/tools/impact.js";
import { whoOwns } from "../../../src/agent/tools/people.js";
import { D } from "../../fixtures/seed-graph.js";
import { call, makeCtx, seededGraph } from "../../helpers/tools.js";

describe("impact_of: not in your records, not mapped, nothing downstream (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    ({ g, cleanup } = await seededGraph());
    // a dependency that ended and came back: closed edge + a new open edge between the same pair
    await upsertNode(g, { type: "System", id: "system:billing", name: "Billing service" }, D("2026-08-01"));
    await upsertEdge(g, { from: "system:billing", type: "DEPENDS_ON", to: "system:reel-scheduler" }, D("2026-08-01"));
    await closeEdge(g, "system:billing", "DEPENDS_ON", "system:reel-scheduler", D("2026-08-20"), "paused");
    await upsertEdge(g, { from: "system:billing", type: "DEPENDS_ON", to: "system:reel-scheduler", since: D("2026-09-10") }, D("2026-09-10"));
  }, 60_000);
  afterAll(async () => cleanup());

  it("an unknown name or id is refused before any traversal, with the closest things in the records", async () => {
    const r = await call(impactOf, { query: "Payroll gateway" }, makeCtx(g));
    expect(r.data.error).toMatch(/^I don't have "Payroll gateway" in your records\./);
    expect(r.data.notInRecords).toBe(true);
    expect(r.data.impacted).toBeUndefined();
    const byId = await call(impactOf, { id: "system:payroll" }, makeCtx(g));
    expect(byId.data.error).toMatch(/I don't have "system:payroll" in your records/);
  });

  it("a plain name resolves to its node first (exact name, any case)", async () => {
    const r = await call(impactOf, { query: "instagram CONNECTOR", depth: 1 }, makeCtx(g));
    expect(r.data.id).toBe("system:ig-connector");
    expect(r.data.status).toBe("impact");
    const asId = await call(impactOf, { id: "Instagram connector", depth: 1 }, makeCtx(g));
    expect(asId.data.id).toBe("system:ig-connector");
  });

  it("a thing with no recorded dependencies is not_mapped, which is not 'nothing breaks'", async () => {
    const r = await call(impactOf, { id: "team:marketing" }, makeCtx(g));
    expect(r.data.status).toBe("not_mapped");
    expect(r.data.total).toBe(0);
    expect(r.note).toMatch(/no dependencies are recorded/);
    expect(r.note).toMatch(/does not mean nothing depends on it/);
  });

  it("a mapped thing with nothing downstream is nothing_depends", async () => {
    const r = await call(impactOf, { id: "system:billing" }, makeCtx(g));
    expect(r.data.status).toBe("nothing_depends");
    expect(r.note).toMatch(/Nothing current depends on/);
  });

  it("parallel edges: a dependency closed and reopened counts once now, and as of a date it held", async () => {
    const r = await call(impactOf, { id: "system:reel-scheduler", depth: 1 }, makeCtx(g));
    expect(r.data.impacted[0].items.map((i: { id: string }) => i.id)).toEqual(["system:billing"]);
    expect(r.data.total).toBe(1);
    const gap = await call(impactOf, { id: "system:reel-scheduler", depth: 1, asOf: "2026-09-01" }, makeCtx(g));
    expect(gap.data.status).toBe("nothing_depends"); // in the gap the old edge had ended and the new one had not begun
    const before = await call(impactOf, { id: "system:reel-scheduler", depth: 1, asOf: "2026-08-10" }, makeCtx(g));
    expect(before.data.total).toBe(1);
  });

  it("other tools say the same words for an unknown name", async () => {
    const r = await call(whoOwns, { query: "zzqx flux capacitor" }, makeCtx(g));
    expect(r.data.error).toMatch(/I don't have "zzqx flux capacitor" in your records/);
  });
});
