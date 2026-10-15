import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { GraphHandle } from "../../../src/graph/client.js";
import { traceDecision } from "../../../src/agent/tools/decisions.js";
import { call, ids, makeCtx, seededGraph } from "../../helpers/tools.js";

describe("trace_decision (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeAll(async () => ({ g, cleanup } = await seededGraph()), 60_000);
  afterAll(async () => cleanup());

  it("finds the decision by query and traces evidence, deciders, effects and what it replaced", async () => {
    const r = await call(traceDecision, { query: "pause daily stories" }, makeCtx(g));
    expect(r.data.decision).toMatchObject({ id: "decision:007-pause-daily-stories", status: "accepted", decidedAt: "2026-09-20" });
    expect(r.data.current).toBe(true);
    const obs = r.data.evidence.find((e: { type: string }) => e.type === "Observation");
    expect(obs).toMatchObject({ metric: "signups_from_reels", value: 55, unit: "signups", window: "2026-09-01..2026-09-30", sources: ["document:ig-insights-sep"] });
    const doc = r.data.evidence.find((e: { type: string }) => e.type === "Document");
    expect(doc).toMatchObject({ id: "document:ig-insights-sep", sources: ["document:ig-insights-sep"] });
    expect(r.data.decidedBy).toEqual([{ id: "person:founder", type: "Person", name: "Ankit", at: "2026-09-20" }]);
    expect(r.data.affects.map((a: { id: string }) => a.id)).toEqual(["channel:instagram"]);
    expect(r.data.supersedes).toEqual([expect.objectContaining({ id: "decision:003-daily-stories", status: "superseded" })]);
    expect(r.data.supersededBy).toEqual([]);
    const types = new Set(r.edges.map((e: { type: string }) => e.type));
    for (const t of ["BASED_ON", "DECIDED", "AFFECTS", "SUPERSEDES"]) expect(types.has(t)).toBe(true);
    expect(ids(r.sources)).toEqual(expect.arrayContaining(["document:adr-007", "document:ig-insights-sep", "document:adr-003"]));
    expect(ids(r.nodes)).toContain(obs.id);
  });

  it("says when a decision was superseded", async () => {
    const r = await call(traceDecision, { id: "decision:003-daily-stories" }, makeCtx(g));
    expect(r.data.current).toBe(false);
    expect(r.data.supersededBy.map((d: { id: string }) => d.id)).toEqual(["decision:007-pause-daily-stories"]);
    expect(r.note).toMatch(/Superseded by decision:007/);
    expect(r.note).toMatch(/No evidence/);
  });

  it("given an affected entity, traces the decision that affects it", async () => {
    const r = await call(traceDecision, { id: "channel:instagram" }, makeCtx(g));
    expect(r.data.decision.id).toBe("decision:007-pause-daily-stories");
    expect(r.note).toMatch(/not a Decision/);
    const none = await call(traceDecision, { id: "system:reel-scheduler" }, makeCtx(g));
    expect(none.data.error).toMatch(/no decision affects it/);
    const neither = await call(traceDecision, {}, makeCtx(g));
    expect(neither.data.error).toMatch(/id .*or a query/);
  });
});
