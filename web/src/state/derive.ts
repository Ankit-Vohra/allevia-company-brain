// Fold a stream of AgentEvents into what the UI shows: per-agent lanes (plan → steps → findings → reviews), the graph
// touched so far, the streamed answer, the path and the checks. Pure, so live runs and replays render identically.
import type { ActionKind, AgentEvent, AgentId, EdgeRef, NodeRef, PlanStep, SourceRef, TurnChecks } from "@shared/contracts";

export type Phase = "planned" | "working" | "done" | "failed";

export interface StepView {
  id: string;
  agent: AgentId;
  name: string;
  args: unknown;
  summary?: string;
  nodes: NodeRef[];
  edges: EdgeRef[];
  sources: SourceRef[];
  done: boolean;
  at: number;            // event index
}

export interface ReviewView { by: AgentId; verdict: "ok" | "fix" | "reject"; note: string; at: number }
export interface FindingView { id: string; agent: AgentId; text: string; citations: string[]; basedOn?: string[]; reviews: ReviewView[]; at: number }

export interface LaneView {
  key: string;           // the agent id, or "<chief>#answer" for the Chief's answering phase
  agent: AgentId;
  task?: string;
  after?: AgentId[];
  phase: Phase;
  status?: string;
  steps: StepView[];
  findings: FindingView[];
  reviewsGiven: (ReviewView & { findingId: string })[];
  handoffsOut: { to: AgentId; note: string; at: number }[];
  ms?: number;
  startAt?: number;
  endAt?: number;
  depth: number;         // stage in the plan DAG (0 = the Chief planning, 99 = the Chief answering)
}

export interface ProposalView { agent: AgentId; recommendationId: string; approvalId: string; title: string; kind: ActionKind }

export interface RunView {
  sessionId?: string;
  turnId?: string;
  tenant?: string;
  question?: string;
  recall?: { brief: string; ids: string[] };
  plan?: { by: AgentId; steps: PlanStep[]; rationale: string };
  lanes: Record<string, LaneView>;
  laneOrder: string[];
  handoffs: { from: AgentId; to: AgentId; note: string; at: number }[];
  findings: Record<string, FindingView>;
  proposals: ProposalView[];
  answer: string;
  answerStarted: boolean;
  path?: { nodes: NodeRef[]; edges: EdgeRef[] };
  final?: { answer: string; citations: string[]; checks: TurnChecks; agents: AgentId[]; ms: number };
  error?: string;
  nodes: Record<string, NodeRef>;
  edges: EdgeRef[];
  sources: Record<string, SourceRef>;
  nodeOrder: string[];
  activeAgents: AgentId[];
  speaker?: AgentId;
  count: number;
}

export const edgeKey = (e: EdgeRef) => `${e.from}|${e.type}|${e.to}`;

function emptyLane(key: string, agent: AgentId): LaneView {
  return { key, agent, phase: "planned", steps: [], findings: [], reviewsGiven: [], handoffsOut: [], depth: 1 };
}

export function deriveRun(events: AgentEvent[]): RunView {
  const v: RunView = {
    lanes: {}, laneOrder: [], handoffs: [], findings: {}, proposals: [], answer: "", answerStarted: false,
    nodes: {}, edges: [], sources: {}, nodeOrder: [], activeAgents: [], count: events.length,
  };
  const edgeSeen = new Set<string>();
  const answerKey = (a: AgentId) => `${a}#answer`;
  const lane = (a: AgentId) => {
    const ans = v.lanes[answerKey(a)];
    if (ans) return ans;
    let l = v.lanes[a];
    if (!l) { l = emptyLane(a, a); v.lanes[a] = l; v.laneOrder.push(a); }
    return l;
  };
  const addNodes = (nodes: NodeRef[], edges: EdgeRef[], sources: SourceRef[] = []) => {
    for (const n of nodes) {
      if (!v.nodes[n.id]) v.nodeOrder.push(n.id);
      v.nodes[n.id] = { ...v.nodes[n.id], ...n };
    }
    for (const e of edges) {
      const k = edgeKey(e);
      if (!edgeSeen.has(k)) { edgeSeen.add(k); v.edges.push(e); }
    }
    for (const s of sources) v.sources[s.id] = s;
  };

  events.forEach((e, i) => {
    switch (e.type) {
      case "session":
        v.sessionId = e.sessionId; v.turnId = e.turnId; v.tenant = e.tenant; v.question = e.question;
        break;
      case "recall":
        v.recall = { brief: e.brief, ids: e.ids };
        break;
      case "plan": {
        v.plan = { by: e.by, steps: e.steps, rationale: e.rationale };
        lane(e.by).depth = 0;
        for (const s of e.steps) {
          const l = lane(s.agent);
          l.task ??= s.task;
          l.after = s.after;
        }
        // depth = longest chain of `after` dependencies, so desks that run in parallel share a stage
        const depthOf = (a: AgentId, seen = new Set<AgentId>()): number => {
          const step = e.steps.find((s) => s.agent === a);
          if (!step?.after?.length || seen.has(a)) return 1;
          seen.add(a);
          return 1 + Math.max(...step.after.map((b) => depthOf(b, seen)));
        };
        for (const s of e.steps) lane(s.agent).depth = depthOf(s.agent);
        break;
      }
      case "agent_start": {
        let l = lane(e.agent);
        // the Chief starts twice: planning, then (after the desks report back) writing the answer, in its own lane
        if (e.agent === v.plan?.by && l.phase === "done" && l.key === e.agent) {
          l = emptyLane(answerKey(e.agent), e.agent);
          l.depth = 99;
          v.lanes[l.key] = l;
          v.laneOrder.push(l.key);
        }
        l.task ??= e.task;
        l.phase = "working";
        l.status = undefined;
        l.startAt ??= i;
        break;
      }
      case "agent_status":
        lane(e.agent).status = e.text;
        break;
      case "tool_call": {
        const l = lane(e.agent);
        l.steps.push({ id: e.id, agent: e.agent, name: e.name, args: e.args, nodes: [], edges: [], sources: [], done: false, at: i });
        l.status = undefined;
        break;
      }
      case "tool_result": {
        const l = lane(e.agent);
        const step = l.steps.find((s) => s.id === e.id) ?? l.steps[l.steps.length - 1];
        if (step) Object.assign(step, { summary: e.summary, nodes: e.nodes, edges: e.edges, sources: e.sources, done: true });
        addNodes(e.nodes, e.edges, e.sources);
        break;
      }
      case "handoff":
        v.handoffs.push({ from: e.from, to: e.to, note: e.note, at: i });
        lane(e.from).handoffsOut.push({ to: e.to, note: e.note, at: i });
        break;
      case "finding": {
        const f: FindingView = { id: e.findingId, agent: e.agent, text: e.text, citations: e.citations, basedOn: e.basedOn, reviews: [], at: i };
        v.findings[e.findingId] = f;
        lane(e.agent).findings.push(f);
        break;
      }
      case "review": {
        const r: ReviewView = { by: e.agent, verdict: e.verdict, note: e.note, at: i };
        v.findings[e.findingId]?.reviews.push(r);
        lane(e.agent).reviewsGiven.push({ ...r, findingId: e.findingId });
        break;
      }
      case "proposal":
        v.proposals.push({ agent: e.agent, recommendationId: e.recommendationId, approvalId: e.approvalId, title: e.title, kind: e.kind });
        break;
      case "agent_done": {
        const l = lane(e.agent);
        l.phase = e.ok ? "done" : "failed";
        l.ms = (l.ms ?? 0) + e.ms;
        l.endAt = i;
        l.status = undefined;
        break;
      }
      case "text":
        v.answer += e.delta;
        v.answerStarted = true;
        v.speaker = e.agent;
        break;
      case "path":
        v.path = { nodes: e.nodes, edges: e.edges };
        addNodes(e.nodes, e.edges);
        break;
      case "final":
        v.final = { answer: e.answer, citations: e.citations, checks: e.checks, agents: e.agents, ms: e.ms };
        if (!v.answer) v.answer = e.answer;
        v.speaker = undefined;
        break;
      case "error":
        v.error = e.message;
        if (e.agent) lane(e.agent).phase = "failed";
        break;
    }
  });
  v.activeAgents = [...new Set(v.laneOrder.map((k) => v.lanes[k]!).filter((l) => l.phase === "working").map((l) => l.agent))];
  return v;
}

/** The lane that currently represents an agent (the Chief's answer lane once it exists). */
export function laneOf(v: RunView, agent: AgentId): LaneView | undefined {
  return v.lanes[`${agent}#answer`] ?? v.lanes[agent];
}

/** Group lanes into plan stages for the work log: the Chief's plan, each DAG depth, then the answer. */
export function stagesOf(v: RunView): { depth: number; lanes: LaneView[] }[] {
  const by = new Map<number, LaneView[]>();
  for (const k of v.laneOrder) {
    const l = v.lanes[k]!;
    const d = k === v.plan?.by ? 0 : l.depth;
    by.set(d, [...(by.get(d) ?? []), l]);
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([depth, lanes]) => ({ depth, lanes }));
}

export function checksOk(c: TurnChecks) {
  return c.citationsValid && c.numbersGrounded && c.simulatedDisclosed && c.freshnessDisclosed;
}
