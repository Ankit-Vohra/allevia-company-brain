// Approvals (spec §9): the one service web cards, Discord buttons and the CLI call when the owner decides.
// States: pending -> approved | edited | rejected -> executed | failed. Each status change goes through upsertNode, so
// the earlier state is kept as a Version (Approval.status is TRACKED).
// A decision records, on the Approval:
//   decision ('approve' | 'reject'), decidedAt, decidedBy, editedPayload (JSON),
//   firstPass   approved with no edit (false for an edited or rejected draft): the KPI's numerator
//   decisionMs  how long the card waited for the owner
//   editDistance normalised word-level distance between the card and the owner's edit (0 = unchanged)
// and APPROVED_BY / REJECTED_BY the actor; the Recommendation becomes approved or dismissed.
// An approve with an edit teaches learned rules (learning.ts) before the executor runs; an approve runs the executor
// (executors.ts) on what the owner approved. Then the learning metrics are recorded on the Business.
// Exactly once: the first decision claims the card (decisionToken, in one statement); any later or concurrent
// decision on the same card changes nothing and returns the card as it stands, with its Action.
// onDecision / makeOnDecision is the hook the API server calls: `POST /api/:t/approvals/:id` -> onDecision(tenant, {id,
// decision, editedPayload}).
import { randomBytes } from "node:crypto";
import type { ActionKind } from "../../shared/contracts.js";
import { openGraph, type GraphHandle } from "../graph/client.js";
import { upsertEdge, upsertNode } from "../graph/upsert.js";
import type { LlmRunner } from "../ingest/llm.js";
import { toIso } from "../util/time.js";
import { executeApproval, type ActionView, type ExecutorDeps } from "./executors.js";
import { editDistance, learnFromEdit, recordLearningMetrics, type LearnedEvent, type LearnedRule, type LearningMetrics } from "./learning.js";
import { ensureActor, findBusinessId, parsePayload, type Payload } from "./shared.js";

export type ApprovalStatus = "pending" | "approved" | "edited" | "rejected" | "executed" | "failed";
export type Decision = "approve" | "reject";

export interface ApprovalView {
  id: string;
  kind: ActionKind;
  status: ApprovalStatus;
  title: string;
  by?: string;
  recommendationId?: string;
  payload: Payload;
  editedPayload?: Payload;
  createdAt: string;
  decidedAt?: string;
  decision?: Decision;
  firstPass?: boolean;
  decisionMs?: number;
  editDistance?: number;
  result?: string;
  actionId?: string;
  simulated?: boolean;
}

export interface DecideInput {
  approvalId: string;
  decision: Decision;
  editedPayload?: Partial<Payload> | string;
  actor?: string;          // person:… or agent:…; default person:founder when it exists, else person:owner
  now?: number;
}

export interface DecideDeps {
  tenant: string;
  executors?: Omit<ExecutorDeps, "tenant">;
  llm?: LlmRunner;                              // optional Haiku summary of complex edits (off when absent)
  onLearned?: (e: LearnedEvent) => void;        // the `learned` AgentEvent
}

export interface DecisionResult {
  approval: ApprovalView;
  action: ActionView | null;
  learned?: LearnedRule[];
  metrics?: LearningMetrics;
  alreadyDecided?: boolean;
}

export class ApprovalNotFound extends Error {
  override name = "ApprovalNotFound";
}

type Read = Pick<GraphHandle, "roQuery">;

interface Row { p: Record<string, unknown>; rec: string | null; recBy: string | null; producer: string | null; action: string | null }

async function readRow(g: Read, id: string): Promise<Row | null> {
  const [r] = await g.roQuery<Row>(
    `MATCH (a:Entity:Approval {id:$id})
     OPTIONAL MATCH (rec:Recommendation)-[pp:PROPOSES]->(a) WHERE pp.until IS NULL
     OPTIONAL MATCH (ag:Agent)-[pr:PRODUCED]->(rec) WHERE pr.until IS NULL
     OPTIONAL MATCH (a)-[ri:RESULTED_IN]->(act:Action) WHERE ri.until IS NULL
     RETURN properties(a) AS p, rec.id AS rec, rec.by AS recBy, ag.rosterId AS producer, act.id AS action LIMIT 1`, { id });
  return r ?? null;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function toView(id: string, r: Row): ApprovalView {
  const p = r.p;
  const title = typeof p.title === "string" && p.title ? p.title : String(p.name ?? id).replace(/^[a-z_]+:\s*/, "");
  const payload = parsePayload(p.payload, title);
  const v: ApprovalView = {
    id, kind: p.kind as ActionKind, status: (p.status as ApprovalStatus) ?? "pending", title, payload,
    createdAt: toIso(num(p.createdAt) ?? 0),
  };
  const by = (typeof p.by === "string" && p.by) || r.recBy || r.producer;
  if (by) v.by = by;
  const rec = r.rec ?? (typeof p.recommendation === "string" ? p.recommendation : null);
  if (rec) v.recommendationId = rec;
  if (typeof p.editedPayload === "string") v.editedPayload = parsePayload(p.editedPayload, title);
  if (num(p.decidedAt)) v.decidedAt = toIso(num(p.decidedAt)!);
  if (p.decision === "approve" || p.decision === "reject") v.decision = p.decision;
  if (typeof p.firstPass === "boolean") v.firstPass = p.firstPass;
  if (num(p.decisionMs) !== undefined) v.decisionMs = num(p.decisionMs);
  if (num(p.editDistance) !== undefined) v.editDistance = num(p.editDistance);
  if (typeof p.result === "string") v.result = p.result;
  if (r.action) v.actionId = r.action;
  if (p.simulated === true || payload.simulated === true) v.simulated = true;
  return v;
}

export async function getApproval(g: Read, id: string): Promise<ApprovalView | null> {
  const r = await readRow(g, id);
  return r ? toView(id, r) : null;
}

// Newest first; `status` filters (e.g. "pending").
export async function listApprovals(g: Read, opts: { status?: ApprovalStatus; limit?: number } = {}): Promise<ApprovalView[]> {
  const rows = await g.roQuery<{ id: string }>(
    `MATCH (a:Approval) WHERE $status IS NULL OR a.status = $status RETURN a.id AS id ORDER BY coalesce(a.createdAt, 0) DESC, id LIMIT $limit`,
    { status: opts.status ?? null, limit: Math.max(1, Math.min(500, opts.limit ?? 100)) });
  const out: ApprovalView[] = [];
  for (const r of rows) {
    const v = await getApproval(g, r.id);
    if (v) out.push(v);
  }
  return out;
}

const same = (a: Payload, b: Payload): boolean => a.title.trim() === b.title.trim() && a.body.replace(/\s+/g, " ").trim() === b.body.replace(/\s+/g, " ").trim();

function mergeEdit(original: Payload, edit: DecideInput["editedPayload"]): Payload | undefined {
  if (edit === undefined || edit === null) return undefined;
  const e = typeof edit === "string" ? { body: edit } : edit;
  const merged = { ...original, ...e } as Payload;
  merged.title = typeof merged.title === "string" && merged.title.trim() ? merged.title : original.title;
  merged.body = typeof merged.body === "string" ? merged.body : original.body;
  return merged;
}

export async function decideApproval(g: GraphHandle, input: DecideInput, deps: DecideDeps): Promise<DecisionResult> {
  if (input.decision !== "approve" && input.decision !== "reject") throw new Error(`decision must be "approve" or "reject", got ${JSON.stringify(input.decision)}`);
  const now = input.now ?? Date.now();
  const row = await readRow(g, input.approvalId);
  if (!row) throw new ApprovalNotFound(`no approval ${input.approvalId}`);
  const before = toView(input.approvalId, row);

  // Claim the card. Only the first decision gets a row back; a second one (or a racing one) sees it decided.
  const token = randomBytes(8).toString("hex");
  const claimed = await g.query<{ mine: boolean }>(
    "MATCH (a:Entity:Approval {id:$id}) WHERE a.decisionToken IS NULL AND a.decidedAt IS NULL SET a.decisionToken = $token RETURN a.decisionToken = $token AS mine",
    { id: input.approvalId, token });
  if (!claimed[0]?.mine) {
    const action = before.actionId ? await actionOf(g, before.actionId) : null;
    return { approval: before, action, alreadyDecided: true };
  }

  try {
    return await decideClaimed(g, input, deps, row, before, now);
  } catch (e) {
    // Nothing decided yet (the first write failed): release the card so the owner can try again.
    await g.query("MATCH (a:Entity:Approval {id:$id}) WHERE a.decisionToken = $token AND a.decidedAt IS NULL SET a.decisionToken = null",
      { id: input.approvalId, token }).catch(() => undefined);
    throw e;
  }
}

async function decideClaimed(g: GraphHandle, input: DecideInput, deps: DecideDeps, row: Row, before: ApprovalView, now: number): Promise<DecisionResult> {
  const edited = mergeEdit(before.payload, input.editedPayload);
  const changed = !!edited && !same(before.payload, edited);
  const effective = changed ? edited! : before.payload;
  const firstPass = input.decision === "approve" && !changed;
  const createdAt = num(row.p.createdAt) ?? now;
  const decisionMs = Math.max(0, now - createdAt);
  const distance = changed ? editDistance(`${before.payload.title}\n${before.payload.body}`, `${edited!.title}\n${edited!.body}`) : 0;
  const status: ApprovalStatus = input.decision === "reject" ? "rejected" : changed ? "edited" : "approved";
  const actor = await ensureActor(g, input.actor ?? (await defaultActor(g)), now);
  const name = String(row.p.name ?? `${before.kind}: ${before.title}`);

  await upsertNode(g, {
    type: "Approval", id: input.approvalId, name,
    props: {
      status, decision: input.decision, decidedAt: now, decidedBy: actor, firstPass, decisionMs, editDistance: distance,
      ...(changed ? { editedPayload: JSON.stringify(edited) } : {}),
    },
  }, now);
  await upsertEdge(g, { from: input.approvalId, type: input.decision === "approve" ? "APPROVED_BY" : "REJECTED_BY", to: actor }, now);
  if (before.recommendationId) {
    const [rec] = await g.roQuery<{ name: string }>("MATCH (r:Entity:Recommendation {id:$id}) RETURN r.name AS name", { id: before.recommendationId });
    if (rec) await upsertNode(g, { type: "Recommendation", id: before.recommendationId, name: rec.name, props: { status: input.decision === "approve" ? "approved" : "dismissed" } }, now);
  }

  let learned: LearnedRule[] | undefined;
  if (input.decision === "approve" && changed) {
    learned = await learnFromEdit(g, {
      approvalId: input.approvalId, original: { title: before.payload.title, body: before.payload.body }, edited: { title: edited!.title, body: edited!.body },
      agentId: before.by, channelId: typeof before.payload.channelId === "string" ? before.payload.channelId : undefined, now,
    }, { llm: deps.llm, onLearned: deps.onLearned });
  }

  let action: ActionView | null = null;
  if (input.decision === "approve") {
    action = await executeApproval(g, {
      approvalId: input.approvalId, kind: before.kind, payload: effective, agent: before.by, recommendationId: before.recommendationId, now,
    }, { tenant: deps.tenant, ...deps.executors });
    const after: ApprovalStatus = action.status === "done" ? "executed" : action.status === "failed" ? "failed" : status;
    await upsertNode(g, { type: "Approval", id: input.approvalId, name, props: { status: after, result: action.result, actionId: action.id } }, now);
  }

  const metrics = await recordLearningMetrics(g, await findBusinessId(g, deps.tenant), now);
  const approval = (await getApproval(g, input.approvalId))!;
  return { approval, action, ...(learned ? { learned } : {}), metrics };
}

async function actionOf(g: Read, id: string): Promise<ActionView | null> {
  const [a] = await g.roQuery<{ p: Record<string, unknown> }>("MATCH (a:Entity:Action {id:$id}) RETURN properties(a) AS p", { id });
  if (!a) return null;
  const p = a.p;
  return {
    id, kind: p.kind as ActionKind, status: p.status as ActionView["status"], result: String(p.result ?? ""), at: Number(p.at ?? 0),
    ...(typeof p.url === "string" ? { url: p.url } : {}), ...(p.simulated === true ? { simulated: true } : {}), affects: [], produced: [],
  };
}

async function defaultActor(g: Read): Promise<string> {
  const [p] = await g.roQuery<{ id: string }>(
    "MATCH (p:Entity:Person) WHERE p.id = 'person:founder' OR p.role IN ['founder', 'owner'] RETURN p.id AS id ORDER BY CASE WHEN p.id = 'person:founder' THEN 0 ELSE 1 END, id LIMIT 1");
  return p?.id ?? "person:owner";
}

// ---------- the API hook ----------

// What the API server hands over: the card id and the decision (the web app's ApprovalDecision), or an approval
// record whose status already says approved/edited/rejected.
export interface DecisionRequest {
  id?: string;
  approvalId?: string;
  decision?: Decision;
  status?: string;
  editedPayload?: Partial<Payload> | string;
  actor?: string;
}

export type OnDecision = (tenant: string, approval: DecisionRequest) => Promise<DecisionResult>;

export interface OnDecisionDeps extends Omit<DecideDeps, "tenant"> {
  open?: (tenant: string) => Promise<GraphHandle>;
  now?: () => number;
}

export function makeOnDecision(deps: OnDecisionDeps = {}): OnDecision {
  return async (tenant, req) => {
    const approvalId = req.approvalId ?? req.id;
    if (!approvalId) throw new Error("onDecision: the approval id is missing");
    const decision: Decision | undefined = req.decision
      ?? (req.status === "rejected" ? "reject" : req.status && ["approved", "edited", "executed"].includes(req.status) ? "approve" : undefined);
    if (!decision) throw new Error(`onDecision: no decision for ${approvalId} (decision or status approved/edited/rejected)`);
    const g = await (deps.open ?? openGraph)(tenant);
    return decideApproval(g, { approvalId, decision, editedPayload: req.editedPayload, actor: req.actor, now: deps.now?.() }, { ...deps, tenant });
  };
}

// The default hook: real executors (gh, Discord, drafts on disk), no model, learned events dropped.
export const onDecision: OnDecision = makeOnDecision();
