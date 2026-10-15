// A reading over a period (a 28-day snapshot) keeps that period in metric_trend, and a summary over many subjects says
// which of them are samples. Live trial 2026-10-15: Aamdani's real "209 sign-ups, 18 Sep to 15 Oct" was reported as one
// day's figure, as one week's, and once as "sample numbers" because other subjects in the same summary were samples.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAll, type GraphHandle } from "../../../src/graph/client.js";
import { ensureIndexes } from "../../../src/graph/indexes.js";
import { addObservation, writeBatch } from "../../../src/graph/upsert.js";
import { metricTrend } from "../../../src/agent/tools/metrics.js";
import { TouchedSet } from "../../../src/agent/tool.js";
import { testGraph } from "../../helpers/graph.js";
import { NOW, stubCtx } from "../../helpers/agent.js";

describe("metric_trend: periods and samples (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await ensureIndexes(g);
    await writeBatch(g, { nodes: [
      { type: "Business", id: "business:kestrel", name: "Kestrel" },
      { type: "Campaign", id: "campaign:spring", name: "Spring ads" },
      { type: "Document", id: "document:snapshot", name: "Acquisition snapshot" },
    ] }, NOW);
    await addObservation(g, { subject: "business:kestrel", metric: "signups", value: 209, unit: "count", asOf: "2026-10-15", windowStart: "2026-09-18", windowEnd: "2026-10-15", src: "document:snapshot" }, NOW);
    for (const [d, v] of [["2026-10-06", 12], ["2026-10-07", 9], ["2026-10-13", 7], ["2026-10-14", 6]] as const) {
      await addObservation(g, { subject: "campaign:spring", metric: "signups", value: v, unit: "count", asOf: d, src: "document:snapshot", simulated: true }, NOW);
    }
  }, 60_000);
  afterAll(async () => { await cleanup(); await closeAll(); });

  const run = (args: Record<string, unknown>) => metricTrend.run(args as never, stubCtx({ graph: g, touched: new TouchedSet(), agentId: "data-analyst" }));

  it("a 28-day total keeps its period, by day and by week, and the note says to give the period", async () => {
    for (const groupBy of ["day", "week"]) {
      const r = await run({ metric: "signups", subject: "business:kestrel", groupBy });
      const series = (r.data as { series: Array<{ date: string; value: number; window?: { from: string; to: string } }> }).series;
      expect(series, groupBy).toEqual([{ date: "2026-10-15", value: 209, window: { from: "2026-09-18", to: "2026-10-15" } }]);
      expect(r.note).toMatch(/cover a period/);
    }
  });

  it("daily readings still go into their weeks, with no period of their own", async () => {
    const r = await run({ metric: "signups", subject: "campaign:spring", groupBy: "week" });
    const series = (r.data as { series: Array<{ date: string; window?: unknown }> }).series;
    expect(series.map((p) => p.date)).toEqual(["2026-10-05", "2026-10-12"]);
    expect(series.every((p) => !p.window)).toBe(true);
  });

  it("a summary flags samples per subject, not on the whole result", async () => {
    const r = await run({ metric: "signups", groupBy: "week" });
    const d = r.data as { simulated?: boolean; bySubject: Array<{ id: string; simulated: boolean; lastWindow?: { from: string } }> };
    expect(d.simulated).toBe(true); // some of it is, and each subject says which
    expect(d.bySubject.find((x) => x.id === "business:kestrel")).toMatchObject({ simulated: false, lastWindow: { from: "2026-09-18" } });
    expect(d.bySubject.find((x) => x.id === "campaign:spring")!.simulated).toBe(true);
    expect(r.note).toMatch(/Only these subjects are simulated: campaign:spring; the others are real/);
  });
});
