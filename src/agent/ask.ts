// ask(): one question from any surface (web, Discord, CLI, MCP) through the agent company, end to end.
// session (new thread unless one is given) -> seed ids (injected search) -> recall brief -> runTurn -> checkTurn on the
// final answer -> saveTurn (Turn, Findings, reviews, the full event log) -> `final`. `final` is always the last event,
// also after an error; an error is reported as an `error` event and the Turn is still saved, marked failed.
import type { AgentEvent, TurnChecks } from "../../shared/contracts.js";
import { openGraph, type GraphHandle } from "../graph/client.js";
import { checkTurn, extractCitations } from "./checks.js";
import { getSession, newSessionId, newTurnId, recallBrief, saveTurn, startSession } from "./memory.js";
import { runTurn, type TurnOutcome } from "./orchestrator.js";
import type { AgentRuntime, Emit } from "./runtime.js";
import { TouchedSet, type AlleviaTool, type ToolContext } from "./tool.js";
import type { RecallBrief } from "./types.js";

export type Channel = "web" | "discord" | "cli" | "mcp";

export interface AskInput {
  tenant: string;
  question: string;
  sessionId?: string;    // continue this thread; omitted -> a new thread
  asker?: string;        // entity id of who asks; default person:founder
  channel: Channel;
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
  outcome?: TurnOutcome;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const EMPTY_BRIEF: RecallBrief = { text: "", ids: [] };

export async function ask(input: AskInput, deps: AskDeps, emit: Emit): Promise<AskResult> {
  const t0 = Date.now();
  const now = deps.now?.() ?? Date.now();
  const asker = input.asker ?? "person:founder";
  const question = input.question.trim();
  const turnId = newTurnId(now);
  const sessionId = input.sessionId ?? newSessionId(now);

  // Everything is logged for replay; a consumer that throws must not break the turn.
  const log: AgentEvent[] = [];
  const deliver = (e: AgentEvent) => { try { emit(e); } catch { /* the stream's problem, not the turn's */ } };
  const out: Emit = (e) => { log.push(e); deliver(e); };

  out({ type: "session", tenant: input.tenant, sessionId, turnId, question });

  let g: GraphHandle | undefined = deps.graph;
  let outcome: TurnOutcome | undefined;
  let failure: string | undefined;
  try {
    if (!question) throw new Error("The question is empty.");
    g ??= await openGraph(input.tenant);
    const continuing = input.sessionId ? !!(await getSession(g, input.sessionId)) : false;
    if (!continuing) await startSession(g, { channel: input.channel, asker, title: question, id: sessionId }, now);

    let seeds: string[] = [];
    try { seeds = deps.seedSearch ? await deps.seedSearch(question) : []; } catch { seeds = []; } // recall is best-effort
    let recall = EMPTY_BRIEF;
    try { recall = await recallBrief(g, { question, seedIds: seeds, ...(continuing ? { sessionId } : {}) }); } catch { recall = EMPTY_BRIEF; }

    outcome = await runTurn(
      { tenant: input.tenant, question, sessionId, turnId, asker, recall },
      {
        runtime: deps.runtime, getTools: deps.getTools, graph: g, now,
        ...(deps.model ? { model: deps.model } : {}), ...(deps.agentTimeoutMs ? { agentTimeoutMs: deps.agentTimeoutMs } : {}),
        ...(deps.embedQuery ? { embedQuery: deps.embedQuery } : {}), ...(deps.readOnly !== undefined ? { readOnly: deps.readOnly } : {}),
      },
      out);
    if (!outcome.ok) failure = "The Chief of Staff could not write the answer.";
  } catch (e) {
    failure = message(e);
    out({ type: "error", message: failure });
  }

  const answer = outcome?.answer ?? "";
  const checks = checkTurn(answer, outcome?.touched ?? new TouchedSet(), { now, question });
  const citations = extractCitations(answer);
  const agents = outcome?.agents ?? [];
  const ms = Date.now() - t0;
  const final: AgentEvent = { type: "final", turnId, answer, citations, checks, agents, ms };
  log.push(final);

  if (g) {
    try {
      const saved = await saveTurn(g, {
        turnId, sessionId, question, answer, asker, at: now, ms, status: failure ? "failed" : "ok", ...(failure ? { error: failure } : {}),
        checks, agents, events: log, touched: outcome?.touched ?? [], citations,
        findings: outcome?.findings ?? [], reviews: outcome?.reviews ?? [],
      });
      if (saved.errors.length) deliver({ type: "error", message: `Saved the turn with ${saved.errors.length} skipped write(s): ${saved.errors[0]}` });
    } catch (e) {
      deliver({ type: "error", message: `Could not save the turn: ${message(e)}` });
    }
  }
  deliver(final);
  return { ok: !failure, turnId, sessionId, answer, citations, checks, agents, ms, ...(outcome ? { outcome } : {}) };
}
