import { describe, it, expect } from "vitest";
import { levelShift, stats } from "../../../src/agent/tools/metrics.js";

const series = (values: number[]) => values.map((value, i) => ({ date: `2026-10-${String(i + 1).padStart(2, "0")}`, value }));

describe("levelShift: the day a level stepped", () => {
  it("finds the date a series fell and the levels either side", () => {
    const s = levelShift(series([250, 240, 260, 255, 245, 52, 48, 55, 50, 47]));
    expect(s).toMatchObject({ at: "2026-10-06", beforePoints: 5, afterPoints: 5 });
    expect(s!.before).toBeGreaterThan(240);
    expect(s!.pctChange).toBeLessThan(-75);
  });
  it("says nothing for a flat, noisy or short series", () => {
    expect(levelShift(series([100, 104, 98, 101, 103, 99, 102, 100]))).toBeUndefined();
    expect(levelShift(series([10, 11, 90, 91]))).toBeUndefined(); // fewer than 3 readings a side
    expect(levelShift(series([0, 0, 0, 5, 5, 5]))).toBeUndefined(); // from zero: no percentage
  });
  it("rides along in stats, but not for period readings", () => {
    expect(stats(series([250, 240, 260, 50, 48, 52])).shift?.at).toBe("2026-10-04");
    expect(stats(series([250, 240, 260, 50, 48, 52]).map((p) => ({ ...p, window: { from: "2026-09-01", to: p.date } }))).shift).toBeUndefined();
  });
});
