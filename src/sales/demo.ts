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
import { ensureAgentNode } from "../actions/shared.js";
import { DAY, logMessage, moveStage, openDeal, recordEnquiry, recordMeeting, type Src } from "./graph.js";

export const SALES_DEMO_TENANT = "demo_growth";
export const isSalesDemo = (tenant: string): boolean => tenant === SALES_DEMO_TENANT;

const HOUR = 3_600_000;

// ---------- the graph ----------

export interface SalesDemoCounts { leads: number; deals: number; meetings: number; messages: number }

export async function seedSalesDemo(g: GraphHandle, now: number, tenant = SALES_DEMO_TENANT): Promise<SalesDemoCounts> {
  const neel = await ensureAgentNode(g, "sales-lead", now - 30 * DAY);
  const at = (ms: number, ref: string): Src => ({ src: ref, now: ms, tenant });
  let messages = 0;

  // Mehta Logistics: wrote ten days ago, was answered, has a deal, and a call booked for tomorrow morning (IST)
  {
    const t0 = now - 10 * DAY;
    const who = { name: "Arjun Mehta", email: "arjun@mehtalogistics.example" };
    const r = await recordEnquiry(g, { ...who, channel: "email", subject: "Warehouse shift workers", body: "We run a warehouse in Chakan and need about 40 shift workers a week, mostly nights. Can Shiftly supply them, and what would it cost?", at: t0, externalId: "demo-mehta-1" }, at(t0, "gmail:demo-mehta-1"));
    messages++;
    await logMessage(g, { leadId: r.leadId, direction: "out", channel: "email", subject: "Re: Warehouse shift workers", body: "Hi Arjun, yes, we can. Nights in Chakan are one of our busiest areas. Could we talk for 30 minutes this week? I will send three times that work for us.", at: t0 + 2 * HOUR, status: "sent", externalId: "demo-mehta-reply", by: neel, toPersonId: r.personId }, at(t0 + 2 * HOUR, "approval:demo-mehta-reply"));
    messages++;
    const deal = await openDeal(g, { leadId: r.leadId, title: "Mehta Logistics: 40 warehouse shifts a week", value: 240000, currency: "INR", stage: "contacted", nextStep: "Call to agree the number of shifts" }, at(t0 + 3 * HOUR, "turn:demo-seed"));
    const book = now - 2 * DAY; // booked two days ago, so it is a move of this week
    const start = Date.parse(new Date(now + DAY).toISOString().slice(0, 10) + "T05:30:00Z"); // 11:00 IST tomorrow
    await recordMeeting(g, { leadId: r.leadId, dealId: deal, title: "Call with Arjun Mehta (Mehta Logistics)", start, end: start + 30 * 60_000, status: "booked", where: "Google Meet" }, at(book, "approval:demo-mehta-invite"));
  }

  // Sahyadri Hotels: answered three weeks ago, a rate card was promised, and nothing has happened since (the stalled deal)
  {
    const t0 = now - 23 * DAY;
    const r = await recordEnquiry(g, { name: "Sana Qureshi", email: "sana@sahyadrihotels.example", channel: "email", subject: "Banquet staff for the wedding season", body: "We host weddings at our Lonavala banquet hall from November. We need servers and runners on weekends. Please send your rates.", at: t0, externalId: "demo-sahyadri-1" }, at(t0, "gmail:demo-sahyadri-1"));
    messages++;
    await logMessage(g, { leadId: r.leadId, direction: "out", channel: "email", subject: "Re: Banquet staff for the wedding season", body: "Hi Sana, thank you. We can staff weekend weddings. I will send our rate card in a few days.", at: t0 + 3 * HOUR, status: "sent", externalId: "demo-sahyadri-reply", by: neel, toPersonId: r.personId }, at(t0 + 3 * HOUR, "approval:demo-sahyadri-reply"));
    messages++;
    await openDeal(g, { leadId: r.leadId, title: "Sahyadri Hotels: weekend wedding staff", value: 180000, currency: "INR", stage: "contacted", nextStep: "Send the rate card" }, at(now - 18 * DAY, "turn:demo-seed"));
  }

  // Desai Caterers: wrote yesterday on WhatsApp, nobody has answered
  {
    const t0 = now - 27 * HOUR;
    await recordEnquiry(g, { name: "Rohit Desai", email: "rohit@desaicaterers.example", phone: "+91 98765 00000", channel: "whatsapp", body: "Need 12 servers for a wedding on 24 Oct in Pune. What are your rates and can you do it at this short notice?", at: t0, externalId: "demo-desai-1" }, at(t0, "whatsapp:demo-desai-1"));
    messages++;
  }

  // Green Leaf Cafes: a customer already. Won this week.
  {
    const t0 = now - 27 * DAY;
    const r = await recordEnquiry(g, { name: "Ira Bose", email: "ira@greenleafcafes.example", channel: "email", subject: "Weekend baristas", body: "We open a third cafe in Baner next month and need weekend baristas. Can you help?", at: t0, externalId: "demo-greenleaf-1" }, at(t0, "gmail:demo-greenleaf-1"));
    messages++;
    await logMessage(g, { leadId: r.leadId, direction: "out", channel: "email", subject: "Re: Weekend baristas", body: "Hi Ira, yes, baristas are easy for us to find in Baner. Shall we talk on Wednesday?", at: t0 + 2 * HOUR, status: "sent", externalId: "demo-greenleaf-reply", by: neel, toPersonId: r.personId }, at(t0 + 2 * HOUR, "approval:demo-greenleaf-reply"));
    messages++;
    const deal = await openDeal(g, { leadId: r.leadId, title: "Green Leaf Cafes: weekend baristas", value: 96000, currency: "INR", stage: "contacted" }, at(t0 + 3 * HOUR, "turn:demo-seed"));
    const start = now - 15 * DAY;
    await recordMeeting(g, { leadId: r.leadId, dealId: deal, title: "Call with Ira Bose (Green Leaf Cafes)", start, end: start + 30 * 60_000, status: "held" }, at(start - 2 * DAY, "approval:demo-greenleaf-invite"));
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
