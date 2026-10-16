// The Studio's API (product design §8), mounted by createApp:
//   POST /api/:t/studio/intake    multipart {photo, note?}; the run streams back as AgentEvents (SSE): asset, assessment,
//                                 asset (variant A), asset (variant B), review, proposal, final
//   GET  /api/:t/assets/:id       the asset's file (?w= for a smaller copy), only when the Asset is in this tenant's graph
//   GET  /api/:t/assets/:id/lineage  how it was made: parents, jobs and cost, rules, Nisha's check, the card and the post
//   GET  /api/:t/studio/latest    the last run's events and where its card stands (for the page after a reload)
//   POST /api/:t/studio/approve   {approvalId, variantId?, caption?}: the owner picks a variant; writes the draft post
//   POST /api/:t/studio/revise    {approvalId, instruction | retryOf}: a change in the owner's words (free light and colour, or the AI editor)
//   GET|PUT /api/:t/studio/settings  "Blur people's faces in my content" and the answer language
//   GET  /api/:t/studio/sample    the demo photo prepared for this tenant, if any (and /sample.jpg, the file)
// Uploads are the one place the API takes more than 64 KB; one Studio run at a time per server.
import { readFileSync } from "node:fs";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AgentEvent } from "../../shared/contracts.js";
import type { GraphHandle } from "../graph/client.js";
import { approveStudioDraft, finalizeStudioDraft, studioCard } from "../studio/approve.js";
import { BrandUploadRejected, ingestBrandUpload } from "../brand/upload.js";
import { activeLogo, getBrandAsset, listBrandAssets, type BrandAssetRow } from "../brand/library.js";
import { loadStudioContext } from "../studio/context.js";
import { ImageRejected, thumbnail } from "../studio/image.js";
import { assetUrl } from "../studio/intake.js";
import { CHECKS_NA, latestStudioRun, runStudio, type StudioDeps } from "../studio/pipeline.js";
import { generateVariant } from "../studio/generate.js";
import { makePremiumAd } from "../studio/premium.js";
import { assetLineage } from "../studio/lineage.js";
import type { ClipPort } from "../studio/clip.js";
import { reviseVariant } from "../studio/revise.js";
import { routeRequest } from "../studio/request.js";
import { creditsWords } from "../studio/credits.js";
import { TARA } from "../studio/assess.js";
import { NISHA } from "../studio/fidelity.js";
import { loadLanguagePreference, setLanguagePreference } from "../agent/language.js";
import { loadStudioSettings, setBlurFaces } from "../studio/settings.js";
import { VisionError } from "../studio/vision.js";
import type { StudioSample } from "../studio/wiring.js";
import type { Decision, OnDecision } from "./approvals.js";
import { approval as readApproval } from "./reads.js";
import { sse } from "./sse.js";

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const STUDIO_UPLOAD_PATH = /^\/api\/[^/]+\/studio\/(?:intake|brand)$/;

export interface StudioWiring {
  deps: Omit<StudioDeps, "now" | "signal">;
  /** The 5 second clip option (studio/clip.ts), when the live engine is on. */
  clip?: ClipPort;
  sample?: (tenant: string) => StudioSample | null;
}

type Status = 400 | 403 | 404 | 409 | 413 | 429 | 500 | 501 | 503;

export interface StudioHelpers {
  tenantOf: (c: Context) => Promise<{ reg: { slug: string; businessId: string }; g: GraphHandle }>;
  refuseInPublicMode: () => void;
  fail: (status: Status, message: string) => never;
  studio?: () => Promise<StudioWiring | null>;
  // records a decision the way every surface does (server/approvals.ts `decide`: executors, learning loop, hooks)
  decide: (g: GraphHandle, tenant: string, id: string, d: Decision) => Promise<{ status: string }>;
  heartbeatMs: number;
  now: () => number;
  log: (line: string) => void;
}

// What the owner sees when a run stops: the photo's own problem in plain words, anything else as one calm sentence.
export function studioErrorMessage(e: unknown): string {
  if (e instanceof ImageRejected) return e.message;
  if (e instanceof VisionError) {
    return /rate.?limit|limit/i.test(e.message)
      ? "Tara can't look at photos right now: the team's model allowance is used up for the moment. Try again in a little while."
      : "Tara couldn't look at the photo this time. Try again in a moment.";
  }
  return "The Studio stopped on an unexpected problem; nothing was posted. Try again in a moment.";
}

export function mountStudio(app: Hono, h: StudioHelpers): void {
  let busy = false;
  const wiring = async (): Promise<StudioWiring> => {
    const w = await h.studio?.();
    if (!w) h.fail(501, "The Studio is not set up on this server.");
    return w!;
  };

  app.post("/api/:t/studio/intake",
    bodyLimit({ maxSize: MAX_UPLOAD_BYTES + 64 * 1024, onError: (c) => c.json({ error: "That photo is too large: send one under 20 MB." }, 413) }),
    async (c) => {
      const { reg, g } = await h.tenantOf(c);
      h.refuseInPublicMode();
      const w = await wiring();
      let form: Record<string, string | File | (string | File)[]>;
      try {
        form = await c.req.parseBody();
      } catch {
        h.fail(400, "Send the photo as multipart/form-data with a `photo` field.");
      }
      const photo = form!.photo;
      if (!(photo instanceof File) || photo.size === 0) h.fail(400, "Add a photo first.");
      const file = photo as File;
      if (file.size > MAX_UPLOAD_BYTES) h.fail(413, "That photo is too large: send one under 20 MB.");
      const note = typeof form!.note === "string" ? form!.note.trim().slice(0, 500) : "";
      if (busy) h.fail(429, "The Studio is already working on a photo. Try again in a minute.");
      busy = true;
      const bytes = Buffer.from(await file.arrayBuffer());
      try {
        return sse<AgentEvent>(c, { heartbeatMs: h.heartbeatMs, log: h.log }, async (send, signal) => {
          try {
            await runStudio(g, { tenant: reg.slug, businessId: reg.businessId, bytes, ...(note ? { note } : {}) }, { ...w.deps, now: h.now, signal }, send);
          } catch (e) {
            if (!signal.aborted) {
              h.log(`[studio] ${reg.slug}: ${e instanceof Error ? e.message : String(e)}`);
              send({ type: "error", message: studioErrorMessage(e) });
            }
          } finally {
            busy = false;
          }
        });
      } catch (e) {
        busy = false;
        throw e;
      }
    });

  // The owner's words under the options, on the web: the same routing as the Discord thread (studio/request.ts). Light and
  // colour changes are free and local; "make it festive", "change the background", "make this into an ad saying ..." and
  // "try again" go to the AI editor, quoted and capped. Streams AgentEvents: status lines, the new option (asset), Nisha's
  // check (review) and a final line the page shows.
  app.post("/api/:t/studio/revise", async (c) => {
    const { reg, g } = await h.tenantOf(c);
    h.refuseInPublicMode();
    const w = await wiring();
    let body: { approvalId?: unknown; instruction?: unknown; retryOf?: unknown };
    try {
      body = await c.req.json();
    } catch {
      h.fail(400, "The request body must be JSON.");
    }
    const approvalId = typeof body!.approvalId === "string" ? body!.approvalId : "";
    const instruction = typeof body!.instruction === "string" ? body!.instruction.trim().slice(0, 400) : "";
    const retryOf = typeof body!.retryOf === "string" && /^[A-Z][A-Z0-9]{0,3}$/.test(body!.retryOf) ? body!.retryOf : undefined;
    if (!approvalId || approvalId.length > 200) h.fail(400, "Say which card: approvalId.");
    if (!instruction && !retryOf) h.fail(400, "Say what to change.");
    if (busy) h.fail(429, "The Studio is already working on a photo. Try again in a minute.");
    busy = true;
    try {
      return sse<AgentEvent>(c, { heartbeatMs: h.heartbeatMs, log: h.log }, async (send, signal) => {
        const t0 = h.now();
        const say = (answer: string) => send({ type: "final", turnId: approvalId, answer, citations: [], checks: CHECKS_NA, agents: [TARA], ms: Math.max(0, h.now() - t0) });
        try {
          const req = retryOf ? { kind: "retry" as const } : routeRequest(instruction);
          const ids = { tenant: reg.slug, businessId: reg.businessId, approvalId };
          send({ type: "agent_start", agent: TARA, task: "Make the change you asked for" });
          const status = (text: string) => send({ type: "agent_status", agent: TARA, text });
          if (req.kind === "chat") {
            send({ type: "agent_done", agent: TARA, ms: 0, ok: true });
            return say("Tell me what you would like changed, for example \"make it warmer\", \"make it festive\", \"a different background\", \"make this a premium UGC ad\", or \"make this into an ad saying ...\".");
          }
          if (req.kind === "clip") {
            send({ type: "agent_done", agent: TARA, ms: 0, ok: true });
            return say(w.clip ? (await w.clip.offer(ids)).message : "I can't make video clips here yet. I can make photos: ask for a change, or an ad.");
          }
          if (req.kind === "adjust") {
            const r = await reviseVariant(g, { ...ids, instruction }, { ...w.deps, now: h.now() });
            send({ type: "agent_done", agent: TARA, ms: Math.max(0, h.now() - t0), ok: r.ok });
            if (!r.ok) return say(r.message);
            send({ type: "asset", agent: TARA, assetId: r.variant.id, kind: "variant", parentId: "", thumb: assetUrl(reg.slug, r.variant.id, 640) });
            send({ type: "review", agent: NISHA, findingId: r.variant.id, verdict: r.fidelity.badge === "unchanged" ? "ok" : "reject", note: `Variant ${r.variant.label}: ${r.fidelity.note}` });
            return say(`Option ${r.variant.label}: ${r.adjustment.label} (free, made with the team's own light and colour tools).`);
          }
          if (req.kind === "premium") {
            const r = await makePremiumAd(g, { ...ids, request: { words: req.words, ...(req.headline ? { headline: req.headline } : {}), ...(req.sub ? { sub: req.sub } : {}) } }, { ...w.deps, now: h.now(), status });
            send({ type: "agent_done", agent: TARA, ms: Math.max(0, h.now() - t0), ok: r.ok });
            if (!r.ok) return say(r.message);
            send({ type: "asset", agent: TARA, assetId: r.variant.id, kind: "variant", parentId: "", thumb: assetUrl(reg.slug, r.variant.id, 640) });
            send({ type: "review", agent: NISHA, findingId: r.variant.id, verdict: r.passed ? "ok" : "reject", note: `Variant ${r.variant.label}: ${r.fidelity.note}` });
            const cost = r.variant.credits !== undefined && r.variant.credits > 0 ? ` It used ${creditsWords(r.variant.credits, { about: true })}.` : "";
            return say(r.passed
              ? `Option ${r.variant.label} is your premium ad picture, and Nisha checked that the product is unchanged.${cost} Ask for "a clip" and I will price a 5 second vertical clip from it first.`
              : `Option ${r.variant.label} was held back: ${r.fidelity.note}${cost} You can ask for it again in other words, or pick another option.`);
          }
          const request = req.kind === "retry" ? { kind: "retry" as const, ...(retryOf ? { of: retryOf } : {}) }
            : req.kind === "ad" ? { kind: "ad" as const, words: req.words, ...(req.headline ? { headline: req.headline } : {}), ...(req.sub ? { sub: req.sub } : {}) }
            : { kind: "request" as const, words: req.words };
          const r = await generateVariant(g, { ...ids, request }, { ...w.deps, now: h.now(), status });
          send({ type: "agent_done", agent: TARA, ms: Math.max(0, h.now() - t0), ok: r.ok });
          if (!r.ok) return say(r.message);
          send({ type: "asset", agent: TARA, assetId: r.variant.id, kind: "variant", parentId: "", thumb: assetUrl(reg.slug, r.variant.id, 640) });
          send({ type: "review", agent: NISHA, findingId: r.variant.id, verdict: r.passed ? "ok" : "reject", note: `Variant ${r.variant.label}: ${r.fidelity.note}` });
          const cost = r.variant.credits !== undefined ? ` It used ${creditsWords(r.variant.credits, { about: true })}.` : "";
          return say(r.passed ? `Option ${r.variant.label} is ready and Nisha checked it.${cost}` : `Option ${r.variant.label} was held back: ${r.fidelity.note}${cost}${r.canRetry ? ` I can try once more${r.retryQuote ? ` (${r.retryQuote})` : ""}.` : ""}`);
        } catch (e) {
          if (!signal.aborted) {
            h.log(`[studio] ${reg.slug}: ${e instanceof Error ? e.message : String(e)}`);
            send({ type: "error", message: studioErrorMessage(e) });
          }
        } finally {
          busy = false;
        }
      });
    } catch (e) {
      busy = false;
      throw e;
    }
  });

  // How a Studio picture or clip was made, read from the graph (studio/lineage.ts): the photo it came from, each step, the Higgsfield
  // jobs and what they cost, the rules, Nisha's check, the card and the post.
  app.get("/api/:t/assets/:id/lineage", async (c) => {
    const { g } = await h.tenantOf(c);
    const lineage = await assetLineage(g, c.req.param("id"));
    if (!lineage.root) h.fail(404, "No such asset.");
    return c.json(lineage);
  });

  app.get("/api/:t/assets/:id", async (c) => {
    const { reg, g } = await h.tenantOf(c);
    const id = c.req.param("id");
    const [row] = await g.roQuery<{ key: string | null; mime: string | null }>(
      "MATCH (a:Entity:Asset {id:$id}) RETURN a.storageKey AS key, a.mime AS mime LIMIT 1", { id });
    if (!row?.key) h.fail(404, "No such asset.");
    const w = await wiring();
    let bytes = w.deps.store.get(reg.slug, row!.key!);
    if (!bytes) h.fail(404, "That asset's file is missing.");
    // a clip is served as the video it is (no thumbnail of a video here)
    if (row!.mime?.startsWith("video/")) {
      return c.body(new Uint8Array(bytes!), 200, { "Content-Type": row!.mime, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=86400, immutable" });
    }
    const width = Number(c.req.query("w") ?? 0);
    if (Number.isFinite(width) && width > 0) bytes = await thumbnail(bytes!, Math.max(64, Math.min(1600, Math.round(width))));
    return c.body(new Uint8Array(bytes!), 200, {
      "Content-Type": width > 0 ? "image/jpeg" : row!.mime ?? "image/jpeg",
      "Cache-Control": "private, max-age=86400, immutable", // content-addressed: the bytes behind an id never change
    });
  });

  app.get("/api/:t/studio/latest", async (c) => {
    const { g } = await h.tenantOf(c);
    const run = await latestStudioRun(g);
    if (!run) return c.json({ run: null });
    const approvalId = [...run.events].reverse().find((e): e is Extract<AgentEvent, { type: "proposal" }> => e.type === "proposal")?.approvalId;
    const card = approvalId ? await readApproval(g, approvalId) : null;
    const [content] = approvalId
      ? await g.roQuery<{ id: string }>("MATCH (:Entity:Approval {id:$id})-[:RESULTED_IN]->(:Action)-[:RESULTED_IN]->(c:Content) RETURN c.id AS id LIMIT 1", { id: approvalId })
      : [];
    return c.json({ run: { ...run, approval: card ? { id: card.id, status: card.status, result: card.result ?? null, contentId: content?.id ?? null } : null } });
  });

  app.post("/api/:t/studio/approve", async (c) => {
    const { reg, g } = await h.tenantOf(c);
    h.refuseInPublicMode();
    let body: { approvalId?: unknown; variantId?: unknown; caption?: unknown };
    try {
      body = await c.req.json();
    } catch {
      h.fail(400, "The request body must be JSON.");
    }
    const approvalId = typeof body!.approvalId === "string" ? body!.approvalId : "";
    if (!approvalId || approvalId.length > 200) h.fail(400, "Say which card: approvalId.");
    const variantId = typeof body!.variantId === "string" && body!.variantId.length <= 200 ? body!.variantId : undefined;
    const caption = typeof body!.caption === "string" ? body!.caption.slice(0, 5000) : undefined;
    const r = await approveStudioDraft(g, { approvalId, ...(variantId ? { variantId } : {}), ...(caption !== undefined ? { caption } : {}), now: h.now() },
      (id, edited) => h.decide(g, reg.slug, id, { decision: "approve", ...(edited ? { editedPayload: edited } : {}) }));
    return c.json({ ...r, approval: await readApproval(g, approvalId) });
  });

  // A 5 second clip from a picture Nisha passed: without confirm it only quotes (nothing is spent); with confirm it makes it.
  app.post("/api/:t/studio/clip", async (c) => {
    const { reg } = await h.tenantOf(c);
    h.refuseInPublicMode();
    const w = await wiring();
    if (!w.clip) h.fail(501, "Clips are not switched on here.");
    let body: { approvalId?: unknown; variantId?: unknown; confirm?: unknown };
    try {
      body = await c.req.json();
    } catch {
      h.fail(400, "The request body must be JSON.");
    }
    const approvalId = typeof body!.approvalId === "string" && body!.approvalId.length <= 200 ? body!.approvalId : "";
    if (!approvalId) h.fail(400, "Say which card: approvalId.");
    const variantId = typeof body!.variantId === "string" && body!.variantId.length <= 200 ? body!.variantId : undefined;
    const ids = { tenant: reg.slug, businessId: reg.businessId, approvalId, ...(variantId ? { variantId } : {}) };
    if (body!.confirm !== true) return c.json(await w.clip!.offer(ids));
    if (busy) h.fail(429, "The Studio is already working. Try again in a minute.");
    busy = true;
    try {
      const r = await w.clip!.make(ids);
      return c.json(r.ok ? { ok: true, message: r.message, assetId: r.assetId, credits: r.credits, url: `/api/${encodeURIComponent(reg.slug)}/assets/${encodeURIComponent(r.assetId)}` } : { ok: false, message: r.message });
    } finally {
      busy = false;
    }
  });

  // The owner's Studio and language settings: "Blur people's faces in my content" (off by default) and the language the
  // team answers in ("auto" follows the question). Per business: a tenant only ever reads or writes its own graph.
  app.get("/api/:t/studio/settings", async (c) => {
    const { g } = await h.tenantOf(c);
    return c.json({ ...(await loadStudioSettings(g)), language: (await loadLanguagePreference(g)) ?? "auto" });
  });

  app.put("/api/:t/studio/settings", async (c) => {
    const { g } = await h.tenantOf(c);
    h.refuseInPublicMode();
    let body: { blurFaces?: unknown; language?: unknown };
    try {
      body = await c.req.json();
    } catch {
      h.fail(400, "The request body must be JSON.");
    }
    if (body!.blurFaces !== undefined && typeof body!.blurFaces !== "boolean") h.fail(400, "blurFaces must be true or false.");
    if (body!.language !== undefined && typeof body!.language !== "string") h.fail(400, "language must be a word such as \"auto\", \"english\" or \"hindi\".");
    if (body!.blurFaces === undefined && body!.language === undefined) h.fail(400, "Say what to change: blurFaces or language.");
    if (typeof body!.blurFaces === "boolean") await setBlurFaces(g, undefined, body!.blurFaces, h.now());
    if (typeof body!.language === "string") await setLanguagePreference(g, body!.language, h.now());
    return c.json({ ...(await loadStudioSettings(g)), language: (await loadLanguagePreference(g)) ?? "auto" });
  });

  // ----- the brand library: what the owner files (logo, palette, fonts, guide, product photos, past designs) -----

  const brandDto = (tenant: string, a: BrandAssetRow) => ({
    id: a.id, kind: a.kind, name: a.name, origin: a.origin, mime: a.mime, w: a.w, h: a.h, status: a.status, description: a.description,
    family: a.family, value: a.value, colours: a.colours, needsBetter: a.needsBetter, containsPerson: a.containsPerson,
    ...(a.storageKey ? { url: `/api/${encodeURIComponent(tenant)}/brand/${encodeURIComponent(a.id)}/file` } : {}),
  });

  app.post("/api/:t/studio/brand",
    bodyLimit({ maxSize: MAX_UPLOAD_BYTES + 64 * 1024, onError: (c) => c.json({ error: "That file is too large: send one under 20 MB." }, 413) }),
    async (c) => {
      const { reg, g } = await h.tenantOf(c);
      h.refuseInPublicMode();
      const w = await wiring();
      let form: Record<string, string | File | (string | File)[]>;
      try {
        form = await c.req.parseBody();
      } catch {
        h.fail(400, "Send the file as multipart/form-data with a `file` field.");
      }
      const file = form!.file;
      if (!(file instanceof File) || file.size === 0) h.fail(400, "Add a file first.");
      const f = file as File;
      if (f.size > MAX_UPLOAD_BYTES) h.fail(413, "That file is too large: send one under 20 MB.");
      const note = typeof form!.note === "string" ? form!.note.trim().slice(0, 500) : "";
      try {
        const ctx = await loadStudioContext(g, reg.businessId).catch(() => null);
        const r = await ingestBrandUpload(g, {
          tenant: reg.slug, businessId: reg.businessId, bytes: Buffer.from(await f.arrayBuffer()), filename: f.name.slice(0, 200), source: "web",
          ...(note ? { note } : {}), ...(ctx?.owner ? { ownerId: ctx.owner.id } : {}),
        }, { store: w.deps.store, vision: w.deps.vision, now: h.now() });
        return c.json({ route: r.route, kind: r.kind, message: r.message, needsBetter: r.needsBetter, asset: r.asset ? { id: r.asset.id, kind: r.asset.kind } : null });
      } catch (e) {
        if (e instanceof BrandUploadRejected) h.fail(400, e.message);
        h.log(`[brand] ${reg.slug}: ${e instanceof Error ? e.message : String(e)}`);
        h.fail(500, studioErrorMessage(e));
      }
    });

  app.get("/api/:t/brand", async (c) => {
    const { reg, g } = await h.tenantOf(c);
    const [assets, logo] = await Promise.all([listBrandAssets(g), activeLogo(g)]);
    return c.json({ assets: assets.map((a) => brandDto(reg.slug, a)), logo: logo ? brandDto(reg.slug, logo) : null });
  });

  app.get("/api/:t/brand/:id/file", async (c) => {
    const { reg, g } = await h.tenantOf(c);
    const a = await getBrandAsset(g, c.req.param("id"));
    if (!a?.storageKey) h.fail(404, "No such brand file.");
    const w = await wiring();
    const bytes = w.deps.store.get(reg.slug, a!.storageKey!);
    if (!bytes) h.fail(404, "That file is missing.");
    const image = a!.mime === "image/png" || a!.mime === "image/jpeg";
    // never sniffed, and only pictures are shown inline: a PDF or a font is a download
    return c.body(new Uint8Array(bytes!), 200, {
      "Content-Type": image ? a!.mime! : "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
      ...(image ? {} : { "Content-Disposition": `attachment; filename="${(a!.family ?? a!.kind).replace(/[^A-Za-z0-9._-]/g, "_")}.${(a!.storageKey!.split(".").pop() ?? "bin")}"` }),
      "Cache-Control": "private, max-age=86400, immutable",
    });
  });

  app.get("/api/:t/studio/sample", async (c) => {
    const { reg } = await h.tenantOf(c);
    const s = (await wiring()).sample?.(reg.slug);
    if (!s) h.fail(404, "No sample photo has been prepared for this business.");
    return c.json({ note: s!.note, caption: s!.caption, url: `/api/${encodeURIComponent(reg.slug)}/studio/sample.jpg` });
  });

  app.get("/api/:t/studio/sample.jpg", async (c) => {
    const { reg } = await h.tenantOf(c);
    const s = (await wiring()).sample?.(reg.slug);
    if (!s) h.fail(404, "No sample photo has been prepared for this business.");
    return c.body(new Uint8Array(readFileSync(s!.file)), 200, { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=600" });
  });
}

// A Studio card approved from the general Approvals list (or Discord) still becomes a draft: the recommended variant
// and the caption as approved. Chained before the server's own onDecision hook.
export function studioDecisionHook(openGraph: (slug: string) => Promise<GraphHandle>, now: () => number, next?: OnDecision): OnDecision {
  return async (tenant, approval) => {
    const posts = approval.kind === "publish_post";
    if ((approval.kind === "content_draft" || posts) && ["approved", "edited", "executed", ...(posts ? ["failed"] : [])].includes(approval.status)) {
      const g = await openGraph(tenant);
      const card = await studioCard(g, approval.id);
      // the executor may already have written the draft; the Studio's part is missing until it USES_ASSET a variant (a post that goes
      // out writes its own Content, so there the Studio's part is done once the card has been finalized: it remembers its Content)
      const [done] = card ? (posts
        ? await g.roQuery<{ c: number }>("MATCH (a:Entity:Approval {id:$id}) WHERE a.contentId IS NOT NULL RETURN count(a) AS c", { id: approval.id })
        : await g.roQuery<{ c: number }>(
          "MATCH (:Entity:Approval {id:$id})-[r1:RESULTED_IN]->(:Action)-[r2:RESULTED_IN]->(:Content)-[u:USES_ASSET]->(:Asset) WHERE ID(r1) >= 0 AND ID(r2) >= 0 RETURN count(u) AS c", { id: approval.id })) : [];
      if (card && !done?.c) {
        const v = card.payload.studio.variants.find((x) => x.id === card.payload.studio.recommended);
        if (v?.badge === "unchanged" || (v?.badge === "unchecked" && card.payload.studio.creative?.allowUnchecked)) {
          await finalizeStudioDraft(g, approval.id, card.payload, v.id, approval.editedPayload?.body ?? card.payload.body, now());
        }
      }
    }
    await next?.(tenant, approval);
  };
}
