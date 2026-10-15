// The Studio's API (product design §8), mounted by createApp:
//   POST /api/:t/studio/intake    multipart {photo, note?}; the run streams back as AgentEvents (SSE): asset, assessment,
//                                 asset (variant A), asset (variant B), review, proposal, final
//   GET  /api/:t/assets/:id       the asset's file (?w= for a smaller copy), only when the Asset is in this tenant's graph
//   GET  /api/:t/studio/latest    the last run's events and where its card stands (for the page after a reload)
//   POST /api/:t/studio/approve   {approvalId, variantId?, caption?}: the owner picks a variant; writes the draft post
//   GET  /api/:t/studio/sample    the demo photo prepared for this tenant, if any (and /sample.jpg, the file)
// Uploads are the one place the API takes more than 64 KB; one Studio run at a time per server.
import { readFileSync } from "node:fs";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AgentEvent } from "../../shared/contracts.js";
import type { GraphHandle } from "../graph/client.js";
import { approveStudioDraft, finalizeStudioDraft, studioCard } from "../studio/approve.js";
import { ImageRejected, thumbnail } from "../studio/image.js";
import { latestStudioRun, runStudio, type StudioDeps } from "../studio/pipeline.js";
import { VisionError } from "../studio/vision.js";
import type { StudioSample } from "../studio/wiring.js";
import type { Decision, OnDecision } from "./approvals.js";
import { approval as readApproval } from "./reads.js";
import { sse } from "./sse.js";

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const STUDIO_UPLOAD_PATH = /^\/api\/[^/]+\/studio\/intake$/;

export interface StudioWiring {
  deps: Omit<StudioDeps, "now" | "signal">;
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

  app.get("/api/:t/assets/:id", async (c) => {
    const { reg, g } = await h.tenantOf(c);
    const id = c.req.param("id");
    const [row] = await g.roQuery<{ key: string | null; mime: string | null }>(
      "MATCH (a:Entity:Asset {id:$id}) RETURN a.storageKey AS key, a.mime AS mime LIMIT 1", { id });
    if (!row?.key) h.fail(404, "No such asset.");
    const w = await wiring();
    let bytes = w.deps.store.get(reg.slug, row!.key!);
    if (!bytes) h.fail(404, "That asset's file is missing.");
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
    if (approval.kind === "content_draft" && ["approved", "edited", "executed"].includes(approval.status)) {
      const g = await openGraph(tenant);
      const card = await studioCard(g, approval.id);
      // the executor may already have written the draft; the Studio's part is missing until it USES_ASSET a variant
      const [done] = card ? await g.roQuery<{ c: number }>(
        "MATCH (:Entity:Approval {id:$id})-[r1:RESULTED_IN]->(:Action)-[r2:RESULTED_IN]->(:Content)-[u:USES_ASSET]->(:Asset) WHERE ID(r1) >= 0 AND ID(r2) >= 0 RETURN count(u) AS c", { id: approval.id }) : [];
      if (card && !done?.c) {
        const v = card.payload.studio.variants.find((x) => x.id === card.payload.studio.recommended);
        if (v?.badge === "unchanged") {
          await finalizeStudioDraft(g, approval.id, card.payload, v.id, approval.editedPayload?.body ?? card.payload.body, now());
        }
      }
    }
    await next?.(tenant, approval);
  };
}
