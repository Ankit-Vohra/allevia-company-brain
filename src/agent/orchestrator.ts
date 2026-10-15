// The agent company's turn (spec §16.2): recall -> the Chief of Staff plans -> department agents work as a DAG
// (independent steps in parallel, `after` steps once their inputs are ready, each handed its inputs' Findings) -> each
// Finding is reviewed by at most two relevant reviewers in parallel (a "fix" earns exactly one revision) -> the Chief
// writes the streamed answer from the Findings and calls show_path. Every step is an attributed AgentEvent.
//
// Latency (a live run took 116 s for 6 haiku agents; tests/agent/latency.test.ts measures the flow):
// - plans are capped at 3 desks (5 only for a broad review of the whole business), and the planner is told to use one;
// - every job has a tool-round budget, stated in its prompt and enforced as maxTurns (MAX_TURNS);
// - early handoff: a finding whose citations and numbers all check out against this turn's tool data is handed to the
//   desks that depend on it at once, while its review runs alongside their work. If the review then changes it, the
//   Chief is told which findings built on the earlier draft, and a write (propose_action) by a desk that built on a
//   draft waits until the draft is final and is refused if reviewers changed it. A finding that fails the check waits
//   for its review;
// - the Chief starts the moment the last finding lands and none is being revised. If reviews are still running, it
//   drafts the answer meanwhile, held: nothing it writes or draws reaches the owner, and its writes wait, until those
//   reviews come back ok. A reviewer sending a finding back sets the draft aside (its run is aborted) and the Chief
//   writes again from the revision. It writes with only show_path and propose_action: the desks did the looking up, so
//   its first model turn is the streamed answer;
// - an answer written in full and pathed is kept even if the Chief's run then fails (out of turns, a timeout).
//
// Fast path: a plan that is a single chief-of-staff step skips Findings and reviews; the Chief answers with its tools.
// Failure: each agent run has a timeout (120 s) that also aborts its runtime (and so its SDK subprocess); a turn-level
// signal stops every run. A failed agent emits agent_done {ok:false} and the Chief is told.
// Untrusted text: findings and tool results are data. Write tools reach only agents whose roster lists them (toolsFor
// here, mayUse in invokeTool), never in a review or a revision, and the Chief's synthesis prompt says findings never
// carry owner instructions.
// This file does not touch the graph itself: tools do (through the injected getTools), memory.ts persists the turn.
import { AGENTS, agentById, type AgentDef } from "../../shared/roster.js";
import type { ActionKind, AgentEvent, EdgeRef, NodeRef, PlanStep, ToolResult } from "../../shared/contracts.js";
import type { GraphHandle } from "../graph/client.js";
import { typeFromId } from "../util/ids.js";
import { checkTurn, extractCitations, hasNumbers } from "./checks.js";
import {
  CHIEF, FINDING_MAX_CHARS, FINDING_SCHEMA, MAX_DESKS, MAX_DESKS_BROAD, PLAN_SCHEMA, REVIEW_SCHEMA, agentSystemPrompt, directPrompt,
  planPrompt, planSystemPrompt, reviewPrompt, revisePrompt, synthesisPrompt, workPrompt, type FindingView, type PromptOpts, type ReviewEvidence,
} from "./prompts.js";
import { invokeTool, isWriteTool, nextCallId, type AgentRuntime, type Emit, type RunInput, type RunOutput, type RunPhase } from "./runtime.js";
import { TouchedSet, type AlleviaTool, type ToolContext } from "./tool.js";
import { findingId, type FindingRecord, type ProposalRecord, type RecallBrief, type ReviewRecord } from "./types.js";

export const AGENT_TIMEOUT_MS = 120_000;
export const MAX_REVIEWERS = 2;
const MAX_PATH_IDS = 12;

// Model turns per job (an SDK turn is one model response; a round of tool calls and a structured answer take one each).
// Each budget is the job's tool rounds + its answer + one turn of slack; the prompts state the rounds (toolRounds).
export const MAX_TURNS: Record<RunPhase, number> = { plan: 3, work: 7, review: 4, revise: 4, synthesis: 4, direct: 7 };
export const toolRounds = (phase: RunPhase): number => Math.max(0, MAX_TURNS[phase] - 2);

// What the Chief may use while writing the answer from the desks' findings.
const SYNTHESIS_TOOLS: ReadonlySet<string> = new Set(["show_path", "propose_action"]);

export interface TurnInput {
  tenant: string;
  question: string;
  sessionId: string;
  turnId: string;
  asker: string;
  recall: RecallBrief;
}

export interface TurnDeps {
  runtime: AgentRuntime;
  getTools: (names: string[]) => AlleviaTool[];
  graph: GraphHandle;
  now: number;                              // epoch ms, fixed for the turn
  model?: string;                           // overrides every agent's roster tier (e.g. "haiku")
  agentTimeoutMs?: number;
  embedQuery?: ToolContext["embedQuery"];
  readOnly?: boolean;
  signal?: AbortSignal;                     // stops every agent run of the turn (a client went away, Ctrl-C)
  timeZone?: string;                        // the tenant's IANA zone for "today" in prompts
  draftWhileReviewing?: boolean;            // default true: the Chief drafts (held) while the last reviews finish
}

export interface Plan { steps: PlanStep[]; rationale: string; chiefTask?: string }

export interface TurnOutcome {
  ok: boolean;                              // false when the Chief could not write the answer (a fallback was used)
  answer: string;
  plan: Plan;
  fastPath: boolean;
  findings: FindingRecord[];
  reviews: ReviewRecord[];
  proposals: ProposalRecord[];
  path?: { nodes: NodeRef[]; edges: EdgeRef[] };
  agents: string[];                         // every agent that ran, in order of first involvement
  failed: string[];                         // agents whose work failed
  touched: TouchedSet;
}

// ---------- pure helpers (exported for tests) ----------

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()) : []);
const unique = <T>(xs: T[]): T[] => [...new Set(xs)];
const nameOf = (id: string): string => agentById(id)?.name ?? id;

export function tryParseJson(text: string): unknown {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return undefined;
  try { return JSON.parse(text.slice(a, b + 1)); } catch { return undefined; }
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Does a task text refer to a desk: its id or title (any case), or its person name (capitalised)?
export function mentionsDesk(task: string, agentId: string): boolean {
  const a = agentById(agentId);
  if (!a) return false;
  const words = (alts: string[], flags: string) => new RegExp(`(?<![\\p{L}\\p{N}-])(?:${alts.map(escapeRe).join("|")})(?![\\p{L}\\p{N}-])`, flags);
  return words([a.id, a.id.replace(/-/g, " "), a.title], "iu").test(task) || words([a.name], "u").test(task);
}

// A broad review of the whole business may use up to MAX_DESKS_BROAD desks; anything else, MAX_DESKS.
const BROAD = new RegExp([
  String.raw`\b(?:doing|going|performing) overall\b`, String.raw`\boverall (?:picture|health|performance|status|summary)\b`,
  String.raw`\bhow(?:'s| is| are) everything\b`, String.raw`\bacross the (?:business|company)\b`,
  String.raw`\ball (?:departments|desks|channels|areas)\b`, String.raw`\bwhole (?:business|company)\b`,
  String.raw`\bfull (?:review|report|audit|picture|brief)\b`, String.raw`\b(?:weekly|monthly|quarterly) (?:review|report|brief|summary)\b`,
  String.raw`\bmorning brief\b`, String.raw`\bstate of the (?:business|company)\b`,
  String.raw`\bhow (?:is|are) (?:the |my |our )?(?:business|company|things) (?:doing|going)\b`,
].join("|"), "i");
export const isBroadQuestion = (question: string): boolean => BROAD.test(question);
export const deskCap = (question: string): number => (isBroadQuestion(question) ? MAX_DESKS_BROAD : MAX_DESKS);

// Validates the Chief's plan: unknown agents dropped, one step per agent (tasks merged), at most deskCap(question)
// steps (3, or 5 for a broad review; the first ones listed are kept), `after` limited to planned agents (plus desks a
// task names), topologically ordered (a cycle is broken by dropping the stuck step's unmet deps). The Chief alongside
// other desks becomes a note for synthesis. Nothing usable -> a single chief-of-staff step.
export function normalisePlan(raw: unknown, question: string): Plan {
  const r = (raw && typeof raw === "object" ? raw : {}) as { steps?: unknown; rationale?: unknown };
  const merged = new Map<string, { agent: string; task: string; after: string[] }>();
  for (const s of Array.isArray(r.steps) ? r.steps : []) {
    if (!s || typeof s !== "object") continue;
    const o = s as Record<string, unknown>;
    const agent = typeof o.agent === "string" ? o.agent.trim() : "";
    if (!agentById(agent)) continue;
    const task = typeof o.task === "string" ? o.task.trim() : "";
    const prev = merged.get(agent);
    if (prev) {
      if (task && !prev.task.includes(task)) prev.task = prev.task ? `${prev.task}; ${task}` : task;
      prev.after = unique([...prev.after, ...strings(o.after)]);
    } else merged.set(agent, { agent, task, after: strings(o.after) });
  }
  let steps = [...merged.values()];
  let chiefTask: string | undefined;
  if (steps.length > 1 && merged.has(CHIEF)) {
    chiefTask = merged.get(CHIEF)!.task || undefined;
    steps = steps.filter((s) => s.agent !== CHIEF);
  }
  steps = steps.slice(0, deskCap(question));
  const planned = new Set(steps.map((s) => s.agent));
  for (const s of steps) {
    // A task that names another planned desk ("using the data-analyst's breakdown", "after Kabir's numbers") needs its
    // finding, even when the model forgot to say so in `after`.
    for (const other of steps) if (other.agent !== s.agent && mentionsDesk(s.task, other.agent)) s.after.push(other.agent);
    s.after = unique(s.after.filter((a) => a !== s.agent && planned.has(a)));
    if (!s.task) s.task = question.trim();
  }
  const ordered: typeof steps = [];
  const done = new Set<string>();
  let pending = steps;
  while (pending.length) {
    const ready = pending.filter((s) => s.after.every((a) => done.has(a)));
    if (!ready.length) { pending[0]!.after = pending[0]!.after.filter((a) => done.has(a)); continue; }
    for (const s of ready) { ordered.push(s); done.add(s.agent); }
    pending = pending.filter((s) => !done.has(s.agent));
  }
  const rationale = typeof r.rationale === "string" ? r.rationale.trim() : "";
  if (!ordered.length) return { steps: [{ agent: CHIEF, task: question.trim() }], rationale: rationale || "Answering directly." };
  return {
    steps: ordered.map((s) => (s.after.length ? { agent: s.agent, task: s.task, after: s.after } : { agent: s.agent, task: s.task })),
    rationale, ...(chiefTask ? { chiefTask } : {}),
  };
}

// Reviewers whose roster `reviews` covers the producer and who are relevant to this finding: the copy editor only for
// content; the fact checker for content and for marketing/analytics findings with numbers; the CoE lead only when the
// finding has numbers. At most MAX_REVIEWERS, in roster order.
export function reviewersFor(producerId: string, text: string): AgentDef[] {
  const numbers = hasNumbers(text);
  return AGENTS.filter((r) => r.id !== producerId && r.reviews?.includes(producerId) && relevantReviewer(r.id, producerId, numbers)).slice(0, MAX_REVIEWERS);
}

// The tools an agent gets for a job: its roster tools (whatever the registry returns beyond them is dropped), without
// write tools when it reviews or revises, and only show_path/propose_action when the Chief writes from findings.
export function toolsFor(agent: AgentDef, phase: RunPhase, getTools: (names: string[]) => AlleviaTool[], opts: { lean?: boolean } = {}): AlleviaTool[] {
  const noWrites = phase === "plan" || phase === "review" || phase === "revise";
  const names = agent.tools.filter((n) => !(phase === "synthesis" && opts.lean && !SYNTHESIS_TOOLS.has(n)));
  const allowed = new Set(names);
  return getTools(names).filter((t) => allowed.has(t.name) && !(noWrites && isWriteTool(t)));
}

// The same tools, but each write tool first waits for `until` (which may refuse by throwing; the model then gets the
// error as the tool's result).
function gateWrites(tools: AlleviaTool[], until: () => Promise<void>): AlleviaTool[] {
  return tools.map((t) => (isWriteTool(t) ? { ...t, run: async (args, ctx) => { await until(); return t.run(args, ctx); } } : t));
}

// Holds a run's events, and what they would commit, until release. The Chief's draft written while reviews finish
// goes through one: if it is set aside, nothing it held is shown.
export class Hold {
  private buffered: AgentEvent[] = [];
  private jobs: Array<() => void> = [];
  private waiters: Array<() => void> = [];
  private isOpen = false;

  constructor(private out: Emit) {}

  get open(): boolean { return this.isOpen; }

  readonly emit: Emit = (e) => { if (this.isOpen) this.out(e); else this.buffered.push(e); };

  later(job: () => void): void { if (this.isOpen) job(); else this.jobs.push(job); }

  release(): void {
    if (this.isOpen) return;
    this.isOpen = true;
    for (const e of this.buffered.splice(0)) this.out(e);
    for (const job of this.jobs.splice(0)) job();
    for (const w of this.waiters.splice(0)) w();
  }

  // Resolves on release; rejects if `signal` aborts first.
  opened(signal?: AbortSignal): Promise<void> {
    if (this.isOpen) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const setAside = () => reject(new Error("the draft was set aside"));
      if (signal?.aborted) return setAside();
      signal?.addEventListener("abort", setAside, { once: true });
      this.waiters.push(() => { signal?.removeEventListener("abort", setAside); resolve(); });
    });
  }
}

function relevantReviewer(reviewer: string, producer: string, numbers: boolean): boolean {
  switch (reviewer) {
    case "copy-editor": return producer === "content-strategist";
    case "fact-checker": return producer === "content-strategist" || numbers;
    case "coe-lead": return numbers;
    default: return true;
  }
}

const ACTION_KINDS: ActionKind[] = ["github_issue", "content_draft", "pause_ad", "discord_post"];

// propose_action's result -> a proposal event. Reads ids from data (flat or nested) or from the returned nodes.
export function toProposal(agent: string, args: unknown, r: ToolResult): ProposalRecord | undefined {
  const d = (r.data && typeof r.data === "object" ? r.data : {}) as Record<string, unknown>;
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const nested = (k: string): Record<string, unknown> => (d[k] && typeof d[k] === "object" ? d[k] as Record<string, unknown> : {});
  const byLabel = (label: string) => r.nodes.find((n) => n.label === label);
  const rec = str(d.recommendationId) ?? str(nested("recommendation").id) ?? byLabel("Recommendation")?.id;
  const appr = str(d.approvalId) ?? str(nested("approval").id) ?? byLabel("Approval")?.id;
  if (!rec || !appr) return undefined;
  const kindRaw = str(d.kind) ?? str(a.kind) ?? str(nested("recommendation").kind);
  const kind = ACTION_KINDS.find((k) => k === kindRaw) ?? "content_draft";
  const title = str(d.title) ?? str(nested("recommendation").title) ?? str(a.title) ?? byLabel("Recommendation")?.name ?? "Proposal";
  return { agent, recommendationId: rec, approvalId: appr, title, kind };
}

// The key of show_path's id list in its input shape (zod 4: unwrap optional/default/nullable to find the array).
export function arrayArgKey(shape: Record<string, unknown>): string | undefined {
  const isArray = (s: unknown): boolean => {
    let cur = s as { def?: { type?: string; innerType?: unknown } } | undefined;
    for (let i = 0; i < 5 && cur?.def; i++) {
      if (cur.def.type === "array") return true;
      cur = cur.def.innerType as typeof cur;
    }
    return false;
  };
  const keys = Object.keys(shape).filter((k) => isArray(shape[k]));
  return keys.find((k) => k === "ids") ?? keys[0];
}

// The Chief's streamed answer. What the owner saw stream IS the answer: text deltas are forwarded and kept. Once an
// answer has been written and show_path is called, anything more (a model re-writing its answer after the tool call)
// is dropped from both the stream and the answer. If nothing streamed, the run's final text is sent once.
const MIN_ANSWER_CHARS = 80;

export class AnswerStream {
  private parts: string[] = [];
  private sealed = false;

  constructor(private out: Emit) {}

  readonly emit: Emit = (e) => {
    if (e.type === "tool_call" && e.agent === CHIEF && e.name === "show_path" && this.parts.join("").trim().length >= MIN_ANSWER_CHARS) {
      this.sealed = true;
    }
    if (e.type === "text" && e.agent === CHIEF) {
      if (this.sealed) return;
      this.parts.push(e.delta);
    }
    this.out(e);
  };

  // The answer, if it was written in full and its path drawn (show_path called after it).
  sealedAnswer(): string | undefined { return this.sealed ? this.parts.join("").trim() || undefined : undefined; }

  finish(finalText: string): string {
    const streamed = this.parts.join("").trim();
    if (streamed) return streamed;
    const text = finalText.trim();
    if (text) this.out({ type: "text", agent: CHIEF, delta: text });
    return text;
  }
}

// ---------- the turn ----------

interface RunOpts {
  phase: RunPhase;
  system: string;
  prompt: string;
  tools: AlleviaTool[];
  outputSchema?: object;
  streamText?: boolean;
  maxTurns: number;
  abort?: AbortSignal;                      // sets this run aside (the Chief's draft, when a review sends a finding back)
  onToolResult?: RunInput["onToolResult"];  // default: path/proposal events straight to the turn
}

interface WorkGates { ready: Promise<void>; final: Promise<void> }

class Turn {
  readonly agents: string[] = [];
  readonly failed: string[] = [];
  readonly findings = new Map<string, FindingRecord>(); // by agent
  private readonly settled = new Set<string>();          // finding ids whose review (and revision) is done
  private readonly sentBack = new Set<string>();         // finding ids a reviewer sent back (fix/reject), until settled
  private readonly drafts = new Map<string, string[]>(); // agent -> finding ids it was handed as drafts
  private readonly gates = new Map<string, WorkGates>(); // agent -> its step's gates
  private readonly listeners = new Set<() => void>();    // told when a finding is sent back or settles
  readonly reviews: ReviewRecord[] = [];
  readonly proposals: ProposalRecord[] = [];
  path?: { nodes: NodeRef[]; edges: EdgeRef[] };
  readonly touched = new TouchedSet();

  constructor(readonly input: TurnInput, readonly deps: TurnDeps, readonly emit: Emit) {}

  private involve(agentId: string): void {
    if (!this.agents.includes(agentId)) this.agents.push(agentId);
  }

  private changed(): void { for (const l of [...this.listeners]) l(); }

  private nextChange(): Promise<void> {
    return new Promise((resolve) => {
      const once = () => { this.listeners.delete(once); resolve(); };
      this.listeners.add(once);
    });
  }

  private planFindings(plan: Plan): FindingRecord[] {
    return plan.steps.map((s) => this.findings.get(s.agent)).filter((f): f is FindingRecord => !!f);
  }

  private ctx(agentId: string): ToolContext {
    const { graph, now, embedQuery, readOnly } = this.deps;
    return {
      graph, tenant: this.input.tenant, turnId: this.input.turnId, agentId, asker: this.input.asker, touched: this.touched, now,
      ...(embedQuery ? { embedQuery } : {}), ...(readOnly !== undefined ? { readOnly } : {}),
    };
  }

  private model(agent: AgentDef): string { return this.deps.model ?? agent.model; }

  private tools(agent: AgentDef, phase: RunPhase, lean = false): AlleviaTool[] { return toolsFor(agent, phase, this.deps.getTools, { lean }); }

  private get promptOpts(): PromptOpts {
    return { now: this.deps.now, tenant: this.input.tenant, ...(this.deps.timeZone ? { timeZone: this.deps.timeZone } : {}) };
  }

  private system(agent: AgentDef, tools: AlleviaTool[]): string {
    return agentSystemPrompt(agent, tools, this.promptOpts);
  }

  // show_path and propose_action results become path/proposal events. Through a Hold, the events wait in it and what
  // they set on the turn (its path, its proposals) happens on release.
  private toolResults(emit: Emit, hold?: Hold): NonNullable<RunInput["onToolResult"]> {
    const commit = (job: () => void) => (hold ? hold.later(job) : job());
    return ({ agent, name, args, result }) => {
      if (name === "show_path") {
        emit({ type: "path", nodes: result.nodes, edges: result.edges });
        commit(() => { this.path = { nodes: result.nodes, edges: result.edges }; });
      } else if (name === "propose_action") {
        const p = toProposal(agent, args, result);
        if (p) {
          emit({ type: "proposal", ...p });
          commit(() => { this.proposals.push(p); });
        }
      }
    };
  }

  private runInput(agent: AgentDef, o: RunOpts, signal?: AbortSignal): RunInput {
    return {
      agentId: agent.id, model: this.model(agent), system: o.system, prompt: o.prompt, tools: o.tools, ctx: this.ctx(agent.id),
      maxTurns: o.maxTurns, phase: o.phase, onToolResult: o.onToolResult ?? this.toolResults(this.emit),
      ...(o.outputSchema ? { outputSchema: o.outputSchema } : {}), ...(o.streamText ? { streamText: true } : {}), ...(signal ? { signal } : {}),
    };
  }

  // One agent run with a timeout. The timeout, the turn's signal and the run's own `abort` all abort the runtime (which
  // closes the SDK subprocess), and the run stops waiting at once.
  private async runAgent(agent: AgentDef, o: RunOpts, emit: Emit = this.emit): Promise<RunOutput> {
    this.involve(agent.id);
    const ms = this.deps.agentTimeoutMs ?? AGENT_TIMEOUT_MS;
    const ac = new AbortController();
    const cleanup: Array<() => void> = [];
    const stop = new Promise<never>((_, reject) => {
      const fail = (why: string) => {
        if (ac.signal.aborted) return;
        const err = new Error(why);
        ac.abort(err);
        reject(err);
      };
      const timer = setTimeout(() => fail(`timed out after ${Math.round(ms / 1000)}s`), ms);
      cleanup.push(() => clearTimeout(timer));
      const stoppers: Array<[AbortSignal | undefined, string]> = [[this.deps.signal, "the turn was stopped"], [o.abort, "set aside"]];
      for (const [signal, why] of stoppers) {
        if (!signal) continue;
        if (signal.aborted) { fail(why); continue; }
        const onAbort = () => fail(why);
        signal.addEventListener("abort", onAbort, { once: true });
        cleanup.push(() => signal.removeEventListener("abort", onAbort));
      }
    });
    stop.catch(() => {});
    try {
      if (ac.signal.aborted) return await stop; // never start a run that is already stopped
      const run = this.deps.runtime.run(this.runInput(agent, o, ac.signal), emit);
      run.catch(() => {}); // a run that loses the race may reject later
      return await Promise.race([run, stop]);
    } finally {
      for (const c of cleanup) c();
    }
  }

  // An agent run bracketed by agent_start/agent_done. Returns undefined when it failed (and says why).
  private async step<T>(agent: AgentDef, task: string, work: () => Promise<T>): Promise<T | undefined> {
    this.involve(agent.id);
    this.emit({ type: "agent_start", agent: agent.id, task });
    const t0 = Date.now();
    try {
      const v = await work();
      this.emit({ type: "agent_done", agent: agent.id, ms: Date.now() - t0, ok: true });
      return v;
    } catch (e) {
      this.emit({ type: "agent_status", agent: agent.id, text: clip(`Couldn't finish: ${e instanceof Error ? e.message : String(e)}`, 160) });
      this.emit({ type: "agent_done", agent: agent.id, ms: Date.now() - t0, ok: false });
      return undefined;
    }
  }

  // ----- plan -----

  async plan(): Promise<Plan> {
    const chief = agentById(CHIEF)!;
    const out = await this.step(chief, "Planning who does what", () => this.runAgent(chief, {
      phase: "plan", system: planSystemPrompt(this.promptOpts),
      prompt: planPrompt({ question: this.input.question, recall: this.input.recall.text }), tools: [], outputSchema: PLAN_SCHEMA, maxTurns: MAX_TURNS.plan,
    }));
    const plan = normalisePlan(out ? out.structured ?? tryParseJson(out.text) : undefined, this.input.question);
    if (!out) plan.rationale = "Planning didn't finish, so I'm answering directly.";
    this.emit({ type: "plan", by: CHIEF, steps: plan.steps, rationale: plan.rationale });
    return plan;
  }

  // ----- work (DAG) -----

  // Each step has a `ready` gate (its finding may be handed on) and a `final` one (reviewed and revised). Dependents wait
  // on `ready`; the answer (see whenToWrite) on every `ready`, then on `final` or a moment to draft.
  work(steps: PlanStep[]): WorkGates {
    for (const s of steps) { // topologically ordered by normalisePlan
      const deps = (s.after ?? []).map((a) => this.gates.get(a)?.ready).filter((p): p is Promise<void> => !!p);
      let release!: () => void;
      const ready = new Promise<void>((r) => { release = r; });
      const final = Promise.all(deps).then(() => this.runStep(s, release)).finally(() => { release(); this.changed(); });
      this.gates.set(s.agent, { ready, final });
    }
    const all = [...this.gates.values()];
    return { ready: Promise.all(all.map((g) => g.ready)).then(() => {}), final: Promise.all(all.map((g) => g.final)).then(() => {}) };
  }

  // A write by a desk that built on drafts: wait until those findings are final; refuse if reviewers changed them.
  private async draftsFinal(drafts: FindingRecord[]): Promise<void> {
    await Promise.all(drafts.map((f) => this.gates.get(f.agent)?.final));
    const changed = drafts.filter((f) => f.revised || f.rejected);
    if (changed.length) {
      throw new Error(`${changed.map((f) => `${nameOf(f.agent)}'s finding`).join(" and ")} changed in review after you were handed it, so put the proposal in your finding instead`);
    }
  }

  // May this finding go to the desks that need it before its review ends? Only when it cites something and every cited
  // id and number checks out against this turn's tool data: what a review can still change then is wording and
  // interpretation, and the Chief is told if it does.
  private handOffEarly(f: FindingRecord): boolean {
    if (!f.citations.length) return false;
    const c = checkTurn(f.text, this.touched, { now: this.deps.now, question: this.input.question });
    return c.citationsValid && c.numbersGrounded;
  }

  private toFinding(out: RunOutput, base: { id: string; agent: string; task: string; depIds: string[] }): FindingRecord {
    const s = (out.structured ?? tryParseJson(out.text)) as Record<string, unknown> | undefined;
    const text = clip((typeof s?.text === "string" ? s.text : out.text).trim(), FINDING_MAX_CHARS);
    if (!text) throw new Error("returned an empty finding");
    const known = new Set([...this.findings.values()].map((f) => f.id));
    return {
      id: base.id, agent: base.agent, task: base.task, text,
      citations: unique([...extractCitations(text), ...strings(s?.citations).filter((id) => this.touched.has(id))]),
      basedOn: unique([...base.depIds, ...strings(s?.basedOn).filter((id) => known.has(id) && id !== base.id)]),
      proposals: strings(s?.proposals).slice(0, 5),
      revised: false, rejected: false,
    };
  }

  private emitFinding(f: FindingRecord): void {
    this.emit({ type: "finding", agent: f.agent, findingId: f.id, text: f.text, citations: f.citations, ...(f.basedOn.length ? { basedOn: f.basedOn } : {}) });
  }

  private async runStep(s: PlanStep, release: () => void): Promise<void> {
    const agent = agentById(s.agent)!;
    const inputs = (s.after ?? []).map((a) => this.findings.get(a)).filter((f): f is FindingRecord => !!f);
    const failedDeps = (s.after ?? []).filter((a) => !this.findings.has(a));
    const drafts = inputs.filter((f) => !this.settled.has(f.id));
    if (drafts.length) this.drafts.set(agent.id, drafts.map((f) => f.id));
    for (const f of inputs) {
      const draft = this.settled.has(f.id) ? "" : " (draft, review running)";
      this.emit({ type: "handoff", from: f.agent, to: agent.id, note: clip(`${nameOf(f.agent)}'s finding${draft}: ${f.text.replace(/\s+/g, " ")}`, 120) });
    }
    const finding = await this.step(agent, s.task, async () => {
      const own = this.tools(agent, "work");
      const tools = drafts.length ? gateWrites(own, () => this.draftsFinal(drafts)) : own;
      const out = await this.runAgent(agent, {
        phase: "work", system: this.system(agent, tools), tools, outputSchema: FINDING_SCHEMA, maxTurns: MAX_TURNS.work,
        prompt: workPrompt({ question: this.input.question, task: s.task, recall: this.input.recall.text, inputs: inputs.map(this.view), failedDeps, toolRounds: toolRounds("work") }),
      });
      const f = this.toFinding(out, { id: findingId(this.input.turnId, agent.id), agent: agent.id, task: s.task, depIds: inputs.map((x) => x.id) });
      this.findings.set(agent.id, f);
      this.emitFinding(f);
      return f;
    });
    if (!finding) { this.failed.push(agent.id); return; }
    // Dependents start now and the review runs alongside them (a finding nobody reviews is final at once anyway).
    if (reviewersFor(agent.id, finding.text).length && this.handOffEarly(finding)) release();
    await this.review(finding, agent);
    this.settled.add(finding.id);
    this.sentBack.delete(finding.id);
    this.changed();
  }

  // ----- review (+ one revision) -----

  // Rejected only when every reviewer that answered rejects; any other non-ok verdict (a fix, or a reject the others
  // disagree with) earns exactly one revision that addresses all the notes.
  private async review(f: FindingRecord, producer: AgentDef): Promise<void> {
    const reviewers = reviewersFor(producer.id, f.text);
    if (!reviewers.length) return;
    const got = (await Promise.all(reviewers.map((r) => this.runReview(r, f, producer)))).filter((v): v is ReviewRecord => !!v);
    this.reviews.push(...got);
    if (got.length && got.every((v) => v.verdict === "reject")) { f.rejected = true; return; }
    const notes = got.filter((v) => v.verdict !== "ok");
    if (notes.length) await this.revise(f, producer, notes);
  }

  // The deterministic check of a finding against this turn's tool results, as one line for reviewers and the Chief.
  private autoCheck(text: string): string {
    const c = checkTurn(text, this.touched, { now: this.deps.now, question: this.input.question });
    return [
      c.citationsValid ? "every cited id was returned by a tool this turn" : `cited but returned by no tool: ${c.invalidCitations.join(", ")}`,
      c.numbersGrounded ? "every number appears in this turn's tool data" : `numbers not found in any tool data: ${c.ungroundedNumbers.join(", ")}`,
    ].join("; ");
  }

  private evidence(f: FindingRecord): ReviewEvidence {
    const byId = new Map(this.touched.nodes().map((n) => [n.id, n] as const));
    for (const s of this.touched.sources()) if (!byId.has(s.id)) byId.set(s.id, { id: s.id, label: "Source", name: s.title, ...(s.asOf ? { asOf: s.asOf } : {}) });
    const citedNodes = f.citations.map((id) => byId.get(id)).filter((n): n is NodeRef => !!n).slice(0, 20)
      .map((n) => ({ id: n.id, label: n.label, name: n.name, ...(n.asOf ? { asOf: n.asOf } : {}) }));
    return { citedNodes, autoCheck: this.autoCheck(f.text) };
  }

  private async runReview(reviewer: AgentDef, f: FindingRecord, producer: AgentDef): Promise<ReviewRecord | undefined> {
    return this.step(reviewer, `Reviewing ${producer.name}'s finding`, async () => {
      const tools = this.tools(reviewer, "review");
      const out = await this.runAgent(reviewer, {
        phase: "review", system: this.system(reviewer, tools), tools, outputSchema: REVIEW_SCHEMA, maxTurns: MAX_TURNS.review,
        prompt: reviewPrompt({ question: this.input.question, reviewer, finding: this.view(f), evidence: this.evidence(f), toolRounds: toolRounds("review") }),
      });
      const s = (out.structured ?? tryParseJson(out.text)) as Record<string, unknown> | undefined;
      const verdict = s?.verdict === "fix" || s?.verdict === "reject" ? s.verdict : "ok";
      const note = clip(typeof s?.note === "string" ? s.note.trim() : out.text.trim(), 400);
      const r: ReviewRecord = { reviewer: reviewer.id, findingId: f.id, verdict, note };
      this.emit({ type: "review", agent: reviewer.id, findingId: f.id, verdict, note });
      if (verdict !== "ok") { this.sentBack.add(f.id); this.changed(); } // a draft of the answer built on it is now stale
      return r;
    });
  }

  private async revise(f: FindingRecord, producer: AgentDef, notes: ReviewRecord[]): Promise<void> {
    await this.step(producer, "Revising after review", async () => {
      const tools = this.tools(producer, "revise");
      const out = await this.runAgent(producer, {
        phase: "revise", system: this.system(producer, tools), tools, outputSchema: FINDING_SCHEMA, maxTurns: MAX_TURNS.revise,
        prompt: revisePrompt({ question: this.input.question, task: f.task, finding: this.view(f), notes: notes.map((n) => ({ reviewer: n.reviewer, verdict: n.verdict, note: n.note })), toolRounds: toolRounds("revise") }),
      });
      const next = this.toFinding(out, { id: f.id, agent: f.agent, task: f.task, depIds: f.basedOn });
      Object.assign(f, { text: next.text, citations: next.citations, basedOn: next.basedOn, proposals: next.proposals.length ? next.proposals : f.proposals, revised: true });
      this.emitFinding(f);
    });
  }

  private readonly view = (f: FindingRecord): FindingView => {
    const caveat = this.draftCaveat(f.agent);
    return {
      id: f.id, agent: f.agent, text: f.text, citations: f.citations, proposals: f.proposals, rejected: f.rejected,
      reviews: this.reviews.filter((r) => r.findingId === f.id).map((r) => ({ reviewer: r.reviewer, verdict: r.verdict, note: r.note })),
      autoCheck: this.autoCheck(f.text),
      ...(this.settled.has(f.id) ? {} : { draft: true }), ...(caveat ? { caveat } : {}),
    };
  };

  // A desk that was handed a draft which reviewers then revised or rejected: say so, so the Chief checks what it took.
  private draftCaveat(agentId: string): string | undefined {
    const changed = (this.drafts.get(agentId) ?? [])
      .map((id) => [...this.findings.values()].find((x) => x.id === id))
      .filter((x): x is FindingRecord => !!x && (x.revised || x.rejected));
    if (!changed.length) return undefined;
    return `it built on an earlier draft of ${changed.map((x) => `${nameOf(x.agent)}'s finding [${x.id}], which reviewers then ${x.rejected ? "rejected" : "revised"}`).join("; and of ")}. Check what it took from it against the final version above.`;
  }

  // ----- answer -----

  async answer(plan: Plan, fast: boolean, work?: WorkGates): Promise<{ text: string; ok: boolean }> {
    const chief = agentById(CHIEF)!;
    const open = work ? await this.whenToWrite(plan, work) : [];
    let failure = "";
    const text = await this.step(chief, fast ? plan.steps[0]!.task : "Writing the answer", async () => {
      try {
        if (open.length) {
          const drafted = await this.draftWhileReviewing(chief, plan, open, work!.final);
          if (drafted !== undefined) return drafted;
        }
        await work?.final;
        return await this.writeAnswer(chief, plan, fast);
      } catch (e) {
        failure = e instanceof Error ? e.message : String(e);
        throw e;
      }
    });
    if (text) {
      if (!this.path) await this.fallbackPath(chief, text);
      return { text, ok: true };
    }
    // The Chief failed: answer with what the desks found, so the owner isn't left with nothing.
    const findings = this.planFindings(plan);
    this.emit({ type: "error", agent: CHIEF, message: `The Chief of Staff could not write the answer${failure ? `: ${failure}` : ""}.` });
    const fallback = findings.length
      ? `I couldn't finish writing the full answer. Here is what the team found:\n\n${findings.map((f) => `**${nameOf(f.agent)}:** ${f.text}`).join("\n\n")}`
      : "I couldn't answer this one just now. Please ask again in a moment.";
    this.emit({ type: "text", agent: CHIEF, delta: fallback });
    return { text: fallback, ok: false };
  }

  // When the Chief starts: once every finding has landed and none is being revised. Returns the findings whose reviews
  // are still running then (the Chief drafts while they finish), or [] once every finding is final.
  private async whenToWrite(plan: Plan, work: WorkGates): Promise<FindingRecord[]> {
    await work.ready;
    for (;;) {
      const open = this.planFindings(plan).filter((f) => !this.settled.has(f.id));
      if (!open.length) { await work.final; return []; }
      if (this.deps.draftWhileReviewing !== false && open.every((f) => !this.sentBack.has(f.id))) return open;
      await this.nextChange();
    }
  }

  // The Chief drafts the answer while `open`'s reviews run. The draft is held; if they all come back ok it is released
  // (what streamed so far, then the rest live) and is the answer. If a reviewer sends one back, the draft is set aside at
  // once (its run aborted, nothing it wrote shown) and undefined tells the caller to write again from the final findings;
  // likewise if the draft failed while held.
  private async draftWhileReviewing(chief: AgentDef, plan: Plan, open: FindingRecord[], final: Promise<void>): Promise<string | undefined> {
    const ids = new Set(open.map((f) => f.id));
    const sentBack = () => [...ids].some((id) => this.sentBack.has(id)) || this.reviews.some((r) => ids.has(r.findingId) && r.verdict !== "ok");
    const setAside = new AbortController();
    const watch = () => { if (sentBack()) setAside.abort(new Error("a reviewer sent a finding back")); };
    this.listeners.add(watch);
    const reviewers = unique(open.flatMap((f) => reviewersFor(f.agent, f.text).map((r) => r.name)));
    this.emit({ type: "agent_status", agent: CHIEF, text: `Drafting the answer while ${reviewers.join(" and ") || "the reviewers"} finish reviewing` });

    const hold = new Hold(this.emit);
    const draft = this.writeAnswer(chief, plan, false, { hold, abort: setAside.signal });
    let failedHeld = false;
    draft.catch(() => { if (!hold.open) failedHeld = true; });
    try {
      await final;
    } finally {
      this.listeners.delete(watch);
    }
    if (setAside.signal.aborted || sentBack()) {
      setAside.abort(new Error("a reviewer sent a finding back"));
      await draft.catch(() => {});
      this.emit({ type: "agent_status", agent: CHIEF, text: "A reviewer sent a finding back, so I'm writing the answer from the final findings" });
      return undefined;
    }
    if (failedHeld) return undefined; // nothing of it was shown: write it again
    hold.release();
    return await draft;
  }

  // The Chief's answer: streamed (through `held.hold` when drafting), then show_path. Throws when it wrote none.
  private async writeAnswer(chief: AgentDef, plan: Plan, fast: boolean, held?: { hold: Hold; abort: AbortSignal }): Promise<string> {
    const findings = this.planFindings(plan);
    const lean = !fast && findings.length > 0; // the desks looked things up: the Chief writes at once
    const phase: RunPhase = fast ? "direct" : "synthesis";
    const own = this.tools(chief, phase, lean);
    const tools = held ? gateWrites(own, () => held.hold.opened(held.abort)) : own;
    const out = held ? held.hold.emit : this.emit;
    const stream = new AnswerStream(out);
    // A held draft treats the findings still under review as final: it is only shown if their reviews come back ok.
    const views = findings.map(this.view).map((v) => (held ? { ...v, draft: undefined } : v));
    let res: RunOutput;
    try {
      res = await this.runAgent(chief, {
        phase, system: this.system(chief, tools), tools, streamText: true, maxTurns: lean ? MAX_TURNS.synthesis : MAX_TURNS.direct,
        prompt: fast
          ? directPrompt({ question: this.input.question, recall: this.input.recall.text, task: plan.steps[0]!.task, toolRounds: toolRounds("direct") })
          : synthesisPrompt({
            question: this.input.question, recall: this.input.recall.text, findings: views, failed: this.failed, canLookUp: !lean,
            ...(plan.chiefTask ? { chiefTask: plan.chiefTask } : {}),
          }),
        ...(held ? { abort: held.abort, onToolResult: this.toolResults(out, held.hold) } : {}),
      }, stream.emit);
    } catch (e) {
      // Written in full and pathed before the run failed (out of turns, a timeout on the turn after show_path): keep it.
      const kept = stream.sealedAnswer();
      if (kept && !held?.abort.aborted) return kept;
      throw e;
    }
    const answer = stream.finish(res.text);
    if (!answer) throw new Error("wrote no answer");
    return answer;
  }

  // The Chief didn't call show_path: call it with the answer's cited ids, in order of appearance.
  private async fallbackPath(chief: AgentDef, answer: string): Promise<void> {
    let showPath: AlleviaTool | undefined;
    try { showPath = this.deps.getTools(["show_path"]).find((t) => t.name === "show_path"); } catch { return; }
    const ids = extractCitations(answer).filter((id) => this.touched.has(id)).slice(0, MAX_PATH_IDS);
    if (!showPath || !ids.length) return;
    const key = arrayArgKey(showPath.input) ?? "ids";
    const input = this.runInput(chief, { phase: "synthesis", system: "", prompt: "", tools: [showPath], maxTurns: 1 });
    await invokeTool(showPath, { [key]: ids }, input, this.emit, nextCallId(CHIEF));
  }
}

function recallNodes(r: RecallBrief): NodeRef[] {
  return r.nodes ?? r.ids.map((id) => ({ id, label: typeFromId(id) ?? "Entity", name: id }));
}

export async function runTurn(input: TurnInput, deps: TurnDeps, emit: Emit): Promise<TurnOutcome> {
  const t = new Turn(input, deps, emit);
  // What the brief showed the agents counts as seen: they may cite it.
  if (input.recall.ids.length) t.touched.add({ data: input.recall.text, nodes: recallNodes(input.recall), edges: [], sources: [] });
  emit({ type: "recall", brief: input.recall.text, ids: input.recall.ids } satisfies AgentEvent);

  const plan = await t.plan();
  const fastPath = plan.steps.length === 1 && plan.steps[0]!.agent === CHIEF;
  const work = fastPath ? undefined : t.work(plan.steps);
  work?.final.catch(() => {}); // awaited below; this only keeps an early rejection from going unhandled
  const { text, ok } = await t.answer(plan, fastPath, work);
  await work?.final;

  const findings = plan.steps.map((s) => t.findings.get(s.agent)).filter((f): f is FindingRecord => !!f);
  return {
    ok, answer: text, plan, fastPath, findings, reviews: t.reviews, proposals: t.proposals, agents: t.agents, failed: t.failed, touched: t.touched,
    ...(t.path ? { path: t.path } : {}),
  };
}
