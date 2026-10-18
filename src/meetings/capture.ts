// Automatic meeting capture: a recorder's new calls become minutes, decisions and routed action items in the business's brain with
// nobody pasting anything. One run, for one business:
//   1. For each recorder (Fireflies, Granola), ask the business's connections whether it is connected. Not connected: say how to
//      connect it ("Connect Fireflies on Your tools") and move on; nothing else is called.
//   2. List the calls of the last few days. A call whose Meeting is already in the graph (named by the recorder and its own meeting
//      id: capturedIds in src/agent/meeting.ts) is skipped before anything is fetched, so a second run, the scheduler and the CLI
//      can all run safely: re-reading the same meeting writes nothing.
//   3. Fetch each new call and run the "remember this meeting" turn on it (ask() with deps.meetingCapture): Memory Keeper reads it
//      and writes the minutes, Taskmaster files the action items and hands each one to the right person or AI teammate, and the
//      minutes email waits in Needs your OK. The turn is saved as its own chat thread ("New meeting from Fireflies: ..."), so the
//      owner finds the summary in Chat.
// A forwarded transcript (the meeting webhook, or the CLI with --file) takes the same path from step 3 (captureInbound).
// Nothing is sent: the minutes email is a card, and it goes out only after the owner says OK, like every outward action.
import type { AskDeps, AskResult, Channel } from "../agent/ask.js";
import type { MeetingCapture } from "../agent/meeting.js";
import { capturedIds } from "../agent/meeting.js";
import type { Emit } from "../agent/runtime.js";
import type { ConnectionsPort } from "../connections/service.js";
import type { GraphHandle } from "../graph/client.js";
import { existingIds } from "../actions/shared.js";
import { sha256 } from "../util/ids.js";
import { inboundMeeting, notesOf, RECORDERS, recorderById, type Recorder, type RecordedMeeting, type ToolSession } from "./recorders.js";

const DAY = 86_400_000;

export interface CaptureDeps {
  graph: GraphHandle;
  port: ConnectionsPort;                 // this business's connections (the sample ones for a demo business)
  askDeps: () => Promise<AskDeps>;       // made only when there is a new meeting to read (it loads the model runtime)
  now?: () => number;
  sinceDays?: number;                    // how far back to look (default 7)
  max?: number;                          // new meetings read per run (default 5): the rest wait for the next run
  channel?: Channel;                     // where the thread says it came from (default "cli")
  emit?: Emit;                           // the turn's work log, streamed (default: dropped)
  log?: (line: string) => void;
}

export type RecorderState = "connected" | "not_connected" | "needs_attention" | "failed";

export interface CaptureReport {
  tenant: string;
  recorders: Array<{ id: string; name: string; state: RecorderState; message: string }>;
  saved: Array<{ recorder: string; externalId: string; title: string; ok: boolean; turnId: string; sessionId: string; answer: string }>;
  skipped: Array<{ recorder: string; externalId: string; title: string; why: string }>;
}

/** The plain line for a recorder that is not connected, with where to connect it. */
export const connectWords = (r: Pick<Recorder, "name" | "connectionId">): string =>
  `${r.name} isn't connected yet. Connect it on Your tools (/connections?connect=${r.connectionId}) and each new call's minutes and action items will arrive by themselves.`;

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const running = new Set<string>(); // one run per business at a time in this process

async function businessTimeZone(g: GraphHandle): Promise<string> {
  const [b] = await g.roQuery<{ tz: string | null }>("MATCH (b:Entity:Business) RETURN b.timeZone AS tz ORDER BY b.id LIMIT 1").catch(() => []);
  return b?.tz || "Asia/Kolkata";
}

function localDay(ms: number, timeZone: string): string {
  try { return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms); } catch { return new Date(ms).toISOString().slice(0, 10); }
}

const RECORDER_NAME: Record<RecordedMeeting["recorder"], string> = { fireflies: "Fireflies", granola: "Granola", inbound: "your meeting address" };

/** Saves one recorded meeting through the meeting turn. The caller has checked it is new. */
async function save(tenant: string, m: RecordedMeeting, d: CaptureDeps): Promise<AskResult> {
  const tz = await businessTimeZone(d.graph);
  const capture: MeetingCapture = {
    recorder: m.recorder, recorderName: RECORDER_NAME[m.recorder], externalId: m.externalId, title: m.title,
    ...(m.startedAt !== null ? { date: localDay(m.startedAt, tz), start: m.startedAt } : {}),
    attendees: m.attendees, ...(m.url ? { url: m.url } : {}), ...(m.sample ? { sample: true } : {}),
  };
  const { ask } = await import("../agent/ask.js");
  const deps = await d.askDeps();
  return ask(
    { tenant, question: `New meeting from ${capture.recorderName}: ${m.title}`, channel: d.channel ?? "cli" },
    { ...deps, graph: d.graph, timeZone: deps.timeZone ?? tz, ...(d.now ? { now: d.now } : {}), meetingCapture: { notes: notesOf(m), capture } },
    d.emit ?? (() => undefined),
  );
}

/** Is this recorder's meeting already in the brain? */
export async function alreadySaved(g: GraphHandle, recorder: RecordedMeeting["recorder"], externalId: string): Promise<boolean> {
  const id = capturedIds({ recorder, externalId }).meetingId;
  return (await existingIds(g, [id])).has(id);
}

/** One capture run for a business: every connected recorder's new calls, at most `max` of them. */
export async function captureMeetings(tenant: string, d: CaptureDeps, o: { recorder?: string } = {}): Promise<CaptureReport> {
  const report: CaptureReport = { tenant, recorders: [], saved: [], skipped: [] };
  if (running.has(tenant)) {
    report.recorders.push({ id: "all", name: "Meeting capture", state: "failed", message: "A capture run for this business is already going; try again in a minute." });
    return report;
  }
  running.add(tenant);
  try {
    const now = (d.now ?? Date.now)();
    const since = now - (d.sinceDays ?? 7) * DAY;
    let left = d.max ?? 5;
    const recorders = o.recorder ? [recorderById(o.recorder)].filter((r): r is Recorder => !!r) : RECORDERS;
    if (o.recorder && !recorders.length) throw new Error(`There is no meeting recorder called "${o.recorder.slice(0, 30)}". Try fireflies or granola.`);
    for (const r of recorders) {
      const st = await d.port.status(r.connectionId).catch((e) => ({ state: "failed" as const, message: message(e) }));
      if (st.state !== "connected") {
        report.recorders.push({ id: r.id, name: r.name, state: st.state === "needs_attention" ? "needs_attention" : st.state === "failed" ? "failed" : "not_connected", message: st.state === "needs_attention" ? st.message : connectWords(r) });
        continue;
      }
      let listed: Awaited<ReturnType<Recorder["list"]>>;
      try {
        listed = await d.port.run(r.connectionId, "meetings: list recent calls", (s: ToolSession) => r.list(s, since, now), { actor: "agent:allevia-librarian" });
      } catch (e) {
        report.recorders.push({ id: r.id, name: r.name, state: "failed", message: `${r.name} didn't answer: ${message(e)}` });
        continue;
      }
      report.recorders.push({ id: r.id, name: r.name, state: "connected", message: `${r.name} is connected: ${listed.length} call${listed.length === 1 ? "" : "s"} in the last ${d.sinceDays ?? 7} days.` });
      // oldest first, so the minutes land in the order the calls happened
      for (const item of [...listed].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))) {
        if (await alreadySaved(d.graph, r.id, item.externalId)) { report.skipped.push({ recorder: r.id, externalId: item.externalId, title: item.title, why: "already saved" }); continue; }
        if (left <= 0) { report.skipped.push({ recorder: r.id, externalId: item.externalId, title: item.title, why: "waits for the next run" }); continue; }
        let m: RecordedMeeting | null;
        try {
          m = await d.port.run(r.connectionId, "meetings: read one call", (s: ToolSession) => r.fetch(s, item.externalId), { actor: "agent:allevia-librarian" });
        } catch (e) {
          report.skipped.push({ recorder: r.id, externalId: item.externalId, title: item.title, why: `could not be read: ${message(e)}` });
          continue;
        }
        if (!m) { report.skipped.push({ recorder: r.id, externalId: item.externalId, title: item.title, why: "no transcript yet" }); continue; }
        left--;
        const res = await save(tenant, m, d);
        report.saved.push({ recorder: r.id, externalId: m.externalId, title: m.title, ok: res.ok, turnId: res.turnId, sessionId: res.sessionId, answer: res.answer });
        d.log?.(`[meetings] ${tenant}: ${res.ok ? "saved" : "could not save"} "${m.title}" from ${r.name}`);
      }
    }
    return report;
  } finally {
    running.delete(tenant);
  }
}

/** A transcript or notes forwarded to the business's meeting address: the same turn, named by the sender's id or the text itself. */
export async function captureInbound(
  tenant: string,
  input: { id?: string; title?: string; date?: string | number; attendees?: unknown[]; text: string },
  d: CaptureDeps,
): Promise<{ status: "saved" | "already_saved" | "failed"; meetingId: string; result?: AskResult }> {
  const text = input.text.trim();
  if (text.length < 80) throw new Error("That is too short to be a meeting: send the transcript or the notes.");
  const m = inboundMeeting({ ...input, text, fingerprint: sha256(text).slice(0, 16) });
  const meetingId = capturedIds(m).meetingId;
  if (await alreadySaved(d.graph, "inbound", m.externalId)) return { status: "already_saved", meetingId };
  const result = await save(tenant, m, d);
  return { status: result.ok ? "saved" : "failed", meetingId, result };
}
