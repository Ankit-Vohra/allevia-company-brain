// The mock backend: same functions and shapes as the real API (web/src/api.ts), backed by in-memory data and scripted
// runs. Used with ?mock=1, or automatically when /api/tenants does not answer.
import type { AgentEvent, AgentId, OnboardEvent } from "@shared/contracts";
import { AGENTS } from "@shared/roster";
import type {
  AgentDetail, AgentStats, AgentSummary, Approval, ApprovalDecision, FindingRecord, GraphData, NodeDetail, OnboardRequest,
  Overview, Recommendation, SearchHit, SessionDetail, SessionSummary, Tenant, TurnRecord,
} from "../types-ext";
import { BRIEF, FRESHNESS, GRAPHS, KNOWS, PLAYBOOKS, TENANTS, seedApprovals, seedRecommendations } from "./data";
import { type MockGraph, buildGraph, graphData, neighborhood, nodeDetail, refOf, searchGraph } from "./graph-kit";
import { onboardScript } from "./onboard";
import { SCRIPTS, avsRun, pickScript, pendingRun, seoRun, storiesRun } from "./runs";
import { type TimedEvent, compile } from "./script";

interface StoredTurn { record: TurnRecord; events: AgentEvent[] }
interface StoredSession { summary: SessionSummary; turns: StoredTurn[] }

const tenants: Tenant[] = [...TENANTS];
const graphs: Record<string, MockGraph> = { ...GRAPHS };
const sessions: Record<string, StoredSession[]> = {};
const recommendations = seedRecommendations();
const approvals = seedApprovals();
let counter = 100;

function store(tenant: string, sessionId: string, title: string, at: string, events: AgentEvent[]) {
  const final = events.find((e): e is Extract<AgentEvent, { type: "final" }> => e.type === "final");
  const session = events.find((e): e is Extract<AgentEvent, { type: "session" }> => e.type === "session");
  if (!final || !session) return;
  const record: TurnRecord = {
    id: final.turnId, question: session.question, answer: final.answer, at, ms: final.ms,
    agents: final.agents, citations: final.citations, checks: final.checks,
  };
  const list = (sessions[tenant] ??= []);
  let s = list.find((x) => x.summary.id === sessionId);
  if (!s) {
    s = { summary: { id: sessionId, title, startedAt: at, lastAt: at, turns: 0, channel: "web" }, turns: [] };
    list.unshift(s);
  }
  s.turns.push({ record, events });
  s.summary.turns = s.turns.length;
  s.summary.lastAt = at;
  list.sort((a, b) => b.summary.lastAt.localeCompare(a.summary.lastAt));
}

function seed() {
  const seeds: [typeof storiesRun, string, string, string][] = [
    [storiesRun, "s-aamdani-stories", "Why we paused daily stories", "2026-10-14T09:05:00+05:30"],
    [seoRun, "s-aamdani-seo", "Pages losing search clicks", "2026-10-13T18:30:00+05:30"],
    [pendingRun, "s-aamdani-pending", "What's waiting on me", "2026-10-12T08:15:00+05:30"],
    [avsRun, "s-avs-architect", "Not ranking for 'architect in London'", "2026-10-15T10:25:00+05:30"],
  ];
  for (const [spec, sid, title, at] of seeds) {
    const events = compile(spec, graphs[spec.tenant]!, { sessionId: sid, turnId: `t-${sid.slice(2)}` }).map((x) => x.event);
    store(spec.tenant, sid, title, at, events);
  }
}
seed();

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (ms <= 0) return resolve();
    const id = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(id); reject(new DOMException("aborted", "AbortError")); }, { once: true });
  });

async function play<T>(events: { at: number; event: T }[], onEvent: (e: T) => void, opts: PlayOpts) {
  let prev = 0;
  const seek = opts.seekMs ?? 0;
  for (const { at, event } of events) {
    if (at > seek) await sleep((at - Math.max(prev, seek)) / Math.max(0.25, opts.speed()), opts.signal);
    prev = at;
    if (opts.signal?.aborted) return;
    onEvent(event);
  }
}

export interface PlayOpts { speed: () => number; seekMs?: number; signal?: AbortSignal }

const graphOf = (t: string) => graphs[t] ?? graphs.aamdani!;
const today = () => new Date().toISOString();

function agentFindings(tenant: string, agent: AgentId): FindingRecord[] {
  const out: FindingRecord[] = [];
  for (const s of sessions[tenant] ?? []) {
    for (const turn of s.turns) {
      const verdicts = new Map<string, FindingRecord["verdicts"]>();
      for (const e of turn.events) {
        if (e.type === "review") {
          const list = verdicts.get(e.findingId) ?? [];
          list.push({ by: e.agent, verdict: e.verdict, note: e.note });
          verdicts.set(e.findingId, list);
        }
      }
      for (const e of turn.events) {
        if (e.type === "finding" && e.agent === agent) {
          out.push({ id: e.findingId, agent, text: e.text, citations: e.citations, turnId: turn.record.id, question: turn.record.question, at: turn.record.at, verdicts: verdicts.get(e.findingId) ?? [] });
        }
      }
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

const BASE_REQUESTS: Record<string, number> = {
  "chief-of-staff": 46, "coe-lead": 21, "data-analyst": 29, "growth-marketer": 12, "content-strategist": 17,
  "copy-editor": 15, "fact-checker": 24, "tech-lead": 11, "ops-manager": 9, librarian: 26,
};

function statsFor(tenant: string, agent: AgentId): AgentStats {
  const scale = tenant === "aamdani" ? 1 : 0.08;
  const turns = (sessions[tenant] ?? []).flatMap((s) => s.turns);
  const handled = turns.filter((t) => t.record.agents.includes(agent));
  const findings = agentFindings(tenant, agent);
  const reviews = turns.flatMap((t) => t.events).filter((e) => e.type === "review" && e.agent === agent).length;
  const proposals = turns.flatMap((t) => t.events).filter((e) => e.type === "proposal" && e.agent === agent).length;
  const base = Math.round((BASE_REQUESTS[agent] ?? 10) * scale);
  const passed = findings.filter((f) => f.verdicts.every((v) => v.verdict === "ok")).length;
  return {
    requests: base + handled.length,
    findings: Math.round(base * 0.8) + findings.length,
    proposals: Math.round(base * 0.15) + proposals,
    reviewsGiven: Math.round(base * (agent === "fact-checker" || agent === "coe-lead" || agent === "copy-editor" ? 1.4 : 0)) + reviews,
    checksPassed: Math.round(base * 0.75) + passed,
    checksTotal: Math.round(base * 0.8) + findings.length,
    lastActiveAt: handled[0]?.record.at,
  };
}

export const mockApi = {
  async tenants(): Promise<Tenant[]> { return tenants; },

  async overview(t: string): Promise<Overview> {
    const g = graphOf(t);
    const counts: Record<string, number> = {};
    for (const n of g.nodes.values()) counts[n.label] = (counts[n.label] ?? 0) + 1;
    return {
      tenant: tenants.find((x) => x.id === t) ?? tenants[0]!,
      counts, freshness: FRESHNESS[t] ?? [], brief: BRIEF[t] ?? "",
      recommendations: (recommendations[t] ?? []).slice(0, 3),
      approvalsPending: (approvals[t] ?? []).filter((a) => a.status === "pending").length,
    };
  },

  async sessions(t: string): Promise<SessionSummary[]> { return (sessions[t] ?? []).map((s) => s.summary); },

  async session(t: string, id: string): Promise<SessionDetail> {
    const s = (sessions[t] ?? []).find((x) => x.summary.id === id);
    if (!s) throw new Error(`No thread ${id}`);
    return { id, title: s.summary.title, turns: s.turns.map((x) => x.record) };
  },

  async replay(t: string, turnId: string): Promise<AgentEvent[]> {
    for (const s of sessions[t] ?? []) for (const turn of s.turns) if (turn.record.id === turnId) return turn.events;
    throw new Error(`No turn ${turnId}`);
  },

  async search(t: string, q: string): Promise<SearchHit[]> { return searchGraph(graphOf(t), q); },
  async node(t: string, id: string): Promise<NodeDetail | null> { return nodeDetail(graphOf(t), id); },
  async graph(t: string, focus: string, depth = 1): Promise<GraphData> { return neighborhood(graphOf(t), focus, depth); },
  async graphOverview(t: string): Promise<GraphData> { return graphData(graphOf(t)); },

  async agents(t: string): Promise<AgentSummary[]> {
    return AGENTS.map((a) => ({ id: a.id, stats: statsFor(t, a.id), knows: KNOWS[t]?.[a.id]?.length ?? 0 }));
  },

  async agent(t: string, id: AgentId): Promise<AgentDetail> {
    const g = graphOf(t);
    const knows = KNOWS[t]?.[id] ?? [];
    const agentNodeId = `agent:${id}`;
    const def = AGENTS.find((a) => a.id === id);
    const known = knows.map(([nid, w]) => ({ ...refOf(g, nid), weight: w }));
    const ids = new Set(knows.map(([nid]) => nid));
    const edges = [
      ...knows.map(([nid]) => ({ from: agentNodeId, type: "KNOWS_ABOUT", to: nid })),
      ...g.edges.filter((e) => ids.has(e.from) && ids.has(e.to)),
    ];
    return {
      id,
      playbooks: PLAYBOOKS[id] ?? [],
      knowledge: { nodes: [{ id: agentNodeId, label: "Agent", name: def ? `${def.name} · ${def.title}` : id, weight: 1 }, ...known], edges },
      findings: agentFindings(t, id).slice(0, 6),
      stats: statsFor(t, id),
    };
  },

  async recommendations(t: string): Promise<Recommendation[]> { return recommendations[t] ?? []; },
  async approvals(t: string): Promise<Approval[]> { return approvals[t] ?? []; },

  async decide(t: string, id: string, d: ApprovalDecision): Promise<Approval> {
    const a = (approvals[t] ?? []).find((x) => x.id === id);
    if (!a) throw new Error(`No approval ${id}`);
    await sleep(500);
    a.decidedAt = today();
    if (d.decision === "reject") { a.status = "rejected"; a.result = "Rejected by the owner"; }
    else {
      if (d.editedPayload) a.editedPayload = d.editedPayload;
      a.status = "executed";
      a.result =
        a.kind === "github_issue" ? `Opened issue #${++counter} in Ankit-Vohra/allevia` :
        a.kind === "content_draft" ? "Draft saved to the reel pipeline (not published)" :
        a.kind === "pause_ad" ? "Campaign paused (simulated)" : "Posted to #allevia";
    }
    const r = (recommendations[t] ?? []).find((x) => x.approvalId === id);
    if (r) r.status = d.decision === "reject" ? "dismissed" : "approved";
    return a;
  },

  async ask(t: string, body: { question: string; sessionId?: string }, onEvent: (e: AgentEvent) => void, opts: PlayOpts) {
    const spec = pickScript(t, body.question) ?? SCRIPTS[0]!;
    const sessionId = body.sessionId ?? `s-${t}-${++counter}`;
    const turnId = `t-${t}-${++counter}`;
    const g = graphs[spec.tenant] ?? graphOf(t);
    const timed: TimedEvent[] = compile({ ...spec, tenant: t, question: body.question.trim() || spec.question }, g, { sessionId, turnId });
    const seen: AgentEvent[] = [];
    await play(timed, (e) => { seen.push(e); onEvent(e); }, opts);
    if (seen.some((e) => e.type === "final")) {
      const title = body.question.trim().replace(/\?$/, "").slice(0, 60);
      store(t, sessionId, title, today(), seen);
    }
  },

  async onboard(req: OnboardRequest, onEvent: (e: OnboardEvent) => void, opts: PlayOpts) {
    const { tenant, events } = onboardScript(req);
    const nodes: [string, string, string][] = [];
    const edges: [string, string, string][] = [];
    await play(events, (e) => {
      if (e.type === "nodes") {
        for (const n of e.nodes) nodes.push([n.id, n.label, n.name]);
        for (const x of e.edges) edges.push([x.from, x.type, x.to]);
      }
      if (e.type === "done" && !tenants.some((x) => x.id === tenant)) {
        let domain = req.url;
        try { domain = new URL(/^https?:/.test(req.url) ? req.url : `https://${req.url}`).hostname.replace(/^www\./, ""); } catch { /* keep */ }
        tenants.push({ id: tenant, name: req.name.trim() || domain, domain, industry: "Set up from its website", country: req.country, currency: req.currency, locale: req.locale });
        graphs[tenant] = buildGraph(nodes, edges);
      }
      onEvent(e);
    }, opts);
  },
};
