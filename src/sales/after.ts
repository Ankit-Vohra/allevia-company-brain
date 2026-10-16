// What an approved email or invite leaves in the records. The executors (src/actions/executors.ts) send the email and add the
// meeting; once one of them says "done", this writes the story down: an outbound Message in the lead's thread (which answers the
// lead and moves a new one to "contacted"), or a booked Meeting (which moves the lead and its deal to "meeting"). The lead is found
// from who the email went to or who was invited, so the tools that propose them need no extra arguments. Anything that is not
// about a known lead leaves nothing. Nothing is written for a dry run: nothing went out.
import type { ActionKind } from "../../shared/contracts.js";
import type { GraphHandle } from "../graph/client.js";
import { ensureAgentNode, type Payload } from "../actions/shared.js";
import { getLead, leadIdFor, logMessage, personIdFor, recordMeeting, dealIdFor } from "./graph.js";

const addresses = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,;]/) : []).map((x) => String(x).trim().toLowerCase()).filter(Boolean);

export interface AfterInput { approvalId: string; kind: ActionKind; payload: Payload; agent?: string; now: number; tenant: string }
export interface After { produced: string[] }

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

export async function recordSalesOutcome(g: GraphHandle, i: AfterInput, link?: string): Promise<After> {
  const produced: string[] = [];
  const src = { src: `approval:${i.approvalId}`, now: i.now, tenant: i.tenant };
  if (i.kind === "email_send") {
    const to = addresses(i.payload.to);
    const leads = await leadsFor(g, to);
    if (!leads.length) return { produced };
    const by = await ensureAgentNode(g, i.agent ?? "sales-lead", i.now);
    const sent = i.payload.send !== false;
    for (const l of leads) {
      produced.push(await logMessage(g, {
        leadId: l.leadId, ...(l.dealId ? { dealId: l.dealId } : {}), direction: "out", channel: "email",
        ...(typeof i.payload.subject === "string" ? { subject: i.payload.subject } : {}), body: i.payload.body, at: i.now,
        status: sent ? "sent" : "draft", externalId: `${i.approvalId}-${l.email}`, by, toPersonId: personIdFor(l.email, ""),
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
      }, src));
    }
  }
  return { produced };
}
