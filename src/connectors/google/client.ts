// The part of Google the Search Console connector talks to, as an interface, so the connector is built and tested against a
// fake (tests/helpers/fake-google.ts) and the real one is a thin layer of fetch calls. The real client refuses to run under
// vitest, the way the gh and Discord defaults do: a test can never reach Google. Nothing here logs a token.
export interface GoogleTokens {
  accessToken: string;
  refreshToken?: string;      // Google gives one on the first consent (access_type=offline, prompt=consent); a refresh may omit it
  expiresIn: number;          // seconds
  scope: string;
}

export interface SiteEntry { siteUrl: string; permissionLevel: string }

export interface AnalyticsQuery {
  startDate: string;          // YYYY-MM-DD
  endDate: string;
  dimensions: Array<"date" | "page" | "query">;
  rowLimit: number;
  startRow?: number;
}
export interface AnalyticsRow { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }

export interface GoogleClient {
  exchangeCode(code: string, codeVerifier?: string): Promise<GoogleTokens>;
  refresh(refreshToken: string): Promise<GoogleTokens>;
  revoke(token: string): Promise<void>;
  listSites(accessToken: string): Promise<SiteEntry[]>;
  searchAnalytics(accessToken: string, siteUrl: string, q: AnalyticsQuery): Promise<AnalyticsRow[]>;
}

// Google says the grant is gone or was never valid: the owner has to connect again.
export class GoogleAuthError extends Error {
  override name = "GoogleAuthError";
}
// Anything else that went wrong talking to Google; `retryable` is a rate limit or Google's own trouble.
export class GoogleApiError extends Error {
  override name = "GoogleApiError";
  constructor(message: string, readonly status: number, readonly retryable: boolean) {
    super(message);
  }
}

export interface RealClientSettings { clientId: string; clientSecret: string; redirectUri: string }
export type FetchFn = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const SITES_URL = "https://www.googleapis.com/webmasters/v3/sites";

const refuseInTests: FetchFn = async () => {
  if (process.env.VITEST) throw new Error("tests must inject a Google client (or fetch): refusing to call Google");
  throw new Error("no fetch available");
};
export const realFetch: FetchFn = (url, init) => (process.env.VITEST ? refuseInTests(url, init) : (fetch(url, init as RequestInit) as ReturnType<FetchFn>));

export const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

export async function failure(res: { status: number; text(): Promise<string> }): Promise<never> {
  let code = "";
  try {
    const body = asRecord(JSON.parse(await res.text()));
    code = typeof body.error === "string" ? body.error : typeof asRecord(body.error).status === "string" ? String(asRecord(body.error).status) : "";
  } catch {
    code = "";
  }
  if (res.status === 401 || code === "invalid_grant" || code === "invalid_token" || code === "UNAUTHENTICATED") throw new GoogleAuthError(`Google no longer accepts this connection (${code || res.status}).`);
  throw new GoogleApiError(`Google answered ${res.status}${code ? ` (${code})` : ""}.`, res.status, res.status === 429 || res.status >= 500);
}

function tokensFrom(body: unknown): GoogleTokens {
  const b = asRecord(body);
  if (typeof b.access_token !== "string") throw new GoogleApiError("Google's answer had no access token.", 502, true);
  return {
    accessToken: b.access_token, ...(typeof b.refresh_token === "string" ? { refreshToken: b.refresh_token } : {}),
    expiresIn: typeof b.expires_in === "number" ? b.expires_in : 3600, scope: typeof b.scope === "string" ? b.scope : "",
  };
}

export function realGoogleClient(s: RealClientSettings, fetchFn: FetchFn = realFetch): GoogleClient {
  const form = (o: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString() });
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  return {
    async exchangeCode(code, codeVerifier) {
      const res = await fetchFn(TOKEN_URL, form({ code, client_id: s.clientId, client_secret: s.clientSecret, redirect_uri: s.redirectUri, grant_type: "authorization_code", ...(codeVerifier ? { code_verifier: codeVerifier } : {}) }));
      return res.ok ? tokensFrom(await res.json()) : failure(res);
    },
    async refresh(refreshToken) {
      const res = await fetchFn(TOKEN_URL, form({ refresh_token: refreshToken, client_id: s.clientId, client_secret: s.clientSecret, grant_type: "refresh_token" }));
      return res.ok ? tokensFrom(await res.json()) : failure(res);
    },
    async revoke(token) {
      await fetchFn(REVOKE_URL, form({ token })).catch(() => undefined); // best effort: the stored copy is deleted either way
    },
    async listSites(accessToken) {
      const res = await fetchFn(SITES_URL, { headers: auth(accessToken) });
      if (!res.ok) return failure(res);
      const entries = asRecord(await res.json()).siteEntry;
      return (Array.isArray(entries) ? entries : []).flatMap((e): SiteEntry[] => {
        const r = asRecord(e);
        return typeof r.siteUrl === "string" ? [{ siteUrl: r.siteUrl, permissionLevel: typeof r.permissionLevel === "string" ? r.permissionLevel : "" }] : [];
      });
    },
    async searchAnalytics(accessToken, siteUrl, q) {
      const res = await fetchFn(`${SITES_URL}/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, {
        method: "POST", headers: { ...auth(accessToken), "content-type": "application/json" },
        body: JSON.stringify({ startDate: q.startDate, endDate: q.endDate, dimensions: q.dimensions, rowLimit: q.rowLimit, startRow: q.startRow ?? 0, dataState: "final" }),
      });
      if (!res.ok) return failure(res);
      const rows = asRecord(await res.json()).rows;
      return (Array.isArray(rows) ? rows : []).flatMap((r): AnalyticsRow[] => {
        const x = asRecord(r);
        if (!Array.isArray(x.keys) || !x.keys.every((k) => typeof k === "string")) return [];
        const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
        return [{ keys: x.keys as string[], clicks: n(x.clicks), impressions: n(x.impressions), ctr: n(x.ctr), position: n(x.position) }];
      });
    },
  };
}
