// The same upload as chat text, for Discord: what we found, and one owner reply applied to the plan.
import { describe, expect, it } from "vitest";
import { previewTable } from "../../../src/connectors/upload/analyse.js";
import { readTable } from "../../../src/connectors/upload/table.js";
import { applyReply, describePreview } from "../../../src/connectors/upload/text.js";

const preview = (csv: string) => previewTable(readTable(Buffer.from(csv), "n.csv"), { fileName: "n.csv", fileHash: "h" });

describe("upload as chat text", () => {
  const p = preview("Date,Orders,Pints sold,Calls\n2026-10-01,3,30,2\n2026-10-02,4,41,3\n2026-10-03,5,50,1\n");

  it("says what it found and asks for what is missing", () => {
    const t = describePreview(p);
    expect(t).toContain("This looks like daily orders and");
    expect(t).toContain("Column B “Orders”: Orders");
    expect(t).toContain("Column C “Pints sold”: I'm not sure what this is");
    expect(t).toContain("Column D “Calls”: Calls and directions from Google (not sure)");
    expect(t).toMatch(/Tell me what is missing/);
  });

  it("applies one reply at a time and never guesses past it", () => {
    const named = applyReply(p.plan, "column C is pints sold")!;
    expect(named.columns.find((c) => c.index === 2)).toEqual({ index: 2, metric: "other", label: "pints sold" });
    const known = applyReply(p.plan, "D is website visits")!;
    expect(known.columns.find((c) => c.index === 3)?.metric).toBe("ga4_sessions");
    const skipped = applyReply(p.plan, "leave out C")!;
    expect(skipped.columns.find((c) => c.index === 2)?.metric).toBe("skip");
    expect(applyReply(p.plan, "each row is a week")!.cadence).toBe("week");
    expect(applyReply(p.plan, "dates are month first")!.dateOrder).toBe("mdy");
    expect(applyReply(p.plan, "thanks!")).toBeNull();
    expect(p.plan.columns.find((c) => c.index === 2)?.metric).toBeNull(); // the original is untouched
  });
});
