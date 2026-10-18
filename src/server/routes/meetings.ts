// Meeting capture on the server (src/meetings):
//   POST /api/:t/meetings/check          read the business's connected recorders now (Fireflies, Granola; the sample Fireflies for
//                                        the demo business): new calls become minutes, routed action items and a minutes card.
//                                        The owner's; never in public mode. Answers what was read, skipped, and what to connect.
//   GET  /api/:t/meetings/address        the business's own meeting address (owner only), or that it is off on this server
//   POST /hooks/meetings/:t/:secret      the meeting address itself: a transcript or notes from any recorder or automation, as JSON
//                                        {id?, title?, date?, attendees?, transcript | notes | text} or as plain text. Accepted at
//                                        once (202) and read in the background; the same meeting posted twice is saved once.
// Nothing here sends anything: the minutes email waits in Needs your OK.
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AskDeps } from "../../agent/ask.js";
import { captureInbound, captureMeetings, type CaptureReport } from "../../meetings/capture.js";
import { MEETING_HOOK_PATH, meetingAddress, meetingTokenOk } from "../../meetings/address.js";
import { HttpError, errorMessage, type RouteCtx } from "../http.js";

export interface MeetingsWiring {
  askDeps: (tenant: string) => Promise<AskDeps>;
  key: () => string | undefined;    // the connector key the meeting address is derived from
  webBaseUrl: () => string;
}

/** What the page shows after a check: one line per recorder and per meeting. */
export function reportDto(r: CaptureReport) {
  return {
    recorders: r.recorders,
    saved: r.saved.map((s) => ({ recorder: s.recorder, title: s.title, ok: s.ok, sessionId: s.sessionId, turnId: s.turnId })),
    skipped: r.skipped.map((s) => ({ recorder: s.recorder, title: s.title, why: s.why })),
  };
}

export function registerMeetingRoutes(app: Hono, ctx: RouteCtx, w: MeetingsWiring): void {
  app.post("/api/:t/meetings/check", async (c) => {
    const { reg, g } = await ctx.tenantOf(c);
    ctx.refuseInPublicMode();
    const askDeps = await w.askDeps(reg.slug);
    if (!askDeps.connections) throw new HttpError(501, "Connections are not set up on this server, so no recorder can be read.");
    const r = await captureMeetings(reg.slug, { graph: g, port: askDeps.connections, askDeps: async () => askDeps, channel: "web", now: ctx.now, log: ctx.log });
    return c.json(reportDto(r));
  });

  app.get("/api/:t/meetings/address", async (c) => {
    const { reg } = await ctx.tenantOf(c);
    ctx.refuseInPublicMode();
    const url = meetingAddress(w.webBaseUrl(), w.key(), reg.slug);
    return c.json(url ? { url } : { url: null, message: "The meeting address isn't switched on on this server yet." });
  });

  const hookBodies = bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ error: "That is too large for one meeting." }, 413) });
  app.post(`${MEETING_HOOK_PATH}/:t/:secret`, hookBodies, async (c) => {
    const slug = c.req.param("t") ?? "";
    if (!ctx.tenantBySlug || !meetingTokenOk(w.key(), slug, c.req.param("secret") ?? "")) throw new HttpError(404, "Not found.");
    const { reg, g } = await ctx.tenantBySlug(slug);
    const type = c.req.header("content-type") ?? "";
    let input: { id?: string; title?: string; date?: string | number; attendees?: unknown[]; text: string };
    if (type.includes("json")) {
      const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
      if (!b) throw new HttpError(400, "Send JSON with the transcript or the notes.");
      const text = [b.transcript, b.notes, b.text, b.body].find((x): x is string => typeof x === "string" && x.trim().length > 0) ?? "";
      input = {
        text, ...(typeof b.id === "string" || typeof b.id === "number" ? { id: String(b.id) } : {}), ...(typeof b.title === "string" ? { title: b.title } : {}),
        ...(typeof b.date === "string" || typeof b.date === "number" ? { date: b.date } : {}), ...(Array.isArray(b.attendees) ? { attendees: b.attendees } : {}),
      };
    } else {
      input = { text: await c.req.text() };
    }
    if (input.text.trim().length < 80) throw new HttpError(400, "That is too short to be a meeting: send the transcript or the notes.");
    // read in the background: Memory Keeper takes a minute, and the sender should not wait for it
    void (async () => {
      try {
        const askDeps = await w.askDeps(reg.slug);
        if (!askDeps.connections) return;
        const r = await captureInbound(reg.slug, input, { graph: g, port: askDeps.connections, askDeps: async () => askDeps, channel: "web", now: ctx.now, log: ctx.log });
        ctx.log(`[meetings] ${reg.slug}: a meeting sent to its address was ${r.status.replace("_", " ")}`);
      } catch (e) {
        ctx.log(`[meetings] ${reg.slug}: a meeting sent to its address could not be read: ${errorMessage(e)}`);
      }
    })();
    return c.json({ accepted: true, message: "Got it. The minutes and action items will be in Allevia in a minute or two." }, 202);
  });
}
