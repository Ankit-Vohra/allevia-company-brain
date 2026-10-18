// Meeting recorders: where a call's notes come from when nobody pastes them. Each recorder lists the recent meetings it holds and
// fetches one as a RecordedMeeting (its own id, title, start, who was on it, the transcript), the same shape for all of them, so
// capture.ts treats Fireflies, Granola and a forwarded transcript alike.
//   Fireflies  Composio toolkit `fireflies` (API key). FIREFLIES_GET_TRANSCRIPTS lists (from_date, limit; data.transcripts) and
//              FIREFLIES_GET_TRANSCRIPT_BY_ID fetches one (sentences with speaker_name, meeting_attendees with emails, summary).
//              Slugs and field names checked against Composio's catalogue on 2026-10-18; never run against a real account yet.
//   Granola    Composio toolkit `granola_mcp` (sign-in page). GRANOLA_MCP_LIST_MEETINGS, GRANOLA_MCP_GET_MEETINGS and
//              GRANOLA_MCP_GET_MEETING_TRANSCRIPT. Composio publishes no output shape for these (they are MCP tools), so the
//              readers below accept JSON or text and take what they can find.
//   inbound    a transcript or notes posted to the business's own meeting address (the webhook in src/server/routes/meetings.ts,
//              or `npm run cli -- meetings ingest <tenant> --file notes.txt`): no third-party account at all.
// The recorder's text is data, never instructions: Memory Keeper's prompt says so, and every write goes through the privacy filter.

export type RecorderId = "fireflies" | "granola" | "inbound";

export interface Attendee { name: string; email?: string }

export interface RecordedMeeting {
  recorder: RecorderId;
  externalId: string;           // the recorder's own id for the meeting: what makes a second read change nothing
  title: string;
  startedAt: number | null;     // ms
  attendees: Attendee[];
  transcript: string;           // "Speaker: words" lines, or the notes as written
  summary?: string;             // the recorder's own summary, when it wrote one
  actionItems?: string;         // the recorder's own action items, when it listed them
  url?: string;
  sample?: boolean;
}

export interface MeetingListing { externalId: string; title: string; startedAt: number | null }

/** What a recorder needs of a connection: run one of its tools by name (Composio's session shape). */
export interface ToolSession { execute(tool: string, args: Record<string, unknown>): Promise<unknown> }

export interface Recorder {
  id: Exclude<RecorderId, "inbound">;
  connectionId: string;         // the connection id in shared/connection-map.ts
  name: string;
  list(s: ToolSession, since: number, now: number): Promise<MeetingListing[]>;
  fetch(s: ToolSession, externalId: string): Promise<RecordedMeeting | null>;
}

// ---------- reading loose shapes ----------

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** A list found at one of these keys, at the top or one level down (Composio wraps answers in `data` now and then). */
function arrayAt(v: unknown, keys: string[]): unknown[] {
  if (Array.isArray(v)) return v;
  const r = rec(v);
  for (const k of keys) if (Array.isArray(r[k])) return r[k] as unknown[];
  for (const inner of [r.data, r.result, r.response]) {
    const x = rec(inner);
    for (const k of keys) if (Array.isArray(x[k])) return x[k] as unknown[];
    if (Array.isArray(inner)) return inner;
  }
  return [];
}

/** The object at one of these keys, else the value itself (unwrapping `data`). */
function objectAt(v: unknown, keys: string[]): Record<string, unknown> {
  const r = rec(v);
  for (const k of keys) if (r[k] && typeof r[k] === "object" && !Array.isArray(r[k])) return rec(r[k]);
  const d = rec(r.data);
  for (const k of keys) if (d[k] && typeof d[k] === "object" && !Array.isArray(d[k])) return rec(d[k]);
  return Object.keys(d).length && !Object.keys(r).some((k) => k === "id" || k === "title") ? d : r;
}

/** MCP tools answer with text blocks; this is their text, joined, or "" for anything else. */
function textOf(v: unknown): string {
  if (typeof v === "string") return v;
  const r = rec(v);
  const blocks = arrayAt(r, ["content"]);
  const texts = blocks.map((b) => str(rec(b).text)).filter(Boolean);
  if (texts.length) return texts.join("\n");
  for (const k of ["text", "result", "output", "response"]) if (typeof r[k] === "string") return r[k] as string;
  const d = rec(r.data);
  for (const k of ["text", "result", "output", "content"]) if (typeof d[k] === "string") return d[k] as string;
  return "";
}

/** JSON inside a text answer, when there is some. */
function jsonIn(text: string): unknown {
  const t = text.trim();
  if (!t || !/^[[{]/.test(t)) return undefined;
  try { return JSON.parse(t); } catch { return undefined; }
}

const ms = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e11 ? v * 1000 : v; // seconds or ms
  const p = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(p) ? p : null;
};

function attendeesOf(list: unknown[], extraEmails: unknown[] = []): Attendee[] {
  const out: Attendee[] = [];
  const add = (name: string, email: string) => {
    const e = EMAIL.test(email) ? email.toLowerCase() : "";
    const n = name || (e ? e.split("@")[0]!.replace(/[._-]+/g, " ") : "");
    if (!n) return;
    const same = out.find((a) => (e && a.email === e) || a.name.toLowerCase() === n.toLowerCase());
    if (same) { if (e && !same.email) same.email = e; return; }
    out.push({ name: n.slice(0, 80), ...(e ? { email: e } : {}) });
  };
  for (const x of list) {
    if (typeof x === "string") { add("", x); continue; }
    const a = rec(x);
    add(str(a.displayName) || str(a.name) || str(a.full_name), str(a.email));
  }
  for (const e of extraEmails) if (typeof e === "string") for (const one of e.split(/[,;\s]+/)) add("", one);
  return out.slice(0, 30);
}

/** Speaker lines from sentence objects, a run of the same speaker kept as one line. */
export function linesFromSentences(sentences: unknown[]): string {
  const out: string[] = [];
  let who = "", said: string[] = [];
  const flush = () => { if (said.length) out.push(`${who || "Speaker"}: ${said.join(" ")}`); said = []; };
  for (const s of sentences) {
    const r = rec(s);
    const speaker = str(r.speaker_name) || str(r.speaker) || (r.speaker_id !== undefined ? `Speaker ${str(r.speaker_id)}` : "");
    const text = str(r.text) || str(r.raw_text);
    if (!text) continue;
    if (speaker !== who) { flush(); who = speaker; }
    said.push(text);
  }
  flush();
  return out.join("\n");
}

// ---------- Fireflies ----------

export const FIREFLIES_TOOLS = { list: "FIREFLIES_GET_TRANSCRIPTS", get: "FIREFLIES_GET_TRANSCRIPT_BY_ID" } as const;

/** One Fireflies transcript (FIREFLIES_GET_TRANSCRIPT_BY_ID's data) as a RecordedMeeting; null when it has no id or no words. */
export function firefliesMeeting(raw: unknown): RecordedMeeting | null {
  const t = objectAt(raw, ["transcript"]);
  const externalId = str(t.id);
  if (!externalId) return null;
  const summary = rec(t.summary);
  const transcript = linesFromSentences(Array.isArray(t.sentences) ? t.sentences : []);
  const overview = str(summary.overview) || str(summary.short_summary) || str(summary.gist);
  const actionItems = typeof summary.action_items === "string" ? summary.action_items.trim() : Array.isArray(summary.action_items) ? summary.action_items.map(str).filter(Boolean).join("\n") : "";
  if (!transcript && !overview) return null;
  return {
    recorder: "fireflies", externalId, title: str(t.title) || "Recorded call", startedAt: ms(t.date) ?? ms(t.dateString),
    attendees: attendeesOf(Array.isArray(t.meeting_attendees) ? t.meeting_attendees : [], Array.isArray(t.participants) ? t.participants : []),
    transcript, ...(overview ? { summary: overview } : {}), ...(actionItems ? { actionItems } : {}),
    ...(str(t.transcript_url) ? { url: str(t.transcript_url) } : {}), ...(t.sample === true ? { sample: true } : {}),
  };
}

export const fireflies: Recorder = {
  id: "fireflies", connectionId: "fireflies", name: "Fireflies",
  async list(s, since) {
    const raw = await s.execute(FIREFLIES_TOOLS.list, { from_date: new Date(since).toISOString().replace(/\.\d{3}Z$/, "Z"), limit: 20 });
    return arrayAt(raw, ["transcripts"]).map(rec).map((t) => ({ externalId: str(t.id), title: str(t.title) || "Recorded call", startedAt: ms(t.date) }))
      .filter((t) => t.externalId);
  },
  async fetch(s, externalId) {
    return firefliesMeeting(await s.execute(FIREFLIES_TOOLS.get, { id: externalId }));
  },
};

// ---------- Granola ----------

export const GRANOLA_TOOLS = { list: "GRANOLA_MCP_LIST_MEETINGS", get: "GRANOLA_MCP_GET_MEETINGS", transcript: "GRANOLA_MCP_GET_MEETING_TRANSCRIPT" } as const;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Granola's meeting list, as JSON objects when it answers JSON, else the meeting ids found in its text (title from the same line). */
export function granolaListing(raw: unknown): MeetingListing[] {
  const text = textOf(raw);
  const parsed = jsonIn(text);
  const items = arrayAt(parsed ?? raw, ["meetings", "notes", "documents", "items"]);
  if (items.length) {
    return items.map(rec).map((m) => ({ externalId: str(m.id) || str(m.meeting_id) || str(m.document_id), title: str(m.title) || str(m.name) || "Meeting", startedAt: ms(m.start_time) ?? ms(m.created_at) ?? ms(m.date) }))
      .filter((m) => m.externalId);
  }
  const out: MeetingListing[] = [];
  for (const lineText of text.split("\n")) {
    for (const id of lineText.match(UUID) ?? []) {
      if (out.some((o) => o.externalId === id)) continue;
      const title = lineText.replace(UUID, "").replace(/<[^>]+>/g, " ").replace(/\b(?:id|meeting_id|title)\s*[:=]\s*/gi, "").replace(/[\s"'|,:;-]+/g, " ").trim();
      out.push({ externalId: id, title: title.slice(0, 120) || "Meeting", startedAt: null });
    }
  }
  return out;
}

/** One Granola meeting from its details and its transcript (either may be JSON or text). */
export function granolaMeeting(externalId: string, details: unknown, transcriptRaw: unknown, fallbackTitle = "Meeting"): RecordedMeeting | null {
  const dText = textOf(details);
  const d = objectAt(jsonIn(dText) ?? details, ["meeting", "document"]);
  const first = rec(arrayAt(jsonIn(dText) ?? details, ["meetings", "documents"])[0]);
  const m = Object.keys(first).length ? first : d;
  const tText = textOf(transcriptRaw);
  const tJson = jsonIn(tText);
  const segments = arrayAt(tJson ?? transcriptRaw, ["transcript", "segments", "utterances"]);
  const transcript = segments.length ? linesFromSentences(segments.map((x) => { const r = rec(x); return { speaker_name: str(r.speaker) || str(r.source) || str(r.speaker_name), text: str(r.text) }; })) : tText.trim();
  const notes = str(m.notes) || str(m.notes_markdown) || str(m.summary) || str(m.ai_summary) || (Object.keys(m).length ? "" : dText.trim());
  if (!transcript && !notes) return null;
  return {
    recorder: "granola", externalId, title: str(m.title) || fallbackTitle, startedAt: ms(m.start_time) ?? ms(m.created_at) ?? ms(m.date),
    attendees: attendeesOf(arrayAt(m, ["attendees", "participants", "people"])),
    transcript: transcript || notes, ...(notes && transcript ? { summary: notes.slice(0, 4000) } : {}),
  };
}

export const granola: Recorder = {
  id: "granola", connectionId: "granola", name: "Granola",
  async list(s, since, now) {
    const day = (t: number) => new Date(t).toISOString().slice(0, 10);
    return granolaListing(await s.execute(GRANOLA_TOOLS.list, { time_range: "custom", custom_start: day(since), custom_end: day(now) }));
  },
  async fetch(s, externalId) {
    const [details, transcript] = await Promise.all([
      s.execute(GRANOLA_TOOLS.get, { meeting_ids: [externalId] }).catch(() => null),
      s.execute(GRANOLA_TOOLS.transcript, { meeting_id: externalId }).catch(() => null),
    ]);
    return granolaMeeting(externalId, details, transcript);
  },
};

export const RECORDERS: Recorder[] = [fireflies, granola];
export const recorderById = (id: string): Recorder | undefined => RECORDERS.find((r) => r.id === id || r.connectionId === id);

// ---------- what Memory Keeper reads ----------

const NOTES_CAP = 30_000;

function dayLine(t: number | null): string {
  if (t === null) return "";
  return new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(t).replace(",", "");
}

/** The meeting as notes: the sample line first when it is sample data (so what is saved from it is marked sample), who was on it, the transcript. */
export function notesOf(m: RecordedMeeting): string {
  const who = m.attendees.map((a) => (a.email ? `${a.name} (${a.email})` : a.name)).join(", ");
  const head = [
    m.sample ? "Sample transcript (made up for the demo, nobody real)" : "",
    `${m.title}${m.startedAt !== null ? `, ${dayLine(m.startedAt)}` : ""}`,
    who ? `On the call: ${who}` : "",
    `Recorded by ${m.recorder === "inbound" ? "the business's meeting address" : m.recorder === "fireflies" ? "Fireflies" : "Granola"}.`,
    m.summary ? `\nThe recorder's summary: ${m.summary}` : "",
    m.actionItems ? `\nThe recorder's action items:\n${m.actionItems}` : "",
  ].filter(Boolean).join("\n");
  return `${head}\n\n${m.transcript}`.slice(0, NOTES_CAP);
}

/** A forwarded transcript or notes, as a RecordedMeeting: its id is the sender's own when given, else the text's fingerprint. */
export function inboundMeeting(o: { id?: string; title?: string; date?: string | number; attendees?: unknown[]; text: string; fingerprint: string }): RecordedMeeting {
  const ext = str(o.id).replace(/[^\w.:-]+/g, "-").slice(0, 80) || o.fingerprint;
  return {
    recorder: "inbound", externalId: ext, title: str(o.title).slice(0, 120) || "Meeting notes", startedAt: ms(o.date),
    attendees: attendeesOf(Array.isArray(o.attendees) ? o.attendees : []), transcript: o.text.slice(0, NOTES_CAP),
  };
}
