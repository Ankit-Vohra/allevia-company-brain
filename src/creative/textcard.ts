// A made piece of writing (a reel script) waits for the owner as an ordinary content_draft card: the same Recommendation
// and Approval the propose_action tool raises, so Approve writes the draft file and nothing is posted. The Studio's
// picture cards (deliverable.ts) are for things with a file; this is for text.
import { agentNodeId } from "../agent/memory.js";
import { serial } from "../agent/tools/common.js";
import type { GraphHandle } from "../graph/client.js";
import { upsertEdge, upsertNode } from "../graph/upsert.js";
import { entityId, sha256 } from "../util/ids.js";
import { isoDate } from "../util/time.js";

export async function saveTextDraft(
  g: GraphHandle, o: { agentId: string; turnId: string; now: number; title: string; body: string; target: string; why: string; evidence?: string[] },
): Promise<{ recommendationId: string; approvalId: string }> {
  const short = sha256(`${o.title}\n${o.body}`).slice(0, 12);
  const recId = entityId("Recommendation", `made text ${short}`);
  const asOf = isoDate(o.now);
  const src = `turn:${o.turnId}`;
  const approvalId = await serial(g.name, async () => {
    const [pending] = await g.roQuery<{ id: string }>(
      "MATCH (:Entity:Recommendation {id:$rid})-[p:PROPOSES]->(a:Approval) WHERE p.until IS NULL AND a.status = 'pending' RETURN a.id AS id ORDER BY a.id LIMIT 1", { rid: recId });
    const id = pending?.id ?? `approval:made-${short}-${o.now.toString(36)}`;
    await upsertNode(g, { type: "Recommendation", id: recId, name: o.title, summary: o.why.slice(0, 1000), props: { status: "open", kind: "content_draft", by: o.agentId, area: "content", confidence: 0.6, score: 0.6 }, src, asOf }, o.now);
    await upsertNode(g, { type: "Approval", id, name: `content_draft: ${o.title}`, props: { status: "pending", kind: "content_draft", title: o.title, payload: JSON.stringify({ title: o.title, body: o.body, target: o.target }), recommendation: recId }, src, asOf }, o.now);
    await upsertEdge(g, { from: recId, type: "PROPOSES", to: id, src, asOf }, o.now);
    for (const e of (o.evidence ?? []).slice(0, 10)) await upsertEdge(g, { from: recId, type: "EVIDENCED_BY", to: e, src, asOf }, o.now).catch(() => undefined);
    await upsertEdge(g, { from: agentNodeId(o.agentId), type: "PRODUCED", to: recId, src, asOf }, o.now).catch(() => undefined);
    return id;
  });
  return { recommendationId: recId, approvalId };
}
