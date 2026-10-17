// "How the brain grew": nodes and edges per day or week, by kind, read straight from the business's own graph. It backs
// `npm run cli -- graph:story <tenant>` and the Brain page's "How your team's brain grew" (GET /api/:t/graph/story), so the
// website's "it keeps growing" is a count of real nodes and edges and never a drawing.
//
// Two clocks, because the graph keeps two (docs/falkordb-queries.md section 7):
//   recorded: when the team learned it (nodes `createdAt`, edges `recordedAt`, both epoch ms the writers stamp);
//   source:   when the thing happened (nodes `asOf`, edges `asOf`, the date of the document or reading it came from).
// Every write goes through upsertNode / upsertEdge, which stamp both, so no node or edge is left out of either count (nodes
// or edges without the stamp are reported as `undated`). Everything here is GRAPH.RO_QUERY and grouped on the grouping
// keys, so no sort can tie (src/graph/safety.ts).
import type { GraphHandle } from "./client.js";
import { referenceFilter, referenceParams } from "./reference.js";

export type StoryAxis = "recorded" | "source";
export type StoryBucket = "day" | "week";

// Kinds a business owner would name, with the node labels and relationship types each one holds. Anything not listed
// falls into "other" so the totals always add up.
export interface StoryKind { id: string; name: string; labels: string[]; rels: string[] }
export const STORY_KINDS: StoryKind[] = [
  { id: "knowledge", name: "Facts and sources", labels: ["Document", "Chunk", "Observation", "Metric", "Page", "Query"],
    rels: ["SOURCED_FROM", "MEASURES", "MENTIONS", "HAS_CHUNK", "LINKS_TO", "LINKS_TO_PAGE", "RANKS_FOR"] },
  { id: "company", name: "Company", labels: ["Business", "Person", "Team", "Agent", "Product", "Feature", "Audience", "Need", "System", "Channel", "Supplier", "Partner", "Client", "Competitor", "Capability", "BrandRule", "BrandAsset"],
    rels: ["MEMBER_OF", "OWNS", "KNOWS_ABOUT", "AUTHORED", "DEPENDS_ON", "PART_OF", "USES", "SAME_AS", "TARGETS", "HAS_NEED", "SOLVES", "COMPETES_WITH", "SUPPLIES", "PARTNERS_WITH", "CLIENT_OF"] },
  { id: "work", name: "Work and decisions", labels: ["Task", "Decision", "Event", "Playbook", "Campaign", "Goal", "Program", "Checkpoint"],
    rels: ["DECIDED", "BASED_ON", "SUPERSEDES", "AFFECTS", "BLOCKS", "PURSUES", "TRACKS", "ENROLLED_IN", "INCLUDES", "APPLIES_TO", "FAILS", "PASSES"] },
  { id: "memory", name: "Memory of conversations", labels: ["Session", "Turn", "Finding", "Memory", "Rule"],
    rels: ["ASKED", "IN_SESSION", "TOUCHED", "CITED", "ABOUT", "STATED", "HANDLED_BY", "PRODUCED", "REVIEWED", "GUIDED_BY", "LEARNED_FROM", "USES_RULE", "CONTRADICTS"] },
  { id: "actions", name: "Ideas and approvals", labels: ["Recommendation", "Approval", "Action"],
    rels: ["PROPOSES", "EVIDENCED_BY", "APPROVED_BY", "REJECTED_BY", "RESULTED_IN", "ADVANCES"] },
  { id: "sales", name: "Sales", labels: ["Lead", "Deal", "Meeting", "Message"],
    rels: ["ENQUIRED_BY", "CAME_VIA", "DEAL_OF", "MEETING_FOR", "MEETING_WITH", "MESSAGE_IN", "SENT_BY", "SENT_TO", "FOLLOWS_UP"] },
  { id: "creative", name: "Pictures and posts", labels: ["Asset", "Content"],
    rels: ["DERIVED_FROM", "USES_ASSET", "DEPICTS", "PUBLISHED_ON", "PROMOTES"] },
  { id: "history", name: "Changes kept", labels: ["Version"], rels: ["HAD_VERSION"] },
];
const OTHER: StoryKind = { id: "other", name: "Other", labels: [], rels: [] };

const KIND_OF_LABEL = new Map(STORY_KINDS.flatMap((k) => k.labels.map((l) => [l, k.id] as const)));
const KIND_OF_REL = new Map(STORY_KINDS.flatMap((k) => k.rels.map((r) => [r, k.id] as const)));
export const kindOfLabel = (label: string | null | undefined): string => (label && KIND_OF_LABEL.get(label)) || OTHER.id;
export const kindOfRel = (rel: string): string => KIND_OF_REL.get(rel) ?? OTHER.id;

export interface StoryPoint {
  /** The first day of the bucket (a Monday for a week), YYYY-MM-DD, UTC. */
  start: string;
  nodes: number;
  edges: number;
  nodesByKind: Record<string, number>;
  edgesByKind: Record<string, number>;
  /** Facts that ended in this bucket (an edge gets `until` and stays; nothing is deleted). Recorded axis only. */
  retired: number;
  /** Running totals at the end of the bucket. */
  totalNodes: number;
  totalEdges: number;
}

export interface GraphStory {
  tenant: string;
  axis: StoryAxis;
  bucket: StoryBucket;
  points: StoryPoint[];
  totals: { nodes: number; edges: number; versions: number; retired: number; undatedNodes: number; undatedEdges: number };
  nodesByType: Array<{ type: string; count: number }>;
  edgesByType: Array<{ type: string; count: number }>;
  first: string | null;
  last: string | null;
  /** What was added after the day of the biggest load (the first ingest or seed): "it keeps growing" as a number. Recorded axis only. */
  afterLoad: null | { loadDay: string; loadNodes: number; loadEdges: number; nodes: number; edges: number; nodesPct: number | null; edgesPct: number | null };
  kinds: Array<{ id: string; name: string }>;
}

const DAY_MS = 86_400_000;
const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const dayMs = (iso: string): number => Date.parse(`${iso}T00:00:00Z`);
function weekStart(iso: string): string {
  const t = dayMs(iso);
  const dow = new Date(t).getUTCDay(); // 0 Sunday
  return isoDay(t - ((dow + 6) % 7) * DAY_MS); // back to Monday
}

interface Row { d: string; k: string; c: number }

async function nodeRows(g: GraphHandle, axis: StoryAxis): Promise<{ rows: Row[]; undated: number }> {
  const day = axis === "recorded"
    ? "n.createdAt - n.createdAt % 86400000"
    : "substring(n.asOf, 0, 10)";
  const has = axis === "recorded" ? "n.createdAt IS NOT NULL" : "n.asOf IS NOT NULL AND size(n.asOf) >= 10";
  const rows = await g.roQuery<{ d: number | string; k: string | null; c: number }>(
    `MATCH (n:Entity) WHERE ${has} AND NOT ${referenceFilter("n")}
     WITH ${day} AS d, [x IN labels(n) WHERE x <> 'Entity' AND x <> 'Searchable'][0] AS k
     RETURN d, k, count(*) AS c ORDER BY d, k`, referenceParams(), { timeoutMs: 30_000 });
  const [un] = await g.roQuery<{ c: number }>(`MATCH (n:Entity) WHERE NOT (${has}) AND NOT ${referenceFilter("n")} RETURN count(n) AS c`, referenceParams(), { timeoutMs: 30_000 });
  return { rows: rows.map((r) => ({ d: typeof r.d === "number" ? isoDay(r.d) : String(r.d), k: r.k ?? "", c: r.c })), undated: un?.c ?? 0 };
}

async function edgeRows(g: GraphHandle, axis: StoryAxis): Promise<{ rows: Row[]; undated: number }> {
  const day = axis === "recorded"
    ? "r.recordedAt - r.recordedAt % 86400000"
    : "substring(r.asOf, 0, 10)";
  const has = axis === "recorded" ? "r.recordedAt IS NOT NULL" : "r.asOf IS NOT NULL AND size(r.asOf) >= 10";
  const rows = await g.roQuery<{ d: number | string; k: string; c: number }>(
    `MATCH (a)-[r]->(b) WHERE ID(r) >= 0 AND ${has} AND NOT ${referenceFilter("a")} AND NOT ${referenceFilter("b")}
     WITH ${day} AS d, type(r) AS k
     RETURN d, k, count(*) AS c ORDER BY d, k`, referenceParams(), { timeoutMs: 30_000 });
  const [un] = await g.roQuery<{ c: number }>(`MATCH (a)-[r]->(b) WHERE ID(r) >= 0 AND NOT (${has}) AND NOT ${referenceFilter("a")} AND NOT ${referenceFilter("b")} RETURN count(r) AS c`, referenceParams(), { timeoutMs: 30_000 });
  return { rows: rows.map((r) => ({ d: typeof r.d === "number" ? isoDay(r.d) : String(r.d), k: r.k, c: r.c })), undated: un?.c ?? 0 };
}

async function retiredRows(g: GraphHandle): Promise<Row[]> {
  const rows = await g.roQuery<{ d: number; c: number }>(
    `MATCH ()-[r]->() WHERE ID(r) >= 0 AND r.retiredAt IS NOT NULL
     WITH r.retiredAt - r.retiredAt % 86400000 AS d
     RETURN d, count(*) AS c ORDER BY d`, {}, { timeoutMs: 30_000 });
  return rows.map((r) => ({ d: isoDay(r.d), k: "retired", c: r.c }));
}

// The biggest day of new nodes is the load (an ingest or a seed); everything recorded on later days came from use.
function loadStats(nodeRows: Row[], edgeRows: Row[]): GraphStory["afterLoad"] {
  const perDay = new Map<string, { n: number; e: number }>();
  for (const r of nodeRows) perDay.set(r.d, { n: (perDay.get(r.d)?.n ?? 0) + r.c, e: perDay.get(r.d)?.e ?? 0 });
  for (const r of edgeRows) perDay.set(r.d, { n: perDay.get(r.d)?.n ?? 0, e: (perDay.get(r.d)?.e ?? 0) + r.c });
  const days = [...perDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  if (!days.length) return null;
  const [loadDay, load] = days.reduce((best, cur) => (cur[1].n > best[1].n ? cur : best));
  const upTo = days.filter(([d]) => d <= loadDay).reduce((s, [, v]) => ({ n: s.n + v.n, e: s.e + v.e }), { n: 0, e: 0 });
  const after = days.filter(([d]) => d > loadDay).reduce((s, [, v]) => ({ n: s.n + v.n, e: s.e + v.e }), { n: 0, e: 0 });
  const pct = (x: number, of: number): number | null => (of > 0 ? Math.round((x / of) * 1000) / 10 : null);
  return { loadDay, loadNodes: load.n, loadEdges: load.e, nodes: after.n, edges: after.e, nodesPct: pct(after.n, upTo.n), edgesPct: pct(after.e, upTo.e) };
}

export interface StoryOpts { axis?: StoryAxis; bucket?: StoryBucket | "auto"; tenant?: string }

// The whole story: three or four grouped reads, then the bucketing in JS. A day that has no new node or edge is still a
// point (zero), so a quiet week shows as quiet instead of disappearing.
export async function graphStory(g: GraphHandle, opts: StoryOpts = {}): Promise<GraphStory> {
  const axis = opts.axis ?? "recorded";
  const [n, e, ret] = await Promise.all([nodeRows(g, axis), edgeRows(g, axis), axis === "recorded" ? retiredRows(g) : Promise.resolve([])]);
  const days = [...n.rows, ...e.rows].map((r) => r.d).sort();
  const first = days[0] ?? null;
  const last = days.at(-1) ?? null;
  const span = first && last ? Math.round((dayMs(last) - dayMs(first)) / DAY_MS) + 1 : 0;
  const bucket: StoryBucket = opts.bucket && opts.bucket !== "auto" ? opts.bucket : span > 21 ? "week" : "day";
  const startOf = (d: string): string => (bucket === "week" ? weekStart(d) : d);

  const points = new Map<string, StoryPoint>();
  const at = (d: string): StoryPoint => {
    const s = startOf(d);
    let p = points.get(s);
    if (!p) { p = { start: s, nodes: 0, edges: 0, nodesByKind: {}, edgesByKind: {}, retired: 0, totalNodes: 0, totalEdges: 0 }; points.set(s, p); }
    return p;
  };
  const nodeTypeTotals = new Map<string, number>();
  const edgeTypeTotals = new Map<string, number>();
  for (const r of n.rows) {
    const p = at(r.d);
    const k = kindOfLabel(r.k);
    p.nodes += r.c;
    p.nodesByKind[k] = (p.nodesByKind[k] ?? 0) + r.c;
    nodeTypeTotals.set(r.k || "Unknown", (nodeTypeTotals.get(r.k || "Unknown") ?? 0) + r.c);
  }
  for (const r of e.rows) {
    const p = at(r.d);
    const k = kindOfRel(r.k);
    p.edges += r.c;
    p.edgesByKind[k] = (p.edgesByKind[k] ?? 0) + r.c;
    edgeTypeTotals.set(r.k, (edgeTypeTotals.get(r.k) ?? 0) + r.c);
  }
  for (const r of ret) at(r.d).retired += r.c;

  // fill the quiet buckets between the first and the last
  if (first && last) {
    const step = bucket === "week" ? 7 : 1;
    for (let t = dayMs(startOf(first)); t <= dayMs(last); t += step * DAY_MS) at(isoDay(t));
  }
  const ordered = [...points.values()].sort((a, b) => a.start.localeCompare(b.start));
  let tn = 0;
  let te = 0;
  for (const p of ordered) { tn += p.nodes; te += p.edges; p.totalNodes = tn; p.totalEdges = te; }

  const versions = nodeTypeTotals.get("Version") ?? 0;
  const afterLoad = axis === "recorded" ? loadStats(n.rows, e.rows) : null;
  const top = (m: Map<string, number>, key: "type"): Array<{ type: string; count: number }> =>
    [...m.entries()].map(([type, count]) => ({ [key]: type, count }) as { type: string; count: number })
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
  return {
    tenant: opts.tenant ?? g.name.replace(/^allevia_/, ""), axis, bucket, points: ordered,
    totals: { nodes: tn, edges: te, versions, retired: ret.reduce((s, r) => s + r.c, 0), undatedNodes: n.undated, undatedEdges: e.undated },
    nodesByType: top(nodeTypeTotals, "type"), edgesByType: top(edgeTypeTotals, "type"),
    first, last,
    afterLoad,
    kinds: [...STORY_KINDS, OTHER].map((k) => ({ id: k.id, name: k.name })),
  };
}

const n0 = (x: number): string => x.toLocaleString("en-US");

// The terminal view. Plain text, one line per bucket: what was added, the running totals, and what kinds of things
// the new nodes were (the order of the columns is STORY_KINDS).
export function formatStory(s: GraphStory): string {
  const by = s.bucket;
  const clock = s.axis === "recorded" ? "when the team learned it (record time)" : "when it happened (the date of its source)";
  const lines: string[] = [];
  lines.push(`How ${s.tenant}'s brain grew, by ${by}, counted by ${clock}`);
  lines.push(`${n0(s.totals.nodes)} nodes and ${n0(s.totals.edges)} edges${s.first ? `, from ${s.first} to ${s.last}` : ""}. ${n0(s.totals.versions)} earlier states of changed things are kept as versions${s.axis === "recorded" ? `; ${n0(s.totals.retired)} facts that stopped being true are closed, never deleted` : ""}.`);
  if (s.totals.undatedNodes || s.totals.undatedEdges) lines.push(`Without a date on this clock: ${n0(s.totals.undatedNodes)} nodes, ${n0(s.totals.undatedEdges)} edges (left out of the table).`);
  lines.push("");
  const kinds = s.kinds.filter((k) => s.points.some((p) => (p.nodesByKind[k.id] ?? 0) > 0));
  const head = [(s.bucket === "week" ? "week of" : "day").padEnd(11), "+nodes".padStart(8), "+edges".padStart(8), "nodes".padStart(8), "edges".padStart(8), ...kinds.map((k) => k.id.padStart(9))];
  lines.push(head.join(" "));
  for (const p of s.points) {
    lines.push([p.start.padEnd(11), n0(p.nodes).padStart(8), n0(p.edges).padStart(8), n0(p.totalNodes).padStart(8), n0(p.totalEdges).padStart(8),
      ...kinds.map((k) => n0(p.nodesByKind[k.id] ?? 0).padStart(9))].join(" "));
  }
  lines.push("");
  lines.push(`Node columns: ${kinds.map((k) => `${k.id} = ${k.name.toLowerCase()}`).join("; ")}.`);
  const a = s.afterLoad;
  if (a) {
    lines.push(a.nodes || a.edges
      ? `The biggest day was ${a.loadDay} (the first ingest or seed: ${n0(a.loadNodes)} nodes, ${n0(a.loadEdges)} edges). Since then, from use alone, it gained ${n0(a.nodes)} more nodes${a.nodesPct !== null ? ` (+${a.nodesPct}%)` : ""} and ${n0(a.edges)} more edges${a.edgesPct !== null ? ` (+${a.edgesPct}%)` : ""}.`
      : `The biggest day was ${a.loadDay} (${n0(a.loadNodes)} nodes, ${n0(a.loadEdges)} edges); nothing has been recorded after it yet.`);
  }
  lines.push(`Nodes by type: ${s.nodesByType.slice(0, 12).map((t) => `${t.type} ${n0(t.count)}`).join(", ")}.`);
  lines.push(`Edges by type: ${s.edgesByType.slice(0, 12).map((t) => `${t.type} ${n0(t.count)}`).join(", ")}.`);
  return lines.join("\n");
}
