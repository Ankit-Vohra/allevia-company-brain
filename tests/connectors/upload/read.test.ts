// Reading the owner's file: CSV and XLSX into a table, with hard caps (size, rows, columns, what a zip may unpack to)
// and plain-words errors. No graph here.
import { describe, expect, it } from "vitest";
import { MAX_COLUMNS, MAX_FILE_BYTES, MAX_ROWS, UploadError } from "../../../src/connectors/upload/limits.js";
import { readTable } from "../../../src/connectors/upload/table.js";
import { makeBombXlsx, makeXlsx, serial } from "../../helpers/xlsx.js";

const csv = (s: string, name = "numbers.csv") => readTable(Buffer.from(s), name);
const fail = (fn: () => unknown): UploadError => {
  try { fn(); } catch (e) { return e as UploadError; }
  throw new Error("expected an UploadError");
};

describe("CSV", () => {
  it("reads a header and rows, trims, and keeps blanks as null", () => {
    const t = csv("Date,Visits,Orders\n2026-10-05, 120 ,3\n2026-10-06,,4\n");
    expect(t.headers).toEqual(["Date", "Visits", "Orders"]);
    expect(t.rows).toEqual([["2026-10-05", "120", "3"], ["2026-10-06", null, "4"]]);
  });

  it("handles a byte-order mark, CRLF, quotes, doubled quotes and a comma inside a quote", () => {
    const t = csv("﻿Date,Note,Orders\r\n2026-10-05,\"hello, \"\"world\"\"\",3\r\n");
    expect(t.headers[0]).toBe("Date");
    expect(t.rows[0]).toEqual(["2026-10-05", 'hello, "world"', "3"]);
  });

  it("sniffs semicolons and tabs", () => {
    expect(csv("Date;Orders\n2026-10-05;3\n").rows[0]).toEqual(["2026-10-05", "3"]);
    expect(csv("Date\tOrders\n2026-10-05\t3\n").rows[0]).toEqual(["2026-10-05", "3"]);
  });

  it("skips title lines above the header and empty rows below it", () => {
    const t = csv("Weekly report\n\nWeek,Enquiries,Orders\n2026-10-05,4,2\n\n2026-10-12,5,1\n");
    expect(t.headers).toEqual(["Week", "Enquiries", "Orders"]);
    expect(t.rows).toHaveLength(2);
  });

  it("reads UTF-16 text exported from Excel", () => {
    const body = "Date\tOrders\n2026-10-05\t3\n";
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, "utf16le")]);
    expect(readTable(buf, "x.txt").rows[0]).toEqual(["2026-10-05", "3"]);
  });

  it("goes by what the file is, not what it is called: a CSV saved as .xls is still text", () => {
    expect(readTable(Buffer.from("Date,Orders\n2026-10-05,3\n"), "numbers.xls").rows).toEqual([["2026-10-05", "3"]]);
    expect(readTable(Buffer.from("Date,Orders\n2026-10-05,3\n"), "numbers.xlsx").rows).toEqual([["2026-10-05", "3"]]);
  });

  it("says plainly when there is nothing to read", () => {
    expect(fail(() => csv("")).message).toMatch(/nothing in this file/i);
    expect(fail(() => csv("Date,Orders\n")).message).toMatch(/no rows/i);
  });
});

describe("XLSX", () => {
  it("reads strings, numbers and real dates (as ISO), and names the sheet", () => {
    const x = makeXlsx([{ name: "Weekly", rows: [["Week starting", "Enquiries"], [{ date: serial("2026-10-05") }, 4], [{ date: serial("2026-10-12") }, 6.5]] }]);
    const t = readTable(x, "numbers.xlsx");
    expect(t.sheet).toBe("Weekly");
    expect(t.headers).toEqual(["Week starting", "Enquiries"]);
    expect(t.rows).toEqual([["2026-10-05", 4], ["2026-10-12", 6.5]]);
  });

  it("reads the 1904 date system", () => {
    const x = makeXlsx([{ name: "S", rows: [["Date", "Orders"], [{ date: serial("2026-10-05") - 1462 }, 3]] }], { date1904: true });
    expect(readTable(x, "a.xlsx").rows[0]![0]).toBe("2026-10-05");
  });

  it("uses the first sheet that has data and lists the others", () => {
    const x = makeXlsx([{ name: "Cover", rows: [["Notes"]] }, { name: "Data", rows: [["Date", "Orders"], ["2026-10-05", 3]] }, { name: "Spare", rows: [["a", "b"], ["c", 1]] }]);
    const t = readTable(x, "a.xlsx");
    expect(t.sheet).toBe("Data");
    expect(t.otherSheets).toEqual(["Cover", "Spare"]);
  });

  it("refuses an old .xls and a password-protected file in plain words", () => {
    const xls = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)]);
    expect(fail(() => readTable(xls, "old.xls")).message).toMatch(/old Excel format|Save As/i);
    expect(fail(() => readTable(Buffer.from("PK\u0003\u0004 not really"), "broken.xlsx")).message).toMatch(/couldn't open|could not open|isn't a spreadsheet/i);
  });
});

describe("caps", () => {
  it("refuses a file over the size cap before reading it", () => {
    const big = Buffer.alloc(MAX_FILE_BYTES + 1, 0x61);
    expect(fail(() => readTable(big, "big.csv")).message).toMatch(/under 20 MB/);
  });

  it("refuses more rows than the cap, in words", () => {
    const rows = Array.from({ length: MAX_ROWS + 5 }, (_, i) => `2026-01-01,${i}`).join("\n");
    const e = fail(() => csv(`Date,Orders\n${rows}\n`));
    expect(e.message).toMatch(/more than 50,000 rows/);
    expect(e.code).toBe("too_many_rows");
  });

  it("refuses too many columns", () => {
    const head = Array.from({ length: MAX_COLUMNS + 1 }, (_, i) => `c${i}`).join(",");
    expect(fail(() => csv(`${head}\n${head}\n`)).message).toMatch(/columns/);
  });

  it("does not unpack a zip bomb: the unpacked size is capped, with a plain error", () => {
    const bomb = makeBombXlsx(80 * 1024 * 1024); // 80 MB of zeros in a few KB
    expect(bomb.length).toBeLessThan(200_000);
    expect(fail(() => readTable(bomb, "bomb.xlsx")).message).toMatch(/too big once opened|too large once opened/i);
  });
});
