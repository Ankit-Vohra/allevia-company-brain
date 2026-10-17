// Shared plumbing for the graph tools (spec §7.2): defining a tool, turning rows into NodeRef/EdgeRef, gathering
// provenance (the Documents behind returned nodes), temporal predicates for `asOf`, full-text helpers, and the caps
// that keep results small. Every read goes through roQuery with a timeout of at most READ_TIMEOUT_MS.
//
// Provenance: every result's `sources` holds, first, one Document behind EACH returned node and each returned edge's
// `src` (so nothing comes back without its source when one exists), then further sources up to SOURCE_CAP.
//
// Errors: bad input the model can fix (unknown id, empty query, refused write) is thrown as InputError and comes back
// as a normal ToolResult with `data.error` and `note`, so the model can correct itself. Anything else throws.
import type { z } from "zod";
import type { AlleviaTool, ToolContext } from "../tool.js";
import type { EdgeRef, NodeRef, SourceRef, ToolResult } from "../../../shared/contracts.js";
import type { AlgoOpts } from "../../graph/algorithms.js";
import { currentEdge } from "../../graph/read.js";
import { MissingEndpoint } from "../../graph/errors.js";
import { openReference } from "../../graph/reference.js";
import { isReferenceId } from "../../ingest/sources/reference.js";
import { REL_TYPES, SEARCHABLE, typeOfLabels, type EntityType, type RelType } from "../../graph/schema.js";
import { toIso } from "../../util/time.js";
import { displayName } from "../../../shared/legacy-names.js";

export const READ_TIMEOUT_MS = 8_000;
export const DEFAULT_ROWS = 25;
export const TEXT_CAP = 400;
export const SOURCE_CAP = 20;          // sources beyond the one-per-node cover
export const SOURCE_COVER_CAP = 150;   // hard ceiling on the cover itself; every tool returns at most this many nodes
// Graph algorithms (paths, PageRank, communities) get one budget per call, passed as the graph core's `timeoutMs`
// (one budget across its projection reads and the algorithm query).
export const TOOL_ALGO_TIMEOUT_MS = 8_000;
export const ALGO_BUDGET: AlgoOpts = { timeoutMs: TOOL_ALGO_TIMEOUT_MS };

// Types that are plumbing, not business facts: hidden from neighbour lists unless asked for.
export const BOOKKEEPING_TYPES: EntityType[] = ["Version", "Turn", "Session", "Observation", "Chunk"];
// Memory/plumbing relationships: a Turn TOUCHES everything it read, so paths through them explain nothing.
export const MEMORY_RELS: RelType[] = ["TOUCHED", "CITED", "ASKED", "IN_SESSION", "HANDLED_BY", "HAD_VERSION", "REVIEWED"];
export const PATH_RELS: RelType[] = REL_TYPES.filter((r) => !MEMORY_RELS.includes(r));
export const SEARCH_TYPES: EntityType[] = SEARCHABLE;

export class InputError extends Error {
  override name = "InputError";
  constructor(message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

export function fail(message: string, extra: Record<string, unknown> = {}): ToolResult {
  return { data: { error: message, ...extra }, nodes: [], edges: [], sources: [], note: message };
}

// Wraps run() so input errors become ToolResults instead of exceptions.
export function defineTool<S extends z.ZodRawShape>(t: AlleviaTool<S>): AlleviaTool {
  const inner = t.run.bind(t);
  const tool: AlleviaTool<S> = {
    ...t,
    async run(args, ctx) {
      try {
        return await inner(args, ctx);
      } catch (e) {
        if (e instanceof InputError) return fail(e.message, e.extra);
        if (e instanceof MissingEndpoint) return fail(`${e.message}. Use search to find ids.`, { missing: e.ids });
        if (/timed? ?out/i.test(String((e as Error)?.message))) return fail("The query took too long. Narrow it: fewer hops, a smaller limit, or a specific id.");
        throw e;
      }
    },
  };
  return tool as unknown as AlleviaTool;
}

// ---------- writes ----------

// Agents of one turn run in parallel; write tools allocate ids like `memory:<turn>-<n>` by reading the highest n. One
// chain per graph makes read-then-write atomic within this process.
const chains = new Map<string, Promise<unknown>>();
export function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (chains.get(key) ?? Promise.resolve()).then(fn, fn);
  chains.set(key, next.catch(() => undefined));
  return next;
}

// The next free `<prefix><n>` (n from 1).
export async function nextId(ctx: ToolContext, prefix: string): Promise<string> {
  const [row] = await ro<{ max: number | null }>(ctx,
    "MATCH (n:Entity) WHERE n.id STARTS WITH $p RETURN max(toInteger(substring(n.id, size($p)))) AS max", { p: prefix });
  return `${prefix}${(row?.max ?? 0) + 1}`;
}

export function refuseIfReadOnly(ctx: ToolContext, tool: string): void {
  if (ctx.readOnly) throw new InputError(`${tool} is disabled in read-only mode; nothing was saved.`, { refused: true });
}

// ctx.signal is aborted when the agent's run is stopped (timeout, turn stopped): a write tool checks it right before it
// commits, so a run stopped mid-call changes nothing.
export function refuseIfStopped(ctx: ToolContext, tool: string): void {
  if (ctx.signal?.aborted) throw new InputError(`${tool} saved nothing: the run was stopped.`, { refused: true });
}

// ---------- reads ----------

// Two FalkorDB planner traps every query here avoids:
// - An UNWIND variable inside a pattern with an edge skips the id index: `UNWIND $ids AS x MATCH (a)-[r]->(:Entity
//   {id:x})` walks every such edge for each x (1.9 s against 5 ms for 600 ids). Bind the anchor alone first:
//   `UNWIND $ids AS x MATCH (n:Entity {id:x}) WITH x, n MATCH (a)-[r]->(n)`.
// - ORDER BY after RETURN resolves `v.until` against the RETURNed `v`; when `v` is a NODE() map without `until`, the
//   sort silently does nothing. Order by a RETURNed alias (`v.until AS until … ORDER BY until`).

// FalkorDB refuses a query outright ("Max pending queries exceeded") when its queue is full (MAX_QUEUED_QUERIES):
// a dozen agents reading in parallel can get there. Such a read waits and tries again, BUSY_RETRIES times, about 1.5 s
// in all; any other error is thrown at once.
const BUSY = /max pending queries/i;
const BUSY_RETRIES = 4;

export async function ro<T = Record<string, unknown>>(ctx: ToolContext, cypher: string, params?: Record<string, unknown>, timeoutMs = READ_TIMEOUT_MS): Promise<T[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await ctx.graph.roQuery<T>(cypher, params, { timeoutMs: Math.min(timeoutMs, READ_TIMEOUT_MS) });
    } catch (e) {
      if (attempt >= BUSY_RETRIES || !BUSY.test(String((e as Error)?.message))) throw e;
      await new Promise((r) => setTimeout(r, 100 * 2 ** attempt * (0.5 + Math.random())));
    }
  }
}

// FalkorDB sends at most 10,000 rows (RESULTSET_SIZE) and drops the rest without an error. A read that can produce
// more either aggregates on the server, or comes back packed: `body` is a query up to (not including) its last WITH,
// `row` the map each of its rows becomes; rows arrive PACK to a result row, at most `cap` of them, plus the full count.
export const PACK = 2_000;
export async function packed<T>(ctx: ToolContext, body: string, row: string, params: Record<string, unknown> = {}, cap = 50_000): Promise<{ rows: T[]; total: number }> {
  const parts = await ro<{ total: number; part: T[] }>(ctx,
    `${body}
     WITH collect(${row}) AS all
     WITH size(all) AS total, all[0..$cap] AS xs
     UNWIND range(0, size(xs) - 1, $pack) AS i RETURN total, xs[i..i + $pack] AS part`,
    { ...params, cap, pack: PACK });
  return { rows: parts.flatMap((p) => p.part), total: parts[0]?.total ?? 0 };
}

// ---------- the shared reference graph ----------

// The same context on the shared reference graph (general know-how; src/graph/reference.ts), so the read helpers here work
// on it unchanged. Null when the run reads no reference graph (ctx.reference === null).
export async function referenceCtx(ctx: ToolContext): Promise<ToolContext | null> {
  if (ctx.reference === null) return null;
  return { ...ctx, graph: ctx.reference ?? await openReference() };
}

// A read of the reference graph: `empty` while it is not loaded yet (no graph) or switched off.
export async function fromReference<T>(ctx: ToolContext, fn: (ref: ToolContext) => Promise<T>, empty: T): Promise<T> {
  const ref = await referenceCtx(ctx);
  if (!ref) return empty;
  try {
    return await fn(ref);
  } catch (e) {
    if (/empty key/i.test(String((e as Error)?.message))) return empty;
    throw e;
  }
}

// ---------- rows -> refs ----------

export interface NodeRow { id: string; labels: string[]; name: string | null; asOf: string | null; simulated: boolean | null }
export interface EdgeRow { from: string; type: string; to: string; since: number | null; until: number | null; src?: string | null }
export interface Brief { id: string; type: string; name: string }

// Cypher map projections; every query that returns nodes or edges uses these, so conversion is uniform.
export const NODE = (a: string): string => `{id: ${a}.id, labels: labels(${a}), name: ${a}.name, asOf: ${a}.asOf, simulated: ${a}.simulated}`;
export const EDGE = (r: string): string => `{from: startNode(${r}).id, type: type(${r}), to: endNode(${r}).id, since: ${r}.since, until: ${r}.until, src: ${r}.src}`;

export function typeOf(row: Pick<NodeRow, "labels">): string {
  return typeOfLabels(row.labels) ?? row.labels.find((l) => l !== "Entity") ?? "Entity";
}

export function toRef(row: NodeRow): NodeRef {
  const label = typeOf(row);
  const ref: NodeRef = { id: row.id, label, name: displayName(row.id, label, row.name ?? row.id) };
  if (typeof row.asOf === "string") ref.asOf = row.asOf;
  if (typeof row.simulated === "boolean") ref.simulated = row.simulated;
  return ref;
}

export function toEdge(row: EdgeRow): EdgeRef {
  return { from: row.from, type: row.type, to: row.to, ...(typeof row.since === "number" ? { since: row.since } : {}), until: row.until ?? null };
}

export const brief = (row: NodeRow): Brief => ({ id: row.id, type: typeOf(row), name: displayName(row.id, typeOf(row), row.name ?? row.id) });
export const edgeText = (e: EdgeRow | EdgeRef): string => `${e.from} -[${e.type}]-> ${e.to}`;

// Collects the nodes and edges a tool touched (deduplicated, in first-seen order) and builds the ToolResult.
export class Collector {
  readonly nodes = new Map<string, NodeRef>();
  readonly edges = new Map<string, EdgeRef>();
  private readonly prov = new Set<string>();
  private readonly edgeSrc = new Set<string>();

  node(row: NodeRow | null | undefined): NodeRef | undefined {
    if (!row || typeof row.id !== "string") return undefined;
    const have = this.nodes.get(row.id);
    if (have) return have;
    const ref = toRef(row);
    this.nodes.set(ref.id, ref);
    return ref;
  }

  edge(row: EdgeRow | null | undefined): void {
    if (!row || typeof row.from !== "string" || typeof row.to !== "string") return;
    this.edgeRef(toEdge(row), row.src);
  }

  // Refs that are already shaped (e.g. from algorithms.shortestPaths).
  ref(ref: NodeRef): void {
    if (!this.nodes.has(ref.id)) this.nodes.set(ref.id, ref);
  }

  // `src` is the edge's own provenance (the document that stated the relationship), when it has one.
  edgeRef(e: EdgeRef, src?: unknown): void {
    this.edges.set(`${e.from}|${e.type}|${e.to}|${e.since ?? ""}`, e);
    if (typeof src === "string" && src) this.edgeSrc.add(src);
  }

  // Ids whose sources count, without returning them as nodes (e.g. observations summarised into data).
  provenance(ids: Iterable<string>): void {
    for (const id of ids) this.prov.add(id);
  }

  async result<T>(ctx: ToolContext, data: T, note?: string): Promise<ToolResult<T>> {
    const sources = await sourcesFor(ctx, [...this.nodes.keys(), ...this.edgeSrc, ...this.prov]);
    return { data, nodes: [...this.nodes.values()], edges: [...this.edges.values()], sources, ...(note ? { note } : {}) };
  }
}

// Documents behind the given ids, in the ids' order: the id itself when it is a Document, its SOURCED_FROM targets,
// the Document named by its `src` prop, and a Chunk's parent Document.
export interface SourceRow { of: string; id: string; title: string | null; asOf: string | null }

const SOURCE_IDS_CAP = 1_000;
const SOURCES_PER_ID = 3; // SOURCED_FROM documents per id, newest first (a hub can have thousands)

// One row per (id, Document behind it), in the ids' order. At most 1 + SOURCES_PER_ID + 1 + 1 rows per id, so even
// SOURCE_IDS_CAP ids stay under FalkorDB's 10,000-row result cap (rows past it are dropped silently).
export async function sourceRows(ctx: ToolContext, ids: string[]): Promise<SourceRow[]> {
  const list = [...new Set(ids)].slice(0, SOURCE_IDS_CAP);
  if (!list.length) return [];
  const cols = "oid AS of, d.id AS id, coalesce(d.title, d.name) AS title, d.asOf AS asOf";
  const rows = await ro<SourceRow>(ctx,
    `UNWIND $ids AS oid MATCH (d:Entity {id:oid}) WHERE d:Document RETURN ${cols}
     UNION ALL
     UNWIND $ids AS oid MATCH (n:Entity {id:oid}) WITH oid, n MATCH (n)-[:SOURCED_FROM]->(d:Document) WITH oid, d ORDER BY d.asOf DESC, d.id
     WITH oid, collect(DISTINCT d)[0..$per] AS ds UNWIND ds AS d RETURN ${cols}
     UNION ALL
     UNWIND $ids AS oid MATCH (n:Entity {id:oid}) WHERE n.src IS NOT NULL WITH oid, n.src AS src MATCH (d:Entity {id:src}) WHERE d:Document RETURN ${cols}
     UNION ALL
     UNWIND $ids AS oid MATCH (c:Entity {id:oid}) WITH oid, c MATCH (d:Document)-[:HAS_CHUNK]->(c) RETURN ${cols}`,
    { ids: list, per: SOURCES_PER_ID });
  const order = new Map(list.map((id, i) => [id, i]));
  return rows.sort((a, b) => (order.get(a.of) ?? 0) - (order.get(b.of) ?? 0));
}

// First one source per id (the cover: nothing returned is left without its source), then the rest up to `cap`.
export async function sourcesFor(ctx: ToolContext, ids: string[], cap = SOURCE_CAP): Promise<SourceRef[]> {
  const rows = await sourceRows(ctx, ids);
  const out = new Map<string, SourceRef>();
  const add = (r: SourceRow) => {
    if (!out.has(r.id)) out.set(r.id, { id: r.id, title: r.title ?? r.id, ...(r.asOf ? { asOf: r.asOf } : {}) });
  };
  const covered = new Set<string>();
  for (const r of rows) {
    if (covered.has(r.of) || out.size >= SOURCE_COVER_CAP) continue;
    covered.add(r.of);
    add(r);
  }
  const limit = Math.max(cap, out.size);
  for (const r of rows) {
    if (out.size >= limit) break;
    add(r);
  }
  return [...out.values()];
}

// ---------- time ----------

// A bare date means the end of that day (UTC): "as of 1 Oct" includes what happened on 1 Oct.
export function parseAsOf(s: string | undefined): number | undefined {
  if (s === undefined || s.trim() === "") return undefined;
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T23:59:59.999Z`) : Date.parse(s);
  if (!Number.isFinite(ms)) throw new InputError(`asOf must be an ISO date like 2026-10-01, got ${JSON.stringify(s)}`);
  return ms;
}

// "holds now" or "held at $asOf" (pass { asOf } in the params when asOf is set).
export function edgeAt(alias: string, asOf?: number): string {
  return asOf === undefined ? currentEdge(alias) : currentEdge(alias, "asOf");
}

export const isoOrNull = (v: unknown): string | null => (typeof v === "number" && Number.isFinite(v) ? toIso(v) : typeof v === "string" ? v : null);

// ---------- text and numbers ----------

export function clip(v: unknown, n = TEXT_CAP): string | undefined {
  if (typeof v !== "string") return undefined;
  return v.length > n ? `${v.slice(0, n - 1)}…` : v;
}

// Never NaN: these numbers end up in query text (variable-length bounds) and LIMITs.
export const clamp = (v: number | undefined, def: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(typeof v === "number" && Number.isFinite(v) ? v : def)));

export const round = (v: number, d = 2): number => Math.round(v * 10 ** d) / 10 ** d;

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const EPOCH_PROPS = new Set(["createdAt", "updatedAt", "recordedAt", "retiredAt", "at", "since", "until"]);
const DROP_PROPS = new Set(["embedding", "textEmbedding", "stateSince", "closedCost", "rev", "_mergeToken"]);

// Node props for the model: no vectors, epoch ms as ISO, long text clipped, long lists shortened.
export function compactProps(kv: Array<[string, unknown]>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of kv) {
    if (DROP_PROPS.has(k) || v === null || v === undefined) continue;
    if (EPOCH_PROPS.has(k) && typeof v === "number") out[k] = toIso(v);
    else if (typeof v === "string") out[k] = clip(v);
    else if (Array.isArray(v)) out[k] = v.length > 20 ? [...v.slice(0, 20), `…${v.length - 20} more`] : v;
    else out[k] = v;
  }
  return out;
}

// ---------- full-text ----------

const STOPWORDS = new Set(
  ("a an and are as at be but by can could did do does for from had has have how i if in into is it its me my no not of on or our " +
    "so such that the their them then there these they this to was we were what when where which who whom why will with would you your")
    .split(" "));

// Words of a free-text query, lowercased, stopwords dropped (unicode-safe: Hindi stays Hindi).
export function ftTerms(text: string, max = 10): string[] {
  const out: string[] = [];
  for (const w of text.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}\p{M}]+/u)) {
    if (w.length < 2 || STOPWORDS.has(w) || out.includes(w)) continue;
    out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

// Any term, stemmed or as a prefix: "stories" matches "story" (stemming) and "storyboard" (prefix).
export function ftQuery(terms: string[]): string {
  return terms.map((t) => (t.length >= 3 ? `${t}|${t}*` : t)).join("|");
}

export interface FtHit { n: NodeRow; summary: string | null; score: number }

export async function ftEntities(ctx: ToolContext, text: string, types: readonly string[], k: number): Promise<FtHit[]> {
  const terms = ftTerms(text);
  if (!terms.length) return [];
  const hits = await ro<FtHit>(ctx,
    `CALL db.idx.fulltext.queryNodes('Searchable', $q) YIELD node, score
     WITH node, score WHERE any(l IN labels(node) WHERE l IN $types)
     RETURN ${NODE("node")} AS n, node.summary AS summary, score ORDER BY score DESC, node.id LIMIT $k`,
    { q: ftQuery(terms), types: [...types], k });
  // A duplicate the librarian merged answers as the node it was merged into (once, at its best rank).
  const canon = await canonicalOf(ctx, hits.map((h) => h.n.id));
  if (!canon.size) return hits;
  const seen = new Set<string>();
  return hits.map((h) => (canon.has(h.n.id) ? { ...h, n: canon.get(h.n.id)! } : h)).filter((h) => !seen.has(h.n.id) && !!seen.add(h.n.id));
}

// ---------- merged duplicates ----------

// The nodes among `ids` that the librarian merged into another (SAME_AS, `mergedInto`; src/ingest/merge.ts), each with
// the node it was merged into. Tools answer with that node, which carries every edge.
export async function canonicalOf(ctx: ToolContext, ids: string[]): Promise<Map<string, NodeRow>> {
  if (!ids.length) return new Map();
  const rows = await ro<{ id: string; c: NodeRow }>(ctx,
    `UNWIND $ids AS id MATCH (d:Entity {id:id}) WHERE d.mergedInto IS NOT NULL WITH d, d.mergedInto AS into MATCH (c:Entity {id: into})
     RETURN d.id AS id, ${NODE("c")} AS c`, { ids: [...new Set(ids)] });
  return new Map(rows.map((r) => [r.id, r.c]));
}

// ---------- resolving ids ----------

export async function getNode(ctx: ToolContext, id: string): Promise<NodeRow | null> {
  const [row] = await ro<{ n: NodeRow }>(ctx, `MATCH (n:Entity {id:$id}) RETURN ${NODE("n")} AS n LIMIT 1`, { id });
  return row?.n ?? null;
}

export async function getNodes(ctx: ToolContext, ids: string[]): Promise<Map<string, NodeRow>> {
  if (!ids.length) return new Map();
  const rows = await ro<{ n: NodeRow }>(ctx, `UNWIND $ids AS id MATCH (n:Entity {id:id}) RETURN ${NODE("n")} AS n`, { ids: [...new Set(ids)] });
  return new Map(rows.map((r) => [r.n.id, r.n]));
}

// Close matches for an id the model got wrong ("decision:pause-stories" -> the real decision id).
export async function suggest(ctx: ToolContext, idOrText: string): Promise<Brief[]> {
  const text = idOrText.includes(":") ? idOrText.slice(idOrText.indexOf(":") + 1) : idOrText;
  try {
    return (await ftEntities(ctx, text.replace(/[-_]/g, " "), SEARCH_TYPES, 5)).map((h) => brief(h.n));
  } catch {
    return [];
  }
}

// What a tool says when a name or id is not in this business's graph. It is said BEFORE any traversal runs, so the
// answer is "I don't have that in your records", never an empty result that reads like "nothing depends on it".
export const notInRecords = (text: string): string => `I don't have ${JSON.stringify(text)} in your records.`;

// The node with this id; a merged duplicate's id gives the node it was merged into. A plain name ("Instagram
// connector") is resolved first: a node whose name is exactly that (any case) is the one meant. Anything else is
// refused with notInRecords and the closest things that are in the records.
export async function requireNode(ctx: ToolContext, id: string): Promise<NodeRow> {
  const [found] = await ro<{ n: NodeRow; c: NodeRow | null }>(ctx,
    `MATCH (n:Entity {id:$id}) OPTIONAL MATCH (c:Entity {id: n.mergedInto})
     RETURN ${NODE("n")} AS n, CASE WHEN c IS NULL THEN null ELSE ${NODE("c")} END AS c LIMIT 1`, { id });
  if (found) return found.c ?? found.n;
  // a shared rule, playbook or reference document (src/graph/reference.ts) is not in the business's records but still resolves
  if (isReferenceId(id)) {
    const shared = await fromReference(ctx, (ref) => getNode(ref, id), null);
    if (shared) return shared;
  }
  const named = await byExactName(ctx, id);
  if (named) return named;
  const suggestions = await suggest(ctx, id);
  throw new InputError(
    `${notInRecords(id)}${suggestions.length ? ` Closest things in the records: ${suggestions.map((s) => s.id).join(", ")}.` : " Use search to find ids."}`,
    { suggestions, notInRecords: true });
}

// The one searchable node whose name is exactly `text` (case and spacing ignored); null when none, or when two differ.
export async function byExactName(ctx: ToolContext, text: string, types: readonly string[] = SEARCH_TYPES): Promise<NodeRow | null> {
  const want = text.trim().replace(/\s+/g, " ").toLowerCase();
  if (!want || /^[a-z]+:/.test(want)) return null; // an id that was not found is not a name
  const hits = await ftEntities(ctx, want, types, 10).catch(() => [] as FtHit[]);
  const exact = hits.filter((h) => String(h.n.name ?? "").trim().replace(/\s+/g, " ").toLowerCase() === want);
  const ids = new Set(exact.map((h) => h.n.id));
  return ids.size === 1 ? exact[0]!.n : null;
}

// `id` wins; otherwise the best full-text match among `types` (the rest come back as alternatives).
export async function resolveTarget(ctx: ToolContext, args: { id?: string; query?: string }, types: readonly string[] = SEARCH_TYPES): Promise<{ node: NodeRow; alternatives: Brief[] }> {
  if (args.id?.trim()) return { node: await requireNode(ctx, args.id.trim()), alternatives: [] };
  if (!args.query?.trim()) throw new InputError("Pass an id (preferred) or a query.");
  const hits = await ftEntities(ctx, args.query, types, 5);
  if (!hits.length) {
    throw new InputError(`${notInRecords(args.query.trim())} Nothing matches it among ${types.length > 6 ? "entities" : types.join("/")}; try search with other words.`,
      { notInRecords: true });
  }
  return { node: hits[0]!.n, alternatives: hits.slice(1).map((h) => brief(h.n)) };
}
