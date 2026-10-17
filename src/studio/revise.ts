// A text reply under the variants ("make it warmer") adjusts the NEXT variant. The owner's words become a small, local
// change of light and colour (warmer or cooler, lighter or darker, more or less contrast, more or less colour),
// applied on top of the latest local variant, so "warmer" and then "a bit more" add up. It becomes a new Asset{kind:
// 'variant'} DERIVED_FROM the original (and from the variant it adjusted, with the words kept), PRODUCED by Miss Influencer, checked
// by Fact Checker against the same straightened frame as every other variant, and added to the pending card so it can be
// approved like the others. Nothing here calls a generative model: asking for a change to what is IN the photo is said
// plainly to be something the team cannot do yet, not faked.
import sharp from "sharp";
import type { GraphHandle } from "../graph/client.js";
import { upsertEdge, upsertNode } from "../graph/upsert.js";
import { TARA, parseAssessment, type PhotoAssessment } from "./assess.js";
import { studioCard, type StudioPayload } from "./approve.js";
import { loadStudioContext } from "./context.js";
import { readPrivacy } from "./privacy.js";
import { loadStudioSettings } from "./settings.js";
import { checkFidelity, type FidelityResult } from "./fidelity.js";
import { estimateTilt, planCrop, straightenedBase, dhash } from "./image.js";
import { chooseTilt, DEFAULT_MODELS, type StudioModels } from "./pipeline.js";
import { saveVariant, type VariantRecord } from "./variants.js";
import type { AssetRecord } from "./intake.js";
import type { AssetStore } from "./store.js";
import type { VisionRunner } from "./vision.js";
import { agentNodeId } from "../agent/memory.js";

export interface Adjustment { warmth: number; brightness: number; contrast: number; saturation: number; label: string }

const UNITS: Array<[RegExp, Partial<Omit<Adjustment, "label">>, string]> = [
  [/\b(warmer|warm up|warmth|cosier|cozier|cosy|cozy|golden)\b/, { warmth: 1 }, "warmer"],
  [/\b(cooler|cool down|colder|bluer|crisper tone)\b/, { warmth: -1 }, "cooler"],
  [/\b(brighter|lighter|lift|more light|less dark)\b/, { brightness: 1 }, "brighter"],
  [/\b(darker|moodier|dim|less bright|more shadow)\b/, { brightness: -1 }, "darker"],
  [/\b(more contrast|punchier|punchy|bolder|crisper)\b/, { contrast: 1 }, "with more contrast"],
  [/\b(less contrast|softer|flatter|gentler)\b/, { contrast: -1 }, "with less contrast"],
  [/\b(more colou?r|more vibrant|vibrant|more saturated|richer|livelier)\b/, { saturation: 1 }, "with more colour"],
  [/\b(less colou?r|muted|more muted|desaturat\w*|calmer colou?rs?|quieter colou?rs?|less saturated)\b/, { saturation: -1 }, "with calmer colour"],
];

// Words to a small adjustment, or null when none of it is something this can do.
export function parseAdjustment(words: string): Adjustment | null {
  const t = ` ${words.toLowerCase().replace(/[^a-z0-9\s']/g, " ").replace(/\s+/g, " ")} `;
  const scale = /\b(a lot|much|way|very|really|a lot more)\b/.test(t) ? 2 : /\b(a bit|slightly|a little|just a touch|subtly|tiny bit)\b/.test(t) ? 0.5 : 1;
  const out: Adjustment = { warmth: 0, brightness: 0, contrast: 0, saturation: 0, label: "" };
  const said: string[] = [];
  for (const [re, delta, label] of UNITS) {
    if (!re.test(t)) continue;
    for (const [k, v] of Object.entries(delta) as Array<[keyof Omit<Adjustment, "label">, number]>) out[k] = Math.max(-2, Math.min(2, out[k] + v * scale));
    said.push(label);
  }
  if (!said.length) return null;
  out.label = said.join(", ");
  return out;
}

const FILLER = new Set(("make it a an the more less bit little lot much very really slightly just touch subtly tiny way please can you could would i want to " +
  "and also but then photo picture image shot look looks feel feels is be little bit so too now again version one option this that with").split(" "));

// What is left of a request once the light-and-colour words are taken out: anything left is a change to what is IN the photo
// (or a style, an ad, a different background), which the generative engine handles.
export function beyondAdjustments(words: string): string[] {
  let t = ` ${words.toLowerCase().replace(/[^a-z0-9\s']/g, " ").replace(/\s+/g, " ")} `;
  for (const [re] of UNITS) t = t.replace(new RegExp(re.source, "g"), " ");
  t = t.replace(/\b(a lot|much|way|very|really|a lot more|a bit|slightly|a little|just a touch|subtly|tiny bit)\b/g, " ");
  return t.split(" ").filter((w) => w && !FILLER.has(w));
}

export const CANNOT_REVISE =
  "I can make a photo warmer or cooler, lighter or darker, with more or less contrast, or with more or less colour. " +
  "Changing what is in the photo is not something the team can do yet.";

// Applies an adjustment to a finished variant (a JPEG at the post size).
export async function adjustVariant(buffer: Buffer, a: Adjustment): Promise<Buffer> {
  let img = sharp(buffer);
  if (a.warmth) img = img.linear([1 + 0.07 * a.warmth, 1 + 0.01 * a.warmth, 1 - 0.07 * a.warmth], [0, 0, 0]);
  if (a.contrast) img = img.linear(1 + 0.18 * a.contrast, -(128 * 0.18 * a.contrast));
  if (a.brightness || a.saturation) img = img.modulate({ brightness: 1 + 0.12 * a.brightness, saturation: 1 + 0.25 * a.saturation });
  return img.jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}

export interface ReviseDeps {
  store: AssetStore;
  vision: VisionRunner;
  models?: Partial<StudioModels>;
  now: number;
}

export type ReviseResult =
  | { ok: true; variant: VariantRecord; fidelity: FidelityResult; adjustment: Adjustment; card: StudioPayload }
  | { ok: false; reason: "unsupported" | "decided" | "missing"; message: string };

export const nextLabel = (labels: string[]): string => {
  for (let c = 67; c < 91; c++) if (!labels.includes(String.fromCharCode(c))) return String.fromCharCode(c); // C, D, E ...
  return `R${labels.length + 1}`;
};

// What every revision (a local adjustment, a generative request, a retry) starts from: the pending card, the owner's photo as
// kept, Miss Influencer's assessment, the straightened frame every variant is checked against, and what is to be blurred in it.
export interface RevisionBase {
  card: { status: string; payload: StudioPayload };
  s: StudioPayload["studio"];
  original: AssetRecord;
  originalBytes: Buffer;
  assessment: PhotoAssessment;
  ctx: Awaited<ReturnType<typeof loadStudioContext>>;
  plan: ReturnType<typeof planCrop>;
  base: Buffer;
  privacy: ReturnType<typeof readPrivacy>;
}

export async function loadRevision(
  g: GraphHandle, o: { tenant: string; businessId: string; approvalId: string }, deps: { store: AssetStore },
): Promise<{ ok: true; r: RevisionBase } | { ok: false; reason: "decided" | "missing"; message: string }> {
  const card = await studioCard(g, o.approvalId);
  if (!card) return { ok: false, reason: "missing", message: "I can't find that photo's card any more." };
  if (card.status !== "pending") return { ok: false, reason: "decided", message: "That one is already decided. Send the photo again to start a new one." };
  const s = card.payload.studio;

  const [orig] = await g.roQuery<{ key: string | null; sha: string | null; name: string | null; w: number | null; h: number | null; a: string | null; note: string | null }>(
    "MATCH (a:Entity:Asset {id:$id}) RETURN a.storageKey AS key, a.sha256 AS sha, a.name AS name, a.w AS w, a.h AS h, a.assessment AS a, a.note AS note", { id: s.originalId });
  const originalBytes = orig?.key ? deps.store.get(o.tenant, orig.key) : null;
  if (!orig?.key || !originalBytes || !orig.sha || !orig.a) return { ok: false, reason: "missing", message: "I can't find the original photo any more." };
  let assessment: PhotoAssessment;
  try {
    assessment = parseAssessment(JSON.parse(orig.a));
  } catch {
    return { ok: false, reason: "missing", message: "I can't find what my team saw in that photo. Send it again." };
  }
  const original: AssetRecord = { id: s.originalId, kind: "original", w: orig.w ?? 0, h: orig.h ?? 0, sha256: orig.sha, dhash: await dhash(originalBytes), storageKey: orig.key, mime: "image/jpeg" };
  const ctx = await loadStudioContext(g, o.businessId, orig.note ?? "");
  const tilt = chooseTilt(await estimateTilt(originalBytes), assessment.quality.tiltDeg);
  const plan = planCrop({ w: original.w, h: original.h }, tilt.deg, assessment.overlays);
  const privacy = readPrivacy(assessment, { blurFaces: (await loadStudioSettings(g, o.businessId)).blurFaces });
  const base = await straightenedBase(originalBytes, plan, privacy.blur);
  return { ok: true, r: { card, s, original, originalBytes, assessment, ctx, plan, base, privacy } };
}

export async function reviseVariant(
  g: GraphHandle, o: { tenant: string; businessId: string; approvalId: string; instruction: string }, deps: ReviseDeps,
): Promise<ReviseResult> {
  const adjustment = parseAdjustment(o.instruction);
  if (!adjustment) return { ok: false, reason: "unsupported", message: CANNOT_REVISE };
  const loaded = await loadRevision(g, o, deps);
  if (!loaded.ok) return loaded;
  const { card, s, original, originalBytes, assessment, ctx, base } = loaded.r;

  // the latest local variant is what gets adjusted, so "warmer" and then "a bit more" add up
  const local = [...s.variants].reverse().find((v) => !v.aiEdited);
  const [row] = local ? await g.roQuery<{ key: string | null }>("MATCH (a:Entity:Asset {id:$id}) RETURN a.storageKey AS key", { id: local.id }) : [];
  const from = row?.key ? deps.store.get(o.tenant, row.key) : null;
  if (!local || !from) return { ok: false, reason: "missing", message: "I can't find the version to adjust. Send the photo again." };

  const label = nextLabel(s.variants.map((v) => v.label));
  const buffer = await adjustVariant(from, adjustment);
  const variant = await saveVariant(g, deps.store, o.tenant, original, buffer, {
    label, name: `Variant ${label}: ${adjustment.label} (adjusted locally)`, treatment: `Adjusted: ${adjustment.label}`, step: "revision", aiEdited: false, engine: "local",
    extra: { instruction: o.instruction.trim().slice(0, 300), adjustedFrom: local.id, costUsd: 0 },
  }, deps.now);
  await upsertEdge(g, { from: variant.id, type: "DERIVED_FROM", to: local.id, props: { step: "revision", instruction: o.instruction.trim().slice(0, 300) } }, deps.now);

  const [fidelity] = await checkFidelity(g, { businessName: ctx.business.name, original: originalBytes, base, locks: assessment.locks, variants: [variant] },
    { vision: deps.vision, model: { ...DEFAULT_MODELS, ...deps.models }.fidelity, now: deps.now });
  if (!fidelity) return { ok: false, reason: "missing", message: "The check on the new version could not run." };

  // the pending card now offers it, and recommends it when it passed
  const payload: StudioPayload = {
    ...card.payload,
    studio: {
      ...s,
      variants: [...s.variants, { id: variant.id, label, badge: fidelity.badge, note: fidelity.note, aiEdited: false }],
      recommended: fidelity.badge === "unchanged" ? variant.id : s.recommended,
    },
  };
  const [ap] = await g.roQuery<{ name: string | null; rec: string | null }>("MATCH (a:Entity:Approval {id:$id}) RETURN a.name AS name, a.recommendation AS rec", { id: o.approvalId });
  await upsertNode(g, { type: "Approval", id: o.approvalId, name: ap?.name ?? o.approvalId, props: { payload: JSON.stringify(payload) } }, deps.now);
  if (ap?.rec) await upsertEdge(g, { from: ap.rec, type: "EVIDENCED_BY", to: variant.id }, deps.now).catch(() => undefined);
  await upsertEdge(g, { from: agentNodeId(TARA), type: "PRODUCED", to: variant.id, props: { step: "revision" } }, deps.now).catch(() => undefined);
  return { ok: true, variant, fidelity, adjustment, card: payload };
}
