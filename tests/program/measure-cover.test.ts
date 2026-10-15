// A goal can read an additive number from readings of other lengths that tile its period exactly: four weekly rows are a
// 28-day month, a weekly row is a 7-day week. Levels (followers) and distinct counts (reach) never add up.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { writeBatch, type ObservationInput } from "../../src/graph/upsert.js";
import { NON_ADDITIVE_METRICS, readSource } from "../../src/program/measure.js";
import { testGraph } from "../helpers/graph.js";

const biz = "business:cover-shop";
const DAY = 86_400_000;
const day = (start: string, n: number) => new Date(Date.parse(`${start}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const TODAY = "2026-10-15";

const obs = (metric: string, ws: string, we: string, value: number): ObservationInput =>
  ({ subject: biz, metric, value, windowStart: ws, windowEnd: we, asOf: "2026-10-15", src: "document:cover-file" });
const weeks = (metric: string, first: string, values: number[]) => values.map((v, i) => obs(metric, day(first, i * 7), day(first, i * 7 + 6), v));

describe("readings that tile the period", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  const month = (metric: string, until?: string) =>
    readSource(g, { metric, subject: "business", agg: "daily_sum" }, { businessId: biz, period: "month", today: TODAY, ...(until ? { until } : {}) });

  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    const s = await writeBatch(g, {
      nodes: [{ type: "Business", id: biz, name: "Cover Shop" }, { type: "Document", id: "document:cover-file", name: "file", props: { kind: "upload" } }],
      observations: [
        // eight weeks, 17 Aug to 11 Oct
        ...weeks("orders", "2026-08-17", [1, 2, 3, 4, 5, 6, 7, 8]),
        // three weeks are 21 days: not a month
        ...weeks("visits", "2026-09-07", [10, 20, 30]),
        // reach is a distinct count: weekly figures never add up
        ...weeks("account_reach", "2026-09-14", [100, 100, 100, 100]),
        // fourteen days, then two weeks
        ...Array.from({ length: 14 }, (_, i) => obs("mixed", day("2026-09-14", i), day("2026-09-14", i), 1)),
        ...weeks("mixed", "2026-09-28", [7, 7]),
        // readings that overlap cannot tile
        obs("overlap", "2026-09-14", "2026-09-27", 5), obs("overlap", "2026-09-21", "2026-10-11", 6),
      ],
    }, Date.parse("2026-10-15T00:00:00Z"));
    expect(s.errors).toEqual([]);
  });
  afterAll(async () => { await cleanup(); await closeAll(); });

  it("reads four weekly rows as the month they cover", async () => {
    const r = await month("orders");
    expect(r).toMatchObject({ value: 5 + 6 + 7 + 8, windowStart: "2026-09-14", windowEnd: "2026-10-11" });
    expect(r!.obsIds).toHaveLength(4);
    expect(r!.evidence).toBe("Sum of 4 orders readings covering 14 Sep to 11 Oct.");
  });

  it("reads the earlier month when asked for the period that ended on or before a date", async () => {
    // (a period older than two weeks counts only when the caller allows it: where a business started)
    expect(await month("orders", "2026-09-27")).toBeNull();
    const r = await readSource(g, { metric: "orders", subject: "business", agg: "daily_sum" }, { businessId: biz, period: "month", today: TODAY, until: "2026-09-27", maxAgeDays: 3650 });
    expect(r).toMatchObject({ value: 3 + 4 + 5 + 6, windowStart: "2026-08-31", windowEnd: "2026-09-27" });
  });

  it("says nothing when the weeks do not cover the month", async () => {
    expect(await month("visits")).toBeNull();
  });

  it("never adds up a level or a distinct count", async () => {
    expect(NON_ADDITIVE_METRICS.has("account_reach")).toBe(true);
    expect(await readSource(g, { metric: "account_reach", subject: "business", agg: "window" }, { businessId: biz, period: "month", today: TODAY })).toBeNull();
  });

  it("mixes days and weeks that tile exactly", async () => {
    expect(await month("mixed")).toMatchObject({ value: 14 + 7 + 7, windowStart: "2026-09-14", windowEnd: "2026-10-11" });
  });

  it("will not use readings that overlap", async () => {
    expect(await month("overlap")).toBeNull();
  });

  it("reads a weekly goal from one weekly row", async () => {
    const r = await readSource(g, { metric: "orders", subject: "business", agg: "daily_sum" }, { businessId: biz, period: "week", today: TODAY });
    expect(r).toMatchObject({ value: 8, windowStart: "2026-10-05", windowEnd: "2026-10-11" });
  });
});
