// The owner's decision on an Approval card (spec §9), the same on every surface: the API's POST /api/:t/approvals/:id
// and Discord's Approve/Reject buttons both come through decide(). It runs the action layer (src/actions/approvals.ts):
// the card is claimed once, the decision recorded (status, decidedAt, firstPass, decisionMs, editDistance, the edited
// payload; the pending state kept as a Version), an edit teaches learned rules (each a `learned` AgentEvent), and an
// approve runs the real executor on what was approved. GitHub issues and Discord posts are a dry run unless
// ALLEVIA_ACTIONS_LIVE=1 (or actions.live): the Action records status 'dry_run' and what would have been created.
// content_draft saves a draft (never publishes) and pause_ad only touches simulated campaigns, so those always run.
// Then the optional onDecision hook (a notification): its failure is logged, never the owner's problem.
// Credits (src/credits): saying OK spends what the card costs (shared/credits.ts approvalCharges: a draft or a booking 1, a
// Studio picture 5, an ad 15, a clip 40), once per card, linked -[:FOR]-> the card. The check comes first: with no credits
// left the OK is refused (OutOfCredits, a 402) and the card stays waiting; with some left it goes through even when the card
// costs more, so the balance goes below zero by at most that one card. "No thanks" costs nothing.
import { approvalCharges, studioBlockOf, type StudioPriceCard } from "../../shared/credits.js";
import { credits as processCredits, type Credits, type Hold } from "../credits/index.js";
import type { LearnedEvent } from "../actions/learning.js";
import { ApprovalNotFound, decideApproval } from "../actions/approvals.js";
import type { ActionView, Drafter, ExecutorDeps, GhRunner, HttpFn } from "../actions/executors.js";
import type { ConnectionsPort } from "../connections/service.js";
import type { PublishRuntime } from "../publish/executor.js";
import { toDto } from "../publish/dto.js";
import { postOfApproval } from "../publish/record.js";
import { demoConnections, isSalesDemo } from "../sales/demo.js";
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

// variantId: the Studio option the owner picked (its price can differ: an ad, a clip); absent, the recommended one.
export interface Decision { decision: "approve" | "reject"; editedPayload?: ApprovalPayload; variantId?: string }

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
  connections?: (tenant: string) => ConnectionsPort | undefined; // a business's connections for calendar_event, email_send and publish_post (default: the server's own)
  publish?: (tenant: string) => PublishRuntime | undefined;      // how a post's picture is made reachable and the daily limit (default: from the server's config)
  llm?: LlmRunner;            // optional Haiku summary of a complex edit (off when absent)
}

export interface DecideOpts {
  now?: number;
  actor?: string;
  by?: string;                  // who said OK, for the credits page (a user id, "owner", "member"); default the actor, else the owner
  credits?: Credits;            // default: this process's (src/credits)
  onDecision?: OnDecision;
  actions?: ActionOpts;
  log?: (line: string) => void;
}

/** What an executor needs for one business: a dry run unless real actions are on, the business's connections, and the posting runtime. */
export function executorsFor(tenant: string, a: ActionOpts = {}): Omit<ExecutorDeps, "tenant"> {
  return {
    dryRun: !(a.live ?? loadConfig().actionsLive),
    ...(a.gh ? { gh: a.gh } : {}), ...(a.http ? { http: a.http } : {}), ...(a.drafter ? { drafter: a.drafter } : {}), ...(a.config ? { config: a.config } : {}),
    ...(a.connections?.(tenant) ? { connections: a.connections(tenant)! } : isSalesDemo(tenant) ? { connections: demoConnections(tenant) } : {}),
    ...(a.publish?.(tenant) ? { publish: a.publish(tenant)! } : {}),
  };
}

export async function decide(g: GraphHandle, tenant: string, id: string, d: Decision, o: DecideOpts = {}): Promise<DecisionDto> {
  const before = await readApproval(g, id);
  if (!before) throw new DecisionError(404, "No such approval.");
  if (before.status !== "pending") throw new DecisionError(409, `${id} was already decided (${before.status}).`);
  const a = o.actions ?? {};
  const executors = executorsFor(tenant, a);
  const learned: LearnedEvent[] = [];
  let action: ActionView | null = null;
  // what saying OK costs, checked before anything is recorded (a 402 leaves the card waiting)
  const cr = o.credits ?? processCredits();
  const charges = d.decision === "approve" ? approvalCharges(before.kind, ...(await studioOf(g, id, d.variantId))) : [];
  const hold: Hold | undefined = charges.length ? await cr.hold(tenant, charges[0]!.service, { g }) : undefined;
  try {
    const r = await decideApproval(g, {
      approvalId: id, decision: d.decision, ...(d.editedPayload ? { editedPayload: { ...d.editedPayload } } : {}), ...(o.actor ? { actor: o.actor } : {}), now: o.now ?? Date.now(),
    }, { tenant, executors, ...(a.llm ? { llm: a.llm } : {}), onLearned: (e) => learned.push(e) });
    if (r.alreadyDecided) throw new DecisionError(409, `${id} was already decided (${r.approval.status}).`);
    action = r.action;
  } catch (e) {
    hold?.release();
    if (e instanceof ApprovalNotFound) throw new DecisionError(404, "No such approval.");
    throw e;
  }
  if (hold) {
    // the decision stands whatever happens here: a charge that fails is logged
    const by = o.by ?? o.actor ?? "owner";
    try {
      for (const [i, c] of charges.entries()) {
        const spend = { ref: id, by, for: [id], ...(c.part ? { part: c.part } : {}) };
        if (i === 0) await hold.commit({ ...spend, service: c.service });
        else await cr.spend(tenant, c.service, { ...spend, g, allowNegative: true });
      }
    } catch (e) {
      hold.release();
      (o.log ?? ((l: string) => console.error(l)))(`[approvals] ${id} was approved but not charged: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const after = (await readApproval(g, id))!;
  if (o.onDecision) {
    try {
      await o.onDecision(tenant, after);
    } catch (e) {
      (o.log ?? ((l: string) => console.error(l)))(`[approvals] onDecision for ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const made = before.kind === "publish_post" && d.decision === "approve" ? await postOfApproval(g, id).catch(() => null) : null;
  return {
    ...((await readApproval(g, id)) ?? after),
    ...(made ? { post: toDto(made, o.now ?? Date.now()) } : {}),
    learned,
    action: action ? { id: action.id, kind: action.kind, status: action.status, result: action.result, ...(action.url ? { url: action.url } : {}), ...(action.simulated ? { simulated: true } : {}) } : null,
  };
}

// The Studio block of a card (its price depends on the option picked) and which option: the one named, the one stored when a
// card that posts was picked (studio/approve.ts), else the recommended one.
async function studioOf(g: GraphHandle, id: string, variantId?: string): Promise<[StudioPriceCard | null, string | undefined]> {
  const [row] = await g.roQuery<{ payload: string | null; chosen: string | null }>(
    "MATCH (a:Entity:Approval {id:$id}) RETURN a.payload AS payload, a.chosenVariant AS chosen", { id });
  return [studioBlockOf(row?.payload), variantId ?? row?.chosen ?? undefined];
}

// The card as it stands after the decision (Discord's buttons need no more).
export async function decideAndNotify(g: GraphHandle, tenant: string, id: string, d: Decision, o: DecideOpts = {}): Promise<ApprovalDto> {
  const { learned: _learned, action: _action, ...card } = await decide(g, tenant, id, d, o);
  return card;
}
