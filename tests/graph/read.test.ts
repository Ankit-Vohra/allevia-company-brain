import { describe, it, expect } from "vitest";
import { currentEdge, edgeValidAt, toNodeRef, toPathResult, shapeValue, isRawNode, isRawPath } from "../../src/graph/read.js";

const rawPath = {
  nodes: [
    { id: 7, labels: ["Entity", "Person"], properties: { id: "person:founder", name: "Founder", embedding: [0.1, 0.2] } },
    { id: 9, labels: ["Entity", "Task"], properties: { id: "task:a", name: "A", asOf: "2026-10-14", simulated: true } },
  ],
  edges: [{ id: 3, sourceId: 7, destinationId: 9, relationshipType: "OWNS", properties: { since: 5, closedCost: 1 } }],
};

describe("read helpers", () => {
  it("builds current-edge predicates", () => {
    expect(currentEdge("r")).toBe("r.until IS NULL");
    expect(currentEdge("r", "asOf")).toBe("(r.since IS NULL OR r.since <= $asOf) AND (r.until IS NULL OR r.until > $asOf)");
    expect(() => currentEdge("r) OR (1=1")).toThrow();
    expect(() => currentEdge("r", "a b")).toThrow();
  });
  it("evaluates edge validity in JS the same way", () => {
    expect(edgeValidAt({})).toBe(true);
    expect(edgeValidAt({ until: 10 })).toBe(false);
    expect(edgeValidAt({ since: 5, until: 10 }, 7)).toBe(true);
    expect(edgeValidAt({ since: 5, until: 10 }, 10)).toBe(false);
    expect(edgeValidAt({ since: 8 }, 7)).toBe(false);
  });
  it("converts raw nodes and paths into refs", () => {
    expect(isRawNode(rawPath.nodes[0])).toBe(true);
    expect(isRawPath(rawPath)).toBe(true);
    expect(toNodeRef(rawPath.nodes[1]!)).toEqual({ id: "task:a", label: "Task", name: "A", asOf: "2026-10-14", simulated: true });
    expect(toPathResult(rawPath)).toEqual({
      nodes: [{ id: "person:founder", label: "Person", name: "Founder" }, { id: "task:a", label: "Task", name: "A", asOf: "2026-10-14", simulated: true }],
      edges: [{ from: "person:founder", type: "OWNS", to: "task:a", since: 5, until: null }],
      length: 1,
    });
  });
  it("shapes query rows: nodes and paths become refs, vectors are dropped", () => {
    const row = { n: rawPath.nodes[0], p: rawPath, xs: [rawPath.nodes[1]], k: 3, r: rawPath.edges[0] };
    expect(shapeValue(row)).toEqual({
      n: { id: "person:founder", label: "Person", name: "Founder" },
      p: toPathResult(rawPath),
      xs: [toNodeRef(rawPath.nodes[1]!)],
      k: 3,
      r: { type: "OWNS", since: 5 },
    });
  });
});
