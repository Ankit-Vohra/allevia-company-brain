// Everything the team makes on request becomes graph nodes with lineage, and a card waiting for the owner's OK:
//   Asset{kind: poster|image|clip|artwork}  -DERIVED_FROM->  the picture it was made from (the artwork, or the owner's photo)
//                                           -USES_ASSET->    the logo and font files it was drawn with (BrandAsset)
//                                           -GUIDED_BY->     the brand rules that shaped it
//   the agent PRODUCED it, the fact checker REVIEWED it
//   Recommendation -PROPOSES-> Approval{content_draft} whose payload is the same card the Studio uses (studio/approve.ts),
//   so Approve works from the web's Studio card, the Approvals list and Discord's buttons, and approving writes the draft
//   post (Content -USES_ASSET-> the chosen option). Nothing posts anywhere: a draft and a file are all there is.
import { CREDIT_COSTS } from "../../shared/plans.js";
import type { DeliverableKind, DeliverableOption } from "../../shared/contracts.js";
import { agentNodeId } from "../agent/memory.js";
import { serial } from "../agent/tools/common.js";
import type { GraphHandle } from "../graph/client.js";
import { upsertEdge, upsertNode } from "../graph/upsert.js";
import { sha256Hex, thumbnail } from "../studio/image.js";
import { assetUrl } from "../studio/intake.js";
import type { StudioPayload } from "../studio/approve.js";
import type { AssetStore } from "../studio/store.js";
import { entityId } from "../util/ids.js";
import { isoDate } from "../util/time.js";
import { NISHA } from "./compose/check.js";

export interface OptionToSave {
  label: string;
  buffer: Buffer;
  mime: "image/jpeg" | "image/png" | "video/mp4";
  w: number;
  h: number;
  badge: "ok" | "held" | "unchecked";
  note: string;
  layout?: string;
  aiEdited: boolean;
  artworkId?: string;                  // the generated artwork this was composed on (its DERIVED_FROM parent)
  extra?: Record<string, string | number | boolean | string[]>;
  words?: string;                      // what is printed on it, for the card and search
}

export interface SaveRequest {
  kind: DeliverableKind;
  title: string;                       // "Diwali sale poster"
  caption: string;                     // the post text that goes with it
  altText: string;
  aspect: string;                      // "4:5"
  channel: string;                     // instagram | instagram story | print
  format?: string;
  request: string;                     // the owner's words
  options: OptionToSave[];
  recommendedLabel?: string;
  parentId?: string;                   // the owner's photo, when it is the hero
  usesBrand: string[];                 // BrandAsset ids used (logo, fonts)
  promotes?: string;                   // the graph node the brief sells (a product, a feature)
  guidedBy: string[];                  // BrandRule ids
  notes: string[];
  hfCredits: number;
}

export interface SaveDeps { store: AssetStore; tenant: string; agentId: string; turnId: string; now: number }

export interface SavedDeliverable {
  recommendationId: string;
  approvalId: string;
  options: DeliverableOption[];
  recommended: string;
  title: string;
  credits: number;
}

const BADGE = { ok: "unchanged", held: "held", ["unchecked"]: "unchecked" } as const;
const EXT = { "image/jpeg": "jpg", "image/png": "png", "video/mp4": "mp4" } as const;
const KIND_CREDITS: Record<DeliverableKind, number> = { poster: CREDIT_COSTS.static_post, image: CREDIT_COSTS.static_post, clip: CREDIT_COSTS.reel };

// A generated or supplied picture that other things are made from (the artwork behind a poster). Not a card by itself.
export async function saveArtwork(
  g: GraphHandle, deps: SaveDeps, a: { buffer: Buffer; engine: string; model: string; prompt: string; jobId?: string; credits?: number; recorded: boolean; scene: string; w: number; h: number },
): Promise<string> {
  const sha = sha256Hex(a.buffer);
  const storageKey = deps.store.put(deps.tenant, sha, a.buffer, "jpg");
  const id = entityId("Asset", `artwork ${sha.slice(0, 16)}`);
  await upsertNode(g, {
    type: "Asset", id, name: `Artwork: ${a.scene.slice(0, 60)}`,
    props: {
      kind: "artwork", mediaType: "image", mime: "image/jpeg", w: a.w, h: a.h, sha256: sha, storageKey, source: a.engine, aiEdited: true,
      iptcSourceType: "trainedAlgorithmicMedia", status: "proposed", model: a.model, prompt: a.prompt.slice(0, 4000), recorded: a.recorded,
      ...(a.jobId ? { hfJobId: a.jobId } : {}), ...(a.credits !== undefined ? { hfCredits: a.credits } : {}), generatedAt: deps.now,
    },
  }, deps.now);
  await upsertEdge(g, { from: agentNodeId(deps.agentId), type: "PRODUCED", to: id, props: { step: "generate" } }, deps.now).catch(() => undefined);
  return id;
}

export async function saveDeliverable(g: GraphHandle, deps: SaveDeps, r: SaveRequest): Promise<SavedDeliverable> {
  const saved: Array<{ o: OptionToSave; id: string; sha: string }> = [];
  for (const o of r.options) {
    const sha = sha256Hex(o.buffer);
    const storageKey = deps.store.put(deps.tenant, sha, o.buffer, EXT[o.mime]);
    const id = entityId("Asset", `${r.kind} ${sha.slice(0, 16)}`);
    await upsertNode(g, {
      type: "Asset", id, name: `${r.title}: option ${o.label}`,
      props: {
        kind: r.kind, label: o.label, mediaType: o.mime === "video/mp4" ? "video" : "image", mime: o.mime, w: o.w, h: o.h, bytes: o.buffer.length, sha256: sha, storageKey,
        source: "creative", madeBy: deps.agentId, aiEdited: o.aiEdited, status: "proposed", check: o.badge, checkNote: o.note.slice(0, 400), checkedBy: NISHA,
        request: r.request.slice(0, 400), ...(r.format ? { format: r.format } : {}), ...(o.layout ? { layout: o.layout } : {}), ...(o.words ? { words: o.words.slice(0, 500) } : {}),
        iptcSourceType: o.aiEdited ? "compositeWithTrainedAlgorithmicMedia" : "algorithmicallyEnhanced", ...(o.extra ?? {}),
      },
    }, deps.now);
    const parent = o.artworkId ?? r.parentId;
    if (parent) await upsertEdge(g, { from: id, type: "DERIVED_FROM", to: parent, props: { step: o.artworkId ? "composite-on-artwork" : "composite-on-photo", ...(o.layout ? { layout: o.layout } : {}) } }, deps.now).catch(() => undefined);
    for (const b of r.usesBrand) await upsertEdge(g, { from: id, type: "USES_ASSET", to: b }, deps.now).catch(() => undefined);
    if (r.promotes) await upsertEdge(g, { from: id, type: "PROMOTES", to: r.promotes }, deps.now).catch(() => undefined);
    for (const rule of r.guidedBy.slice(0, 8)) await upsertEdge(g, { from: id, type: "GUIDED_BY", to: rule }, deps.now).catch(() => undefined);
    await upsertEdge(g, { from: agentNodeId(deps.agentId), type: "PRODUCED", to: id, props: { step: "make" } }, deps.now).catch(() => undefined);
    await upsertEdge(g, { from: agentNodeId(NISHA), type: "REVIEWED", to: id, props: { verdict: o.badge } }, deps.now).catch(() => undefined);
    saved.push({ o, id, sha });
  }

  const first = saved[0]!;
  const rec = r.recommendedLabel ? saved.find((s) => s.o.label === r.recommendedLabel) : undefined;
  const recommended = (rec ?? saved.find((s) => s.o.badge === "ok") ?? saved.find((s) => s.o.badge === "unchecked") ?? first).id;
  const options: DeliverableOption[] = saved.map((s) => ({
    assetId: s.id, label: s.o.label, badge: s.o.badge, note: s.o.note, thumb: assetUrl(deps.tenant, s.id, 640), ...(s.o.layout ? { layout: s.o.layout } : {}), aiEdited: s.o.aiEdited,
  }));
  const credits = KIND_CREDITS[r.kind];
  const payload: StudioPayload = {
    title: r.title, body: r.caption, target: r.channel,
    studio: {
      originalId: saved.find((s) => s.o.artworkId)?.o.artworkId ?? r.parentId ?? first.id,
      variants: saved.map((s) => ({ id: s.id, label: s.o.label, badge: BADGE[s.o.badge], note: s.o.note, aiEdited: s.o.aiEdited })),
      recommended, altText: r.altText, hashtags: [], credits, voiceRuleIds: r.guidedBy.filter((x) => x.startsWith("brand-rule:")),
      creative: { kind: r.kind, aspect: r.aspect, channel: r.channel === "instagram story" ? "instagram" : r.channel, by: deps.agentId, allowUnchecked: true, ...(r.format ? { format: r.format } : {}) },
    },
  };
  const short = first.sha.slice(0, 12);
  const recId = entityId("Recommendation", `made ${r.kind} ${short}`);
  const why = [
    `Made on request: ${JSON.stringify(r.request.slice(0, 200))}.`,
    ...saved.map((s) => `Option ${s.o.label}: ${s.o.badge === "ok" ? "Nisha checked it" : s.o.badge === "held" ? `Nisha held it back (${s.o.note})` : "not double-checked"}.`),
    ...r.notes.slice(0, 3),
    `Uses ${credits} credit${credits === 1 ? "" : "s"} on approval.`,
  ].join(" ");
  const asOf = isoDate(deps.now);
  const src = `turn:${deps.turnId}`;
  const approvalId = await serial(g.name, async () => {
    const [pending] = await g.roQuery<{ id: string }>(
      "MATCH (:Entity:Recommendation {id:$rid})-[p:PROPOSES]->(a:Approval) WHERE p.until IS NULL AND a.status = 'pending' RETURN a.id AS id ORDER BY a.id LIMIT 1", { rid: recId });
    const id = pending?.id ?? `approval:made-${short}-${deps.now.toString(36)}`;
    await upsertNode(g, { type: "Recommendation", id: recId, name: r.title, summary: why.slice(0, 1000), props: { status: "open", kind: "content_draft", by: deps.agentId, area: "content", confidence: saved.some((s) => s.o.badge === "ok") ? 0.8 : 0.4, score: 0.8 }, src, asOf }, deps.now);
    await upsertNode(g, { type: "Approval", id, name: `content_draft: ${r.title}`, props: { status: "pending", kind: "content_draft", title: r.title, payload: JSON.stringify(payload), recommendation: recId, studio: true, creative: true }, src, asOf }, deps.now);
    await upsertEdge(g, { from: recId, type: "PROPOSES", to: id, src, asOf }, deps.now);
    for (const s of saved) await upsertEdge(g, { from: recId, type: "EVIDENCED_BY", to: s.id, src, asOf }, deps.now);
    await upsertEdge(g, { from: agentNodeId(deps.agentId), type: "PRODUCED", to: recId, src, asOf }, deps.now).catch(() => undefined);
    return id;
  });
  void thumbnail;
  return { recommendationId: recId, approvalId, options, recommended, title: r.title, credits };
}
