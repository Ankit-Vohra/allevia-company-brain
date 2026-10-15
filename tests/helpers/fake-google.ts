// A fake Google for the Search Console connector's tests: it hands out scripted tokens, lists scripted sites, answers Search
// Analytics queries from a function, and records every call. Nothing here touches the network, and the real client refuses
// to run under vitest. Token strings are made up and never real.
import {
  GoogleApiError, GoogleAuthError, type AnalyticsQuery, type AnalyticsRow, type GoogleClient, type GoogleTokens, type SiteEntry,
} from "../../src/connectors/google/client.js";

export interface FakeGoogleScript {
  codes?: Record<string, GoogleTokens>;                  // authorization code -> tokens
  sites?: SiteEntry[];
  analytics?: (siteUrl: string, q: AnalyticsQuery) => AnalyticsRow[];
}

export class FakeGoogle implements GoogleClient {
  calls: Array<{ op: string; args: unknown[] }> = [];
  refreshes = 0;
  private n = 0;
  failRefresh: "auth" | "api" | null = null;
  refusedRefreshTokens = new Set<string>();             // these refresh tokens are revoked: Google says invalid_grant
  failAnalytics: "auth" | "api" | null = null;
  revoked: string[] = [];

  constructor(public script: FakeGoogleScript = {}) {}

  private log(op: string, ...args: unknown[]) { this.calls.push({ op, args }); }

  async exchangeCode(code: string): Promise<GoogleTokens> {
    this.log("exchangeCode", code);
    const t = this.script.codes?.[code];
    if (!t) throw new GoogleAuthError("invalid_grant");
    return t;
  }
  async refresh(refreshToken: string): Promise<GoogleTokens> {
    this.log("refresh", refreshToken);
    this.refreshes++;
    if (this.failRefresh === "auth" || this.refusedRefreshTokens.has(refreshToken)) throw new GoogleAuthError("invalid_grant");
    if (this.failRefresh === "api") throw new GoogleApiError("Google answered 503.", 503, true);
    return { accessToken: `fresh-access-token-${++this.n}-ZZZZZZZZZZZZ`, expiresIn: 3600, scope: "https://www.googleapis.com/auth/webmasters.readonly" }; // no new refresh token: Google omits it
  }
  async revoke(token: string): Promise<void> { this.log("revoke", token); this.revoked.push(token); }
  async listSites(accessToken: string): Promise<SiteEntry[]> { this.log("listSites", accessToken); return this.script.sites ?? []; }
  async searchAnalytics(accessToken: string, siteUrl: string, q: AnalyticsQuery): Promise<AnalyticsRow[]> {
    this.log("searchAnalytics", accessToken, siteUrl, q);
    if (this.failAnalytics === "auth") throw new GoogleAuthError("invalid_token");
    if (this.failAnalytics === "api") throw new GoogleApiError("Google answered 429.", 429, true);
    return this.script.analytics?.(siteUrl, q) ?? [];
  }
}

export const READONLY = "https://www.googleapis.com/auth/webmasters.readonly";
export const tokens = (n: string, over: Partial<GoogleTokens> = {}): GoogleTokens => ({
  accessToken: `access-token-${n}-AAAAAAAAAAAAAA`, refreshToken: `refresh-token-${n}-BBBBBBBBBBBBBB`, expiresIn: 3600, scope: READONLY, ...over,
});

const day = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

// Search Analytics rows for a site: one per day from startDate to endDate (skipping `quietDays`, as Google skips days with
// nothing), top pages and top queries for the other dimensions.
export function analyticsFor(o: { pages?: string[]; queries?: string[]; quietDays?: string[]; clicksOn?: (date: string) => number } = {}): (siteUrl: string, q: AnalyticsQuery) => AnalyticsRow[] {
  return (_site, q) => {
    const dim = q.dimensions[0];
    if (dim === "date") {
      const rows: AnalyticsRow[] = [];
      for (let d = q.startDate; d <= q.endDate; d = day(d, 1)) {
        if (o.quietDays?.includes(d)) continue;
        const clicks = o.clicksOn?.(d) ?? 10 + (Number(d.slice(8)) % 5);
        rows.push({ keys: [d], clicks, impressions: clicks * 20, ctr: 0.05, position: 8.4 });
      }
      return rows;
    }
    if (dim === "page") return (o.pages ?? []).map((p, i) => ({ keys: [p], clicks: 40 - i * 5, impressions: 1200 - i * 100, ctr: (40 - i * 5) / (1200 - i * 100), position: 6.25 + i }));
    return (o.queries ?? []).map((t, i) => ({ keys: [t], clicks: 20 - i, impressions: 400 - i * 10, ctr: (20 - i) / (400 - i * 10), position: 3.5 + i }));
  };
}
