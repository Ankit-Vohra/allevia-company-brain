// The variants (product design §6, steps 4 and 6). Both start from the same straightened 4:5 frame of the owner's photo
// (straightenedBase), so Nisha can compare each one against exactly what it was made from.
// - A, "Safe": local and free (renderVariantA), never labelled AI.
// - B, "Best bet": one generative edit from the engine (Higgsfield), prompted from the graph, labelled AI-edited.
// Each becomes Asset{kind:'variant'} DERIVED_FROM the original {step, treatment}, PRODUCED by Tara.
import sharp from "sharp";
import type { GraphHandle } from "../graph/client.js";
import { upsertEdge, upsertNode } from "../graph/upsert.js";
import { agentNodeId } from "../agent/memory.js";
import { entityId } from "../util/ids.js";
import { TARA } from "./assess.js";
import type { GenerationEngine } from "./engine.js";
import type { AssessmentOverlay } from "../../shared/contracts.js";
import { dhash, POST_SIZE, renderVariantA, sha256Hex, straightenedBase, type CropPlan } from "./image.js";
import type { AssetRecord } from "./intake.js";
import type { EditPrompt, EditTreatment } from "./prompt.js";
import type { AssetStore } from "./store.js";

export interface VariantRecord extends AssetRecord {
  label: "A" | "B";
  treatment: string;
  step: string;
  aiEdited: boolean;
  engine: string;
  model?: string;
  credits?: number;
  recorded?: boolean;
  jobId?: string;
  buffer: Buffer;
}

const variantId = (originalSha: string, label: string, sha: string) => entityId("Asset", `${originalSha.slice(0, 16)}-${label.toLowerCase()}-${sha.slice(0, 8)}`);

async function saveVariant(
  g: GraphHandle, store: AssetStore, tenant: string, original: AssetRecord, buffer: Buffer,
  v: { label: "A" | "B"; name: string; treatment: string; step: string; aiEdited: boolean; engine: string; extra: Record<string, string | number | boolean | string[]> },
  now: number,
): Promise<VariantRecord> {
  const meta = await sharp(buffer).metadata();
  const sha = sha256Hex(buffer);
  const storageKey = store.put(tenant, sha, buffer);
  const id = variantId(original.sha256, v.label, sha);
  const dh = await dhash(buffer);
  await upsertNode(g, {
    type: "Asset", id, name: v.name,
    props: {
      kind: "variant", label: v.label, mediaType: "image", mime: "image/jpeg", w: meta.width ?? 0, h: meta.height ?? 0, sha256: sha, dhash: dh,
      storageKey, source: v.engine, treatment: v.treatment, step: v.step, aiEdited: v.aiEdited,
      iptcSourceType: v.aiEdited ? "compositeWithTrainedAlgorithmicMedia" : "algorithmicallyEnhanced", status: "proposed", ...v.extra,
    },
  }, now);
  await upsertEdge(g, { from: id, type: "DERIVED_FROM", to: original.id, props: { step: v.step, treatment: v.treatment } }, now);
  await upsertEdge(g, { from: agentNodeId(TARA), type: "PRODUCED", to: id, props: { step: v.step } }, now);
  return {
    id, kind: "variant", w: meta.width ?? 0, h: meta.height ?? 0, sha256: sha, dhash: dh, storageKey, mime: "image/jpeg",
    label: v.label, treatment: v.treatment, step: v.step, aiEdited: v.aiEdited, engine: v.engine, buffer,
  };
}

export async function makeVariantA(
  g: GraphHandle, deps: { store: AssetStore; now: number }, tenant: string, original: AssetRecord, base: Buffer, o: { paper: string; rotate: number },
): Promise<VariantRecord> {
  const r = await renderVariantA(base, o);
  return saveVariant(g, deps.store, tenant, original, r.buffer, {
    label: "A", name: "Variant A: straightened and graded (local)", treatment: r.treatment, step: r.step, aiEdited: false, engine: "local",
    extra: { costUsd: 0 },
  }, deps.now);
}

// The engine edits the owner's whole photo (metadata already stripped), keeping its framing; the code then applies the
// same straighten-and-crop plan as variant A, so A, B and the frame Nisha compares against line up pixel for pixel.
// null when the engine has nothing for this photo (RecordedEngine without a recording): no variant B, and the caller
// says so instead of inventing one.
export async function makeVariantB(
  g: GraphHandle, deps: { store: AssetStore; now: number; engine: GenerationEngine }, tenant: string, original: AssetRecord, originalBuffer: Buffer,
  plan: CropPlan, privacy: AssessmentOverlay[], treatment: EditTreatment, prompt: EditPrompt,
): Promise<VariantRecord | null> {
  const res = await deps.engine.edit({ image: originalBuffer, mime: "image/jpeg", originalSha256: original.sha256 }, prompt.prompt, { treatment: treatment.key, aspect: "same" });
  if (!res) return null;
  const meta = await sharp(res.image).metadata();
  const drift = meta.width && meta.height ? Math.abs(meta.width / meta.height / (original.w / original.h) - 1) : 1;
  if (drift > 0.04) throw new Error(`the edit came back ${meta.width}×${meta.height}, not the photo's shape; it cannot be checked against the original`);
  const full = await sharp(res.image).resize(original.w, original.h, { fit: "fill" }).jpeg({ quality: 95 }).toBuffer();
  const frame = await straightenedBase(full, plan, privacy);
  const buffer = await sharp(frame).resize(POST_SIZE.w, POST_SIZE.h, { fit: "cover", kernel: "lanczos3" }).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
  const rec = await saveVariant(g, deps.store, tenant, original, buffer, {
    label: "B", name: `Variant B: ${treatment.label} (${res.engine === "higgsfield" ? "Higgsfield" : res.engine}, AI-edited)`,
    treatment: `${treatment.label}${res.model ? ` · ${res.model}` : ""}`, step: "generative-edit", aiEdited: true, engine: res.engine,
    extra: {
      treatmentKey: treatment.key, model: res.model, recorded: res.recorded, prompt: res.prompt.slice(0, 4000),
      graphPrompt: prompt.prompt.slice(0, 4000), promptSources: prompt.sources.slice(0, 40),
      ...(res.jobId ? { hfJobId: res.jobId } : {}), ...(res.credits !== undefined ? { hfCredits: res.credits } : {}),
      ...(res.createdAt ? { generatedAt: res.createdAt } : {}),
    },
  }, deps.now);
  return { ...rec, model: res.model, recorded: res.recorded, ...(res.jobId ? { jobId: res.jobId } : {}), ...(res.credits !== undefined ? { credits: res.credits } : {}) };
}
