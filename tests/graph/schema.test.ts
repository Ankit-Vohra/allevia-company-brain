import { describe, it, expect } from "vitest";
import {
  ENTITY_TYPES, REL_TYPES, ALLOWED_PATTERNS, FUNCTIONAL_RELS, TRACKED_PROPS, SEARCHABLE, ONTOLOGY_VERSION,
  isAllowed, functionalRule, isEntityType, isRelType,
} from "../../src/graph/schema.js";

const types = new Set<string>(ENTITY_TYPES);
const rels = new Set<string>(REL_TYPES);

describe("schema", () => {
  it("every pattern uses known types", () => {
    for (const [from, rel, to] of ALLOWED_PATTERNS) {
      expect(from === "*" || types.has(from), `${from} ${rel} ${to}`).toBe(true);
      expect(rels.has(rel), rel).toBe(true);
      expect(to === "*" || types.has(to), `${from} ${rel} ${to}`).toBe(true);
    }
  });
  it("every relationship type has at least one pattern", () => {
    const used = new Set(ALLOWED_PATTERNS.map((p) => p[1]));
    expect(REL_TYPES.filter((r) => !used.has(r))).toEqual([]);
  });
  it("has the spec's types", () => {
    expect(ENTITY_TYPES).toHaveLength(33);
    expect(types.has("Finding")).toBe(true);
    expect(isAllowed("Turn", "HANDLED_BY", "Agent") && isAllowed("Agent", "PRODUCED", "Finding") && isAllowed("Finding", "BASED_ON", "Finding")).toBe(true);
    expect(types.has("Version") && types.has("Chunk") && types.has("Observation")).toBe(true);
    for (const r of ["OWNS", "BASED_ON", "SUPERSEDES", "SOURCED_FROM", "MEASURES", "HAD_VERSION", "CONTRADICTS", "LEARNED_FROM"]) {
      expect(rels.has(r), r).toBe(true);
    }
    expect(ONTOLOGY_VERSION).toBe(1);
    expect(isEntityType("Task") && !isEntityType("Url") && isRelType("OWNS") && !isRelType("owns")).toBe(true);
  });
  it("checks patterns", () => {
    expect(isAllowed("Decision", "BASED_ON", "Observation")).toBe(true);
    expect(isAllowed("Page", "DECIDED", "Person")).toBe(false);
    expect(isAllowed("Task", "SOURCED_FROM", "Document")).toBe(true); // '*' on the left
    expect(isAllowed("Document", "MENTIONS", "Campaign")).toBe(true); // '*' on the right
    expect(isAllowed("Agent", "OWNS", "Task")).toBe(true);
    expect(isAllowed("Task", "OWNS", "Person")).toBe(false);
    expect(isAllowed("Recommendation", "PROPOSES", "Approval")).toBe(true);
    expect(isAllowed("Approval", "APPROVED_BY", "Agent")).toBe(true);
  });
  it("describes functional relationships", () => {
    expect(functionalRule("OWNS", "Person", "Task")).toEqual(expect.objectContaining({ rel: "OWNS", key: "to" }));
    expect(functionalRule("OWNS", "Person", "System")).toBeUndefined();
    expect(functionalRule("SUPERSEDES", "Decision", "Decision")).toEqual(expect.objectContaining({ key: "to" }));
    expect(functionalRule("MENTIONS", "Document", "Task")).toBeUndefined();
    for (const f of FUNCTIONAL_RELS) expect(rels.has(f.rel)).toBe(true);
  });
  it("tracks the listed props and keeps chunks/versions out of search", () => {
    expect(TRACKED_PROPS.Task).toEqual(["status", "title", "name"]);
    expect(TRACKED_PROPS.Page).toEqual(["title", "statusCode", "metaDescription", "name"]);
    // the display title lives in `name`, so wherever `title` is tracked, renames are too
    for (const [t, props] of Object.entries(TRACKED_PROPS)) if (props.includes("title")) expect(props, t).toContain("name");
    expect(SEARCHABLE).toContain("Decision");
    expect(SEARCHABLE).not.toContain("Chunk");
    expect(SEARCHABLE).not.toContain("Version");
    for (const t of SEARCHABLE) expect(types.has(t)).toBe(true);
  });
});
