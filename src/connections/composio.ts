// Composio is the main path to a business's tools (Gmail, Calendar, Analytics, Search Console, Google Ads, Instagram, Facebook,
// Meta Ads, WhatsApp, Shopify, Stripe, HubSpot, Calendly, Mailchimp, LinkedIn, Slack and the rest of its catalogue), behind the
// same Connector interface as our own Google app. Composio holds those tokens; Allevia stores only the connected-account id,
// sealed per business.
//   entity     each business has an opaque Composio user id derived from its slug and the connector key (not the slug, not an
//              email); the server sets it, a model never does
//   connect    ask Composio for a hosted connect link for that user and toolkit; our callback comes back with a signed state
//   complete   Composio sends the owner back; the account is fetched and must belong to THIS business's user id, be for this
//              toolkit and be active before its id is sealed
//   run        a session for one call: `execute(tool, args)` runs a Composio tool as this business, and only this business;
//              `listTools()` says what the toolkit can do. Google toolkits also carry `apis`, the same Calendar/Gmail/Analytics
//              calls our own Google app offers, so the agents' tools work on either path (Analytics through the read-only proxy).
// Off, and plainly explained, without COMPOSIO_API_KEY. The REST shapes and the tool slugs below follow Composio's v3 API and
// catalogue as known when this was written and have NEVER run against the real service: `connect toolkits` checks the slugs, and
// docs/connections-setup.md lists what to verify first.
import { createHmac } from "node:crypto";
import { entryById, entryByToolkit, TOOLKIT_CATALOG, type ToolkitEntry } from "../../shared/connection-map.js";
import { asRecord, realFetch, type FetchFn } from "../connectors/google/client.js";
import { once } from "./once.js";
import { pickGa4Property, readerFor, type Reader } from "./firstread.js";
import { noteConnection, type ConnectionEvent } from "./graph.js";
import type { GoogleApis } from "./google/apis.js";
import type { GoogleSession } from "./google/product.js";
import {
  ConnectProblem, NeedsAttentionError, NotConfiguredError, NotConnectedError,
  type Availability, type CompleteOutcome, type ConnectionHealth, type ConnectionStatus, type Connector, type ConnectorCtx, type ConnectorInfo, type ConnectStart,
} from "./types.js";

const BASE = "https://backend.composio.dev/api/v3";

export interface ComposioAccount { id: string; status: string; userId: string; toolkit: string }
/** `params` is what Composio says the action takes (its input schema): which arguments it requires and which it knows. */
export interface ComposioToolInfo { slug: string; name: string; description: string; params?: { required: string[]; properties: string[] } }
export interface ComposioToolkitInfo { slug: string; name: string; description: string }

/** One thing the owner pastes to connect a toolkit that has no sign-in page (Composio's connected_account_initiation fields). */
export interface KeyFieldSpec { name: string; label: string; description: string; secret: boolean }
/** One way a toolkit signs in: `mode` is Composio's auth scheme (API_KEY, BEARER_TOKEN, OAUTH2, DCR_OAUTH ...). `needsConfig`: making
 *  an auth config for it needs our own app's details (a client id), which no owner can paste. */
export interface AuthScheme { mode: string; needsConfig: boolean; fields: KeyFieldSpec[]; hint?: string }
/** How a toolkit authenticates: `managed` lists the schemes Composio runs its own app for (OAuth with nothing to set up). */
export interface ToolkitAuth { name: string; managed: string[]; schemes: AuthScheme[]; hint?: string }

export interface ComposioClient {
  /** Finds or makes the auth config for a toolkit: Composio's own app, or (`custom`: an auth scheme) one for keys the owner pastes. */
  authConfigId(toolkit: string, custom?: string): Promise<string>;
  /** How a toolkit signs in (GET /toolkits/{slug}); null when Composio does not know it. */
  authInfo(toolkit: string): Promise<ToolkitAuth | null>;
  /** Makes a connected account from what the owner pasted (an API key). The values go to Composio and nowhere else. */
  createAccount(o: { authConfigId: string; userId: string; scheme: string; values: Record<string, string> }): Promise<{ id: string; status: string }>;
  link(o: { authConfigId: string; userId: string; callbackUrl: string }): Promise<{ redirectUrl: string; accountId: string }>;
  account(id: string): Promise<ComposioAccount | null>;
  deleteAccount(id: string): Promise<void>;
  execute(o: { tool: string; accountId: string; userId: string; args: Record<string, unknown> }): Promise<{ ok: boolean; data: unknown; error?: string }>;
  /** Calls the provider's own API with the connected account's token (Composio's proxy), for what its toolkit has no action for. */
  proxy(o: ProxyRequest & { accountId: string; userId: string }): Promise<ProxyResponse>;
  /** The actions a toolkit offers. */
  tools(toolkit: string, search?: string): Promise<ComposioToolInfo[]>;
  /** Composio's catalogue, searched by words. */
  searchToolkits(query: string): Promise<ComposioToolkitInfo[]>;
  toolkit(slug: string): Promise<ComposioToolkitInfo | null>;
}

/** One call to a provider's API through Composio's proxy. `query` becomes query parameters. */
export interface ProxyRequest { endpoint: string; method: "GET" | "POST"; body?: Record<string, unknown>; query?: Record<string, string> }
/** `status` is the provider's own HTTP status; `data` its JSON answer. */
export interface ProxyResponse { status: number; data: unknown }

export class ComposioError extends Error {
  override name = "ComposioError";
  /** `reason`: Composio's own short explanation, when it gave one; `slug`: its error code (e.g. ConnectedAccount_CredentialValidationRejected). */
  constructor(message: string, readonly status: number, readonly reason?: string, readonly slug?: string) {
    super(message);
  }
}

/** Composio ran the action and the tool itself said it did not work (as opposed to Composio not answering): what the tool refused to do was not done. */
export class ComposioToolError extends ComposioError {
  override name = "ComposioToolError";
}

export function realComposioClient(apiKey: string, fetchFn: FetchFn = realFetch): ComposioClient {
  const call = async (path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetchFn(`${BASE}${path}`, {
      method: init.method ?? "GET", headers: { "x-api-key": apiKey, "content-type": "application/json" },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    let body: Record<string, unknown> = {};
    try { body = asRecord(JSON.parse(await res.text())); } catch { body = {}; }
    if (!res.ok && res.status !== 404) {
      const err = asRecord(body.error);
      if (res.status === 403 && err.slug === "APIKey_InsufficientPermissions") throw new ComposioError("The Composio key does not have the access this needs (it needs write access to auth configs, connected accounts and tool execution). Make a key with full access in Composio and set it as COMPOSIO_API_KEY.", 403);
      const said = typeof err.message === "string" ? err.message.replace(/\s+/g, " ").trim().slice(0, 160) : "";
      throw new ComposioError(`Composio answered ${res.status}.`, res.status, said || undefined, typeof err.slug === "string" ? err.slug : undefined);
    }
    return { status: res.status, body };
  };
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const items = (b: Record<string, unknown>): Record<string, unknown>[] => (Array.isArray(b.items) ? b.items : Array.isArray(b.data) ? b.data : []).map(asRecord);
  return {
    async authConfigId(toolkit, custom) {
      const found = items((await call(`/auth_configs?toolkit_slug=${encodeURIComponent(toolkit)}`)).body).filter((i) => str(i.id) && str(i.status).toUpperCase() !== "DISABLED");
      const scheme = (i: Record<string, unknown>) => (str(i.auth_scheme) || str(i.authScheme)).toUpperCase();
      const have = custom
        ? found.find((i) => scheme(i) === custom.toUpperCase() && i.is_composio_managed !== true)
        : found.find((i) => i.is_composio_managed === true) ?? found[0];
      if (have) return str(have.id);
      const auth_config = custom ? { type: "use_custom_auth", authScheme: custom, credentials: {} } : { type: "use_composio_managed_auth" };
      const made = await call("/auth_configs", { method: "POST", body: { toolkit: { slug: toolkit }, auth_config } });
      const id = str(asRecord(made.body.auth_config).id) || str(made.body.id);
      if (!id) throw new ComposioError("Composio did not make an auth config.", 502);
      return id;
    },
    async authInfo(toolkit) {
      const r = await call(`/toolkits/${encodeURIComponent(toolkit)}`);
      if (r.status === 404) return null;
      const https = (v: unknown) => { const u = str(v); return /^https:\/\/[^\s"<>]+$/.test(u) ? u : undefined; };
      const managed = (Array.isArray(r.body.composio_managed_auth_schemes) ? r.body.composio_managed_auth_schemes : []).filter((x): x is string => typeof x === "string" && !!x).map((x) => x.toUpperCase());
      const schemes = (Array.isArray(r.body.auth_config_details) ? r.body.auth_config_details : []).map(asRecord).map((d): AuthScheme => {
        const fields = asRecord(d.fields);
        const required = (k: string) => { const v = asRecord(fields[k]).required; return Array.isArray(v) ? v.map(asRecord) : []; };
        const hint = https(d.auth_hint_url);
        return {
          mode: str(d.mode).toUpperCase(), needsConfig: required("auth_config_creation").length > 0,
          fields: required("connected_account_initiation").filter((f) => str(f.name)).map((f) => ({
            name: str(f.name), label: (str(f.displayName) || str(f.name)).slice(0, 60), description: str(f.description).slice(0, 300), secret: f.is_secret !== false,
          })),
          ...(hint ? { hint } : {}),
        };
      }).filter((x) => x.mode);
      const hint = https(r.body.auth_guide_url);
      return { name: str(r.body.name) || toolkit, managed, schemes, ...(hint ? { hint } : {}) };
    },
    async createAccount(o) {
      const r = await call("/connected_accounts", {
        method: "POST",
        body: { auth_config: { id: o.authConfigId }, connection: { user_id: o.userId, state: { authScheme: o.scheme, val: { status: "ACTIVE", ...o.values } } } },
      });
      const id = str(r.body.id) || str(asRecord(r.body.connected_account).id);
      if (!id) throw new ComposioError("Composio did not make the connection.", 502);
      return { id, status: str(r.body.status) || str(asRecord(r.body.connectionData).status) };
    },
    async link(o) {
      const r = await call("/connected_accounts/link", { method: "POST", body: { auth_config_id: o.authConfigId, user_id: o.userId, callback_url: o.callbackUrl } });
      const redirectUrl = str(r.body.redirect_url), accountId = str(r.body.connected_account_id);
      if (!redirectUrl || !accountId) throw new ComposioError("Composio did not give a connect link.", 502);
      return { redirectUrl, accountId };
    },
    async account(id) {
      const r = await call(`/connected_accounts/${encodeURIComponent(id)}`);
      if (r.status === 404) return null;
      return { id: str(r.body.id) || id, status: str(r.body.status), userId: str(r.body.user_id) || str(asRecord(r.body.user).id), toolkit: str(asRecord(r.body.toolkit).slug) };
    },
    async deleteAccount(id) {
      await call(`/connected_accounts/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
    async execute(o) {
      const r = await call(`/tools/execute/${encodeURIComponent(o.tool)}`, { method: "POST", body: { connected_account_id: o.accountId, user_id: o.userId, arguments: o.args, version: "latest" } });
      const success = r.body.successful === true || r.body.success === true;
      return { ok: success, data: r.body.data ?? null, ...(success ? {} : { error: str(r.body.error) || "The tool did not work." }) };
    },
    async proxy(o) {
      const parameters = Object.entries(o.query ?? {}).map(([name, value]) => ({ name, value, type: "query" }));
      const r = await call("/tools/execute/proxy", {
        method: "POST",
        body: { endpoint: o.endpoint, method: o.method, connected_account_id: o.accountId, user_id: o.userId, ...(o.body ? { body: o.body } : {}), ...(parameters.length ? { parameters } : {}) },
      });
      if (r.status === 404 && r.body.status === undefined) throw new ComposioError("Composio has no proxy at this address.", 404);
      return { status: typeof r.body.status === "number" ? r.body.status : r.status, data: r.body.data ?? null };
    },
    async tools(toolkit, search) {
      // MCP toolkits (Higgsfield MCP) list and run their tools only at a named version: without it the list is empty and a run is "not found"
      const q = new URLSearchParams({ toolkit_slug: toolkit, toolkit_versions: "latest", limit: "200", ...(search ? { search } : {}) });
      return items((await call(`/tools?${q}`)).body).map((t): ComposioToolInfo => {
        const input = asRecord(t.input_parameters);
        const properties = Object.keys(asRecord(input.properties));
        const required = Array.isArray(input.required) ? input.required.filter((x): x is string => typeof x === "string") : [];
        return { slug: str(t.slug), name: str(t.name), description: str(t.description).slice(0, 240), ...(properties.length || required.length ? { params: { required, properties } } : {}) };
      }).filter((t) => t.slug);
    },
    async searchToolkits(query) {
      const q = new URLSearchParams({ search: query, limit: "20" });
      return items((await call(`/toolkits?${q}`)).body).map((t) => ({ slug: str(t.slug), name: str(t.name) || str(t.slug), description: str(asRecord(t.meta).description) || str(t.description) })).filter((t) => t.slug);
    },
    async toolkit(slug) {
      const r = await call(`/toolkits/${encodeURIComponent(slug)}`);
      return r.status === 404 ? null : { slug: str(r.body.slug) || slug, name: str(r.body.name) || slug, description: str(asRecord(r.body.meta).description) };
    },
  };
}

// ---------- reading or changing: what a tool slug does ----------

const CHANGES = /(CREATE|SEND|POST|DELETE|REMOVE|UPDATE|PATCH|PAUSE|ENABLE|DISABLE|INSERT|ADD|REPLY|PUBLISH|MODIFY|CANCEL|TRASH|MOVE|SET|ARCHIVE|WRITE|UPLOAD|SUBMIT|APPROVE|REFUND|CHARGE|PAY|TRANSFER|BOOK|INVITE|SCHEDULE|FORWARD|DRAFT|COMMENT|LIKE|FOLLOW|SHARE|ASSIGN|MERGE|IMPORT|APPEND|CLEAR|BATCH_UPDATE|SUBSCRIBE|UNSUBSCRIBE|RUN_CAMPAIGN)/;
const READS = /(GET|LIST|FETCH|FIND|SEARCH|READ|QUERY|RETRIEVE|VIEW|LOOKUP|FREE_BUSY|REPORT|COUNT|DESCRIBE|CHECK|ANALYTICS|INSIGHTS|STATS|BALANCE|STATUS|EXPLORE|PRESETS|COSTS|ESTIMATE|WAIT|DISPLAY)/;

/** "read" only when the slug clearly looks up something and clearly changes nothing; everything else waits for the owner's OK. */
export function classifyTool(slug: string): "read" | "act" {
  const s = slug.toUpperCase();
  return READS.test(s) && !CHANGES.test(s) ? "read" : "act";
}

// The proxy reaches a provider's whole API with the owner's token, so it only ever reads: a GET, or a POST to a call that is a
// query by its nature (a report, a search analytics query). Anything else is refused before it leaves Allevia.
const PROXY_READ_POSTS = /(:runReport|:batchRunReports|:runPivotReport|:runRealtimeReport|\/searchAnalytics\/query)$/;

export function proxyIsRead(method: string, endpoint: string): boolean {
  let url: URL;
  try { url = new URL(endpoint); } catch { return false; }
  if (url.protocol !== "https:") return false;
  const m = method.toUpperCase();
  return m === "GET" || (m === "POST" && PROXY_READ_POSTS.test(url.pathname));
}

// ---------- the Google calls on Composio, so the agents' Calendar, Gmail tools work on either path ----------

// Tool slugs for the calls we wrap. UNVERIFIED against the live catalogue (see the header): the agent can always list a
// toolkit's real actions with connection_tools and call them by name.
export const GOOGLE_SLUGS = {
  freeBusy: "GOOGLECALENDAR_FREE_BUSY_QUERY",
  createEvent: "GOOGLECALENDAR_CREATE_EVENT",
  sendEmail: "GMAIL_SEND_EMAIL",
  fetchEmails: "GMAIL_FETCH_EMAILS",
} as const;

const arrAt = (v: unknown, key: string, depth = 0): unknown[] => {
  if (!v || typeof v !== "object" || depth > 5) return [];
  const o = v as Record<string, unknown>;
  if (Array.isArray(o[key])) return o[key] as unknown[];
  for (const x of Object.values(o)) { const r = arrAt(x, key, depth + 1); if (r.length) return r; }
  return [];
};
const firstStr = (v: unknown, keys: string[], depth = 0): string => {
  if (!v || typeof v !== "object" || depth > 5) return "";
  const o = v as Record<string, unknown>;
  for (const k of keys) if (typeof o[k] === "string" && o[k]) return o[k] as string;
  for (const x of Object.values(o)) { const r = firstStr(x, keys, depth + 1); if (r) return r; }
  return "";
};

// Google Analytics has no report action in Composio's toolkit, so its two calls go to Google's own Admin and Data APIs through the
// proxy (read-only by proxyIsRead, audited per call), and answer what our own Google app answers.
const GA4_ADMIN = "https://analyticsadmin.googleapis.com/v1beta";
const GA4_DATA = "https://analyticsdata.googleapis.com/v1beta";
type ProxyFn = (req: ProxyRequest) => Promise<unknown>;

export function composioGa4(proxy: ProxyFn): Pick<GoogleApis, "ga4Properties" | "ga4Report"> {
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const num = (v: unknown): number => { const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN; return Number.isFinite(n) ? n : 0; };
  return {
    async ga4Properties() {
      const r = asRecord(await proxy({ endpoint: `${GA4_ADMIN}/accountSummaries`, method: "GET", query: { pageSize: "200" } }));
      return arr(r.accountSummaries).flatMap((a) => arr(asRecord(a).propertySummaries).flatMap((p) => {
        const x = asRecord(p);
        return /^properties\/\d+$/.test(str(x.property)) ? [{ property: str(x.property), displayName: str(x.displayName) || str(x.property) }] : [];
      }));
    },
    async ga4Report(_t, property, q) {
      if (!/^properties\/\d+$/.test(property)) throw new ComposioError("That is not an analytics property.", 400);
      const r = asRecord(await proxy({
        endpoint: `${GA4_DATA}/${property}:runReport`, method: "POST",
        body: { dateRanges: [{ startDate: q.startDate, endDate: q.endDate }], dimensions: q.dimensions.map((name) => ({ name })), metrics: q.metrics.map((name) => ({ name })), limit: String(q.limit) },
      }));
      return arr(r.rows).map((row) => {
        const x = asRecord(row);
        return { dimensions: arr(x.dimensionValues).map((d) => str(asRecord(d).value)), metrics: arr(x.metricValues).map((m) => num(asRecord(m).value)) };
      });
    },
  };
}

/** `proxy` is given for Google Analytics: its calls then go through the proxy (composioGa4). */
export function composioGoogleApis(execute: (tool: string, args: Record<string, unknown>) => Promise<unknown>, proxy?: ProxyFn): GoogleApis {
  const unsupported = (what: string) => async (): Promise<never> => { throw new ComposioError(`${what} is not wrapped on this path: list the toolkit's actions with connection_tools and call one by name.`, 501); };
  return {
    accountEmail: async () => null,
    async freeBusy(_t, q) {
      const d = await execute(GOOGLE_SLUGS.freeBusy, { timeMin: q.timeMin, timeMax: q.timeMax, ...(q.timeZone ? { timeZone: q.timeZone } : {}), items: [{ id: "primary" }] });
      return arrAt(d, "busy").flatMap((b) => { const r = asRecord(b); return typeof r.start === "string" && typeof r.end === "string" ? [{ start: r.start, end: r.end }] : []; });
    },
    async createEvent(_t, e) {
      const minutes = Math.max(1, Math.round((Date.parse(e.end) - Date.parse(e.start)) / 60_000));
      // Composio wants a naive local time and a zone: the instant is sent as UTC, which every calendar shows in its own zone
      const d = await execute(GOOGLE_SLUGS.createEvent, {
        summary: e.summary, start_datetime: new Date(Date.parse(e.start)).toISOString().slice(0, 19), timezone: "UTC", event_duration_hour: Math.floor(minutes / 60), event_duration_minutes: minutes % 60,
        ...(e.description ? { description: e.description } : {}), ...(e.attendees?.length ? { attendees: e.attendees, send_updates: "all" } : {}),
      });
      const id = firstStr(d, ["id", "event_id"]);
      if (!id) throw new ComposioError("Google did not confirm the event.", 502);
      return { id, ...(firstStr(d, ["htmlLink", "html_link"]) ? { link: firstStr(d, ["htmlLink", "html_link"]) } : {}) };
    },
    async sendEmail(_t, m) {
      const d = await execute(GOOGLE_SLUGS.sendEmail, {
        recipient_email: m.to[0], ...(m.to.length > 1 ? { extra_recipients: m.to.slice(1) } : {}), ...(m.cc?.length ? { cc: m.cc } : {}), subject: m.subject, body: m.body, is_html: false,
      });
      const id = firstStr(d, ["id", "message_id", "messageId"]);
      if (!id) throw new ComposioError("Google did not confirm the email.", 502);
      return { id, ...(firstStr(d, ["threadId", "thread_id"]) ? { threadId: firstStr(d, ["threadId", "thread_id"]) } : {}) };
    },
    async searchInbox(_t, q) {
      const d = await execute(GOOGLE_SLUGS.fetchEmails, { query: q.query, max_results: Math.min(q.max, 25) });
      return arrAt(d, "messages").slice(0, q.max).map((m) => {
        const r = asRecord(m);
        return { id: firstStr(r, ["messageId", "id"]), from: firstStr(r, ["sender", "from"]), subject: firstStr(r, ["subject"]), date: firstStr(r, ["messageTimestamp", "date"]), snippet: firstStr(r, ["preview", "snippet", "messageText"]).slice(0, 300) };
      });
    },
    ...(proxy ? composioGa4(proxy) : { ga4Properties: unsupported("Listing analytics properties"), ga4Report: unsupported("An analytics report") }),
    adsCustomers: unsupported("Listing ads accounts"), adsCampaigns: unsupported("An ads report"),
  };
}

// Search Console through Composio: the owner's first verified site, then the search analytics query.
interface SearchQuery { startDate: string; endDate: string; dimensions: Array<"date" | "page" | "query">; rowLimit?: number }
async function searchConsoleQuery(execute: (tool: string, args: Record<string, unknown>) => Promise<unknown>, q: SearchQuery) {
  const sites = arrAt(await execute("GOOGLE_SEARCH_CONSOLE_LIST_SITES", {}), "siteEntry").map(asRecord).filter((s) => typeof s.siteUrl === "string" && s.permissionLevel !== "siteUnverifiedUser");
  const site = (sites.find((s) => String(s.siteUrl).startsWith("sc-domain:")) ?? sites[0])?.siteUrl;
  if (typeof site !== "string") throw new ComposioError("No site in Search Console for this account.", 404);
  const d = await execute("GOOGLE_SEARCH_CONSOLE_SEARCH_ANALYTICS_QUERY", { site_url: site, start_date: q.startDate, end_date: q.endDate, dimensions: q.dimensions, row_limit: q.rowLimit ?? 25 });
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return arrAt(d, "rows").map(asRecord).flatMap((r) => (Array.isArray(r.keys) ? [{ keys: r.keys.map(String), clicks: n(r.clicks), impressions: n(r.impressions), ctr: n(r.ctr), position: n(r.position) }] : []));
}

// ---------- connectors ----------

export interface ComposioDeps { apiKey: string; client: ComposioClient | null; connectorKey: string }

/** The opaque Composio user id for one business. */
export function composioUserId(connectorKey: string, tenant: string): string {
  return `al_${createHmac("sha256", connectorKey).update(`composio-user\u0000${tenant}`).digest("hex").slice(0, 24)}`;
}

/** `name`: the tool's own name as Composio gives it (for a tool found by search). Never a key: a key the owner pasted went to Composio only. */
interface Stored { accountId: string; userId: string; at: number; headline?: string; readAt?: number; property?: string; name?: string }

// ---------- tools connected with a key the owner pastes ----------

/** Schemes where the owner signs in on the provider's own page; everything else (API_KEY, BEARER_TOKEN, BASIC ...) is pasted. */
const SIGN_IN = /OAUTH/;
const KEY_ORDER = ["API_KEY", "BEARER_TOKEN"];

/** The scheme an owner can connect by pasting a key: one that needs nothing of ours set up first, API keys first. */
export function keyScheme(a: ToolkitAuth): AuthScheme | undefined {
  const ok = a.schemes.filter((s) => !SIGN_IN.test(s.mode) && !s.needsConfig && s.mode !== "NO_AUTH");
  return [...ok].sort((x, y) => rank(x.mode) - rank(y.mode))[0];
}
const rank = (m: string) => { const i = KEY_ORDER.indexOf(m); return i < 0 ? KEY_ORDER.length : i; };
/** The fields to paste for a scheme; a key scheme with none listed takes one API key. */
const keyFields = (s: AuthScheme): KeyFieldSpec[] => (s.fields.length ? s.fields : [{ name: s.mode === "BEARER_TOKEN" ? "token" : "generic_api_key", label: s.mode === "BEARER_TOKEN" ? "Token" : "API key", description: "", secret: true }]);

// The check right after a key is pasted: a harmless read (a balance, the credits left, who the key belongs to) so the owner sees it works.
const CHECK_FIRST = /(BALANCE|CREDIT)/;
const CHECK_NEXT = /(GET_ME\b|_ME$|CURRENT_USER|WHOAMI|GET_USER|GET_ACCOUNT|ACCOUNT_INFO|PROFILE)/;
const AMOUNT_KEYS = ["credits_left", "remaining_credits", "available_credits", "credit_balance", "credits", "balance", "remaining"];

function amountIn(v: unknown, depth = 0): { key: string; n: number } | null {
  if (!v || typeof v !== "object" || depth > 5) return null;
  const o = v as Record<string, unknown>;
  for (const k of AMOUNT_KEYS) {
    const x = o[k];
    const n = typeof x === "number" ? x : typeof x === "string" && x.trim() !== "" ? Number(x) : NaN;
    if (Number.isFinite(n)) return { key: k, n };
  }
  for (const x of Object.values(o)) { const r = amountIn(x, depth + 1); if (r) return r; }
  return null;
}

/** "1,200 credits left" from what a balance tool answered; undefined when it carries no amount. */
export function checkHeadline(tool: string, data: unknown): string | undefined {
  const a = amountIn(data);
  if (!a) return undefined;
  const n = a.n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return /credit/i.test(a.key) || /CREDIT/.test(tool.toUpperCase()) ? `${n} ${a.n === 1 ? "credit" : "credits"} left` : `balance ${n}`;
}

/** Composio's own words, short, with anything the owner pasted taken out. */
function shortReason(e: ComposioError, secrets: string[]): string {
  let why = (e.reason ?? "").replace(/\s+/g, " ").trim();
  for (const s of secrets) if (s.length >= 4) why = why.split(s).join("…");
  why = why.replace(/[.\s]+$/, "").slice(0, 140);
  if (!why) return `it answered ${e.status}`;
  return /^[A-Z][a-z]/.test(why) ? why.charAt(0).toLowerCase() + why.slice(1) : why; // "Invalid key" -> "invalid key", "API key ..." stays
}
const CREDITS_SEEN = new Map<string, { at: number; credits: number }>();

export const COMPOSIO_OFF_WORDS = (what: string) => `Connecting ${what} isn't switched on yet. Your team is setting up the connection service and will let you know when it's ready.`;

export interface ComposioSession {
  execute(tool: string, args: Record<string, unknown>): Promise<unknown>;
  /** A read-only call to the provider's own API with this business's connected account (proxyIsRead); answers its JSON. */
  proxy(req: ProxyRequest): Promise<unknown>;
  listTools(search?: string): Promise<ComposioToolInfo[]>;
  toolkit: string;
  /** Google Analytics only: the property to read (the one the daily read found for this business, else picked now). */
  ga4Property?: () => Promise<string | null>;
  // present for the Google toolkits: the same session shape the own-Google path gives
  apis?: GoogleApis;
  accessToken?: string;
  meta?: Readonly<Record<string, string>>;
  allowed?: (scope: string) => boolean;
}

export function infoOf(e: ToolkitEntry): ConnectorInfo {
  return { id: e.id, name: e.name, group: e.group, provider: "composio", blurb: e.blurb, reads: e.reads, acts: e.acts, capabilities: e.capabilities as ConnectorInfo["capabilities"] };
}

export class ComposioConnector implements Connector {
  /** A tool found by search takes Composio's own name for it ("Higgsfield") once Composio has said it. */
  info: ConnectorInfo;
  /** The daily read (and the first one, right after connecting), for toolkits that have a reader (firstread.ts). A tool found by
   *  search has the harmless check instead (a balance, the credits left), so "Read now" says how it stands. */
  readonly pull?: (ctx: ConnectorCtx) => Promise<{ ok: boolean; message: string }>;
  constructor(readonly entry: ToolkitEntry, private deps: ComposioDeps) {
    this.info = infoOf(entry);
    const reader = readerFor(entry);
    if (reader) this.pull = (ctx) => once(`${ctx.tenant}\u0000${entry.id}`, () => this.readNow(ctx, reader));
    else if (this.dynamic) this.pull = (ctx) => once(`${ctx.tenant}\u0000${entry.id}`, () => this.checkNow(ctx));
  }

  private get dynamic(): boolean { return this.entry.id.startsWith("app-"); }
  private named(name: string | undefined): void {
    if (this.dynamic && name && name !== this.info.name) this.info = { ...this.info, name: name.slice(0, 60) };
  }

  // How this toolkit signs in, asked once per server run (a failure is not kept, so the next try asks again).
  private authAsked?: Promise<ToolkitAuth | null>;
  private async auth(): Promise<ToolkitAuth | null> {
    this.authAsked ??= this.client().authInfo(this.entry.toolkit).then((a) => { this.named(a?.name); return a; });
    try { return await this.authAsked; } catch (e) { this.authAsked = undefined; throw e; }
  }

  /** Any failure while connecting, as one sentence the owner reads on the card. Values the owner pasted never appear in it. */
  private problem(e: unknown, secrets: string[] = []): Error {
    if (e instanceof ConnectProblem || e instanceof NotConfiguredError || e instanceof NotConnectedError) return e;
    const name = this.info.name;
    if (e instanceof ComposioError) {
      if (e.slug === "ConnectedAccount_CredentialValidationRejected" || (secrets.length && (e.status === 401 || e.status === 403) && e.slug?.startsWith("ConnectedAccount"))) {
        return new ConnectProblem(this.info.id, `${name} didn't accept that key. Check it and paste it again.`, 422);
      }
      if (e.status === 403 && e.slug === "APIKey_InsufficientPermissions") {
        return new NotConfiguredError(this.info.id, { ok: false, message: COMPOSIO_OFF_WORDS(name), missing: [{ setting: "COMPOSIO_API_KEY", words: e.message }] });
      }
      return new ConnectProblem(this.info.id, `Composio couldn't set up ${name}: ${shortReason(e, secrets)}.`);
    }
    return new ConnectProblem(this.info.id, `Composio couldn't set up ${name}: it didn't answer. Try again in a minute.`);
  }

  private async readNow(ctx: ConnectorCtx, reader: Reader): Promise<{ ok: boolean; message: string }> {
    try {
      const first = await this.run(ctx, (s) => reader(s.execute, ctx, s.proxy));
      const r = await this.stored(ctx);
      if (r) await ctx.vault.put(ctx.tenant, this.info.id, { ...r, readAt: ctx.now(), ...(first.headline ? { headline: first.headline } : {}), ...(first.property ? { property: first.property } : {}) } satisfies Stored);
      return first.headline ? { ok: true, message: first.headline } : { ok: false, message: `${this.info.name} is connected, but there was nothing to read yet.` };
    } catch (e) {
      if (e instanceof NotConnectedError || e instanceof NeedsAttentionError) return { ok: false, message: e.words };
      return { ok: false, message: `${this.info.name} is busy or slow right now. We will try again tomorrow.` };
    }
  }

  availability(): Availability {
    const missing = [
      ...(this.deps.apiKey ? [] : [{ setting: "COMPOSIO_API_KEY", words: "the key for Allevia's connection service (Composio)" }]),
      ...(this.deps.connectorKey.length >= 32 ? [] : [{ setting: "ALLEVIA_CONNECTOR_KEY", words: "the key that locks stored connections (at least 32 characters)" }]),
    ];
    return missing.length ? { ok: false, message: COMPOSIO_OFF_WORDS(this.info.name), missing } : { ok: true, message: "", missing: [] };
  }

  private client(): ComposioClient {
    if (!this.deps.client) throw new NotConnectedError(this.info.id, this.info.name, COMPOSIO_OFF_WORDS(this.info.name));
    return this.deps.client;
  }
  private stored(ctx: ConnectorCtx): Promise<Stored | null> { return ctx.vault.get(ctx.tenant, this.info.id) as Promise<Stored | null>; }
  private user(ctx: ConnectorCtx): string { return composioUserId(this.deps.connectorKey, ctx.tenant); }

  // The graph learns of the change: the System's status (a Version each time), when and by whom, and the edges around it
  // (src/connections/graph.ts). A failure here is said in words and never stops a connection; the ladder catches up on its next sync.
  private markSystem(ctx: ConnectorCtx, event: ConnectionEvent, extra: Record<string, string | null> = {}): Promise<string[]> {
    return noteConnection(ctx, { id: this.info.id, system: this.entry.system, provider: "composio" }, event, extra);
  }

  async status(ctx: ConnectorCtx): Promise<ConnectionStatus> {
    const r = await this.stored(ctx);
    if (!r) return { state: "not_connected", message: this.info.blurb };
    this.named(r.name);
    if (r.userId !== this.user(ctx)) return { state: "needs_attention", message: `We can't use the saved ${this.info.name} connection any more. Connect it again.` };
    const left = this.entry.toolkit === "higgsfield_mcp" ? await this.creditsLeft(ctx, r) : undefined;
    const message = r.headline ? `${this.info.name} connected: ${r.headline}.` : left !== undefined ? `${this.info.name} is connected: ${Math.floor(left).toLocaleString("en-US")} credits left.` : `${this.info.name} is connected.`;
    return { state: "connected", message, lastReadAt: new Date(r.readAt ?? r.at).toISOString() };
  }

  // The connected Higgsfield's credits left, for its line on Your tools: read at most every 5 minutes, never waited on long.
  private async creditsLeft(ctx: ConnectorCtx, r: Stored): Promise<number | undefined> {
    const key = `${ctx.tenant}\u0000${r.accountId}`;
    const hit = CREDITS_SEEN.get(key);
    if (hit && ctx.now() - hit.at < 300_000) return hit.credits;
    const client = this.deps.client;
    if (!client) return undefined;
    const read = client.execute({ tool: "HIGGSFIELD_MCP_BALANCE", accountId: r.accountId, userId: r.userId, args: {} })
      .then((o) => { const c = o.ok ? (o.data as { credits?: unknown } | null)?.credits : undefined; return typeof c === "number" && Number.isFinite(c) ? c : undefined; })
      .catch(() => undefined);
    const credits = await Promise.race([read, new Promise<undefined>((res) => setTimeout(() => res(undefined), 4000).unref?.())]);
    if (credits !== undefined) CREDITS_SEEN.set(key, { at: ctx.now(), credits });
    return credits;
  }

  // Connecting, three ways, by how the toolkit signs in (Composio's GET /toolkits/{slug}):
  //   Composio runs a sign-in app for it        the owner goes to Composio's hosted page (as before)
  //   it takes a key (API_KEY, BEARER_TOKEN...)  the web app opens the paste-your-key sheet; connectWithKey finishes it
  //   a sign-in needing nothing of ours set up  an auth config of our own for that scheme, then the hosted page
  // Anything else is said plainly: it needs its own app registered first.
  async connect(ctx: ConnectorCtx): Promise<ConnectStart> {
    try {
      const a = await this.auth();
      if (!a) throw new ConnectProblem(this.info.id, `Composio doesn't know ${this.info.name} any more, so it can't be connected.`);
      if (!a.managed.length) {
        const key = keyScheme(a);
        if (key) {
          return {
            url: `${ctx.webBaseUrl}/connections?${new URLSearchParams({ connect: this.info.id })}`,
            key: { tool: this.info.name, fields: keyFields(key).map((f) => ({ name: f.name, label: f.label, ...(f.description ? { help: f.description } : {}), secret: f.secret })), ...(key.hint ?? a.hint ? { hint: key.hint ?? a.hint } : {}) },
          };
        }
        const own = a.schemes.find((s) => SIGN_IN.test(s.mode) && !s.needsConfig);
        if (!own) throw new ConnectProblem(this.info.id, `Composio couldn't set up ${this.info.name}: it needs its own sign-in app registered first, which your team has to do.`);
        return await this.hosted(ctx, await this.client().authConfigId(this.entry.toolkit, own.mode));
      }
      return await this.hosted(ctx, await this.client().authConfigId(this.entry.toolkit));
    } catch (e) {
      throw this.problem(e);
    }
  }

  private async hosted(ctx: ConnectorCtx, authConfigId: string): Promise<ConnectStart> {
    const state = ctx.beginAuth({});
    const callbackUrl = `${ctx.webBaseUrl}/api/connectors/google/callback?${new URLSearchParams({ state })}`; // one callback address for every provider
    const l = await this.client().link({ authConfigId, userId: this.user(ctx), callbackUrl });
    return { url: l.redirectUrl };
  }

  /** The owner pasted a key on the sheet: it goes to Composio, which keeps it; only the connected account's id is sealed here. */
  async connectWithKey(ctx: ConnectorCtx, values: Record<string, string>): Promise<{ message: string }> {
    const pasted = Object.values(values).filter((v) => typeof v === "string" && v.length > 0);
    try {
      const a = await this.auth();
      const scheme = a && !a.managed.length ? keyScheme(a) : undefined;
      if (!scheme) throw new ConnectProblem(this.info.id, `${this.info.name} doesn't take a key here. Tap Connect and sign in instead.`);
      const fields = keyFields(scheme);
      const clean: Record<string, string> = {};
      for (const f of fields) {
        const v = (values[f.name] ?? "").trim();
        if (!v) throw new ConnectProblem(this.info.id, `${this.info.name} needs your ${fields.length === 1 ? "API key" : f.label}.`);
        if (v.length > 2000 || /[\r\n\0]/.test(v)) throw new ConnectProblem(this.info.id, `That doesn't look like a ${this.info.name} key. Copy it again and paste just the key.`);
        clean[f.name] = v;
      }
      const client = this.client();
      const userId = this.user(ctx);
      const authConfigId = await client.authConfigId(this.entry.toolkit, scheme.mode);
      const made = await client.createAccount({ authConfigId, userId, scheme: scheme.mode, values: clean });
      // the account must be this business's own, for this toolkit, and active before its id is kept
      const acct = made.status.toUpperCase() === "ACTIVE" ? { id: made.id, userId, toolkit: this.entry.toolkit, status: "ACTIVE" } : await client.account(made.id);
      if (!acct || acct.userId !== userId || acct.toolkit.toLowerCase() !== this.entry.toolkit || acct.status.toUpperCase() !== "ACTIVE") {
        await client.deleteAccount(made.id).catch(() => undefined);
        throw new ConnectProblem(this.info.id, `${this.info.name} didn't accept that key. Check it and paste it again.`, 422);
      }
      await ctx.vault.put(ctx.tenant, this.info.id, { accountId: made.id, userId, at: ctx.now(), ...(this.dynamic ? { name: this.info.name } : {}) } satisfies Stored);
    } catch (e) {
      throw this.problem(e, pasted);
    }
    await this.markSystem(ctx, "connected");
    if (this.pull) await this.pull(ctx).catch(() => undefined); // the harmless read, so the card says it works
    return { message: (await this.status(ctx)).message };
  }

  /** "Read now" (and the check right after connecting) for a tool found by search: one harmless read, its line kept with the connection. */
  private async checkNow(ctx: ConnectorCtx): Promise<{ ok: boolean; message: string }> {
    try {
      const headline = await this.run(ctx, async (s) => {
        const tools = (await s.listTools()).filter((t) => classifyTool(t.slug) === "read" && !t.params?.required.length);
        const pick = tools.find((t) => CHECK_FIRST.test(t.slug.toUpperCase())) ?? tools.find((t) => CHECK_NEXT.test(t.slug.toUpperCase()));
        if (!pick) return undefined;
        return checkHeadline(pick.slug, await s.execute(pick.slug, {})) ?? "";
      });
      const r = await this.stored(ctx);
      if (r && headline !== undefined) await ctx.vault.put(ctx.tenant, this.info.id, { ...r, readAt: ctx.now(), ...(headline ? { headline } : {}) } satisfies Stored);
      await ctx.audit("check read", headline !== undefined, headline === undefined ? "no harmless read for this tool" : undefined);
      return headline ? { ok: true, message: `${this.info.name} connected: ${headline}.` } : { ok: true, message: `${this.info.name} is connected.` };
    } catch (e) {
      if (e instanceof NotConnectedError || e instanceof NeedsAttentionError) return { ok: false, message: e.words };
      await ctx.audit("check read", false, e instanceof ComposioToolError ? "the tool said no" : "failed");
      return { ok: false, message: `${this.info.name} is connected, but it didn't answer just now.` };
    }
  }

  async complete(ctx: ConnectorCtx, params: Record<string, string>): Promise<CompleteOutcome> {
    if (params.status && params.status !== "success") return { result: "denied" };
    const id = params.connected_account_id || params.connectedAccountId;
    if (!id) return { result: "problem", reason: "no_account" };
    const acct = await this.client().account(id);
    // the account must be this business's own, for this toolkit, and active: never take an id on the word of the address bar
    if (!acct || acct.userId !== this.user(ctx) || acct.toolkit.toLowerCase() !== this.entry.toolkit || acct.status.toUpperCase() !== "ACTIVE") return { result: "problem", reason: "not_active" };
    await ctx.vault.put(ctx.tenant, this.info.id, { accountId: acct.id, userId: acct.userId, at: ctx.now() } satisfies Stored);
    await this.markSystem(ctx, "connected");
    if (this.pull) void this.pull(ctx).catch(() => undefined); // the first numbers, straight away; the daily read repeats it
    return { result: "connected" };
  }

  async disconnect(ctx: ConnectorCtx): Promise<void> {
    const r = await this.stored(ctx).catch(() => null);
    if (r && this.deps.client) await this.deps.client.deleteAccount(r.accountId).catch(() => undefined);
    await ctx.vault.delete(ctx.tenant, this.info.id);
    await this.markSystem(ctx, "disconnected");
  }

  async health(ctx: ConnectorCtx): Promise<ConnectionHealth> {
    const r = await this.stored(ctx).catch(() => null);
    if (!r) return { ok: false, message: `${this.info.name} isn't connected.` };
    const a = await this.client().account(r.accountId);
    if (a && a.userId === this.user(ctx) && a.status.toUpperCase() === "ACTIVE") return { ok: true, message: `${this.info.name} still answers.` };
    await this.markSystem(ctx, "expired", { lastError: "The connection service no longer accepts the saved access" }); // the ladder drops a rung, and the graph keeps when it stopped
    return { ok: false, message: `${this.info.name} stopped letting us in. Connect it again.` };
  }

  // The Analytics property picked for a live report is kept with the connection, so the next report reads the same one at once.
  private async keepProperty(ctx: ConnectorCtx, r: Stored, property: string | null): Promise<string | null> {
    if (property) await ctx.vault.put(ctx.tenant, this.info.id, { ...r, property } satisfies Stored).catch(() => undefined);
    return property;
  }

  /** A session for one call: runs Composio tools as this business, and only this business. */
  async run<T>(ctx: ConnectorCtx, fn: (s: ComposioSession & GoogleSession) => Promise<T>): Promise<T> {
    const r = await this.stored(ctx).catch(() => { throw new NeedsAttentionError(this.info.id, this.info.name, `We can't open the saved ${this.info.name} connection. Ask the owner to connect it again.`); });
    if (!r) throw new NotConnectedError(this.info.id, this.info.name, `${this.info.name} isn't connected yet. Ask the owner to connect it: open Connections in Allevia and tap Connect ${this.info.name}.`);
    if (r.userId !== this.user(ctx)) throw new NeedsAttentionError(this.info.id, this.info.name, `${this.info.name} is not set up for this business. Ask the owner to connect it again.`);
    const client = this.client();
    const execute = async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
      const out = await client.execute({ tool, accountId: r.accountId, userId: r.userId, args });
      if (!out.ok) throw new ComposioToolError(out.error ?? "The tool did not work.", 502);
      return out.data;
    };
    const proxy = async (req: ProxyRequest): Promise<unknown> => {
      const where = (() => { try { const u = new URL(req.endpoint); return `${u.host.split(".")[0]}${u.pathname.replace(/^\/v\d+\w*(?=\/)/, "")}`; } catch { return "a bad address"; } })();
      const op = `proxy ${req.method} ${where}`;
      if (!proxyIsRead(req.method, req.endpoint)) {
        await ctx.audit(op, false, "refused: the proxy only reads");
        throw new ComposioError(`${this.info.name} can only be read this way.`, 403);
      }
      let out: ProxyResponse;
      try {
        out = await client.proxy({ ...req, accountId: r.accountId, userId: r.userId });
      } catch (e) {
        await ctx.audit(op, false, e instanceof Error ? e.message : "failed");
        throw e;
      }
      const ok = out.status >= 200 && out.status < 300;
      await ctx.audit(op, ok, ok ? undefined : `answered ${out.status}`);
      if (!ok) throw new ComposioToolError(`${this.info.name} answered ${out.status}.`, out.status);
      return out.data;
    };
    const ga4 = this.entry.toolkit === "google_analytics";
    return fn({
      toolkit: this.entry.toolkit, execute, proxy, listTools: (q) => client.tools(this.entry.toolkit, q),
      apis: composioGoogleApis(execute, ga4 ? proxy : undefined), accessToken: "composio", allowed: () => true,
      meta: ga4 && r.property ? { selected: r.property } : {},
      ...(ga4 ? { ga4Property: async () => r.property ?? this.keepProperty(ctx, r, (await pickGa4Property(proxy, ctx))?.property ?? null) } : {}),
      ...(this.entry.toolkit === "google_search_console" ? { query: (q: SearchQuery) => searchConsoleQuery(execute, q) } : {}),
    } as ComposioSession & GoogleSession);
  }
}

export function composioConnectors(deps: ComposioDeps, only?: (e: ToolkitEntry) => boolean): ComposioConnector[] {
  return TOOLKIT_CATALOG.filter((e) => !only || only(e)).map((e) => new ComposioConnector(e, deps));
}

/** Any toolkit in Composio's catalogue, not just ours: its connection id is `app-<slug>`. */
export const DYNAMIC_SLUG = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
export function dynamicEntry(slug: string, name: string, description: string): ToolkitEntry {
  const known = entryByToolkit(slug);
  if (known) return known;
  return {
    id: `app-${slug}`, toolkit: slug, name, group: "team",
    blurb: description ? `Your team can use ${name}: ${description.replace(/\s+/g, " ").slice(0, 110)}` : `Your team can use ${name}.`, reads: [`What you let it read in ${name}.`], acts: [`Changes in ${name} only after you say OK.`],
    recommended: null, fits: [], departments: ["leadership", "ops"], capabilities: [], system: { id: `system:app-${slug}`, name },
  };
}

export { entryById };
