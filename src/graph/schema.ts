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
  // another business the owner competes with, watched through public data only (src/publicdata): its public numbers are
  // Observations that MEASURE it, so trends build over time
  "Competitor",
  // other businesses the owner's own pages name (onboarding, src/ingest/tidy.ts): who supplies it, whom it works with,
  // whom it works for. The owner's Business is the one business in its graph; a third party is never typed Business.
  "Supplier", "Partner", "Client",
  // the Sales department (src/sales): who asked (Lead), the chance of a sale (Deal), a call or visit (Meeting) and what was
  // said to whom (Message). Written by the sales tools and the inbox reader, never extracted from a document.
  "Lead", "Deal", "Meeting", "Message",
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
  // a competitor and the business it competes with
  "COMPETES_WITH",
  // the owner's suppliers, partners and clients (src/ingest/tidy.ts)
  "SUPPLIES", "PARTNERS_WITH", "CLIENT_OF",
  // sales: a lead is by a person and came through a channel; a deal belongs to a lead; a meeting is for a deal or lead and
  // with a person; a message is in a lead, deal or meeting, sent by someone to someone; a follow-up task is for one of them
  "ENQUIRED_BY", "CAME_VIA", "DEAL_OF", "MEETING_FOR", "MEETING_WITH", "MESSAGE_IN", "SENT_BY", "SENT_TO", "FOLLOWS_UP",
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
  "BrandAsset", "Content", "Goal", "Lead", "Deal",
];
const EVIDENCE: EntityType[] = ["Observation", "Document", "Chunk", "Memory", "Event", "Decision"];
// Another business, as the owner's pages name it.
export const OTHER_BUSINESS_TYPES: EntityType[] = ["Supplier", "Partner", "Client", "Competitor"];
// Types whose duplicates may be merged (SAME_AS, same type only).
export const SAME_AS_TYPES: EntityType[] = [
  "System", "Channel", "Product", "Feature", "Audience", "Need", "Content", "Campaign", "Event", "Query", "Person", "Team",
  "Business", ...OTHER_BUSINESS_TYPES,
];

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
  // the brand library and what is made from it: a poster uses the logo and font files it was drawn with, an owner
  // uploads brand files, and a newer logo supersedes the one before it
  ...pat(["Content", "Asset"], "USES_ASSET", "BrandAsset"),
  ...pat("Person", "AUTHORED", "BrandAsset"),
  ...pat("BrandAsset", "DERIVED_FROM", "BrandAsset"),
  ...pat("BrandAsset", "SUPERSEDES", "BrandAsset"),
  ...pat("Asset", "GUIDED_BY", ["BrandRule", "Rule"]),
  ...pat("Asset", "PROMOTES", ["Product", "Feature", "Business", "Content", "Page"]),
  ...pat("Asset", "DEPICTS", ["Product", "Page", "Business", "Event"]),
  ...pat(["Turn", "Finding", "Content"], "GUIDED_BY", ["Memory", "Rule", "BrandRule"]),
  // merges (src/ingest/merge.ts, the librarian's and onboarding's): same type only, duplicate -> canonical
  ...SAME_AS_TYPES.flatMap((t) => pat(t, "SAME_AS", t)),
  // a third party extraction typed Business, retyped (src/ingest/tidy.ts): the Business node points at its new node
  ...pat("Business", "SAME_AS", OTHER_BUSINESS_TYPES),
  // competitors (public data): who they compete with, and their own public channels
  ...pat("Competitor", "COMPETES_WITH", "Business"),
  ...pat("Competitor", "TARGETS", "Audience"),
  // suppliers, partners and clients: the relation to the owner's business, and the people who work there
  ...pat("Supplier", "SUPPLIES", ["Business", "Product"]),
  ...pat("Partner", "PARTNERS_WITH", "Business"),
  ...pat("Client", "CLIENT_OF", "Business"),
  ...pat("Person", "MEMBER_OF", ["Supplier", "Partner", "Client"]),
  // sales (src/sales/graph.ts). Every node carries src and asOf; every edge too.
  ...pat(["Lead", "Deal", "Meeting", "Message"], "PART_OF", "Business"),
  ...pat("Lead", "ENQUIRED_BY", "Person"),
  ...pat("Lead", "CAME_VIA", "Channel"),
  ...pat("Deal", "DEAL_OF", "Lead"),
  ...pat("Meeting", "MEETING_FOR", ["Deal", "Lead"]),
  ...pat("Meeting", "MEETING_WITH", "Person"),
  ...pat("Message", "MESSAGE_IN", ["Lead", "Deal", "Meeting"]),
  ...pat("Message", "SENT_BY", ACTORS),
  ...pat("Message", "SENT_TO", "Person"),
  ...pat("Task", "FOLLOWS_UP", ["Lead", "Deal", "Meeting"]),
  // an approved email or invite that went out: the Action made this Message or Meeting
  ...pat("Action", "RESULTED_IN", ["Message", "Meeting"]),
];

// Patterns only the deterministic mappers write (src/ingest/sources/ops-map): a step of a user flow (Feature, kind funnel_step)
// happens on a screen (Page, kind app_screen) in the app (Channel), so a broken screen breaks the step and every step after it.
// Kept out of ALLOWED_PATTERNS on purpose: that list is what the extraction model is shown, and changing it would change every
// tenant's extraction cache key and re-run every document through the model.
//
// The graph audit (docs/graph-audit.md) added the links the deterministic writers need to make the product's own work
// traversable, kept here for the same reason:
//   - a card or a rule is GUIDED_BY the rule it applied, and a card, a rule or a memory is SOURCED_FROM the turn it came out of;
//   - an agent's Finding is GUIDED_BY the skill (a Playbook{kind:'skill'}) its desk opened;
//   - what a sales message or meeting went through (Channel), where a lead came from (Campaign, Content) and what a lead,
//     deal, meeting or message is for (Goal);
//   - a connection (System) PRODUCED the snapshot Documents its facts came from;
//   - a rival (Competitor) OWNS the channels and ads watched through public data;
//   - the Discord card an Approval was posted as (Approval PUBLISHED_ON Channel);
//   - the run that measured a graph-hygiene reading (Observation SOURCED_FROM Event: an onboarding or ingest run).
//   - the account a post went from, a Channel PART_OF the platform's Channel.
export const MAPPER_PATTERNS: Pattern[] = [
  ...pat("Feature", "DEPENDS_ON", ["Page", "Channel"]),
  ...pat(["Approval", "Recommendation"], "GUIDED_BY", ["Rule", "BrandRule", "Memory"]),
  ...pat("Finding", "GUIDED_BY", "Playbook"),
  ...pat(["Recommendation", "Approval", "Memory", "Rule"], "SOURCED_FROM", "Turn"),
  ...pat(["Message", "Meeting"], "CAME_VIA", "Channel"),
  ...pat("Lead", "CAME_VIA", ["Campaign", "Content"]),
  ...pat(["Lead", "Deal", "Meeting", "Message"], "ADVANCES", "Goal"),
  ...pat("System", "PRODUCED", "Document"),
  ...pat("Competitor", "OWNS", ["Channel", "Content"]),
  ...pat("Approval", "PUBLISHED_ON", "Channel"),
  ...pat("Observation", "SOURCED_FROM", "Event"),
  // posting (src/publish): the account a post went from is a Channel of its own (channel:instagram:cafe), PART_OF the platform's
  // channel (channel:instagram), so two accounts on one platform are two nodes and the platform's numbers stay on one
  ...pat("Channel", "PART_OF", "Channel"),
];

const ALLOWED = new Set([...ALLOWED_PATTERNS, ...MAPPER_PATTERNS].map(([f, r, t]) => `${f}|${r}|${t}`));

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
  Agent: ["enabled", "mode", "autonomy", "skillsOff"],
  Rule: ["status", "confidence"],
  // the graph audit: a connection's state (ok, expired, not connected), a post's, a message's and an action's progress each
  // leave a Version, so "connected on 9 Oct, expired on 14 Oct, reconnected 15 Oct" and "scheduled, publishing, published" are reads
  System: ["status"],
  Content: ["status"],
  Message: ["status"],
  Action: ["status"],
  // sales: the stage a lead or deal is in is bi-temporal ("what moved this week" reads the Versions); so is a meeting's state
  Lead: ["stage"],
  Deal: ["stage", "value"],
  Meeting: ["status", "start"],
};

// Types the entity search (full-text on name/summary, vector on embedding) should return. Chunks have their own
// text and vector indexes; Observations, Versions and the episodic/action plumbing are reached by traversal instead.
export const SEARCHABLE: EntityType[] = [
  "Business", "Person", "Agent", "Team", "Product", "Feature", "Audience", "Need", "BrandRule", "BrandAsset", "Channel",
  "Content", "Campaign", "Page", "Query", "Metric", "Document", "Decision", "Task", "System", "Event", "Playbook", "Rule",
  "Recommendation", "Memory", "Finding", "Goal", "Competitor", "Supplier", "Partner", "Client", "Lead", "Deal", "Meeting",
];

// Nodes of a type search can be asked for by name carry this label (upsertNode adds it on create, ensureIndexes backfills
// older graphs), so the full-text and vector indexes sit on `Searchable` and hold what search can return. Left out: the
// readings (an Observation has a display name per reading, 160k a year, that crowded real entities out of the ranking),
// Version stubs (no name) and Chunks (their own indexes). It is not an entity type: typeOfLabels skips it, but labels(n)
// lists it (by label id, so before or after the type label): never take "the first label that is not Entity" as the type.
export const SEARCHABLE_LABEL = "Searchable";
// Every type but those three, not just SEARCHABLE: search takes `types` and can be asked for a Turn or an Approval by
// name (SEARCHABLE is the default set); the types in between are few and do not grow with the readings.
export const SEARCH_INDEXED_TYPES: EntityType[] = ENTITY_TYPES.filter((t) => t !== "Observation" && t !== "Version" && t !== "Chunk");

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
