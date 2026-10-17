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
// The owner's settings (TurnDeps.team, product design §2.4): a desk switched off is never in the plan schema, the
// planner's desk list or a review; a light desk runs on the cheapest model; every prompt an agent gets carries the
// owner's standing instructions about it, and the ones that applied are returned as guidedBy (memory.ts writes
// GUIDED_BY from the Turn and each Finding).
// Failure: each agent run has a timeout (120 s) that also aborts its runtime (and so its SDK subprocess); a turn-level
// signal stops every run. A failed agent emits agent_done {ok:false} and the Chief is told.
// Untrusted text: findings and tool results are data. Write tools reach only agents whose roster lists them (toolsFor
// here, mayUse in invokeTool), never in a review or a revision, and the Chief's synthesis prompt says findings never
// carry owner instructions. `remember` (which recall later shows as an owner preference) is offered only when the
// owner's question asks to remember or note something, and saves only text made mostly of the question's own words.
// This file does not touch the graph itself: tools do (through the injected getTools), memory.ts persists the turn.
import { AGENTS, agentById, type AgentDef } from "../../shared/roster.js";
import type { ActionKind, AgentEvent, EdgeRef, NodeRef, PlanStep, ToolResult } from "../../shared/contracts.js";
import type { GraphHandle } from "../graph/client.js";
import { modesUsed, type CapabilityModeInfo } from "../capabilities/modes.js";
import { typeFromId } from "../util/ids.js";
import { checkTurn, extractCitations, hasNumbers } from "./checks.js";
import type { SkillCatalog } from "./skills/catalog.js";
import { clipToItem } from "./style.js";
import { languageNote } from "./language.js";
import { humanPass, rewritePrompt, rewriteSystem, REWRITE_SCHEMA } from "./humanize.js";
import {
  CHIEF, CONTENT_DESK, FINDING_SCHEMA, findingMaxChars, MAX_DESKS, MAX_DESKS_BROAD, MAX_DESKS_DIAGNOSE, REVIEW_SCHEMA, agentSystemPrompt, directPrompt, planSchema,
  planPrompt, planSystemPrompt, reviewPrompt, revisePrompt, synthesisPrompt, workPrompt, type FindingView, type PromptOpts, type ReviewEvidence,
} from "./prompts.js";
import type { CreativeDeps } from "../creative/ports.js";
import type { PublicDataPort } from "../publicdata/service.js";
import type { ConnectionsPort } from "../connections/service.js";
import { invokeTool, isWriteTool, nextCallId, type AgentRuntime, type Emit, type RunInput, type RunOutput, type RunPhase } from "./runtime.js";
import { TouchedSet, type AlleviaTool, type ToolContext } from "./tool.js";
import {
  findingId, type FindingRecord, type InstructionNote, type ProposalRecord, type RecallBrief, type ReviewRecord, type TeamSettings,
} from "./types.js";

export const AGENT_TIMEOUT_MS = 120_000;
// A run that can make things (a poster takes an artwork, a check and a model turn) gets longer: the owner is told within two
// minutes of asking, and the run's own steps are each capped by the engine and the checks.
export const AGENT_TIMEOUT_CREATIVE_MS = 240_000;
const PUBLIC_DATA_TOOLS: ReadonlySet<string> = new Set(["google_listing", "instagram_public", "competitor_watch", "ad_library"]);
export const MAX_REVIEWERS = 2;
const MAX_PATH_IDS = 12;
const EVIDENCE_CHARS = 2_400;      // tool data handed to a reviewer, in all
const EVIDENCE_ITEM_CHARS = 600;   // per tool result

// Model turns per job (an SDK turn is one model response; a round of tool calls and a structured answer take one each).
// Each budget is the job's tool rounds (stated in its prompt) + its answer + one turn of slack; a review has no slack:
// it gets the cited tool data in its prompt, so one lookup at most and then its verdict.
const TOOL_ROUNDS: Record<RunPhase, number> = { plan: 0, work: 5, review: 1, revise: 2, synthesis: 2, direct: 5, polish: 0 };
export const MAX_TURNS: Record<RunPhase, number> = { plan: 3, work: 7, review: 2, revise: 4, synthesis: 4, direct: 7, polish: 2 };
export const toolRounds = (phase: RunPhase): number => TOOL_ROUNDS[phase];

// Planning is a short structured choice of desks: the cheapest model does it (unless TurnDeps.model overrides all).
export const PLANNER_MODEL = "haiku";
// A desk the owner put on light mode runs on the cheapest model too.
export const LIGHT_MODEL = "haiku";

export const USE_SKILL = "use_skill";

// What the Chief may use while writing the answer from the desks' findings.
const SYNTHESIS_TOOLS: ReadonlySet<string> = new Set(["show_path", "propose_action"]);

export interface TurnInput {
  tenant: string;
  question: string;
  sessionId: string;
  turnId: string;
  asker: string;
  recall: RecallBrief;
  // A direct chat: the owner talks to this one roster agent. No planning and no other desks; the agent answers with its own
  // tools, skills and the owner's instructions about it, and the answer still goes through the Chief's checks (citations,
  // numbers, plain words) and the humanizer pass. Absent, or the Chief itself: the whole team, the Chief routes.
  target?: string;
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
  capabilities?: CapabilityModeInfo[];      // the capability ladder: the Chief says where non-live data comes from
  team?: TeamSettings;                      // desks switched off or light, and the owner's standing instructions
  language?: string;                        // the business's own language setting (language.ts); absent: follow the question
  humanize?: boolean;                       // default true: the standing last pass on the answer (src/agent/humanize.ts)
  skills?: SkillCatalog;                    // the skills agents can open (use_skill): the shipped packs plus this business's own; none = no skills
  creative?: CreativeDeps;                  // what the creating tools may use; absent: creating is not set up (the tools say so)
  publicData?: PublicDataPort;              // public-data lookups (Apify, budgeted); absent or off: the tools say so
  connectionsNote?: string;                 // what is connected for this business, told to the desks that hold the connection tools (ConnectionsPort.note)
  connections?: ConnectionsPort;            // this business's connections; absent: the tools that need one say none is connected
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
  pathGrounded?: boolean;                   // the drawn path has no id nobody looked up, and no pair left unlinked (show_path's result)
  agents: string[];                         // every agent that ran, in order of first involvement
  failed: string[];                         // agents whose work failed
  touched: TouchedSet;
  guidedBy: string[];                       // the owner's instructions the turn worked under (saved as Turn GUIDED_BY)
  skills: SkillUse[];                       // the skills agents opened this turn, once each per agent (saved on the Turn)
  memories?: string[];                      // the Memory ids `remember` saved this turn (each SOURCED_FROM the Turn)
  deliverables: DeliverableRecord[];        // what the team made this turn (posters, images, clips), each waiting for the owner's OK
}

export interface SkillUse { agent: string; skillId: string; name: string; source: "code" | "business" }
export type DeliverableRecord = Extract<AgentEvent, { type: "deliverable" }>;

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

// Does a text name a channel: its name or its id's key ("LinkedIn", "linkedin"), as a word, in any case?
export function namesChannel(text: string, ch: { id: string; name: string }): boolean {
  const key = ch.id.slice(ch.id.indexOf(":") + 1).replace(/-/g, " ");
  const words = unique([ch.name, key].map((w) => w.trim()).filter((w) => w.length >= 3));
  return words.some((w) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(w)}(?![\\p{L}\\p{N}])`, "iu").test(text));
}

// A broad review of the whole business may use up to MAX_DESKS_BROAD desks; anything else, MAX_DESKS.
const BROAD = new RegExp([
  String.raw`\b(?:doing|going|performing) overall\b`, String.raw`\boverall (?:picture|health|performance|status|summary)\b`,
  String.raw`\bhow(?:'s| is| are) everything\b`, String.raw`\bacross the (?:business|company)\b`,
  String.raw`\ball (?:departments|desks|channels|areas)\b`, String.raw`\bwhole (?:business|company)\b`,
  String.raw`\bfull (?:review|report|audit|picture|brief)\b`, String.raw`\b(?:weekly|monthly|quarterly) (?:review|report|brief|summary)\b`,
  String.raw`\bmorning brief\b`, String.raw`\btoday'?s note\b`, String.raw`\bstate of the (?:business|company)\b`,
  String.raw`\bhow (?:is|are) (?:the |my |our )?(?:business|company|things) (?:doing|going)\b`,
].join("|"), "i");
export const isBroadQuestion = (question: string): boolean => BROAD.test(question);
// A diagnosis: the owner asks why a number fell or what broke. It earns the same five desks as a broad review, because
// the answer joins what moved, what broke, what shipped, what else it hits and what was decided before.
const DIAGNOSIS = new RegExp([
  String.raw`\bwhy\b[^?.!]{0,60}\b(?:drop(?:ped|ping)?|fell|fall(?:en|ing)?|down|declin\w+|dips?|dipped|slump\w*|lower|fewer|worse|crash\w*|broke(?:n)?|stopp\w+|spik\w+)\b`,
  String.raw`\bwhat (?:broke|went wrong|changed|happened)\b`, String.raw`\bsomething (?:is |seems |has )?(?:wrong|broken|off)\b`,
  String.raw`\b(?:drop|fall|dip|decline)\s+in\b`,
].join("|"), "i");
export const isDiagnosisQuestion = (question: string): boolean => DIAGNOSIS.test(question);
export const deskCap = (question: string): number => (isBroadQuestion(question) ? MAX_DESKS_BROAD : isDiagnosisQuestion(question) ? MAX_DESKS_DIAGNOSE : MAX_DESKS);

// Validates the Chief's plan: unknown agents and desks the owner switched off dropped, one step per agent (tasks
// merged), at most deskCap(question) steps (3, or 5 for a broad review; the first ones listed are kept), `after` limited
// to planned agents (plus desks a task names), topologically ordered (a cycle is broken by dropping the stuck step's
// unmet deps). The Chief alongside other desks becomes a note for synthesis. Nothing usable -> a single chief-of-staff
// step.
export function normalisePlan(raw: unknown, question: string, opts: { disabled?: Iterable<string> } = {}): Plan {
  const off = new Set([...(opts.disabled ?? [])].filter((id) => id !== CHIEF));
  const r = (raw && typeof raw === "object" ? raw : {}) as { steps?: unknown; rationale?: unknown };
  const merged = new Map<string, { agent: string; task: string; after: string[] }>();
  for (const s of Array.isArray(r.steps) ? r.steps : []) {
    if (!s || typeof s !== "object") continue;
    const o = s as Record<string, unknown>;
    const agent = typeof o.agent === "string" ? o.agent.trim() : "";
    if (!agentById(agent) || off.has(agent)) continue;
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
// finding has numbers; the QA & Release Manager only on a Tech Lead finding about a release or the app's health. When
// the automatic check already passed (`checked`: every cited id and number found in this turn's tool data), one
// numbers reviewer is enough: the CoE lead, not the fact checker as well. A desk the owner switched off never reviews.
// At most MAX_REVIEWERS, in roster order.
export function reviewersFor(producerId: string, text: string, opts: { checked?: boolean; disabled?: ReadonlySet<string> } = {}): AgentDef[] {
  const numbers = hasNumbers(text);
  let rs = AGENTS.filter((r) => r.id !== producerId && !opts.disabled?.has(r.id) && r.reviews?.includes(producerId) && relevantReviewer(r.id, producerId, numbers, text));
  if (opts.checked && rs.some((r) => r.id === "coe-lead")) rs = rs.filter((r) => r.id !== "fact-checker");
  return rs.slice(0, MAX_REVIEWERS);
}

// The tools an agent gets for a job: its roster tools (whatever the registry returns beyond them is dropped), without
// write tools when it reviews or revises, only show_path/propose_action when the Chief writes from findings, and
// `remember` only when the owner's question asks for it (and then guarded by rememberRefusal).
export function toolsFor(
  agent: AgentDef, phase: RunPhase, getTools: (names: string[]) => AlleviaTool[], opts: { lean?: boolean; question?: string; skills?: SkillCatalog; extra?: string[] } = {},
): AlleviaTool[] {
  const noWrites = phase === "plan" || phase === "review" || phase === "revise";
  const question = opts.question ?? "";
  const names = agent.tools.filter((n) =>
    !(phase === "synthesis" && opts.lean && !SYNTHESIS_TOOLS.has(n)) && !(n === REMEMBER && !asksToRemember(question)));
  // An agent with skills can open them in every job (a plan too: the Chief's planning skill), at no cost when it doesn't.
  if (opts.skills?.has(agent.id) && (phase !== "plan" || agent.id === CHIEF)) names.push(USE_SKILL);
  for (const n of opts.extra ?? []) if (!names.includes(n)) names.push(n);
  const allowed = new Set(names);
  return getTools(names)
    .filter((t) => allowed.has(t.name) && !(noWrites && isWriteTool(t)))
    .map((t) => (t.name === REMEMBER ? guardRemember(t, question) : t));
}

// ---------- remember: only what the owner asked to remember ----------

const REMEMBER = "remember";

// An explicit request to remember or note something (English, Hindi, Hinglish). "Do you remember…" asks to recall.
const ASKS_TO_REMEMBER = new RegExp([
  String.raw`(?<!\b(?:do|did|does|can|could) (?:you|we|i|they) )(?<!\bwhat do (?:you|we) )\bremember\b`, String.raw`\bmemori[sz]e\b`,
  String.raw`\bdon'?t forget\b`, String.raw`\bdo not forget\b`, String.raw`\bnote (?:that|this|down|it)\b`, String.raw`\b(?:make|take) a note\b`,
  String.raw`\bkeep (?:it )?in mind\b`, String.raw`\bbear in mind\b`, String.raw`\bfrom now on\b`, String.raw`\bgoing forward\b`, String.raw`\bfor future reference\b`,
  String.raw`\byaad rakh`, String.raw`\bnote kar`, String.raw`\bdh?yaa?n rakh`, String.raw`\bbh?oolna mat\b`, String.raw`\bmat bh?oolna\b`, String.raw`\baage se\b`,
  "याद रख", "नोट कर", "ध्यान रख", "भूलना मत", "मत भूलना", "आगे से",
].join("|"), "iu");

export const asksToRemember = (question: string): boolean => ASKS_TO_REMEMBER.test(question);

// Words that carry no content of their own in a note ("Owner prefers …") or a request ("Please remember that I …").
const FILLER = new Set(`a an the and or but to of for in on at by with from as is are was be been it its this that these those
i me my mine we us our you your he she they them their owner owners business prefer prefers preferred preference wants want
wanted likes like should always never please remember note noted keep mind make take down don't dont do not forget from now
on going forward future reference that's will would can could ki ko ka ke ki hai hain mujhe mera meri mere hum humein hamara
yaad rakhna rakho rakh kar lo karo dhyan aage se se मुझे मेरा मेरी हम कि को का के की है हैं याद रखना रखो नोट कर लो ध्यान आगे से`.split(/\s+/));

const stem = (w: string): string => (w.length > 4 ? w.replace(/(?:ies|es|s|ing|ed)$/u, "") : w);
const contentWords = (text: string): Set<string> =>
  new Set((text.toLowerCase().match(/[\p{L}\p{M}\p{N}']+/gu) ?? []).filter((w) => !FILLER.has(w) && w.length > 1).map(stem));

function stringsIn(v: unknown, depth = 0): string[] {
  if (typeof v === "string") return [v];
  if (!v || typeof v !== "object" || depth > 2) return [];
  return Object.values(v as Record<string, unknown>).flatMap((x) => stringsIn(x, depth + 1));
}

// Why a remember call must not save, or undefined when it may: the question has to ask to remember something, and at
// least half of what is saved has to be the question's own words (so text from a tool result or a document can't be
// stored as the owner's preference).
export function rememberRefusal(question: string, args: unknown): string | undefined {
  if (!asksToRemember(question)) return "Not saved: the owner didn't ask you to remember anything in this question.";
  const note = contentWords(stringsIn(args).join(" "));
  const asked = contentWords(question);
  const overlap = [...note].filter((w) => asked.has(w)).length;
  if (!note.size || !overlap || overlap / note.size < 0.5) {
    return "Not saved: that isn't what the owner asked you to remember. Save only the owner's request, in their own words.";
  }
  return undefined;
}

function guardRemember(t: AlleviaTool, question: string): AlleviaTool {
  return { ...t, run: async (args, ctx) => {
    const why = rememberRefusal(question, args);
    if (why) throw new Error(why);
    return t.run(args, ctx);
  } };
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

// A finding about a release or the app's health (builds, store review, crashes, ANRs, error spikes, rollbacks): the
// QA & Release Manager reviews the Tech Lead on these only, not on site, SEO or dependency findings.
const RELEASE_OR_APP_HEALTH = new RegExp([
  String.raw`\breleas(?:e|es|ed|ing)\b`, String.raw`\brollouts?\b`, String.raw`\broll(?:ed|ing)? (?:out|back)\b`, String.raw`\brollbacks?\b`,
  String.raw`\bhotfix(?:es)?\b`, String.raw`\bbuilds?\b`, String.raw`\bversion \d`, String.raw`\bv\d+\.\d+`, String.raw`\bdeploy(?:s|ed|ment|ments)?\b`,
  String.raw`\bapp ?store\b`, String.raw`\bplay (?:store|console|vitals)\b`, String.raw`\bgoogle play\b`, String.raw`\btestflight\b`,
  String.raw`\bcrash(?:es|ed|ing)?\b`, String.raw`\bcrash-free\b`, String.raw`\banrs?\b`, String.raw`\bsentry\b`, String.raw`\bapp health\b`,
  String.raw`\b(?:android|ios|mobile) app\b`, String.raw`\bthe app (?:is )?(?:down|broken|failing|slow|freez)`,
].join("|"), "i");
export const concernsReleaseOrAppHealth = (text: string): boolean => RELEASE_OR_APP_HEALTH.test(text);

function relevantReviewer(reviewer: string, producer: string, numbers: boolean, text: string): boolean {
  switch (reviewer) {
    case "copy-editor": return producer === "content-strategist";
    case "fact-checker": return producer === "content-strategist" || numbers;
    case "coe-lead": return numbers;
    case "qa-release": return concernsReleaseOrAppHealth(text);
    default: return true;
  }
}

const ACTION_KINDS: ActionKind[] = ["github_issue", "content_draft", "pause_ad", "discord_post", "calendar_event", "email_send", "connection_action", "publish_post"];

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

// The cards a creating tool raised (data.proposed), as proposal events.
export function createdProposals(agent: string, r: ToolResult): ProposalRecord[] {
  const d = (r.data && typeof r.data === "object" ? r.data : {}) as Record<string, unknown>;
  if (!Array.isArray(d.proposed)) return [];
  const out: ProposalRecord[] = [];
  for (const x of d.proposed) {
    const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    if (typeof o.approvalId !== "string" || !o.approvalId) continue;
    out.push({ agent, recommendationId: typeof o.recommendationId === "string" ? o.recommendationId : "", approvalId: o.approvalId, title: typeof o.title === "string" ? o.title : "Something we made", kind: "content_draft" });
  }
  return out;
}

// The questions a creating tool needs answered (data.quickReplies), as a `quick_replies` event: at most three, options clipped.
export function toQuickReplies(agent: string, r: ToolResult): Extract<AgentEvent, { type: "quick_replies" }> | undefined {
  const d = (r.data && typeof r.data === "object" ? r.data : {}) as Record<string, unknown>;
  if (!Array.isArray(d.quickReplies) || !d.quickReplies.length) return undefined;
  const questions = d.quickReplies.slice(0, 3).flatMap((x) => {
    const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    if (typeof o.question !== "string") return [];
    const options = (Array.isArray(o.options) ? o.options : []).filter((v): v is string => typeof v === "string" && !!v.trim()).map((v) => v.slice(0, 70)).slice(0, 4);
    return [{ field: typeof o.field === "string" ? o.field : "", question: o.question.slice(0, 200), options }];
  });
  return questions.length ? { type: "quick_replies", agent, questions } : undefined;
}

// What a creating tool made (data.deliverable), as a `deliverable` event; undefined when the shape is not right.
export function toDeliverable(agent: string, r: ToolResult): DeliverableRecord | undefined {
  const d = (r.data && typeof r.data === "object" ? r.data : {}) as Record<string, unknown>;
  const x = d.deliverable as Record<string, unknown> | undefined;
  if (!x || typeof x !== "object" || typeof x.approvalId !== "string" || !Array.isArray(x.options) || !x.options.length) return undefined;
  const kind = x.kind === "poster" || x.kind === "image" || x.kind === "clip" ? x.kind : undefined;
  if (!kind) return undefined;
  return {
    type: "deliverable", agent, kind, title: typeof x.title === "string" ? x.title : "Something we made", approvalId: x.approvalId,
    recommended: typeof x.recommended === "string" ? x.recommended : "", options: x.options as DeliverableRecord["options"],
    notes: Array.isArray(x.notes) ? x.notes.filter((n): n is string => typeof n === "string") : [], ...(typeof x.credits === "number" ? { credits: x.credits } : {}),
  };
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

// The Chief's streamed answer. What the owner saw stream IS the answer: text deltas are forwarded and kept, and the
// stored answer is exactly what the stream shows at the end. The Chief's tool calls split its text into segments:
// - text written before a lookup (any tool but show_path and the write tools) is a working note ("Owner is agent:ops.
//   Check its team.", eval 2026-10-15 two-hop-cron-team): it leaves the answer, the stream gets a `reset` to the answer
//   so far, and the note goes to the work log as the Chief's status. So does text before a show_path drawn before any
//   answer was written;
// - text before a write tool (propose_action) is part of the answer: proposing an action doesn't end it;
// - once an answer has been written and show_path is called, it is sealed: anything more (a model re-writing its answer
//   after the tool call) is dropped from both the stream and the answer.
// If nothing is left at the end, the last note long enough to be an answer is the answer (a model that wrote its answer
// and then looked something up, then stopped); failing that, the run's final text is sent once.
const MIN_ANSWER_CHARS = 80;
const NOTE_STATUS_CHARS = 160;
// "I've written the answer above", "Everything is in the answer above", "nothing to add", "... not linked in the records, so there is no
// path to show" (the show_path note asks the Chief to say so, and some runs say only that): a line that sends the owner elsewhere.
const POINTS_BACK = /\b(?:answer|above|already|nothing (?:more )?to add|as (?:written|said)|no path|not linked in the records)\b/i;

export class AnswerStream {
  private kept = "";            // answer text before a write tool call: settled
  private parts: string[] = []; // the current segment (since the last tool call)
  private notes: string[] = []; // segments that turned out to be notes
  private sealed = false;
  private any = false;          // has any text streamed at all

  constructor(private out: Emit, private readonly who: string = CHIEF) {}

  private current(): string { return this.kept + this.parts.join(""); }

  readonly emit: Emit = (e) => {
    if (e.type === "tool_call" && e.agent === this.who && !this.sealed) {
      if (e.name === "show_path" && this.written()) this.sealed = true;
      else if (isWriteTool({ name: e.name })) { this.kept = this.current(); this.parts = []; }
      else this.takeBackNote();
    }
    if (e.type === "text" && e.agent === this.who) {
      if (this.sealed) return;
      // The answer never starts with blank lines (the paragraph break the SDK puts before a new text block).
      const blank = !this.current().trim();
      const delta = blank ? e.delta.trimStart() : e.delta;
      if (!delta) return;
      this.parts.push(delta);
      this.any = true;
      this.out(delta === e.delta ? e : { ...e, delta });
      return;
    }
    this.out(e);
  };

  // The current segment was a working note: out of the answer and the stream, into the log.
  private takeBackNote(): void {
    const note = this.parts.join("").trim();
    this.parts = [];
    if (!note) return;
    this.notes.push(note);
    this.out({ type: "text", agent: this.who, delta: this.kept, reset: true });
    this.out({ type: "agent_status", agent: this.who, text: clip(note.replace(/\s+/g, " "), NOTE_STATUS_CHARS) });
  }

  // The answer, if it was written in full and its path drawn (show_path called after it).
  sealedAnswer(): string | undefined { return this.sealed ? this.current().trim() || undefined : undefined; }

  // Has the Chief written an answer yet (as much as sealing needs)?
  written(): boolean { return this.current().trim().length >= MIN_ANSWER_CHARS; }

  finish(finalText: string): string {
    const streamed = this.current().trim();
    // Found in the efficiency benchmark (17 Oct, "What breaks if the Instagram token expires?" on a real business): the Chief
    // wrote the answer, looked something else up (so the answer became a note), and then wrote only "I've written the answer
    // above ...". A short line that points back at an answer is not the answer: the last note long enough to be one is.
    if (streamed && streamed.length < MIN_ANSWER_CHARS * 2 && POINTS_BACK.test(streamed)) {
      const earlier = [...this.notes].reverse().find((n) => n.length >= MIN_ANSWER_CHARS && n.length > streamed.length);
      if (earlier) {
        this.out({ type: "text", agent: this.who, delta: earlier, reset: true });
        return earlier;
      }
    }
    if (streamed) return streamed;
    // Everything written was taken back as notes: the last one long enough to be an answer (else the last) is the best
    // there is, and better than the run's whole text, which holds every note.
    const best = [...this.notes].reverse().find((n) => n.length >= MIN_ANSWER_CHARS) ?? this.notes.at(-1);
    if (best) {
      this.out({ type: "text", agent: this.who, delta: best, reset: true });
      return best;
    }
    if (this.any) return "";
    const text = finalText.trim();
    if (text) this.out({ type: "text", agent: this.who, delta: text });
    return text;
  }
}

// The Chief sometimes draws the path before writing the answer, then (having drafted it in its head) writes only "see
// the answer above" (eval 2026-10-15, memory-ig-token). So while nothing has been written, show_path's result tells it
// the owner has seen no answer yet. What it writes after the path is then the answer (AnswerStream seals only after one).
export const PATH_FIRST_NOTE =
  "The path is drawn, but the owner has seen no answer yet: nothing you drafted or planned was shown. Write the full answer now, once, with its [[id]] citations. Don't call show_path again.";

export function notePathFirst(tools: AlleviaTool[], written: () => boolean): AlleviaTool[] {
  return tools.map((t) => (t.name !== "show_path" ? t : {
    ...t,
    async run(args, ctx) {
      const r = await t.run(args, ctx);
      return written() ? r : { ...r, note: r.note ? `${r.note} ${PATH_FIRST_NOTE}` : PATH_FIRST_NOTE };
    },
  }));
}

// What use_skill's result says it showed the agent: its business-skill rule ids (each with the channel it is scoped to, if one) and the
// ids of the learned rules. Both are Memory or Rule nodes, so the turn can be GUIDED_BY them.
export function skillRulesShown(agent: string, data: Record<string, unknown>): Array<{ agent: string; id: string; channel?: { id: string; name: string } }> {
  const out: Array<{ agent: string; id: string; channel?: { id: string; name: string } }> = [];
  for (const r of Array.isArray(data.rules) ? data.rules : []) {
    const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
    const ch = (o.channel && typeof o.channel === "object" ? o.channel : undefined) as { id?: unknown; name?: unknown } | undefined;
    if (typeof o.id === "string" && o.id) out.push({ agent, id: o.id, ...(typeof ch?.id === "string" ? { channel: { id: ch.id, name: typeof ch.name === "string" ? ch.name : ch.id } } : {}) });
  }
  for (const id of Array.isArray(data.learned) ? data.learned : []) if (typeof id === "string" && id) out.push({ agent, id });
  return out;
}

// show_path's result says what it could not draw: ids nobody looked up (refused), unknown ids, pairs with no link within the
// hops or not checked in time. A path with none of those is fully grounded; the Turn keeps the answer (Turn.pathGrounded).
export function pathIsGrounded(data: unknown): boolean | undefined {
  const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  if (!Array.isArray(d.ordered)) return undefined; // not show_path's own result: nothing to say
  const n = (k: string): number => (Array.isArray(d[k]) ? (d[k] as unknown[]).length : 0);
  return d.ordered.length > 0 && n("refused") + n("missing") + n("unconnected") + n("unchecked") === 0;
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
  model?: string;                           // default: TurnDeps.model, else the agent's roster tier
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
  private readonly early = new Set<string>();            // finding ids handed on before their review ended
  private readonly unreviewed = new Map<string, Set<string>>(); // finding id -> reviewers that could not run, even on a second try
  private readonly results: Array<{ agent: string; name: string; data: unknown; ids: string[] }> = []; // every tool result
  private readonly listeners = new Set<() => void>();    // told when a finding is sent back or settles
  private readonly prompted = new Map<string, Set<string>>(); // agent -> the owner's instruction ids its prompts carried
  private readonly off: ReadonlySet<string>;             // desks the owner switched off (never the Chief)
  private readonly light: ReadonlySet<string>;           // desks on light mode: the cheapest model
  readonly reviews: ReviewRecord[] = [];
  readonly proposals: ProposalRecord[] = [];
  readonly skillsUsed: SkillUse[] = [];
  private readonly skillRules: Array<{ agent: string; id: string; channel?: { id: string; name: string } }> = []; // what use_skill showed: the business's rules for the skill, and lessons learned from edits
  readonly memories: string[] = [];
  readonly deliverables: DeliverableRecord[] = [];
  private readonly creative?: CreativeDeps;               // the request's own copy: one credit count for every tool call of the turn
  path?: { nodes: NodeRef[]; edges: EdgeRef[] };
  pathGrounded?: boolean;
  readonly touched = new TouchedSet();

  constructor(readonly input: TurnInput, readonly deps: TurnDeps, readonly emit: Emit) {
    this.off = new Set((deps.team?.disabled ?? []).filter((id) => id !== CHIEF));
    this.light = new Set(deps.team?.light ?? []);
    if (deps.creative) this.creative = { ...deps.creative, spent: { credits: 0 } };
  }

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
    const { graph, now, embedQuery, readOnly, skills } = this.deps;
    return {
      graph, tenant: this.input.tenant, turnId: this.input.turnId, agentId, asker: this.input.asker, touched: this.touched, now,
      ...(embedQuery ? { embedQuery } : {}), ...(readOnly !== undefined ? { readOnly } : {}), ...(skills ? { skills } : {}),
      question: this.input.question, ...(this.creative ? { creative: this.creative } : {}),
      ...(this.deps.publicData ? { publicData: this.deps.publicData } : {}),
      ...(this.deps.connections ? { connections: this.deps.connections } : {}),
    };
  }

  private model(agent: AgentDef): string { return this.deps.model ?? (this.light.has(agent.id) ? LIGHT_MODEL : agent.model); }

  private tools(agent: AgentDef, phase: RunPhase, lean = false): AlleviaTool[] {
    // A desk the owner talks to directly draws its own path (show_path), as the Chief does when it answers.
    const extra = agent.id !== CHIEF && phase === "direct" ? ["show_path"] : [];
    return toolsFor(agent, phase, this.deps.getTools, { lean, question: this.input.question, extra, ...(this.deps.skills ? { skills: this.deps.skills } : {}) });
  }

  // The roster agent a direct chat is with (never the Chief: asking the Chief is asking the team).
  get targetAgent(): AgentDef | undefined {
    const id = this.input.target;
    return id && id !== CHIEF ? agentById(id) : undefined;
  }

  // Who writes the answer the owner reads: the agent they chose, or the Chief.
  private get answerer(): string { return this.targetAgent?.id ?? CHIEF; }

  private get promptOpts(): PromptOpts {
    return { now: this.deps.now, tenant: this.input.tenant, ...(this.deps.timeZone ? { timeZone: this.deps.timeZone } : {}), language: this.languageNote, ...(this.deps.connectionsNote ? { connectionsNote: this.deps.connectionsNote } : {}) };
  }

  // The answer's language, decided from the question (and the business's own setting), told to every agent.
  private get languageNote(): string { return languageNote(this.input.question, this.deps.language); }

  // Every prompt an agent gets carries the owner's standing instructions about it. What a prompt showed counts as seen
  // (like the recall brief): the agent may cite it.
  private system(agent: AgentDef, tools: AlleviaTool[], phase: RunPhase = "work"): string {
    const instructions = (this.deps.team?.instructions ?? []).filter((n) => n.agents.includes(agent.id));
    if (instructions.length) {
      const unseen = instructions.filter((n) => !this.touched.has(n.id));
      if (unseen.length) {
        this.touched.add({ data: unseen.map((n) => n.text), nodes: unseen.map((n) => ({ id: n.id, label: "Memory", name: clip(n.text, 80) })), edges: [], sources: [] });
      }
      const seen = this.prompted.get(agent.id) ?? new Set<string>();
      for (const n of instructions) seen.add(n.id);
      this.prompted.set(agent.id, seen);
    }
    // Skills are listed (name and when to use it) only when the agent can open them.
    const skills = tools.some((t) => t.name === USE_SKILL) ? this.deps.skills?.forAgent(agent.id) ?? [] : [];
    return agentSystemPrompt(agent, tools, { ...this.promptOpts, instructions, skills, skillPhase: phase === "review" ? "review" : "other" });
  }

  // The instructions that guided the turn, by agent: those its prompts carried that apply here. One scoped to a channel
  // ("no emojis on LinkedIn") applies when the turn touched that channel or named it (in the question, a task, a finding
  // or the answer: `texts`); an unscoped one always does.
  guidance(texts: string[]): { turn: string[]; byAgent: Map<string, string[]> } {
    const corpus = [this.input.question, ...texts].join("\n");
    const notes = new Map((this.deps.team?.instructions ?? []).map((n) => [n.id, n] as const));
    const applies = (n: InstructionNote) => !n.channel || this.touched.has(n.channel.id) || namesChannel(corpus, n.channel);
    const byAgent = new Map<string, string[]>();
    for (const [agent, ids] of this.prompted) {
      const used = [...ids].filter((id) => { const n = notes.get(id); return !!n && applies(n); });
      if (used.length) byAgent.set(agent, used);
    }
    return { turn: unique([...byAgent.values()].flat()), byAgent };
  }

  // The rules use_skill showed an agent that applied to this turn, by agent: one scoped to a channel applies like an owner
  // instruction does (the turn touched the channel or named it); the rest always do.
  skillGuidance(texts: string[]): Map<string, string[]> {
    const corpus = [this.input.question, ...texts].join("\n");
    const out = new Map<string, string[]>();
    for (const r of this.skillRules) {
      if (r.channel && !this.touched.has(r.channel.id) && !namesChannel(corpus, r.channel)) continue;
      out.set(r.agent, unique([...(out.get(r.agent) ?? []), r.id]));
    }
    return out;
  }

  private guidanceFor(agents: string[], texts: string[]): InstructionNote[] {
    const { byAgent } = this.guidance(texts);
    const ids = new Set(agents.flatMap((a) => byAgent.get(a) ?? []));
    return (this.deps.team?.instructions ?? []).filter((n) => ids.has(n.id));
  }

  // show_path and propose_action results become path/proposal events. Through a Hold, the events wait in it and what
  // they set on the turn (its path, its proposals) happens on release.
  private toolResults(emit: Emit, hold?: Hold): NonNullable<RunInput["onToolResult"]> {
    const commit = (job: () => void) => (hold ? hold.later(job) : job());
    return ({ agent, name, args, result }) => {
      commit(() => { this.results.push({ agent, name, data: result.data, ids: [...result.nodes.map((n) => n.id), ...result.sources.map((s) => s.id)] }); });
      if (name === "show_path") {
        emit({ type: "path", nodes: result.nodes, edges: result.edges });
        // A call that drew nothing (every id refused or unknown) does not replace a path already drawn, and leaves the
        // turn without one when it is the only call, so the cited ids are tried instead (fallbackPath).
        if (result.nodes.length) {
          const grounded = pathIsGrounded(result.data);
          commit(() => { this.path = { nodes: result.nodes, edges: result.edges }; this.pathGrounded = grounded; });
        }
      } else if (name === USE_SKILL) {
        const d = (result.data && typeof result.data === "object" ? result.data : {}) as Record<string, unknown>;
        if (typeof d.skill === "string" && typeof d.name === "string") {
          const use: SkillUse = { agent, skillId: d.skill, name: d.name, source: d.source === "business" ? "business" : "code" };
          emit({ type: "skill_used", ...use });
          emit({ type: "agent_status", agent, text: `${nameOf(agent)} is using: ${use.name}` });
          commit(() => { if (!this.skillsUsed.some((u) => u.agent === agent && u.skillId === use.skillId)) this.skillsUsed.push(use); });
          const shown = skillRulesShown(agent, d);
          if (shown.length) commit(() => { this.skillRules.push(...shown); });
        }
      } else if (name === "remember") {
        const id = (result.data && typeof result.data === "object" ? (result.data as Record<string, unknown>).id : undefined);
        if (typeof id === "string" && id) commit(() => { this.memories.push(id); });
      } else if (name === "propose_action") {
        const p = toProposal(agent, args, result);
        if (p) {
          emit({ type: "proposal", ...p });
          commit(() => { this.proposals.push(p); });
        }
      } else {
        // the tools that make things: each card they raised is a proposal, and what they made is a `deliverable` for the web app and Discord
        for (const p of createdProposals(agent, result)) {
          emit({ type: "proposal", ...p });
          commit(() => { this.proposals.push(p); });
        }
        const q = toQuickReplies(agent, result);
        if (q) emit(q);
        const d = toDeliverable(agent, result);
        if (d) {
          emit(d);
          commit(() => { this.deliverables.push(d); });
        }
      }
    };
  }

  private runInput(agent: AgentDef, o: RunOpts, signal?: AbortSignal): RunInput {
    return {
      agentId: agent.id, model: o.model ?? this.model(agent), system: o.system, prompt: o.prompt, tools: o.tools, ctx: this.ctx(agent.id),
      maxTurns: o.maxTurns, phase: o.phase, onToolResult: o.onToolResult ?? this.toolResults(this.emit),
      ...(o.outputSchema ? { outputSchema: o.outputSchema } : {}), ...(o.streamText ? { streamText: true } : {}), ...(signal ? { signal } : {}),
    };
  }

  // One agent run with a timeout. The timeout, the turn's signal and the run's own `abort` all abort the runtime (which
  // closes the SDK subprocess), and the run stops waiting at once. Once it settles the run is no longer live: anything
  // it still emits or reports (a tool call that was in flight) is dropped.
  private async runAgent(agent: AgentDef, o: RunOpts, emit: Emit = this.emit): Promise<RunOutput> {
    this.involve(agent.id);
    // A public-data lookup waits on a run in Apify's cloud (up to a few minutes), so a desk that holds one gets the long limit too.
    const slowTools = !!this.creative || (this.deps.publicData?.enabled === true && agent.tools.some((t) => PUBLIC_DATA_TOOLS.has(t)));
    const ms = this.deps.agentTimeoutMs ?? (slowTools && (o.phase === "direct" || o.phase === "work") ? AGENT_TIMEOUT_CREATIVE_MS : AGENT_TIMEOUT_MS);
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
    let live = true;
    const onToolResult = o.onToolResult ?? this.toolResults(this.emit);
    try {
      if (ac.signal.aborted) return await stop; // never start a run that is already stopped
      const input: RunInput = { ...this.runInput(agent, o, ac.signal), onToolResult: (c) => { if (live) onToolResult(c); } };
      const run = this.deps.runtime.run(input, (e) => { if (live) emit(e); });
      run.catch(() => {}); // a run that loses the race may reject later
      const out = await Promise.race([run, stop]);
      // Out of turns: only a desk's work is usable unfinished (as a partial finding); a plan, review, revision or answer
      // that didn't finish counts as not done (a partial review must never read as an "ok").
      if (out.partial && o.phase !== "work") throw new Error("ran out of turns before finishing");
      return out;
    } finally {
      live = false;
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

  // The plan schema and the planner's desk list hold only the desks the owner has on.
  async plan(): Promise<Plan> {
    const target = this.targetAgent;
    if (target) {
      // A direct chat: no planner, no other desks. The one step is the owner's own words.
      return { steps: [{ agent: target.id, task: this.input.question.trim() }], rationale: `You asked ${target.name} directly.` };
    }
    const chief = agentById(CHIEF)!;
    const enabled = AGENTS.map((a) => a.id).filter((id) => !this.off.has(id));
    // The planner has no lookups, but it may open its planning skill (the desks' skills are named in its prompt).
    const skills = this.deps.skills;
    const tools = skills?.has(CHIEF) ? this.deps.getTools([USE_SKILL]) : [];
    const out = await this.step(chief, "Planning who does what", () => this.runAgent(chief, {
      phase: "plan", model: this.deps.model ?? PLANNER_MODEL,
      system: planSystemPrompt({ ...this.promptOpts, disabled: [...this.off], ...(skills ? { skills, chiefCanOpenSkills: tools.length > 0 } : {}) }),
      prompt: planPrompt({ question: this.input.question, recall: this.input.recall.text }), tools, outputSchema: planSchema(enabled), maxTurns: MAX_TURNS.plan,
    }));
    const plan = normalisePlan(out ? out.structured ?? tryParseJson(out.text) : undefined, this.input.question, { disabled: this.off });
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
    return !f.partial && f.citations.length > 0 && this.checksOut(f);
  }

  // Every cited id and number in it was found in this turn's tool data.
  private checksOut(f: FindingRecord): boolean {
    const c = checkTurn(f.text, this.touched, { now: this.deps.now, question: this.input.question });
    return c.citationsValid && c.numbersGrounded;
  }

  private reviewersOf(f: FindingRecord): AgentDef[] {
    return reviewersFor(f.agent, f.text, { checked: this.checksOut(f), disabled: this.off });
  }

  private toFinding(out: RunOutput, base: { id: string; agent: string; task: string; depIds: string[] }): FindingRecord {
    const s = (out.structured ?? tryParseJson(out.text)) as Record<string, unknown> | undefined;
    const text = clipToItem(typeof s?.text === "string" ? s.text : out.text, findingMaxChars(base.agent)); // cut between items, never inside one
    if (!text) throw new Error("returned an empty finding");
    const known = new Set([...this.findings.values()].map((f) => f.id));
    return {
      id: base.id, agent: base.agent, task: base.task, text,
      // Only ids a tool returned this turn: a made-up [[id]] stays in the text (where the automatic check flags it) but
      // never becomes a citation that is lit up, handed on or persisted.
      citations: unique([...extractCitations(text), ...strings(s?.citations)]).filter((id) => this.touched.has(id)),
      basedOn: unique([...base.depIds, ...strings(s?.basedOn).filter((id) => known.has(id) && id !== base.id)]),
      proposals: strings(s?.proposals).slice(0, 5),
      revised: false, rejected: false, ...(out.partial ? { partial: true } : {}),
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
        prompt: workPrompt({ question: this.input.question, task: s.task, recall: this.input.recall.text, inputs: inputs.map(this.view), failedDeps, toolRounds: toolRounds("work"), agent: agent.id, language: this.languageNote }) + this.namedSkills(agent, s.task, tools),
      });
      const f = this.toFinding(out, { id: findingId(this.input.turnId, agent.id), agent: agent.id, task: s.task, depIds: inputs.map((x) => x.id) });
      this.findings.set(agent.id, f);
      if (f.partial) this.emit({ type: "agent_status", agent: agent.id, text: "Ran out of turns: handing over what I have (partial)" });
      this.emitFinding(f);
      return f;
    });
    if (!finding) { this.failed.push(agent.id); return; }
    // Dependents start now and the review runs alongside them (a finding nobody reviews is final at once anyway).
    if (this.reviewersOf(finding).length && this.handOffEarly(finding)) { this.early.add(finding.id); release(); }
    await this.review(finding, agent);
    this.settled.add(finding.id);
    this.sentBack.delete(finding.id);
    this.changed();
  }

  // ----- review (+ one revision) -----

  // Rejected only when every reviewer that answered rejects; any other non-ok verdict (a fix, or a reject the others
  // disagree with) earns exactly one revision that addresses all the notes.
  private async review(f: FindingRecord, producer: AgentDef): Promise<void> {
    const reviewers = this.reviewersOf(f);
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
    // The data behind the cited ids, so the reviewer can decide without looking anything up (clipped, deduplicated).
    const cited = new Set(f.citations);
    const toolData: NonNullable<ReviewEvidence["toolData"]> = [];
    const seen = new Set<string>();
    let room = EVIDENCE_CHARS;
    for (const r of this.results) {
      if (room <= 0 || !r.ids.some((id) => cited.has(id))) continue;
      const data = clip(JSON.stringify(r.data ?? null), EVIDENCE_ITEM_CHARS);
      if (seen.has(`${r.name}|${data}`)) continue;
      seen.add(`${r.name}|${data}`);
      room -= data.length;
      toolData.push({ tool: r.name, agent: r.agent, data });
    }
    return { citedNodes, autoCheck: this.autoCheck(f.text), ...(toolData.length ? { toolData } : {}) };
  }

  // A reviewer whose run dies (content trial 2026-10-15: the Claude Code process crashed under load) gets one more try,
  // unless it timed out or the turn was stopped. If it still cannot run, the finding is marked unreviewed, and the Chief is
  // told to say so: a missing fact check must never read as a passed one.
  private async runReview(reviewer: AgentDef, f: FindingRecord, producer: AgentDef): Promise<ReviewRecord | undefined> {
    let failure: unknown;
    const attempt = (): Promise<ReviewRecord | undefined> => this.step(reviewer, `Reviewing ${producer.name}'s finding`, async () => {
      try {
        const tools = this.tools(reviewer, "review");
        const out = await this.runAgent(reviewer, {
          phase: "review", system: this.system(reviewer, tools, "review"), tools, outputSchema: REVIEW_SCHEMA, maxTurns: MAX_TURNS.review,
          prompt: reviewPrompt({ question: this.input.question, reviewer, finding: this.view(f), evidence: this.evidence(f), toolRounds: toolRounds("review") }),
        });
        const s = (out.structured ?? tryParseJson(out.text)) as Record<string, unknown> | undefined;
        const verdict = s?.verdict === "fix" || s?.verdict === "reject" ? s.verdict : "ok";
        const note = clip(typeof s?.note === "string" ? s.note.trim() : out.text.trim(), 400);
        const r: ReviewRecord = { reviewer: reviewer.id, findingId: f.id, verdict, note };
        this.emit({ type: "review", agent: reviewer.id, findingId: f.id, verdict, note });
        if (verdict !== "ok") { this.sentBack.add(f.id); this.changed(); } // a draft of the answer built on it is now stale
        return r;
      } catch (e) {
        failure = e;
        throw e;
      }
    });
    let r = await attempt();
    const message = failure instanceof Error ? failure.message : String(failure ?? "");
    if (!r && !this.deps.signal?.aborted && !/timed out|was stopped|set aside/i.test(message)) r = await attempt();
    if (!r && !this.deps.signal?.aborted) {
      const set = this.unreviewed.get(f.id) ?? new Set<string>();
      set.add(reviewer.id);
      this.unreviewed.set(f.id, set);
    }
    return r;
  }

  private async revise(f: FindingRecord, producer: AgentDef, notes: ReviewRecord[]): Promise<void> {
    await this.step(producer, "Revising after review", async () => {
      const tools = this.tools(producer, "revise");
      const out = await this.runAgent(producer, {
        phase: "revise", system: this.system(producer, tools, "revise"), tools, outputSchema: FINDING_SCHEMA, maxTurns: MAX_TURNS.revise,
        prompt: revisePrompt({ question: this.input.question, task: f.task, finding: this.view(f), notes: notes.map((n) => ({ reviewer: n.reviewer, verdict: n.verdict, note: n.note })), toolRounds: toolRounds("revise"), agent: producer.id, language: this.languageNote }),
      });
      const next = this.toFinding(out, { id: f.id, agent: f.agent, task: f.task, depIds: f.basedOn });
      Object.assign(f, { text: next.text, citations: next.citations, basedOn: next.basedOn, proposals: next.proposals.length ? next.proposals : f.proposals, revised: true });
      this.emitFinding(f);
    });
  }

  private readonly view = (f: FindingRecord): FindingView => {
    const caveat = this.draftCaveat(f.agent);
    return {
      id: f.id, agent: f.agent, text: f.text, citations: f.citations, proposals: f.proposals, rejected: f.rejected, ...(f.partial ? { partial: true } : {}),
      ...(f.revised ? { revised: true } : {}), ...(this.unreviewed.get(f.id)?.size ? { unreviewed: [...this.unreviewed.get(f.id)!] } : {}),
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

  // The plan named one of this agent's skills ("Plan the owner's week with the what-do-i-do-this-week skill"): the agent is
  // told to open it first and to look the facts up live. The Chief chose the skill when it planned; this only passes it on
  // (live trial 2026-10-15: the Chief answered from earlier threads without opening the skill it had planned to use).
  private namedSkills(agent: AgentDef, task: string, tools: AlleviaTool[]): string {
    if (!tools.some((t) => t.name === USE_SKILL)) return "";
    const named = (this.deps.skills?.forAgent(agent.id) ?? []).filter((k) => task.includes(k.id));
    if (!named.length) return "";
    return `\n\nYour plan names your skill ${named.map((k) => k.id).join(" and ")}: open it with use_skill in your first round, and look the facts up again with your tools in that round. Earlier answers in what we already know may be out of date.`;
  }

  // ----- the last pass: the answer reads as a person wrote it -----

  // The no-model pass always (wrappers, dashes, curly quotes); Dev on the cheapest model only when strong tells are left,
  // and not for copy Dev already checked (the content desk's captions) or when Dev is switched off. A table or pure data
  // is left alone. The owner sees the cleaned answer replace the streamed one; nothing it relies on can move (sameFacts).
  async polish(text: string, plan: Plan): Promise<string> {
    if (this.deps.humanize === false || !text.trim()) return text;
    const dev = agentById("copy-editor")!;
    const content = this.planFindings(plan).some((f) => f.agent === CONTENT_DESK && !f.rejected);
    const instructions = (this.deps.team?.instructions ?? []).filter((n) => n.agents.includes(dev.id) && !n.channel).map((n) => n.text);
    const r = await humanPass(text, {
      skipModel: content || this.off.has(dev.id) || this.deps.signal?.aborted === true,
      rewrite: async (t, tells) => {
        const out = await this.step(dev, "Making the answer read like a person wrote it", () => this.runAgent(dev, {
          phase: "polish", model: this.deps.model ?? LIGHT_MODEL, system: rewriteSystem({ instructions }), prompt: rewritePrompt(t, tells),
          tools: [], outputSchema: REWRITE_SCHEMA, maxTurns: MAX_TURNS.polish,
        }));
        const s = (out?.structured ?? (out ? tryParseJson(out.text) : undefined)) as { text?: unknown } | undefined;
        return typeof s?.text === "string" ? s.text : undefined;
      },
    });
    if (r.changed) this.emit({ type: "text", agent: this.answerer, delta: r.text, reset: true });
    return r.text;
  }

  // ----- answer -----

  async answer(plan: Plan, fast: boolean, work?: WorkGates): Promise<{ text: string; ok: boolean }> {
    const chief = (fast ? agentById(plan.steps[0]!.agent) : undefined) ?? agentById(CHIEF)!;
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
    const who = chief.id === CHIEF ? "The Chief of Staff" : chief.name;
    this.emit({ type: "error", agent: chief.id, message: `${who} could not write the answer${failure ? `: ${failure}` : ""}.` });
    const fallback = findings.length
      ? `I couldn't finish writing the full answer. Here is what the team found:\n\n${findings.map((f) => `**${nameOf(f.agent)}:** ${f.text}`).join("\n\n")}`
      : "I couldn't answer this one just now. Please ask again in a moment.";
    this.emit({ type: "text", agent: chief.id, delta: fallback });
    return { text: fallback, ok: false };
  }

  // When the Chief starts: once every finding has landed and the open ones can be drafted from (or are all final).
  // Returns the findings whose reviews are still running then (the Chief drafts while they finish), or [] once every
  // finding is final.
  private async whenToWrite(plan: Plan, work: WorkGates): Promise<FindingRecord[]> {
    await work.ready;
    for (;;) {
      const open = this.planFindings(plan).filter((f) => !this.settled.has(f.id));
      if (!open.length) { await work.final; return []; }
      // Draft only when it is likely to be kept: every open finding passed the automatic check (it was handed on early),
      // none is content (its copy edits usually send it back), and none has been sent back.
      const draftable = open.every((f) => this.early.has(f.id) && agentById(f.agent)?.department !== "content" && !this.sentBack.has(f.id));
      if (this.deps.draftWhileReviewing !== false && draftable) return open;
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
    const reviewers = unique(open.flatMap((f) => this.reviewersOf(f).map((r) => r.name)));
    const whoReviews = reviewers.length === 1 ? `${reviewers[0]} finishes` : `${reviewers.join(" and ") || "the reviewers"} finish`;
    this.emit({ type: "agent_status", agent: CHIEF, text: `Drafting the answer while ${whoReviews} reviewing` });

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
    const out = held ? held.hold.emit : this.emit;
    const stream = new AnswerStream(out, chief.id);
    const tools = notePathFirst(held ? gateWrites(own, () => held.hold.opened(held.abort)) : own, () => stream.written());
    // A held draft treats the findings still under review as final: it is only shown if their reviews come back ok.
    const views = findings.map(this.view).map((v) => (held ? { ...v, draft: undefined } : v));
    // Data-source modes: on the fast path every capability that isn't live (the Chief looks up for itself); from
    // findings, the ones this turn's tool data drew on.
    const caps = this.deps.capabilities ?? [];
    const sources = fast ? caps.filter((c) => c.accessMode !== "api") : modesUsed(this.touched.nodes().map((n) => n.id), caps, "prompt");
    // The owner's instructions the desks worked under, so the answer honours them and the path can show them.
    const guidance = fast ? [] : this.guidanceFor(plan.steps.map((s) => s.agent), [...plan.steps.map((s) => s.task), ...findings.map((f) => f.text)]);
    let res: RunOutput;
    try {
      res = await this.runAgent(chief, {
        phase, system: this.system(chief, tools, phase), tools, streamText: true, maxTurns: lean ? MAX_TURNS.synthesis : MAX_TURNS.direct,
        prompt: fast
          ? directPrompt({ question: this.input.question, recall: this.input.recall.text, task: plan.steps[0]!.task, toolRounds: toolRounds("direct"), sources, language: this.languageNote }) + this.namedSkills(chief, plan.steps[0]!.task, tools)
          : synthesisPrompt({
            question: this.input.question, recall: this.input.recall.text, findings: views, failed: this.failed, canLookUp: !lean, sources, guidance, language: this.languageNote, diagnosis: isDiagnosisQuestion(this.input.question),
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
    await invokeTool(showPath, { [key]: ids }, input, this.emit, nextCallId(chief.id));
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
  const fastPath = plan.steps.length === 1 && (plan.steps[0]!.agent === CHIEF || plan.steps[0]!.agent === t.targetAgent?.id);
  const work = fastPath ? undefined : t.work(plan.steps);
  work?.final.catch(() => {}); // awaited below; this only keeps an early rejection from going unhandled
  const answered = await t.answer(plan, fastPath, work);
  await work?.final;
  const ok = answered.ok;
  const text = ok ? await t.polish(answered.text, plan) : answered.text;

  const findings = plan.steps.map((s) => t.findings.get(s.agent)).filter((f): f is FindingRecord => !!f);
  const corpus = [...plan.steps.map((s) => s.task), ...findings.map((f) => f.text), text];
  const { turn: owned, byAgent } = t.guidance(corpus);
  const skillRules = t.skillGuidance(corpus);
  const guidedBy = unique([...owned, ...[...skillRules.values()].flat()]);
  for (const f of findings) {
    const ids = unique([...(byAgent.get(f.agent) ?? []), ...(skillRules.get(f.agent) ?? [])]);
    if (ids.length) f.guidedBy = ids;
    const used = t.skillsUsed.filter((u) => u.agent === f.agent).map((u) => u.skillId);
    if (used.length) f.skills = used;
  }
  return {
    ok, answer: text, plan, fastPath, findings, reviews: t.reviews, proposals: t.proposals, agents: t.agents, failed: t.failed, touched: t.touched,
    guidedBy, skills: t.skillsUsed, deliverables: t.deliverables, ...(t.memories.length ? { memories: t.memories } : {}),
    ...(t.path ? { path: t.path, ...(t.pathGrounded !== undefined ? { pathGrounded: t.pathGrounded } : {}) } : {}),
  };
}
