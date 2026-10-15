import { describe, it, expect } from "vitest";
import { idPrefix, entityId, typeFromId } from "../../src/util/ids.js";
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
    expect(ENTITY_TYPES).toHaveLength(38);
    expect(types.has("Finding")).toBe(true);
    expect(isAllowed("Turn", "HANDLED_BY", "Agent") && isAllowed("Agent", "PRODUCED", "Finding") && isAllowed("Finding", "BASED_ON", "Finding")).toBe(true);
    expect(types.has("Version") && types.has("Chunk") && types.has("Observation")).toBe(true);
    for (const r of ["OWNS", "BASED_ON", "SUPERSEDES", "SOURCED_FROM", "MEASURES", "HAD_VERSION", "CONTRADICTS", "LEARNED_FROM"]) {
      expect(rels.has(r), r).toBe(true);
    }
    expect(ONTOLOGY_VERSION).toBe(2);
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

describe("schema v2 (product design §7)", () => {
  const NEW_TYPES = ["Goal", "Program", "Checkpoint", "Asset", "Capability"] as const;
  const NEW_RELS = ["PURSUES", "TRACKS", "ADVANCES", "ENROLLED_IN", "DERIVED_FROM", "USES_ASSET", "DEPICTS", "GUIDED_BY"] as const;

  it("is version 2", () => {
    expect(ONTOLOGY_VERSION).toBe(2);
  });
  it("adds the five node labels, each with a type-prefixed id that maps back", () => {
    for (const t of NEW_TYPES) {
      expect(isEntityType(t), t).toBe(true);
      expect(idPrefix(t)).toBe(t.toLowerCase());
      expect(typeFromId(entityId(t, "Visibility 90 days"))).toBe(t);
    }
    expect(entityId("Goal", "More enquiries")).toBe("goal:more-enquiries");
    // the ids of the old types are untouched, and "obs" is still the Observation prefix
    expect(typeFromId("brand-rule:x")).toBe("BrandRule");
    expect(typeFromId("obs:m:s:2026-10-15")).toBe("Observation");
  });
  it("adds the eight relationship types, each with at least one pattern", () => {
    for (const r of NEW_RELS) {
      expect(isRelType(r), r).toBe(true);
      expect(ALLOWED_PATTERNS.some((p) => p[1] === r), r).toBe(true);
    }
  });
  it("allows the new relationship patterns (§7.3)", () => {
    expect(isAllowed("Business", "PURSUES", "Goal")).toBe(true);
    expect(isAllowed("Goal", "TRACKS", "Metric")).toBe(true);
    for (const from of ["Recommendation", "Content", "Task", "Approval", "Campaign"] as const) {
      expect(isAllowed(from, "ADVANCES", "Goal"), from).toBe(true);
    }
    expect(isAllowed("Business", "ENROLLED_IN", "Program")).toBe(true);
    expect(isAllowed("Asset", "DERIVED_FROM", "Asset")).toBe(true);
    expect(isAllowed("Content", "USES_ASSET", "Asset")).toBe(true);
    for (const to of ["Product", "Page", "Business", "Event"] as const) expect(isAllowed("Asset", "DEPICTS", to), to).toBe(true);
    for (const from of ["Turn", "Finding", "Content"] as const) {
      for (const to of ["Memory", "Rule", "BrandRule"] as const) expect(isAllowed(from, "GUIDED_BY", to), `${from} ${to}`).toBe(true);
    }
  });
  it("allows the extended patterns (§7.4)", () => {
    expect(isAllowed("Goal", "PART_OF", "Program")).toBe(true);
    expect(isAllowed("Checkpoint", "PART_OF", "Program")).toBe(true);
    expect(isAllowed("Capability", "PART_OF", "Business")).toBe(true);
    expect(isAllowed("Capability", "DEPENDS_ON", "Channel")).toBe(true);
    expect(isAllowed("Capability", "DEPENDS_ON", "System")).toBe(true);
    expect(isAllowed("Agent", "USES", "Capability")).toBe(true);
    expect(isAllowed("Person", "AUTHORED", "Asset")).toBe(true);
    expect(isAllowed("Agent", "PRODUCED", "Asset") && isAllowed("Agent", "PRODUCED", "Task")).toBe(true);
    expect(isAllowed("Agent", "REVIEWED", "Asset")).toBe(true);
    expect(isAllowed("Goal", "SUPERSEDES", "Goal")).toBe(true);
    expect(isAllowed("Agent", "OWNS", "Goal") && isAllowed("Person", "OWNS", "Goal") && isAllowed("Team", "OWNS", "Goal")).toBe(true);
    // numbers stay Observations: they measure goals, assets and checkpoints
    for (const t of ["Goal", "Asset", "Checkpoint"] as const) expect(isAllowed("Observation", "MEASURES", t), t).toBe(true);
    // what already held still holds
    expect(isAllowed("Agent", "USES", "System") && isAllowed("Agent", "PRODUCED", "Finding") && isAllowed("Agent", "REVIEWED", "Content")).toBe(true);
  });
  it("rejects the wrong shapes", () => {
    expect(isAllowed("Goal", "PURSUES", "Business")).toBe(false);          // wrong direction
    expect(isAllowed("Person", "PURSUES", "Goal")).toBe(false);            // only a Business pursues
    expect(isAllowed("Goal", "TRACKS", "Observation")).toBe(false);        // a goal tracks a Metric; the number is an Observation
    expect(isAllowed("Page", "ADVANCES", "Goal")).toBe(false);
    expect(isAllowed("Recommendation", "ADVANCES", "Metric")).toBe(false);
    expect(isAllowed("Business", "ENROLLED_IN", "Goal")).toBe(false);
    expect(isAllowed("Person", "ENROLLED_IN", "Program")).toBe(false);
    expect(isAllowed("Asset", "DERIVED_FROM", "Content")).toBe(false);
    expect(isAllowed("Content", "DERIVED_FROM", "Asset")).toBe(false);
    expect(isAllowed("Asset", "USES_ASSET", "Content")).toBe(false);
    expect(isAllowed("Asset", "DEPICTS", "Person")).toBe(false);
    expect(isAllowed("Task", "GUIDED_BY", "Rule")).toBe(false);
    expect(isAllowed("Turn", "GUIDED_BY", "Document")).toBe(false);
    expect(isAllowed("Goal", "PART_OF", "Business")).toBe(false);
    expect(isAllowed("Program", "PART_OF", "Goal")).toBe(false);
    expect(isAllowed("Capability", "PART_OF", "Program")).toBe(false);
    expect(isAllowed("Capability", "DEPENDS_ON", "Page")).toBe(false);
    expect(isAllowed("Person", "USES", "Capability")).toBe(false);
    expect(isAllowed("Agent", "AUTHORED", "Asset")).toBe(false);           // people author assets; agents PRODUCE them
    expect(isAllowed("Person", "PRODUCED", "Asset")).toBe(false);
    expect(isAllowed("Person", "REVIEWED", "Asset")).toBe(false);
    expect(isAllowed("Goal", "SUPERSEDES", "Program")).toBe(false);        // same-type rule
  });
  it("keeps SUPERSEDES same-type for goals", () => {
    const goal = ALLOWED_PATTERNS.filter((p) => p[1] === "SUPERSEDES" && (p[0] === "Goal" || p[2] === "Goal"));
    expect(goal).toEqual([["Goal", "SUPERSEDES", "Goal"]]);
  });
  it("makes TRACKS, ENROLLED_IN and DERIVED_FROM functional on the source", () => {
    expect(functionalRule("TRACKS", "Goal", "Metric")).toEqual(expect.objectContaining({ rel: "TRACKS", key: "from" }));
    expect(functionalRule("ENROLLED_IN", "Business", "Program")).toEqual(expect.objectContaining({ rel: "ENROLLED_IN", key: "from" }));
    expect(functionalRule("DERIVED_FROM", "Asset", "Asset")).toEqual(expect.objectContaining({ rel: "DERIVED_FROM", key: "from" }));
    // the others stay many-to-many
    for (const r of ["PURSUES", "ADVANCES", "USES_ASSET", "DEPICTS", "GUIDED_BY"] as const) {
      expect(FUNCTIONAL_RELS.some((f) => f.rel === r), r).toBe(false);
    }
    // the rule applies to its own source type only
    expect(functionalRule("DERIVED_FROM", "Content", "Asset")).toBeUndefined();
  });
  it("tracks the new and extended props (§7.1, §7.2)", () => {
    expect(TRACKED_PROPS.Goal).toEqual(["status", "target"]);
    expect(TRACKED_PROPS.Program).toEqual(["status", "guaranteeState"]);
    expect(TRACKED_PROPS.Asset).toEqual(["status"]);
    expect(TRACKED_PROPS.Capability).toEqual(["accessMode", "status"]);
    expect(TRACKED_PROPS.Checkpoint).toBeUndefined();
    expect(TRACKED_PROPS.Business).toEqual(["country", "currency", "locale", "timeZone", "designStyle", "templateKey"]);
    expect(TRACKED_PROPS.Business).not.toContain("privacyRegime");
    expect(TRACKED_PROPS.Business).not.toContain("vertical");
    expect(TRACKED_PROPS.Agent).toEqual(["enabled", "mode", "autonomy"]);
    expect(TRACKED_PROPS.Rule).toEqual(["status"]);
    expect(TRACKED_PROPS.Approval).toEqual(["status"]);
  });
  it("searches Goals only", () => {
    expect(SEARCHABLE).toContain("Goal");
    for (const t of ["Program", "Checkpoint", "Asset", "Capability"] as const) expect(SEARCHABLE, t).not.toContain(t);
  });
});
