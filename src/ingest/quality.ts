// The graph-quality report (issue #24): how clean one business's graph is, read-only. `npm run cli -- graph:quality <tenant>`.
//
// It looks at the business's own knowledge: nodes of the types below, leaving out what every tenant shares (the
// playbooks' rules and Google-update events, and the bare channel anchors they hang off), what was already merged or
// retired, and the pages, documents and chunks (provenance, not knowledge). For that, it counts:
//   duplicates  pairs that name one thing (dedupe.ts): certain ones (one channel, the same words, an alias) and possible
//               ones (close vectors or one name inside the other) the model has not yet judged; `nodes` is how many
//               nodes would go if they were merged;
//   mistyped    another business typed Business (it should be a Supplier, Partner, Client, Competitor or the owner
//               itself), and a Person that is a first name alone (retype.ts);
//   orphans     own nodes tied to nothing but the page they came from (no relation to the business or to anything else);
//   unsourced   own nodes with no current SOURCED_FROM and no `src`, relations between own nodes with no `src`, and the
//               business's day-one facts (hours, address, price range) with no source recorded;
//   facts       which day-one facts the business has (facts.ts) and how many products carry a price;
//   tidied      what onboarding's tidy pass did and can undo: merges (SAME_AS), retyped businesses, retired names.
// `noise` is the share of own nodes that are a duplicate, mistyped or an orphan.
//
// Every read pages or batches (MAX_PAGE), groups nothing beside a nullable column, and sorts on unique keys, so it is
// safe on a live database: it never writes.
import type { GraphHandle } from "../graph/client.js";
import { MAX_PAGE } from "../graph/client.js";
import { typeOfLabels, type EntityType } from "../graph/schema.js";
import { HISTORY_RELS } from "./merge.js";
import { DEDUPE_TYPES, findDuplicatePairs, pairKey, plausible, type DedupeNode, type Pair } from "./dedupe.js";
import { firstNameOnly, isSelf } from "./retype.js";
import { isReservedId } from "./resolve-names.js";

type Read = Pick<GraphHandle, "roQuery" | "name">;

export const QUALITY_TYPES: readonly EntityType[] = [...DEDUPE_TYPES, "Business", "Person", "Team", "Decision", "Task"];
// What ties a node to its source, not to other knowledge.
const PROVENANCE = new Set(["SOURCED_FROM", "MENTIONS", "HAS_CHUNK", "LINKS_TO", "LINKS_TO_PAGE"]);
const NOT_KNOWLEDGE = new Set<string>(["Document", "Chunk", "Page", "Version", "Turn", "Session", "Finding"]);
const HISTORY = new Set<string>(HISTORY_RELS);
// Business facts and the prop that names their source.
export const BUSINESS_FACTS = ["hours", "address", "priceRange"] as const;
export const factSrcProp = (f: string): string => `${f}Src`;

export interface EdgeEnd { dir: "out" | "in"; type: string; other: string; otherType?: EntityType; otherKind?: string; src?: string }

export interface StateNode extends DedupeNode {
  summary?: string;
  src?: string;
  role?: string;
  title?: string;
  mergedInto?: string;
  retired?: boolean;
  kind?: string;
  props: Record<string, unknown>;
  edges: EdgeEnd[];
}

export interface GraphState { businessId: string; owner?: StateNode; nodes: StateNode[]; shared: number; merged: number; retired: number; retyped: number }

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const nums = (v: unknown): number[] | undefined => (Array.isArray(v) && v.length && v.every((x) => typeof x === "number") ? (v as number[]) : undefined);

// Allevia's own scaffolding in every graph: the playbooks (their documents, rules and Google-update events), the plan
// (program, checkpoints, goals), the capability ladder and Allevia's own agents and teams.
const SCAFFOLD_TYPES = new Set<string>(["Rule", "Playbook", "Capability", "Program", "Checkpoint", "Goal", "Agent"]);
const scaffold = (e: EdgeEnd): boolean =>
  (e.otherType === "Document" && e.otherKind === "playbook") || (!!e.otherType && SCAFFOLD_TYPES.has(e.otherType)) ||
  (e.otherType === "Event" && e.other.startsWith("event:google-update")) || isReservedId(e.other);

// Shared by every tenant (the playbooks' rules and events, the bare channel anchors they and the capability ladder
// hang off, Allevia's own teams), not this business's knowledge.
export function isShared(n: Pick<StateNode, "edges" | "kind" | "id">): boolean {
  // (and the ingest pipeline's own run log: event:ingest-<time>)
  if (n.kind === "google-update" || n.id.startsWith("event:google-update") || n.id.startsWith("event:ingest-") || isReservedId(n.id)) return true;
  const srcDocs = n.edges.filter((e) => e.type === "SOURCED_FROM" && e.dir === "out");
  if (srcDocs.length) return srcDocs.every((e) => e.otherKind === "playbook");
  return n.edges.length > 0 && n.edges.every(scaffold);
}

// Reads the business's nodes of QUALITY_TYPES with their current edges (and vectors, when asked).
export async function readGraphState(g: Read, businessId: string, opts: { embeddings?: boolean } = {}): Promise<GraphState> {
  const labels = QUALITY_TYPES.map((t) => `n:${t}`).join(" OR ");
  const all: StateNode[] = [];
  for (let after = ""; ;) {
    const rows = await g.roQuery<{ id: string; labels: string[]; p: Record<string, unknown> }>(
      `MATCH (n:Entity) WHERE n.id > $after AND (${labels})
       WITH n ORDER BY n.id LIMIT $lim
       RETURN n.id AS id, labels(n) AS labels, properties(n) AS p ORDER BY id`,
      { after, lim: MAX_PAGE });
    for (const r of rows) {
      const type = typeOfLabels(r.labels);
      const name = str(r.p.name);
      if (!type || !name) continue;
      const { embedding: _e, textEmbedding: _t, ...p } = r.p;
      all.push({
        id: r.id, type, name, aliases: strs(p.aliases), degree: 0, props: p, edges: [],
        ...(str(p.summary) ? { summary: str(p.summary)! } : {}), ...(str(p.src) ? { src: str(p.src)! } : {}),
        ...(p.simulated === true ? { simulated: true } : {}), ...(str(p.platform) ? { platform: str(p.platform)! } : {}),
        ...(strs(p.notSameAs).length ? { notSameAs: strs(p.notSameAs) } : {}), ...(strs(p.distinctFrom).length ? { distinctFrom: strs(p.distinctFrom) } : {}),
        ...(str(p.mergedInto) ? { mergedInto: str(p.mergedInto)! } : {}), ...(p.retired === true ? { retired: true } : {}),
        ...(str(p.role) ? { role: str(p.role)! } : {}), ...(str(p.title) ? { title: str(p.title)! } : {}), ...(str(p.kind) ? { kind: str(p.kind)! } : {}),
      });
    }
    if (rows.length < MAX_PAGE) break;
    after = rows[rows.length - 1]!.id;
  }
  const byId = new Map(all.map((n) => [n.id, n] as const));
  const live = all.filter((n) => !n.mergedInto && !n.retired);
  // the owner's own edges are not needed (they come back from the other end), and it can have thousands
  const ids = live.map((n) => n.id).filter((id) => id !== businessId);
  const addRows = (rows: Array<{ id: string; dir: "out" | "in"; t: string; x: string; xl: string[]; xk: unknown; src: unknown }>) => {
    for (const r of rows) {
      const n = byId.get(r.id);
      if (!n) continue;
      const otherType = typeOfLabels(r.xl);
      n.edges.push({ dir: r.dir, type: r.t, other: r.x, ...(otherType ? { otherType } : {}), ...(str(r.xk) ? { otherKind: str(r.xk)! } : {}), ...(str(r.src) ? { src: str(r.src)! } : {}) });
    }
  };
  const edgeQuery = (dirOut: boolean) => dirOut
    ? `UNWIND $ids AS id MATCH (n:Entity {id:id})-[r]->(x:Entity) WHERE r.until IS NULL
       RETURN n.id AS id, 'out' AS dir, type(r) AS t, x.id AS x, labels(x) AS xl, x.kind AS xk, r.src AS src`
    : `UNWIND $ids AS id MATCH (x:Entity)-[r]->(n:Entity {id:id}) WHERE r.until IS NULL
       RETURN n.id AS id, 'in' AS dir, type(r) AS t, x.id AS x, labels(x) AS xl, x.kind AS xk, r.src AS src`;
  const BATCH = 20;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    for (const out of [true, false]) {
      const rows = await g.roQuery<Parameters<typeof addRows>[0][number]>(edgeQuery(out), { ids: batch });
      if (rows.length < MAX_PAGE) { addRows(rows); continue; }
      for (const id of batch) addRows(await g.roQuery(edgeQuery(out), { ids: [id] })); // a busy batch: one node at a time
    }
  }
  for (const n of live) n.degree = n.edges.filter((e) => !HISTORY.has(e.type)).length;
  if (opts.embeddings) {
    for (let i = 0; i < ids.length; i += 200) {
      const rows = await g.roQuery<{ id: string; e: unknown }>(
        "UNWIND $ids AS id MATCH (n:Entity {id:id}) RETURN n.id AS id, n.embedding AS e", { ids: ids.slice(i, i + 200) });
      for (const r of rows) { const v = nums(r.e); if (v) byId.get(r.id)!.embedding = v; }
    }
  }
  const owner = byId.get(businessId);
  const nodes = live.filter((n) => n.id !== businessId && !isShared(n));
  return {
    businessId, ...(owner ? { owner } : {}), nodes, shared: live.length - nodes.length - (owner ? 1 : 0),
    merged: all.filter((n) => n.mergedInto && n.props.retypedTo === undefined).length,
    retyped: all.filter((n) => n.mergedInto && n.props.retypedTo !== undefined).length,
    retired: all.filter((n) => n.retired).length,
  };
}

// ---------- the report ----------

export interface QualityReport {
  graph: string;
  businessId: string;
  nodes: { own: number; shared: number; byType: Record<string, number> };
  duplicates: { certain: number; possible: number; nodes: number; examples: string[] };
  mistyped: { otherBusinesses: number; firstNamePeople: number; total: number; examples: string[] };
  orphans: { count: number; byType: Record<string, number>; examples: string[] };
  unsourced: { nodes: number; edges: number; facts: number; examples: string[] };
  facts: { hours: boolean; address: boolean; priceRange: boolean; pricedProducts: number; fromListing: string[] };
  tidied: { merged: number; retyped: number; retired: number };
  noise: number;
}

const EXAMPLES = 8;
const label = (n: Pick<StateNode, "type" | "name">) => `${n.type} "${n.name}"`;
const bump = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };

// Nodes that would go if the pairs were merged: per connected group, its size minus one.
export function duplicateNodes(pairs: readonly Pair[]): Set<string> {
  const parent = new Map<string, string>();
  const find = (x: string): string => { let r = x; while ((parent.get(r) ?? r) !== r) r = parent.get(r)!; parent.set(x, r); return r; };
  for (const p of pairs) { const [a, b] = [find(p.a), find(p.b)]; if (a !== b) parent.set(a < b ? b : a, a < b ? a : b); }
  return new Set([...parent.keys()].filter((id) => find(id) !== id));
}

export function qualityOf(state: GraphState, graph: string): QualityReport {
  const { nodes, owner } = state;
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const byType: Record<string, number> = {};
  for (const n of nodes) bump(byType, n.type);

  const ownerName = str(owner?.name) ?? "";
  const domain = str(owner?.props.domain);
  const found = findDuplicatePairs(nodes, ownerName ? { business: ownerName } : {});
  const certain = found.certain;
  const borderline = found.borderline.filter((p) => plausible(p, byId));
  const dupes = duplicateNodes([...certain, ...borderline]);
  const pairLine = (p: Pair) => `${p.type}: "${byId.get(p.a)?.name}" ~ "${byId.get(p.b)?.name}" (${p.how}${p.score !== undefined ? ` ${p.score}` : ""})`;

  const others = nodes.filter((n) => n.type === "Business");
  const firstNames = nodes.filter((n) => n.type === "Person" && firstNameOnly({
    id: n.id, name: n.name, ...(n.summary ? { summary: n.summary } : {}), ...(n.role ? { role: n.role } : {}), ...(n.title ? { title: n.title } : {}),
    relTypes: n.edges.filter((e) => e.dir === "out").map((e) => e.type),
  }));
  const mistyped = new Set([...others, ...firstNames].map((n) => n.id));

  const knowledge = (e: EdgeEnd) => !PROVENANCE.has(e.type) && !HISTORY.has(e.type) && !(e.otherType && NOT_KNOWLEDGE.has(e.otherType)) && e.type !== "KNOWS_ABOUT";
  const orphans = nodes.filter((n) => !n.edges.some(knowledge));
  const orphanTypes: Record<string, number> = {};
  for (const n of orphans) bump(orphanTypes, n.type);

  const sourced = (n: StateNode) => !!n.src || n.edges.some((e) => e.type === "SOURCED_FROM" && e.dir === "out");
  const unsourcedNodes = nodes.filter((n) => !sourced(n));
  const ownIds = new Set([...nodes.map((n) => n.id), state.businessId]);
  const unsourcedEdges = nodes.flatMap((n) => n.edges.filter((e) => e.dir === "out" && knowledge(e) && ownIds.has(e.other) && !e.src).map((e) => `${n.id} -[${e.type}]-> ${e.other}`));
  const ownerFacts = BUSINESS_FACTS.filter((f) => owner?.props[f] !== undefined && owner?.props[f] !== null);
  const unsourcedFacts = ownerFacts.filter((f) => !str(owner?.props[factSrcProp(f)]));

  const listing = nodes.find((n) => n.id === "channel:google-maps");
  const fromListing = listing ? ["hours", "address"].filter((f) => { const v = listing.props[f]; return Array.isArray(v) ? v.length > 0 : !!str(v); }) : [];
  const priced = nodes.filter((n) => n.type === "Product" && typeof n.props.price === "number").length;

  const noisy = new Set([...dupes, ...mistyped, ...orphans.map((n) => n.id)]);
  return {
    graph, businessId: state.businessId,
    nodes: { own: nodes.length, shared: state.shared, byType },
    duplicates: { certain: certain.length, possible: borderline.length, nodes: dupes.size, examples: [...certain, ...borderline].slice(0, EXAMPLES).map(pairLine) },
    mistyped: {
      otherBusinesses: others.length, firstNamePeople: firstNames.length, total: mistyped.size,
      examples: [
        ...others.map((n) => `${label(n)}${isSelf(n.name, { name: ownerName, ...(domain ? { domain } : {}) }) ? " (the business itself)" : ""}`),
        ...firstNames.map((n) => `${label(n)} (first name only)`),
      ].slice(0, EXAMPLES),
    },
    orphans: { count: orphans.length, byType: orphanTypes, examples: orphans.slice(0, EXAMPLES).map(label) },
    unsourced: {
      nodes: unsourcedNodes.length, edges: unsourcedEdges.length, facts: unsourcedFacts.length,
      examples: [...unsourcedNodes.map(label), ...unsourcedEdges, ...unsourcedFacts.map((f) => `Business ${f}`)].slice(0, EXAMPLES),
    },
    facts: {
      hours: ownerFacts.includes("hours"), address: ownerFacts.includes("address"), priceRange: ownerFacts.includes("priceRange"),
      pricedProducts: priced, fromListing,
    },
    tidied: { merged: state.merged, retyped: state.retyped, retired: state.retired },
    noise: nodes.length ? Math.round((noisy.size / nodes.length) * 1000) / 1000 : 0,
  };
}

export async function graphQuality(g: Read, businessId: string): Promise<QualityReport> {
  return qualityOf(await readGraphState(g, businessId, { embeddings: true }), g.name);
}

// The report as a few plain lines.
export function formatQuality(r: QualityReport): string {
  const types = (m: Record<string, number>) => Object.entries(m).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, v]) => `${k} ${v}`).join(", ") || "none";
  const ex = (xs: string[]) => xs.map((x) => `    - ${x}`);
  return [
    `Graph quality: ${r.graph} (business ${r.businessId})`,
    `  Own nodes: ${r.nodes.own} (${types(r.nodes.byType)}); ${r.nodes.shared} shared playbook nodes left out`,
    `  Noise: ${(r.noise * 100).toFixed(1)}% of own nodes are a duplicate, mistyped or an orphan`,
    `  Duplicates: ${r.duplicates.certain} certain pair(s), ${r.duplicates.possible} possible; ${r.duplicates.nodes} node(s) would go`, ...ex(r.duplicates.examples),
    `  Mistyped: ${r.mistyped.total} (${r.mistyped.otherBusinesses} other business(es) typed Business, ${r.mistyped.firstNamePeople} first name(s) as People)`, ...ex(r.mistyped.examples),
    `  Orphans: ${r.orphans.count} tied to nothing but their page (${types(r.orphans.byType)})`, ...ex(r.orphans.examples),
    `  No source: ${r.unsourced.nodes} node(s), ${r.unsourced.edges} relation(s), ${r.unsourced.facts} business fact(s)`, ...ex(r.unsourced.examples),
    `  Day-one facts: hours ${r.facts.hours ? "yes" : "no"}, address ${r.facts.address ? "yes" : "no"}, price range ${r.facts.priceRange ? "yes" : "no"}, ${r.facts.pricedProducts} priced product(s)` +
      `${r.facts.fromListing.length ? `; from the Google Maps listing: ${r.facts.fromListing.join(", ")}` : ""}`,
    `  Tidied (undo with db:unmerge): ${r.tidied.merged} merged, ${r.tidied.retyped} retyped, ${r.tidied.retired} retired`,
  ].join("\n");
}

export { pairKey };
