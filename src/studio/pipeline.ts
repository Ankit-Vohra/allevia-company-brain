// One Studio run, streamed as AgentEvents so the office and the Studio page show who did what (product design §6):
//   intake (asset) → Tara assesses (assessment) → the plan straightens and crops → variant A, local (asset) →
//   variant B, generative, prompted from the graph (asset) → Nisha checks both (review) → Dev writes the caption →
//   the approval card (proposal) → final.
// The run's events are kept on the original Asset (studioEvents), so the page can show the last run after a reload.
import type { AgentEvent, AgentId, TurnChecks } from "../../shared/contracts.js";
import type { GraphHandle } from "../graph/client.js";
import { upsertEdge, upsertNode } from "../graph/upsert.js";
import { ensureRoster } from "../agent/memory.js";
import { assessPhoto, recordAssessment, TARA, type AssessContext, type PhotoAssessment } from "./assess.js";
import { privacyNote, readPrivacy, STOP_MESSAGE } from "./privacy.js";
import { proposeStudioDraft } from "./approve.js";
import { DEV, writeCaption, type Caption } from "./caption.js";
import { loadStudioContext, type StudioContext } from "./context.js";
import type { GenerationEngine } from "./engine.js";
import { checkFidelity, NISHA, type FidelityResult } from "./fidelity.js";
import { blurBoxes, estimateTilt, planCrop, straightenedBase, thumbnail, type CropPlan } from "./image.js";
import { assetUrl, blockOriginal, intake, keepOriginal, type AssetRecord } from "./intake.js";
import { buildEditPrompt, TREATMENTS } from "./prompt.js";
import type { AssetStore } from "./store.js";
import { makeVariantA, makeVariantB, type VariantRecord } from "./variants.js";
import type { VisionRunner } from "./vision.js";

export interface StudioModels { assess: string; fidelity: string; caption: string }
export const DEFAULT_MODELS: StudioModels = { assess: "sonnet", fidelity: "sonnet", caption: "haiku" };

export interface StudioDeps {
  store: AssetStore;
  vision: VisionRunner;            // Tara and Nisha look at photos
  engine: GenerationEngine;        // variant B
  models?: Partial<StudioModels>;
  // Dev rewrites Tara's draft with the model (one more call per photo). Off by default: Dev's voice check runs in code
  // either way, and two calls per post keep within Appendix B.3's $0.10 of Claude per post.
  devRewrite?: boolean;
  now?: () => number;
  signal?: AbortSignal;
}

export interface StudioInput { tenant: string; businessId: string; bytes: Buffer; note?: string; ownerId?: string }

export interface StudioResult {
  original: AssetRecord;
  assessment: PhotoAssessment;
  tilt: { deg: number; source: "edges" | "tara" | "level" };
  plan: CropPlan;
  variants: VariantRecord[];
  fidelity: FidelityResult[];
  caption: Caption;
  context: StudioContext;
  recommendationId: string;
  approvalId: string;
  title: string;
  // Set when the run ended without a card: Tara said reshoot, or privacy stopped it (a child, people who cannot be blurred).
  // Then variants and fidelity are empty, there is no card (approvalId is ""), and `message` is what the owner is told.
  stopped?: { reason: "reshoot" | "privacy"; message: string };
}

const CHECKS_NA: TurnChecks = { citationsValid: true, invalidCitations: [], numbersGrounded: true, ungroundedNumbers: [], simulatedDisclosed: true, freshnessDisclosed: true };

export function assessContextFor(ctx: StudioContext, note: string, a: Pick<AssetRecord, "w" | "h">): AssessContext {
  return {
    businessName: ctx.business.name, ...(ctx.business.industry ? { industry: ctx.business.industry } : {}), ...(ctx.business.city ? { city: ctx.business.city } : {}),
    ...(ctx.brand.visualStyle ? { visualStyle: ctx.brand.visualStyle } : {}), ...(ctx.brand.tone ? { tone: ctx.brand.tone } : {}),
    ...(ctx.brand.voiceRules.length ? { voiceRules: ctx.brand.voiceRules.map((r) => r.text) } : {}),
    ...(note ? { note } : {}), ...(ctx.project ? { project: ctx.project.name } : {}),
    w: a.w, h: a.h,
  };
}

// The tilt to straighten by: the photo's own edges when they agree on one angle, Tara's estimate otherwise.
export function chooseTilt(edges: { deg: number; confidence: number }, tara: number): StudioResult["tilt"] {
  if (edges.confidence >= 0.08 && Math.abs(edges.deg) <= 12) return Math.abs(edges.deg) < 0.3 ? { deg: 0, source: "level" } : { deg: edges.deg, source: "edges" };
  return Math.abs(tara) < 0.3 ? { deg: 0, source: "level" } : { deg: tara, source: "tara" };
}

export async function runStudio(g: GraphHandle, input: StudioInput, deps: StudioDeps, emit: (e: AgentEvent) => void): Promise<StudioResult> {
  const now = deps.now ?? (() => Date.now());
  const models = { ...DEFAULT_MODELS, ...deps.models };
  const t0 = now();
  const log: AgentEvent[] = [];
  const send = (e: AgentEvent) => { log.push(e); emit(e); };
  const status = (agent: AgentId, text: string) => send({ type: "agent_status", agent, text });
  const stopIfAborted = () => { if (deps.signal?.aborted) throw new Error("The Studio run was stopped."); };
  const started: Record<string, number> = {};
  const start = (agent: AgentId, task: string) => { started[agent] = now(); send({ type: "agent_start", agent, task }); };
  const done = (agent: AgentId, ok = true) => send({ type: "agent_done", agent, ms: Math.max(0, now() - (started[agent] ?? now())), ok });
  const note = input.note?.trim() ?? "";

  await ensureRoster(g, { businessId: input.businessId }, now());
  const ctx = await loadStudioContext(g, input.businessId, note);

  // 1. intake: the photo is held in memory until privacy has said what may be kept (content trial 2026-10-15)
  start(TARA, "Look at the new photo and plan the post");
  status(TARA, "Receiving the photo: stripping location data, fingerprinting it");
  const got = await intake(g, { tenant: input.tenant, bytes: input.bytes, note, ownerId: input.ownerId ?? ctx.owner?.id ?? null }, { store: deps.store, now: now(), agent: TARA, persist: false });
  let original = got.asset;
  stopIfAborted();

  // 2. Tara's assessment, then what privacy allows: a possible minor, or people who cannot be blurred, stop here with
  // nothing kept; a person or a plate is blurred, in everything made and in the copy that is kept.
  status(TARA, "Looking at the photo: subject, light, clutter, what must not change");
  const assessment = await assessPhoto(g, original.id, got.normalized.buffer, assessContextFor(ctx, note, original), { vision: deps.vision, model: models.assess, now: now(), record: false });
  stopIfAborted();
  const priv = readPrivacy(assessment);
  const emptyCaption: Caption = { caption: "", altText: "", hashtags: [], edits: [], lint: [], by: "facts" };
  const stoppedResult = (stopped: NonNullable<StudioResult["stopped"]>, tilt: StudioResult["tilt"], plan: CropPlan): StudioResult => ({
    original, assessment, tilt, plan, variants: [], fidelity: [], caption: emptyCaption, context: ctx, recommendationId: "", approvalId: "", title: "", stopped,
  });
  if (priv.stop) {
    const message = STOP_MESSAGE[priv.stop];
    await blockOriginal(g, { asset: original, reason: priv.stop, now: now() });
    status(TARA, priv.stop === "minor" ? "A child is in the photo: not keeping it" : "People are in the photo and cannot be blurred: not keeping it");
    done(TARA, false);
    send({ type: "error", message });
    send({ type: "final", turnId: original.id, answer: message, citations: [], checks: CHECKS_NA, agents: [TARA], ms: Math.max(0, now() - t0) });
    return stoppedResult({ reason: "privacy", message }, { deg: 0, source: "level" }, planCrop({ w: original.w, h: original.h }, 0, []));
  }
  const redacted = priv.boxes.length > 0;
  const kept = redacted ? await blurBoxes(got.normalized.buffer, priv.boxes) : got.normalized.buffer;
  if (priv.people) status(TARA, "A person is in the photo: blurring them everywhere, and the original with the person will not be kept");
  else if (redacted) status(TARA, "A number plate or house number is in the photo: blurring it everywhere, including the copy we keep");
  original = await keepOriginal(g, { tenant: input.tenant, asset: original, kept, redacted, containsPerson: priv.people, store: deps.store, now: now() });
  await recordAssessment(g, original.id, assessment, now());
  send(got.event); // after the copy exists, so its thumbnail is never a missing file
  send({ type: "assessment", agent: TARA, assetId: original.id, verdict: assessment.verdict, overlays: assessment.overlays });
  if (ctx.project?.pageId) await upsertEdge(g, { from: original.id, type: "DEPICTS", to: ctx.project.pageId, props: { via: "owner note" } }, now()).catch(() => undefined);
  stopIfAborted();

  // 3. the plan (code): straighten and crop
  const tilt = chooseTilt(await estimateTilt(got.normalized.buffer), assessment.quality.tiltDeg);
  const plan = planCrop({ w: original.w, h: original.h }, tilt.deg, assessment.overlays);

  // A photo that cannot be saved stops here with Tara's one line on how to take it again: no variant, no generative edit,
  // no card to approve (content trial 2026-10-15: the studio used to carry on and offer the hopeless photo for approval).
  if (assessment.verdict === "reshoot") {
    const message = `Tara can't save this photo${assessment.coaching ? `: ${assessment.coaching}` : "."} Nothing was made and no Studio credit was used.`;
    status(TARA, "This photo can't be saved: no edit made");
    done(TARA);
    send({ type: "final", turnId: original.id, answer: message, citations: [original.id], checks: CHECKS_NA, agents: [TARA], ms: Math.max(0, now() - t0) });
    await keepRun(g, original.id, log, tilt, now(), "");
    return stoppedResult({ reason: "reshoot", message }, tilt, plan);
  }

  status(TARA, tilt.deg ? `Straightening by ${Math.abs(tilt.deg).toFixed(1)}° and cropping to 4:5 around the building` : "Cropping to 4:5 around the building");
  const privacy = priv.boxes;
  const base = await straightenedBase(got.normalized.buffer, plan, privacy);
  const variants: VariantRecord[] = [];

  // 4. variant A, local
  status(TARA, `Variant A: grading toward the brand's paper tone ${ctx.brand.paper}`);
  const a = await makeVariantA(g, { store: deps.store, now: now() }, input.tenant, original, base, { paper: ctx.brand.paper, rotate: plan.rotate });
  variants.push(a);
  send({ type: "asset", agent: TARA, assetId: a.id, kind: "variant", parentId: original.id, thumb: assetUrl(input.tenant, a.id, 640) });
  stopIfAborted();

  // 5. variant B, generative (prompted from the graph). A photo Tara says to post as it is gets no generative edit: it
  // would cost a credit and could only risk what is already good.
  let b: VariantRecord | null = null;
  if (assessment.verdict === "use") {
    status(TARA, "This photo is good as it is: no generative edit is needed, so you can post it as it is (variant A only straightens and crops)");
  } else {
    const treatment = TREATMENTS["relight-clean-editorial"]!;
    const prompt = await buildEditPrompt(g, ctx, assessment, treatment, now());
    status(TARA, `Variant B: ${treatment.label.toLowerCase()}, prompt built from ${prompt.sources.length} brand and rule nodes`);
    try {
      // the engine is given the blurred copy: a person or a plate never leaves the studio unblurred
      b = await makeVariantB(g, { store: deps.store, now: now(), engine: deps.engine }, input.tenant, original, kept, base, plan, privacy, treatment, prompt);
    } catch (e) {
      status(TARA, `Variant B skipped: ${(e as Error).message.slice(0, 90)}`);
    }
    if (!b) status(TARA, "No generative edit for this photo yet: live edits arrive with the Higgsfield API in Phase 2");
  }
  if (b) variants.push(b);
  if (b) send({ type: "asset", agent: TARA, assetId: b.id, kind: "variant", parentId: original.id, thumb: assetUrl(input.tenant, b.id, 640) });
  done(TARA);
  send({ type: "handoff", from: TARA, to: NISHA, note: `${variants.length} variant${variants.length === 1 ? "" : "s"} to check against the original` });
  stopIfAborted();

  // 6. Nisha's fidelity check
  start(NISHA, "Check every variant against the original: same building, nothing invented");
  status(NISHA, "Comparing edges and shapes with the original");
  const fidelity = await checkFidelity(g, { businessName: ctx.business.name, original: kept, base, locks: assessment.locks, variants }, {
    vision: deps.vision, model: models.fidelity, now: now(),
  });
  for (const f of fidelity) send({ type: "review", agent: NISHA, findingId: f.assetId, verdict: f.badge === "unchanged" ? "ok" : "reject", note: `Variant ${f.label}: ${f.note}` });
  done(NISHA);
  send({ type: "handoff", from: NISHA, to: DEV, note: "Checked; caption the post" });
  stopIfAborted();

  // 7. Dev's caption
  start(DEV, "Write the caption in the brand's voice");
  status(DEV, deps.devRewrite ? "Rewriting Tara's draft caption, then holding it to the voice rules" : "Holding Tara's draft caption to the voice rules and the brand's don'ts");
  const pick = variants.find((v) => fidelity.find((f) => f.assetId === v.id)?.badge === "unchanged") ?? a;
  const caption = await writeCaption(ctx, assessment, note, deps.devRewrite ? await thumbnail(pick.buffer, 768) : null,
    { vision: deps.devRewrite ? deps.vision : null, model: models.caption });
  if (caption.edits.length) status(DEV, `Voice check: ${caption.edits.slice(0, 3).join("; ")}`);
  done(DEV);
  stopIfAborted();

  // 8. the approval card
  const card = await proposeStudioDraft(g, {
    original, variants, fidelity, caption, ctx, assessment, now: now(),
    ...(redacted ? { privacy: { people: priv.people, redacted: true, note: privacyNote(priv) } } : {}),
  });
  send({ type: "proposal", agent: TARA, recommendationId: card.recommendationId, approvalId: card.approvalId, title: card.title, kind: "content_draft" });

  const okCount = fidelity.filter((f) => f.badge === "unchanged").length;
  const answer = [
    `Tara: ${assessment.verdict} (${assessment.subject}).`,
    `${variants.length} variant${variants.length === 1 ? "" : "s"}; Nisha passed ${okCount} as "building unchanged".`,
    `Dev's caption is on the card, waiting for your approval (1 Studio credit when approved).`,
  ].join(" ");
  send({
    type: "final", turnId: original.id, answer, citations: [original.id, ...variants.map((v) => v.id), card.approvalId], checks: CHECKS_NA,
    agents: [TARA, NISHA, DEV], ms: Math.max(0, now() - t0),
  });

  await keepRun(g, original.id, log, tilt, now(), card.approvalId);

  return { original, assessment, tilt, plan, variants, fidelity, caption, context: ctx, ...card };
}

// Keeps the run on the original, for the page after a reload (and the public demo).
async function keepRun(g: GraphHandle, id: string, log: AgentEvent[], tilt: StudioResult["tilt"], now: number, approvalId: string): Promise<void> {
  const [row] = await g.roQuery<{ name: string }>("MATCH (x:Entity:Asset {id:$id}) RETURN x.name AS name", { id });
  await upsertNode(g, {
    type: "Asset", id, name: row?.name ?? id,
    props: { status: "assessed", studioEvents: JSON.stringify(log), studioRunAt: now, ...(approvalId ? { approvalId } : {}), tiltDeg: tilt.deg, tiltSource: tilt.source },
  }, now);
}

// The latest run's events for the Studio page, newest first by run time.
export async function latestStudioRun(g: GraphHandle): Promise<{ assetId: string; at: number; note: string; events: AgentEvent[] } | null> {
  const [row] = await g.roQuery<{ id: string; at: number; events: string; note: string | null }>(
    "MATCH (a:Asset) WHERE a.kind = 'original' AND a.studioEvents IS NOT NULL RETURN a.id AS id, a.studioRunAt AS at, a.studioEvents AS events, a.note AS note ORDER BY a.studioRunAt DESC, a.id LIMIT 1");
  if (!row) return null;
  try {
    return { assetId: row.id, at: row.at, note: row.note ?? "", events: JSON.parse(row.events) as AgentEvent[] };
  } catch {
    return null;
  }
}
