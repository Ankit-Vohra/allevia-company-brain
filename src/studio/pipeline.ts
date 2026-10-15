// One Studio run, streamed as AgentEvents so the office and the Studio page show who did what (product design §6):
//   intake (asset) → Tara assesses (assessment) → the plan straightens and crops → variant A, local (asset) →
//   variant B, generative, prompted from the graph (asset) → Nisha checks both (review) → Dev writes the caption →
//   the approval card (proposal) → final.
// The run's events are kept on the original Asset (studioEvents), so the page can show the last run after a reload.
import type { AgentEvent, AgentId, TurnChecks } from "../../shared/contracts.js";
import type { GraphHandle } from "../graph/client.js";
import { upsertEdge, upsertNode } from "../graph/upsert.js";
import { ensureRoster } from "../agent/memory.js";
import { assessPhoto, TARA, type AssessContext, type PhotoAssessment } from "./assess.js";
import { proposeStudioDraft } from "./approve.js";
import { DEV, writeCaption, type Caption } from "./caption.js";
import { loadStudioContext, type StudioContext } from "./context.js";
import type { GenerationEngine } from "./engine.js";
import { checkFidelity, NISHA, type FidelityResult } from "./fidelity.js";
import { estimateTilt, planCrop, straightenedBase, thumbnail, type CropPlan } from "./image.js";
import { assetUrl, intake, type AssetRecord } from "./intake.js";
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

  // 1. intake
  start(TARA, "Look at the new photo and plan the post");
  status(TARA, "Receiving the photo: stripping location data, fingerprinting it");
  const got = await intake(g, { tenant: input.tenant, bytes: input.bytes, note, ownerId: input.ownerId ?? ctx.owner?.id ?? null }, { store: deps.store, now: now(), agent: TARA });
  const original = got.asset;
  send(got.event);
  if (ctx.project?.pageId) await upsertEdge(g, { from: original.id, type: "DEPICTS", to: ctx.project.pageId, props: { via: "owner note" } }, now()).catch(() => undefined);
  stopIfAborted();

  // 2. Tara's assessment
  status(TARA, "Looking at the photo: subject, light, clutter, what must not change");
  const assessment = await assessPhoto(g, original.id, got.normalized.buffer, assessContextFor(ctx, note, original), { vision: deps.vision, model: models.assess, now: now() });
  send({ type: "assessment", agent: TARA, assetId: original.id, verdict: assessment.verdict, overlays: assessment.overlays });
  stopIfAborted();

  // 3. the plan (code): straighten and crop
  const tilt = chooseTilt(await estimateTilt(got.normalized.buffer), assessment.quality.tiltDeg);
  const plan = planCrop({ w: original.w, h: original.h }, tilt.deg, assessment.overlays);
  status(TARA, tilt.deg ? `Straightening by ${Math.abs(tilt.deg).toFixed(1)}° and cropping to 4:5 around the building` : "Cropping to 4:5 around the building");
  const privacy = assessment.overlays.filter((o) => o.kind === "privacy");
  const base = await straightenedBase(got.normalized.buffer, plan, privacy);
  const variants: VariantRecord[] = [];

  // 4. variant A, local
  status(TARA, `Variant A: grading toward the brand's paper tone ${ctx.brand.paper}`);
  const a = await makeVariantA(g, { store: deps.store, now: now() }, input.tenant, original, base, { paper: ctx.brand.paper, rotate: plan.rotate });
  variants.push(a);
  send({ type: "asset", agent: TARA, assetId: a.id, kind: "variant", parentId: original.id, thumb: assetUrl(input.tenant, a.id, 640) });
  stopIfAborted();

  // 5. variant B, generative (prompted from the graph)
  const treatment = TREATMENTS["relight-clean-editorial"]!;
  const prompt = await buildEditPrompt(g, ctx, assessment, treatment, now());
  status(TARA, `Variant B: ${treatment.label.toLowerCase()}, prompt built from ${prompt.sources.length} brand and rule nodes`);
  let b: VariantRecord | null = null;
  try {
    b = await makeVariantB(g, { store: deps.store, now: now(), engine: deps.engine }, input.tenant, original, got.normalized.buffer, base, plan, privacy, treatment, prompt);
  } catch (e) {
    status(TARA, `Variant B skipped: ${(e as Error).message.slice(0, 90)}`);
  }
  if (b) {
    variants.push(b);
    send({ type: "asset", agent: TARA, assetId: b.id, kind: "variant", parentId: original.id, thumb: assetUrl(input.tenant, b.id, 640) });
  } else {
    status(TARA, "No generative edit for this photo yet: live edits arrive with the Higgsfield API in Phase 2");
  }
  done(TARA);
  send({ type: "handoff", from: TARA, to: NISHA, note: `${variants.length} variant${variants.length === 1 ? "" : "s"} to check against the original` });
  stopIfAborted();

  // 6. Nisha's fidelity check
  start(NISHA, "Check every variant against the original: same building, nothing invented");
  status(NISHA, "Comparing edges and shapes with the original");
  const fidelity = await checkFidelity(g, { businessName: ctx.business.name, original: got.normalized.buffer, base, locks: assessment.locks, variants }, {
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
  const card = await proposeStudioDraft(g, { original, variants, fidelity, caption, ctx, assessment, now: now() });
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

  // keep the run on the original, for the page after a reload (and the public demo)
  const [row] = await g.roQuery<{ name: string }>("MATCH (x:Entity:Asset {id:$id}) RETURN x.name AS name", { id: original.id });
  await upsertNode(g, {
    type: "Asset", id: original.id, name: row?.name ?? original.id,
    props: { status: "assessed", studioEvents: JSON.stringify(log), studioRunAt: now(), approvalId: card.approvalId, tiltDeg: tilt.deg, tiltSource: tilt.source },
  }, now());

  return { original, assessment, tilt, plan, variants, fidelity, caption, context: ctx, ...card };
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
