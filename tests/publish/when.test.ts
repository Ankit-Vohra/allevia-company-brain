// "Post Tuesday 7 pm": the instant is in the business's own zone, and the words come back in it.
import { describe, expect, it } from "vitest";
import { parseClock, resolveWhen, whenWords, MAX_AHEAD_MS } from "../../src/publish/when.js";

const FRI = Date.parse("2026-10-16T10:00:00Z"); // Friday 16 October 2026, 10:00 UTC
const iso = (r: ReturnType<typeof resolveWhen>) => (r.ok ? new Date(r.at).toISOString() : r.error);

describe("parseClock", () => {
  it("reads the ways an owner says a time", () => {
    expect(parseClock("19:00")).toBe("19:00");
    expect(parseClock("7pm")).toBe("19:00");
    expect(parseClock("7:30 PM")).toBe("19:30");
    expect(parseClock("12am")).toBe("00:00");
    expect(parseClock("12pm")).toBe("12:00");
    expect(parseClock("9")).toBe("09:00");
    expect(parseClock("25:00")).toBeNull();
    expect(parseClock("13pm")).toBeNull();
    expect(parseClock("soon")).toBeNull();
    expect(parseClock(undefined)).toBeNull();
  });
});

describe("resolveWhen", () => {
  it("Tuesday 7 pm is the next Tuesday, in the business's zone", () => {
    expect(iso(resolveWhen({ weekday: "tuesday", time: "7pm" }, "Asia/Dubai", FRI))).toBe("2026-10-20T15:00:00.000Z");
    expect(iso(resolveWhen({ weekday: "tuesday", time: "7pm" }, "Asia/Kolkata", FRI))).toBe("2026-10-20T13:30:00.000Z");
    expect(iso(resolveWhen({ weekday: "tuesday", time: "19:00" }, "America/New_York", FRI))).toBe("2026-10-20T23:00:00.000Z");
    expect(iso(resolveWhen({ weekday: "tuesday", time: "19:00" }, "Australia/Sydney", FRI))).toBe("2026-10-20T08:00:00.000Z");
  });

  it("today counts when the time is still ahead, and next week when it has gone by", () => {
    // 14:00 on Friday in Dubai: 6 pm Friday is still ahead, 9 am Friday is not
    expect(iso(resolveWhen({ weekday: "friday", time: "6pm" }, "Asia/Dubai", FRI))).toBe("2026-10-16T14:00:00.000Z");
    expect(iso(resolveWhen({ weekday: "friday", time: "9am" }, "Asia/Dubai", FRI))).toBe("2026-10-23T05:00:00.000Z");
  });

  it("the weekday is the one where the business is, not where the server is", () => {
    // 22:00 UTC Friday is already Saturday 02:00 in Dubai, so "Saturday 9am" is the next morning there
    const lateFri = Date.parse("2026-10-16T22:00:00Z");
    expect(iso(resolveWhen({ weekday: "saturday", time: "9am" }, "Asia/Dubai", lateFri))).toBe("2026-10-17T05:00:00.000Z");
    expect(iso(resolveWhen({ weekday: "saturday", time: "9am" }, "America/New_York", lateFri))).toBe("2026-10-17T13:00:00.000Z");
  });

  it("follows daylight saving: 7 pm London is an hour later in UTC after the clocks go back on 25 October", () => {
    expect(iso(resolveWhen({ date: "2026-10-24", time: "7pm" }, "Europe/London", FRI))).toBe("2026-10-24T18:00:00.000Z");
    expect(iso(resolveWhen({ date: "2026-10-26", time: "7pm" }, "Europe/London", FRI))).toBe("2026-10-26T19:00:00.000Z");
  });

  it("takes an exact instant only when it carries its offset", () => {
    expect(iso(resolveWhen({ at: "2026-10-20T19:00:00+04:00" }, "Asia/Dubai", FRI))).toBe("2026-10-20T15:00:00.000Z");
    expect(iso(resolveWhen({ at: "2026-10-20T19:00:00" }, "Asia/Dubai", FRI))).toMatch(/needs its zone/);
  });

  it("refuses, in plain words, a past time, one too far off, a missing time and an unknown zone", () => {
    expect(iso(resolveWhen({ date: "2026-10-15", time: "7pm" }, "Asia/Dubai", FRI))).toMatch(/already passed/);
    expect(iso(resolveWhen({ at: new Date(FRI + 60_000).toISOString() }, "Asia/Dubai", FRI))).toMatch(/already passed/);
    expect(iso(resolveWhen({ at: new Date(FRI + MAX_AHEAD_MS + 3_600_000).toISOString() }, "Asia/Dubai", FRI))).toMatch(/more than 90 days/);
    expect(iso(resolveWhen({ weekday: "tuesday" }, "Asia/Dubai", FRI))).toMatch(/What time/);
    expect(iso(resolveWhen({ time: "7pm" }, "Asia/Dubai", FRI))).toMatch(/Say when/);
    expect(iso(resolveWhen({ weekday: "tuesday", time: "7pm" }, "Mars/Olympus", FRI))).toMatch(/time zone/);
    expect(iso(resolveWhen({ date: "20 Oct", time: "7pm" }, "Asia/Dubai", FRI))).toMatch(/couldn't read that date/);
  });
});

describe("whenWords", () => {
  const tue = Date.parse("2026-10-20T15:00:00Z");
  it("reads in the business's own zone", () => {
    expect(whenWords(tue, "Asia/Dubai")).toBe("Tue 20 Oct, 7:00 pm");
    expect(whenWords(tue, "Asia/Kolkata")).toBe("Tue 20 Oct, 8:30 pm");
    expect(whenWords(tue, "America/New_York")).toBe("Tue 20 Oct, 11:00 am");
  });
  it("says today and tomorrow when it can", () => {
    expect(whenWords(tue, "Asia/Dubai", Date.parse("2026-10-20T06:00:00Z"))).toBe("today at 7:00 pm");
    expect(whenWords(tue, "Asia/Dubai", Date.parse("2026-10-19T06:00:00Z"))).toBe("tomorrow at 7:00 pm");
    expect(whenWords(tue, "Asia/Dubai", Date.parse("2026-10-16T06:00:00Z"))).toBe("Tue 20 Oct, 7:00 pm");
  });
});
