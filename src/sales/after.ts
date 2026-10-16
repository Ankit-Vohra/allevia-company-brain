// What an approved email or invite leaves in the records. The executors (src/actions/executors.ts) send the email and add the
// meeting; once one of them says "done", this writes the story down: an outbound Message in the lead's thread (which answers the
// lead and moves a new one to "contacted"), or a booked Meeting (which moves the lead and its deal to "meeting"). The lead is found
// from who the email went to or who was invited, so the tools that propose them need no extra arguments. Anything that is not
// about a known lead leaves nothing. Nothing is written for a dry run: nothing went out.
//
// What the executor may hand over besides the link (all optional; without them the records are as before, just without the ids):
//   messageId   Gmail's id for the email that went out   -> Message.externalId
//   threadId    Gmail's thread id                        -> Message.threadId
//   eventId     Google Calendar's id for the event       -> Meeting.calendarEventId
//   url / link  the event's link                         -> Meeting.link
// The third argument is that object (the executor's own outcome can be passed as it is) or, as before, just the link.
//
// The status of a message is the story of that email: an approved "don't send yet" is saved as a draft; the same words approved
// to send later find that draft and make it "sent" (Message.status is tracked, so the draft stays one hop away as a Version);
// an email with no draft before it is a new message that is sent.
import type { ActionKind } from "../../shared/contracts.js";
import type { GraphHandle } from "../graph/client.js";
import { ensureAgentNode, type Payload } from "../actions/shared.js";
import { findDraftMessage, getLead, leadIdFor, logMessage, personIdFor, recordMeeting, dealIdFor } from "./graph.js";

const addresses = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,;]/) : []).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export interface AfterInput { approvalId: string; kind: ActionKind; payload: Payload; agent?: string; now: number; tenant: string }
export interface After { produced: string[] }
export interface SalesOutcomeIds { link?: string; url?: string; messageId?: string; threadId?: string; eventId?: string }

async function leadsFor(g: GraphHandle, emails: string[]): Promise<Array<{ leadId: string; email: string; dealId?: string }>> {
  const out: Array<{ leadId: string; email: string; dealId?: string }> = [];
  for (const email of emails) {
    const leadId = leadIdFor(email, "");
    if (!(await getLead(g, leadId))) continue;
    const [d] = await g.roQuery<{ c: number }>("MATCH (d:Entity:Deal {id:$id}) RETURN count(d) AS c", { id: dealIdFor(leadId) });
    out.push({ leadId, email, ...((d?.c ?? 0) > 0 ? { dealId: dealIdFor(leadId) } : {}) });
  }
  return out;
}

export async function recordSalesOutcome(g: GraphHandle, i: AfterInput, outcome?: string | SalesOutcomeIds): Promise<After> {
  const produced: string[] = [];
  const ids: SalesOutcomeIds = typeof outcome === "string" ? { link: outcome } : outcome ?? {};
  const link = text(ids.link) ?? text(ids.url);
  const src = { src: i.approvalId.startsWith("approval:") ? i.approvalId : `approval:${i.approvalId}`, now: i.now, tenant: i.tenant };
  if (i.kind === "email_send") {
    const to = addresses(i.payload.to);
    const leads = await leadsFor(g, to);
    if (!leads.length) return { produced };
    const by = await ensureAgentNode(g, i.agent ?? "sales-lead", i.now);
    const sent = i.payload.send !== false;
    const subject = typeof i.payload.subject === "string" ? i.payload.subject : undefined;
    for (const l of leads) {
      const key = `${i.approvalId}-${l.email}`;
      // the draft of these exact words saved earlier, if there is one: it is the message that is going out now
      const draft = sent ? await findDraftMessage(g, l.leadId, { ...(subject ? { subject } : {}), body: i.payload.body }) : null;
      produced.push(await logMessage(g, {
        leadId: l.leadId, ...(l.dealId ? { dealId: l.dealId } : {}), direction: "out", channel: "email",
        ...(subject ? { subject } : {}), body: i.payload.body, at: i.now,
        status: sent ? "sent" : "draft", key, externalId: (sent ? text(ids.messageId) : undefined) ?? key,
        ...(draft ? { messageId: draft } : {}), ...(sent && text(ids.threadId) ? { threadId: text(ids.threadId)! } : {}),
        by, toPersonId: personIdFor(l.email, ""),
      }, src));
    }
    return { produced };
  }
  if (i.kind === "calendar_event") {
    const guests = addresses(i.payload.attendees);
    const start = Date.parse(String(i.payload.start ?? "")), end = Date.parse(String(i.payload.end ?? ""));
    if (!Number.isFinite(start) || !Number.isFinite(end)) return { produced };
    for (const l of await leadsFor(g, guests)) {
      produced.push(await recordMeeting(g, {
        leadId: l.leadId, ...(l.dealId ? { dealId: l.dealId } : {}), title: i.payload.title, start, end, status: "booked", ...(link ? { link } : {}),
        ...(text(ids.eventId) ? { calendarEventId: text(ids.eventId)! } : {}),
      }, src));
    }
  }
  return { produced };
}
