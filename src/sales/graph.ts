// The Sales department's records in the business's own graph: Lead, Deal, Meeting and Message nodes, linked to the Person who
// asked, the Channel it came through, the Business and the follow-up Task. Everything carries its source (src) and date
// (asOf), on nodes and edges alike.
//
// Stages are bi-temporal. `Lead.stage` and `Deal.stage` are tracked properties (schema TRACKED_PROPS): every move writes a
// Version holding the old state, so "what moved this week" is a read of Versions (whatMoved), not a log we keep by hand.
//   new -> contacted -> meeting -> won | lost      (a lost or won lead that writes again goes back to new)
// Nothing here knows about a tenant: the graph handle is the business's own, so another business can never be reached.
import type { GraphHandle } from "../graph/client.js";
import type { Prim } from "../graph/validate.js";
import { upsertEdge, upsertNode } from "../graph/upsert.js";
import { findBusinessId } from "../actions/shared.js";
import { entityId, sha256, slugify } from "../util/ids.js";
import { toIso } from "../util/time.js";

export const STAGES = ["new", "contacted", "meeting", "won", "lost"] as const;
export type Stage = (typeof STAGES)[number];
export const OPEN_STAGES: Stage[] = ["new", "contacted", "meeting"];
export const isStage = (s: unknown): s is Stage => typeof s === "string" && (STAGES as readonly string[]).includes(s);
const isOpen = (s: unknown): boolean => s !== "won" && s !== "lost";

export const DAY = 86_400_000;
export const STALLED_DAYS = 14;

export type MeetingStatus = "proposed" | "booked" | "held" | "cancelled";

export interface Src { src: string; now: number; tenant?: string }
type Read = Pick<GraphHandle, "roQuery">;

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const asOfOf = (now: number): string => toIso(now);
const emailKey = (email: string): string => email.trim().toLowerCase();
export const looksLikeEmail = (s: string): boolean => /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/.test(s.trim());

// ---------- ids ----------

export const personIdFor = (email: string, name: string): string => entityId("Person", email ? emailKey(email) : name);
export const leadIdFor = (email: string, name: string): string => entityId("Lead", email ? emailKey(email) : name);
export const dealIdFor = (leadId: string): string => `deal:${leadId.slice(leadId.indexOf(":") + 1)}`;
export const meetingIdFor = (leadId: string, startMs: number): string => `meeting:${leadId.slice(leadId.indexOf(":") + 1)}-${toIso(startMs).slice(0, 16).replace(/[-:T]/g, "")}`;
export const messageIdFor = (externalId: string): string => `message:${slugify(externalId) || sha256(externalId).slice(0, 12)}`;

async function nameOf(g: Read, id: string): Promise<{ name: string; props: Record<string, unknown> } | null> {
  const [r] = await g.roQuery<{ name: string | null; kv: Array<[string, unknown]> }>(
    "MATCH (n:Entity {id:$id}) RETURN n.name AS name, [k IN keys(n) WHERE NOT k IN ['embedding', 'textEmbedding'] | [k, n[k]]] AS kv LIMIT 1", { id });
  return r ? { name: r.name ?? id, props: Object.fromEntries(r.kv) } : null;
}

async function exists(g: Read, id: string): Promise<boolean> {
  const [r] = await g.roQuery<{ c: number }>("MATCH (n:Entity {id:$id}) RETURN count(n) AS c", { id });
  return (r?.c ?? 0) > 0;
}

async function link(g: GraphHandle, from: string, type: Parameters<typeof upsertEdge>[1]["type"], to: string, s: Src, props?: Record<string, Prim>): Promise<void> {
  await upsertEdge(g, { from, type, to, ...(props ? { props } : {}), src: s.src, asOf: asOfOf(s.now), since: s.now }, s.now);
}

// ---------- channels ----------

const CHANNEL_NAMES: Record<string, string> = {
  email: "Email", gmail: "Email", whatsapp: "WhatsApp", form: "Website form", website: "Website form", instagram: "Instagram",
  phone: "Phone", sheet: "Spreadsheet", upload: "Spreadsheet", referral: "Referral",
};
export const channelNameFor = (raw: string): string => CHANNEL_NAMES[raw.trim().toLowerCase()] ?? (raw.trim() || "Email");

// The channel the business already has (onboarding may have made "WhatsApp"), else a plain one. Never rewrites an existing node.
export async function ensureChannel(g: GraphHandle, raw: string, s: Src): Promise<string> {
  const name = channelNameFor(raw);
  const id = entityId("Channel", name);
  if (!(await exists(g, id))) await upsertNode(g, { type: "Channel", id, name, props: { kind: "enquiry" }, src: s.src, asOf: asOfOf(s.now) }, s.now);
  return id;
}

// ---------- writes ----------

export interface EnquiryInput {
  name: string;                 // the person's name as they wrote it ("Priya Shah"); the email's local part when unknown
  email: string;                // may be "" for a WhatsApp or phone enquiry
  phone?: string;
  channel: string;              // email | whatsapp | form | instagram | phone | sheet ...
  subject?: string;
  body: string;                 // what they asked, as written
  at: number;                   // when they wrote (epoch ms)
  externalId: string;           // the message's id in its own system (Gmail id, a row number): makes the write repeatable
  threadId?: string;
  value?: number;               // what the owner thinks it is worth, when known
  currency?: string;
}

export interface Recorded { leadId: string; personId: string; messageId: string; dealId?: string; isNew: boolean; repeated: boolean }

// A new enquiry: the Person, the Lead (one per person; a returning person reopens theirs), the inbound Message, the links.
// Repeatable: the same externalId changes nothing.
export async function recordEnquiry(g: GraphHandle, e: EnquiryInput, s: Src): Promise<Recorded> {
  const name = e.name.trim() || (e.email ? e.email.split("@")[0]! : "Someone new");
  const email = e.email ? emailKey(e.email) : "";
  const personId = personIdFor(email, name);
  const leadId = leadIdFor(email, name);
  const messageId = messageIdFor(`${e.channel}-${e.externalId}`);
  const asOf = asOfOf(s.now);
  const biz = await findBusinessId(g, s.tenant);

  const had = await nameOf(g, leadId);
  const repeated = await exists(g, messageId);
  const person = await nameOf(g, personId);
  if (!person) {
    await upsertNode(g, { type: "Person", id: personId, name, props: { role: "lead", ...(email ? { email } : {}), ...(e.phone ? { phone: e.phone } : {}) }, src: s.src, asOf }, s.now);
  } else if (email && person.props.email !== email) {
    await upsertNode(g, { type: "Person", id: personId, name: person.name, props: { email }, src: s.src, asOf }, s.now);
  }
  if (repeated) return { leadId, personId, messageId, isNew: false, repeated: true };

  const channelId = await ensureChannel(g, e.channel, s);
  const stage: Stage = had && isOpen(had.props.stage) ? (had.props.stage as Stage) : "new";
  const prevInbound = typeof had?.props.lastInboundAt === "number" ? had.props.lastInboundAt : 0;
  await upsertNode(g, {
    type: "Lead", id: leadId, name: `${name}${e.subject ? `: ${clip(e.subject, 80)}` : ""}`,
    summary: clip(e.body.replace(/\s+/g, " ").trim(), 400),
    props: {
      stage, source: channelNameFor(e.channel), ...(email ? { email } : {}), ...(e.phone ? { phone: e.phone } : {}),
      ...(e.subject ? { subject: clip(e.subject, 160) } : {}),
      firstContactAt: typeof had?.props.firstContactAt === "number" ? had.props.firstContactAt : e.at,
      lastInboundAt: Math.max(prevInbound, e.at), needsReply: true, lastActivityAt: Math.max(e.at, typeof had?.props.lastActivityAt === "number" ? had.props.lastActivityAt : 0),
      ...(e.value !== undefined ? { value: e.value, ...(e.currency ? { currency: e.currency } : {}) } : {}),
    },
    src: s.src, asOf,
  }, s.now);
  if (had && !isOpen(had.props.stage)) await moveStage(g, leadId, "new", { ...s, reason: "wrote again" });

  await upsertNode(g, {
    type: "Message", id: messageId, name: clip(`${name}: ${e.subject ?? e.body}`.replace(/\s+/g, " "), 100),
    summary: clip(e.body.trim(), 1500),
    props: { direction: "in", status: "received", channel: channelNameFor(e.channel), at: e.at, externalId: e.externalId, ...(e.subject ? { subject: clip(e.subject, 160) } : {}), ...(e.threadId ? { threadId: e.threadId } : {}) },
    src: s.src, asOf,
  }, s.now);

  await link(g, leadId, "ENQUIRED_BY", personId, s);
  await link(g, leadId, "CAME_VIA", channelId, s);
  await link(g, messageId, "MESSAGE_IN", leadId, s);
  await link(g, messageId, "SENT_BY", personId, s);
  if (biz) {
    await link(g, leadId, "PART_OF", biz, s);
    await link(g, messageId, "PART_OF", biz, s);
  }
  return { leadId, personId, messageId, isNew: !had, repeated: false };
}

export interface MoveOpts extends Src { reason?: string }

// Moves a lead or deal to a stage. The old stage stays one hop away as a Version, dated by this write. A move to the stage it is
// already in changes nothing. Returns what it was before.
export async function moveStage(g: GraphHandle, id: string, stage: Stage, o: MoveOpts): Promise<{ from: string | null; to: Stage; changed: boolean }> {
  const type = id.startsWith("lead:") ? "Lead" : id.startsWith("deal:") ? "Deal" : null;
  if (!type) throw new Error(`${id} is not a lead or a deal`);
  const cur = await nameOf(g, id);
  if (!cur) throw new Error(`${id} is not in the records`);
  const from = typeof cur.props.stage === "string" ? cur.props.stage : null;
  if (from === stage) return { from, to: stage, changed: false };
  await upsertNode(g, {
    type, id, name: cur.name,
    props: { stage, stageNote: o.reason ?? null, lastActivityAt: o.now },
    src: o.src, asOf: asOfOf(o.now),
  }, o.now);
  return { from, to: stage, changed: true };
}

export interface DealInput { leadId: string; title?: string; value?: number; currency?: string; stage?: Stage; nextStep?: string }

// The chance of a sale behind a lead: one Deal per lead, opened when someone is worth a conversation.
export async function openDeal(g: GraphHandle, d: DealInput, s: Src): Promise<string> {
  const lead = await nameOf(g, d.leadId);
  if (!lead) throw new Error(`${d.leadId} is not in the records`);
  const id = dealIdFor(d.leadId);
  const asOf = asOfOf(s.now);
  const had = await nameOf(g, id);
  const stage: Stage = d.stage ?? (had && isStage(had.props.stage) ? had.props.stage : "contacted");
  await upsertNode(g, {
    type: "Deal", id, name: d.title ?? had?.name ?? `Deal: ${lead.name}`,
    props: {
      stage: had ? (had.props.stage as string) : stage,
      openedAt: typeof had?.props.openedAt === "number" ? had.props.openedAt : s.now, lastActivityAt: s.now,
      ...(d.value !== undefined ? { value: d.value } : {}), ...(d.currency ? { currency: d.currency } : {}), ...(d.nextStep ? { nextStep: clip(d.nextStep, 200) } : {}),
    },
    src: s.src, asOf,
  }, s.now);
  if (had && had.props.stage !== stage) await moveStage(g, id, stage, s);
  await link(g, id, "DEAL_OF", d.leadId, s);
  const biz = await findBusinessId(g, s.tenant);
  if (biz) await link(g, id, "PART_OF", biz, s);
  return id;
}

export interface MessageInput {
  leadId: string;
  direction: "in" | "out";
  channel: string;
  subject?: string;
  body: string;
  at: number;
  status: "draft" | "sent" | "received";
  externalId: string;
  by?: string;                  // the agent node or person node that wrote it
  toPersonId?: string;
  dealId?: string;
}

// A message in a lead's story. An outbound one that is sent answers the lead (needsReply off) and moves a new lead to contacted.
export async function logMessage(g: GraphHandle, m: MessageInput, s: Src): Promise<string> {
  const lead = await nameOf(g, m.leadId);
  if (!lead) throw new Error(`${m.leadId} is not in the records`);
  const id = messageIdFor(`${m.channel}-${m.externalId}`);
  const asOf = asOfOf(s.now);
  await upsertNode(g, {
    type: "Message", id, name: clip(`${m.direction === "out" ? "To" : "From"} ${lead.name.split(":")[0]}: ${m.subject ?? m.body}`.replace(/\s+/g, " "), 100),
    summary: clip(m.body.trim(), 1500),
    props: { direction: m.direction, status: m.status, channel: channelNameFor(m.channel), at: m.at, externalId: m.externalId, ...(m.subject ? { subject: clip(m.subject, 160) } : {}) },
    src: s.src, asOf,
  }, s.now);
  await link(g, id, "MESSAGE_IN", m.leadId, s);
  if (m.dealId) await link(g, id, "MESSAGE_IN", m.dealId, s);
  if (m.by) await link(g, id, "SENT_BY", m.by, s);
  if (m.toPersonId) await link(g, id, "SENT_TO", m.toPersonId, s);
  const biz = await findBusinessId(g, s.tenant);
  if (biz) await link(g, id, "PART_OF", biz, s);
  if (m.direction === "out" && m.status === "sent") {
    await upsertNode(g, { type: "Lead", id: m.leadId, name: lead.name, props: { needsReply: false, lastOutboundAt: m.at, lastActivityAt: Math.max(m.at, typeof lead.props.lastActivityAt === "number" ? lead.props.lastActivityAt : 0) }, src: s.src, asOf }, s.now);
    if (lead.props.stage === "new") await moveStage(g, m.leadId, "contacted", { ...s, reason: "replied" });
    if (m.dealId) await upsertNode(g, { type: "Deal", id: m.dealId, name: (await nameOf(g, m.dealId))?.name ?? "Deal", props: { lastActivityAt: m.at }, src: s.src, asOf }, s.now);
  }
  return id;
}

export interface MeetingInput {
  leadId: string;
  dealId?: string;
  title: string;
  start: number;
  end: number;
  status: MeetingStatus;
  where?: string;
  calendarEventId?: string;
  attendeeEmail?: string;
}

// A call or visit. Booking one moves the lead (and its deal) to "meeting"; holding it keeps it there; cancelling leaves the stage.
export async function recordMeeting(g: GraphHandle, m: MeetingInput, s: Src): Promise<string> {
  const lead = await nameOf(g, m.leadId);
  if (!lead) throw new Error(`${m.leadId} is not in the records`);
  const id = meetingIdFor(m.leadId, m.start);
  const asOf = asOfOf(s.now);
  await upsertNode(g, {
    type: "Meeting", id, name: clip(m.title, 120),
    props: { status: m.status, start: m.start, end: m.end, ...(m.where ? { where: m.where } : {}), ...(m.calendarEventId ? { calendarEventId: m.calendarEventId } : {}) },
    src: s.src, asOf,
  }, s.now);
  await link(g, id, "MEETING_FOR", m.dealId ?? m.leadId, s);
  const person = (await g.roQuery<{ id: string }>("MATCH (:Entity {id:$id})-[r:ENQUIRED_BY]->(p:Person) WHERE r.until IS NULL RETURN p.id AS id ORDER BY p.id LIMIT 1", { id: m.leadId }))[0];
  if (person) await link(g, id, "MEETING_WITH", person.id, s);
  const biz = await findBusinessId(g, s.tenant);
  if (biz) await link(g, id, "PART_OF", biz, s);
  if (m.status === "booked" || m.status === "held") {
    if (isOpen(lead.props.stage) && lead.props.stage !== "meeting") await moveStage(g, m.leadId, "meeting", { ...s, reason: "meeting booked" });
    if (m.dealId) {
      const d = await nameOf(g, m.dealId);
      if (d && isOpen(d.props.stage) && d.props.stage !== "meeting") await moveStage(g, m.dealId, "meeting", { ...s, reason: "meeting booked" });
    }
  }
  return id;
}

export interface TaskInput { forId: string; title: string; due?: number; owner?: string }

// "Follow up with Priya on Friday": a Task for a lead, deal or meeting, owned by the person who will do it.
export async function addFollowUp(g: GraphHandle, t: TaskInput, s: Src): Promise<string> {
  const target = await nameOf(g, t.forId);
  if (!target) throw new Error(`${t.forId} is not in the records`);
  const id = entityId("Task", `${t.title} ${t.forId}`);
  const asOf = asOfOf(s.now);
  await upsertNode(g, { type: "Task", id, name: clip(t.title, 120), props: { status: "open", kind: "follow_up", ...(t.due ? { dueAt: t.due } : {}) }, src: s.src, asOf }, s.now);
  await link(g, id, "FOLLOWS_UP", t.forId, s);
  if (t.owner) await link(g, t.owner, "OWNS", id, s);
  return id;
}

// ---------- reads ----------

export interface LeadRow {
  id: string; name: string; stage: Stage; source: string | null; email: string | null; subject: string | null; summary: string | null;
  needsReply: boolean; firstContactAt: number | null; lastInboundAt: number | null; lastOutboundAt: number | null; lastActivityAt: number | null;
  value: number | null; dealId: string | null; src: string | null; asOf: string | null;
}

const LEAD_COLS = `l.id AS id, l.name AS name, l.stage AS stage, l.source AS source, l.email AS email, l.subject AS subject, l.summary AS summary,
  coalesce(l.needsReply, false) AS needsReply, l.firstContactAt AS firstContactAt, l.lastInboundAt AS lastInboundAt, l.lastOutboundAt AS lastOutboundAt,
  l.lastActivityAt AS lastActivityAt, l.value AS value, l.src AS src, l.asOf AS asOf`;

const toLead = (r: Record<string, unknown>): LeadRow => ({
  id: String(r.id), name: String(r.name ?? r.id), stage: isStage(r.stage) ? r.stage : "new", source: (r.source as string) ?? null, email: (r.email as string) ?? null,
  subject: (r.subject as string) ?? null, summary: (r.summary as string) ?? null, needsReply: r.needsReply === true,
  firstContactAt: (r.firstContactAt as number) ?? null, lastInboundAt: (r.lastInboundAt as number) ?? null, lastOutboundAt: (r.lastOutboundAt as number) ?? null,
  lastActivityAt: (r.lastActivityAt as number) ?? null, value: (r.value as number) ?? null, dealId: (r.dealId as string) ?? null, src: (r.src as string) ?? null, asOf: (r.asOf as string) ?? null,
});

export async function listLeads(g: Read, o: { stage?: Stage; open?: boolean; limit?: number } = {}): Promise<LeadRow[]> {
  const where = o.stage ? "WHERE l.stage = $stage" : o.open ? "WHERE l.stage IN $open" : "";
  const rows = await g.roQuery<Record<string, unknown>>(
    `MATCH (l:Entity:Lead) ${where} RETURN ${LEAD_COLS}, null AS dealId ORDER BY coalesce(l.lastActivityAt, 0) DESC, l.id LIMIT $limit`,
    { ...(o.stage ? { stage: o.stage } : {}), ...(o.open ? { open: OPEN_STAGES } : {}), limit: Math.max(1, Math.min(o.limit ?? 50, 200)) });
  return rows.map(toLead);
}

export async function getLead(g: Read, id: string): Promise<LeadRow | null> {
  const [r] = await g.roQuery<Record<string, unknown>>(`MATCH (l:Entity:Lead {id:$id}) RETURN ${LEAD_COLS}, null AS dealId`, { id });
  return r ? toLead(r) : null;
}

// Enquiries nobody has answered: the last thing that happened is them writing. Oldest first (they have waited longest).
export async function unanswered(g: Read, now: number, o: { minHours?: number; limit?: number } = {}): Promise<Array<LeadRow & { waitingHours: number }>> {
  const rows = await g.roQuery<Record<string, unknown>>(
    `MATCH (l:Entity:Lead) WHERE l.needsReply = true AND l.stage IN $open RETURN ${LEAD_COLS}, null AS dealId ORDER BY coalesce(l.lastInboundAt, 0), l.id LIMIT $limit`,
    { open: OPEN_STAGES, limit: Math.max(1, Math.min(o.limit ?? 50, 200)) });
  const minMs = (o.minHours ?? 0) * 3_600_000;
  return rows.map(toLead)
    .map((l) => ({ ...l, waitingHours: Math.max(0, Math.round((now - (l.lastInboundAt ?? now)) / 3_600_000)) }))
    .filter((l) => l.waitingHours * 3_600_000 >= minMs);
}

export interface DealRow {
  id: string; name: string; stage: Stage; value: number | null; currency: string | null; leadId: string | null; leadName: string | null;
  nextStep: string | null; lastActivityAt: number | null; openedAt: number | null; idleDays: number; src: string | null; asOf: string | null;
}

export async function listDeals(g: Read, now: number, o: { open?: boolean; limit?: number } = {}): Promise<DealRow[]> {
  const rows = await g.roQuery<Record<string, unknown>>(
    `MATCH (d:Entity:Deal) ${o.open ? "WHERE d.stage IN $open" : ""}
     OPTIONAL MATCH (d)-[r:DEAL_OF]->(l:Lead) WHERE r.until IS NULL
     RETURN d.id AS id, d.name AS name, d.stage AS stage, d.value AS value, d.currency AS currency, l.id AS leadId, l.name AS leadName,
       d.nextStep AS nextStep, d.lastActivityAt AS lastActivityAt, d.openedAt AS openedAt, d.src AS src, d.asOf AS asOf
     ORDER BY coalesce(d.lastActivityAt, 0), d.id LIMIT $limit`,
    { ...(o.open ? { open: OPEN_STAGES } : {}), limit: Math.max(1, Math.min(o.limit ?? 50, 200)) });
  return rows.map((r) => {
    const last = (r.lastActivityAt as number | null) ?? (r.openedAt as number | null);
    return {
      id: String(r.id), name: String(r.name ?? r.id), stage: isStage(r.stage) ? r.stage : "new", value: (r.value as number) ?? null, currency: (r.currency as string) ?? null,
      leadId: (r.leadId as string) ?? null, leadName: (r.leadName as string) ?? null, nextStep: (r.nextStep as string) ?? null,
      lastActivityAt: (r.lastActivityAt as number) ?? null, openedAt: (r.openedAt as number) ?? null,
      idleDays: last === null || last === undefined ? 0 : Math.max(0, Math.floor((now - last) / DAY)), src: (r.src as string) ?? null, asOf: (r.asOf as string) ?? null,
    };
  });
}

// Open deals with nothing happening for `days` days (two weeks by default), most idle first.
export async function stalledDeals(g: Read, now: number, days = STALLED_DAYS): Promise<DealRow[]> {
  return (await listDeals(g, now, { open: true, limit: 200 })).filter((d) => d.idleDays >= days).sort((a, b) => b.idleDays - a.idleDays || a.id.localeCompare(b.id));
}

export interface MeetingRow { id: string; name: string; status: MeetingStatus; start: number; end: number; leadId: string | null; leadName: string | null; personEmail: string | null; src: string | null }

// Meetings starting in [from, to) that are booked (or still only proposed when `status` says so), soonest first.
export async function meetingsBetween(g: Read, from: number, to: number, status: MeetingStatus = "booked"): Promise<MeetingRow[]> {
  const rows = await g.roQuery<Record<string, unknown>>(
    `MATCH (m:Entity:Meeting) WHERE m.status = $status AND m.start >= $from AND m.start < $to
     OPTIONAL MATCH (m)-[r:MEETING_FOR]->(t:Entity) WHERE r.until IS NULL
     OPTIONAL MATCH (m)-[w:MEETING_WITH]->(p:Person) WHERE w.until IS NULL
     RETURN m.id AS id, m.name AS name, m.status AS status, m.start AS start, m.end AS end, t.id AS leadId, t.name AS leadName, p.email AS personEmail, m.src AS src
     ORDER BY m.start, m.id LIMIT 100`, { status, from, to });
  return rows.map((r) => ({
    id: String(r.id), name: String(r.name), status: r.status as MeetingStatus, start: Number(r.start), end: Number(r.end),
    leadId: (r.leadId as string) ?? null, leadName: (r.leadName as string) ?? null, personEmail: (r.personEmail as string) ?? null, src: (r.src as string) ?? null,
  }));
}

export interface Move { id: string; kind: "Lead" | "Deal"; name: string; from: string | null; to: string; at: number; atIso: string }

// What moved between two times: every stage change of a lead or deal, from the Versions kept when the stage changed, plus
// each lead that arrived in the window (null -> new). Oldest first.
export async function whatMoved(g: Read, from: number, to: number): Promise<Move[]> {
  const versions = await g.roQuery<{ id: string; name: string | null; cur: string | null; labels: string[]; props: string; until: number; vid: string }>(
    `MATCH (n:Entity)-[h:HAD_VERSION]->(v:Version) WHERE (n:Lead OR n:Deal) AND v.until >= $from AND 'stage' IN v.changed
     RETURN n.id AS id, n.name AS name, n.stage AS cur, labels(n) AS labels, v.props AS props, v.until AS until, v.id AS vid
     ORDER BY n.id, v.until, v.id`, { from });
  const moves: Move[] = [];
  const byNode = new Map<string, typeof versions>();
  for (const v of versions) byNode.set(v.id, [...(byNode.get(v.id) ?? []), v]);
  for (const [id, vs] of byNode) {
    vs.forEach((v, i) => {
      let was: string | null = null;
      try { was = (JSON.parse(v.props) as { stage?: string }).stage ?? null; } catch { was = null; }
      const next = vs[i + 1];
      let now: string | null = v.cur;
      if (next) { try { now = (JSON.parse(next.props) as { stage?: string }).stage ?? v.cur; } catch { now = v.cur; } }
      if (v.until < to && now && was !== now) moves.push({ id, kind: v.labels.includes("Deal") ? "Deal" : "Lead", name: v.name ?? id, from: was, to: now, at: v.until, atIso: toIso(v.until) });
    });
  }
  const fresh = await g.roQuery<{ id: string; name: string | null; at: number | null }>(
    "MATCH (l:Entity:Lead) WHERE l.firstContactAt >= $from AND l.firstContactAt < $to RETURN l.id AS id, l.name AS name, l.firstContactAt AS at ORDER BY l.id", { from, to });
  for (const f of fresh) if (f.at !== null) moves.push({ id: f.id, kind: "Lead", name: f.name ?? f.id, from: null, to: "new", at: f.at, atIso: toIso(f.at) });
  return moves.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

export interface Pipeline { byStage: Record<Stage, number>; openValue: number; open: number; wonValue: number }

export async function pipeline(g: Read): Promise<Pipeline> {
  const rows = await g.roQuery<{ stage: string | null; n: number; value: number | null }>(
    "MATCH (d:Entity:Deal) WITH d.stage AS stage, count(d) AS n, sum(coalesce(d.value, 0)) AS value RETURN stage, n, value");
  const leads = await g.roQuery<{ stage: string | null; n: number }>("MATCH (l:Entity:Lead) WITH l.stage AS stage, count(l) AS n RETURN stage, n");
  const byStage = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>;
  for (const r of leads) if (isStage(r.stage)) byStage[r.stage] += r.n;
  let openValue = 0, wonValue = 0, open = 0;
  for (const r of rows) {
    if (!isStage(r.stage)) continue;
    if (isOpen(r.stage)) { openValue += r.value ?? 0; open += r.n; }
    else if (r.stage === "won") wonValue += r.value ?? 0;
  }
  return { byStage, openValue, open, wonValue };
}
