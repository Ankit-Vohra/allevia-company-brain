// What the API reads from a tenant graph, shaped into the web app's JSON (types.ts). Every query here is a
// GRAPH.RO_QUERY with a timeout and a LIMIT; embeddings and bookkeeping props never leave this file.
import { z } from "zod";
import type { AgentEvent, EdgeRef, NodeRef, SourceRef, TurnChecks } from "../../shared/contracts.js";
import { AGENTS, agentById } from "../../shared/roster.js";
import type { GraphHandle } from "../graph/client.js";
import { SEARCHABLE } from "../graph/schema.js";
import { STOPPED_MESSAGE } from "../agent/ask.js";
import { agentNodeId } from "../agent/memory.js";
import { TouchedSet, type ToolContext } from "../agent/tool.js";
import { search } from "../agent/tools/search.js";
import { NODE, toRef, type NodeRow } from "../agent/tools/common.js";
import { localCommunities, localPageRank } from "./local-graph.js";
import {
  APPROVAL_STATUSES, REC_AREAS, type AgentDetailDto, type AgentStatsDto, type AgentSummaryDto, type ApprovalDto, type ApprovalPayload,
  type ApprovalStatus, type BriefDto, type Channel, type FindingRecordDto, type FreshnessDto, type GraphDataDto, type GraphNodeDto,
  type NodeDetailDto, type RecArea, type RecommendationDto, type SearchHitDto, type SessionDetailDto, type SessionSummaryDto,
  type TurnRecordDto, type VersionRecordDto,
} from "./types.js";

export const READ_MS = 10_000;
export const LIMITS = {
  sessions: 50, turns: 100, search: 25, neighbors: 40, versions: 20, sources: 10, focusNodes: 150, overviewNodes: 400,
  overviewEdges: 3000, recommendations: 50, approvals: 100, findings: 6, knows: 25, knowledgeEdges: 200, playbooks: 6,
} as const;

// Props never returned: vectors, write bookkeeping, and a Turn's raw event log (served by the replay endpoint).
const HIDDEN = ["embedding", "textEmbedding", "rev", "_mergeToken", "closedCost", "asOfMs", "retiredAsOfMs", "events"];
// Node types left out of maps and neighbour lists: plumbing, not business facts.
const PLUMBING = ["Version", "Chunk"];
// Relationships a map leaves out: version history, and a Turn's links to everything it read.
const MAP_SKIP_RELS = ["HAD_VERSION", "TOUCHED", "CITED", "HAS_CHUNK"];

const ro = <T>(g: GraphHandle, cypher: string, params?: Record<string, unknown>) => g.roQuery<T>(cypher, params, { timeoutMs: READ_MS });

const iso = (v: unknown): string | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v).toISOString();
  if (typeof v === "string" && v) return Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : v;
  return undefined;
};
const str = (v: unknown, dflt = ""): string => (typeof v === "string" ? v : v === null || v === undefined ? dflt : String(v));
const numOr = (v: unknown, dflt: number): number => (typeof v === "number" && Number.isFinite(v) ? v : dflt);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const parseJson = (v: unknown): unknown => {
  if (typeof v !== "string") return v ?? null;
  try { return JSON.parse(v); } catch { return null; }
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const rosterIdOf = (agentNode: unknown): string | undefined => {
  const s = str(agentNode);
  return s.startsWith("agent:allevia-") && agentById(s.slice("agent:allevia-".length)) ? s.slice("agent:allevia-".length) : undefined;
};

// ---------- tenant ----------

export interface BusinessProps { name?: string; domain?: string; industry?: string; city?: string; country?: string; currency?: string; locale?: string; timeZone?: string }

export async function businessProps(g: GraphHandle, businessId: string): Promise<BusinessProps> {
  const rows = await ro<Record<string, unknown>>(g,
    `MATCH (b:Entity:Business {id:$id}) RETURN b.name AS name, b.domain AS domain, b.industry AS industry, b.city AS city, b.country AS country,
       b.currency AS currency, b.locale AS locale, b.timeZone AS timeZone LIMIT 1`, { id: businessId });
  const r = rows[0] ?? {};
  return Object.fromEntries(Object.entries(r).filter(([, v]) => typeof v === "string" && v)) as BusinessProps;
}

// ---------- overview ----------

export async function labelCounts(g: GraphHandle): Promise<Record<string, number>> {
  const rows = await ro<{ label: string | null; c: number }>(g,
    "MATCH (n:Entity) WITH [l IN labels(n) WHERE NOT l IN ['Entity', 'Searchable']][0] AS label RETURN label, count(*) AS c ORDER BY c DESC, label LIMIT 100");
  return Object.fromEntries(rows.filter((r) => r.label).map((r) => [r.label!, r.c]));
}

const SOURCE_NAMES: Record<string, string> = {
  vault: "Vault notes", note: "Vault notes", decision: "Decisions", report: "Reports", snapshot: "Ops snapshots", pending: "Pending list",
  registry: "Registry", readme: "Readmes", agent: "Agent notes", playbook: "Playbooks", simulated: "Simulated ads", brief: "Today's note",
  web: "Website crawl", web_page: "Website crawl", page: "Website crawl", website: "Website crawl", github_issue: "GitHub issues",
  issue: "GitHub issues", instagram: "Instagram", search_console: "Search Console", ga4: "GA4",
};
const STALE_DAYS = 7;

export async function freshness(g: GraphHandle, now: number): Promise<FreshnessDto[]> {
  const rows = await ro<{ kind: string; asOf: string | null }>(g,
    "MATCH (d:Document) WHERE d.asOf IS NOT NULL RETURN coalesce(d.kind, 'other') AS kind, max(d.asOf) AS asOf ORDER BY asOf DESC, kind LIMIT 30");
  const merged = new Map<string, FreshnessDto>();
  for (const r of rows) {
    if (!r.asOf) continue;
    const source = SOURCE_NAMES[r.kind] ?? r.kind.replace(/[_-]+/g, " ").replace(/^\p{L}/u, (c) => c.toUpperCase());
    const at = Date.parse(r.asOf);
    const status: FreshnessDto["status"] = Number.isFinite(at) && now - at > STALE_DAYS * 86_400_000 ? "stale" : "ok";
    const item: FreshnessDto = { source, asOf: r.asOf.slice(0, 10), status, ...(r.kind === "simulated" ? { note: "simulated" } : {}) };
    const have = merged.get(source);
    if (!have || item.asOf > have.asOf) merged.set(source, item);
  }
  return [...merged.values()];
}

export async function pendingApprovals(g: GraphHandle): Promise<number> {
  const [r] = await ro<{ c: number }>(g, "MATCH (a:Approval) WHERE coalesce(a.status, 'pending') = 'pending' RETURN count(a) AS c");
  return r?.c ?? 0;
}

export async function latestBrief(g: GraphHandle): Promise<BriefDto | null> {
  const rows = await ro<Record<string, unknown>>(g,
    `MATCH (d:Document) WHERE d.kind = 'brief'
     RETURN d.id AS id, coalesce(d.title, d.name) AS title, d.asOf AS asOf, coalesce(d.text, d.body, d.summary, '') AS text
     ORDER BY coalesce(d.asOf, '') DESC, coalesce(d.createdAt, 0) DESC, d.id LIMIT 1`);
  const r = rows[0];
  if (!r) return null;
  return { id: str(r.id), title: str(r.title, "Today's note"), ...(typeof r.asOf === "string" ? { asOf: r.asOf } : {}), text: str(r.text) };
}

// ---------- sessions and turns ----------

const CHANNELS: Channel[] = ["web", "discord", "cli"];
const toChannel = (v: unknown): Channel => (CHANNELS.includes(v as Channel) ? (v as Channel) : "cli");

export const DEFAULT_CHECKS: TurnChecks = {
  citationsValid: true, invalidCitations: [], numbersGrounded: true, ungroundedNumbers: [], simulatedDisclosed: true, freshnessDisclosed: true,
};

// `showcaseOnly`: public mode shows only the turns marked Turn.showcase = true, and the threads that hold one.
export async function sessions(g: GraphHandle, o: { showcaseOnly: boolean; limit?: number }): Promise<SessionSummaryDto[]> {
  const rows = await ro<{ id: string; name: string | null; channel: string | null; agent: string | null; startedAt: number | null; n: number; last: number | null }>(g,
    `MATCH (s:Session)
     OPTIONAL MATCH (t:Turn)-[r:IN_SESSION]->(s) WHERE r.until IS NULL ${o.showcaseOnly ? "AND t.showcase = true" : ""}
     WITH s, count(t) AS n, max(t.at) AS last
     ${o.showcaseOnly ? "WHERE n > 0" : ""}
     RETURN s.id AS id, s.name AS name, s.channel AS channel, s.agent AS agent, coalesce(s.startedAt, s.createdAt) AS startedAt, n, last
     ORDER BY coalesce(last, s.startedAt, s.createdAt, 0) DESC, s.id LIMIT $limit`,
    { limit: Math.min(o.limit ?? LIMITS.sessions, LIMITS.sessions) });
  return rows.map((r) => ({
    id: r.id, title: r.name || "Thread", channel: toChannel(r.channel), turns: r.n, ...(r.agent && agentById(r.agent) ? { agent: r.agent } : {}),
    startedAt: iso(r.startedAt) ?? iso(r.last) ?? new Date(0).toISOString(), lastAt: iso(r.last) ?? iso(r.startedAt) ?? new Date(0).toISOString(),
  }));
}

export async function sessionDetail(g: GraphHandle, id: string, o: { showcaseOnly: boolean }): Promise<SessionDetailDto | null> {
  const [s] = await ro<{ name: string | null; agent: string | null }>(g, "MATCH (s:Entity:Session {id:$id}) RETURN s.name AS name, s.agent AS agent LIMIT 1", { id });
  if (!s) return null;
  const rows = await ro<Record<string, unknown>>(g,
    `MATCH (s:Entity:Session {id:$id}) WITH s
     MATCH (t:Turn)-[r:IN_SESSION]->(s) WHERE r.until IS NULL ${o.showcaseOnly ? "AND t.showcase = true" : ""}
     RETURN t.id AS id, t.question AS question, t.answer AS answer, t.at AS at, t.ms AS ms, t.agents AS agents, t.skills AS skills, t.citations AS citations,
       t.checks AS checks, t.status AS status, t.error AS error, t.source AS source, t.target AS target ORDER BY t.at, t.id LIMIT $limit`, { id, limit: LIMITS.turns });
  if (o.showcaseOnly && !rows.length) return null;
  return { id, title: s.name || "Thread", ...(s.agent && agentById(s.agent) ? { agent: s.agent } : {}), turns: rows.map(turnRecord) };
}

function turnRecord(r: Record<string, unknown>): TurnRecordDto {
  const checks = parseJson(r.checks);
  const error = typeof r.error === "string" && r.error ? r.error : undefined;
  return {
    id: str(r.id), question: str(r.question), answer: str(r.answer), at: iso(r.at) ?? new Date(0).toISOString(), ms: numOr(r.ms, 0),
    ...(r.source === "web" || r.source === "discord" || r.source === "cli" ? { source: r.source } : {}),
    ...(typeof r.target === "string" && agentById(r.target) ? { target: r.target } : {}),
    agents: strList(r.agents), ...(strList(r.skills).length ? { skills: strList(r.skills) } : {}), citations: strList(r.citations), checks: { ...DEFAULT_CHECKS, ...(isObj(checks) ? (checks as Partial<TurnChecks>) : {}) },
    ...(r.status === "failed" ? { ended: error === STOPPED_MESSAGE ? "stopped" as const : "failed" as const, ...(error ? { error } : {}) } : {}),
  };
}

export async function turnEvents(g: GraphHandle, turnId: string, o: { showcaseOnly: boolean }): Promise<AgentEvent[] | null> {
  const rows = await ro<{ e: string | null; showcase: boolean | null }>(g,
    "MATCH (t:Entity:Turn {id:$id}) RETURN t.events AS e, t.showcase AS showcase LIMIT 1", { id: turnId });
  const r = rows[0];
  if (!r || (o.showcaseOnly && r.showcase !== true)) return null;
  const events = parseJson(r.e);
  return Array.isArray(events) ? (events as AgentEvent[]) : null;
}

// A stored Turn for GET /turns/:id/events when it is no longer live on this server: where it ran, how it ended and
// its saved (compacted) event log.
export interface StoredTurn { id: string; sessionId: string; question: string; status: "ok" | "failed"; error: string | null; events: AgentEvent[] }

export async function storedTurn(g: GraphHandle, turnId: string, o: { showcaseOnly: boolean }): Promise<StoredTurn | null> {
  const rows = await ro<{ q: string | null; sid: string | null; status: string | null; error: string | null; e: string | null; showcase: boolean | null }>(g,
    `MATCH (t:Entity:Turn {id:$id}) RETURN t.question AS q, t.sessionId AS sid, t.status AS status, t.error AS error, t.events AS e,
       t.showcase AS showcase LIMIT 1`, { id: turnId });
  const r = rows[0];
  if (!r || (o.showcaseOnly && r.showcase !== true)) return null;
  const events = parseJson(r.e);
  return {
    id: turnId, sessionId: str(r.sid), question: str(r.q), status: r.status === "failed" ? "failed" : "ok", error: r.error ?? null,
    events: Array.isArray(events) ? (events as AgentEvent[]) : [],
  };
}

// Public mode: the stored showcase turn whose question matches (case and spacing ignored), or the one named by id.
export async function findShowcaseTurn(g: GraphHandle, o: { question?: string; turnId?: string }): Promise<{ id: string; events: AgentEvent[] } | null> {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const rows = await ro<{ id: string; q: string | null }>(g,
    "MATCH (t:Turn) WHERE t.showcase = true RETURN t.id AS id, t.question AS q ORDER BY t.at DESC, t.id LIMIT 200");
  const hit = rows.find((r) => (o.turnId && r.id === o.turnId) || (o.question && r.q && norm(r.q) === norm(o.question)));
  if (!hit) return null;
  const events = await turnEvents(g, hit.id, { showcaseOnly: true });
  return events ? { id: hit.id, events } : null;
}

// ---------- search ----------

export async function searchGraph(
  g: GraphHandle, tenant: string, q: string, embedQuery?: ToolContext["embedQuery"], now: number = Date.now(),
): Promise<SearchHitDto[]> {
  const ctx: ToolContext = {
    graph: g, tenant, turnId: "api-search", agentId: "chief-of-staff", asker: "person:founder", touched: new TouchedSet(), now, readOnly: true,
    ...(embedQuery ? { embedQuery } : {}),
  };
  const r = await search.run(z.object(search.input).parse({ query: q, limit: LIMITS.search }), ctx);
  const hits = (r.data as { hits?: Array<{ id: string; type: string; name: string; summary?: string; snippet?: string; score: number }> } | null)?.hits ?? [];
  const refs = new Map(r.nodes.map((n) => [n.id, n]));
  return hits.map((h) => ({
    node: refs.get(h.id) ?? { id: h.id, label: h.type, name: h.name },
    score: h.score,
    ...(h.snippet || h.summary ? { snippet: h.snippet ?? h.summary } : {}),
  }));
}

// ---------- one node ----------

interface NbRow { type: string; since: number | null; n: NodeRow }

export async function nodeDetail(g: GraphHandle, id: string): Promise<NodeDetailDto | null> {
  const [row] = await ro<{ labels: string[]; kv: Array<[string, unknown]> }>(g,
    "MATCH (n:Entity {id:$id}) RETURN labels(n) AS labels, [k IN keys(n) WHERE NOT k IN $skip | [k, n[k]]] AS kv LIMIT 1", { id, skip: HIDDEN });
  if (!row) return null;
  const props = Object.fromEntries(row.kv);
  const ref = toRef({ id, labels: row.labels, name: str(props.name) || null, asOf: (props.asOf as string) ?? null, simulated: (props.simulated as boolean) ?? null });
  const node: GraphNodeDto = { ...ref, ...(typeof props.summary === "string" ? { summary: props.summary } : {}),
    ...(typeof props.rank === "number" ? { rank: props.rank } : {}), ...(typeof props.community === "number" ? { community: props.community } : {}) };

  const nbQuery = (dir: "out" | "in") => ro<NbRow>(g,
    `MATCH (n:Entity {id:$id}) WITH n
     MATCH (n)${dir === "out" ? "-[r]->" : "<-[r]-"}(m:Entity)
     WHERE r.until IS NULL AND NOT type(r) IN $skipRels AND NOT any(l IN labels(m) WHERE l IN $plumbing)
     RETURN type(r) AS type, r.since AS since, ${NODE("m")} AS n
     ORDER BY CASE WHEN m:Observation OR m:Turn OR m:Finding THEN 1 ELSE 0 END, type, m.id LIMIT $limit`,
    { id, skipRels: ["HAD_VERSION"], plumbing: PLUMBING, limit: LIMITS.neighbors });
  const [outs, ins, versions, sources] = await Promise.all([nbQuery("out"), nbQuery("in"), versionsOf(g, id), sourcesOf(g, id, props.src)]);
  const neighbors: NodeDetailDto["neighbors"] = [
    ...outs.map((r) => ({ edge: edgeRef(id, r.type, r.n.id, r.since), node: toRef(r.n), direction: "out" as const })),
    ...ins.map((r) => ({ edge: edgeRef(r.n.id, r.type, id, r.since), node: toRef(r.n), direction: "in" as const })),
  ];
  return { node, props, neighbors, versions, sources };
}

const edgeRef = (from: string, type: string, to: string, since?: number | null): EdgeRef =>
  ({ from, type, to, ...(typeof since === "number" ? { since } : {}), until: null });

async function versionsOf(g: GraphHandle, id: string): Promise<VersionRecordDto[]> {
  const rows = await ro<{ since: number | null; until: number | null; props: string | null; src: string | null; changed: string[] | null }>(g,
    `MATCH (:Entity {id:$id})-[:HAD_VERSION]->(v:Version)
     RETURN v.since AS since, v.until AS until, v.props AS props, v.src AS src, v.changed AS changed ORDER BY v.since DESC, v.id LIMIT $limit`,
    { id, limit: LIMITS.versions });
  return rows.map((r) => {
    const all = parseJson(r.props);
    const snapshot = isObj(all) ? all : {};
    const keep = r.changed?.length ? [...r.changed, "name"] : Object.keys(snapshot).filter((k) => !HIDDEN.includes(k));
    const props = Object.fromEntries(keep.filter((k) => k in snapshot).map((k) => [k, snapshot[k]]));
    return { since: iso(r.since) ?? new Date(0).toISOString(), until: iso(r.until) ?? null, props, ...(r.src ? { src: r.src } : {}) };
  });
}

type DocRow = { id: string; title: string | null; asOf: string | null };

// The node's own source (`src`) first, then the Documents it is SOURCED_FROM.
async function sourcesOf(g: GraphHandle, id: string, src: unknown): Promise<SourceRef[]> {
  const cols = "d.id AS id, coalesce(d.title, d.name) AS title, d.asOf AS asOf";
  const [own, linked] = await Promise.all([
    typeof src === "string" && src ? ro<DocRow>(g, `MATCH (d:Entity:Document {id:$src}) RETURN ${cols} LIMIT 1`, { src }) : Promise.resolve([]),
    ro<DocRow>(g,
      `MATCH (:Entity {id:$id})-[r:SOURCED_FROM]->(d:Document) WHERE r.until IS NULL RETURN ${cols} ORDER BY coalesce(d.asOf, '') DESC, d.id LIMIT $limit`,
      { id, limit: LIMITS.sources }),
  ]);
  return uniqueById([...own, ...linked]).slice(0, LIMITS.sources).map((r) => ({ id: r.id, title: r.title ?? r.id, ...(r.asOf ? { asOf: r.asOf } : {}) }));
}

function uniqueById<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}

// ---------- graph views ----------

interface EdgeRow { from: string; type: string; to: string; since: number | null }

async function edgesAmong(g: GraphHandle, ids: string[], limit: number): Promise<EdgeRef[]> {
  if (!ids.length) return [];
  const rows = await ro<EdgeRow>(g,
    `MATCH (a:Entity)-[r]->(b:Entity) WHERE a.id IN $ids AND b.id IN $ids AND r.until IS NULL AND NOT type(r) IN $skip
     RETURN a.id AS from, type(r) AS type, b.id AS to, r.since AS since LIMIT $limit`,
    { ids, skip: MAP_SKIP_RELS, limit });
  return rows.map((r) => edgeRef(r.from, r.type, r.to, r.since));
}

// The focus node and what is within `depth` hops over current edges (breadth first, capped per hop).
export async function focusGraph(g: GraphHandle, focus: string, depth: number): Promise<GraphDataDto | null> {
  const [f] = await ro<{ n: NodeRow; summary: string | null }>(g, `MATCH (n:Entity {id:$id}) RETURN ${NODE("n")} AS n, n.summary AS summary LIMIT 1`, { id: focus });
  if (!f) return null;
  const nodes = new Map<string, GraphNodeDto>([[focus, { ...toRef(f.n), ...(f.summary ? { summary: f.summary } : {}) }]]);
  let frontier = [focus];
  for (let hop = 0; hop < depth && frontier.length && nodes.size < LIMITS.focusNodes; hop++) {
    const room = LIMITS.focusNodes - nodes.size;
    const rows = await ro<{ n: NodeRow }>(g,
      `MATCH (a:Entity)-[r]-(m:Entity) WHERE a.id IN $ids AND r.until IS NULL AND NOT type(r) IN $skip
         AND NOT any(l IN labels(m) WHERE l IN $plumbing) AND NOT m.id IN $seen
       WITH DISTINCT m
       RETURN ${NODE("m")} AS n ORDER BY CASE WHEN m:Observation OR m:Turn OR m:Session OR m:Finding THEN 1 ELSE 0 END, m.id LIMIT $limit`,
      { ids: frontier, skip: MAP_SKIP_RELS, plumbing: PLUMBING, seen: [...nodes.keys()], limit: room });
    frontier = [];
    for (const r of rows) if (!nodes.has(r.n.id)) { nodes.set(r.n.id, toRef(r.n)); frontier.push(r.n.id); }
  }
  return { nodes: [...nodes.values()], edges: await edgesAmong(g, [...nodes.keys()], LIMITS.focusNodes * 4) };
}

// The company at a glance: the top nodes by stored `rank` (else by degree), the current edges between them, and topic
// communities. Without stored rank/community (before the librarian has run) both are computed on this subgraph.
export async function overviewGraph(g: GraphHandle, limit: number = LIMITS.overviewNodes): Promise<GraphDataDto> {
  const cap = Math.max(1, Math.min(limit, LIMITS.overviewNodes));
  const rows = await ro<{ n: NodeRow; summary: string | null; rank: number | null; community: number | null; deg: number }>(g,
    `MATCH (n:Entity) WHERE any(l IN labels(n) WHERE l IN $types)
     OPTIONAL MATCH (n)-[r]-() WHERE r.until IS NULL AND NOT type(r) IN $skip
     WITH n, count(r) AS deg
     RETURN ${NODE("n")} AS n, n.summary AS summary, n.rank AS rank, n.community AS community, deg
     ORDER BY coalesce(n.rank, 0) DESC, deg DESC, n.id LIMIT $limit`,
    { types: SEARCHABLE, skip: MAP_SKIP_RELS, limit: cap });
  const ids = rows.map((r) => r.n.id);
  const edges = await edgesAmong(g, ids, LIMITS.overviewEdges);
  const storedRank = rows.some((r) => typeof r.rank === "number");
  const storedCommunity = rows.some((r) => typeof r.community === "number");
  const maxRank = Math.max(0, ...rows.map((r) => (typeof r.rank === "number" ? r.rank : 0))) || 1;
  const pr = storedRank ? undefined : localPageRank(ids, edges);
  const comm = storedCommunity ? undefined : localCommunities(ids, edges);
  const nodes: GraphNodeDto[] = rows.map((r) => {
    const rank = storedRank ? (typeof r.rank === "number" ? Math.round((r.rank / maxRank) * 1000) / 1000 : 0) : pr!.get(r.n.id) ?? 0;
    const community = storedCommunity ? (typeof r.community === "number" ? r.community : undefined) : comm!.get(r.n.id);
    return { ...toRef(r.n), rank, ...(community !== undefined ? { community } : {}), ...(r.summary ? { summary: r.summary.slice(0, 280) } : {}) };
  });
  return { nodes, edges };
}

// ---------- agents ----------

interface StatRow {
  id: string; requests: number; findings: number; proposals: number; reviews: number; passed: number; last: number | null; knows: number;
}

export async function agentStats(g: GraphHandle): Promise<Map<string, AgentStatsDto & { knows: number }>> {
  const ids = AGENTS.map((a) => agentNodeId(a.id));
  const rows = await ro<StatRow>(g,
    `UNWIND $ids AS aid
     OPTIONAL MATCH (a:Entity:Agent {id:aid})
     OPTIONAL MATCH (t:Turn)-[h:HANDLED_BY]->(a) WHERE h.until IS NULL
     WITH aid, a, count(DISTINCT t) AS requests, max(t.at) AS last
     OPTIONAL MATCH (a)-[pf:PRODUCED]->(f:Finding) WHERE pf.until IS NULL
     WITH aid, a, requests, last, count(DISTINCT f) AS findings,
          sum(CASE WHEN f IS NOT NULL AND coalesce(f.rejected, false) = false AND coalesce(f.revised, false) = false THEN 1 ELSE 0 END) AS passed
     OPTIONAL MATCH (a)-[pr:PRODUCED]->(rec:Recommendation) WHERE pr.until IS NULL
     WITH aid, a, requests, last, findings, passed, count(DISTINCT rec) AS proposals
     OPTIONAL MATCH (a)-[rv:REVIEWED]->()
     WITH aid, a, requests, last, findings, passed, proposals, count(rv) AS reviews
     OPTIONAL MATCH (a)-[k:KNOWS_ABOUT]->() WHERE k.until IS NULL
     RETURN aid AS id, requests, findings, passed, proposals, reviews, last, count(k) AS knows`,
    { ids });
  const out = new Map<string, AgentStatsDto & { knows: number }>();
  for (const a of AGENTS) {
    const r = rows.find((x) => x.id === agentNodeId(a.id));
    out.set(a.id, {
      requests: r?.requests ?? 0, findings: r?.findings ?? 0, proposals: r?.proposals ?? 0, reviewsGiven: r?.reviews ?? 0,
      checksPassed: r?.passed ?? 0, checksTotal: r?.findings ?? 0, knows: r?.knows ?? 0,
      ...(r?.last ? { lastActiveAt: iso(r.last) } : {}),
    });
  }
  return out;
}

export async function agentSummaries(g: GraphHandle): Promise<AgentSummaryDto[]> {
  const stats = await agentStats(g);
  return AGENTS.map((a) => {
    const { knows, ...s } = stats.get(a.id)!;
    return { id: a.id, stats: s, knows };
  });
}

export async function agentDetail(g: GraphHandle, rosterId: string): Promise<AgentDetailDto | null> {
  const def = agentById(rosterId);
  if (!def) return null;
  const aid = agentNodeId(rosterId);
  const [stats, knows, findings, playbooks] = await Promise.all([
    agentStats(g),
    ro<{ n: NodeRow; w: number | null }>(g,
      `MATCH (:Entity:Agent {id:$aid})-[k:KNOWS_ABOUT]->(x:Entity) WHERE k.until IS NULL
       RETURN ${NODE("x")} AS n, k.weight AS w ORDER BY coalesce(k.weight, 0) DESC, x.id LIMIT $limit`, { aid, limit: LIMITS.knows }),
    agentFindings(g, aid, rosterId),
    agentPlaybooks(g, aid, def.tools.includes("playbook")),
  ]);
  const maxW = Math.max(1, ...knows.map((k) => numOr(k.w, 1)));
  const known = knows.map((k) => ({ ...toRef(k.n), weight: Math.round((numOr(k.w, 1) / maxW) * 1000) / 1000 }));
  const between = await edgesAmong(g, known.map((k) => k.id), LIMITS.knowledgeEdges);
  const { knows: _knows, ...s } = stats.get(rosterId)!;
  void _knows;
  return {
    id: rosterId,
    playbooks,
    knowledge: {
      nodes: [{ id: aid, label: "Agent", name: `${def.name} · ${def.title}`, weight: 1 }, ...known],
      edges: [...known.map((k) => ({ from: aid, type: "KNOWS_ABOUT", to: k.id, until: null })), ...between],
    },
    findings,
    stats: s,
  };
}

async function agentFindings(g: GraphHandle, aid: string, rosterId: string): Promise<FindingRecordDto[]> {
  const rows = await ro<Record<string, unknown>>(g,
    `MATCH (:Entity:Agent {id:$aid})-[pf:PRODUCED]->(f:Finding) WHERE pf.until IS NULL
     WITH f ORDER BY coalesce(f.createdAt, 0) DESC, f.id DESC LIMIT $limit
     OPTIONAL MATCH (f)-[pt:PART_OF]->(t:Turn) WHERE pt.until IS NULL
     OPTIONAL MATCH (rv:Agent)-[r:REVIEWED]->(f)
     WITH f, t, collect({by: rv.id, verdict: r.verdict, note: r.note}) AS verdicts
     RETURN f.id AS id, coalesce(f.text, f.summary, '') AS text, f.citations AS citations, coalesce(t.id, f.turnId) AS turnId,
       t.question AS question, coalesce(t.at, f.createdAt) AS at, verdicts
     ORDER BY at DESC, id`,
    { aid, limit: LIMITS.findings });
  return rows.map((r) => ({
    id: str(r.id), agent: rosterId, text: str(r.text), citations: strList(r.citations), turnId: str(r.turnId), question: str(r.question),
    at: iso(r.at) ?? new Date(0).toISOString(),
    verdicts: (Array.isArray(r.verdicts) ? r.verdicts : []).flatMap((v: unknown) => {
      if (!isObj(v)) return [];
      const by = rosterIdOf(v.by);
      const verdict = v.verdict === "ok" || v.verdict === "fix" || v.verdict === "reject" ? v.verdict : undefined;
      return by && verdict ? [{ by, verdict, note: str(v.note) }] : [];
    }),
  }));
}

// Playbooks the agent USES; an agent with the playbook tool also reads the tenant's imported playbooks.
async function agentPlaybooks(g: GraphHandle, aid: string, readsPlaybooks: boolean): Promise<AgentDetailDto["playbooks"]> {
  type Row = { id: string; name: string | null; source: string | null };
  const cols = "p.id AS id, p.name AS name, coalesce(p.source, p.url, p.license, '') AS source";
  const [used, all] = await Promise.all([
    ro<Row>(g, `MATCH (:Entity:Agent {id:$aid})-[u:USES]->(p:Playbook) WHERE u.until IS NULL RETURN ${cols} ORDER BY p.id LIMIT $limit`,
      { aid, limit: LIMITS.playbooks }),
    readsPlaybooks ? ro<Row>(g, `MATCH (p:Playbook) RETURN ${cols} ORDER BY p.id LIMIT $limit`, { limit: LIMITS.playbooks }) : Promise.resolve([]),
  ]);
  return uniqueById([...used, ...all]).slice(0, LIMITS.playbooks).map((r) => ({ id: r.id, name: r.name ?? r.id, source: r.source ?? "" }));
}

// ---------- recommendations and approvals ----------

const AREA_ALIASES: Record<string, RecArea> = { ads: "ads", ad: "ads", seo: "seo", content: "content", funnel: "funnel", tech: "tech", ops: "knowledge", knowledge: "knowledge" };
const toArea = (v: unknown, kind: unknown): RecArea => {
  const a = AREA_ALIASES[str(v).toLowerCase()];
  if (a) return a;
  if (kind === "pause_ad") return "ads";
  if (kind === "content_draft") return "content";
  if (kind === "github_issue") return "tech";
  return REC_AREAS.includes(str(v) as RecArea) ? (str(v) as RecArea) : "knowledge";
};

// The money at stake, when the recommendation carries one: `value` as JSON {amount, currency?, per?, note?}, or flat
// valueAmount/valueCurrency/valuePer/valueNote props.
function toValue(p: Record<string, unknown>): RecommendationDto["value"] | undefined {
  const raw = parseJson(p.value);
  const v = isObj(raw) ? raw : { amount: p.valueAmount, currency: p.valueCurrency, per: p.valuePer, note: p.valueNote };
  if (typeof v.amount !== "number" || !Number.isFinite(v.amount)) return undefined;
  const per = v.per === "week" || v.per === "month" || v.per === "year" ? v.per : undefined;
  return {
    amount: v.amount, ...(typeof v.currency === "string" && v.currency ? { currency: v.currency } : {}), ...(per ? { per } : {}),
    ...(typeof v.note === "string" && v.note ? { note: v.note } : {}),
  };
}

const REC_STATUS: Record<string, RecommendationDto["status"]> = {
  approved: "approved", executed: "approved", done: "approved", accepted: "approved",
  rejected: "dismissed", dismissed: "dismissed", closed: "dismissed", superseded: "dismissed", proposed: "proposed",
};

export async function recommendations(g: GraphHandle, limit: number = LIMITS.recommendations): Promise<RecommendationDto[]> {
  const rows = await ro<{ r: Record<string, unknown>; approvals: Array<{ id: string; status: string | null; at: number | null }>; ev: NodeRow[]; producer: string | null }>(g,
    `MATCH (r:Recommendation)
     WITH r ORDER BY coalesce(r.score, r.confidence, 0) DESC, coalesce(r.createdAt, 0) DESC, r.id LIMIT $limit
     OPTIONAL MATCH (r)-[p:PROPOSES]->(a:Approval) WHERE p.until IS NULL
     WITH r, collect({id: a.id, status: a.status, at: a.createdAt}) AS approvals
     OPTIONAL MATCH (r)-[e:EVIDENCED_BY|BASED_ON]->(x:Entity) WHERE e.until IS NULL
     WITH r, approvals, collect(${NODE("x")})[0..8] AS ev
     OPTIONAL MATCH (ag:Agent)-[pr:PRODUCED]->(r) WHERE ID(pr) >= 0
     RETURN {id: r.id, name: r.name, summary: r.summary, area: r.area, kind: r.kind, status: r.status, score: r.score, confidence: r.confidence,
       by: r.by, impact: r.impact, value: r.value, valueAmount: r.valueAmount, valueCurrency: r.valueCurrency, valuePer: r.valuePer,
       valueNote: r.valueNote, simulated: r.simulated, createdAt: r.createdAt} AS r,
       approvals, ev, collect(ag.id)[0] AS producer
     ORDER BY coalesce(r.score, r.confidence, 0) DESC, r.id`,
    { limit: Math.max(1, Math.min(limit, LIMITS.recommendations)) });
  for (const r of rows) r.ev = r.ev.filter((n) => typeof n.id === "string"); // OPTIONAL MATCH misses collect as {id: null}
  const evIds = [...new Set(rows.flatMap((r) => r.ev.map((n) => n.id)))];
  const evEdges = await edgesAmong(g, evIds, 500);
  return rows.map(({ r, approvals, ev, producer }) => {
    const live = approvals.filter((a) => a.id).sort((a, b) => numOr(b.at, 0) - numOr(a.at, 0));
    const pending = live.find((a) => (a.status ?? "pending") === "pending");
    const decided = live.find((a) => a.status && a.status !== "pending");
    let status = REC_STATUS[str(r.status)] ?? "open";
    if (status === "open" && pending) status = "proposed";
    if (status === "open" && decided) status = decided.status === "rejected" ? "dismissed" : "approved";
    const evidence = ev.map(toRef);
    const ids = new Set(evidence.map((n) => n.id));
    const confidence = numOr(r.confidence, numOr(r.score, 0.5));
    const value = toValue(r);
    return {
      id: str(r.id), area: toArea(r.area, r.kind), title: str(r.name, str(r.id)), why: str(r.summary), impact: str(r.impact),
      ...(value ? { value } : {}), confidence, score: numOr(r.score, confidence), status,
      by: agentById(str(r.by)) ? str(r.by) : rosterIdOf(producer) ?? "chief-of-staff",
      evidence, evidenceEdges: evEdges.filter((e) => ids.has(e.from) && ids.has(e.to)),
      ...((pending ?? live[0]) ? { approvalId: (pending ?? live[0])!.id } : {}),
      ...(r.simulated === true || evidence.some((n) => n.simulated) ? { simulated: true } : {}),
      createdAt: iso(r.createdAt) ?? new Date(0).toISOString(),
    };
  });
}

// A stored payload (JSON) as the card's {title, body, target}: any other fields are kept in the body as JSON.
export function toPayload(raw: unknown, fallbackTitle: string): ApprovalPayload {
  const p = parseJson(raw);
  if (!isObj(p)) return { title: fallbackTitle, body: typeof raw === "string" ? raw : "" };
  const title = str(p.title) || fallbackTitle;
  const bodyKey = ["body", "text", "caption", "message", "content", "brief"].find((k) => typeof p[k] === "string");
  const targetKey = ["target", "repo", "channel", "campaign", "url"].find((k) => typeof p[k] === "string");
  const rest = Object.fromEntries(Object.entries(p).filter(([k]) => k !== "title" && k !== bodyKey && k !== targetKey));
  const body = bodyKey ? str(p[bodyKey]) : Object.keys(rest).length ? JSON.stringify(rest, null, 2) : "";
  return { title, body, ...(targetKey ? { target: str(p[targetKey]) } : {}) };
}

const ACTION_KINDS = ["github_issue", "content_draft", "pause_ad", "discord_post"] as const;
const APPROVAL_FIELDS = `a.id AS id, a.name AS name, a.title AS title, a.kind AS kind, a.status AS status, a.payload AS payload,
  a.editedPayload AS editedPayload, a.createdAt AS createdAt, a.decidedAt AS decidedAt, a.result AS result, a.simulated AS simulated,
  a.recommendation AS recProp`;

function toApproval(r: Record<string, unknown>): ApprovalDto {
  const title = str(r.title) || str(r.name).replace(/^[a-z_]+:\s*/, "") || str(r.id);
  const kind = (ACTION_KINDS as readonly string[]).includes(str(r.kind)) ? (str(r.kind) as ApprovalDto["kind"]) : "github_issue";
  const status = (APPROVAL_STATUSES as readonly string[]).includes(str(r.status)) ? (str(r.status) as ApprovalStatus) : "pending";
  const recId = str(r.rec) || str(r.recProp);
  return {
    id: str(r.id), kind, status, title, by: agentById(str(r.by)) ? str(r.by) : rosterIdOf(r.producer) ?? "chief-of-staff",
    ...(recId ? { recommendationId: recId } : {}),
    payload: toPayload(r.payload, title),
    ...(r.editedPayload ? { editedPayload: toPayload(r.editedPayload, title) } : {}),
    createdAt: iso(r.createdAt) ?? new Date(0).toISOString(),
    ...(iso(r.decidedAt) ? { decidedAt: iso(r.decidedAt) } : {}),
    ...(typeof r.result === "string" && r.result ? { result: r.result } : {}),
    ...(r.simulated === true || r.recSimulated === true || kind === "pause_ad" ? { simulated: true } : {}),
  };
}

// FalkorDB 4.22 (the cloud) refuses a node taken out of a list (collect(r)[0]) as a pattern endpoint, so the first
// recommendation is picked by id and matched again.
const approvalQuery = (where: string) =>
  `MATCH (a:Entity:Approval) ${where}
   WITH a ORDER BY CASE WHEN coalesce(a.status, 'pending') = 'pending' THEN 0 ELSE 1 END, coalesce(a.createdAt, 0) DESC, a.id LIMIT $limit
   OPTIONAL MATCH (r0:Recommendation)-[pp:PROPOSES]->(a) WHERE ID(pp) >= 0
   WITH a, collect(r0.id)[0] AS rid
   OPTIONAL MATCH (r:Entity:Recommendation {id: rid})
   OPTIONAL MATCH (ag:Agent)-[pr:PRODUCED]->(r) WHERE ID(pr) >= 0
   WITH a, r, collect(ag.id)[0] AS producer
   RETURN ${APPROVAL_FIELDS}, r.id AS rec, coalesce(r.by, a.by) AS by, r.simulated AS recSimulated, producer`;

export async function approvals(g: GraphHandle, limit: number = LIMITS.approvals): Promise<ApprovalDto[]> {
  const rows = await ro<Record<string, unknown>>(g, approvalQuery(""), { limit: Math.max(1, Math.min(limit, LIMITS.approvals)) });
  return rows.map(toApproval);
}

export async function approval(g: GraphHandle, id: string): Promise<ApprovalDto | null> {
  const rows = await ro<Record<string, unknown>>(g, approvalQuery("WHERE a.id = $id"), { id, limit: 1 });
  return rows[0] ? toApproval(rows[0]) : null;
}

export type { NodeRef };
