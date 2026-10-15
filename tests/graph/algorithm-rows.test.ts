// A per-node algorithm (PageRank, betweenness, ...) can hand back a NaN or an Infinity for a node (0 / 0 on one with
// no edges). Such a score has no rank: it must not reach the JS sort (a NaN makes the comparator inconsistent) nor the
// librarian's `rank` write (the client refuses a non-finite number, which would abort the whole run).
import { describe, it, expect } from "vitest";
import { finiteRows } from "../../src/graph/algorithms.js";

describe("finiteRows", () => {
  it("keeps finite scores in order", () => {
    expect(finiteRows([["a", 0.5], ["b", 0], ["c", -2]])).toEqual([["a", 0.5], ["b", 0], ["c", -2]]);
  });

  it("drops NaN, Infinity, -Infinity, and anything that is not a number", () => {
    const rows = [["a", 1], ["b", Number.NaN], ["c", Number.POSITIVE_INFINITY], ["d", Number.NEGATIVE_INFINITY], ["e", null as unknown as number], ["f", 2]] as Array<[string, number]>;
    expect(finiteRows(rows)).toEqual([["a", 1], ["f", 2]]);
  });

  it("returns nothing for an empty result", () => {
    expect(finiteRows([])).toEqual([]);
  });
});
