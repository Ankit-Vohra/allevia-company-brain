// A fake of the Google services the connections call (Calendar, Gmail, Analytics, Ads). Scripted answers, every call recorded,
// nothing touches the network. Pairs with FakeGoogle (tests/helpers/fake-google.ts), which plays the OAuth side.
import { GoogleApiError, GoogleAuthError } from "../../src/connectors/google/client.js";
import type {
  AdsCampaignRow, AdsCustomer, BusyBlock, CreatedEvent, Ga4Property, Ga4Query, Ga4Row, GoogleApis, InboxMessage, NewEvent, OutgoingEmail, SentEmail,
} from "../../src/connections/google/apis.js";

export interface FakeApisScript {
  account?: string | null;
  busy?: BusyBlock[];
  properties?: Ga4Property[];
  ga4?: (property: string, q: Ga4Query) => Ga4Row[];
  customers?: AdsCustomer[];
  campaigns?: AdsCampaignRow[];
  inbox?: InboxMessage[];
}

export class FakeGoogleApis implements GoogleApis {
  calls: Array<{ op: string; token: string; args: unknown[] }> = [];
  sent: OutgoingEmail[] = [];
  events: NewEvent[] = [];
  failWith: "auth" | "api" | null = null;      // every call fails this way
  authFailuresLeft = 0;                          // the next N calls say "the token was refused", then work
  constructor(public script: FakeApisScript = {}) {}

  private hit(op: string, token: string, ...args: unknown[]): void {
    this.calls.push({ op, token, args });
    if (this.authFailuresLeft > 0) { this.authFailuresLeft--; throw new GoogleAuthError("invalid_token"); }
    if (this.failWith === "auth") throw new GoogleAuthError("invalid_token");
    if (this.failWith === "api") throw new GoogleApiError("Google answered 503.", 503, true);
  }

  async accountEmail(token: string): Promise<string | null> { this.hit("accountEmail", token); return this.script.account === undefined ? "owner@shop.example" : this.script.account; }
  async freeBusy(token: string, q: { timeMin: string; timeMax: string; timeZone?: string }): Promise<BusyBlock[]> { this.hit("freeBusy", token, q); return this.script.busy ?? []; }
  async createEvent(token: string, e: NewEvent): Promise<CreatedEvent> { this.hit("createEvent", token, e); this.events.push(e); return { id: `evt-${this.events.length}`, link: `https://calendar.example/evt-${this.events.length}` }; }
  async sendEmail(token: string, m: OutgoingEmail): Promise<SentEmail> { this.hit("sendEmail", token, { to: m.to, subject: m.subject }); this.sent.push(m); return { id: `msg-${this.sent.length}`, threadId: `thr-${this.sent.length}` }; }
  async searchInbox(token: string, q: { query: string; max: number }): Promise<InboxMessage[]> { this.hit("searchInbox", token, q); return this.script.inbox ?? []; }
  async ga4Properties(token: string): Promise<Ga4Property[]> { this.hit("ga4Properties", token); return this.script.properties ?? []; }
  async ga4Report(token: string, property: string, q: Ga4Query): Promise<Ga4Row[]> { this.hit("ga4Report", token, property, q); return this.script.ga4?.(property, q) ?? []; }
  async adsCustomers(token: string): Promise<AdsCustomer[]> { this.hit("adsCustomers", token); return this.script.customers ?? []; }
  async adsCampaigns(token: string, customerId: string, q: { startDate: string; endDate: string }): Promise<AdsCampaignRow[]> { this.hit("adsCampaigns", token, customerId, q); return this.script.campaigns ?? []; }
}

const day = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

// GA4 rows for a date range, one per day, `sessions` growing with the day of the month so a trend exists.
export function ga4Days(): (property: string, q: Ga4Query) => Ga4Row[] {
  return (_p, q) => {
    const rows: Ga4Row[] = [];
    for (let d = q.startDate; d <= q.endDate; d = day(d, 1)) rows.push({ dimensions: [d.replaceAll("-", "")], metrics: [100 + Number(d.slice(8)), 80 + Number(d.slice(8)), 3] });
    return rows;
  };
}
