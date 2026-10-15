// Dates and numbers as people write them in a spreadsheet.
import { describe, expect, it } from "vitest";
import { detectDateOrder, parseDateCell } from "../../../src/connectors/upload/dates.js";
import { parseNumberCell } from "../../../src/connectors/upload/numbers.js";

describe("dates", () => {
  it("reads ISO dates, with or without a time", () => {
    expect(parseDateCell("2026-10-05", "dmy")).toEqual({ start: "2026-10-05", end: "2026-10-05", grain: "day" });
    expect(parseDateCell("2026/10/05", "dmy")?.start).toBe("2026-10-05");
    expect(parseDateCell("2026-10-05T00:00:00Z", "dmy")?.start).toBe("2026-10-05");
  });

  it("reads day/month/year or month/day/year as told, and never accepts an impossible date", () => {
    expect(parseDateCell("05/10/2026", "dmy")?.start).toBe("2026-10-05");
    expect(parseDateCell("05/10/2026", "mdy")?.start).toBe("2026-05-10");
    expect(parseDateCell("31/02/2026", "dmy")).toBeNull();
    expect(parseDateCell("13/01/2026", "mdy")).toBeNull();
    expect(parseDateCell("5.10.26", "mdy")?.start).toBe("2026-10-05"); // dots are day-first in practice
  });

  it("reads words: 5 Oct 2026, Oct 5, 2026, Monday 5 October 2026", () => {
    expect(parseDateCell("5 Oct 2026", "dmy")?.start).toBe("2026-10-05");
    expect(parseDateCell("Oct 5, 2026", "dmy")?.start).toBe("2026-10-05");
    expect(parseDateCell("Monday, 5 October 2026", "dmy")?.start).toBe("2026-10-05");
    expect(parseDateCell("5-Oct-26", "dmy")?.start).toBe("2026-10-05");
  });

  it("reads a month on its own as the whole month, and an ISO week as Monday to Sunday", () => {
    expect(parseDateCell("Oct 2026", "dmy")).toEqual({ start: "2026-10-01", end: "2026-10-31", grain: "month" });
    expect(parseDateCell("2026-02", "dmy")).toEqual({ start: "2026-02-01", end: "2026-02-28", grain: "month" });
    expect(parseDateCell("2026-W41", "dmy")).toEqual({ start: "2026-10-05", end: "2026-10-11", grain: "week" });
  });

  it("reads a range with both ends (a weekly export)", () => {
    expect(parseDateCell("05/10/2026 - 11/10/2026", "dmy")).toEqual({ start: "2026-10-05", end: "2026-10-11", grain: "range" });
    expect(parseDateCell("5 Oct – 11 Oct 2026", "dmy")).toEqual({ start: "2026-10-05", end: "2026-10-11", grain: "range" });
    expect(parseDateCell("11 Oct 2026 - 5 Oct 2026", "dmy")).toBeNull();
  });

  it("says text and plain numbers are not dates", () => {
    for (const v of ["Total", "12", "1,234", "hello", "", "2026"]) expect(parseDateCell(v, "dmy")).toBeNull();
  });

  it("decides day-first or month-first from the values, and says when it only guessed", () => {
    expect(detectDateOrder(["13/10/2026", "05/10/2026"], "mdy")).toEqual({ order: "dmy", certain: true });
    expect(detectDateOrder(["10/13/2026", "10/05/2026"], "dmy")).toEqual({ order: "mdy", certain: true });
    expect(detectDateOrder(["05/10/2026", "06/10/2026"], "dmy")).toEqual({ order: "dmy", certain: false });
    expect(detectDateOrder(["2026-10-05"], "mdy")).toEqual({ order: "mdy", certain: true }); // ISO has no order to guess
  });
});

describe("numbers", () => {
  it("reads plain, grouped and decimal numbers", () => {
    expect(parseNumberCell("42")).toBe(42);
    expect(parseNumberCell(" 1,234 ")).toBe(1234);
    expect(parseNumberCell("1,23,456")).toBe(123456); // Indian grouping
    expect(parseNumberCell("1,234,567.89")).toBe(1234567.89);
    expect(parseNumberCell("1.234,56")).toBe(1234.56);
    expect(parseNumberCell("12,5")).toBe(12.5);
    expect(parseNumberCell(7)).toBe(7);
  });

  it("strips money and percent signs, reads brackets and a minus as negative", () => {
    expect(parseNumberCell("£1,200.50")).toBe(1200.5);
    expect(parseNumberCell("₹ 45,000")).toBe(45000);
    expect(parseNumberCell("USD 300")).toBe(300);
    expect(parseNumberCell("12%")).toBe(12);
    expect(parseNumberCell("(500)")).toBe(-500);
    expect(parseNumberCell("-3")).toBe(-3);
  });

  it("returns null for blanks and words, never zero", () => {
    for (const v of ["", " ", "-", "n/a", "N/A", "null", "abc", "12abc", null]) expect(parseNumberCell(v as string | null)).toBeNull();
    expect(parseNumberCell(Number.NaN)).toBeNull();
  });
});
