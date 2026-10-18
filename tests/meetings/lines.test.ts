// The lines of a call: numbered for Memory Keeper, split into speakers, and matched back to each decision and action.
import { describe, expect, it } from "vitest";
import { bestLine, callLines, linesFor, numberedNotes } from "../../src/meetings/lines.js";

const NOTES = [
  "Sample transcript (made up for the demo, nobody real)",
  "On the call: Ritika Menon, Aman Shetty",
  "",
  "The recorder's summary: the reorder coupon fails at checkout.",
  "Aman Shetty: The KETTLE10 coupon failed at checkout on the reorder link.",
  "Wholesale lead: We will get the wholesale checkout fixed by Wednesday.",
  "Ritika Menon: I will send our GST details for the invoices by Monday.",
].join("\n");

describe("callLines", () => {
  it("numbers the non-empty lines and names the speaker, not the headings", () => {
    const ls = callLines(NOTES);
    expect(ls).toHaveLength(6);
    expect(ls.map((l) => l.speaker ?? null)).toEqual([null, null, null, "Aman Shetty", "Wholesale lead", "Ritika Menon"]);
    expect(ls[3]).toMatchObject({ ord: 4, text: "Aman Shetty: The KETTLE10 coupon failed at checkout on the reorder link." });
  });
  it("shows Memory Keeper the same numbers", () => {
    const n = numberedNotes(NOTES).split("\n");
    expect(n[0]).toBe("1| Sample transcript (made up for the demo, nobody real)");
    expect(n[2]).toBe("");
    expect(n[4]).toBe("4| Aman Shetty: The KETTLE10 coupon failed at checkout on the reorder link.");
  });
});

describe("which line an item came from", () => {
  const ls = callLines(NOTES);
  it("takes the lines Memory Keeper named, when they exist", () => {
    expect(linesFor({ text: "anything", lines: [6, 99, 6] }, ls)).toEqual([6]);
  });
  it("else the line sharing the most words, a spoken line over the recorder's summary", () => {
    expect(linesFor({ text: "Fix the reorder coupon at checkout" }, ls)).toEqual([4]);
    expect(bestLine("Send the GST details for the invoices", ls, "Ritika Menon")).toBe(6);
    expect(linesFor({ text: "Book the delivery van" }, ls)).toEqual([]);
  });
});
