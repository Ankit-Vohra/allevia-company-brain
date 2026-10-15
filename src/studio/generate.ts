// The owner's own requests to the generative engine (founder's brief, 2026-10-15): "make it festive", "change the
// background", "remove the pole", "make this into an ad saying ...", and "try again" when Nisha held an AI edit back.
// Each becomes a new Asset{kind:'variant'} on the pending card, made from the straightened frame (so it lines up with the
// other options with no guessing), checked by Nisha against the original with the owner's request as the allowed change,
// and offered like any other option. The engine is quoted before it generates, capped per run and per day, and may decline
// (not signed in, a cap, low balance): then nothing is added and the owner is told why in plain words.
// A photo with a child in it never goes to the engine. Light and colour words never come here (revise.ts, free).
import { createHash } from "node:crypto";
import sharp from "sharp";
import type { GraphHandle } from "../graph/client.js";
import { upsertEdge, upsertNode } from "../graph/upsert.js";
import { agentNodeId } from "../agent/memory.js";
import { TARA } from "./assess.js";
import { renderAd } from "./ad.js";
import type { StudioPayload } from "./approve.js";
import { EngineDecline, type EditOpts, type GenerationEngine } from "./engine.js";
import { checkFidelity, type FidelityResult } from "./fidelity.js";
import { blurBoxes, boxesInFrame, POST_SIZE, sha256Hex } from "./image.js";
import { CHILD_NOTICE } from "./privacy.js";
import { buildRequestPrompt, TREATMENTS, type RequestMode } from "./prompt.js";
import { loadRevision, nextLabel } from "./revise.js";
import { DEFAULT_MODELS, type StudioModels } from "./pipeline.js";
import { saveVariant, type VariantRecord } from "./variants.js";
import type { AssetStore } from "./store.js";
import type { VisionRunner } from "./vision.js";

export type GenerateRequest =
  | { kind: "request"; words: string }
  | { kind: "ad"; words: string; headline?: string; sub?: string }
  | { kind: "retry"; of?: string };

export interface GenerateDeps {
  store: AssetStore;
  vision: VisionRunner;
  engine: GenerationEngine;
  models?: Partial<StudioModels>;
  now: number;
  /** Plain progress lines for the work log. */
  status?: (text: string) => void;
}

export type GenerateResult =
  | {
    ok: true; variant: VariantRecord; fidelity: FidelityResult; card: StudioPayload; passed: boolean;
    /** Held back by Nisha and a retry is on offer (one per option). */
    canRetry: boolean;
    /** What a retry would cost, in the owner's words, when the engine can say. */
    retryQuote?: string;
    request: string;
  }
  | { ok: false; reason: "decided" | "missing" | "child" | "declined" | "need-message" | "no-retry"; message: string };

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

export const NEED_AD_MESSAGE = "What should the ad say? Tell me the words, for example: make this into an ad saying \"Free site visit this week\".";

export async function generateVariant(
  g: GraphHandle, o: { tenant: string; businessId: string; approvalId: string; request: GenerateRequest }, deps: GenerateDeps,
): Promise<GenerateResult> {
  const loaded = await loadRevision(g, o, deps);
  if (!loaded.ok) return loaded;
  const { card, s, original, originalBytes, assessment, ctx, plan, base, privacy } = loaded.r;
  if (privacy.localOnly) return { ok: false, reason: "child", message: `${CHILD_NOTICE} I can still make it warmer, cooler, lighter or darker.` };

  // what to make
  let words: string;
  let mode: RequestMode;
  let headline: string | undefined;
  let sub: string | undefined;
  let retryOf: (typeof s.variants)[number] | undefined;
  let retryNotes: { added: string[]; removed: string[] } | undefined;
  let requested: string | undefined;
  if (o.request.kind === "retry") {
    const wanted = o.request.of;
    retryOf = wanted ? s.variants.find((v) => v.label === wanted) : [...s.variants].reverse().find((v) => v.aiEdited && v.canRetry);
    if (!retryOf || !retryOf.aiEdited || retryOf.badge === "unchanged" || !retryOf.canRetry) {
      return { ok: false, reason: "no-retry", message: "There is nothing held back to try again. Tell me what you would like changed instead." };
    }
    const [row] = await g.roQuery<{ instruction: string | null; fidelity: string | null; headline: string | null; sub: string | null; step: string | null }>(
      "MATCH (a:Entity:Asset {id:$id}) RETURN a.instruction AS instruction, a.fidelity AS fidelity, a.adHeadline AS headline, a.adSub AS sub, a.step AS step", { id: retryOf.id });
    const verdict = safeJson<{ added?: string[]; removed?: string[] }>(row?.fidelity);
    retryNotes = { added: verdict?.added ?? [], removed: verdict?.removed ?? [] };
    words = row?.instruction?.trim() || TREATMENTS["relight-clean-editorial"]!.scope;
    requested = row?.instruction?.trim() || undefined;
    headline = row?.headline ?? undefined;
    sub = row?.sub ?? undefined;
    mode = headline ? "ad" : "retry";
  } else if (o.request.kind === "ad") {
    if (!o.request.headline) return { ok: false, reason: "need-message", message: NEED_AD_MESSAGE };
    ({ headline, sub } = { headline: o.request.headline, sub: o.request.sub });
    words = `an advertisement for ${ctx.business.name}`; // the model is never given the message: the studio sets it afterwards
    requested = `an advertising image with this message set at the bottom: "${headline}${sub ? ` / ${sub}` : ""}"`;
    mode = "ad";
  } else {
    words = o.request.words;
    requested = words;
    mode = "request";
  }

  const prompt = buildRequestPrompt(ctx, assessment, { words, mode: mode === "retry" ? "request" : mode, ...(retryNotes ? { retry: retryNotes } : {}) });
  const input = await sharp(base).jpeg({ quality: 92 }).toBuffer();
  const key = createHash("sha256").update(`${mode}|${words}|${retryOf?.id ?? ""}`).digest("hex").slice(0, 10);
  const opts: EditOpts = { treatment: `${mode}:${key}`, aspect: "same", onQuote: (q) => deps.status?.(`The AI edit costs ${q.words}`) };
  const editInput = { image: input, mime: "image/jpeg" as const, originalSha256: `${original.sha256}:${sha256Hex(input).slice(0, 12)}`, tenant: o.tenant };

  deps.status?.(mode === "ad" ? "Styling the picture as an ad" : retryOf ? "Trying the AI edit again, with a tighter lock" : `Making the AI edit: ${clip(words, 80)}`);
  let res;
  try {
    res = await deps.engine.edit(editInput, prompt.prompt, opts);
  } catch (e) {
    if (e instanceof EngineDecline) return { ok: false, reason: "declined", message: e.message.replace(/, so I (?:made|kept to) the simple clean-up( only)?\.?/i, ".").replace(/\.\./g, ".") };
    return { ok: false, reason: "declined", message: "The AI edit stopped on a problem, so nothing was added. Try again in a moment." };
  }
  if (!res) return { ok: false, reason: "declined", message: "The AI editor isn't switched on here, so I can only change light and colour for now." };

  // line it up with the other options: the engine was given the frame, so it only needs sizing; privacy boxes are blurred again
  let frame: Buffer = await sharp(res.image).resize(POST_SIZE.w, POST_SIZE.h, { fit: "cover", kernel: "lanczos3" }).jpeg({ quality: 92 }).toBuffer();
  frame = await blurBoxes(frame, boxesInFrame(plan, privacy.blur));
  const buffer = mode === "ad" && headline
    ? await renderAd(frame, { headline, ...(sub ? { sub } : {}) }, { paper: ctx.brand.paper, ...(ctx.brand.ink ? { ink: ctx.brand.ink } : {}), ...(ctx.brand.accent ? { accent: ctx.brand.accent } : {}), ...(ctx.brand.fonts[0] ? { font: ctx.brand.fonts[0] } : {}) })
    : await sharp(frame).jpeg({ quality: 90, mozjpeg: true }).toBuffer();

  const label = nextLabel(s.variants.map((v) => v.label));
  const step = mode === "ad" ? "generative-ad" : retryOf ? "generative-retry" : "generative-request";
  const title = mode === "ad" ? `Ad: ${clip(headline ?? "", 40)}` : retryOf ? "Second try" : clip(words, 50);
  const saved = await saveVariant(g, deps.store, o.tenant, original, buffer, {
    label, name: `Variant ${label}: ${title} (Higgsfield, AI-edited)`, treatment: `${title}${res.model ? ` · ${res.model}` : ""}`, step, aiEdited: true, engine: res.engine,
    extra: {
      instruction: (requested ?? words).slice(0, 300), model: res.model, prompt: res.prompt.slice(0, 4000), recorded: res.recorded,
      ...(res.jobId ? { hfJobId: res.jobId } : {}), ...(res.credits !== undefined ? { hfCredits: res.credits } : {}), ...(res.createdAt ? { generatedAt: res.createdAt } : {}),
      ...(retryOf ? { retryOf: retryOf.id } : {}), ...(headline ? { adHeadline: headline } : {}), ...(sub ? { adSub: sub } : {}),
    },
  }, deps.now);
  const variant: VariantRecord = { ...saved, model: res.model, recorded: res.recorded, ...(res.jobId ? { jobId: res.jobId } : {}), ...(res.credits !== undefined ? { credits: res.credits } : {}) };
  if (retryOf) await upsertEdge(g, { from: variant.id, type: "DERIVED_FROM", to: retryOf.id, props: { step: "retry", reason: "held back by Nisha" } }, deps.now);

  const [fidelity] = await checkFidelity(g, { businessName: ctx.business.name, original: originalBytes, base, locks: assessment.locks, variants: [variant], ...(requested ? { requested } : {}) },
    { vision: deps.vision, model: { ...DEFAULT_MODELS, ...deps.models }.fidelity, now: deps.now });
  if (!fidelity) return { ok: false, reason: "missing", message: "The check on the new version could not run." };
  const passed = fidelity.badge === "unchanged";
  const canRetry = !passed && !retryOf;

  const payload: StudioPayload = {
    ...card.payload,
    studio: {
      ...s,
      variants: [
        ...s.variants.map((v) => (retryOf && v.id === retryOf.id ? { ...v, canRetry: false } : v)),
        { id: variant.id, label, badge: fidelity.badge, note: fidelity.note, aiEdited: true, request: clip(requested ?? words, 200), ...(variant.credits !== undefined ? { credits: variant.credits } : {}), ...(canRetry ? { canRetry } : {}) },
      ],
      recommended: passed ? variant.id : s.recommended,
    },
  };
  const [ap] = await g.roQuery<{ name: string | null; rec: string | null }>("MATCH (a:Entity:Approval {id:$id}) RETURN a.name AS name, a.recommendation AS rec", { id: o.approvalId });
  await upsertNode(g, { type: "Approval", id: o.approvalId, name: ap?.name ?? o.approvalId, props: { payload: JSON.stringify(payload) } }, deps.now);
  if (ap?.rec) await upsertEdge(g, { from: ap.rec, type: "EVIDENCED_BY", to: variant.id }, deps.now).catch(() => undefined);
  await upsertEdge(g, { from: agentNodeId(TARA), type: "PRODUCED", to: variant.id, props: { step } }, deps.now).catch(() => undefined);

  let retryQuote: string | undefined;
  if (canRetry && deps.engine.quote) {
    try { retryQuote = (await deps.engine.quote(editInput, prompt.prompt, opts)).words; } catch { retryQuote = undefined; }
  }
  return { ok: true, variant, fidelity, card: payload, passed, canRetry, ...(retryQuote ? { retryQuote } : {}), request: requested ?? words };
}

function safeJson<T>(s: string | null | undefined): T | null {
  try { return s ? (JSON.parse(s) as T) : null; } catch { return null; }
}
