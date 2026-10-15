// Episodic memory in the tenant graph (spec §7.3, §8, §16.2 step 6).
// - ensureRoster: the AI staff as Agent nodes (agent:allevia-<id>) MEMBER_OF their department Team (team:allevia-<dept>).
// - Sessions are threads; a Turn is one question and answer, stored with its checks and the full AgentEvent log (replay).
// - saveTurn links the Turn to its session, asker, agents (HANDLED_BY), every touched node (TOUCHED) and its citations
//   (CITED); writes each agent's Finding (PART_OF the Turn, PRODUCED by the agent, CITED, BASED_ON other Findings) and
//   each review (REVIEWED, with verdict and note); and grows each agent's KNOWS_ABOUT weight for what its Findings cited.
//   A citation counts (CITED, KNOWS_ABOUT) only if a tool returned that id this turn and it is in the graph: an id a
//   model made up, or copied from text, is kept in the Turn's text but never becomes an edge. The owner's instructions
//   the turn worked under (guidedBy, from the orchestrator) become GUIDED_BY from the Turn and from each Finding whose
//   desk they guided, when they are a Memory, Rule or BrandRule in the graph.
//   The two raw-Cypher writes here (Session.lastAt, the KNOWS_ABOUT merge) bypass upsert, so they go through rawWrite,
//   which tells the projection cache (noteGraphWrite) that the graph changed.
// - recallBrief: "what we already know" before a turn, with ids the agents may cite.
import { randomBytes } from "node:crypto";
import { AGENTS, DEPARTMENTS, agentById } from "../../shared/roster.js";
import type { AgentEvent, NodeRef, TurnChecks } from "../../shared/contracts.js";
import type { GraphHandle } from "../graph/client.js";
import { noteGraphWrite } from "../graph/projection.js";
import { writeBatch, type EdgeInput, type NodeInput, type Prim } from "../graph/upsert.js";
import { typeFromId } from "../util/ids.js";
import { istDate } from "../util/time.js";
import { TouchedSet } from "./tool.js";
import type { FindingRecord, RecallBrief, ReviewRecord } from "./types.js";

export const agentNodeId = (rosterId: string): string => `agent:allevia-${rosterId}`;
export const teamNodeId = (departmentId: string): string => `team:allevia-${departmentId}`;

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const unique = <T>(xs: T[]): T[] => [...new Set(xs)];
const rand = (): string => randomBytes(4).toString("hex");

export const newSessionId = (now: number): string => `session:${istDate(now)}-${rand()}`;
export const newTurnId = (now: number): string => `turn:${istDate(now)}-${rand()}`;

// ---------- roster ----------

function rosterWrites(businessId?: string): { nodes: NodeInput[]; edges: EdgeInput[] } {
  const nodes: NodeInput[] = [
    ...DEPARTMENTS.map((d): NodeInput => ({
      type: "Team", id: teamNodeId(d.id), name: d.name, summary: d.blurb, props: { department: d.id, hue: d.hue, allevia: true },
    })),
    ...AGENTS.map((a): NodeInput => ({
      type: "Agent", id: agentNodeId(a.id), name: a.name, summary: `${a.title}. ${a.persona}`,
      props: { rosterId: a.id, title: a.title, department: a.department, model: a.model, tools: a.tools, handles: a.handles, allevia: true },
    })),
  ];
  const edges: EdgeInput[] = AGENTS.map((a) => ({ from: agentNodeId(a.id), type: "MEMBER_OF", to: teamNodeId(a.department) }));
  if (businessId) edges.push(...DEPARTMENTS.map((d): EdgeInput => ({ from: teamNodeId(d.id), type: "PART_OF", to: businessId })));
  return { nodes, edges };
}

// Idempotent: re-running changes nothing (upserts are no-ops on identical content).
export async function ensureRoster(g: GraphHandle, opts: { businessId?: string } = {}, now: number = Date.now()): Promise<void> {
  let businessId = opts.businessId;
  if (businessId && !(await existing(g, [businessId])).has(businessId)) businessId = undefined;
  const s = await writeBatch(g, rosterWrites(businessId), now);
  if (s.errors.length) throw new Error(`ensureRoster: ${s.errors.map((e) => e.error).join("; ")}`);
}

const rosterReady = new Set<string>();
async function rosterOnce(g: GraphHandle, now: number): Promise<void> {
  if (rosterReady.has(g.name)) return;
  const have = await g.roQuery<{ c: number }>("MATCH (a:Entity:Agent) WHERE a.id IN $ids RETURN count(a) AS c", { ids: AGENTS.map((a) => agentNodeId(a.id)) });
  if ((have[0]?.c ?? 0) < AGENTS.length) await ensureRoster(g, {}, now);
  rosterReady.add(g.name);
}

// ---------- helpers ----------

// Every write that bypasses upsert/writeBatch: run it, then invalidate the graph's cached projection (even if the query
// failed part-way, a stale projection is worse than a rebuild). Awaited like upsert's, so other processes see the
// write stamp before we go on.
async function rawWrite(g: GraphHandle, cypher: string, params: Record<string, unknown>): Promise<void> {
  try {
    await g.query(cypher, params);
  } finally {
    await noteGraphWrite(g.name);
  }
}

async function existing(g: GraphHandle, ids: string[]): Promise<Set<string>> {
  const want = unique(ids.filter(Boolean));
  if (!want.length) return new Set();
  const rows = await g.roQuery<{ id: string }>("UNWIND $ids AS id MATCH (n:Entity {id:id}) RETURN n.id AS id", { ids: want });
  return new Set(rows.map((r) => r.id));
}

// "person:ankit-vohra" -> "Ankit Vohra"
const nameFromId = (id: string): string => {
  const key = id.slice(id.indexOf(":") + 1).replace(/[-_]+/g, " ").trim();
  return key ? key.replace(/\b\p{L}/gu, (c) => c.toUpperCase()) : id;
};

async function ensurePerson(g: GraphHandle, id: string, now: number): Promise<boolean> {
  if ((await existing(g, [id])).has(id)) return true;
  if (!id.startsWith("person:")) return false;
  const s = await writeBatch(g, { nodes: [{ type: "Person", id, name: nameFromId(id) }] }, now);
  return s.errors.length === 0;
}

// Consecutive text deltas from the same agent become one event: the replay log stays small and replays the same.
export function compactEvents(events: AgentEvent[]): AgentEvent[] {
  const out: AgentEvent[] = [];
  for (const e of events) {
    const last = out.at(-1);
    if (e.type === "text" && last?.type === "text" && last.agent === e.agent) out[out.length - 1] = { ...last, delta: last.delta + e.delta };
    else out.push(e);
  }
  return out;
}

// ---------- sessions ----------

export interface SessionInfo { id: string; channel: string; asker: string; startedAt: number; title: string }

export async function startSession(
  g: GraphHandle, o: { channel: string; asker: string; title?: string; id?: string }, now: number = Date.now(),
): Promise<SessionInfo> {
  const id = o.id ?? newSessionId(now);
  const title = clip(oneLine(o.title ?? "") || "New thread", 120);
  await ensurePerson(g, o.asker, now);
  const s = await writeBatch(g, {
    nodes: [{ type: "Session", id, name: title, props: { channel: o.channel, asker: o.asker, startedAt: now } }],
  }, now);
  if (s.errors.length) throw new Error(`startSession: ${s.errors.map((e) => e.error).join("; ")}`);
  return { id, channel: o.channel, asker: o.asker, startedAt: now, title };
}

function toSessionInfo(p: Record<string, unknown>): SessionInfo {
  return { id: String(p.id), channel: String(p.channel ?? ""), asker: String(p.asker ?? ""), startedAt: Number(p.startedAt ?? p.createdAt ?? 0), title: String(p.name ?? "") };
}

export interface TurnSummary { id: string; question: string; answer: string; at: number; status: string; checks: TurnChecks | null; agents: string[] }

const parseJson = <T>(s: unknown): T | null => {
  if (typeof s !== "string") return null;
  try { return JSON.parse(s) as T; } catch { return null; }
};

export async function getSession(g: GraphHandle, id: string): Promise<(SessionInfo & { turns: TurnSummary[] }) | null> {
  const rows = await g.roQuery<{ p: Record<string, unknown> }>("MATCH (s:Entity:Session {id:$id}) RETURN properties(s) AS p", { id });
  if (!rows[0]) return null;
  const turns = await g.roQuery<{ id: string; q: string; a: string; at: number; status: string | null; checks: string | null; agents: string[] | null }>(
    "MATCH (s:Entity:Session {id:$id}) WITH s MATCH (t:Turn)-[r:IN_SESSION]->(s) WHERE r.until IS NULL RETURN t.id AS id, t.question AS q, t.answer AS a, t.at AS at, t.status AS status, t.checks AS checks, t.agents AS agents ORDER BY t.at, t.id",
    { id });
  return {
    ...toSessionInfo(rows[0].p),
    turns: turns.map((t) => ({ id: t.id, question: t.q ?? "", answer: t.a ?? "", at: t.at, status: t.status ?? "ok", checks: parseJson<TurnChecks>(t.checks), agents: t.agents ?? [] })),
  };
}

export async function listSessions(g: GraphHandle, o: { limit?: number } = {}): Promise<Array<SessionInfo & { lastAt: number; turnCount: number }>> {
  const rows = await g.roQuery<{ p: Record<string, unknown>; n: number; last: number | null }>(
    `MATCH (s:Session) OPTIONAL MATCH (t:Turn)-[it:IN_SESSION]->(s) WHERE it.until IS NULL
     WITH s, count(t) AS n, max(t.at) AS last
     RETURN properties(s) AS p, n, last ORDER BY coalesce(last, s.startedAt) DESC, s.id LIMIT $limit`,
    { limit: Math.max(1, Math.min(200, o.limit ?? 20)) });
  return rows.map((r) => {
    const s = toSessionInfo(r.p);
    return { ...s, turnCount: r.n, lastAt: r.last ?? s.startedAt };
  });
}

export async function getTurnEvents(g: GraphHandle, turnId: string): Promise<AgentEvent[] | null> {
  const rows = await g.roQuery<{ e: string | null }>("MATCH (t:Entity:Turn {id:$id}) RETURN t.events AS e", { id: turnId });
  return parseJson<AgentEvent[]>(rows[0]?.e);
}

// ---------- showcase (spec §11.3) ----------

// The public demo replays only turns marked Turn.showcase = true. Only a finished turn with a stored event log can be
// marked, because the replay is that log.
export interface ShowcaseTurn { id: string; question: string; at: number; showcase: boolean }

export async function setShowcase(g: GraphHandle, turnId: string, on: boolean): Promise<ShowcaseTurn> {
  const rows = await g.roQuery<{ q: string | null; at: number | null; status: string | null; hasEvents: boolean }>(
    "MATCH (t:Entity:Turn {id:$id}) RETURN t.question AS q, t.at AS at, t.status AS status, t.events IS NOT NULL AS hasEvents LIMIT 1", { id: turnId });
  const t = rows[0];
  if (!t) throw new Error(`No turn ${turnId} in ${g.name}.`);
  if (on && (t.status ?? "ok") !== "ok") throw new Error(`${turnId} failed, so it can't be a showcase turn.`);
  if (on && !t.hasEvents) throw new Error(`${turnId} has no stored event log to replay.`);
  await rawWrite(g, "MATCH (t:Entity:Turn {id:$id}) SET t.showcase = $on", { id: turnId, on });
  return { id: turnId, question: t.q ?? "", at: t.at ?? 0, showcase: on };
}

export async function listShowcase(g: GraphHandle): Promise<ShowcaseTurn[]> {
  const rows = await g.roQuery<{ id: string; q: string | null; at: number | null }>(
    "MATCH (t:Turn) WHERE t.showcase = true RETURN t.id AS id, t.question AS q, t.at AS at ORDER BY t.at, t.id");
  return rows.map((r) => ({ id: r.id, question: r.q ?? "", at: r.at ?? 0, showcase: true }));
}

// ---------- turns ----------

export interface SaveTurnInput {
  turnId: string;
  sessionId: string;
  question: string;
  answer: string;
  asker: string;
  source?: string;                  // which door the question came through ("web", "discord", "cli", "mcp") (a thread can be continued from either)
  at: number;                       // epoch ms the turn started
  ms?: number;                      // how long it took
  status?: "ok" | "failed";
  error?: string;
  checks?: TurnChecks;
  agents: string[];                 // roster ids
  events: AgentEvent[];             // the full log, for replay
  touched: TouchedSet | string[];   // every node/source id a tool returned
  citations: string[];              // [[ids]] in the answer
  findings: FindingRecord[];
  reviews: ReviewRecord[];
  guidedBy?: string[];              // the owner's instructions (Memory, Rule, BrandRule ids) the turn worked under
}

export interface SaveTurnResult { nodesCreated: number; edgesCreated: number; errors: string[] }

// GUIDED_BY reaches only these (schema: Turn|Finding|Content -GUIDED_BY-> Memory|Rule|BrandRule).
const GUIDES = new Set(["Memory", "Rule", "BrandRule"]);

export async function saveTurn(g: GraphHandle, t: SaveTurnInput): Promise<SaveTurnResult> {
  const now = t.at;
  await rosterOnce(g, now);
  const session = await g.roQuery<{ c: number }>("MATCH (s:Entity:Session {id:$id}) RETURN count(s) AS c", { id: t.sessionId });
  if (!session[0]?.c) await startSession(g, { channel: "unknown", asker: t.asker, title: t.question, id: t.sessionId }, now);
  const askerOk = await ensurePerson(g, t.asker, now);

  const touchedIds = t.touched instanceof TouchedSet ? [...t.touched.nodes().map((n) => n.id), ...t.touched.sources().map((s) => s.id)] : t.touched;
  const findingIds = new Set(t.findings.map((f) => f.id));
  const guideIds = [...(t.guidedBy ?? []), ...t.findings.flatMap((f) => f.guidedBy ?? [])].filter((id) => GUIDES.has(typeFromId(id) ?? ""));
  const known = await existing(g, [...touchedIds, ...t.citations, ...t.findings.flatMap((f) => [...f.citations, ...f.basedOn]), ...guideIds]);
  const guide = (id: string): boolean => known.has(id) && GUIDES.has(typeFromId(id) ?? ""); // an instruction still in the graph
  const exists = (id: string): boolean => known.has(id) && id !== t.turnId;
  const seen = new Set(touchedIds);
  const cited = (id: string): boolean => seen.has(id) && exists(id); // returned by a tool this turn, and in the graph

  const turnProps: Record<string, Prim> = {
    question: t.question, answer: t.answer, at: t.at, status: t.status ?? "ok", sessionId: t.sessionId, asker: t.asker,
    agents: t.agents, citations: t.citations, checks: JSON.stringify(t.checks ?? null), events: JSON.stringify(compactEvents(t.events)),
  };
  if (t.source) turnProps.source = t.source;
  if (t.ms !== undefined) turnProps.ms = t.ms;
  if (t.error) turnProps.error = t.error;
  const nodes: NodeInput[] = [{ type: "Turn", id: t.turnId, name: clip(oneLine(t.question), 120) || t.turnId, summary: clip(t.answer, 600), props: turnProps }];
  const edges: EdgeInput[] = [{ from: t.turnId, type: "IN_SESSION", to: t.sessionId }];
  if (askerOk) edges.push({ from: t.asker, type: "ASKED", to: t.turnId });
  for (const a of unique(t.agents)) if (agentById(a)) edges.push({ from: t.turnId, type: "HANDLED_BY", to: agentNodeId(a) });
  for (const id of unique(touchedIds)) if (exists(id)) edges.push({ from: t.turnId, type: "TOUCHED", to: id });
  for (const id of unique(t.citations)) if (cited(id)) edges.push({ from: t.turnId, type: "CITED", to: id });
  for (const id of unique(t.guidedBy ?? [])) if (guide(id)) edges.push({ from: t.turnId, type: "GUIDED_BY", to: id });

  for (const f of t.findings) {
    const who = agentById(f.agent);
    nodes.push({
      type: "Finding", id: f.id, name: clip(oneLine(`${who?.name ?? f.agent}: ${f.task}`), 120), summary: clip(f.text, 600),
      props: {
        text: f.text, agent: f.agent, task: f.task, turnId: t.turnId, citations: f.citations, basedOn: f.basedOn, proposals: f.proposals,
        revised: f.revised, rejected: f.rejected, partial: f.partial === true,
      },
    });
    edges.push({ from: f.id, type: "PART_OF", to: t.turnId });
    if (who) edges.push({ from: agentNodeId(f.agent), type: "PRODUCED", to: f.id });
    for (const id of unique(f.citations)) if (cited(id)) edges.push({ from: f.id, type: "CITED", to: id });
    for (const id of unique(f.basedOn)) if (id !== f.id && (findingIds.has(id) || known.has(id))) edges.push({ from: f.id, type: "BASED_ON", to: id });
    for (const id of unique(f.guidedBy ?? [])) if (guide(id)) edges.push({ from: f.id, type: "GUIDED_BY", to: id });
  }
  for (const r of t.reviews) {
    if (agentById(r.reviewer) && findingIds.has(r.findingId)) {
      edges.push({ from: agentNodeId(r.reviewer), type: "REVIEWED", to: r.findingId, props: { verdict: r.verdict, note: r.note, turnId: t.turnId } });
    }
  }

  const s = await writeBatch(g, { nodes, edges }, now);
  await rawWrite(g, "MATCH (s:Entity:Session {id:$id}) SET s.lastAt = CASE WHEN coalesce(s.lastAt, 0) > $at THEN s.lastAt ELSE $at END", { id: t.sessionId, at: t.at });
  await growKnowsAbout(g, t, cited, now);
  return {
    nodesCreated: s.nodesCreated, edgesCreated: s.edgesCreated,
    errors: s.errors.map((e) => `${e.kind}: ${e.error}`),
  };
}

// Each agent knows a little more about what its (non-rejected) Findings cited; on the fast path the Chief's own
// citations count. Counted once per turn per (agent, entity): the edge keeps the ids of the turns that counted (the
// last KNOWS_TURNS of them), so re-saving any turn, in any order, changes nothing.
const KNOWS_TURNS = 200;
async function growKnowsAbout(g: GraphHandle, t: SaveTurnInput, cited: (id: string) => boolean, now: number): Promise<void> {
  const pairs = new Map<string, { a: string; x: string }>();
  const add = (agent: string, ids: string[]) => {
    if (!agentById(agent)) return;
    for (const x of ids) if (cited(x)) pairs.set(`${agent}|${x}`, { a: agentNodeId(agent), x });
  };
  for (const f of t.findings) if (!f.rejected) add(f.agent, f.citations);
  if (!t.findings.length && (t.status ?? "ok") === "ok") add("chief-of-staff", t.citations);
  if (!pairs.size) return;
  await rawWrite(g,
    `UNWIND $pairs AS p
     MATCH (a:Entity {id:p.a}), (x:Entity {id:p.x})
     MERGE (a)-[r:KNOWS_ABOUT]->(x)
     ON CREATE SET r.since = $now, r.recordedAt = $now
     WITH r, ($turn IN coalesce(r.turns, []) OR r.lastTurn = $turn) AS counted
     SET r.weight = CASE WHEN counted THEN coalesce(r.weight, 1) ELSE coalesce(r.weight, 0) + 1 END,
         r.turns = CASE WHEN counted THEN coalesce(r.turns, []) ELSE (coalesce(r.turns, []) + [$turn])[-$keep..] END,
         r.lastTurn = $turn`,
    { pairs: [...pairs.values()], now, turn: t.turnId, keep: KNOWS_TURNS });
}

// ---------- recall ----------

const BRIEF_MAX_CHARS = 6_000; // ≈ 1,500 tokens
const CLOSED_STATUSES = ["done", "rejected", "executed", "closed", "dismissed", "failed", "superseded"];
const stripCitations = (s: string): string => s.replace(/\s*\[\[[^\]]*\]\]/g, "");

interface TurnRow { id: string; q: string | null; a: string | null; at: number | null }

const turnLine = (r: TurnRow): string =>
  `- [[${r.id}]] ${r.at ? istDate(r.at) : "?"}: asked "${clip(oneLine(r.q ?? ""), 140)}"; answered "${clip(oneLine(stripCitations(r.a ?? "")), 220)}"`;

export async function recallBrief(g: GraphHandle, o: { question: string; seedIds: string[]; sessionId?: string }): Promise<RecallBrief> {
  const seeds = unique(o.seedIds.filter(Boolean)).slice(0, 25);
  const sections: Array<{ title: string; lines: string[] }> = [];
  const refs = new Map<string, NodeRef>();
  const ref = (id: string, label: string, name: string | null | undefined) => { if (!refs.has(id)) refs.set(id, { id, label, name: name || id }); };

  const thread: TurnRow[] = o.sessionId ? (await g.roQuery<TurnRow>(
    `MATCH (s:Entity:Session {id:$sid}) WITH s MATCH (t:Turn)-[r:IN_SESSION]->(s) WHERE r.until IS NULL AND coalesce(t.status, 'ok') = 'ok'
     RETURN t.id AS id, t.question AS q, t.answer AS a, t.at AS at ORDER BY t.at DESC, t.id LIMIT 3`, { sid: o.sessionId })).reverse() : [];
  if (thread.length) {
    sections.push({ title: "This thread so far:", lines: thread.map(turnLine) });
    for (const r of thread) ref(r.id, "Turn", r.q);
  }

  if (seeds.length) {
    const inThread = new Set(thread.map((r) => r.id));
    const turns = (await g.roQuery<TurnRow>(
      `MATCH (x:Entity) WHERE x.id IN $ids WITH x MATCH (t:Turn)-[:TOUCHED|CITED]->(x) WHERE coalesce(t.status, 'ok') = 'ok'
       WITH DISTINCT t RETURN t.id AS id, t.question AS q, t.answer AS a, t.at AS at ORDER BY t.at DESC, t.id LIMIT 8`, { ids: seeds }))
      .filter((r) => !inThread.has(r.id)).slice(0, 5);
    if (turns.length) {
      sections.push({ title: "Earlier threads on this:", lines: turns.map(turnLine) });
      for (const r of turns) ref(r.id, "Turn", r.q);
    }

    const notes = await g.roQuery<{ id: string; name: string; text: string | null; kind: string | null; asOf: string | null }>(
      `MATCH (m:Memory)-[r:ABOUT]->(x:Entity) WHERE x.id IN $ids AND r.until IS NULL
       WITH DISTINCT m RETURN m.id AS id, m.name AS name, coalesce(m.text, m.summary, m.name) AS text, m.kind AS kind, m.asOf AS asOf
       ORDER BY coalesce(m.createdAt, 0) DESC, m.id LIMIT 8`, { ids: seeds });
    if (notes.length) {
      sections.push({ title: "Notes from the owner and the team:", lines: notes.map((m) => `- [[${m.id}]]${m.kind ? ` (${m.kind})` : ""}${m.asOf ? ` as of ${m.asOf}` : ""}: ${clip(oneLine(m.text ?? ""), 240)}`) });
      for (const m of notes) ref(m.id, "Memory", m.name);
    }

    const recs = await g.roQuery<{ id: string; name: string; status: string | null; approvals: string[] }>(
      `MATCH (x:Entity) WHERE x.id IN $ids WITH x MATCH (rec:Recommendation)-[r:BASED_ON|EVIDENCED_BY|AFFECTS]->(x) WHERE r.until IS NULL AND NOT coalesce(rec.status, 'open') IN $closed
       WITH DISTINCT rec
       OPTIONAL MATCH (rec)-[pp:PROPOSES]->(ap:Approval) WHERE pp.until IS NULL AND coalesce(ap.status, 'pending') = 'pending'
       RETURN rec.id AS id, rec.name AS name, rec.status AS status, collect(ap.id) AS approvals LIMIT 8`, { ids: seeds, closed: CLOSED_STATUSES });
    if (recs.length) {
      sections.push({
        title: "Open recommendations and approvals waiting on the owner:",
        lines: recs.map((r) => `- [[${r.id}]] ${clip(oneLine(r.name ?? ""), 160)} (${r.status ?? "open"})${r.approvals.length ? `; approval ${r.approvals.map((a) => `[[${a}]]`).join(", ")} pending` : ""}`),
      });
      for (const r of recs) { ref(r.id, "Recommendation", r.name); for (const a of r.approvals) ref(a, "Approval", a); }
    }
  }

  const prefs = await g.roQuery<{ id: string; name: string; text: string | null }>(
    `MATCH (m:Memory) WHERE m.kind = 'preference'
     RETURN m.id AS id, m.name AS name, coalesce(m.text, m.summary, m.name) AS text ORDER BY coalesce(m.createdAt, 0) DESC, m.id LIMIT 8`);
  if (prefs.length) {
    sections.push({ title: "Owner preferences:", lines: prefs.map((m) => `- [[${m.id}]] ${clip(oneLine(m.text ?? ""), 200)}`) });
    for (const m of prefs) ref(m.id, "Memory", m.name);
  }

  // Fit the budget by dropping whole lines from the end; then keep only ids that made it into the text.
  let text = sections.map((s) => [s.title, ...s.lines].join("\n")).join("\n\n");
  while (text.length > BRIEF_MAX_CHARS && sections.length) {
    const last = sections.at(-1)!;
    last.lines.pop();
    if (!last.lines.length) sections.pop();
    text = sections.map((s) => [s.title, ...s.lines].join("\n")).join("\n\n");
  }
  const ids = [...refs.keys()].filter((id) => text.includes(`[[${id}]]`));
  return { text, ids, nodes: ids.map((id) => refs.get(id)!) };
}
