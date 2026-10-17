// Sample connections for a demo business: Gmail (a sample inbox), Google Calendar (a sample calendar with real-looking busy
// times) and Shopify (sample store data), behind the same ConnectionsPort the real connections give (src/connections/service.ts),
// so the agents' tools, the stand-up's free times and the Your tools page work unchanged. Only for the businesses listed in
// SAMPLE_TENANTS; everything they answer is sample data for the demo and says so.
//
// Nothing reaches anyone. The port is NOT flagged `simulated`, so with ALLEVIA_ACTIONS_LIVE unset an approved email or meeting
// stays a dry run in the executors ("Dry run: would send ..."); with it set, the "sent" email and the "booked" meeting land in
// this process's memory and nowhere else.
//
// The numbers come from the same functions the seed wrote into the graph (coffee-model.ts), from the moment the seed ran (kept on
// the sample Shopify export Document), so a question asked days later still gets the same week the graph holds.
import { entryById } from "../../../shared/connection-map.js";
import { ComposioError, type ComposioToolInfo } from "../../connections/composio.js";
import type { ConnectionsPort } from "../../connections/service.js";
import type { BusyBlock, CreatedEvent, GoogleApis, InboxMessage, NewEvent, OutgoingEmail, SentEmail } from "../../connections/google/apis.js";
import { NotConnectedError, type ConnectionStatus, type ConnectionView } from "../../connections/types.js";
import { openGraph } from "../../graph/client.js";
import { addDays } from "../../insights/text.js";
import { busyBlocks, COFFEE_INBOX, sampleAt } from "./coffee-inbox.js";
import { AOV_INR, coffeeTimeline, istDay, storeDay, type CoffeeTimeline } from "./coffee-model.js";

export type SampleProfile = "coffee";

/** The demo businesses whose tools are sample connections, and their profile. */
const SAMPLE_TENANTS = new Map<string, SampleProfile>([["bluetokai", "coffee"]]);

/** Tests (and a second demo copy) add a tenant here; production uses the fixed list above. */
export function registerSampleTenant(tenant: string, profile: SampleProfile = "coffee"): void { SAMPLE_TENANTS.set(tenant, profile); }
export const isSampleTenant = (tenant: string): boolean => SAMPLE_TENANTS.has(tenant);

export const SAMPLE_CONNECTED = ["gmail", "google-calendar", "shopify"] as const;
export const SAMPLE_WORDS = "Sample data for this demo: nothing is read from a real account, and nothing is really sent or booked.";
export const SAMPLE_ACCOUNT = "owner@sample-inbox.example";
const ANCHOR_DOC = "document:sample-shopify-export";

/** A connection as the Your tools page shows it: connected, with the sample line as its message. */
export function sampleView(id: string): ConnectionView {
  const e = entryById(id)!;
  return {
    id, name: e.name, access: e.acts.length ? "read_act" : "read", group: e.group, blurb: e.blurb, reads: e.reads, acts: e.acts,
    state: "connected", message: SAMPLE_WORDS, available: true, extras: id === "gmail" ? ["inbox"] : [],
  };
}

// ---------- the moment the seed ran, and its products ----------

export interface SampleAnchor { timeline: CoffeeTimeline; products: Array<{ id: string; name: string; price: number | null }> }

async function readAnchor(tenant: string, now: () => number): Promise<SampleAnchor> {
  try {
    const g = await openGraph(tenant);
    const [d] = await g.roQuery<{ at: number | null; weeks: number | null; products: string | null }>(
      "MATCH (d:Entity:Document {id:$id}) RETURN d.anchorNow AS at, d.weeks AS weeks, d.products AS products", { id: ANCHOR_DOC });
    if (d && typeof d.at === "number") {
      const products = (() => { try { return JSON.parse(d.products ?? "[]") as SampleAnchor["products"]; } catch { return []; } })();
      return { timeline: coffeeTimeline(d.at, typeof d.weeks === "number" ? d.weeks : 8), products };
    }
  } catch {
    // not seeded yet, or the graph is asleep: the sample answers from now
  }
  return { timeline: coffeeTimeline(now()), products: [] };
}

// ---------- Gmail and Google Calendar ----------

export class SampleCoffeeGoogle implements GoogleApis {
  sent: OutgoingEmail[] = [];
  events: NewEvent[] = [];
  constructor(private anchor: () => Promise<SampleAnchor>) {}
  async accountEmail(): Promise<string | null> { return SAMPLE_ACCOUNT; }
  async freeBusy(_t: string, q: { timeMin: string; timeMax: string }): Promise<BusyBlock[]> {
    return busyBlocks(Date.parse(q.timeMin), Date.parse(q.timeMax));
  }
  async createEvent(_t: string, e: NewEvent): Promise<CreatedEvent> {
    this.events.push(e);
    return { id: `sample-evt-${this.events.length}`, link: `https://calendar.example/sample-evt-${this.events.length}` };
  }
  async sendEmail(_t: string, m: OutgoingEmail): Promise<SentEmail> {
    this.sent.push(m);
    return { id: `sample-msg-${this.sent.length}`, threadId: m.threadId ?? `sample-thr-${this.sent.length}` };
  }
  async searchInbox(_t: string, q: { query: string; max: number }): Promise<InboxMessage[]> {
    const { timeline } = await this.anchor();
    return COFFEE_INBOX.map((m) => ({
      id: m.id, threadId: m.threadId, from: `${m.fromName} <${m.fromEmail}>`, subject: m.subject, date: new Date(sampleAt(timeline, m.key)).toUTCString(), snippet: m.body,
    })).sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).slice(0, Math.max(1, q.max));
  }
  async ga4Properties() { return []; }
  async ga4Report() { return []; }
  async adsCustomers() { return []; }
  async adsCampaigns() { return []; }
}

// ---------- Shopify (Composio's session shape: named read actions) ----------

const TOOLS: ComposioToolInfo[] = [
  { slug: "SHOPIFY_GET_SHOP_DETAILS", name: "Shop details", description: "The store's name and currency (sample store data)." },
  { slug: "SHOPIFY_GET_ORDERS_COUNT", name: "Count orders", description: "How many orders between two dates: created_at_min, created_at_max (ISO). Sample store data." },
  { slug: "SHOPIFY_GET_ORDER_LIST", name: "List orders", description: "Orders between two dates, newest first: created_at_min, created_at_max, limit (at most 250). Each with its payment method, city, refunds. Sample store data." },
  { slug: "SHOPIFY_GET_PRODUCTS", name: "List products", description: "The products and their prices. Sample store data." },
  { slug: "SHOPIFY_GET_ABANDONED_CHECKOUTS", name: "Abandoned checkouts", description: "Checkouts started and not finished between two dates. Sample store data." },
];

const NOTE = "Sample store data for the demo: not the business's real orders.";
const CITY_NAMES = ["Bengaluru", "Delhi", "Mumbai", "Pune", "Hyderabad", "Chennai", "Kolkata", "Gurugram"];

function daysIn(t: CoffeeTimeline, args: Record<string, unknown>): string[] {
  const day = (v: unknown, fallback: string): string => {
    const ms = typeof v === "string" ? Date.parse(v) : NaN;
    return Number.isFinite(ms) ? istDay(ms) : fallback;
  };
  const from = day(args.created_at_min, addDays(t.lastDay, -6));
  const to = day(args.created_at_max, t.lastDay);
  return t.days.filter((d) => d >= from && d <= (to < t.lastDay ? to : t.lastDay));
}

/** The orders of one day, as Shopify would list them: online-store and subscription orders (the apps and wholesale are elsewhere). */
function ordersOf(t: CoffeeTimeline, day: string, products: SampleAnchor["products"]): Array<Record<string, unknown>> {
  const s = storeDay(t, day);
  const out: Array<Record<string, unknown>> = [];
  const methods: Array<[string, number]> = [["upi", s.ordersUpi], ["card", s.ordersCard], ["netbanking", s.ordersOther]];
  const base = Date.parse(`${day}T03:30:00Z`); // 09:00 IST
  let n = 0;
  const titles = products.length ? products : [{ id: "product:sample", name: "Coffee, 250 g (sample product)", price: AOV_INR.online }];
  const push = (gateway: string, source: string) => {
    const p = titles[n % titles.length]!;
    const qty = 1 + (n % 3 === 0 ? 1 : 0);
    const price = p.price ?? AOV_INR.online;
    out.push({
      id: Number(`${day.replace(/-/g, "")}${String(n).padStart(4, "0")}`), name: `#S${day.slice(5).replace("-", "")}-${n + 1}`,
      created_at: new Date(base + Math.floor((n * 13 * 60_000 * 60) / Math.max(1, s.online + s.subscriptions))).toISOString(),
      currency: "INR", total_price: String(price * qty), financial_status: "paid", gateway, source_name: source,
      shipping_address: { city: CITY_NAMES[(n * 7) % CITY_NAMES.length] }, line_items: [{ title: p.name, quantity: qty, price: String(price) }],
      sample: true,
    });
    n++;
  };
  for (const [gateway, count] of methods) for (let i = 0; i < count; i++) push(gateway, "web");
  for (let i = 0; i < s.subscriptions; i++) push(i % 3 === 0 ? "upi_autopay" : "card", "subscription_contract");
  for (let i = 0; i < Math.min(s.refunds, out.length); i++) out[(i * 11) % out.length]!.financial_status = "refunded";
  return out;
}

export function sampleShopifySession(anchor: () => Promise<SampleAnchor>) {
  return {
    toolkit: "shopify",
    async listTools(search?: string): Promise<ComposioToolInfo[]> {
      const q = search?.trim().toLowerCase();
      return q ? TOOLS.filter((x) => `${x.slug} ${x.name} ${x.description}`.toLowerCase().includes(q)) : TOOLS;
    },
    async execute(tool: string, args: Record<string, unknown>): Promise<unknown> {
      const { timeline: t, products } = await anchor();
      switch (tool.toUpperCase()) {
        case "SHOPIFY_GET_SHOP_DETAILS":
          return { shop: { name: "Online store (sample store data)", currency: "INR", timezone: "Asia/Kolkata", note: NOTE }, sample: true };
        case "SHOPIFY_GET_ORDERS_COUNT": {
          const days = daysIn(t, args);
          return { count: days.reduce((a, d) => { const s = storeDay(t, d); return a + s.online + s.subscriptions; }, 0), from: days[0] ?? null, to: days.at(-1) ?? null, sample: true, note: NOTE };
        }
        case "SHOPIFY_GET_ORDER_LIST": {
          const days = daysIn(t, args);
          const limit = Math.max(1, Math.min(250, Number(args.limit) || 50));
          const all = days.flatMap((d) => ordersOf(t, d, products)).reverse();
          return { orders: all.slice(0, limit), total_in_range: all.length, sample: true, note: NOTE };
        }
        case "SHOPIFY_GET_PRODUCTS":
          return { products: products.map((p, i) => ({ id: i + 1, title: p.name, status: "active", variants: [{ price: p.price !== null ? String(p.price) : null }] })), sample: true, note: NOTE };
        case "SHOPIFY_GET_ABANDONED_CHECKOUTS": {
          const days = daysIn(t, args);
          const count = days.reduce((a, d) => a + storeDay(t, d).abandonedCheckouts, 0);
          return { count, by_day: days.map((d) => ({ day: d, abandoned: storeDay(t, d).abandonedCheckouts })), sample: true, note: NOTE };
        }
        default:
          throw new ComposioError(`The sample store has no "${tool.slice(0, 60)}". It has: ${TOOLS.map((x) => x.slug).join(", ")}.`, 400);
      }
    },
  };
}

// ---------- the port ----------

const ports = new Map<string, ConnectionsPort & { apis: SampleCoffeeGoogle }>();

/** The sample connections of a demo business (one per process, so what was "sent" can be read back). */
export function sampleConnections(tenant: string, now: () => number = () => Date.now()): ConnectionsPort & { apis: SampleCoffeeGoogle } {
  const have = ports.get(tenant);
  if (have) return have;
  let cached: Promise<SampleAnchor> | undefined;
  let at = 0;
  // read once a minute at most: a reseed is picked up without a restart
  const anchor = (): Promise<SampleAnchor> => {
    if (!cached || now() - at > 60_000) { cached = readAnchor(tenant, now); at = now(); }
    return cached;
  };
  const apis = new SampleCoffeeGoogle(anchor);
  const shopify = sampleShopifySession(anchor);
  const connected = new Set<string>(SAMPLE_CONNECTED);
  const port: ConnectionsPort & { apis: SampleCoffeeGoogle; sample: true } = {
    tenant, apis, sample: true,
    async status(id: string): Promise<ConnectionStatus> {
      return connected.has(id) ? { state: "connected", message: SAMPLE_WORDS } : { state: "not_connected", message: "Not connected in this demo." };
    },
    async list() { return SAMPLE_CONNECTED.map(sampleView); },
    async note() {
      return `Connected tools of this business, all SAMPLE DATA for the demo (say so whenever you use them; nothing is really sent or booked): Gmail (gmail, a sample inbox), Google Calendar (google-calendar, a sample calendar) and Shopify (shopify, sample store data). Use connections_available to see what you may use.`;
    },
    async run<S, T>(id: string, _op: string, fn: (session: S) => Promise<T>): Promise<T> {
      if (!connected.has(id)) throw new NotConnectedError(id, entryById(id)?.name ?? id, `${entryById(id)?.name ?? id} isn't connected in this demo.`);
      if (id === "shopify") return fn(shopify as unknown as S);
      return fn({ apis, accessToken: "sample", meta: {}, allowed: () => true, account: SAMPLE_ACCOUNT } as unknown as S);
    },
  };
  ports.set(tenant, port);
  return port;
}
