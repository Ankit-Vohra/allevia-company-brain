// runIngest (spec §6.1): one tenant's sources → privacy filter → deterministic writes and LLM extraction → embeddings →
// librarian → privacy scan → report. Order:
//   1. ensureTenant + ensureIndexes
//   2. sources: brain (vault + registry + PENDING + ADRs), ops (latest snapshot dir), playbooks, simulated ads, and the
//      GitHub issues fetch (mapped later, once the graph knows the names to look for)
//   3. the deterministic writes, as one batch (a node several sources describe is merged first, so sources never take
//      turns overwriting each other), then stale vault structure (chunks, links a document no longer has) is closed
//   4. embeddings for the entities so far (entity resolution's similar() searches them)
//   5. LLM extraction of the vault documents in priority order (decisions, the 14 most recent daily reports, the rest by
//      in-links), at most `limitDocs` (default 80), 3 at a time through the on-disk cache; each result is resolved
//      against the graph (known names, then the vector index with the name-agreement rule) and written in that same
//      order, so a run is deterministic whatever order the model answers in; then re-resolved from the cache against the
//      finished graph until a pass changes nothing (so the next run has nothing left to change)
//   6. GitHub issues → Tasks, owners and MENTIONS of what the graph now knows
//   7. embeddings for everything new or changed (entities and chunks), then the librarian
//   8. scanGraph: any hit fails the run loudly (after the report is saved)
//   9. the report → <dataDir>/runs/<tenant>/<ts>.json, and an Event {kind:'ingest'} node
// Idempotent: a second run with unchanged sources creates 0 nodes and 0 edges and calls no model (the run's own Event
// node aside). A dry run reads the sources and ranks the documents, and writes nothing and calls no model.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { loadConfig } from "../config.js";
import { MAX_PAGE, openGraph, type GraphHandle } from "../graph/client.js";
import { ensureIndexes, CHUNK_VECTOR_PROP, ENTITY_VECTOR_PROP } from "../graph/indexes.js";
import { ensureTenant, businessId } from "../graph/tenants.js";
import { isEntityType, typeOfLabels, type EntityType } from "../graph/schema.js";
import { closeEdge, observationId, upsertNode, writeBatch, type EdgeInput, type NodeInput, type ObservationInput, type WriteStats } from "../graph/upsert.js";
import { noteGraphWrite } from "../graph/projection.js";
import { searchableTypesPredicate } from "../graph/read.js";
import { entityId, sha256 } from "../util/ids.js";
import { istDate } from "../util/time.js";
import { tenantConfig, type SourceName, type TenantConfig } from "../tenant-config.js";
import { EXTRACTABLE_TYPES, extractDoc, rememberWrite, resolveExtraction, type Extraction, type KnownEntity } from "./extract.js";
import { normName } from "./resolve-names.js";
import { AgentSdkRunner, FatalLlmError, Semaphore, type LlmRunner } from "./llm.js";
import { EMBED_MODEL, embedPassages, entityText } from "./embed.js";
import { scanGraph, type ScanHit } from "./privacy.js";
import { runLibrarian, type LibrarianReport } from "./librarian.js";
import { loadBrain } from "./sources/brain.js";
import { mapSnapshot } from "./sources/ops.js";
import { loadPlaybooks } from "./sources/playbooks.js";
import { simulateAds } from "./sources/simads.js";
import { fetchIssues, mapIssues, type GhIssue, type GhRunner } from "./sources/github.js";
import type { IngestReport, RawDoc, SourceResult } from "./types.js";

export const DEFAULT_EXTRACT_LIMIT = 80;
export const RECENT_DAILY_REPORTS = 14;
export const EXTRACT_CONCURRENCY = 3;
export const MAX_SETTLE_PASSES = 3;
const EMBED_WRITE_BATCH = 32;
const MAX_LISTED = 200; // per list in the report (skipped files, write errors…)

export type EmbedFn = (texts: string[]) => Promise<number[][]>;

export interface IngestOptions {
  sources?: SourceName[];
  limitDocs?: number;          // most documents to send to the model (default 80); the rest are listed as skipped
  model?: string;              // extraction model alias (default config.extractModel, "haiku")
  dryRun?: boolean;
  runner?: LlmRunner;          // default: AgentSdkRunner on the subscription
  embed?: EmbedFn;             // default: local e5-small passages
  gh?: GhRunner;               // default: the gh CLI
  brainPath?: string;          // default: tenant config, then config.brainPath
  dataDir?: string;            // default: config.dataDir (cache, runs, snapshots)
  opsSnapshotDir?: string;     // default: the latest <dataDir>/snapshots/<tenant>/<date>/
  metaGraph?: string;          // tenant registry graph (tests use their own)
  now?: Date;
  log?: (line: string) => void;
}

export interface PipelineReport extends IngestReport {
  dryRun: boolean;
  model: string;
  durationMs: number;
  sources: Array<IngestReport["sources"][number] & { ms: number }>;
  extraction: IngestReport["extraction"] & {
    candidates: number; skipped: number; failed: number; observations: number; olderReadings: number; settlePasses: number;
    order: string[]; skippedDocs: Array<{ id: string; reason: string }>; failures: Array<{ id: string; error: string }>;
  };
  embeddings: { entities: number; chunks: number };
  retired: { structure: number; mentions: number };
  librarian?: LibrarianReport;
  graph: { nodes: Record<string, number>; edges: Record<string, number> };
  skipped: Array<{ source: string; ref: string; reason: string }>;
  writeErrors: Array<{ kind: string; ref: string; error: string }>;
  privacyScan: { hits: number; byKind: Record<string, number>; sample: ScanHit[] };
}

export interface IngestRun { report: PipelineReport; reportPath: string }

// ---------- pure helpers (exported for tests) ----------

const dateOf = (d: RawDoc): string => d.asOf ?? /\d{4}-\d{2}-\d{2}/.exec(d.path ?? "")?.[0] ?? "";
const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const byPath = (a: RawDoc, b: RawDoc) => ((a.path ?? a.id) < (b.path ?? b.id) ? -1 : (a.path ?? a.id) > (b.path ?? b.id) ? 1 : 0);

// Decisions (by path), then the most recent daily reports, then everything else by in-links, commits, date, path.
export function extractionOrder(docs: RawDoc[]): RawDoc[] {
  const decisions = docs.filter((d) => d.kind === "decision").sort(byPath);
  const daily = docs.filter((d) => d.kind === "report" && (d.path ?? "").includes("/daily/"))
    .sort((a, b) => (dateOf(a) < dateOf(b) ? 1 : dateOf(a) > dateOf(b) ? -1 : byPath(a, b)));
  const recent = daily.slice(0, RECENT_DAILY_REPORTS);
  const taken = new Set([...decisions, ...recent].map((d) => d.id));
  const rest = docs.filter((d) => !taken.has(d.id)).sort((a, b) =>
    num(b.meta?.inLinks) - num(a.meta?.inLinks) || num(b.meta?.commits) - num(a.meta?.commits)
    || (dateOf(a) < dateOf(b) ? 1 : dateOf(a) > dateOf(b) ? -1 : 0) || byPath(a, b));
  return [...decisions, ...recent, ...rest];
}

const STOP = new Set(["a", "an", "the", "for", "of", "to", "in", "on", "and", "or", "every", "all", "adr", "our", "we", "is", "be", "with", "by", "no"]);
const words = (s: string) => new Set(normName(s).split(" ").filter((w) => w && !STOP.has(w) && !/^\d+$/.test(w)));

// An ADR's extraction names its decision in the model's own words ("Require human review for every post"). The ADR
// already is a Decision node (adr.ts), so the extracted decision that is the ADR itself takes the ADR's name (the model's
// name becomes an alias) and resolves onto it instead of becoming a near-duplicate. "Is the ADR": the only Decision in
// the extraction, or the one sharing the most words with the ADR's name (at least half of the shorter name's words).
export function alignAdrDecision(ex: Extraction, decisionName: string): Extraction {
  const decisions = ex.entities.map((e, i) => ({ e, i })).filter((x) => x.e.type === "Decision");
  if (!decisions.length || decisions.some((x) => normName(x.e.name) === normName(decisionName))) return ex;
  const target = words(decisionName);
  const score = (name: string) => {
    const w = words(name);
    const shared = [...w].filter((x) => target.has(x)).length;
    return shared / Math.max(1, Math.min(w.size, target.size));
  };
  const best = decisions.map((x) => ({ ...x, s: score(x.e.name) })).sort((a, b) => b.s - a.s)[0]!;
  const pick = decisions.length === 1 ? decisions[0]! : best.s >= 0.5 ? best : undefined;
  if (!pick) return ex;
  const entities = ex.entities.map((e, i) => (i !== pick.i ? e : {
    ...e, name: decisionName, aliases: [e.name, ...(e.aliases ?? [])].filter((a) => normName(a) !== normName(decisionName)),
  }));
  return { ...ex, entities };
}

// A node several sources describe becomes one write, so sources never take turns overwriting it on every run:
// - its name and summary come from the first source in list order that has one (the vault's registry names the
//   connectors the ops snapshot only knows by key);
// - its state (props, src, asOf) from the newest source by asOf (on equal dates the earlier one), with the others
//   filling props it lacks.
export function mergeNodes(lists: NodeInput[][]): NodeInput[] {
  const groups = new Map<string, NodeInput[]>();
  for (const n of lists.flat()) groups.set(n.id, [...(groups.get(n.id) ?? []), n]);
  const t = (n: NodeInput) => { const x = n.asOf ? Date.parse(n.asOf) : NaN; return Number.isFinite(x) ? x : -Infinity; };
  return [...groups.values()].map((ns) => {
    if (ns.length === 1) return ns[0]!;
    const ordered = ns.map((n, i) => ({ n, i })).sort((a, b) => t(b.n) - t(a.n) || a.i - b.i).map((x) => x.n);
    const base = ordered[0]!;
    const props = Object.assign({}, ...ordered.slice(1).reverse().map((n) => n.props ?? {}), base.props ?? {});
    const summary = ns.find((n) => n.summary)?.summary;
    return { ...base, name: ns[0]!.name, ...(summary ? { summary } : {}), ...(Object.keys(props).length ? { props } : {}) };
  });
}

// Two documents may report the same number (same metric, subject and date: one observation id) with different values.
// The newer document is the correction; an older one, or one from the same day read later, never overwrites it. Without
// this rule the two would take turns on every run, each turn leaving a Version. Readings weaker than the stored one (a
// document against a connector's measurement) are left to writeObservation, which skips them.
async function keepNewestReadings(g: GraphHandle, obs: ObservationInput[], docId: string): Promise<{ keep: ObservationInput[]; older: number }> {
  if (!obs.length) return { keep: obs, older: 0 };
  const rows = await g.roQuery<{ id: string; src: string | null; srcAsOf: string | null }>(
    "MATCH (o:Observation) WHERE o.id IN $ids OPTIONAL MATCH (d:Document {id: o.src}) RETURN o.id AS id, o.src AS src, d.asOf AS srcAsOf",
    { ids: obs.map(observationId) });
  const stored = new Map(rows.map((r) => [r.id, r]));
  const [me] = await g.roQuery<{ asOf: string | null }>("MATCH (d:Document {id:$id}) RETURN d.asOf AS asOf", { id: docId });
  const mine = me?.asOf ?? "";
  const keep = obs.filter((o) => {
    const s = stored.get(observationId(o));
    if (!s || !s.src || s.src === docId) return true;
    if (!s.srcAsOf) return true; // stored from a connector or an undated source: conf decides (writeObservation)
    return mine > s.srcAsOf;
  });
  return { keep, older: obs.length - keep.length };
}

// ---------- writes that survive a busy or restarting server ----------

// FalkorDB is shared (other processes run tests and agents on it): a busy server refuses queries ("Max pending queries
// exceeded"), a restarting one is unreachable or still loading. Those items are retried; anything else is a real error.
const TRANSIENT_DB_ERROR = /max pending queries|LOADING|socket closed|ECONNREFUSED|ECONNRESET|connection is closed|timed? ?out/i;
export const isTransientDbError = (msg: string): boolean => TRANSIENT_DB_ERROR.test(msg);

type Write = { nodes?: NodeInput[]; edges?: EdgeInput[]; observations?: ObservationInput[] };
const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function writeWithRetry(
  w: Write, writer: (w: Write) => Promise<WriteStats>, sleep: (ms: number) => Promise<void> = sleepMs, attempts = 3,
): Promise<WriteStats> {
  const total = await writer(w);
  for (let i = 1; i < attempts; i++) {
    const retry = total.errors.filter((e) => isTransientDbError(e.error));
    if (!retry.length) break;
    total.errors = total.errors.filter((e) => !isTransientDbError(e.error));
    await sleep(1500 * i);
    const s = await writer({
      nodes: retry.filter((e) => e.kind === "node").map((e) => e.item as NodeInput),
      observations: retry.filter((e) => e.kind === "observation").map((e) => e.item as ObservationInput),
      edges: retry.filter((e) => e.kind === "edge").map((e) => e.item as EdgeInput),
    });
    for (const k of ["nodesCreated", "nodesUpdated", "versions", "edgesCreated", "edgesClosed", "observations", "skippedWeaker"] as const) total[k] += s[k];
    total.errors.push(...s.errors);
  }
  return total;
}

// ---------- graph helpers ----------

type Totals = Omit<WriteStats, "errors"> & { errors: number };
const zero = (): Totals => ({ nodesCreated: 0, nodesUpdated: 0, versions: 0, edgesCreated: 0, edgesClosed: 0, observations: 0, skippedWeaker: 0, errors: 0 });

function itemRef(item: NodeInput | EdgeInput | ObservationInput): string {
  if ("type" in item && "from" in item) return `${item.from} -[${item.type}]-> ${item.to}`;
  if ("id" in item) return item.id;
  return `${item.metric} of ${item.subject}`;
}

async function loadKnown(g: GraphHandle): Promise<Map<string, KnownEntity>> {
  const types = EXTRACTABLE_TYPES.map((t) => `n:${t}`).join(" OR ");
  const out = new Map<string, KnownEntity>();
  for (let after = ""; ;) {
    const rows = await g.roQuery<{ id: string; labels: string[]; name: string | null; aliases: unknown }>(
      `MATCH (n:Entity) WHERE n.id > $after AND (${types}) RETURN n.id AS id, labels(n) AS labels, n.name AS name, n.aliases AS aliases ORDER BY n.id LIMIT $lim`,
      { after, lim: MAX_PAGE });
    for (const r of rows) {
      const type = typeOfLabels(r.labels);
      if (!type || !r.name) continue;
      const aliases = Array.isArray(r.aliases) ? r.aliases.filter((a): a is string => typeof a === "string") : [];
      out.set(r.id, { id: r.id, type, name: r.name, ...(aliases.length ? { aliases } : {}) });
    }
    if (rows.length < MAX_PAGE) return out;
    after = rows[rows.length - 1]!.id;
  }
}

// similar(): the nearest same-type entity in the vector index, as cosine similarity (FalkorDB returns the distance).
function similarFn(g: GraphHandle, embed: EmbedFn) {
  return async (type: EntityType, name: string): Promise<{ id: string; score: number } | null> => {
    if (!isEntityType(type)) return null;
    const [vec] = await embed([entityText({ name, type })]);
    if (!vec) return null;
    const rows = await g.roQuery<{ id: string; d: number }>(
      `CALL db.idx.vector.queryNodes('Entity', '${ENTITY_VECTOR_PROP}', 25, vecf32($v)) YIELD node, score
       WITH node, score WHERE node:${type} RETURN node.id AS id, score AS d ORDER BY d ASC LIMIT 1`, { v: vec });
    return rows[0] ? { id: rows[0].id, score: 1 - rows[0].d } : null;
  };
}

const embedKey = (text: string) => sha256(`${EMBED_MODEL}\n${text}`).slice(0, 16);

// Embeds what has no vector yet or whose text changed (embedKey). `ids` limits it to those nodes; chunks only on request.
async function embedNodes(g: GraphHandle, embed: EmbedFn, opts: { ids?: string[]; chunks?: boolean } = {}): Promise<{ entities: number; chunks: number }> {
  const todo: Array<{ id: string; text: string; key: string }> = [];
  const pick = (rows: Array<{ id: string; labels: string[]; name: string | null; summary: string | null; key: string | null; has: boolean }>) => {
    for (const r of rows) {
      const type = typeOfLabels(r.labels);
      if (!type || !r.name) continue;
      const text = entityText({ name: r.name, type, summary: r.summary ?? undefined });
      const key = embedKey(text);
      if (!r.has || r.key !== key) todo.push({ id: r.id, text, key });
    }
  };
  const fields = `n.id AS id, labels(n) AS labels, n.name AS name, n.summary AS summary, n.embedKey AS key, n.${ENTITY_VECTOR_PROP} IS NOT NULL AS has`;
  if (opts.ids) {
    for (let i = 0; i < opts.ids.length; i += MAX_PAGE) {
      pick(await g.roQuery(`MATCH (n:Entity) WHERE n.id IN $ids AND ${searchableTypesPredicate("n")} RETURN ${fields}`, { ids: opts.ids.slice(i, i + MAX_PAGE) }));
    }
  } else {
    for (let after = ""; ;) {
      const rows = await g.roQuery<{ id: string; labels: string[]; name: string | null; summary: string | null; key: string | null; has: boolean }>(
        `MATCH (n:Entity) WHERE n.id > $after AND ${searchableTypesPredicate("n")} RETURN ${fields} ORDER BY n.id LIMIT $lim`, { after, lim: MAX_PAGE });
      pick(rows);
      if (rows.length < MAX_PAGE) break;
      after = rows[rows.length - 1]!.id;
    }
  }
  const chunks: typeof todo = [];
  if (opts.chunks) {
    for (let after = ""; ;) {
      const rows = await g.roQuery<{ id: string; text: string | null; key: string | null; has: boolean }>(
        `MATCH (c:Chunk) WHERE c.id > $after RETURN c.id AS id, c.text AS text, c.embedKey AS key, c.${CHUNK_VECTOR_PROP} IS NOT NULL AS has ORDER BY c.id LIMIT $lim`,
        { after, lim: MAX_PAGE });
      for (const r of rows) {
        if (!r.text) continue;
        const key = embedKey(r.text);
        if (!r.has || r.key !== key) chunks.push({ id: r.id, text: r.text, key });
      }
      if (rows.length < MAX_PAGE) break;
      after = rows[rows.length - 1]!.id;
    }
  }
  for (const [list, prop] of [[todo, ENTITY_VECTOR_PROP], [chunks, CHUNK_VECTOR_PROP]] as const) {
    for (let i = 0; i < list.length; i += EMBED_WRITE_BATCH) {
      const batch = list.slice(i, i + EMBED_WRITE_BATCH);
      const vecs = await embed(batch.map((b) => b.text));
      await g.query(`UNWIND $rows AS r MATCH (n:Entity {id: r.id}) SET n.${prop} = vecf32(r.vec), n.embedKey = r.key`,
        { rows: batch.map((b, j) => ({ id: b.id, key: b.key, vec: vecs[j]! })) });
    }
  }
  if (todo.length || chunks.length) await noteGraphWrite(g.name);
  return { entities: todo.length, chunks: chunks.length };
}

// Vault structure a document no longer has (a chunk past its new end, a link it dropped) is closed, never deleted.
async function retireStructure(g: GraphHandle, docIds: string[], asserted: Set<string>, now: number): Promise<number> {
  let closed = 0;
  for (let i = 0; i < docIds.length; i += MAX_PAGE) {
    const rows = await g.roQuery<{ from: string; type: "HAS_CHUNK" | "LINKS_TO"; to: string }>(
      "MATCH (d:Document)-[r:HAS_CHUNK|LINKS_TO]->(x:Entity) WHERE d.id IN $ids AND r.until IS NULL RETURN d.id AS from, type(r) AS type, x.id AS to",
      { ids: docIds.slice(i, i + MAX_PAGE) });
    for (const r of rows) {
      if (!asserted.has(`${r.from}|${r.type}|${r.to}`)) closed += await closeEdge(g, r.from, r.type, r.to, now, "no longer in the document");
    }
  }
  return closed;
}

async function graphCounts(g: GraphHandle): Promise<PipelineReport["graph"]> {
  const nodes: Record<string, number> = {};
  for (const r of await g.roQuery<{ l: string[]; c: number }>("MATCH (n) RETURN labels(n) AS l, count(n) AS c")) {
    const t = typeOfLabels(r.l) ?? r.l.join(":");
    nodes[t] = (nodes[t] ?? 0) + r.c;
  }
  const edges: Record<string, number> = {};
  for (const r of await g.roQuery<{ t: string; c: number }>("MATCH ()-[r]->() WHERE r.until IS NULL RETURN type(r) AS t, count(r) AS c")) edges[r.t] = r.c;
  const sort = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]));
  return { nodes: sort(nodes), edges: sort(edges) };
}

function latestSnapshot(root: string): string | undefined {
  if (!existsSync(root)) return undefined;
  const dates = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name)).map((d) => d.name).sort();
  return dates.length ? join(root, dates[dates.length - 1]!) : undefined;
}

// ---------- the run ----------

export async function runIngest(tenant: string | TenantConfig, opts: IngestOptions = {}): Promise<IngestRun> {
  const t0 = Date.now();
  const tc = typeof tenant === "string" ? tenantConfig(tenant) : tenant;
  const cfg = loadConfig();
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const log = opts.log ?? (() => {});
  const want = new Set<SourceName>(opts.sources ?? tc.sources);
  const model = opts.model ?? cfg.extractModel;
  const dataDir = opts.dataDir ?? cfg.dataDir;
  const embed = opts.embed ?? embedPassages;
  const limit = Math.max(0, Math.floor(opts.limitDocs ?? DEFAULT_EXTRACT_LIMIT));
  const startedAt = now.toISOString();
  const skipped: PipelineReport["skipped"] = [];
  const redactions: Record<string, number> = {};
  const addRedactions = (c: Record<string, number>) => { for (const [k, n] of Object.entries(c)) redactions[k] = (redactions[k] ?? 0) + n; };
  const sourceRows: PipelineReport["sources"] = [];
  const results: SourceResult[] = [];
  const took = (r: SourceResult, ms: number) => {
    results.push(r);
    sourceRows.push({ source: r.source, docs: r.docs.length, nodes: r.write.nodes.length, edges: r.write.edges.length, observations: r.write.observations.length, skipped: r.skipped.length, ms });
    skipped.push(...r.skipped.map((s) => ({ source: r.source, ...s })));
    addRedactions(r.redactions);
    log(`[${r.source}] ${r.write.nodes.length} nodes, ${r.write.edges.length} edges, ${r.write.observations.length} observations, ${r.docs.length} docs, ${r.skipped.length} skipped (${ms} ms)`);
  };

  // ---- 2. sources ----
  let vaultHead: string | undefined;
  let brainDocs: string[] = [];
  const brainStructure = new Set<string>();
  if (want.has("brain")) {
    const t = Date.now();
    const brain = await loadBrain({ vaultPath: opts.brainPath ?? tc.brainPath ?? cfg.brainPath });
    vaultHead = brain.vaultHead;
    brainDocs = brain.write.nodes.filter((n) => n.type === "Document" && n.props?.kind !== "registry").map((n) => n.id);
    for (const e of brain.write.edges) if (e.type === "HAS_CHUNK" || e.type === "LINKS_TO") brainStructure.add(`${e.from}|${e.type}|${e.to}`);
    took(brain, Date.now() - t);
  }
  if (want.has("ops")) {
    const t = Date.now();
    const dir = opts.opsSnapshotDir ?? latestSnapshot(join(dataDir, "snapshots", tc.slug));
    if (!dir) skipped.push({ source: "ops", ref: join("snapshots", tc.slug), reason: "no snapshot directory (run the ops snapshot first)" });
    else {
      const date = basename(dir);
      took(mapSnapshot(dir, { tenantSlug: tc.slug, asOf: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : istDate(nowMs) }), Date.now() - t);
    }
  }
  if (want.has("playbooks")) {
    const t = Date.now();
    took(loadPlaybooks({ tenantSlug: tc.slug, industry: tc.industry }), Date.now() - t);
  }
  if (want.has("simads")) {
    if (!tc.ads) skipped.push({ source: "simads", ref: tc.slug, reason: "no ads profile in the tenant config" });
    else {
      const t = Date.now();
      took(simulateAds({ tenantSlug: tc.slug, seed: tc.ads.seed, days: tc.ads.days, endDate: istDate(nowMs), profile: tc.ads.profile }), Date.now() - t);
    }
  }
  const issues: Array<{ repo: string; issues: GhIssue[]; ms: number }> = [];
  if (want.has("github")) {
    for (const repo of tc.github?.repos ?? []) {
      const t = Date.now();
      try {
        issues.push({ repo, issues: await fetchIssues(repo, opts.gh), ms: Date.now() - t });
      } catch (e) {
        skipped.push({ source: "github", ref: repo, reason: `issues not read: ${(e as Error).message.slice(0, 200)}` });
      }
    }
    if (!tc.github?.repos.length) skipped.push({ source: "github", ref: tc.slug, reason: "no repos in the tenant config" });
  }

  const candidates = extractionOrder(results.flatMap((r) => r.docs));
  const chosen = candidates.slice(0, limit);
  const report: PipelineReport = {
    tenant: tc.slug, startedAt, finishedAt: startedAt, dryRun: !!opts.dryRun, model, durationMs: 0,
    sources: sourceRows, stats: { nodesCreated: 0, nodesUpdated: 0, versions: 0, edgesCreated: 0, edgesClosed: 0, observations: 0, errors: 0 },
    extraction: {
      docs: 0, cached: 0, entities: 0, relations: 0, observations: 0, olderReadings: 0, settlePasses: 0, dropped: 0, candidates: candidates.length,
      skipped: candidates.length - chosen.length, failed: 0, order: chosen.map((d) => d.id),
      skippedDocs: candidates.slice(limit).map((d) => ({ id: d.id, reason: `over the extraction limit (${limit})` })), failures: [],
    },
    embeddings: { entities: 0, chunks: 0 }, retired: { structure: 0, mentions: 0 }, graph: { nodes: {}, edges: {} },
    redactions, privacyScanHits: 0, privacyScan: { hits: 0, byKind: {}, sample: [] }, skipped: [], writeErrors: [],
    ...(vaultHead ? { vaultHead } : {}),
  };
  const finish = (): PipelineReport => {
    report.finishedAt = new Date(nowMs + (Date.now() - t0)).toISOString();
    report.durationMs = Date.now() - t0;
    report.skipped = skipped.slice(0, MAX_LISTED * 5);
    return report;
  };
  if (opts.dryRun) {
    log(`[dry-run] ${candidates.length} documents qualify for extraction; ${chosen.length} would be extracted. Nothing written.`);
    return { report: finish(), reportPath: "" };
  }

  // ---- 1. tenant and graph ----
  await ensureTenant({ slug: tc.slug, name: tc.name, domain: tc.domain, industry: tc.industry, city: tc.city }, { metaGraph: opts.metaGraph });
  const g = await openGraph(tc.slug);
  await ensureIndexes(g);
  const totals = zero();
  const put = (w: Write) => writeWithRetry(w, (x) => writeBatch(g, x, nowMs));
  const tally = (s: WriteStats) => {
    for (const k of ["nodesCreated", "nodesUpdated", "versions", "edgesCreated", "edgesClosed", "observations", "skippedWeaker"] as const) totals[k] += s[k];
    totals.errors += s.errors.length;
    for (const e of s.errors) if (report.writeErrors.length < MAX_LISTED) report.writeErrors.push({ kind: e.kind, ref: itemRef(e.item), error: e.error.slice(0, 300) });
  };

  // ---- 3. deterministic writes ----
  {
    const t = Date.now();
    const s = await put({
      nodes: mergeNodes(results.map((r) => r.write.nodes)),
      observations: results.flatMap((r) => r.write.observations),
      edges: results.flatMap((r) => r.write.edges),
    });
    tally(s);
    report.retired.structure = await retireStructure(g, brainDocs, brainStructure, nowMs);
    totals.edgesClosed += report.retired.structure;
    log(`[write] deterministic: +${s.nodesCreated} nodes (${s.nodesUpdated} updated), +${s.edgesCreated} edges, ${s.observations} observations, ${s.errors.length} errors (${Date.now() - t} ms)`);
  }

  // ---- 4. embeddings for resolution ----
  {
    const t = Date.now();
    const e = await embedNodes(g, embed);
    report.embeddings.entities += e.entities;
    log(`[embed] ${e.entities} entities (${Date.now() - t} ms)`);
  }

  // ---- 5. extraction ----
  if (chosen.length) {
    const t = Date.now();
    let known = await loadKnown(g);
    const similar = similarFn(g, embed);
    const runner = opts.runner ?? new AgentSdkRunner({ concurrency: EXTRACT_CONCURRENCY, log });
    const sem = new Semaphore(EXTRACT_CONCURRENCY);
    const cacheDir = join(dataDir, "cache", "extract");
    const business = { name: tc.name, industry: tc.description ?? tc.industry };
    let fatal: Error | undefined;
    const jobs = chosen.map((d) => sem.run(async () => {
      if (fatal) throw new Error("not attempted after a fatal model error");
      try {
        return await extractDoc(d, business, { runner, model, cacheDir });
      } catch (e) {
        if (e instanceof FatalLlmError) fatal ??= e;
        throw e;
      }
    }).then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e })));

    // Resolve one document's extraction against `known`, write it, and (retire) close the MENTIONS the document no
    // longer makes. Returns how much the graph changed.
    const apply = async (d: RawDoc, ex: Extraction, retire: boolean) => {
      const resolved = await resolveExtraction(ex, { docId: d.id, text: d.text, asOf: d.asOf, existing: known, similar, founderNames: tc.founderNames });
      const readings = await keepNewestReadings(g, resolved.write.observations, d.id);
      const write = { ...resolved.write, observations: readings.keep };
      const s = await put(write);
      tally(s);
      rememberWrite(known, write);
      let closed = 0;
      if (retire) {
        const keep = new Set(write.edges.filter((e) => e.type === "MENTIONS" && e.from === d.id).map((e) => e.to));
        const current = await g.roQuery<{ to: string }>("MATCH (:Document {id:$id})-[r:MENTIONS]->(x:Entity) WHERE r.until IS NULL RETURN x.id AS to", { id: d.id });
        for (const r of current) if (!keep.has(r.to)) closed += await closeEdge(g, d.id, "MENTIONS", r.to, nowMs, "no longer in the document");
        report.retired.mentions += closed;
        totals.edgesClosed += closed;
      }
      const e = await embedNodes(g, embed, { ids: write.nodes.map((n) => n.id) });
      report.embeddings.entities += e.entities;
      return { s, dropped: resolved.dropped.length, older: readings.older, changes: s.nodesCreated + s.nodesUpdated + s.versions + s.edgesCreated + s.edgesClosed + closed };
    };

    const done: Array<{ d: RawDoc; ex: Extraction }> = [];
    let changes = 0;
    for (const [i, d] of chosen.entries()) {
      const res = await jobs[i]!;
      if (fatal) break;
      if (!res.ok) {
        report.extraction.failed++;
        report.extraction.failures.push({ id: d.id, error: (res.e instanceof Error ? res.e.message : String(res.e)).slice(0, 300) });
        log(`[extract] ${i + 1}/${chosen.length} ${d.path ?? d.id}: FAILED`);
        continue;
      }
      const { extraction, cached } = res.v;
      const ex = typeof d.meta?.decisionName === "string" ? alignAdrDecision(extraction, d.meta.decisionName) : extraction;
      const r = await apply(d, ex, !cached); // a changed document no longer mentions what its old text did
      done.push({ d, ex });
      changes += r.changes;
      report.extraction.docs++;
      if (cached) report.extraction.cached++;
      report.extraction.entities += ex.entities.length;
      report.extraction.relations += ex.relations.length;
      report.extraction.observations += ex.observations.length;
      report.extraction.dropped += r.dropped;
      report.extraction.olderReadings += r.older;
      log(`[extract] ${i + 1}/${chosen.length} ${d.kind} ${d.path ?? d.id}${cached ? " (cached)" : ""}: ${ex.entities.length} entities, ${ex.relations.length} relations, ${ex.observations.length} numbers, ${r.dropped} dropped; +${r.s.nodesCreated} nodes +${r.s.edgesCreated} edges`);
    }
    if (fatal) {
      await Promise.allSettled(jobs);
      throw new Error(`extraction stopped: ${fatal.message}`);
    }

    // Settle. A document read early resolved its names against a graph that later documents then grew (a node that
    // did not exist yet, a name two entities now share). Re-resolving every document against the whole graph, read
    // afresh in id order exactly as the next run will read it, until a pass changes nothing, means the next run with
    // the same sources changes nothing either. Cached extractions only: no model calls.
    for (let pass = 1; changes > 0 && pass <= MAX_SETTLE_PASSES; pass++) {
      known = await loadKnown(g);
      changes = 0;
      for (const { d, ex } of done) changes += (await apply(d, ex, true)).changes;
      report.extraction.settlePasses = pass;
      log(`[extract] settle pass ${pass}: ${changes} change(s)`);
    }
    log(`[extract] ${report.extraction.docs} documents (${report.extraction.cached} cached, ${report.extraction.failed} failed) in ${Date.now() - t} ms`);
  }

  // ---- 6. GitHub ----
  if (issues.length) {
    const known = [...(await loadKnown(g)).values()];
    for (const { repo, issues: list, ms } of issues) {
      const r = mapIssues(list, { repo, founderLogins: tc.github?.founderLogins ?? [], known, businessId: businessId(tc.slug) });
      took(r, ms);
      const s = await put(r.write);
      tally(s);
    }
  }

  // ---- 7. embeddings, librarian ----
  {
    const t = Date.now();
    const e = await embedNodes(g, embed, { chunks: true });
    report.embeddings.entities += e.entities;
    report.embeddings.chunks += e.chunks;
    log(`[embed] ${e.entities} entities, ${e.chunks} chunks (${Date.now() - t} ms)`);
  }
  report.librarian = await runLibrarian(g, { now: nowMs, log });
  totals.edgesCreated += report.librarian.knowsAbout.created;
  totals.edgesClosed += report.librarian.knowsAbout.closed;
  totals.errors += report.librarian.knowsAbout.errors;

  report.stats = { nodesCreated: totals.nodesCreated, nodesUpdated: totals.nodesUpdated, versions: totals.versions, edgesCreated: totals.edgesCreated, edgesClosed: totals.edgesClosed, observations: totals.observations, errors: totals.errors };
  report.graph = await graphCounts(g);

  // ---- 8. privacy scan ----
  const hits = await scanGraph(g);
  report.privacyScanHits = hits.length;
  for (const h of hits) report.privacyScan.byKind[h.kind] = (report.privacyScan.byKind[h.kind] ?? 0) + 1;
  report.privacyScan.hits = hits.length;
  report.privacyScan.sample = hits.slice(0, 50);

  // ---- 9. report and Event ----
  finish();
  const dir = join(dataDir, "runs", tc.slug);
  mkdirSync(dir, { recursive: true });
  const reportPath = join(dir, `${startedAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 1));
  if (hits.length) {
    const where = hits.slice(0, 5).map((h) => `${h.id} .${h.prop} (${h.kind})`).join("; "); // ids and prop names only, never values
    throw new Error(`privacy scan found ${hits.length} hit(s) in the graph (${Object.entries(report.privacyScan.byKind).map(([k, n]) => `${k} ${n}`).join(", ")}): ${where}; report: ${reportPath}`);
  }
  await upsertNode(g, {
    type: "Event", id: entityId("Event", `ingest ${tc.slug} ${startedAt}`), name: `Ingest run ${startedAt}`,
    summary: `Ingested ${[...want].join(", ")}: +${report.stats.nodesCreated} nodes, +${report.stats.edgesCreated} edges, ${report.extraction.docs} documents extracted.`,
    props: {
      kind: "ingest", at: startedAt, finishedAt: report.finishedAt, sources: [...want], nodesCreated: report.stats.nodesCreated,
      edgesCreated: report.stats.edgesCreated, edgesClosed: report.stats.edgesClosed, docsExtracted: report.extraction.docs,
      privacyScanHits: 0, ...(vaultHead ? { vaultHead: vaultHead.slice(0, 12) } : {}),
    },
    asOf: istDate(nowMs),
  }, nowMs);
  log(`[report] ${reportPath}`);
  return { report, reportPath };
}
