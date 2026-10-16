// The Sales demo on the synthetic business (demo_growth, "Shiftly"): a few leads in different stages, a stalled deal, an enquiry
// nobody has answered and one that is only in the inbox, so the whole flow can be shown without a real customer:
//   a new enquiry -> a reply with three real times -> OK -> the invite -> the reminder.
// Two parts:
//   seedSalesDemo    the leads, deals, meetings and messages in the graph (called by seedGrowth), dated from `now`
//   demoConnections  a ConnectionsPort for the demo business only: a sample inbox, a sample calendar, and an email and a meeting that
//                    are "sent" and "booked" into memory, so the approved cards really run end to end and reach nobody. It speaks
//                    the same interface as the real connections (src/connections/service.ts), so the tools and executors that use
//                    it are the real ones.
// Everything here is synthetic: no real company, person or address (all .example).
import { entryById } from "../../shared/connection-map.js";
import type { ConnectionsPort } from "../connections/service.js";
import type { BusyBlock, CreatedEvent, GoogleApis, InboxMessage, NewEvent, OutgoingEmail, SentEmail } from "../connections/google/apis.js";
import { NotConnectedError, type ConnectionStatus, type ConnectionView } from "../connections/types.js";
import type { GraphHandle } from "../graph/client.js";
import { actionIdFor } from "../actions/executors.js";
import { ensureActor, ensureAgentNode, findBusinessId } from "../actions/shared.js";
import { upsertEdge, upsertNode } from "../graph/upsert.js";
import { entityId } from "../util/ids.js";
import { toIso } from "../util/time.js";
import { DAY, enquiryGoal, logMessage, moveStage, openDeal, recordEnquiry, recordMeeting, type Src } from "./graph.js";

export const SALES_DEMO_TENANT = "demo_growth";
export const isSalesDemo = (tenant: string): boolean => tenant === SALES_DEMO_TENANT;

const HOUR = 3_600_000;

// ---------- the graph ----------

export interface SalesDemoCounts { leads: number; deals: number; meetings: number; messages: number }

// The goal the demo's enquiries are for: the business's own enquiries goal when it has one, else a small one of the demo's own. It is
// not part of a growth plan (nothing is enrolled), so it has a target and no reading yet.
async function demoEnquiryGoal(g: GraphHandle, now: number, agent: string): Promise<void> {
  if (await enquiryGoal(g)) return;
  const biz = await findBusinessId(g, SALES_DEMO_TENANT);
  const src = "demo:sales-seed", since = now - 30 * DAY, asOf = toIso(since);
  const metric = entityId("Metric", "enquiries");
  const goal = entityId("Goal", "employer enquiries");
  await upsertNode(g, { type: "Metric", id: metric, name: "Enquiries", props: { key: "enquiries", unit: "enquiries" }, src, asOf }, since);
  await upsertNode(g, {
    type: "Goal", id: goal, name: "More enquiries from employers", summary: "Employers who ask Shiftly for shift staff: a wedding season, a new cafe, a warehouse.",
    props: { metricKey: "enquiries", unit: "enquiries", period: "month", target: 12, priority: 1, status: "no_data" }, src, asOf,
  }, since);
  await upsertEdge(g, { from: goal, type: "TRACKS", to: metric, src, asOf, since }, since);
  await upsertEdge(g, { from: agent, type: "OWNS", to: goal, src, asOf, since }, since);
  if (biz) await upsertEdge(g, { from: biz, type: "PURSUES", to: goal, src, asOf, since }, since);
}

// What brought the wedding-season enquiries: a campaign with its UTM name, and the reel inside it. Sample data, said so.
async function demoCampaign(g: GraphHandle, now: number): Promise<void> {
  const src = "demo:sales-seed", since = now - 40 * DAY, asOf = toIso(since);
  await upsertNode(g, { type: "Campaign", id: "campaign:wedding-season-staffing", name: "Wedding season staffing", props: { status: "active", objective: "enquiries", utm_campaign: "wedding-season" }, simulated: true, src, asOf }, since);
  await upsertNode(g, { type: "Content", id: "content:weekend-wedding-staff-reel", name: "Weekend wedding staff reel", props: { status: "published", format: "reel" }, simulated: true, src, asOf }, since);
  await upsertEdge(g, { from: "content:weekend-wedding-staff-reel", type: "PART_OF", to: "campaign:wedding-season-staffing", src, asOf, since }, since);
}

interface CardSeed {
  id: string;                    // the approval is approval:<id>, the action action:<id>
  kind: "email_send" | "calendar_event";
  title: string;                 // the card's title, as the tool made it
  why: string;
  payload: Record<string, unknown>;
  leadId: string;
  evidence: string[];            // what the card was based on
  made: string;                  // the Message or Meeting the action made
  createdAt: number;
  decidedAt: number;
  result: string;
  url?: string;
}

// An approved card, the way the real flow leaves it (propose_action, then decideApproval and the executor): a Recommendation by the
// sales lead that PROPOSES the Approval and is EVIDENCED_BY what it was based on; the owner's OK (APPROVED_BY, status approved then
// executed, each a Version); the Action it ran, which AFFECTS the lead and RESULTED_IN the Message or Meeting. The Message and
// Meeting themselves are written by the sales writers, before this. Nothing was really sent or booked: the Action says so.
async function seedApprovedCard(g: GraphHandle, c: CardSeed, who: { agent: string; owner: string }): Promise<void> {
  const approval = `approval:${c.id}`;
  const rec = entityId("Recommendation", c.title);
  const action = actionIdFor(approval);
  const name = `${c.kind}: ${c.title}`;
  const src = "demo:sales-seed";
  const edge = (from: string, type: "PROPOSES" | "EVIDENCED_BY" | "PRODUCED" | "APPROVED_BY" | "RESULTED_IN" | "AFFECTS", to: string, ms: number) =>
    upsertEdge(g, { from, type, to, src: approval, asOf: toIso(ms), since: ms }, ms);
  await upsertNode(g, {
    type: "Recommendation", id: rec, name: c.title, summary: c.why,
    props: { status: "open", kind: c.kind, by: "sales-lead", area: "sales" }, src, asOf: toIso(c.createdAt),
  }, c.createdAt);
  await upsertNode(g, {
    type: "Approval", id: approval, name,
    props: { status: "pending", kind: c.kind, payload: JSON.stringify(c.payload), title: c.title, recommendation: rec, by: "sales-lead" }, src, asOf: toIso(c.createdAt),
  }, c.createdAt);
  await edge(rec, "PROPOSES", approval, c.createdAt);
  for (const e of [...new Set(c.evidence)]) await edge(rec, "EVIDENCED_BY", e, c.createdAt);
  await edge(who.agent, "PRODUCED", rec, c.createdAt);
  // the owner's OK
  await upsertNode(g, {
    type: "Approval", id: approval, name,
    props: { status: "approved", decision: "approve", decidedAt: c.decidedAt, decidedBy: who.owner, firstPass: true, decisionMs: c.decidedAt - c.createdAt, editDistance: 0 },
    src: approval, asOf: toIso(c.decidedAt),
  }, c.decidedAt);
  await edge(approval, "APPROVED_BY", who.owner, c.decidedAt);
  await upsertNode(g, { type: "Recommendation", id: rec, name: c.title, props: { status: "approved" }, src: approval, asOf: toIso(c.decidedAt) }, c.decidedAt);
  // what it ran, a moment after the OK
  const ran = c.decidedAt + 2_000;
  await upsertNode(g, {
    type: "Action", id: action, name: name.slice(0, 160),
    props: { kind: c.kind, status: "done", result: c.result, at: ran, approval, by: "sales-lead", ...(c.url ? { url: c.url } : {}) },
    simulated: true, src: approval, asOf: toIso(ran),
  }, ran);
  await edge(approval, "RESULTED_IN", action, ran);
  await edge(action, "AFFECTS", c.leadId, ran);
  await edge(action, "RESULTED_IN", c.made, ran);
  await upsertNode(g, { type: "Approval", id: approval, name, props: { status: "executed", result: c.result, actionId: action }, src: approval, asOf: toIso(ran) }, ran);
}

type Card = Pick<CardSeed, "id" | "kind" | "title" | "why" | "payload">;

const emailCard = (id: string, subject: string, to: string, body: string, why: string, send = true): Card => ({
  id, kind: "email_send", title: `${send ? "Send" : "Draft"} email: ${subject}`, why,
  payload: { title: subject, subject, to: [to], body, send, target: `${send ? "Email to" : "Draft email to"} ${to}` },
});

const inviteCard = (id: string, title: string, guest: string, start: number, end: number, why: string): Card => ({
  id, kind: "calendar_event", title: `Meeting: ${title}`, why,
  payload: {
    title, body: "", start: new Date(start).toISOString(), end: new Date(end).toISOString(), attendees: [guest],
    target: `Google Calendar: ${new Date(start).toISOString().replace("T", " ").slice(0, 16)} for ${Math.round((end - start) / 60_000)} minutes, guest ${guest}`,
  },
});

// What every record below was made from: the enquiry arrives, the team's reply is proposed and the owner says OK, and the owner's OK
// is the Approval that ends in the Message or Meeting. Dated from `now`. Everything is synthetic: no real company, person or address.
export async function seedSalesDemo(g: GraphHandle, now: number, tenant = SALES_DEMO_TENANT): Promise<SalesDemoCounts> {
  const neel = await ensureAgentNode(g, "sales-lead", now - 30 * DAY);
  const owner = await ensureActor(g, "person:founder", now - 30 * DAY);
  const who = { agent: neel, owner };
  const at = (ms: number, ref: string): Src => ({ src: ref, now: ms, tenant });
  let messages = 0;
  await demoCampaign(g, now);
  await demoEnquiryGoal(g, now, neel);

  // Mehta Logistics: wrote ten days ago, was answered, has a deal, and a call booked for tomorrow morning (IST). The reply was approved
  // twice: first as a draft ("don't send yet": the wording is saved as ready), then to send, which makes the same message "sent".
  {
    const t0 = now - 10 * DAY;
    const person = { name: "Arjun Mehta", email: "arjun@mehtalogistics.example" };
    const r = await recordEnquiry(g, { ...person, channel: "email", subject: "Warehouse shift workers", body: "We run a warehouse in Chakan and need about 40 shift workers a week, mostly nights. Can Shiftly supply them, and what would it cost?", at: t0, externalId: "demo-mehta-1" }, at(t0, "gmail:demo-mehta-1"));
    messages++;
    const subject = "Re: Warehouse shift workers";
    const body = "Hi Arjun, yes, we can. Nights in Chakan are one of our busiest areas. Could we talk for 30 minutes this week? I will send three times that work for us.";
    const reply = { leadId: r.leadId, direction: "out" as const, channel: "email", subject, body, by: neel, toPersonId: r.personId };
    const draftAt = t0 + HOUR, sentAt = t0 + 2 * HOUR;
    const drafted = await logMessage(g, { ...reply, at: draftAt, status: "draft", key: "demo-mehta-reply", externalId: "demo-mehta-reply" }, at(draftAt, "approval:demo-mehta-reply-draft"));
    await seedApprovedCard(g, {
      ...emailCard("demo-mehta-reply-draft", subject, person.email, body, "Arjun asked about 40 night-shift workers a week; the wording of the answer, to read before it goes", false),
      leadId: r.leadId, evidence: [r.leadId, r.messageId], made: drafted, createdAt: draftAt - 20 * 60_000, decidedAt: draftAt,
      result: "Approved. This wording is saved as ready; nothing was sent. Ask your team to send it when you want it to go.",
    }, who);
    await logMessage(g, { ...reply, at: sentAt, status: "sent", key: "demo-mehta-reply", externalId: "demo-gmail-mehta-reply", threadId: "demo-thr-mehta" }, at(sentAt, "approval:demo-mehta-reply"));
    await seedApprovedCard(g, {
      ...emailCard("demo-mehta-reply", subject, person.email, body, "The approved draft to Arjun, now sent"),
      leadId: r.leadId, evidence: [r.leadId, r.messageId], made: drafted, createdAt: sentAt - 5 * 60_000, decidedAt: sentAt,
      result: `Sent "${subject}" to ${person.email} (message demo-gmail-mehta-reply).`,
    }, who);
    messages++;
    const deal = await openDeal(g, { leadId: r.leadId, title: "Mehta Logistics: 40 warehouse shifts a week", value: 240000, currency: "INR", stage: "contacted", nextStep: "Call to agree the number of shifts" }, at(t0 + 3 * HOUR, "turn:demo-seed"));
    const book = now - 2 * DAY; // booked two days ago, so it is a move of this week
    const start = Date.parse(new Date(now + DAY).toISOString().slice(0, 10) + "T05:30:00Z"); // 11:00 IST tomorrow
    const title = "Call with Arjun Mehta (Mehta Logistics)";
    const meeting = await recordMeeting(g, { leadId: r.leadId, dealId: deal, title, start, end: start + 30 * 60_000, status: "booked", where: "Google Meet", calendarEventId: "demo-evt-mehta" }, at(book, "approval:demo-mehta-invite"));
    await seedApprovedCard(g, {
      ...inviteCard("demo-mehta-invite", title, person.email, start, start + 30 * 60_000, "Arjun agreed to a call; the invite, at a time that is free on the calendar"),
      leadId: r.leadId, evidence: [r.leadId, deal], made: meeting, createdAt: book - 30 * 60_000, decidedAt: book,
      result: `Added "${title}" to your calendar.`, url: "https://calendar.example/demo-evt-mehta",
    }, who);
  }

  // Sahyadri Hotels: answered three weeks ago, a rate card was promised, and nothing has happened since (the stalled deal). It came
  // through the wedding-season campaign: the link carried utm_campaign=wedding-season.
  {
    const t0 = now - 23 * DAY;
    const r = await recordEnquiry(g, { name: "Sana Qureshi", email: "sana@sahyadrihotels.example", channel: "email", subject: "Banquet staff for the wedding season", body: "We host weddings at our Lonavala banquet hall from November. We need servers and runners on weekends. Please send your rates.", at: t0, externalId: "demo-sahyadri-1", utmCampaign: "wedding-season" }, at(t0, "gmail:demo-sahyadri-1"));
    messages++;
    const subject = "Re: Banquet staff for the wedding season";
    const body = "Hi Sana, thank you. We can staff weekend weddings. I will send our rate card in a few days.";
    const reply = await logMessage(g, { leadId: r.leadId, direction: "out", channel: "email", subject, body, at: t0 + 3 * HOUR, status: "sent", key: "demo-sahyadri-reply", externalId: "demo-gmail-sahyadri-reply", threadId: "demo-thr-sahyadri", by: neel, toPersonId: r.personId }, at(t0 + 3 * HOUR, "approval:demo-sahyadri-reply"));
    await seedApprovedCard(g, {
      ...emailCard("demo-sahyadri-reply", subject, "sana@sahyadrihotels.example", body, "Sana asked for rates for weekend wedding staff; a first answer that promises the rate card"),
      leadId: r.leadId, evidence: [r.leadId, r.messageId], made: reply, createdAt: t0 + 2 * HOUR, decidedAt: t0 + 3 * HOUR,
      result: `Sent "${subject}" to sana@sahyadrihotels.example (message demo-gmail-sahyadri-reply).`,
    }, who);
    messages++;
    await openDeal(g, { leadId: r.leadId, title: "Sahyadri Hotels: weekend wedding staff", value: 180000, currency: "INR", stage: "contacted", nextStep: "Send the rate card" }, at(now - 18 * DAY, "turn:demo-seed"));
  }

  // Desai Caterers: wrote yesterday on WhatsApp, nobody has answered. The WhatsApp ad's own headline was "Weekend wedding staff reel".
  {
    const t0 = now - 27 * HOUR;
    await recordEnquiry(g, { name: "Rohit Desai", email: "rohit@desaicaterers.example", phone: "+91 98765 00000", channel: "whatsapp", body: "Need 12 servers for a wedding on 24 Oct in Pune. What are your rates and can you do it at this short notice?", at: t0, externalId: "demo-desai-1", sourceText: "Weekend wedding staff reel" }, at(t0, "whatsapp:demo-desai-1"));
    messages++;
  }

  // Green Leaf Cafes: a customer already. Won this week.
  {
    const t0 = now - 27 * DAY;
    const r = await recordEnquiry(g, { name: "Ira Bose", email: "ira@greenleafcafes.example", channel: "email", subject: "Weekend baristas", body: "We open a third cafe in Baner next month and need weekend baristas. Can you help?", at: t0, externalId: "demo-greenleaf-1" }, at(t0, "gmail:demo-greenleaf-1"));
    messages++;
    const subject = "Re: Weekend baristas";
    const body = "Hi Ira, yes, baristas are easy for us to find in Baner. Shall we talk on Wednesday?";
    const reply = await logMessage(g, { leadId: r.leadId, direction: "out", channel: "email", subject, body, at: t0 + 2 * HOUR, status: "sent", key: "demo-greenleaf-reply", externalId: "demo-gmail-greenleaf-reply", threadId: "demo-thr-greenleaf", by: neel, toPersonId: r.personId }, at(t0 + 2 * HOUR, "approval:demo-greenleaf-reply"));
    await seedApprovedCard(g, {
      ...emailCard("demo-greenleaf-reply", subject, "ira@greenleafcafes.example", body, "Ira needs weekend baristas for a new cafe in Baner; a quick yes and an offer to talk"),
      leadId: r.leadId, evidence: [r.leadId, r.messageId], made: reply, createdAt: t0 + HOUR, decidedAt: t0 + 2 * HOUR,
      result: `Sent "${subject}" to ira@greenleafcafes.example (message demo-gmail-greenleaf-reply).`,
    }, who);
    messages++;
    const deal = await openDeal(g, { leadId: r.leadId, title: "Green Leaf Cafes: weekend baristas", value: 96000, currency: "INR", stage: "contacted" }, at(t0 + 3 * HOUR, "turn:demo-seed"));
    const start = now - 15 * DAY;
    const title = "Call with Ira Bose (Green Leaf Cafes)";
    const meeting = await recordMeeting(g, { leadId: r.leadId, dealId: deal, title, start, end: start + 30 * 60_000, status: "held", calendarEventId: "demo-evt-greenleaf" }, at(start - 2 * DAY, "approval:demo-greenleaf-invite"));
    await seedApprovedCard(g, {
      ...inviteCard("demo-greenleaf-invite", title, "ira@greenleafcafes.example", start, start + 30 * 60_000, "Ira said yes to a call on Wednesday; the invite"),
      leadId: r.leadId, evidence: [r.leadId, deal], made: meeting, createdAt: start - 2 * DAY - 30 * 60_000, decidedAt: start - 2 * DAY,
      result: `Added "${title}" to your calendar.`, url: "https://calendar.example/demo-evt-greenleaf",
    }, who);
    const won = now - 3 * DAY;
    await moveStage(g, deal, "won", { ...at(won, "turn:demo-seed"), reason: "signed for three months" });
    await moveStage(g, r.leadId, "won", { ...at(won + HOUR, "turn:demo-seed"), reason: "signed for three months" });
  }
  return { leads: 4, deals: 3, meetings: 2, messages };
}

// ---------- the sample connections ----------

/** The one enquiry that is only in the sample inbox: Cafe Verde wants weekend baristas. A newsletter beside it shows machines are skipped. */
export function demoInbox(now: number): InboxMessage[] {
  const d = (ms: number) => new Date(ms).toUTCString();
  return [
    { id: "demo-verde-1", threadId: "demo-thr-verde", from: "Meghna Rao <meghna@cafeverde.example>", subject: "Weekend baristas for our new cafe", date: d(now - 3 * HOUR), snippet: "Hi, we open a new cafe in Koregaon Park on 1 November and need 4 baristas for the weekends. Can Shiftly send us people, and how soon? Could we talk this week?" },
    { id: "demo-news-1", threadId: "demo-thr-news", from: "Shift Weekly <newsletter@shiftweekly.example>", subject: "This week in hourly hiring", date: d(now - 20 * HOUR), snippet: "Unsubscribe any time. Ten tips for filling night shifts." },
  ];
}

/** Sample Google: a calendar with two busy blocks a day (10:00 and 14:30 IST on weekdays), an inbox, and email and meetings kept in memory. */
export class DemoGoogleApis implements GoogleApis {
  sent: OutgoingEmail[] = [];
  events: NewEvent[] = [];
  constructor(private now: () => number) {}
  async accountEmail(): Promise<string | null> { return "rhea@shiftly.example"; }
  async freeBusy(_t: string, q: { timeMin: string; timeMax: string }): Promise<BusyBlock[]> {
    const out: BusyBlock[] = [];
    const first = Date.parse(`${q.timeMin.slice(0, 10)}T00:00:00Z`) - DAY, last = Date.parse(q.timeMax);
    for (let t = first; t <= last; t += DAY) {
      const day = new Date(t).toISOString().slice(0, 10);
      out.push({ start: `${day}T04:30:00.000Z`, end: `${day}T05:30:00.000Z` }, { start: `${day}T09:00:00.000Z`, end: `${day}T10:30:00.000Z` });
    }
    return out;
  }
  async createEvent(_t: string, e: NewEvent): Promise<CreatedEvent> { this.events.push(e); return { id: `demo-evt-${this.events.length}`, link: `https://calendar.example/demo-evt-${this.events.length}` }; }
  async sendEmail(_t: string, m: OutgoingEmail): Promise<SentEmail> { this.sent.push(m); return { id: `demo-msg-${this.sent.length}`, threadId: m.threadId ?? `demo-thr-${this.sent.length}` }; }
  async searchInbox(): Promise<InboxMessage[]> { return demoInbox(this.now()); }
  async ga4Properties() { return []; }
  async ga4Report() { return []; }
  async adsCustomers() { return []; }
  async adsCampaigns() { return []; }
}

const DEMO_CONNECTED = ["gmail", "google-calendar"];

const view = (id: string): ConnectionView => {
  const e = entryById(id)!;
  return { id, name: e.name, access: "read_act", group: e.group, blurb: e.blurb, reads: e.reads, acts: e.acts, state: "connected", message: "Sample data for the demo: nothing is really sent or booked.", available: true };
};

const ports = new Map<string, { port: ConnectionsPort; apis: DemoGoogleApis }>();

/** The sample connections for a demo business (one per process, so what was "sent" can be read back). */
export function demoConnections(tenant: string, now: () => number = () => Date.now()): ConnectionsPort & { apis: DemoGoogleApis } {
  const have = ports.get(tenant);
  if (have) return Object.assign(have.port, { apis: have.apis });
  const apis = new DemoGoogleApis(now);
  const port: ConnectionsPort & { simulated: true } = {
    tenant, simulated: true,
    async status(id: string): Promise<ConnectionStatus> {
      return DEMO_CONNECTED.includes(id) ? { state: "connected", message: "Sample data for the demo." } : { state: "not_connected", message: "Not connected in the demo." };
    },
    async list() { return DEMO_CONNECTED.map(view); },
    async note() { return "Connected tools of this business (sample data for the demo; nothing is really sent or booked): Gmail (gmail), Google Calendar (google-calendar). Use connections_available to see what you may use."; },
    async run<S, T>(id: string, _op: string, fn: (session: S) => Promise<T>): Promise<T> {
      if (!DEMO_CONNECTED.includes(id)) throw new NotConnectedError(id, entryById(id)?.name ?? id, `${entryById(id)?.name ?? id} isn't connected in the demo. Ask the owner to connect it.`);
      return fn({ apis, accessToken: "demo", meta: {}, allowed: () => true, account: "rhea@shiftly.example" } as unknown as S);
    },
  };
  ports.set(tenant, { port, apis });
  return Object.assign(port, { apis });
}
