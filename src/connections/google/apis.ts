// The Google services the connections call, as an interface (so every connector and tool is built and tested against a fake,
// tests/helpers/fake-google-apis.ts) and a real implementation made of plain fetch calls. The real one refuses to run under
// vitest, as the OAuth client does. Nothing here logs a token or a message body.
//   Calendar   free/busy, create an event
//   Gmail      send a message; (only when the owner allowed it) search the inbox
//   GA4        list properties (Admin API), run a report (Data API)
//   Google Ads list the accounts the sign-in can reach, run a GAQL query (read only)
import { GoogleApiError, GoogleAuthError, asRecord, failure, realFetch, type FetchFn } from "../../connectors/google/client.js";

export interface BusyBlock { start: string; end: string }
export interface NewEvent {
  summary: string;
  description?: string;
  start: string;            // ISO date-time with offset
  end: string;
  timeZone?: string;
  attendees?: string[];     // email addresses; each gets Google's invitation
}
export interface CreatedEvent { id: string; link?: string }

export interface OutgoingEmail { to: string[]; cc?: string[]; subject: string; body: string; replyToMessageId?: string; threadId?: string }
export interface SentEmail { id: string; threadId?: string }
export interface InboxMessage { id: string; threadId?: string; from: string; subject: string; date: string; snippet: string }

export interface Ga4Property { property: string; displayName: string }
export interface Ga4Query { startDate: string; endDate: string; dimensions: string[]; metrics: string[]; limit: number }
export interface Ga4Row { dimensions: string[]; metrics: number[] }

export interface AdsCustomer { id: string }
export interface AdsCampaignRow { id: string; name: string; status: string; costMicros: number; clicks: number; impressions: number; conversions: number }

export interface GoogleApis {
  accountEmail(accessToken: string): Promise<string | null>;
  freeBusy(accessToken: string, q: { timeMin: string; timeMax: string; timeZone?: string }): Promise<BusyBlock[]>;
  createEvent(accessToken: string, e: NewEvent): Promise<CreatedEvent>;
  sendEmail(accessToken: string, m: OutgoingEmail): Promise<SentEmail>;
  searchInbox(accessToken: string, q: { query: string; max: number }): Promise<InboxMessage[]>;
  ga4Properties(accessToken: string): Promise<Ga4Property[]>;
  ga4Report(accessToken: string, property: string, q: Ga4Query): Promise<Ga4Row[]>;
  adsCustomers(accessToken: string): Promise<AdsCustomer[]>;
  adsCampaigns(accessToken: string, customerId: string, q: { startDate: string; endDate: string }): Promise<AdsCampaignRow[]>;
}

export interface RealApisSettings { adsDeveloperToken?: string; adsLoginCustomerId?: string; adsApiVersion?: string }

const num = (v: unknown): number => { const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN; return Number.isFinite(n) ? n : 0; };
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const clean = (s: string) => s.replace(/[\r\n]+/g, " ").trim(); // a header value can never carry a second header

// A plain-text RFC 2822 message: headers cleaned of line breaks, the subject encoded for non-ASCII, the body as UTF-8 base64.
export function rfc822(m: OutgoingEmail): string {
  const subject = /^[\x20-\x7e]*$/.test(m.subject) ? clean(m.subject) : `=?UTF-8?B?${Buffer.from(clean(m.subject), "utf8").toString("base64")}?=`;
  const lines = [
    `To: ${m.to.map(clean).join(", ")}`,
    ...(m.cc?.length ? [`Cc: ${m.cc.map(clean).join(", ")}`] : []),
    `Subject: ${subject}`,
    ...(m.replyToMessageId ? [`In-Reply-To: ${clean(m.replyToMessageId)}`, `References: ${clean(m.replyToMessageId)}`] : []),
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "",
    (Buffer.from(m.body, "utf8").toString("base64").match(/.{1,76}/g) ?? []).join("\r\n"),
  ];
  return lines.join("\r\n");
}

export function realGoogleApis(s: RealApisSettings = {}, fetchFn: FetchFn = realFetch): GoogleApis {
  const auth = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });
  const json = (token: string, body: unknown, extra: Record<string, string> = {}) =>
    ({ method: "POST", headers: auth(token, { "content-type": "application/json", ...extra }), body: JSON.stringify(body) });
  const ok = async (res: Awaited<ReturnType<FetchFn>>): Promise<Record<string, unknown>> => (res.ok ? asRecord(await res.json()) : failure(res));
  const adsBase = `https://googleads.googleapis.com/${s.adsApiVersion || "v23"}`;
  const adsHeaders = (token: string): Record<string, string> => {
    if (!s.adsDeveloperToken) throw new GoogleApiError("Google Ads is not set up on this server (no developer token).", 503, false);
    return auth(token, { "developer-token": s.adsDeveloperToken, ...(s.adsLoginCustomerId ? { "login-customer-id": s.adsLoginCustomerId.replace(/-/g, "") } : {}) });
  };

  return {
    async accountEmail(token) {
      const res = await fetchFn("https://openidconnect.googleapis.com/v1/userinfo", { headers: auth(token) });
      if (!res.ok) return null;
      const e = asRecord(await res.json()).email;
      return typeof e === "string" ? e : null;
    },
    async freeBusy(token, q) {
      const b = await ok(await fetchFn("https://www.googleapis.com/calendar/v3/freeBusy", json(token, { timeMin: q.timeMin, timeMax: q.timeMax, ...(q.timeZone ? { timeZone: q.timeZone } : {}), items: [{ id: "primary" }] })));
      const cal = asRecord(asRecord(b.calendars).primary);
      if (arr(cal.errors).length) throw new GoogleApiError("Google would not share when this calendar is busy.", 403, false);
      return arr(cal.busy).flatMap((x): BusyBlock[] => { const r = asRecord(x); return str(r.start) && str(r.end) ? [{ start: str(r.start), end: str(r.end) }] : []; });
    },
    async createEvent(token, e) {
      const body = {
        summary: e.summary, ...(e.description ? { description: e.description } : {}),
        start: { dateTime: e.start, ...(e.timeZone ? { timeZone: e.timeZone } : {}) }, end: { dateTime: e.end, ...(e.timeZone ? { timeZone: e.timeZone } : {}) },
        ...(e.attendees?.length ? { attendees: e.attendees.map((email) => ({ email })) } : {}),
      };
      const r = await ok(await fetchFn(`https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=${e.attendees?.length ? "all" : "none"}`, json(token, body)));
      if (!str(r.id)) throw new GoogleApiError("Google did not confirm the event.", 502, true);
      return { id: str(r.id), ...(str(r.htmlLink) ? { link: str(r.htmlLink) } : {}) };
    },
    async sendEmail(token, m) {
      const r = await ok(await fetchFn("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", json(token, { raw: b64url(rfc822(m)), ...(m.threadId ? { threadId: m.threadId } : {}) })));
      if (!str(r.id)) throw new GoogleApiError("Google did not confirm the email.", 502, true);
      return { id: str(r.id), ...(str(r.threadId) ? { threadId: str(r.threadId) } : {}) };
    },
    async searchInbox(token, q) {
      const list = await ok(await fetchFn(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${new URLSearchParams({ q: q.query, maxResults: String(Math.min(q.max, 25)) })}`, { headers: auth(token) }));
      const out: InboxMessage[] = [];
      for (const m of arr(list.messages).slice(0, Math.min(q.max, 25))) {
        const id = str(asRecord(m).id);
        if (!id) continue;
        const r = await ok(await fetchFn(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, { headers: auth(token) }));
        const h = (name: string) => str(arr(asRecord(r.payload).headers).map(asRecord).find((x) => str(x.name).toLowerCase() === name)?.value);
        out.push({ id, ...(str(r.threadId) ? { threadId: str(r.threadId) } : {}), from: h("from"), subject: h("subject"), date: h("date"), snippet: str(r.snippet) });
      }
      return out;
    },
    async ga4Properties(token) {
      const r = await ok(await fetchFn("https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200", { headers: auth(token) }));
      return arr(r.accountSummaries).flatMap((a) => arr(asRecord(a).propertySummaries).flatMap((p): Ga4Property[] => {
        const x = asRecord(p);
        return /^properties\/\d+$/.test(str(x.property)) ? [{ property: str(x.property), displayName: str(x.displayName) || str(x.property) }] : [];
      }));
    },
    async ga4Report(token, property, q) {
      if (!/^properties\/\d+$/.test(property)) throw new GoogleApiError("That is not an analytics property.", 400, false);
      const r = await ok(await fetchFn(`https://analyticsdata.googleapis.com/v1beta/${property}:runReport`, json(token, {
        dateRanges: [{ startDate: q.startDate, endDate: q.endDate }], dimensions: q.dimensions.map((name) => ({ name })), metrics: q.metrics.map((name) => ({ name })), limit: String(q.limit),
      })));
      return arr(r.rows).map((row) => {
        const x = asRecord(row);
        return { dimensions: arr(x.dimensionValues).map((d) => str(asRecord(d).value)), metrics: arr(x.metricValues).map((m) => num(asRecord(m).value)) };
      });
    },
    async adsCustomers(token) {
      const r = await ok(await fetchFn(`${adsBase}/customers:listAccessibleCustomers`, { headers: adsHeaders(token) }));
      return arr(r.resourceNames).flatMap((n): AdsCustomer[] => { const m = /^customers\/(\d+)$/.exec(str(n)); return m ? [{ id: m[1]! }] : []; });
    },
    async adsCampaigns(token, customerId, q) {
      if (!/^\d+$/.test(customerId)) throw new GoogleApiError("That is not an ads account number.", 400, false);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(q.startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(q.endDate)) throw new GoogleApiError("Bad dates.", 400, false);
      const query = `SELECT campaign.id, campaign.name, campaign.status, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions FROM campaign WHERE segments.date BETWEEN '${q.startDate}' AND '${q.endDate}' AND campaign.status != 'REMOVED' ORDER BY metrics.cost_micros DESC LIMIT 100`;
      const r = await ok(await fetchFn(`${adsBase}/customers/${customerId}/googleAds:search`, json(token, { query }, adsHeaders(token))));
      return arr(r.results).map((row) => {
        const x = asRecord(row), c = asRecord(x.campaign), m = asRecord(x.metrics);
        return { id: str(c.id), name: str(c.name), status: str(c.status), costMicros: num(m.costMicros), clicks: num(m.clicks), impressions: num(m.impressions), conversions: num(m.conversions) };
      });
    },
  };
}

export { GoogleApiError, GoogleAuthError };
