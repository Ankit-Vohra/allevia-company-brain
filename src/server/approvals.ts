// The owner's decision on an Approval card (spec §9), the same on every surface: the API's POST /api/:t/approvals/:id
// and Discord's Approve/Reject buttons both come through decide(). It runs the action layer (src/actions/approvals.ts):
// the card is claimed once, the decision recorded (status, decidedAt, firstPass, decisionMs, editDistance, the edited
// payload; the pending state kept as a Version), an edit teaches learned rules (each a `learned` AgentEvent), and an
// approve runs the real executor on what was approved. GitHub issues and Discord posts are a dry run unless
// ALLEVIA_ACTIONS_LIVE=1 (or actions.live): the Action records status 'dry_run' and what would have been created.
// content_draft saves a draft (never publishes) and pause_ad only touches simulated campaigns, so those always run.
// Then the optional onDecision hook (a notification): its failure is logged, never the owner's problem.
import type { LearnedEvent } from "../actions/learning.js";
import { ApprovalNotFound, decideApproval } from "../actions/approvals.js";
import type { ActionView, Drafter, ExecutorDeps, GhRunner, HttpFn } from "../actions/executors.js";
import type { LlmRunner } from "../ingest/llm.js";
import { loadConfig } from "../config.js";
import type { GraphHandle } from "../graph/client.js";
import { approval as readApproval } from "./reads.js";
import type { ApprovalDto, ApprovalPayload, DecisionDto } from "./types.js";

export class DecisionError extends Error {
  constructor(readonly status: 404 | 409, message: string) {
    super(message);
  }
}

export interface Decision { decision: "approve" | "reject"; editedPayload?: ApprovalPayload }

// Called after a decision is recorded and its action has run.
export type OnDecision = (tenant: string, approval: ApprovalDto) => Promise<void> | void;

// How approved actions run. Everything is optional: the defaults are the real executors, with GitHub and Discord in
// dry-run mode unless ALLEVIA_ACTIONS_LIVE=1.
export interface ActionOpts {
  live?: boolean;
  gh?: GhRunner;
  http?: HttpFn;
  drafter?: Drafter;
  config?: ExecutorDeps["config"];
  llm?: LlmRunner;            // optional Haiku summary of a complex edit (off when absent)
}

export interface DecideOpts {
  now?: number;
  actor?: string;
  onDecision?: OnDecision;
  actions?: ActionOpts;
  log?: (line: string) => void;
}

export async function decide(g: GraphHandle, tenant: string, id: string, d: Decision, o: DecideOpts = {}): Promise<DecisionDto> {
  const before = await readApproval(g, id);
  if (!before) throw new DecisionError(404, "No such approval.");
  if (before.status !== "pending") throw new DecisionError(409, `${id} was already decided (${before.status}).`);
  const a = o.actions ?? {};
  const executors: Omit<ExecutorDeps, "tenant"> = {
    dryRun: !(a.live ?? loadConfig().actionsLive),
    ...(a.gh ? { gh: a.gh } : {}), ...(a.http ? { http: a.http } : {}), ...(a.drafter ? { drafter: a.drafter } : {}), ...(a.config ? { config: a.config } : {}),
  };
  const learned: LearnedEvent[] = [];
  let action: ActionView | null = null;
  try {
    const r = await decideApproval(g, {
      approvalId: id, decision: d.decision, ...(d.editedPayload ? { editedPayload: { ...d.editedPayload } } : {}), ...(o.actor ? { actor: o.actor } : {}), now: o.now ?? Date.now(),
    }, { tenant, executors, ...(a.llm ? { llm: a.llm } : {}), onLearned: (e) => learned.push(e) });
    if (r.alreadyDecided) throw new DecisionError(409, `${id} was already decided (${r.approval.status}).`);
    action = r.action;
  } catch (e) {
    if (e instanceof ApprovalNotFound) throw new DecisionError(404, "No such approval.");
    throw e;
  }
  const after = (await readApproval(g, id))!;
  if (o.onDecision) {
    try {
      await o.onDecision(tenant, after);
    } catch (e) {
      (o.log ?? ((l: string) => console.error(l)))(`[approvals] onDecision for ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return {
    ...((await readApproval(g, id)) ?? after),
    learned,
    action: action ? { id: action.id, kind: action.kind, status: action.status, result: action.result, ...(action.url ? { url: action.url } : {}), ...(action.simulated ? { simulated: true } : {}) } : null,
  };
}

// The card as it stands after the decision (Discord's buttons need no more).
export async function decideAndNotify(g: GraphHandle, tenant: string, id: string, d: Decision, o: DecideOpts = {}): Promise<ApprovalDto> {
  const { learned: _learned, action: _action, ...card } = await decide(g, tenant, id, d, o);
  return card;
}
