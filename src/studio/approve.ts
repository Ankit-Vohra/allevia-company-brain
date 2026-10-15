// The Studio's approval card and what approving it does (product design §6, steps 8 and 9).
// - proposeStudioDraft: Tara's Recommendation and a pending Approval{kind:'content_draft'} whose payload is the card:
//   title, Dev's caption, and the studio block (the original, the variants with Nisha's badges, the recommended one).
// - finalizeStudioDraft (on approve): Content{format:'post', status:'draft'} -USES_ASSET-> the chosen variant; the
//   variant (and the original) DEPICTS the project Page when the note named one; Approval -RESULTED_IN-> Action
//   -RESULTED_IN-> Content; the credits the post would cost recorded as Observations (credits_charged, usd_cost).
//   Credits are spent only on approval: a rejected card costs nothing (§4.2). Nothing is published.
import { CREDIT_COSTS } from "../../shared/plans.js";
import type { GraphHandle } from "../graph/client.js";
import { addObservation, upsertEdge, upsertNode } from "../graph/upsert.js";
import { agentNodeId } from "../agent/memory.js";
import { serial } from "../agent/tools/common.js";
import { entityId } from "../util/ids.js";
import { isoDate } from "../util/time.js";
import { decideApproval, DecisionError } from "../server/approvals.js";
import { TARA, type PhotoAssessment } from "./assess.js";
import { DEV, type Caption } from "./caption.js";
import type { StudioContext } from "./context.js";
import type { FidelityResult } from "./fidelity.js";
import type { AssetRecord } from "./intake.js";
import type { VariantRecord } from "./variants.js";

// Appendix B.3: a post (1 credit) costs about $0.50 all-in: variant A $0, one generative edit about $0.15, 15% retries,
// Claude vision, prompt and QA about $0.10.
export const POST_COST_USD = 0.5;
export const POST_COST_EVIDENCE = "Product design Appendix B.3: a post costs about $0.50 all-in (local variant $0, one generative edit about $0.15, 15% retries, Claude vision and QA about $0.10).";

export interface StudioCard {
  originalId: string;
  variants: Array<{ id: string; label: string; badge: string; note: string; aiEdited: boolean }>;
  recommended: string;
  altText: string;
  hashtags: string[];
  credits: number;
  projectId?: string;
  pageId?: string;
  voiceRuleIds: string[];
}

export interface StudioPayload { title: string; body: string; target: string; studio: StudioCard }

export function recommendVariant(variants: VariantRecord[], fidelity: FidelityResult[]): VariantRecord | undefined {
  const ok = (v: VariantRecord) => fidelity.find((f) => f.assetId === v.id)?.badge === "unchanged";
  return variants.find((v) => v.label === "B" && ok(v)) ?? variants.find((v) => v.label === "A" && ok(v)) ?? variants.find((v) => v.label === "A");
}

export async function proposeStudioDraft(
  g: GraphHandle,
  o: { original: AssetRecord; variants: VariantRecord[]; fidelity: FidelityResult[]; caption: Caption; ctx: StudioContext; assessment: PhotoAssessment; now: number },
): Promise<{ recommendationId: string; approvalId: string; title: string; payload: StudioPayload }> {
  const short = o.original.sha256.slice(0, 12);
  const recId = entityId("Recommendation", `studio ${short}`);
  const subject = o.ctx.project?.name ?? o.assessment.subject;
  const title = `Post the ${subject} photo`;
  const rec = recommendVariant(o.variants, o.fidelity);
  const body = [o.caption.caption, o.caption.hashtags.join(" ")].filter(Boolean).join("\n\n");
  const studio: StudioCard = {
    originalId: o.original.id,
    variants: o.variants.map((v) => {
      const f = o.fidelity.find((x) => x.assetId === v.id);
      return { id: v.id, label: v.label, badge: f?.badge ?? "unchecked", note: f?.note ?? "", aiEdited: v.aiEdited };
    }),
    recommended: rec?.id ?? "", altText: o.caption.altText, hashtags: o.caption.hashtags, credits: CREDIT_COSTS.static_post,
    ...(o.ctx.project ? { projectId: o.ctx.project.contentId, ...(o.ctx.project.pageId ? { pageId: o.ctx.project.pageId } : {}) } : {}),
    voiceRuleIds: o.ctx.brand.voiceRules.map((r) => r.id),
  };
  const payload: StudioPayload = { title, body, target: "instagram", studio };
  const why = [
    `Tara: ${o.assessment.verdict} (${o.assessment.subject}).`,
    rec ? `Variant ${rec.label} recommended; Nisha: ${o.fidelity.find((f) => f.assetId === rec.id)?.note ?? "not checked"}.` : "No variant passed Nisha's check.",
    `Uses ${CREDIT_COSTS.static_post} Studio credit on approval.`,
  ].join(" ");
  return serial(g.name, async () => {
    const [pending] = await g.roQuery<{ id: string }>(
      "MATCH (:Recommendation {id:$rid})-[p:PROPOSES]->(a:Approval) WHERE p.until IS NULL AND a.status = 'pending' RETURN a.id AS id ORDER BY a.id LIMIT 1", { rid: recId });
    const approvalId = pending?.id ?? `approval:studio-${short}-${o.now.toString(36)}`;
    const src = `studio:${short}`;
    const asOf = isoDate(o.now);
    await upsertNode(g, {
      type: "Recommendation", id: recId, name: title, summary: why,
      props: { status: "open", kind: "content_draft", by: TARA, area: "content", confidence: rec ? 0.8 : 0.3, score: rec ? 0.8 : 0.3 }, src, asOf,
    }, o.now);
    await upsertNode(g, {
      type: "Approval", id: approvalId, name: `content_draft: ${title}`,
      props: { status: "pending", kind: "content_draft", title, payload: JSON.stringify(payload), recommendation: recId, studio: true }, src, asOf,
    }, o.now);
    await upsertEdge(g, { from: recId, type: "PROPOSES", to: approvalId, src, asOf }, o.now);
    for (const id of [o.original.id, ...o.variants.map((v) => v.id)]) await upsertEdge(g, { from: recId, type: "EVIDENCED_BY", to: id, src, asOf }, o.now);
    await upsertEdge(g, { from: agentNodeId(TARA), type: "PRODUCED", to: recId, src, asOf }, o.now);
    return { recommendationId: recId, approvalId, title, payload };
  });
}

// The stored card, or null when the approval is not a Studio card.
export async function studioCard(g: GraphHandle, approvalId: string): Promise<{ status: string; payload: StudioPayload } | null> {
  const [row] = await g.roQuery<{ status: string | null; payload: string | null }>(
    "MATCH (a:Approval {id:$id}) RETURN a.status AS status, a.payload AS payload", { id: approvalId });
  if (!row?.payload) return null;
  try {
    const p = JSON.parse(row.payload) as StudioPayload;
    return p?.studio?.originalId ? { status: row.status ?? "pending", payload: p } : null;
  } catch {
    return null;
  }
}

export interface ApproveInput { approvalId: string; variantId?: string; caption?: string; now: number }

// Records the owner's approval (decideApproval: pending -> approved | edited) and writes the draft.
export async function approveStudioDraft(g: GraphHandle, input: ApproveInput): Promise<{ contentId: string; status: string; variantId: string }> {
  const card = await studioCard(g, input.approvalId);
  if (!card) throw new DecisionError(404, `No Studio card ${input.approvalId}.`);
  if (card.status !== "pending") throw new DecisionError(409, `${input.approvalId} was already decided (${card.status}).`);
  const variantId = input.variantId ?? card.payload.studio.recommended;
  const v = card.payload.studio.variants.find((x) => x.id === variantId);
  if (!v) throw new DecisionError(404, `${variantId} is not one of this card's variants.`);
  if (v.badge !== "unchanged") throw new DecisionError(409, `Nisha held variant ${v.label} back (${v.note || v.badge}); pick a variant marked "building unchanged".`);
  const current = { title: card.payload.title, body: card.payload.body, target: card.payload.target };
  const caption = input.caption?.trim();
  const edited = caption && caption !== current.body ? { ...current, body: caption.slice(0, 5000) } : undefined;
  const d = await decideApproval(g, input.approvalId, { decision: "approve", ...(edited ? { editedPayload: edited } : {}) }, current, input.now);
  const contentId = await finalizeStudioDraft(g, input.approvalId, card.payload, variantId, edited?.body ?? current.body, input.now);
  return { contentId, status: d.status, variantId };
}

export async function finalizeStudioDraft(g: GraphHandle, approvalId: string, p: StudioPayload, variantId: string, body: string, now: number): Promise<string> {
  const s = p.studio;
  const [orig] = await g.roQuery<{ sha: string | null }>("MATCH (a:Asset {id:$id}) RETURN a.sha256 AS sha", { id: s.originalId });
  const short = (orig?.sha ?? s.originalId.replace(/^asset:/, "")).slice(0, 12);
  const contentId = entityId("Content", `post ${short}`);
  const actionId = entityId("Action", `studio draft ${short}`);
  const src = approvalId;
  const asOf = isoDate(now);
  const v = s.variants.find((x) => x.id === variantId);
  await upsertNode(g, {
    type: "Content", id: contentId, name: p.title.replace(/^Post the /, "Post: ").replace(/ photo$/, ""), summary: body.slice(0, 600),
    props: {
      format: "post", status: "draft", channel: "instagram", caption: body.slice(0, 5000), altText: s.altText, aspect: "4:5",
      assetId: variantId, aiEdited: v?.aiEdited ?? false, createdBy: "studio",
    }, src, asOf,
  }, now);
  await upsertNode(g, { type: "Action", id: actionId, name: `Saved the draft post ${contentId}`, props: { kind: "content_draft", status: "done", at: now }, src, asOf }, now);
  await upsertEdge(g, { from: approvalId, type: "RESULTED_IN", to: actionId, src, asOf }, now);
  await upsertEdge(g, { from: actionId, type: "RESULTED_IN", to: contentId, src, asOf }, now);
  await upsertEdge(g, { from: contentId, type: "USES_ASSET", to: variantId, src, asOf }, now);
  await upsertEdge(g, { from: agentNodeId(TARA), type: "PRODUCED", to: contentId, src, asOf }, now);
  await upsertEdge(g, { from: agentNodeId(DEV), type: "AUTHORED", to: contentId, props: { part: "caption" }, src, asOf }, now);
  for (const r of s.voiceRuleIds.slice(0, 8)) await upsertEdge(g, { from: contentId, type: "GUIDED_BY", to: r, src, asOf }, now).catch(() => undefined);
  if (s.projectId) await upsertEdge(g, { from: contentId, type: "PROMOTES", to: s.projectId, src, asOf }, now).catch(() => undefined);
  if (s.pageId) {
    for (const a of [variantId, s.originalId]) await upsertEdge(g, { from: a, type: "DEPICTS", to: s.pageId, src, asOf }, now).catch(() => undefined);
  }
  // asset states: the chosen variant approved, the others declined, the original used
  const assets = await g.roQuery<{ id: string; name: string }>("MATCH (a:Asset) WHERE a.id IN $ids RETURN a.id AS id, a.name AS name",
    { ids: [s.originalId, ...s.variants.map((x) => x.id)] });
  for (const a of assets) {
    const status = a.id === variantId ? "approved" : a.id === s.originalId ? "used" : "declined";
    await upsertNode(g, { type: "Asset", id: a.id, name: a.name, props: { status } }, now);
  }
  await addObservation(g, { subject: contentId, metric: "credits_charged", value: s.credits, unit: "credits", asOf, src: approvalId, evidence: "Product design §4.2: a static post uses 1 Studio credit, spent on approval." }, now);
  await addObservation(g, { subject: contentId, metric: "usd_cost", value: POST_COST_USD, unit: "USD", asOf, src: approvalId, conf: 0.5, evidence: POST_COST_EVIDENCE }, now);
  const [ap] = await g.roQuery<{ name: string }>("MATCH (a:Approval {id:$id}) RETURN a.name AS name", { id: approvalId });
  await upsertNode(g, { type: "Approval", id: approvalId, name: ap?.name ?? approvalId, props: { result: `Draft post saved (${contentId}); not published.`, contentId } }, now);
  return contentId;
}
