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
//              calls our own Google app offers, so the agents' tools work on either path.
// Off, and plainly explained, without COMPOSIO_API_KEY. The REST shapes and the tool slugs below follow Composio's v3 API and
// catalogue as known when this was written and have NEVER run against the real service: `connect toolkits` checks the slugs, and
// docs/connections-setup.md lists what to verify first.
import { createHmac } from "node:crypto";
import { entryById, entryByToolkit, TOOLKIT_CATALOG, type ToolkitEntry } from "../../shared/connection-map.js";
import { asRecord, realFetch, type FetchFn } from "../connectors/google/client.js";
import { once } from "./once.js";
import { readerFor, type Reader } from "./firstread.js";
import { noteConnection, type ConnectionEvent } from "./graph.js";
import type { GoogleApis } from "./google/apis.js";
import type { GoogleSession } from "./google/product.js";
import {
  NeedsAttentionError, NotConfiguredError, NotConnectedError,
  type Availability, type CompleteOutcome, type ConnectionHealth, type ConnectionStatus, type Connector, type ConnectorCtx, type ConnectorInfo, type ConnectStart,
} from "./types.js";

const BASE = "https://backend.composio.dev/api/v3";

export interface ComposioAccount { id: string; status: string; userId: string; toolkit: string }
/** `params` is what Composio says the action takes (its input schema): which arguments it requires and which it knows. */
export interface ComposioToolInfo { slug: string; name: string; description: string; params?: { required: string[]; properties: string[] } }
export interface ComposioToolkitInfo { slug: string; name: string; description: string }

export interface ComposioClient {
  /** Finds or makes the auth config for a toolkit (Composio's own app until ours is approved). */
  authConfigId(toolkit: string): Promise<string>;
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
  constructor(message: string, readonly status: number) {
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
      throw new ComposioError(`Composio answered ${res.status}.`, res.status);
    }
    return { status: res.status, body };
  };
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const items = (b: Record<string, unknown>): Record<string, unknown>[] => (Array.isArray(b.items) ? b.items : Array.isArray(b.data) ? b.data : []).map(asRecord);
  return {
    async authConfigId(toolkit) {
      const found = await call(`/auth_configs?toolkit_slug=${encodeURIComponent(toolkit)}`);
      const first = items(found.body).find((i) => str(i.id));
      if (first) return str(first.id);
      const made = await call("/auth_configs", { method: "POST", body: { toolkit: { slug: toolkit }, auth_config: { type: "use_composio_managed_auth" } } });
      const id = str(asRecord(made.body.auth_config).id) || str(made.body.id);
      if (!id) throw new ComposioError("Composio did not make an auth config.", 502);
      return id;
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
      const r = await call(`/tools/execute/${encodeURIComponent(o.tool)}`, { method: "POST", body: { connected_account_id: o.accountId, user_id: o.userId, arguments: o.args } });
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
      const q = new URLSearchParams({ toolkit_slug: toolkit, limit: "100", ...(search ? { search } : {}) });
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
const READS = /(GET|LIST|FETCH|FIND|SEARCH|READ|QUERY|RETRIEVE|VIEW|LOOKUP|FREE_BUSY|REPORT|COUNT|DESCRIBE|CHECK|ANALYTICS|INSIGHTS|STATS)/;

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

export function composioGoogleApis(execute: (tool: string, args: Record<string, unknown>) => Promise<unknown>): GoogleApis {
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
    ga4Properties: unsupported("Listing analytics properties"), ga4Report: unsupported("An analytics report"),
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

interface Stored { accountId: string; userId: string; at: number; headline?: string; readAt?: number }

export const COMPOSIO_OFF_WORDS = (what: string) => `Connecting ${what} isn't switched on yet. Your team is setting up the connection service and will let you know when it's ready.`;

export interface ComposioSession {
  execute(tool: string, args: Record<string, unknown>): Promise<unknown>;
  /** A read-only call to the provider's own API with this business's connected account (proxyIsRead); answers its JSON. */
  proxy(req: ProxyRequest): Promise<unknown>;
  listTools(search?: string): Promise<ComposioToolInfo[]>;
  toolkit: string;
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
  readonly info: ConnectorInfo;
  /** The daily read (and the first one, right after connecting), for toolkits that have a reader (firstread.ts). */
  readonly pull?: (ctx: ConnectorCtx) => Promise<{ ok: boolean; message: string }>;
  constructor(readonly entry: ToolkitEntry, private deps: ComposioDeps) {
    this.info = infoOf(entry);
    const reader = readerFor(entry);
    if (reader) this.pull = (ctx) => once(`${ctx.tenant}\u0000${entry.id}`, () => this.readNow(ctx, reader));
  }

  private async readNow(ctx: ConnectorCtx, reader: Reader): Promise<{ ok: boolean; message: string }> {
    try {
      const first = await this.run(ctx, (s) => reader(s.execute, ctx, s.proxy));
      const r = await this.stored(ctx);
      if (r) await ctx.vault.put(ctx.tenant, this.info.id, { ...r, readAt: ctx.now(), ...(first.headline ? { headline: first.headline } : {}) } satisfies Stored);
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
    if (r.userId !== this.user(ctx)) return { state: "needs_attention", message: `We can't use the saved ${this.info.name} connection any more. Connect it again.` };
    return { state: "connected", message: r.headline ? `${this.info.name} connected: ${r.headline}.` : `${this.info.name} is connected.`, lastReadAt: new Date(r.readAt ?? r.at).toISOString() };
  }

  async connect(ctx: ConnectorCtx): Promise<ConnectStart> {
    const state = ctx.beginAuth({});
    const callbackUrl = `${ctx.webBaseUrl}/api/connectors/google/callback?${new URLSearchParams({ state })}`; // one callback address for every provider
    try {
      const authConfigId = await this.client().authConfigId(this.entry.toolkit);
      const l = await this.client().link({ authConfigId, userId: this.user(ctx), callbackUrl });
      return { url: l.redirectUrl };
    } catch (e) {
      if (e instanceof ComposioError && e.status === 403) {
        throw new NotConfiguredError(this.info.id, { ok: false, message: COMPOSIO_OFF_WORDS(this.info.name), missing: [{ setting: "COMPOSIO_API_KEY", words: e.message }] });
      }
      throw e;
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
    return fn({
      toolkit: this.entry.toolkit, execute, proxy, listTools: (q) => client.tools(this.entry.toolkit, q),
      apis: composioGoogleApis(execute), accessToken: "composio", meta: {}, allowed: () => true,
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
