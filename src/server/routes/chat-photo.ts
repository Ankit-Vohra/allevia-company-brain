// A photo sent in the chat: the owner attaches a photo and says what they want ("make this a premium ad", "a Diwali post").
//   POST /api/:t/chat/photo   multipart {photo, note?, sessionId?, target?}; an SSE stream of AgentEvents, like POST /api/:t/ask
// The photo takes the Studio's upload path (the same size limit; intake strips EXIF and location, keeps it in this business's own
// folder) and runs the Studio's pipeline unchanged (studio/pipeline.ts runStudio: Miss Influencer, the free clean-up and the AI
// edit with its quote, Fact Checker, Wordsmith, the card that waits for the OK). What is new is only the wrapper: the run is a
// live turn in the conversation (server/turns.ts), so it keeps going if the tab closes, and it is saved in the thread
// (agent/memory.ts saveTurn) with the options as a card the chat shows (a `deliverable`) and the Library lists.
// Nothing is charged here: the work needs credits left to start, and a post is charged when the owner says OK (as the Studio).
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AgentEvent, AgentId, DeliverableOption } from "../../../shared/contracts.js";
import type { CreditService } from "../../../shared/plans.js";
import { agentById } from "../../../shared/roster.js";
import type { GraphHandle } from "../../graph/client.js";
import { getSession, newSessionId, newTurnId, saveTurn, startSession } from "../../agent/memory.js";
import { studioCard } from "../../studio/approve.js";
import { TARA } from "../../studio/assess.js";
import { assetUrl } from "../../studio/intake.js";
import { CHECKS_NA, runStudio, type StudioResult } from "../../studio/pipeline.js";
import { MAX_UPLOAD_BYTES, studioErrorMessage, type StudioWiring } from "../studio.js";
import { sse } from "../sse.js";
import { HttpError, type RouteCtx } from "../http.js";
import type { LiveTurns } from "../turns.js";

export const CHAT_PHOTO_PATH = /^\/api\/[^/]+\/chat\/photo$/;

/** What the owner's message says when they send a photo with no words. */
export const DEFAULT_PHOTO_NOTE = "Make a post from this photo";
const ASKER = "person:founder";

export interface ChatPhotoDeps {
  turns: LiveTurns;
  studio?: () => Promise<StudioWiring | null>;
  gate?: (g: GraphHandle, tenant: string, service: CreditService) => Promise<void>;
  heartbeatMs: number;
}

const BADGE: Record<string, DeliverableOption["badge"]> = { unchanged: "ok", changed: "held", unchecked: "unchecked" };

/** The card the pipeline left, as the chat's "made" card: each option with Fact Checker's check, the pick first marked. */
export async function photoDeliverable(g: GraphHandle, tenant: string, r: Pick<StudioResult, "approvalId" | "title">): Promise<Extract<AgentEvent, { type: "deliverable" }> | null> {
  if (!r.approvalId) return null;
  const card = await studioCard(g, r.approvalId);
  if (!card) return null;
  const s = card.payload.studio;
  return {
    type: "deliverable", agent: TARA, kind: "image", title: r.title || card.payload.title, approvalId: r.approvalId, recommended: s.recommended,
    options: s.variants.map((v) => ({ assetId: v.id, label: v.label, badge: BADGE[v.badge] ?? "unchecked", note: v.note, thumb: assetUrl(tenant, v.id, 640), aiEdited: v.aiEdited })),
    notes: [...(s.privacy?.note ? [s.privacy.note] : []), ...(s.notices ?? [])],
  };
}

export function registerChatPhotoRoutes(app: Hono, ctx: RouteCtx, d: ChatPhotoDeps): void {
  let busy = false; // one photo at a time per server, like the Studio's own upload

  app.post("/api/:t/chat/photo",
    bodyLimit({ maxSize: MAX_UPLOAD_BYTES + 64 * 1024, onError: (c) => c.json({ error: "That photo is too large: send one under 20 MB." }, 413) }),
    async (c) => {
      const { reg, g } = await ctx.tenantOf(c);
      ctx.refuseInPublicMode();
      const w = await d.studio?.();
      if (!w) throw new HttpError(501, "Photos can't be made into posts on this server yet.");
      await d.gate?.(g, reg.slug, "picture");
      let form: Record<string, string | File | (string | File)[]>;
      try {
        form = await c.req.parseBody();
      } catch {
        throw new HttpError(400, "Send the photo as multipart/form-data with a `photo` field.");
      }
      const photo = form.photo;
      if (!(photo instanceof File) || photo.size === 0) throw new HttpError(400, "Add a photo first.");
      if (photo.size > MAX_UPLOAD_BYTES) throw new HttpError(413, "That photo is too large: send one under 20 MB.");
      const note = typeof form.note === "string" ? form.note.trim().slice(0, 500) : "";
      const sessionIn = typeof form.sessionId === "string" && form.sessionId.length > 0 && form.sessionId.length <= 200 ? form.sessionId : undefined;
      const targetIn = typeof form.target === "string" && form.target ? form.target : undefined;
      if (targetIn && !agentById(targetIn)) throw new HttpError(400, "That person is not on the team.");
      const target = targetIn && targetIn !== "chief-of-staff" ? targetIn : undefined;
      if (busy) throw new HttpError(429, "Miss Influencer is already working on a photo. Try again in a minute.");
      busy = true;
      const bytes = Buffer.from(await photo.arrayBuffer());
      const question = note || DEFAULT_PHOTO_NOTE;

      let turn;
      try {
        turn = d.turns.start(reg.slug, question, async (emit, signal) => {
          const at = ctx.now();
          const turnId = newTurnId(at);
          const sessionId = sessionIn ?? newSessionId(at);
          const log: AgentEvent[] = [];
          const out = (e: AgentEvent) => { log.push(e); emit(e); };
          out({ type: "session", tenant: reg.slug, sessionId, turnId, question });
          let answer = "";
          let failure: string | undefined;
          const agents = new Set<AgentId>([TARA]);
          try {
            if (!(await getSession(g, sessionId))) await startSession(g, { channel: "web", asker: ASKER, title: question, id: sessionId, ...(target ? { agent: target } : {}) }, at);
            // the pipeline's own `final` is held back: the turn's final comes last, after the card, with this turn's id
            const result = await runStudio(g, { tenant: reg.slug, businessId: reg.businessId, bytes, ...(note ? { note } : {}) }, { ...w.deps, now: ctx.now, signal }, (e) => {
              if (e.type === "final") { answer = e.answer; return; }
              if ("agent" in e && typeof e.agent === "string") agents.add(e.agent as AgentId);
              out(e);
            });
            const made = await photoDeliverable(g, reg.slug, result);
            if (made) out(made);
            if (answer) out({ type: "text", agent: TARA, delta: answer });
          } catch (e) {
            failure = signal.aborted ? "Stopped before the options were ready." : studioErrorMessage(e);
            if (!signal.aborted) ctx.log(`[chat-photo] ${reg.slug}: ${e instanceof Error ? e.message : String(e)}`);
            out({ type: "error", agent: TARA, message: failure });
          } finally {
            busy = false;
          }
          const final: AgentEvent = { type: "final", turnId, answer: failure && !answer ? failure : answer, citations: [], checks: CHECKS_NA, agents: [...agents], ms: Math.max(0, ctx.now() - at) };
          log.push(final);
          try {
            const proposals = log.filter((e): e is Extract<AgentEvent, { type: "proposal" }> => e.type === "proposal");
            await saveTurn(g, {
              turnId, sessionId, question, answer, asker: ASKER, source: "web", at, ms: Math.max(0, ctx.now() - at), status: failure ? "failed" : "ok",
              ...(failure ? { error: failure } : {}), ...(target ? { target } : {}), checks: CHECKS_NA, agents: [...agents], events: log, touched: [],
              citations: [], findings: [], reviews: [], made: proposals.flatMap((p) => [p.recommendationId, p.approvalId]),
            });
          } catch (e) {
            ctx.log(`[chat-photo] ${reg.slug}: could not save the turn: ${e instanceof Error ? e.message : String(e)}`);
          }
          emit(final);
          return { ok: !failure };
        }, target);
      } catch (e) {
        busy = false;
        throw e;
      }
      return sse<AgentEvent>(c, { heartbeatMs: d.heartbeatMs, log: ctx.log }, (send, signal) => turn.follow(0, send, signal));
    });
}
