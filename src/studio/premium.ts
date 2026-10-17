// "Make this a premium ad" (founder's brief, 17 Oct): a rough product photo in, a premium, UGC-style ad picture out, then a short
// vertical clip from it (clip.ts), both waiting for the owner's OK like every other Studio option, with the whole chain in the
// business's graph (lineage.ts).
//
// The picture is made by Higgsfield's product-photoshoot backend (engine.photoshoot): the studio gives it the owner's intent and what
// the business and the product are, the backend writes the prompt for the mode (a lifestyle scene with hands and atmosphere is the
// UGC look), and the owner's photo goes to the model as the reference so the product stays the product. Nothing is generated until
// the engine has quoted it (about 6.5 credits at 2k), checked it against the per-run cap, the daily cap and the balance floor.
// Fact Checker then checks the PRODUCT against the original (not the place): a new scene is the point, a changed label or shape is not,
// and a picture she holds back cannot be approved. Words on the ad are never generated: if the owner gave a message, the studio
// sets it afterwards in the brand's own colours and font (ad.ts).
import sharp from "sharp";
import type { GraphHandle } from "../graph/client.js";
import { upsertEdge, upsertNode } from "../graph/upsert.js";
import { agentNodeId } from "../agent/memory.js";
import { TARA, type SubjectKind } from "./assess.js";
import { renderAd } from "./ad.js";
import type { StudioPayload } from "./approve.js";
import { EngineDecline, type EditResult, type PhotoshootMode, type PhotoshootOpts } from "./engine.js";
import { checkFidelity } from "./fidelity.js";
import type { GenerateDeps, GenerateResult } from "./generate.js";
import { POST_SIZE, sha256Hex } from "./image.js";
import { recordGeneration } from "./lineage.js";
import { CHILD_NOTICE } from "./privacy.js";
import { DEFAULT_MODELS } from "./pipeline.js";
import { loadRevision, nextLabel } from "./revise.js";
import { saveVariant, type VariantRecord } from "./variants.js";
import type { StudioContext } from "./context.js";
import type { PhotoAssessment } from "./assess.js";

export interface PremiumRequest { words: string; mode?: PhotoshootMode; headline?: string; sub?: string }

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

export const MODE_WORDS: Record<PhotoshootMode, string> = {
  lifestyle_scene: "a lifestyle scene, the way a real customer would shoot it",
  closeup_product_with_person: "a close-up with hands holding the product",
  product_shot: "a clean studio shot",
  ad_creative_pack: "a paid-social ad picture",
};

// The mode from the owner's words; "UGC", "lifestyle" and "premium" with no other cue mean a lifestyle scene.
export function chooseMode(words: string, _kind?: SubjectKind): PhotoshootMode {
  const t = words.toLowerCase();
  if (/\b(?:studio|white background|plain background|catalog(?:ue)?|packshot|pack shot|clean background|amazon|shopify)\b/.test(t)) return "product_shot";
  if (/\b(?:close[- ]?up|hands?|holding|tight crop|in (?:her|his|their) hands?|applying)\b/.test(t)) return "closeup_product_with_person";
  if (/\b(?:ad pack|paid|meta ads?|facebook ads?|google ads?|tiktok ads?|performance)\b/.test(t)) return "ad_creative_pack";
  return "lifestyle_scene";
}

// What the business and the product are, and what the owner wants, in the words the backend's prompt-writer works from.
export function premiumIntent(ctx: StudioContext, a: PhotoAssessment, o: PremiumRequest & { mode: PhotoshootMode }): { intent: string; brandContext: string; productContext: string } {
  const want = o.words.replace(/\s+/g, " ").trim().slice(0, 240);
  const b = ctx.brand;
  const palette = [b.paper, b.ink, b.accent].filter(Boolean).join(", ");
  const intent = [
    `A premium, UGC-style Instagram ad for ${ctx.business.name}${ctx.business.industry ? ` (${ctx.business.industry})` : ""}: ${a.subject}.`,
    `It should feel like a real customer's own handheld phone shot, but lit and styled like a premium brand campaign. ${MODE_WORDS[o.mode]}.`,
    want ? `The owner asked: ${JSON.stringify(want)}.` : "",
    "Leave calm space for a short headline; add no text, logos or numbers of your own.",
  ].filter(Boolean).join(" ");
  const brandContext = [
    `${ctx.business.name}${ctx.business.city ? `, ${ctx.business.city}` : ""}.`,
    b.tone ? `Brand tone: ${clip(b.tone, 160)}` : "", palette ? `Brand colours: ${palette}.` : "",
  ].filter(Boolean).join(" ");
  const productContext = [`${a.subject}.`, a.locks.length ? `Must stay recognisable: ${a.locks.join("; ")}.` : ""].filter(Boolean).join(" ");
  return { intent, brandContext, productContext };
}

const nope = (message: string, reason: "declined" | "child" = "declined"): GenerateResult => ({ ok: false, reason, message });

export async function makePremiumAd(
  g: GraphHandle, o: { tenant: string; businessId: string; approvalId: string; request: PremiumRequest }, deps: GenerateDeps,
): Promise<GenerateResult & { mode?: PhotoshootMode }> {
  const loaded = await loadRevision(g, o, deps);
  if (!loaded.ok) return loaded;
  const { s, original, assessment, ctx, base, card, originalBytes } = loaded.r;
  if (loaded.r.privacy.localOnly) return nope(`${CHILD_NOTICE} I can still make it warmer, cooler, lighter or darker.`, "child");
  const engine = deps.engine;
  if (!engine.photoshoot) return nope("The AI editor isn't switched on here, so I can't make an ad picture.");

  const mode = o.request.mode ?? chooseMode(o.request.words, assessment.subjectKind);
  const { intent, brandContext, productContext } = premiumIntent(ctx, assessment, { ...o.request, mode });
  const input = await sharp(base).jpeg({ quality: 92 }).toBuffer();
  // the same words on the same card state join the same job (a double tap is never charged twice); once an option has been added
  // to the card, asking again is a new try
  const key = sha256Hex(Buffer.from(`${mode}|${o.request.words}|${s.variants.length}`)).slice(0, 10);
  const opts: PhotoshootOpts = {
    mode, treatment: `premium-ad:${mode}:${key}`, aspect: "4:5", brandContext, productContext,
    onQuote: (q) => deps.status?.(`The premium ad picture costs ${q.words}`),
  };
  const editInput = { image: input, mime: "image/jpeg" as const, originalSha256: `${original.sha256}:${sha256Hex(input).slice(0, 12)}`, tenant: o.tenant };

  deps.status?.(`Making a premium ad picture: ${MODE_WORDS[mode]}`);
  let res: EditResult | null;
  try {
    res = await engine.photoshoot(editInput, intent, opts);
  } catch (e) {
    if (e instanceof EngineDecline) return nope(e.message.replace(/, so I (?:made|kept to) the simple clean-up( only)?\.?/i, ".").replace(/\.\./g, "."));
    return nope("The ad picture stopped on a problem, so nothing was added. Try again in a moment.");
  }
  if (!res) return nope("The AI editor isn't switched on here, so I can't make an ad picture.");

  // sized like the other options; the owner's message (if any) is set by code, never generated
  const frame = await sharp(res.image).resize(POST_SIZE.w, POST_SIZE.h, { fit: "cover", kernel: "lanczos3" }).jpeg({ quality: 92 }).toBuffer();
  const headline = o.request.headline;
  const buffer = headline
    ? await renderAd(frame, { headline, ...(o.request.sub ? { sub: o.request.sub } : {}) }, { paper: ctx.brand.paper, ...(ctx.brand.ink ? { ink: ctx.brand.ink } : {}), ...(ctx.brand.accent ? { accent: ctx.brand.accent } : {}), ...(ctx.brand.fonts[0] ? { font: ctx.brand.fonts[0] } : {}) })
    : await sharp(frame).jpeg({ quality: 90, mozjpeg: true }).toBuffer();

  const label = nextLabel(s.variants.map((v) => v.label));
  const title = `Premium ad${headline ? `: ${clip(headline, 36)}` : ""}`;
  const requested = `a premium, UGC-style advertising picture of the same product (${MODE_WORDS[mode]})`;
  const saved = await saveVariant(g, deps.store, o.tenant, original, buffer, {
    label, name: `Variant ${label}: ${title} (Higgsfield product photoshoot, AI-made)`, treatment: `${title} · ${MODE_WORDS[mode]}${res.model ? ` · ${res.model}` : ""}`,
    step: "premium-ad", aiEdited: true, engine: res.engine,
    extra: {
      instruction: clip(o.request.words || requested, 300), model: res.model, prompt: res.prompt.slice(0, 4000), recorded: res.recorded, photoshootMode: mode,
      intent: intent.slice(0, 1500), ...(res.jobId ? { hfJobId: res.jobId } : {}), ...(res.credits !== undefined ? { hfCredits: res.credits } : {}),
      ...(res.createdAt ? { generatedAt: res.createdAt } : {}), ...(headline ? { adHeadline: headline } : {}), ...(o.request.sub ? { adSub: o.request.sub } : {}),
    },
  }, deps.now);
  const variant: VariantRecord = { ...saved, model: res.model, recorded: res.recorded, ...(res.jobId ? { jobId: res.jobId } : {}), ...(res.credits !== undefined ? { credits: res.credits } : {}) };
  // the job, its cost and the rules it was built from are facts in the graph (lineage.ts), not only properties of the asset
  const guided = ctx.brand.ids.filter((id) => /^(?:brand-rule|rule):/.test(id));
  await recordGeneration(g, {
    assetId: variant.id, jobId: res.jobId ?? `recorded-${key}`, model: res.model, credits: res.credits ?? 0, mode, prompt: res.prompt, recorded: res.recorded, guidedBy: guided, now: deps.now,
  });

  const [fidelity] = await checkFidelity(g, { businessName: ctx.business.name, original: originalBytes, base, locks: assessment.locks, variants: [variant], requested, subject: "product" },
    { vision: deps.vision, model: { ...DEFAULT_MODELS, ...deps.models }.fidelity, now: deps.now });
  if (!fidelity) return nope("The check on the new picture could not run, so it was not added.");
  const passed = fidelity.badge === "unchanged";

  const payload: StudioPayload = {
    ...card.payload,
    studio: {
      ...s,
      variants: [
        ...s.variants,
        { id: variant.id, label, badge: fidelity.badge, note: fidelity.note, aiEdited: true, request: clip(requested, 200), premium: true, ...(variant.credits !== undefined ? { credits: variant.credits } : {}) },
      ],
      recommended: passed ? variant.id : s.recommended,
    },
  };
  const [ap] = await g.roQuery<{ name: string | null; rec: string | null }>("MATCH (a:Entity:Approval {id:$id}) RETURN a.name AS name, a.recommendation AS rec", { id: o.approvalId });
  await upsertNode(g, { type: "Approval", id: o.approvalId, name: ap?.name ?? o.approvalId, props: { payload: JSON.stringify(payload) } }, deps.now);
  if (ap?.rec) await upsertEdge(g, { from: ap.rec, type: "EVIDENCED_BY", to: variant.id }, deps.now).catch(() => undefined);
  await upsertEdge(g, { from: agentNodeId(TARA), type: "PRODUCED", to: variant.id, props: { step: "premium-ad" } }, deps.now).catch(() => undefined);
  return { ok: true, variant, fidelity, card: payload, passed, canRetry: false, request: requested, mode };
}
