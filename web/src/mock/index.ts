// The mock backend: same functions and shapes as the real API (web/src/api.ts), backed by in-memory data and scripted
// runs. Used with ?mock=1, or automatically when GET /api/health fails.
import type { AgentEvent, AgentId, OnboardEvent } from "@shared/contracts";
import { AGENTS } from "@shared/roster";
import type { CapabilityState, DirectivePreview, LearnedRuleDto, ProgramScorecard } from "@shared/contracts";
import type {
  AgentDetail, AgentStats, AgentSummary, AgentView, Approval, ApprovalDecision, Brief, DecisionResult, FindingRecord, GoalSetup, GraphData,
  LearningFeed, NodeDetail, OnboardRequest, Overview, Recommendation, SearchHit, SessionDetail, SessionSummary, Tenant, TurnRecord, Usage,
} from "../types-ext";
import type { AgentPatch } from "../api";
import type { WeekDto } from "@shared/week";
import { BRIEF, FRESHNESS, GRAPHS, KNOWS, PLAYBOOKS, TENANTS, seedApprovals, seedRecommendations } from "./data";
import { type MockGraph, buildGraph, graphData, mapOf, neighborhood, nodeDetail, refOf, searchGraph } from "./graph-kit";
import type { BrainMapDto } from "../lib/brain-map";
import { directRun, skillsOf, toolsOf } from "./chat";
import { onboardScript } from "./onboard";
import * as p90 from "./program";
import { SCRIPTS, avsRun, pickScript, pendingRun, seoRun, storiesRun } from "./runs";
import { type TimedEvent, compile } from "./script";

interface StoredTurn { record: TurnRecord; events: AgentEvent[] }
interface StoredSession { summary: SessionSummary; turns: StoredTurn[] }

const tenants: Tenant[] = [...TENANTS];
const graphs: Record<string, MockGraph> = { ...GRAPHS };
const sessions: Record<string, StoredSession[]> = {};
const recommendations = seedRecommendations();
const approvals = seedApprovals();
// the drafts the owner edited before approving, and the rules they taught (with their LEARNED_FROM paths in the graph)
approvals.aamdani = [...(approvals.aamdani ?? []), ...p90.editedApprovals()];
for (const [t, list] of Object.entries(approvals)) if (graphs[t]) p90.addLearningToGraph(graphs[t]!, t, list);
const briefs: Record<string, Brief> = {};
let counter = 100;

function store(tenant: string, sessionId: string, title: string, at: string, events: AgentEvent[], from: { agent?: AgentId; door?: "web" | "discord" } = {}) {
  const final = events.find((e): e is Extract<AgentEvent, { type: "final" }> => e.type === "final");
  const session = events.find((e): e is Extract<AgentEvent, { type: "session" }> => e.type === "session");
  if (!final || !session) return;
  const record: TurnRecord = {
    id: final.turnId, question: session.question, answer: final.answer, at, ms: final.ms,
    agents: final.agents, citations: final.citations, checks: final.checks,
    source: from.door ?? "web", ...(from.agent ? { target: from.agent } : {}),
  };
  const list = (sessions[tenant] ??= []);
  let s = list.find((x) => x.summary.id === sessionId);
  if (!s) {
    s = { summary: { id: sessionId, title, startedAt: at, lastAt: at, turns: 0, channel: from.door ?? "web", ...(from.agent ? { agent: from.agent } : {}) }, turns: [] };
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
    [avsRun, "s-avs-architect", "Not ranking for 'architect in Raipur'", "2026-10-14T18:25:00+05:30"],
  ];
  for (const [spec, sid, title, at] of seeds) {
    const events = compile(spec, graphs[spec.tenant]!, { sessionId: sid, turnId: `t-${sid.slice(2)}` }).map((x) => x.event);
    store(spec.tenant, sid, title, at, events);
  }
}
seed();

// Direct chats with one person, and a conversation that began in Discord: so the chat's rail has something in every door.
function seedChat() {
  const direct: Array<[string, AgentId, string, string, string]> = [
    ["aamdani", "content-strategist", "s-aamdani-tara-reels", "What reels should we make this week?", "2026-10-15T10:40:00+05:30"],
    ["aamdani", "data-analyst", "s-aamdani-kabir-signups", "Where do people drop off when they sign up?", "2026-10-14T16:10:00+05:30"],
    ["avs-atelier", "tech-lead", "s-avs-arjun-home", "What is wrong with our home page?", "2026-10-15T09:30:00+05:30"],
  ];
  for (const [tenant, agent, sid, q, at] of direct) {
    const spec = directRun(tenant, agent, q);
    const events = compile(spec, graphs[tenant]!, { sessionId: sid, turnId: `t-${sid.slice(2)}` }).map((x) => x.event);
    store(tenant, sid, q.replace(/\?$/, ""), at, events, { agent });
  }
  // a team conversation the owner started from their phone in Discord
  const discordRun = pendingRun;
  const events = compile(discordRun, graphs.aamdani!, { sessionId: "s-aamdani-discord", turnId: "t-aamdani-discord" }).map((x) => x.event);
  store("aamdani", "s-aamdani-discord", "What's waiting on me", "2026-10-15T08:05:00+05:30", events, { door: "discord" });
}
seedChat();

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
    return { id, title: s.summary.title, ...(s.summary.agent ? { agent: s.summary.agent } : {}), turns: s.turns.map((x) => x.record) };
  },

  async replay(t: string, turnId: string): Promise<AgentEvent[]> {
    for (const s of sessions[t] ?? []) for (const turn of s.turns) if (turn.record.id === turnId) return turn.events;
    throw new Error(`No turn ${turnId}`);
  },

  async search(t: string, q: string): Promise<SearchHit[]> { return searchGraph(graphOf(t), q); },
  async node(t: string, id: string): Promise<NodeDetail | null> { return nodeDetail(graphOf(t), id); },
  async graph(t: string, focus: string, depth = 1): Promise<GraphData> { return neighborhood(graphOf(t), focus, depth); },
  async graphOverview(t: string): Promise<GraphData> { return graphData(graphOf(t)); },
  async brainMap(t: string, limit = 400): Promise<BrainMapDto> { return mapOf(graphOf(t), limit); },

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

  async decide(t: string, id: string, d: ApprovalDecision): Promise<DecisionResult> {
    const a = (approvals[t] ?? []).find((x) => x.id === id);
    if (!a) throw new Error(`No approval ${id}`);
    await sleep(500);
    a.decidedAt = today();
    let learned: DecisionResult["learned"] = [];
    if (d.decision === "reject") { a.status = "rejected"; a.result = "Rejected by the owner"; }
    else {
      const edited = d.editedPayload && (d.editedPayload.title !== a.payload.title || d.editedPayload.body !== a.payload.body) ? d.editedPayload : undefined;
      if (edited) {
        a.editedPayload = edited;
        learned = p90.learnFromEdit(t, a, edited).map((r) => ({ type: "learned" as const, ruleId: r.ruleId, text: r.text, fromApprovalId: a.id }));
        if (graphs[t]) p90.addLearningToGraph(graphs[t]!, t, approvals[t] ?? []);
      }
      a.status = "executed";
      a.result =
        a.kind === "github_issue" ? `Opened issue #${++counter} in Ankit-Vohra/allevia` :
        a.kind === "content_draft" ? "Draft saved to the reel pipeline (not published)" :
        a.kind === "pause_ad" ? "Campaign paused (simulated)" : "Posted to #allevia";
    }
    const r = (recommendations[t] ?? []).find((x) => x.approvalId === id);
    if (r) r.status = d.decision === "reject" ? "dismissed" : "approved";
    return { ...a, learned, action: null };
  },

  // ---- Allevia 90, the ladder, the team and what it learned (./program.ts) ----

  async program(t: string): Promise<ProgramScorecard | null> { return p90.programOf(t); },
  async usage(t: string, month?: string): Promise<Usage> { return p90.usageOf(t, month); },
  /** The demo's week: drafts decided here count as they are approved; the rest are the sample business's numbers. */
  async week(t: string): Promise<WeekDto> {
    const since = Date.now() - 7 * 86_400_000;
    const okd = (approvals[t] ?? []).filter((a) => a.status !== "pending" && a.status !== "rejected" && a.decidedAt && Date.parse(a.decidedAt) >= since).length;
    const base = t === "avs-atelier" ? { approved: 3, sent: 2, practice: 1, filed: 1, learned: 9, answered: 6 } : { approved: 5, sent: 3, practice: 2, filed: 2, learned: 14, answered: 11 };
    return {
      since: new Date(since).toISOString(), days: 7, approved: base.approved + okd,
      sent: { done: base.sent, practice: base.practice }, filed: { done: base.filed, practice: 0 }, learned: base.learned, answered: base.answered,
    };
  },
  async goalSetup(t: string): Promise<GoalSetup[]> { return p90.goalSetupOf(t); },
  async setGoal(t: string, id: string, target?: number): Promise<GoalSetup> { return p90.setGoal(t, id, target); },
  async capabilities(t: string): Promise<CapabilityState[]> { return p90.capabilitiesOf(t); },
  async team(t: string): Promise<AgentView[]> {
    const stats = await mockApi.agents(t);
    return p90.teamOf(t).map((s) => ({ ...stats.find((x) => x.id === s.id)!, ...s, learnedRules: p90.activeRulesFor(t, s.id), tools: toolsOf(s.id), skills: skillsOf(s.id, s.skillsOff) }));
  },
  async setAgent(t: string, id: string, patch: AgentPatch): Promise<AgentView> {
    await sleep(250);
    p90.setAgent(t, id, patch);
    return (await mockApi.team(t)).find((a) => a.id === id)!;
  },
  async previewDirective(t: string, text: string): Promise<DirectivePreview> { await sleep(450); return p90.previewDirective(t, text); },
  async applyDirective(t: string, id: string): Promise<DirectivePreview & { errors?: string[] }> { await sleep(350); return p90.applyDirective(t, id); },
  async learning(t: string): Promise<LearningFeed> { return p90.learningFeed(t); },
  async retireRule(t: string, ruleId: string): Promise<LearnedRuleDto> { await sleep(250); return p90.retireRule(t, ruleId); },
  async brief(t: string): Promise<Brief | null> {
    const name = tenants.find((x) => x.id === t)?.name ?? t;
    return briefs[t] ?? { id: `document:brief-${t}`, title: "Today's note", asOf: today().slice(0, 10), text: p90.briefText(t, name) };
  },
  async runBrief(t: string): Promise<Brief> {
    await sleep(700);
    const name = tenants.find((x) => x.id === t)?.name ?? t;
    return (briefs[t] = { id: `document:brief-${t}`, title: "Today's note", asOf: today().slice(0, 10), date: today().slice(0, 10), text: p90.briefText(t, name) });
  },

  async ask(t: string, body: { question: string; sessionId?: string; target?: AgentId }, onEvent: (e: AgentEvent) => void, opts: PlayOpts) {
    const direct = body.target && body.target !== "chief-of-staff" ? body.target : undefined;
    const spec = direct ? directRun(t, direct, body.question.trim()) : pickScript(t, body.question) ?? SCRIPTS[0]!;
    const sessionId = body.sessionId ?? `s-${t}-${++counter}`;
    const turnId = `t-${t}-${++counter}`;
    const g = graphs[spec.tenant] ?? graphOf(t);
    const timed: TimedEvent[] = compile({ ...spec, tenant: t, question: body.question.trim() || spec.question }, g, { sessionId, turnId });
    const seen: AgentEvent[] = [];
    await play(timed, (e) => { seen.push(e); onEvent(e); }, opts);
    if (seen.some((e) => e.type === "final")) {
      const title = body.question.trim().replace(/\?$/, "").slice(0, 60);
      store(t, sessionId, title, today(), seen, direct ? { agent: direct } : {});
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
        tenants.push({ id: tenant, name: req.name.trim() || domain, domain, industry: "Set up from its website", country: req.country, currency: req.currency, locale: req.locale, timeZone: req.timeZone });
        graphs[tenant] = buildGraph(nodes, edges);
      }
      onEvent(e);
    }, opts);
  },
};
