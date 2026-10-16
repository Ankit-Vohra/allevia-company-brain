// "Change" on a stand-up draft: the owner says in their own words what to change ("shorter, and mention the Raipur office"),
// the person who drafted it redrafts, and the card comes back still waiting for the owner's OK. The earlier words are kept
// on the card (previousBody), and how many times it was sent back is counted (changeRequests): a card the owner then
// approves was not approved as it first stood. Only a stand-up card that is still waiting can be changed this way.
import { getApproval } from "../actions/approvals.js";
import type { GraphHandle } from "../graph/client.js";
import { upsertNode } from "../graph/upsert.js";
import { clip, oneLine } from "../insights/text.js";
import type { Drafters, TextKind } from "./draft.js";

const KIND: Record<string, TextKind> = { post: "post", poster: "post", reply: "reply", website_fix: "website_text", follow_up: "follow_up", offer: "offer" };

export type ReviseResult = { ok: true; approvalId: string } | { ok: false; why: string };

export async function reviseDraft(g: GraphHandle, approvalId: string, instruction: string, d: { text: Drafters["text"]; now?: number }): Promise<ReviseResult> {
  const now = d.now ?? Date.now();
  const ask = clip(oneLine(instruction), 600);
  if (!ask) return { ok: false, why: "Tell me what to change, for example \"shorter, and mention the Raipur office\"." };
  const a = await getApproval(g, approvalId);
  if (!a) return { ok: false, why: "That draft is no longer there." };
  if (a.status !== "pending") return { ok: false, why: "That one was already decided." };
  const [row] = await g.roQuery<{ kind: string | null; n: number | null; name: string }>(
    "MATCH (x:Entity:Approval {id:$id}) RETURN x.standupKind AS kind, x.changeRequests AS n, x.name AS name", { id: approvalId });
  if (!row?.kind) return { ok: false, why: "Only your team's drafts from today's note can be changed here. Edit this one in the web app." };
  const kind = KIND[row.kind] ?? "post";
  const t = await d.text({
    agent: a.by ?? "content-strategist", kind,
    brief: `Purpose: redraft this the way the owner asked, keeping what they did not ask to change. The owner asked: ${JSON.stringify(ask)}. The draft: ${JSON.stringify(clip(a.payload.body, 1500))}`,
    facts: [], question: `${ask}\n${a.payload.body}`,
  });
  if (!t.ok || !t.text.trim()) return { ok: false, why: `Your team could not redraft it just now (${t.why ?? "no draft came back"}). Try again in a minute.` };
  const body = [t.text.trim(), ...(t.hashtags.length ? ["", t.hashtags.join(" ")] : []), ...(t.warnings.length ? ["", `Check before you use it: ${t.warnings.join("; ")}.`] : [])].join("\n");
  const payload = { ...a.payload, body, previousBody: a.payload.body };
  await upsertNode(g, {
    type: "Approval", id: approvalId, name: row.name,
    props: { payload: JSON.stringify(payload), changeRequests: (row.n ?? 0) + 1, lastChange: ask, changedAt: now },
  }, now);
  return { ok: true, approvalId };
}
