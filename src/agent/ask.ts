// ask(): one question from any surface (web, Discord, CLI, MCP) through the agent company, end to end.
// session (new thread unless one is given) -> seed ids (injected search) -> recall brief, the capability ladder and the
// team settings -> runTurn -> checkTurn on the final answer -> saveTurn (Turn, Findings, reviews, the full event log,
// GUIDED_BY the owner's instructions that applied) -> `final`. `final` is always the last event, also after an error;
// an error is reported as an `error` event and the Turn is still saved, marked failed. The turn's stream closes when
// `final` is made: anything a run emits after that is dropped from the stream and the log.
import type { AgentEvent, TurnChecks } from "../../shared/contracts.js";
import { openGraph, type GraphHandle } from "../graph/client.js";
import { capabilityModes } from "../capabilities/ladder.js";
import type { CapabilityModeInfo } from "../capabilities/modes.js";
import { agentById } from "../../shared/roster.js";
import { loadTeamSettings } from "../settings/team.js";
import { loadLanguagePreference } from "./language.js";
import { fillInFromSession, isFillItIn } from "./fillin.js";
import { checkTurn, extractCitations } from "./checks.js";
import { getSession, newSessionId, newTurnId, recallBrief, saveTurn, startSession } from "./memory.js";
import { runTurn, type TurnOutcome } from "./orchestrator.js";
import { UsageMeter, type AgentRuntime, type Emit, type Usage } from "./runtime.js";
import { TouchedSet, type AlleviaTool, type ToolContext } from "./tool.js";
import { loadBusinessSkills } from "./skills/business.js";
import type { SkillCatalog } from "./skills/catalog.js";
import type { CreativeDeps } from "../creative/ports.js";
import type { PublicDataPort } from "../publicdata/service.js";
import type { ConnectionsPort } from "../connections/service.js";
import type { RecallBrief, TeamSettings } from "./types.js";

export type Channel = "web" | "discord" | "cli" | "mcp";

export interface AskInput {
  tenant: string;
  question: string;
  sessionId?: string;    // continue this thread; omitted -> a new thread
  asker?: string;        // entity id of who asks; default person:founder
  channel: Channel;
  // A direct chat with one roster agent (src/agent/orchestrator.ts TurnInput.target). A new thread remembers it
  // (Session.agent). Absent or the Chief: the whole team, the Chief routes.
  target?: string;
  // Answer without writing anything: no session, no Turn, no memory (and, with deps.readOnly, no tool writes). For measuring
  // an answer on a business's real graph (scripts/bench-efficiency.ts) and for read-only checks; the answer is not kept.
  ephemeral?: boolean;
}

export interface AskDeps {
  runtime: AgentRuntime;
  getTools: (names: string[]) => AlleviaTool[];
  graph?: GraphHandle;                                // default: the tenant's graph
  seedSearch?: (question: string) => Promise<string[]>; // entity ids the question is about (wired to the search tool)
  now?: () => number;
  model?: string;                                     // override every agent's model (e.g. "haiku")
  agentTimeoutMs?: number;
  embedQuery?: ToolContext["embedQuery"];
  readOnly?: boolean;
  timeZone?: string;                                  // the tenant's IANA zone for dates in prompts (default IST)
  signal?: AbortSignal;                               // stops the turn: every agent run is aborted, the turn saved as failed
  skills?: SkillCatalog | null;                       // the shipped skill packs; this business's own are laid over them each turn. none/null: no skills
  creative?: CreativeDeps;                            // what the tools that make things may use; absent: they say it isn't set up
  publicData?: PublicDataPort;                        // public-data lookups (Apify); absent or off: those tools say so
  connections?: ConnectionsPort;                      // this business's connections; absent: the tools that need one say none is connected
}

// What src/agent/wiring.ts (written once the graph tools land) must export, so every surface (CLI, server, Discord,
// MCP) builds the same deps: the SDK runtime, the real tools, the tenant graph and search-backed seeds.
export interface AgentWiring {
  createAskDeps(opts: { tenant: string; model?: string }): Promise<AskDeps>;
}

export interface AskResult {
  ok: boolean;
  turnId: string;
  sessionId: string;
  answer: string;
  citations: string[];
  checks: TurnChecks;
  agents: string[];
  ms: number;
  /** What the model read and wrote for this answer, summed over every agent run, and how many tools were called. */
  usage?: Usage & { toolCalls: number };
  outcome?: TurnOutcome;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
export const STOPPED_MESSAGE = "Stopped before the answer was finished.";
const EMPTY_BRIEF: RecallBrief = { text: "", ids: [] };

export async function ask(input: AskInput, deps: AskDeps, emit: Emit): Promise<AskResult> {
  const t0 = Date.now();
  const now = deps.now?.() ?? Date.now();
  const asker = input.asker ?? "person:founder";
  const question = input.question.trim();
  const turnId = newTurnId(now);
  const sessionId = input.sessionId ?? newSessionId(now);
  const target = input.target && input.target !== "chief-of-staff" ? input.target : undefined;

  // Everything is logged for replay; a consumer that throws must not break the turn.
  const log: AgentEvent[] = [];
  let closed = false;
  const deliver = (e: AgentEvent) => { try { emit(e); } catch { /* the stream's problem, not the turn's */ } };
  const out: Emit = (e) => { if (closed) return; log.push(e); deliver(e); };

  out({ type: "session", tenant: input.tenant, sessionId, turnId, question });
  const meter = new UsageMeter();

  let g: GraphHandle | undefined = deps.graph;
  let outcome: TurnOutcome | undefined;
  let failure: string | undefined;
  let capabilities: CapabilityModeInfo[] | undefined;
  try {
    if (!question) throw new Error("The question is empty.");
    if (target && !agentById(target)) throw new Error("That person is not on the team.");
    g ??= await openGraph(input.tenant);
    const continuing = input.sessionId ? !!(await getSession(g, input.sessionId)) : false;
    if (!continuing && !input.ephemeral) await startSession(g, { channel: input.channel, asker, title: question, id: sessionId, ...(target ? { agent: target } : {}) }, now);

    let seeds: string[] = [];
    try { seeds = deps.seedSearch ? await deps.seedSearch(question) : []; } catch { seeds = []; } // recall is best-effort
    let recall = EMPTY_BRIEF;
    try { recall = await recallBrief(g, { question, seedIds: seeds, ...(continuing ? { sessionId } : {}) }); } catch { recall = EMPTY_BRIEF; }
    // The capability ladder (best-effort): the Chief says where non-live data comes from, and the answer is checked for it.
    try { capabilities = await capabilityModes(g, now); } catch { capabilities = undefined; }
    // The owner's team settings: desks switched off or light, standing instructions. If they can't be read, the turn
    // runs with the full team and no instructions (and says so in the log).
    let team: TeamSettings | undefined;
    try { team = await loadTeamSettings(g); } catch (e) { out({ type: "error", message: `Could not read the team settings, so the whole team is on: ${message(e)}` }); }
    if (target && team?.disabled.includes(target)) {
      const who = agentById(target)!.name;
      throw new Error(`${who} is switched off right now. Switch ${who} back on from the chat header, or ask the whole team.`);
    }
    // The shipped skills with this business's own laid over them (its graph only: a new business has the shipped ones alone).
    let skills = deps.skills ?? undefined;
    if (skills) {
      try { skills = skills.withBusiness(await loadBusinessSkills(g)); } catch (e) { out({ type: "error", message: `Could not read this business's own skills, so the shipped ones are used: ${message(e)}` }); }
    }

    if (skills && team?.skillsOff) skills = skills.restrict(team.skillsOff);

    // "Fill it in": the owner accepts the draft's suggestions. Done in code on the draft already in this thread (fillin.ts):
    // no desks run, nothing is re-invented, and the sources are the ones the draft already had.
    const filled = continuing && isFillItIn(question) ? await fillInFromSession(g, sessionId, question).catch(() => null) : null;
    if (filled) {
      const touched = new TouchedSet();
      touched.add({ data: filled.previous, nodes: filled.nodes, edges: [], sources: [] });
      out({ type: "agent_start", agent: "chief-of-staff", task: "Write the suggestions into the copy" });
      out({ type: "text", agent: "chief-of-staff", delta: filled.answer });
      out({ type: "agent_done", agent: "chief-of-staff", ms: 0, ok: true });
      outcome = {
        ok: true, answer: filled.answer, plan: { steps: [{ agent: "chief-of-staff", task: "Fill in the suggestions" }], rationale: "The owner accepted the suggestions in the last draft." },
        fastPath: true, findings: [], reviews: [], proposals: [], agents: ["chief-of-staff"], failed: [], touched, guidedBy: [], skills: [], deliverables: [],
      };
    }

    // What this business has connected, told to the desks that can use it (best-effort: a slow or missing answer is just no note).
    let connectionsNote = "";
    if (!outcome && deps.connections) try { connectionsNote = await Promise.race([deps.connections.note(), new Promise<string>((r) => setTimeout(() => r(""), 2500))]); } catch { connectionsNote = ""; }

    // The business's own language setting (best-effort): absent, the answer follows the question's language.
    let language: string | undefined;
    if (!outcome) try { language = await loadLanguagePreference(g); } catch { language = undefined; }

    if (!outcome) outcome = await runTurn(
      { tenant: input.tenant, question, sessionId, turnId, asker, recall, ...(target ? { target } : {}) },
      {
        runtime: meter.wrap(deps.runtime), getTools: deps.getTools, graph: g, now,
        ...(deps.model ? { model: deps.model } : {}), ...(deps.agentTimeoutMs ? { agentTimeoutMs: deps.agentTimeoutMs } : {}),
        ...(deps.embedQuery ? { embedQuery: deps.embedQuery } : {}), ...(deps.readOnly !== undefined ? { readOnly: deps.readOnly } : {}),
        ...(deps.timeZone ? { timeZone: deps.timeZone } : {}), ...(deps.signal ? { signal: deps.signal } : {}),
        ...(capabilities ? { capabilities } : {}), ...(team ? { team } : {}), ...(language ? { language } : {}), ...(skills ? { skills } : {}),
        ...(deps.creative ? { creative: deps.creative } : {}), ...(deps.publicData ? { publicData: deps.publicData } : {}),
        ...(deps.connections ? { connections: deps.connections } : {}), ...(connectionsNote ? { connectionsNote } : {}),
      },
      out);
    if (deps.signal?.aborted) failure = STOPPED_MESSAGE;
    else if (!outcome.ok) failure = "The Chief of Staff could not write the answer.";
  } catch (e) {
    failure = deps.signal?.aborted ? STOPPED_MESSAGE : message(e);
    out({ type: "error", message: failure });
  }

  const answer = outcome?.answer ?? "";
  const checks = checkTurn(answer, outcome?.touched ?? new TouchedSet(), { now, question, ...(capabilities ? { capabilities } : {}) });
  const citations = extractCitations(answer);
  const agents = outcome?.agents ?? [];
  const ms = Date.now() - t0;
  const final: AgentEvent = { type: "final", turnId, answer, citations, checks, agents, ms };
  closed = true;
  log.push(final);
  const usage = { ...meter.total, toolCalls: log.filter((e) => e.type === "tool_call").length };

  if (g && !input.ephemeral) {
    try {
      const saved = await saveTurn(g, {
        turnId, sessionId, question, answer, asker, source: input.channel, at: now, ms, status: failure ? "failed" : "ok", ...(failure ? { error: failure } : {}),
        ...(target ? { target } : {}), checks, agents, events: log, touched: outcome?.touched ?? [], citations,
        findings: outcome?.findings ?? [], reviews: outcome?.reviews ?? [], guidedBy: outcome?.guidedBy ?? [],
        ...(outcome?.skills?.length ? { skills: outcome.skills } : {}),
        ...(outcome?.path?.nodes.length ? { pathIds: outcome.path.nodes.map((n) => n.id), ...(outcome.pathGrounded !== undefined ? { pathGrounded: outcome.pathGrounded } : {}) } : {}),
        cost: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens, modelCalls: usage.modelCalls, toolCalls: usage.toolCalls },
      });
      if (saved.errors.length) deliver({ type: "error", message: `Saved the turn with ${saved.errors.length} skipped write(s): ${saved.errors[0]}` });
    } catch (e) {
      deliver({ type: "error", message: `Could not save the turn: ${message(e)}` });
    }
  }
  deliver(final);
  return { ok: !failure, turnId, sessionId, answer, citations, checks, agents, ms, usage, ...(outcome ? { outcome } : {}) };
}
