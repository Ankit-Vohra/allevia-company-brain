// Ontology (spec §5): node labels, relationship types, which (from, rel, to) triples are legal, which relationships
// are functional, and which properties keep a version history. Writes are validated against this; the extraction
// JSON schema is built from it. Bump ONTOLOGY_VERSION when a change needs re-ingestion.

// v2 (product design §7): Goal, Program, Checkpoint, Asset, Capability, their relationships (PURSUES, TRACKS, ADVANCES,
// ENROLLED_IN, DERIVED_FROM, USES_ASSET, DEPICTS, GUIDED_BY), and the extended patterns that tie them to the rest.
export const ONTOLOGY_VERSION = 2;

// Every node also carries the base label `Entity` (so `MATCH (n:Entity {id})` finds anything, Chunks and Versions
// included). The type label is the one that is not `Entity`.
export const ENTITY_TYPES = [
  "Business", "Person", "Agent", "Team", "Product", "Feature", "Audience", "Need", "BrandRule", "BrandAsset",
  "Channel", "Content", "Campaign", "Page", "Query", "Metric", "Observation", "Document", "Chunk", "Decision", "Task",
  "System", "Event", "Playbook", "Rule", "Recommendation", "Approval", "Action", "Session", "Turn", "Memory", "Version",
  // the agent company: one Finding per agent step-result inside a Turn (founder 2026-10-15: "every agent is visible")
  "Finding",
  // product design §7.1: what the owner is pursuing, the Allevia 90 program and its day 0/30/60/90 checkpoints, media
  // (originals, variants, finals), and what each connected source lets the agents do (the capability ladder)
  "Goal", "Program", "Checkpoint", "Asset", "Capability",
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const REL_TYPES = [
  // company
  "MEMBER_OF", "OWNS", "KNOWS_ABOUT", "AUTHORED", "DECIDED", "BASED_ON", "SUPERSEDES", "AFFECTS", "DEPENDS_ON", "BLOCKS",
  "PART_OF",
  // knowledge
  "MENTIONS", "LINKS_TO", "SOURCED_FROM", "HAS_CHUNK",
  // market
  "TARGETS", "HAS_NEED", "SOLVES", "PUBLISHED_ON", "PROMOTES", "LINKS_TO_PAGE", "RANKS_FOR", "USES_RULE", "MEASURES",
  // procedural
  "INCLUDES", "APPLIES_TO", "FAILS", "PASSES", "LEARNED_FROM",
  // action layer
  "PROPOSES", "EVIDENCED_BY", "APPROVED_BY", "REJECTED_BY", "RESULTED_IN",
  // memory
  "ASKED", "IN_SESSION", "TOUCHED", "CITED", "ABOUT", "STATED", "HAD_VERSION", "CONTRADICTS",
  // agent company (multi-agent shared state)
  "HANDLED_BY", "PRODUCED", "REVIEWED",
  // who uses which tool/system (registry: agents using connectors and skills)
  "USES",
  // goals, program, media and guidance (product design §7.3)
  "PURSUES", "TRACKS", "ADVANCES", "ENROLLED_IN", "DERIVED_FROM", "USES_ASSET", "DEPICTS", "GUIDED_BY",
  // the librarian's merge pass: a duplicate System/Channel/Product points at the node it is the same as
  "SAME_AS",
] as const;
export type RelType = (typeof REL_TYPES)[number];

type End = EntityType | "*";
export type Pattern = [End, RelType, End];

// Expand "any of these sources, any of these targets" into flat triples.
function pat(from: End | End[], rel: RelType, to: End | End[]): Pattern[] {
  const fs = Array.isArray(from) ? from : [from];
  const ts = Array.isArray(to) ? to : [to];
  return fs.flatMap((f) => ts.map((t): Pattern => [f, rel, t]));
}

const ACTORS: EntityType[] = ["Person", "Agent"];
const OWNERS: EntityType[] = ["Person", "Agent", "Team", "Business"];
const OWNABLE: EntityType[] = [
  "Task", "System", "Channel", "Product", "Feature", "Decision", "Campaign", "Page", "Document", "Playbook", "Metric",
  "BrandAsset", "Content", "Goal",
];
const EVIDENCE: EntityType[] = ["Observation", "Document", "Chunk", "Memory", "Event", "Decision"];

export const ALLOWED_PATTERNS: Pattern[] = [
  // company
  ...pat(["Person", "Agent", "Team"], "MEMBER_OF", ["Team", "Business"]),
  ...pat(OWNERS, "OWNS", OWNABLE),
  ...pat([...ACTORS, "Team"], "KNOWS_ABOUT", "*"),
  ...pat(ACTORS, "AUTHORED", ["Document", "Content", "Decision", "Playbook", "Rule"]),
  ...pat("Person", "AUTHORED", "Asset"),
  ...pat([...ACTORS, "Team"], "DECIDED", "Decision"),
  ...pat("Decision", "BASED_ON", [...EVIDENCE, "Recommendation"]),
  ...pat("Recommendation", "BASED_ON", [...EVIDENCE, "Rule", "Metric", "Content", "Page", "Campaign"]),
  ...pat(["Decision", "Rule", "BrandRule", "Recommendation", "Document", "Memory", "Playbook", "Goal"], "SUPERSEDES",
    ["Decision", "Rule", "BrandRule", "Recommendation", "Document", "Memory", "Playbook", "Goal"]).filter((p) => p[0] === p[2]),
  ...pat(["Decision", "Event", "Action", "Task", "Recommendation"], "AFFECTS", "*"),
  ...pat("System", "DEPENDS_ON", "System"),
  ...pat("Channel", "DEPENDS_ON", ["System", "Channel"]),
  ...pat("Capability", "DEPENDS_ON", ["Channel", "System"]),
  ...pat("Task", "DEPENDS_ON", ["Task", "System", "Decision"]),
  ...pat(["Product", "Feature"], "DEPENDS_ON", ["System", "Feature"]),
  ...pat("Campaign", "DEPENDS_ON", ["Channel", "Page", "Content"]),
  ...pat(["Task", "System", "Event", "Decision"], "BLOCKS", "Task"),
  ...pat("Task", "BLOCKS", "Decision"),
  ...pat("Feature", "PART_OF", "Product"),
  ...pat("Page", "PART_OF", ["Channel", "Page"]),
  ...pat("Content", "PART_OF", "Campaign"),
  ...pat("Task", "PART_OF", ["Task", "Campaign"]),
  ...pat("Team", "PART_OF", ["Team", "Business"]),
  ...pat(["Product", "Channel"], "PART_OF", "Business"),
  ...pat("System", "PART_OF", "System"),
  ...pat(["Goal", "Checkpoint"], "PART_OF", "Program"),
  ...pat("Capability", "PART_OF", "Business"),
  // knowledge
  ...pat(["Document", "Chunk", "Content", "Task"], "MENTIONS", "*"),
  ...pat(["Document", "Chunk"], "LINKS_TO", ["Document", "Page"]),
  ...pat("*", "SOURCED_FROM", "Document"),
  ...pat("Document", "HAS_CHUNK", "Chunk"),
  // market
  ...pat(["Business", "Product", "Feature", "Content", "Campaign", "Page", "Channel"], "TARGETS", "Audience"),
  ...pat(["Page", "Content", "Campaign"], "TARGETS", "Query"),
  ...pat("Audience", "HAS_NEED", "Need"),
  ...pat(["Product", "Feature", "Page", "Content"], "SOLVES", "Need"),
  ...pat(["Content", "Page", "Campaign"], "PUBLISHED_ON", "Channel"),
  ...pat(["Content", "Campaign", "Page"], "PROMOTES", ["Product", "Feature", "Page", "Business", "Content"]),
  ...pat(["Content", "Page", "Campaign", "Channel", "Document"], "LINKS_TO_PAGE", "Page"),
  ...pat(["Page", "Content"], "RANKS_FOR", "Query"),
  ...pat(["Content", "Page", "Campaign"], "USES_RULE", ["Rule", "BrandRule"]),
  ...pat("Observation", "MEASURES", "*"),
  // procedural
  ...pat("Playbook", "INCLUDES", ["Rule", "Playbook"]),
  ...pat(["Rule", "Playbook", "BrandRule"], "APPLIES_TO", "*"),
  ...pat(["Page", "Content", "Campaign", "Channel"], "FAILS", ["Rule", "BrandRule"]),
  ...pat(["Page", "Content", "Campaign", "Channel"], "PASSES", ["Rule", "BrandRule"]),
  ...pat(["Rule", "BrandRule", "Memory"], "LEARNED_FROM", "Approval"),
  // action layer
  ...pat("Recommendation", "PROPOSES", "Approval"),
  ...pat("Recommendation", "EVIDENCED_BY", "*"),
  ...pat("Approval", "APPROVED_BY", ACTORS),
  ...pat("Approval", "REJECTED_BY", ACTORS),
  ...pat("Approval", "RESULTED_IN", "Action"),
  ...pat("Action", "RESULTED_IN", ["Task", "Content", "Document", "Campaign", "Observation", "Event", "Page"]),
  // memory
  ...pat(ACTORS, "ASKED", "Turn"),
  ...pat("Turn", "IN_SESSION", "Session"),
  ...pat("Turn", "TOUCHED", "*"),
  ...pat("Turn", "CITED", "*"),
  ...pat("Memory", "ABOUT", "*"),
  ...pat(ACTORS, "STATED", "Memory"),
  ...pat("*", "HAD_VERSION", "Version"),
  ...pat("*", "CONTRADICTS", "*"),
  // agent company: a Turn is handled by agents; each agent PRODUCES Findings (its share of the work, with citations);
  // reviewers REVIEW them; a Finding can build on another agent's Finding (the handoff, visible as BASED_ON).
  ...pat("Turn", "HANDLED_BY", "Agent"),
  // Rule: a learned rule is PRODUCED by the copy editor that distilled it from the owner's edit (product design §9.3).
  ...pat("Agent", "PRODUCED", ["Finding", "Recommendation", "Content", "Document", "Asset", "Task", "Rule"]),
  ...pat("Agent", "REVIEWED", ["Finding", "Content", "Recommendation", "Asset"]),
  ...pat("Finding", "PART_OF", "Turn"),
  ...pat("Finding", "CITED", "*"),
  ...pat("Finding", "BASED_ON", ["Finding", ...EVIDENCE]),
  ...pat("Recommendation", "BASED_ON", "Finding"),
  ...pat(["Person", "Agent", "Team", "Business", "System"], "USES", ["System", "Channel", "Playbook", "Rule"]),
  ...pat("Agent", "USES", "Capability"),
  // goals, program, media and guidance (product design §7.3). Numbers stay Observations: MEASURES (Observation -> *)
  // already reaches a Goal, an Asset or a Checkpoint.
  ...pat("Business", "PURSUES", "Goal"),
  ...pat("Goal", "TRACKS", "Metric"),
  ...pat(["Recommendation", "Content", "Task", "Approval", "Campaign"], "ADVANCES", "Goal"),
  ...pat("Business", "ENROLLED_IN", "Program"),
  ...pat("Asset", "DERIVED_FROM", "Asset"), // edge props: step, treatment
  ...pat("Content", "USES_ASSET", "Asset"),
  ...pat("Asset", "DEPICTS", ["Product", "Page", "Business", "Event"]),
  ...pat(["Turn", "Finding", "Content"], "GUIDED_BY", ["Memory", "Rule", "BrandRule"]),
  // the librarian's merge pass (src/ingest/merge.ts): same type only, duplicate -> canonical
  ...pat("System", "SAME_AS", "System"),
  ...pat("Channel", "SAME_AS", "Channel"),
  ...pat("Product", "SAME_AS", "Product"),
];

const ALLOWED = new Set(ALLOWED_PATTERNS.map(([f, r, t]) => `${f}|${r}|${t}`));

export function isAllowed(from: EntityType, rel: RelType, to: EntityType): boolean {
  return [from, "*"].some((f) => [to, "*"].some((t) => ALLOWED.has(`${f}|${rel}|${t}`)));
}

// Functional relationships: at most one CURRENT edge per slot. When a new edge arrives for an occupied slot, upsertEdge
// closes the old one (until + retiredAt) instead of deleting it.
//   key 'to'   - the target is the slot: "a Task has one current owner" (any OWNS edge into the same Task).
//   key 'from' - the source is the slot: "X has one current <rel> target" (any <rel> edge out of the same X).
// fromType/toType restrict when the rule applies (OWNS is functional only when the target is a Task).
export interface FunctionalRule {
  rel: RelType;
  fromType?: EntityType;
  toType?: EntityType;
  key: "to" | "from";
  why: string;
}

export const FUNCTIONAL_RELS: FunctionalRule[] = [
  { rel: "OWNS", toType: "Task", key: "to", why: "a task has one current owner" },
  { rel: "SUPERSEDES", key: "to", why: "a decision (or rule, doc…) is superseded by at most one successor" },
  { rel: "IN_SESSION", fromType: "Turn", key: "from", why: "a turn belongs to one session" },
  { rel: "TRACKS", fromType: "Goal", key: "from", why: "a goal is measured by one metric" },
  { rel: "ENROLLED_IN", fromType: "Business", key: "from", why: "a business is in one current program" },
  { rel: "DERIVED_FROM", fromType: "Asset", key: "from", why: "an asset has one parent: the one it was made from" },
  { rel: "SAME_AS", key: "from", why: "a duplicate is the same as one canonical node" },
];

export function functionalRule(rel: RelType, fromType: EntityType, toType: EntityType): FunctionalRule | undefined {
  return FUNCTIONAL_RELS.find((f) => f.rel === rel && (!f.fromType || f.fromType === fromType) && (!f.toType || f.toType === toType));
}

// Properties whose change writes a Version node (old values kept one hop away via HAD_VERSION). Wherever `title` is
// tracked, `name` is too: the display title lives in `name`, so a rename is a change of state. Observation values
// are tracked so a number corrected by a later source keeps its earlier reading.
export const TRACKED_PROPS: Partial<Record<EntityType, string[]>> = {
  Task: ["status", "title", "name"],
  Decision: ["status", "title", "name"],
  Channel: ["status", "handle"],
  Page: ["title", "statusCode", "metaDescription", "name"],
  Campaign: ["status"],
  Recommendation: ["status"],
  Approval: ["status"],
  Observation: ["value", "unit"],
  // product design §7.1 / §7.2
  Goal: ["status", "target"],
  Program: ["status", "guaranteeState"],
  Asset: ["status"],
  Capability: ["accessMode", "status"],
  Business: ["country", "currency", "locale", "timeZone", "designStyle", "templateKey"],
  Agent: ["enabled", "mode", "autonomy"],
  Rule: ["status"],
};

// Types the entity search (full-text on name/summary, vector on embedding) should return. Chunks have their own
// text and vector indexes; Observations, Versions and the episodic/action plumbing are reached by traversal instead.
export const SEARCHABLE: EntityType[] = [
  "Business", "Person", "Agent", "Team", "Product", "Feature", "Audience", "Need", "BrandRule", "BrandAsset", "Channel",
  "Content", "Campaign", "Page", "Query", "Metric", "Document", "Decision", "Task", "System", "Event", "Playbook", "Rule",
  "Recommendation", "Memory", "Finding", "Goal",
];

// Searchable nodes also carry this label (upsertNode adds it on create, ensureIndexes backfills older graphs), so the
// full-text and vector indexes sit on `Searchable` and hold only what search returns: observation names (one per
// reading, 160k a year), Versions, Turns and the rest of the plumbing are not in them. It is not an entity type:
// typeOfLabels skips it, but labels(n) lists it (by label id, so before or after the type label): never take "the
// first label that is not Entity" as the type.
export const SEARCHABLE_LABEL = "Searchable";

// The lowercase key an Observation's metric is queried by (`o.metricKey = $key`), so a read never wraps the property
// in toLower() (a function of the property is a label scan; the property itself is a range index).
export const metricKeyOf = (metric: string): string => metric.toLowerCase();

const TYPE_SET = new Set<string>(ENTITY_TYPES);
const REL_SET = new Set<string>(REL_TYPES);
export const isEntityType = (s: string): s is EntityType => TYPE_SET.has(s);
export const isRelType = (s: string): s is RelType => REL_SET.has(s);

// The type label of a node given all its labels (the one that is not `Entity`).
export function typeOfLabels(labels: readonly string[]): EntityType | undefined {
  return labels.find((l): l is EntityType => l !== "Entity" && isEntityType(l));
}

// Bookkeeping props upsert owns; callers cannot set them through `props`.
// `rev` counts writes (compare-and-set for concurrent upserts); `_mergeToken` exists only inside one MERGE statement.
export const NODE_META_PROPS = [
  "id", "name", "summary", "src", "asOf", "simulated", "createdAt", "updatedAt", "stateSince", "embedding", "textEmbedding",
  "rev", "_mergeToken",
] as const;
// asOfMs: the edge's asOf as epoch ms, written by upsertEdge so a statement can compare source dates; retiredAsOfMs:
// the date of the source that ended the edge (see edges.ts).
export const EDGE_META_PROPS = [
  "since", "until", "recordedAt", "retiredAt", "src", "asOf", "asOfMs", "retiredAsOfMs", "conf", "closedCost", "closeReason",
] as const;

// Closed edges also get `closedCost = CLOSED_EDGE_COST`. FalkorDB's algo.SPpaths cannot filter on edge properties,
// but it can cap a summed cost (costProp/maxCost, missing cost = 0), which makes it skip closed edges during the search.
export const CLOSED_EDGE_COST = 1_000_000;
