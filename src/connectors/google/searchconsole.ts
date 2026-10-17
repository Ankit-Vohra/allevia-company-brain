// The Search Console connector: a business connects with Google OAuth (it clicks Connect, signs in to its own Google account,
// says yes to read-only Search Console), and Allevia reads its clicks, impressions and top pages and searches every day.
//   authorizationUrl   the Google address the owner is sent to (state signed with the tenant and an expiry)
//   handleCallback     the code Google sends back becomes tokens, sealed per tenant (store.ts), and the business's website
//                      property is picked when the account has one clear match, else the owner is asked
//   pullSearchConsole  refresh the access token when it is old, read the last days, write Observations (searchconsole-map.ts)
//                      sourced from a Document, then lock goal baselines and re-derive the capability: Search Console moves to
//                      "api" (live connector data under 7 days old) and the Search clicks goal reads a real number
//   connectionStatus   what to tell the owner, in plain words, whatever state the connection is in
//   disconnect         forget the tokens (and ask Google to revoke them); the history already read stays
// What the graph holds is only the System node (status, property, when it last read), never a token.
// Failure is calm: a refused refresh marks the System 'expired' (the ladder drops a rung and the owner is told to connect
// again), a rate limit or Google outage is recorded and retried tomorrow without touching the capability.
import { randomBytes } from "node:crypto";
import { findBusiness, syncCapabilities, deriveCapabilities } from "../../capabilities/ladder.js";
import type { GraphHandle } from "../../graph/client.js";
import { upsertNode, writeBatch, type NodeInput } from "../../graph/upsert.js";
import { settleGoals } from "../../program/late.js";
import { addDays } from "../../insights/text.js";
import { isoDate } from "../../util/time.js";
import { GoogleApiError, GoogleAuthError, type AnalyticsRow, type GoogleClient, type SiteEntry } from "./client.js";
import { signState, verifyState } from "./crypto.js";
import { GOOGLE_SEARCH_CHANNEL } from "./ids.js";
import { mapSearchAnalytics } from "./searchconsole-map.js";
import { NOT_CONFIGURED_WORDS, NotConfiguredError, type GoogleSettings } from "./settings.js";
import type { TokenRecord, TokenStore } from "./store.js";

export const CONNECTOR = "search-console";
export const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
export const SYSTEM_ID = "system:search-console";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const STATE_TTL_MS = 10 * 60_000;
const REFRESH_MARGIN_MS = 60_000;
export const FIRST_PULL_DAYS = 90;
export const LAG_DAYS = 3;          // Search Console's newest days are still being filled in
export const OVERLAP_DAYS = 3;      // each pull re-reads the last days it already has, because Google revises them
export const WINDOW_DAYS = 28;

export interface GoogleDeps {
  settings: GoogleSettings;
  store: TokenStore;
  client: GoogleClient;
  now: () => number;
}

export class ConnectError extends Error {
  override name = "ConnectError";
  constructor(readonly code: "bad_state" | "missing_scope" | "no_refresh" | "google" | "not_found", message: string) {
    super(message);
  }
}

// ---------- status ----------

export type ConnectorState = "not_configured" | "not_connected" | "choose_property" | "connected" | "needs_reconnect";
export interface ConnectorStatus {
  state: ConnectorState;
  message: string;
  property?: string;
  sites?: string[];
  lastPullAt?: string;
  dataThrough?: string;
  capabilityMode?: string;
  missing?: string[];      // for the operator: what the founder still has to set up (plain words)
}

export interface SystemProps { status: string | null; property: string | null; siteChoices: string[] | null; lastPullAt: number | null; dataThrough: string | null; lastError: string | null }

export async function readSystem(g: GraphHandle): Promise<SystemProps | null> {
  const [r] = await g.roQuery<SystemProps>(
    `MATCH (s:Entity:System {id:$id}) RETURN s.status AS status, s.property AS property, s.siteChoices AS siteChoices, s.lastPullAt AS lastPullAt,
            s.dataThrough AS dataThrough, s.lastError AS lastError`, { id: SYSTEM_ID });
  return r ?? null;
}

export async function writeSystem(g: GraphHandle, now: number, props: Record<string, string | number | boolean | string[] | null>): Promise<void> {
  await upsertNode(g, { type: "System", id: SYSTEM_ID, name: "Search Console", props: { kind: "connector", provider: "google", ...props } }, now);
}

export async function connectionStatus(deps: GoogleDeps, g: GraphHandle, tenant: string, businessId?: string): Promise<ConnectorStatus> {
  if (!deps.settings.configured) return { state: "not_configured", message: NOT_CONFIGURED_WORDS, missing: deps.settings.missing.map((m) => m.words) };
  let tokens: TokenRecord | null;
  try {
    tokens = await deps.store.get(tenant, CONNECTOR);
  } catch {
    return { state: "needs_reconnect", message: "We can't open the saved Search Console connection any more. Connect it again." };
  }
  const sys = await readSystem(g);
  if (!tokens) return { state: "not_connected", message: "Connect Search Console to see the searches that bring people to your site." };
  if (sys?.status === "expired") return { state: "needs_reconnect", message: "Google stopped letting us read Search Console (the access was removed or has run out). Connect it again." };
  if (!sys?.property) {
    return {
      state: "choose_property", message: "You're connected. Pick which website to read.", ...(sys?.siteChoices?.length ? { sites: sys.siteChoices } : {}),
    };
  }
  const mode = (await deriveCapabilities(g, { now: deps.now(), ...(businessId ? { businessId } : {}) })).find((c) => c.key === "search_console")?.accessMode;
  const through = sys.dataThrough ?? undefined;
  return {
    state: "connected", property: sys.property,
    message: `Reading ${sys.property} from Google${through ? `. The newest numbers are from ${through}` : ""}.${sys.lastError ? ` The last try had a problem (${sys.lastError}); we will try again.` : ""}`,
    ...(sys.lastPullAt ? { lastPullAt: new Date(sys.lastPullAt).toISOString() } : {}), ...(through ? { dataThrough: through } : {}), ...(mode ? { capabilityMode: mode } : {}),
  };
}

// ---------- connecting ----------

const spent = new Map<string, number>(); // nonce -> expiry: a state is good once
function remember(n: string, exp: number, now: number): boolean {
  for (const [k, e] of spent) if (e < now) spent.delete(k);
  if (spent.has(n)) return false;
  spent.set(n, exp);
  return true;
}

export function authorizationUrl(deps: GoogleDeps, tenant: string): string {
  if (!deps.settings.configured) throw new NotConfiguredError(deps.settings.missing);
  const state = signState(deps.settings.connectorKey, { t: tenant, e: deps.now() + STATE_TTL_MS, n: randomBytes(12).toString("hex") });
  const q = new URLSearchParams({
    client_id: deps.settings.clientId, redirect_uri: deps.settings.redirectUri, response_type: "code", scope: SCOPE,
    access_type: "offline", prompt: "consent", include_granted_scopes: "true", state,
  });
  return `${AUTH_URL}?${q.toString()}`;
}

// The tenant a returning `state` was made for, once, while it is fresh; null for anything forged, old or already used.
export function tenantFromState(deps: GoogleDeps, state: string): string | null {
  if (!deps.settings.configured) return null;
  const p = verifyState<{ t: string; e: number; n: string }>(deps.settings.connectorKey, state);
  if (!p || typeof p.t !== "string" || typeof p.n !== "string" || typeof p.e !== "number" || p.e < deps.now()) return null;
  return remember(p.n, p.e, deps.now()) ? p.t : null;
}

export type PropertyPick = { site: string } | { choose: string[] } | { none: true };

// The business's website among the properties its Google account can read. A domain property (sc-domain:) covers the whole
// site and wins; otherwise the https address on the business's own host; two equally good matches are left for the owner.
export function matchProperty(sites: readonly SiteEntry[], domain: string | null | undefined): PropertyPick {
  const usable = sites.filter((s) => s.permissionLevel !== "siteUnverifiedUser");
  const host = (domain ?? "").trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/\/.*$/, "");
  if (!host) return usable.length === 1 ? { site: usable[0]!.siteUrl } : usable.length ? { choose: usable.map((s) => s.siteUrl) } : { none: true };
  const bare = host.replace(/^www\./, "");
  const matches = usable.filter((s) => {
    const u = s.siteUrl.toLowerCase();
    return u === `sc-domain:${bare}` || new RegExp(`^https?://(?:www\\.)?${bare.replace(/\./g, "\\.")}/`).test(u);
  });
  if (!matches.length) return usable.length ? { choose: usable.map((s) => s.siteUrl) } : { none: true };
  const dom = matches.find((s) => s.siteUrl.toLowerCase() === `sc-domain:${bare}`);
  if (dom) return { site: dom.siteUrl };
  const https = matches.filter((s) => s.siteUrl.toLowerCase().startsWith("https://"));
  const exact = https.filter((s) => s.siteUrl.toLowerCase() === `https://${host}/`);
  if (exact.length === 1) return { site: exact[0]!.siteUrl };
  if (https.length === 1) return { site: https[0]!.siteUrl };
  return { choose: matches.map((s) => s.siteUrl) };
}

async function businessDomain(g: GraphHandle, businessId: string | undefined): Promise<string | null> {
  const biz = businessId ?? (await findBusiness(g));
  if (!biz) return null;
  const [b] = await g.roQuery<{ d: string | null }>("MATCH (b:Entity:Business {id:$id}) RETURN b.domain AS d", { id: biz });
  return b?.d ?? null;
}

export async function handleCallback(deps: GoogleDeps, g: GraphHandle, tenant: string, code: string, businessId?: string, codeVerifier?: string): Promise<{ state: "connected" | "choose_property"; property?: string }> {
  if (!deps.settings.configured) throw new NotConfiguredError(deps.settings.missing);
  const now = deps.now();
  let t;
  try {
    t = await deps.client.exchangeCode(code, codeVerifier);
  } catch (e) {
    if (e instanceof GoogleAuthError) throw new ConnectError("google", "Google did not accept that sign-in (it may have run out). Try connecting again.");
    throw new ConnectError("google", "We couldn't reach Google just now. Try connecting again in a minute.");
  }
  if (!t.scope.split(/[\s,]+/).includes(SCOPE)) {
    throw new ConnectError("missing_scope", "We need permission to read your Search Console, and that box was not ticked. Connect again and leave it ticked.");
  }
  const existing = await deps.store.get(tenant, CONNECTOR).catch(() => null);
  const refreshToken = t.refreshToken ?? existing?.refreshToken;
  if (!refreshToken) {
    throw new ConnectError("no_refresh", "Google didn't give us lasting access. In your Google account, open the page that lists apps with access, remove Allevia, and connect again.");
  }
  await deps.store.put(tenant, CONNECTOR, { accessToken: t.accessToken, refreshToken, expiresAt: now + t.expiresIn * 1000, scope: t.scope, obtainedAt: now });

  let sites: SiteEntry[] = [];
  try {
    sites = await deps.client.listSites(t.accessToken);
  } catch {
    sites = [];
  }
  const pick = matchProperty(sites, await businessDomain(g, businessId));
  const usable = sites.filter((s) => s.permissionLevel !== "siteUnverifiedUser").map((s) => s.siteUrl);
  if ("site" in pick) {
    await writeSystem(g, now, { status: "ok", property: pick.site, siteChoices: usable, connectedAt: now, lastError: null });
    return { state: "connected", property: pick.site };
  }
  await writeSystem(g, now, { status: "pending", property: null, siteChoices: "choose" in pick ? pick.choose : usable, connectedAt: now, lastError: null });
  return { state: "choose_property" };
}

export async function chooseProperty(deps: GoogleDeps, g: GraphHandle, tenant: string, siteUrl: string): Promise<void> {
  const sys = await readSystem(g);
  const tokens = await deps.store.get(tenant, CONNECTOR).catch(() => null);
  if (!tokens) throw new ConnectError("not_found", "Connect Search Console first.");
  let allowed = sys?.siteChoices ?? [];
  if (!allowed.includes(siteUrl)) {
    // the list may have been out of date: ask Google, with a fresh token
    const fresh = await freshToken(deps, g, tenant, tokens).catch(() => null);
    allowed = fresh ? (await deps.client.listSites(fresh.accessToken).catch(() => [])).filter((s) => s.permissionLevel !== "siteUnverifiedUser").map((s) => s.siteUrl) : allowed;
  }
  if (!allowed.includes(siteUrl)) throw new ConnectError("not_found", "That website isn't one your Google account can read in Search Console.");
  await writeSystem(g, deps.now(), { status: "ok", property: siteUrl, siteChoices: allowed, lastError: null });
}

export async function disconnectSearchConsole(deps: GoogleDeps, g: GraphHandle, tenant: string): Promise<void> {
  const tokens = await deps.store.get(tenant, CONNECTOR).catch(() => null);
  if (tokens) await deps.client.revoke(tokens.refreshToken).catch(() => undefined);
  await deps.store.delete(tenant, CONNECTOR);
  if (await readSystem(g)) await writeSystem(g, deps.now(), { status: "not_connected", property: null, siteChoices: null, lastError: null });
}

// ---------- pulling ----------

export type PullStatus = "ok" | "not_connected" | "needs_property" | "needs_reconnect" | "error";
export interface PullResult {
  status: PullStatus;
  message: string;
  property?: string;
  through?: string;
  days?: number;
  zeroDays?: number;
  pages?: number;
  skippedPages?: number;
  queries?: number;
  written?: number;
}

// A token good for at least a minute: the stored one, or a refreshed one (stored again; Google leaves the refresh token out).
export async function freshToken(deps: GoogleDeps, g: GraphHandle, tenant: string, tokens: TokenRecord, force = false): Promise<TokenRecord> {
  const now = deps.now();
  if (!force && tokens.expiresAt - REFRESH_MARGIN_MS > now) return tokens;
  const t = await deps.client.refresh(tokens.refreshToken); // GoogleAuthError / GoogleApiError go to the caller
  const next: TokenRecord = { accessToken: t.accessToken, refreshToken: t.refreshToken ?? tokens.refreshToken, expiresAt: now + t.expiresIn * 1000, scope: t.scope || tokens.scope, obtainedAt: now };
  await deps.store.put(tenant, CONNECTOR, next);
  return next;
}

const EXPIRED_WORDS = "Google stopped letting us read Search Console (the access was removed or has run out). Connect it again.";

async function expire(deps: GoogleDeps, g: GraphHandle): Promise<PullResult> {
  await writeSystem(g, deps.now(), { status: "expired", lastError: "Google no longer accepts the saved access" });
  await syncCapabilities(g, { now: deps.now() }).catch(() => undefined);
  return { status: "needs_reconnect", message: EXPIRED_WORDS };
}

export async function pullSearchConsole(deps: GoogleDeps, g: GraphHandle, tenant: string, opts: { businessId?: string } = {}): Promise<PullResult> {
  const now = deps.now();
  if (!deps.settings.configured) return { status: "not_connected", message: NOT_CONFIGURED_WORDS };
  let tokens: TokenRecord | null;
  try {
    tokens = await deps.store.get(tenant, CONNECTOR);
  } catch {
    return { status: "needs_reconnect", message: "We can't open the saved Search Console connection any more. Connect it again." };
  }
  if (!tokens) return { status: "not_connected", message: "Search Console isn't connected." };
  const sys = await readSystem(g);
  if (!sys?.property) return { status: "needs_property", message: "Pick which website to read first." };
  const property = sys.property;

  const today = isoDate(now);
  const end = addDays(today, -LAG_DAYS);
  const start = sys.dataThrough ? addDays(sys.dataThrough, -OVERLAP_DAYS) : addDays(end, -(FIRST_PULL_DAYS - 1));
  const windowStart = addDays(end, -(WINDOW_DAYS - 1));

  const read = async (dims: Array<"date" | "page" | "query">, from: string, rowLimit: number): Promise<AnalyticsRow[]> => {
    const go = (t: TokenRecord) => deps.client.searchAnalytics(t.accessToken, property, { startDate: from, endDate: end, dimensions: dims, rowLimit });
    try {
      return await go(tokens!);
    } catch (e) {
      if (!(e instanceof GoogleAuthError)) throw e;
      tokens = await freshToken(deps, g, tenant, tokens!, true); // the access token was refused: one forced refresh, then once more
      return go(tokens);
    }
  };

  let daily: AnalyticsRow[], pages: AnalyticsRow[], queries: AnalyticsRow[];
  try {
    tokens = await freshToken(deps, g, tenant, tokens);
    daily = await read(["date"], start, 1000);
    pages = await read(["page"], windowStart, 250);
    queries = await read(["query"], windowStart, 50);
  } catch (e) {
    if (e instanceof GoogleAuthError) return expire(deps, g);
    const retryable = e instanceof GoogleApiError ? e.retryable : true;
    const words = retryable ? "Google is busy or slow right now" : "Google would not give us the numbers";
    await writeSystem(g, now, { lastError: words }).catch(() => undefined);
    return { status: "error", property, message: `${words}. We will try again tomorrow.` };
  }

  const docId = `document:gsc-pull-${today}`;
  const known = new Set((await g.roQuery<{ id: string }>("MATCH (p:Page) RETURN p.id AS id ORDER BY id LIMIT 5000")).map((r) => r.id));
  const haveChannel = (await g.roQuery<{ id: string }>("MATCH (c:Entity:Channel {id:$id}) RETURN c.id AS id", { id: GOOGLE_SEARCH_CHANNEL })).length > 0;
  const m = mapSearchAnalytics({ daily, pages, queries, startDate: start, endDate: end, windowStart, pullDate: today, docId, channelId: GOOGLE_SEARCH_CHANNEL, knownPages: known });
  const nodes: NodeInput[] = [
    ...(haveChannel ? [] : [{ type: "Channel" as const, id: GOOGLE_SEARCH_CHANNEL, name: "Google Search" }]),
    { type: "Document", id: docId, name: `Search Console numbers read on ${today}`, summary: `Clicks, impressions and top pages and searches for ${property}, ${start} to ${end}.`, props: { kind: "snapshot", provider: "search-console", property }, asOf: today },
    ...m.nodes,
  ];
  const stats = await writeBatch(g, { nodes, observations: m.observations }, now);
  if (stats.errors.length) throw new Error(`search console: ${stats.errors[0]!.error}`);
  await writeSystem(g, now, { status: "ok", lastPullAt: now, dataThrough: end, lastError: null });
  try {
    await settleGoals(g, { now, ...(opts.businessId ? { businessId: opts.businessId } : {}) });
    await syncCapabilities(g, { now, ...(opts.businessId ? { businessId: opts.businessId } : {}) });
  } catch {
    // the numbers are in; the goals and the ladder catch up on the next read of the plan
  }
  return {
    status: "ok", property, through: end, days: m.stats.days, zeroDays: m.stats.zeroDays, pages: m.stats.pages, skippedPages: m.stats.skippedPages, queries: m.stats.queries,
    written: stats.observations, message: `Read ${property} up to ${end}.`,
  };
}
