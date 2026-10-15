// The owner's decision on an Approval card (spec §9). For now a decision only records itself: the Approval's status
// moves pending -> approved | edited | rejected through upsertNode (status is TRACKED, so the pending state is kept as a
// Version), with decidedAt, decisionMs (proposal to decision) and, for an edit, the editedPayload. Executors and the
// learning loop hang off the server's onDecision hook, which runs after this returns.
import type { GraphHandle } from "../graph/client.js";
import { upsertNode } from "../graph/upsert.js";
import { serial } from "../agent/tools/common.js";
import { approval as readApproval } from "./reads.js";
import type { ApprovalDto, ApprovalPayload, ApprovalStatus } from "./types.js";

export class DecisionError extends Error {
  constructor(readonly status: 404 | 409, message: string) {
    super(message);
  }
}

export interface Decision { decision: "approve" | "reject"; editedPayload?: ApprovalPayload }

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// `current` is the stored payload as the card shows it; an approve with an edited payload that differs is "edited".
export async function decideApproval(
  g: GraphHandle, id: string, d: Decision, current: ApprovalPayload, now: number = Date.now(),
): Promise<{ status: ApprovalStatus; decidedAt: number; decisionMs: number }> {
  return serial(`decide:${g.name}`, async () => {
    const [row] = await g.roQuery<{ name: string | null; status: string | null; createdAt: number | null }>(
      "MATCH (a:Approval {id:$id}) RETURN a.name AS name, a.status AS status, a.createdAt AS createdAt LIMIT 1", { id });
    if (!row) throw new DecisionError(404, `No approval ${id}.`);
    if ((row.status ?? "pending") !== "pending") throw new DecisionError(409, `${id} was already decided (${row.status}).`);
    const edited = d.decision === "approve" && d.editedPayload && !sameJson(d.editedPayload, current) ? d.editedPayload : undefined;
    const status: ApprovalStatus = d.decision === "reject" ? "rejected" : edited ? "edited" : "approved";
    const decisionMs = Math.max(0, now - (typeof row.createdAt === "number" ? row.createdAt : now));
    await upsertNode(g, {
      type: "Approval", id, name: row.name || id,
      props: { status, decidedAt: now, decisionMs, ...(edited ? { editedPayload: JSON.stringify(edited) } : {}) },
    }, now);
    return { status, decidedAt: now, decisionMs };
  });
}

// Called after a decision is recorded (ServerDeps.onDecision: executors and the learning loop plug in here).
export type OnDecision = (tenant: string, approval: ApprovalDto) => Promise<void> | void;

// The whole decision as every surface makes it (the API's POST /api/:t/approvals/:id, Discord's Approve/Reject
// buttons): record it, then run the onDecision hook. The hook's failure is logged, never the owner's problem: the
// decision stands. Returns the card as it stands afterwards.
export async function decideAndNotify(
  g: GraphHandle, tenant: string, id: string, d: Decision,
  o: { now?: number; onDecision?: OnDecision; log?: (line: string) => void } = {},
): Promise<ApprovalDto> {
  const before = await readApproval(g, id);
  if (!before) throw new DecisionError(404, "No such approval.");
  await decideApproval(g, id, d, before.payload, o.now ?? Date.now());
  const after = (await readApproval(g, id))!;
  if (o.onDecision) {
    try {
      await o.onDecision(tenant, after);
    } catch (e) {
      (o.log ?? ((l: string) => console.error(l)))(`[approvals] onDecision for ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return (await readApproval(g, id)) ?? after;
}
