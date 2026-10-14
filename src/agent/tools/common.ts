// Shared plumbing for the graph tools (spec §7.2): defining a tool, turning rows into NodeRef/EdgeRef, gathering
// provenance (the Documents behind returned nodes), temporal predicates for `asOf`, full-text helpers, and the caps
// that keep results small. Every read goes through roQuery with a timeout of at most READ_TIMEOUT_MS.
//
// Errors: bad input the model can fix (unknown id, empty query, refused write) is thrown as InputError and comes back
// as a normal ToolResult with `data.error` and `note`, so the model can correct itself. Anything else throws.
import type { z } from "zod";
import type { AlleviaTool, ToolContext } from "../tool.js";
import type { EdgeRef, NodeRef, SourceRef, ToolResult } from "../../../shared/contracts.js";
import type { GraphHandle, QueryOpts } from "../../graph/client.js";
import { currentEdge } from "../../graph/read.js";
import { MissingEndpoint } from "../../graph/errors.js";
import { REL_TYPES, SEARCHABLE, typeOfLabels, type EntityType, type RelType } from "../../graph/schema.js";
import { toIso } from "../../util/time.js";

export const READ_TIMEOUT_MS = 8_000;
export const DEFAULT_ROWS = 25;
export const TEXT_CAP = 400;
export const SOURCE_CAP = 20;

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
  const rows = await ro<{ id: string }>(ctx, "MATCH (n:Entity) WHERE n.id STARTS WITH $p RETURN n.id AS id", { p: prefix });
  const max = rows.reduce((m, r) => Math.max(m, Number(r.id.slice(prefix.length)) || 0), 0);
  return `${prefix}${max + 1}`;
}

export function refuseIfReadOnly(ctx: ToolContext, tool: string): void {
  if (ctx.readOnly) throw new InputError(`${tool} is disabled in read-only mode; nothing was saved.`, { refused: true });
}

// ---------- reads ----------

export function ro<T = Record<string, unknown>>(ctx: ToolContext, cypher: string, params?: Record<string, unknown>, timeoutMs = READ_TIMEOUT_MS): Promise<T[]> {
  return ctx.graph.roQuery<T>(cypher, params, { timeoutMs: Math.min(timeoutMs, READ_TIMEOUT_MS) });
}

// The graph core's algorithms call roQuery without a timeout; this view caps every read they make.
export function bounded(g: GraphHandle, ms = READ_TIMEOUT_MS): GraphHandle {
  return new Proxy(g, {
    get(target, key) {
      if (key === "roQuery") {
        return (c: string, p?: Record<string, unknown>, o?: QueryOpts) => target.roQuery(c, p, { ...o, timeoutMs: Math.min(o?.timeoutMs ?? ms, ms) });
      }
      const v = Reflect.get(target, key, target) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

// ---------- rows -> refs ----------

export interface NodeRow { id: string; labels: string[]; name: string | null; asOf: string | null; simulated: boolean | null }
export interface EdgeRow { from: string; type: string; to: string; since: number | null; until: number | null }
export interface Brief { id: string; type: string; name: string }

// Cypher map projections; every query that returns nodes or edges uses these, so conversion is uniform.
export const NODE = (a: string): string => `{id: ${a}.id, labels: labels(${a}), name: ${a}.name, asOf: ${a}.asOf, simulated: ${a}.simulated}`;
export const EDGE = (r: string): string => `{from: startNode(${r}).id, type: type(${r}), to: endNode(${r}).id, since: ${r}.since, until: ${r}.until}`;

export function typeOf(row: Pick<NodeRow, "labels">): string {
  return typeOfLabels(row.labels) ?? row.labels.find((l) => l !== "Entity") ?? "Entity";
}

export function toRef(row: NodeRow): NodeRef {
  const ref: NodeRef = { id: row.id, label: typeOf(row), name: row.name ?? row.id };
  if (typeof row.asOf === "string") ref.asOf = row.asOf;
  if (typeof row.simulated === "boolean") ref.simulated = row.simulated;
  return ref;
}

export function toEdge(row: EdgeRow): EdgeRef {
  return { from: row.from, type: row.type, to: row.to, ...(typeof row.since === "number" ? { since: row.since } : {}), until: row.until ?? null };
}

export const brief = (row: NodeRow): Brief => ({ id: row.id, type: typeOf(row), name: row.name ?? row.id });
export const edgeText = (e: EdgeRow | EdgeRef): string => `${e.from} -[${e.type}]-> ${e.to}`;

// Collects the nodes and edges a tool touched (deduplicated, in first-seen order) and builds the ToolResult.
export class Collector {
  readonly nodes = new Map<string, NodeRef>();
  readonly edges = new Map<string, EdgeRef>();
  private readonly prov = new Set<string>();

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
    this.edgeRef(toEdge(row));
  }

  // Refs that are already shaped (e.g. from algorithms.shortestPaths).
  ref(ref: NodeRef): void {
    if (!this.nodes.has(ref.id)) this.nodes.set(ref.id, ref);
  }

  edgeRef(e: EdgeRef): void {
    this.edges.set(`${e.from}|${e.type}|${e.to}|${e.since ?? ""}`, e);
  }

  // Ids whose sources count, without returning them as nodes (e.g. observations summarised into data).
  provenance(ids: Iterable<string>): void {
    for (const id of ids) this.prov.add(id);
  }

  async result<T>(ctx: ToolContext, data: T, note?: string): Promise<ToolResult<T>> {
    const sources = await sourcesFor(ctx, [...this.nodes.keys(), ...this.prov]);
    return { data, nodes: [...this.nodes.values()], edges: [...this.edges.values()], sources, ...(note ? { note } : {}) };
  }
}

// Documents behind the given ids, in the ids' order: the id itself when it is a Document, its SOURCED_FROM targets,
// and the Document named by its `src` prop.
export interface SourceRow { of: string; id: string; title: string | null; asOf: string | null }

// One row per (id, Document behind it), in the ids' order.
export async function sourceRows(ctx: ToolContext, ids: string[]): Promise<SourceRow[]> {
  const list = [...new Set(ids)].slice(0, 300);
  if (!list.length) return [];
  const cols = "oid AS of, d.id AS id, coalesce(d.title, d.name) AS title, d.asOf AS asOf";
  const rows = await ro<SourceRow>(ctx,
    `UNWIND $ids AS oid MATCH (d:Entity {id:oid}) WHERE d:Document RETURN ${cols}
     UNION ALL
     UNWIND $ids AS oid MATCH (:Entity {id:oid})-[:SOURCED_FROM]->(d:Document) RETURN ${cols}
     UNION ALL
     UNWIND $ids AS oid MATCH (n:Entity {id:oid}) WHERE n.src IS NOT NULL WITH oid, n.src AS src MATCH (d:Entity {id:src}) WHERE d:Document RETURN ${cols}`,
    { ids: list });
  const order = new Map(list.map((id, i) => [id, i]));
  return rows.sort((a, b) => (order.get(a.of) ?? 0) - (order.get(b.of) ?? 0));
}

export async function sourcesFor(ctx: ToolContext, ids: string[], cap = SOURCE_CAP): Promise<SourceRef[]> {
  const rows = await sourceRows(ctx, ids);
  const out = new Map<string, SourceRef>();
  for (const r of rows) {
    if (out.size >= cap) break;
    if (!out.has(r.id)) out.set(r.id, { id: r.id, title: r.title ?? r.id, ...(r.asOf ? { asOf: r.asOf } : {}) });
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

export const clamp = (v: number | undefined, def: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(v ?? def)));

export const round = (v: number, d = 2): number => Math.round(v * 10 ** d) / 10 ** d;

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const EPOCH_PROPS = new Set(["createdAt", "updatedAt", "recordedAt", "retiredAt", "at", "since", "until"]);
const DROP_PROPS = new Set(["embedding", "textEmbedding", "stateSince", "closedCost"]);

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
  return ro<FtHit>(ctx,
    `CALL db.idx.fulltext.queryNodes('Entity', $q) YIELD node, score
     WITH node, score WHERE any(l IN labels(node) WHERE l IN $types)
     RETURN ${NODE("node")} AS n, node.summary AS summary, score ORDER BY score DESC, node.id LIMIT $k`,
    { q: ftQuery(terms), types: [...types], k });
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

export async function requireNode(ctx: ToolContext, id: string): Promise<NodeRow> {
  const row = await getNode(ctx, id);
  if (row) return row;
  const suggestions = await suggest(ctx, id);
  throw new InputError(
    `No entity with id ${id}.${suggestions.length ? ` Did you mean: ${suggestions.map((s) => s.id).join(", ")}?` : " Use search to find ids."}`,
    { suggestions });
}

// `id` wins; otherwise the best full-text match among `types` (the rest come back as alternatives).
export async function resolveTarget(ctx: ToolContext, args: { id?: string; query?: string }, types: readonly string[] = SEARCH_TYPES): Promise<{ node: NodeRow; alternatives: Brief[] }> {
  if (args.id?.trim()) return { node: await requireNode(ctx, args.id.trim()), alternatives: [] };
  if (!args.query?.trim()) throw new InputError("Pass an id (preferred) or a query.");
  const hits = await ftEntities(ctx, args.query, types, 5);
  if (!hits.length) throw new InputError(`Nothing matches ${JSON.stringify(args.query)} among ${types.length > 6 ? "entities" : types.join("/")}. Try search.`);
  return { node: hits[0]!.n, alternatives: hits.slice(1).map((h) => brief(h.n)) };
}
