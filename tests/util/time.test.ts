import { describe, it, expect } from "vitest";
import { isoDate, toIso, parseTime, formatIst } from "../../src/util/time.js";

describe("time", () => {
  const ms = Date.UTC(2026, 9, 14, 20, 0, 0); // 2026-10-15 01:30 IST
  it("formats epoch ms", () => {
    expect(toIso(ms)).toBe("2026-10-14T20:00:00.000Z");
    expect(isoDate(ms)).toBe("2026-10-14");
    expect(formatIst(ms)).toBe("15 Oct 2026, 01:30 IST");
  });
  it("parses ISO dates and epoch numbers", () => {
    expect(parseTime("2026-10-14T20:00:00.000Z")).toBe(ms);
    expect(parseTime("2026-10-14")).toBe(Date.UTC(2026, 9, 14));
    expect(parseTime(ms)).toBe(ms);
    expect(() => parseTime("not a date")).toThrow();
  });
});
