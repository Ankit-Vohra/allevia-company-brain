// `graph:reference-split` (src/cli/hygiene.ts): moves the general know-how out of business graphs that still hold a copy of it
// (onboarding copied the playbooks into every business until 17 Oct 2026) and leaves each business only its own facts.
//
// For one business graph:
//   1. find its reference nodes (referenceFilter: the ids of the current reference write, a vendored source, or a stub);
//   2. a reference node that something of the business depends on is KEPT AS A STUB (same id and type, name, a short summary,
//      kind, severity, howToFix; `refStub: true`): a Page FAILS or PASSES it, a Content USES_RULE it, a Turn or Finding CITED
//      it, a card is GUIDED_BY or BASED_ON it, an Asset GUIDED_BY it… Edges of the copy itself (a Playbook INCLUDES a Rule,
//      SOURCED_FROM the vendored file, APPLIES_TO or AFFECTS a channel) and memory plumbing (a Turn TOUCHED it, an Agent
//      KNOWS_ABOUT it, its Versions) are not dependencies. A stub loses the copy's edges, and keeps every business edge;
//   3. every other reference node is removed, with its Versions and Chunks.
// Dry run by default: it reads and reports, and writes nothing. With apply, the caller backs the business up first
// (tenant:export, src/cli/hygiene.ts), and the shared reference graph is loaded before anything is removed.
import { MAX_PAGE, type GraphHandle } from "./client.js";
import { noteGraphWrite } from "./projection.js";
import { referenceFilter, referenceParams } from "./reference.js";
import { isRelType, typeOfLabels } from "./schema.js";
import { isReferenceEdge } from "../ingest/sources/reference.js";

// Edges that are not a reason to keep a reference node: memory plumbing (dropped with the node).
const WEAK_RELS = ["TOUCHED", "KNOWS_ABOUT", "HAD_VERSION"];
// Edges of the copy itself, from a reference node to a channel anchor (an older pack version had other ones).
const COPY_RELS = new Set(["APPLIES_TO", "AFFECTS", "INCLUDES", "SOURCED_FROM"]);
// What a stub keeps; everything else (the rule text, template, example, embedding…) stays only in the reference graph.
const STUB_KEEP = new Set([
  "id", "name", "summary", "src", "asOf", "simulated", "createdAt", "updatedAt", "stateSince", "rev", "refStub",
  "kind", "severity", "weight", "issueType", "category", "hookId", "industry", "howToFix", "status",
]);
const BATCH = 200;

export interface SplitKept { id: string; type: string; why: string[] }
export interface SplitReport {
  graph: string;
  applied: boolean;
  reference: Record<string, number>;    // reference nodes found, by type (stubs included)
  alreadyStubs: number;
  kept: SplitKept[];                    // kept as stubs, with the business edges that need them
  removed: Record<string, number>;      // removed (or, in a dry run, to remove), by type
  versions: number;                     // their Versions removed (or to remove)
  chunks: number;                       // their Chunks removed (or to remove)
  touchedDropped: number;               // Turn TOUCHED / Agent KNOWS_ABOUT edges that go with the removed nodes
  before: { nodes: number; edges: number };
  after?: { nodes: number; edges: number };
}

interface RefRow { id: string; labels: string[]; stub: boolean | null }
interface DepRow { id: string; rel: string; from: string; to: string; other: string; labels: string[] }

async function size(g: GraphHandle): Promise<{ nodes: number; edges: number }> {
  const [n] = await g.roQuery<{ c: number }>("MATCH (n) RETURN count(n) AS c");
  const [e] = await g.roQuery<{ c: number }>("MATCH ()-[r]->() WHERE ID(r) >= 0 RETURN count(r) AS c");
  return { nodes: n?.c ?? 0, edges: e?.c ?? 0 };
}

// The reference nodes of a business graph (Versions and Chunks are not entities of their own), paged by id.
export async function referenceNodesOf(g: GraphHandle): Promise<RefRow[]> {
  const out: RefRow[] = [];
  for (let after = ""; ;) {
    const rows = await g.roQuery<RefRow>(
      `MATCH (n:Entity) WHERE n.id > $after AND NOT n:Version AND NOT n:Chunk AND ${referenceFilter("n")}
       RETURN n.id AS id, labels(n) AS labels, n.refStub AS stub ORDER BY id LIMIT $limit`,
      { ...referenceParams(), after, limit: MAX_PAGE });
    out.push(...rows);
    if (rows.length < MAX_PAGE) return out;
    after = rows[rows.length - 1]!.id;
  }
}

const chunks = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

export async function splitReference(g: GraphHandle, opts: { apply?: boolean; now?: number } = {}): Promise<SplitReport> {
  const before = await size(g);
  const refs = await referenceNodesOf(g);
  const ids = refs.map((r) => r.id);
  const idSet = new Set(ids);
  const typeOf = (labels: string[]): string => typeOfLabels(labels) ?? labels.find((l) => l !== "Entity" && l !== "Searchable") ?? "Entity";
  const reference: Record<string, number> = {};
  for (const r of refs) reference[typeOf(r.labels)] = (reference[typeOf(r.labels)] ?? 0) + 1;

  // every edge between a reference node and a node outside the copy
  const deps: DepRow[] = [];
  let touchedDropped = 0;
  for (const part of chunks(ids, BATCH)) {
    deps.push(...await g.roQuery<DepRow>(
      `UNWIND $ids AS id MATCH (n:Entity {id:id}) WITH n MATCH (n)-[r]-(m:Entity) WHERE NOT m.id IN $all AND NOT type(r) IN $weak AND NOT m:Version
       RETURN n.id AS id, type(r) AS rel, startNode(r).id AS from, endNode(r).id AS to, m.id AS other, labels(m) AS labels`,
      { ids: part, all: ids, weak: WEAK_RELS }));
    const [w] = await g.roQuery<{ c: number }>(
      "UNWIND $ids AS id MATCH (n:Entity {id:id}) WITH n MATCH (n)-[r]-(m:Entity) WHERE type(r) IN ['TOUCHED', 'KNOWS_ABOUT'] RETURN count(r) AS c",
      { ids: part });
    touchedDropped += w?.c ?? 0;
  }
  const copyEdge = (d: DepRow): boolean =>
    isReferenceEdge(d.from, d.rel, d.to) || (d.from === d.id && COPY_RELS.has(d.rel) && (d.labels.includes("Channel") || d.labels.includes("Document")));
  const why = new Map<string, Map<string, number>>();
  for (const d of deps) {
    if (copyEdge(d)) continue;
    const dir = d.from === d.id ? `${d.rel} -> ${typeOf(d.labels)}` : `${typeOf(d.labels)} ${d.rel}`;
    const m = why.get(d.id) ?? new Map<string, number>();
    m.set(dir, (m.get(dir) ?? 0) + 1);
    why.set(d.id, m);
  }
  const byId = new Map(refs.map((r) => [r.id, r]));
  const kept: SplitKept[] = [...why.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, m]) => ({
    id, type: typeOf(byId.get(id)!.labels), why: [...m.entries()].map(([k, n]) => `${k}${n > 1 ? ` (${n})` : ""}`),
  }));
  const keep = new Set(kept.map((k) => k.id));
  const gone = ids.filter((id) => !keep.has(id));
  const removed: Record<string, number> = {};
  for (const id of gone) { const t = typeOf(byId.get(id)!.labels); removed[t] = (removed[t] ?? 0) + 1; }

  let versions = 0;
  let chunkCount = 0;
  for (const part of chunks(gone, BATCH)) {
    const [v] = await g.roQuery<{ c: number }>("UNWIND $ids AS id MATCH (n:Entity {id:id}) WITH n MATCH (n)-[:HAD_VERSION]->(v:Version) RETURN count(DISTINCT v) AS c", { ids: part });
    const [c] = await g.roQuery<{ c: number }>("UNWIND $ids AS id MATCH (n:Entity {id:id}) WITH n MATCH (n)-[:HAS_CHUNK]->(c:Chunk) RETURN count(DISTINCT c) AS c", { ids: part });
    versions += v?.c ?? 0;
    chunkCount += c?.c ?? 0;
  }
  const report: SplitReport = {
    graph: g.name, applied: false, reference, alreadyStubs: refs.filter((r) => r.stub === true).length, kept, removed, versions,
    chunks: chunkCount, touchedDropped, before,
  };
  if (!opts.apply) return report;

  // ---- apply: stubs first (so nothing of the business loses an endpoint), then the rest ----
  const now = opts.now ?? Date.now();
  for (const id of keep) {
    const [row] = await g.roQuery<{ kv: Array<[string, unknown]> }>(
      "MATCH (n:Entity {id:$id}) RETURN [k IN keys(n) WHERE NOT k IN ['embedding', 'textEmbedding'] | [k, n[k]]] AS kv", { id });
    if (!row) continue;
    const props: Record<string, unknown> = Object.fromEntries(row.kv.filter(([k]) => STUB_KEEP.has(k)));
    if (typeof props.summary === "string" && props.summary.length > 200) props.summary = `${props.summary.slice(0, 199).trimEnd()}…`;
    if (typeof props.howToFix === "string" && props.howToFix.length > 300) props.howToFix = `${props.howToFix.slice(0, 299).trimEnd()}…`;
    props.refStub = true;
    props.rev = (typeof props.rev === "number" ? props.rev : 0) + 1;
    props.updatedAt = now;
    await g.query("MATCH (n:Entity {id:$id}) SET n = $props", { id, props });
    // the copy's own edges go; the business's stay
    const own = await g.roQuery<DepRow>(
      "MATCH (n:Entity {id:$id})-[r]-(m:Entity) RETURN n.id AS id, type(r) AS rel, startNode(r).id AS from, endNode(r).id AS to, m.id AS other, labels(m) AS labels",
      { id });
    for (const d of own.filter((x) => copyEdge(x) && !keep.has(x.other) && isRelType(x.rel))) {
      await g.query(`MATCH (a:Entity {id:$from})-[r:${d.rel}]->(b:Entity {id:$to}) DELETE r`, { from: d.from, to: d.to });
    }
  }
  for (const part of chunks(gone, BATCH)) {
    await g.query("UNWIND $ids AS id MATCH (n:Entity {id:id}) WITH n MATCH (n)-[:HAD_VERSION]->(v:Version) DETACH DELETE v", { ids: part });
    await g.query("UNWIND $ids AS id MATCH (n:Entity {id:id}) WITH n MATCH (n)-[:HAS_CHUNK]->(c:Chunk) DETACH DELETE c", { ids: part });
    await g.query("UNWIND $ids AS id MATCH (n:Entity {id:id}) DETACH DELETE n", { ids: part });
  }
  await noteGraphWrite(g.name);
  return { ...report, applied: true, after: await size(g) };
}

const n = (x: number): string => x.toLocaleString("en-US");
const counts = (o: Record<string, number>): string => Object.entries(o).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${n(v)} ${k}`).join(", ") || "none";

export function formatSplit(slug: string, r: SplitReport, opts: { maxKept?: number } = {}): string {
  const total = Object.values(r.reference).reduce((s, x) => s + x, 0);
  const gone = Object.values(r.removed).reduce((s, x) => s + x, 0);
  const lines = [
    `${slug} (${r.graph}): ${n(r.before.nodes)} nodes, ${n(r.before.edges)} edges${r.after ? ` -> ${n(r.after.nodes)} nodes, ${n(r.after.edges)} edges` : ""}`,
    `  general know-how found: ${n(total)} (${counts(r.reference)})${r.alreadyStubs ? `, ${n(r.alreadyStubs)} already stubs` : ""}`,
    `  ${r.applied ? "removed" : "would remove"}: ${n(gone)} (${counts(r.removed)}), with ${n(r.versions)} versions and ${n(r.chunks)} chunks; ${n(r.touchedDropped)} TOUCHED/KNOWS_ABOUT edges go with them`,
    `  ${r.applied ? "kept" : "would keep"} as stubs: ${n(r.kept.length)}${r.kept.length ? " (business facts point at them)" : ""}`,
  ];
  const max = opts.maxKept ?? 25;
  for (const k of r.kept.slice(0, max)) lines.push(`    ${k.id} (${k.type}): ${k.why.join("; ")}`);
  if (r.kept.length > max) lines.push(`    … and ${n(r.kept.length - max)} more (--json lists them all)`);
  return lines.join("\n");
}
