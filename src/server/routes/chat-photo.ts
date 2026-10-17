// A photo sent in the chat: the owner attaches a photo and says what they want ("make this a premium ad", "a Diwali post").
//   POST /api/:t/chat/photo          multipart {photo, note?, sessionId?, target?}; an SSE stream of AgentEvents, like POST /api/:t/ask
//   POST /api/:t/chat/photo/change   {approvalId, instruction | retryOf | clip: true + variantId?, sessionId?, target?}: a change to
//                                    the photo's card, asked for on the chat's card or in the Library; the same SSE stream
// The photo takes the Studio's upload path (the same size limit; intake strips EXIF and location, keeps it in this business's own
// folder) and runs the Studio's pipeline unchanged (studio/pipeline.ts runStudio: Miss Influencer, the free clean-up and the AI
// edit with its quote, Fact Checker, Wordsmith, the card that waits for the OK). A change runs the Studio's own change path
// unchanged (server/studio.ts changeStudioOption, the one POST /studio/revise runs: light and colour free, the AI editor quoted and
// capped), and a clip the Studio's clip service (the one POST /studio/clip runs; the price is asked there first, without confirm,
// and nothing is made until the owner presses the button). What is new is only the wrapper: each run is a live turn in the
// conversation (server/turns.ts), so it keeps going if the tab closes, and it is saved in the thread (agent/memory.ts saveTurn)
// with what it made as a card the chat shows (a `deliverable`) and the Library lists. A change asked for in the Library joins the
// thread its photo was sent in.
// Nothing is charged here: the work needs credits left to start, and a post (with its clip) is charged when the owner says OK.
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
import { changeStudioOption, MAX_UPLOAD_BYTES, studioErrorMessage, type StudioWiring } from "../studio.js";
import { sse } from "../sse.js";
import { HttpError, type RouteCtx } from "../http.js";
import type { LiveTurn, LiveTurns } from "../turns.js";

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

type Made = Extract<AgentEvent, { type: "deliverable" }>;
const BADGE: Record<string, DeliverableOption["badge"]> = { unchanged: "ok", changed: "held", ["unchecked"]: "unchecked" };

/** The card the pipeline left, as the chat's "made" card: each option with Fact Checker's check, the pick first marked.
 *  `only`: just these options (a change shows the option it made, not the whole card again). */
export async function photoDeliverable(g: GraphHandle, tenant: string, r: Pick<StudioResult, "approvalId" | "title">, only?: string[]): Promise<Made | null> {
  if (!r.approvalId) return null;
  const card = await studioCard(g, r.approvalId);
  if (!card) return null;
  const s = card.payload.studio;
  const variants = only ? s.variants.filter((v) => only.includes(v.id)) : s.variants;
  if (!variants.length) return null;
  return {
    type: "deliverable", agent: TARA, kind: "image", title: r.title || card.payload.title, approvalId: r.approvalId, recommended: s.recommended, studio: true,
    options: variants.map((v) => ({ assetId: v.id, label: v.label, badge: BADGE[v.badge] ?? "unchecked", note: v.note, thumb: assetUrl(tenant, v.id, 640), aiEdited: v.aiEdited })),
    notes: only ? [] : [...(s.privacy?.note ? [s.privacy.note] : []), ...(s.notices ?? [])],
  };
}

/** The conversation a card's photo was sent in (the latest turn whose saved work log has the card), if any. */
export async function threadOfCard(g: GraphHandle, approvalId: string): Promise<{ sessionId: string; agent: string | null } | null> {
  const [row] = await g.roQuery<{ id: string; agent: string | null }>(
    "MATCH (t:Entity:Turn)-[r:IN_SESSION]->(s:Entity:Session) WHERE r.until IS NULL AND t.events CONTAINS $needle RETURN s.id AS id, s.agent AS agent, t.at AS at, t.id AS tid ORDER BY at DESC, tid DESC LIMIT 1",
    { needle: `"approvalId":${JSON.stringify(approvalId)}` });
  return row ? { sessionId: row.id, agent: row.agent ?? null } : null;
}

/** The words a change shows as the owner's message in the thread. */
export function changeQuestion(o: { instruction?: string; retryOf?: string; clip?: boolean; label?: string }): string {
  const which = o.label ? `option ${o.label}` : "the picture";
  if (o.clip) return `Make a 5 second clip from ${which}`;
  if (o.retryOf) return `Try option ${o.retryOf} again`;
  return o.label ? `Change option ${o.label}: ${o.instruction ?? ""}`.trim() : (o.instruction ?? "").trim();
}

interface TurnSpec { tenant: string; g: GraphHandle; question: string; sessionId?: string; target?: string }
type Work = (out: (e: AgentEvent) => void, signal: AbortSignal) => Promise<{ answer: string; agents?: AgentId[] }>;

export function registerChatPhotoRoutes(app: Hono, ctx: RouteCtx, d: ChatPhotoDeps): void {
  let busy = false; // one photo (or one change) at a time per server, like the Studio's own routes

  // One live turn in the conversation: the session first, the work's events, the answer, then the final with this turn's id;
  // saved in the thread whatever happened.
  const runTurn = (spec: TurnSpec, work: Work, failed: (e: unknown) => string): LiveTurn => {
    const { g, question, target } = spec;
    return d.turns.start(spec.tenant, question, async (emit, signal) => {
      const at = ctx.now();
      const turnId = newTurnId(at);
      const sessionId = spec.sessionId ?? newSessionId(at);
      const log: AgentEvent[] = [];
      const out = (e: AgentEvent) => { log.push(e); emit(e); };
      out({ type: "session", tenant: spec.tenant, sessionId, turnId, question });
      let answer = "";
      let failure: string | undefined;
      const agents = new Set<AgentId>([TARA]);
      try {
        if (!(await getSession(g, sessionId))) await startSession(g, { channel: "web", asker: ASKER, title: question, id: sessionId, ...(target ? { agent: target } : {}) }, at);
        const r = await work((e) => {
          if ("agent" in e && typeof e.agent === "string") agents.add(e.agent as AgentId);
          out(e);
        }, signal);
        for (const a of r.agents ?? []) agents.add(a);
        answer = r.answer;
        if (answer) out({ type: "text", agent: TARA, delta: answer });
      } catch (e) {
        failure = signal.aborted ? "Stopped before it was ready." : failed(e);
        if (!signal.aborted) ctx.log(`[chat-photo] ${spec.tenant}: ${e instanceof Error ? e.message : String(e)}`);
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
        ctx.log(`[chat-photo] ${spec.tenant}: could not save the turn: ${e instanceof Error ? e.message : String(e)}`);
      }
      emit(final);
      return { ok: !failure };
    }, target);
  };

  const targetOf = (v: unknown): string | undefined => {
    const t = typeof v === "string" && v ? v : undefined;
    if (t && !agentById(t)) throw new HttpError(400, "That person is not on the team.");
    return t && t !== "chief-of-staff" ? t : undefined;
  };
  const sessionOf = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= 200 ? v : undefined);

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
      const sessionIn = sessionOf(form.sessionId);
      const target = targetOf(form.target);
      if (busy) throw new HttpError(429, "Miss Influencer is already working on a photo. Try again in a minute.");
      busy = true;
      const bytes = Buffer.from(await photo.arrayBuffer());
      const question = note || DEFAULT_PHOTO_NOTE;

      let turn: LiveTurn;
      try {
        turn = runTurn({ tenant: reg.slug, g, question, ...(sessionIn ? { sessionId: sessionIn } : {}), ...(target ? { target } : {}) }, async (out, signal) => {
          // the pipeline's own `final` is held back: the turn's final comes last, after the card, with this turn's id
          let answer = "";
          const result = await runStudio(g, { tenant: reg.slug, businessId: reg.businessId, bytes, ...(note ? { note } : {}) }, { ...w.deps, now: ctx.now, signal }, (e) => {
            if (e.type === "final") { answer = e.answer; return; }
            out(e);
          });
          const made = await photoDeliverable(g, reg.slug, result);
          if (made) out(made);
          return { answer };
        }, (e) => studioErrorMessage(e));
      } catch (e) {
        busy = false;
        throw e;
      }
      return sse<AgentEvent>(c, { heartbeatMs: d.heartbeatMs, log: ctx.log }, (send, signal) => turn.follow(0, send, signal));
    });

  // A change to a photo's card, from the chat's card or the Library: the Studio's own change path, or (clip: true) the 5 second clip
  // the owner was quoted for on POST /studio/clip and said yes to. The new option comes back as a card in the photo's thread.
  app.post("/api/:t/chat/photo/change", async (c) => {
    const { reg, g } = await ctx.tenantOf(c);
    ctx.refuseInPublicMode();
    const w = await d.studio?.();
    if (!w) throw new HttpError(501, "Photos can't be changed on this server yet.");
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      throw new HttpError(400, "The request body must be JSON.");
    }
    const approvalId = typeof body.approvalId === "string" && body.approvalId.length <= 200 ? body.approvalId : "";
    const instruction = typeof body.instruction === "string" ? body.instruction.trim().slice(0, 400) : "";
    const retryOf = typeof body.retryOf === "string" && /^[A-Z][A-Z0-9]{0,3}$/.test(body.retryOf) ? body.retryOf : undefined;
    const clip = body.clip === true;
    const variantId = typeof body.variantId === "string" && body.variantId.length <= 200 ? body.variantId : undefined;
    if (!approvalId) throw new HttpError(400, "Say which card: approvalId.");
    if (!clip && !instruction && !retryOf) throw new HttpError(400, "Say what to change.");
    if (clip && !w.clip) throw new HttpError(501, "Clips are not switched on here.");
    const target = targetOf(body.target);
    if (busy) throw new HttpError(429, "Miss Influencer is already working on a photo. Try again in a minute.");
    await d.gate?.(g, reg.slug, clip ? "video_short" : "picture");

    const card = await studioCard(g, approvalId);
    const label = card?.payload.studio.variants.find((v) => v.id === variantId)?.label;
    const question = changeQuestion({ instruction, ...(retryOf ? { retryOf } : {}), clip, ...(label ? { label } : {}) });
    const thread = sessionOf(body.sessionId) ? null : await threadOfCard(g, approvalId);
    const sessionId = sessionOf(body.sessionId) ?? thread?.sessionId;
    const who = target ?? (thread?.agent && thread.agent !== "chief-of-staff" ? thread.agent : undefined);
    const ids = { tenant: reg.slug, businessId: reg.businessId, approvalId };
    const title = card?.payload.title ?? "";

    busy = true;
    let turn: LiveTurn;
    try {
      turn = runTurn({ tenant: reg.slug, g, question, ...(sessionId ? { sessionId } : {}), ...(who ? { target: who } : {}) }, async (out) => {
        if (clip) {
          const t0 = ctx.now();
          out({ type: "agent_start", agent: TARA, task: "Make the 5 second clip" });
          const r = await w.clip!.make({ ...ids, ...(variantId ? { variantId } : {}) });
          out({ type: "agent_done", agent: TARA, ms: Math.max(0, ctx.now() - t0), ok: r.ok });
          if (!r.ok) return { answer: r.message };
          out({ type: "asset", agent: TARA, assetId: r.assetId, kind: "variant", parentId: variantId ?? "", thumb: assetUrl(reg.slug, r.assetId, 640) });
          const from = label ? `option ${label}` : "the picture";
          out({
            type: "deliverable", agent: TARA, kind: "clip", title: title ? `Clip: ${title}` : "Your 5 second clip", approvalId, recommended: r.assetId, studio: true, credits: r.credits,
            options: [{ assetId: r.assetId, label: "Clip", badge: "unchecked", note: `5 seconds, silent, made from ${from}`, thumb: assetUrl(reg.slug, r.assetId, 640), aiEdited: true }],
            notes: [`It goes with ${from}'s post when you approve ${from}.`],
          });
          return { answer: r.message };
        }
        const r = await changeStudioOption(g, ids, { instruction, ...(retryOf ? { retryOf } : {}) }, w, ctx.now, out);
        if (r.made) {
          const made = await photoDeliverable(g, reg.slug, { approvalId, title: "" }, [r.made.assetId]);
          if (made) out({ ...made, title: `Option ${r.made.label}${title ? `: ${title}` : ""}` });
        }
        return { answer: r.answer };
      }, (e) => studioErrorMessage(e));
    } catch (e) {
      busy = false;
      throw e;
    }
    return sse<AgentEvent>(c, { heartbeatMs: d.heartbeatMs, log: ctx.log }, (send, signal) => turn.follow(0, send, signal));
  });
}
