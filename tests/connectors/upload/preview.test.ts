// The owner's file becomes a guess in plain words, never a silent decision: the date column, how often a row comes, what
// each number column is, and what we left out. And personal columns are refused.
import { describe, expect, it } from "vitest";
import { UploadError } from "../../../src/connectors/upload/limits.js";
import { METRICS, guessHeader, isAdditive } from "../../../src/connectors/upload/metrics.js";
import { buildSeries, previewTable } from "../../../src/connectors/upload/analyse.js";
import { readTable } from "../../../src/connectors/upload/table.js";
import { NON_ADDITIVE_METRICS } from "../../../src/program/measure.js";
import { makeXlsx, serial } from "../../helpers/xlsx.js";

const table = (csv: string) => readTable(Buffer.from(csv), "n.csv");
const preview = (csv: string, over: { country?: string } = {}) => previewTable(table(csv), { fileName: "n.csv", fileHash: "h".repeat(64), ...over });
const fail = (fn: () => unknown): UploadError => { try { fn(); } catch (e) { return e as UploadError; } throw new Error("expected an UploadError"); };

const weekly = (rows: number, extra = "") => ["Week starting,Enquiries,Orders,Revenue (£)", ...Array.from({ length: rows }, (_, i) => {
  const d = new Date(Date.UTC(2026, 6, 6) + i * 7 * 86_400_000).toISOString().slice(0, 10);
  return `${d},${10 + i},${3 + i},${500 + 10 * i}${extra}`;
})].join("\n");

describe("headers", () => {
  it("guesses what a column is from its words, and says how sure", () => {
    expect(guessHeader("Sessions")).toEqual({ metric: "ga4_sessions", sure: true });
    expect(guessHeader("Website visits")).toEqual({ metric: "ga4_sessions", sure: true });
    expect(guessHeader("Enquiries")).toEqual({ metric: "enquiries", sure: true });
    expect(guessHeader("New leads")).toEqual({ metric: "enquiries", sure: true });
    expect(guessHeader("Revenue (£)")).toEqual({ metric: "revenue", sure: true });
    expect(guessHeader("Ad spend")).toEqual({ metric: "ad_spend", sure: true });
    expect(guessHeader("Followers")).toEqual({ metric: "followers", sure: true });
    expect(guessHeader("Signups")).toEqual({ metric: "new_accounts", sure: true });
    expect(guessHeader("Calls")).toEqual({ metric: "gbp_actions", sure: false });
    expect(guessHeader("Clicks")).toEqual({ metric: "gsc_clicks", sure: false });
    expect(guessHeader("Pints sold")).toEqual({ metric: null, sure: false });
    expect(guessHeader("")).toEqual({ metric: null, sure: false });
  });

  it("keeps the additive list in step with the one the goals read", () => {
    expect(METRICS.filter((m) => !m.additive).map((m) => m.key).sort()).toEqual(METRICS.filter((m) => NON_ADDITIVE_METRICS.has(m.key)).map((m) => m.key).sort());
    expect(isAdditive("followers")).toBe(false);
    expect(isAdditive("enquiries")).toBe(true);
  });
});

describe("a weekly file", () => {
  const p = preview(weekly(14));

  it("finds the date column, the weeks and the span, and says it in words", () => {
    expect(p.dateColumn).toMatchObject({ index: 0, header: "Week starting" });
    expect(p.cadence).toBe("week");
    expect(p.rowCount).toBe(14);
    expect(p.from).toBe("2026-07-06");
    expect(p.to).toBe("2026-10-11"); // the Sunday that closes the last week
    expect(p.headline).toMatch(/^This looks like weekly enquiries, orders and sales, from 6 Jul to 11 Oct\./);
    expect(p.headline).toMatch(/OK\?$/);
  });

  it("proposes a metric for every number column and asks nothing it can answer itself", () => {
    expect(p.columns.map((c) => [c.header, c.guess.metric, c.guess.sure])).toEqual([["Enquiries", "enquiries", true], ["Orders", "orders", true], ["Revenue (£)", "revenue", true]]);
    expect(p.questions).toEqual([]);
    expect(p.plan).toMatchObject({ dateColumn: 0, cadence: "week", weekAnchor: "start" });
    expect(p.plan.columns).toEqual([{ index: 1, metric: "enquiries" }, { index: 2, metric: "orders" }, { index: 3, metric: "revenue" }]);
    expect(p.sampleRows).toHaveLength(3);
    expect(p.sampleRows[0]).toEqual(["2026-07-06", "10", "3", "500"]);
  });

  it("offers the owner every number we know how to keep, plus their own", () => {
    expect(p.metricOptions.map((m) => m.key)).toContain("ga4_sessions");
    expect(p.metricOptions.every((m) => m.label.length > 0)).toBe(true);
  });
});

describe("a daily file", () => {
  it("reads days, ISO dates, a blank as missing and a Total row as left out", () => {
    const p = preview("Date,Visits,Orders\n2026-10-01,100,2\n2026-10-02,,3\n2026-10-03,90,4\nTotal,190,9\n");
    expect(p.cadence).toBe("day");
    expect(p.rowCount).toBe(3);
    expect(p.skippedRows).toBe(1);
    expect(p.blanks).toBe(1);
    expect(p.headline).toMatch(/^This looks like daily website visits and orders, from 1 Oct to 3 Oct\./);
    expect(p.sentences.join(" ")).toMatch(/1 row without a date was left out/);
    expect(p.sentences.join(" ")).toMatch(/blank, not counted as zero/);
  });
});

describe("never silently guess", () => {
  it("asks when the day and month could be either way round, and says which it assumed", () => {
    const p = preview("Date,Orders\n05/10/2026,3\n06/10/2026,4\n07/10/2026,5\n");
    expect(p.dateOrderGuessed).toBe(true);
    expect(p.questions).toContain("date_order");
    expect(p.plan.dateOrder).toBe("dmy");
    expect(p.sentences.join(" ")).toMatch(/5 Oct 2026/);
    expect(preview("Date,Orders\n05/10/2026,3\n06/10/2026,4\n07/10/2026,5\n", { country: "US" }).plan.dateOrder).toBe("mdy");
    expect(preview("Date,Orders\n13/10/2026,3\n14/10/2026,4\n").dateOrderGuessed).toBe(false);
  });

  it("asks when it cannot tell days from weeks from months", () => {
    const p = preview("Date,Orders\n2026-10-01,3\n2026-10-09,4\n2026-10-30,5\n");
    expect(p.cadence).toBeNull();
    expect(p.questions).toContain("cadence");
    expect(p.headline).toMatch(/can't tell|couldn't tell/i);
  });

  it("asks what a column is when the header is not one we know, and when we only half know", () => {
    const p = preview("Date,Pints sold,Calls\n2026-10-01,5,2\n2026-10-02,6,3\n2026-10-03,7,1\n");
    expect(p.questions).toContain("metrics");
    expect(p.columns.map((c) => c.guess)).toEqual([{ metric: null, label: null, sure: false }, { metric: "gbp_actions", label: "Calls and directions from Google", sure: false }]);
    expect(p.plan.columns).toEqual([{ index: 1, metric: null }, { index: 2, metric: "gbp_actions" }]);
  });

  it("leaves out columns that number the rows, and text columns, and says so", () => {
    const p = preview("Week no,Date,Channel,Orders\n41,2026-10-05,Email,3\n42,2026-10-12,Email,4\n43,2026-10-19,Email,5\n");
    expect(p.leftOut.map((l) => l.header)).toEqual(["Week no", "Channel"]);
    expect(p.plan.columns).toEqual([{ index: 0, metric: "skip" }, { index: 3, metric: "orders" }]);
  });
});

describe("other layouts", () => {
  it("reads months written as words, and rows that carry their own start and end", () => {
    const m = preview("Month,Orders\nJan 2026,30\nFeb 2026,28\nMar 2026,35\n");
    expect(m.cadence).toBe("month");
    expect(m.to).toBe("2026-03-31");
    const r = preview("Week,Enquiries\n05/10/2026 - 11/10/2026,4\n12/10/2026 - 18/10/2026,5\n");
    expect(r.cadence).toBe("week");
    expect(r.from).toBe("2026-10-05");
    expect(r.plan.cadence).toBe("ranges");
  });

  it("reads an Excel file with real dates the same way", () => {
    const x = makeXlsx([{ name: "Weekly", rows: [["Week", "Enquiries"], [{ date: serial("2026-10-05") }, 4], [{ date: serial("2026-10-12") }, 6], [{ date: serial("2026-10-19") }, 5]] }]);
    const p = previewTable(readTable(x, "n.xlsx"), { fileName: "n.xlsx", fileHash: "h".repeat(64) });
    expect(p.cadence).toBe("week");
    expect(p.from).toBe("2026-10-05");
    expect(p.headline).toMatch(/weekly enquiries/);
  });

  it("says a week can end on the date instead, when the header says so", () => {
    const p = preview("Week ending,Enquiries\n2026-10-11,4\n2026-10-18,5\n2026-10-25,6\n");
    expect(p.plan.weekAnchor).toBe("end");
    expect(p.from).toBe("2026-10-05");
    expect(p.to).toBe("2026-10-25");
  });

  it("adds up rows that share a date for counts, and tells the owner", () => {
    const p = preview("Date,Channel,Orders\n2026-10-01,Email,2\n2026-10-01,Social,3\n2026-10-02,Email,1\n");
    expect(p.duplicates).toBe(1);
    expect(p.sentences.join(" ")).toMatch(/appears? more than once/i);
    const s = buildSeries(table("Date,Channel,Orders\n2026-10-01,Email,2\n2026-10-01,Social,3\n2026-10-02,Email,1\n"), { dateColumn: 0, dateOrder: "dmy", cadence: "day", weekAnchor: "start", columns: [{ index: 2, metric: "orders" }] });
    expect(s.points.map((x) => [x.windowEnd, x.value])).toEqual([["2026-10-01", 5], ["2026-10-02", 1]]);
  });
});

describe("refusals", () => {
  it("refuses a file with no date column, in words", () => {
    const e = fail(() => preview("Product,Price\nTea,3\nCoffee,4\n"));
    expect(e.code).toBe("no_date");
    expect(e.message).toMatch(/couldn't find a date/i);
  });

  it("refuses a file with no number columns", () => {
    expect(fail(() => preview("Date,Note\n2026-10-01,hello\n2026-10-02,there\n")).code).toBe("no_numbers");
  });

  it("refuses personal columns by their header, and says which", () => {
    const e = fail(() => preview("Date,Customer email,Orders\n2026-10-01,a@example.com,3\n2026-10-02,b@example.com,4\n"));
    expect(e.code).toBe("personal");
    expect(e.message).toMatch(/Customer email/);
    expect(e.message).toMatch(/only need the numbers/i);
  });

  it("refuses an email or phone number hiding in any cell, and never echoes it", () => {
    const e = fail(() => preview("Date,Orders,Notes\n2026-10-01,3,call jane@example.com\n2026-10-02,4,fine\n"));
    expect(e.code).toBe("personal");
    expect(e.message).not.toMatch(/jane@example\.com/);
    expect(e.message).toMatch(/Notes/);
    expect(fail(() => preview("Date,Orders,Ref\n2026-10-01,3,sk-live-abcdef1234567890abcdef1234567890\n2026-10-02,4,x\n")).code).toBe("personal");
  });

  it("does not take a plain count for a phone number", () => {
    expect(() => preview("Date,Visits\n2026-10-01,9876543210\n2026-10-02,1234567890\n")).not.toThrow();
  });
});
