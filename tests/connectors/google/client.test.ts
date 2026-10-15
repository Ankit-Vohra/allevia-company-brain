// The real Google client's requests, checked against a scripted fetch (no network, no credential), and the guard that keeps
// it from ever running inside a test.
import { describe, expect, it } from "vitest";
import { GoogleApiError, GoogleAuthError, realGoogleClient, type FetchFn } from "../../../src/connectors/google/client.js";

interface Sent { url: string; method?: string; headers?: Record<string, string>; body?: string }
function scripted(...replies: Array<{ status: number; json?: unknown }>): { fetch: FetchFn; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetch: FetchFn = async (url, init) => {
    sent.push({ url, ...init });
    const r = replies.shift() ?? { status: 500 };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.json ?? {}, text: async () => JSON.stringify(r.json ?? {}) };
  };
  return { fetch, sent };
}
const SETTINGS = { clientId: "test-client-id.apps.example", clientSecret: "test-client-secret-xxxxxxxxxxxx", redirectUri: "https://allevia.example/api/connectors/google/callback" };

describe("the real Google client", () => {
  it("exchanges a code the way Google's token endpoint wants it", async () => {
    const { fetch, sent } = scripted({ status: 200, json: { access_token: "access-a-AAAAAAAA", refresh_token: "refresh-b-BBBBBBBB", expires_in: 3599, scope: "https://www.googleapis.com/auth/webmasters.readonly" } });
    const t = await realGoogleClient(SETTINGS, fetch).exchangeCode("auth-code-1");
    expect(t).toEqual({ accessToken: "access-a-AAAAAAAA", refreshToken: "refresh-b-BBBBBBBB", expiresIn: 3599, scope: "https://www.googleapis.com/auth/webmasters.readonly" });
    expect(sent[0]!.url).toBe("https://oauth2.googleapis.com/token");
    expect(sent[0]!.method).toBe("POST");
    expect(Object.fromEntries(new URLSearchParams(sent[0]!.body))).toEqual({
      code: "auth-code-1", client_id: SETTINGS.clientId, client_secret: SETTINGS.clientSecret, redirect_uri: SETTINGS.redirectUri, grant_type: "authorization_code",
    });
  });

  it("refreshes with the refresh token and no redirect", async () => {
    const { fetch, sent } = scripted({ status: 200, json: { access_token: "access-c-CCCCCCCC", expires_in: 3600, scope: "x" } });
    expect(await realGoogleClient(SETTINGS, fetch).refresh("refresh-b-BBBBBBBB")).toMatchObject({ accessToken: "access-c-CCCCCCCC", expiresIn: 3600 });
    expect(Object.fromEntries(new URLSearchParams(sent[0]!.body))).toEqual({ refresh_token: "refresh-b-BBBBBBBB", client_id: SETTINGS.clientId, client_secret: SETTINGS.clientSecret, grant_type: "refresh_token" });
  });

  it("lists sites with a bearer token and reads Search Analytics from the site's own address", async () => {
    const { fetch, sent } = scripted(
      { status: 200, json: { siteEntry: [{ siteUrl: "sc-domain:kestrel.example", permissionLevel: "siteOwner" }, { nonsense: true }] } },
      { status: 200, json: { rows: [{ keys: ["2026-10-01"], clicks: 4, impressions: 90, ctr: 0.0444, position: 7.2 }, { keys: [3] }] } },
    );
    const c = realGoogleClient(SETTINGS, fetch);
    expect(await c.listSites("access-a-AAAAAAAA")).toEqual([{ siteUrl: "sc-domain:kestrel.example", permissionLevel: "siteOwner" }]);
    expect(sent[0]).toMatchObject({ url: "https://www.googleapis.com/webmasters/v3/sites", headers: { authorization: "Bearer access-a-AAAAAAAA" } });
    const rows = await c.searchAnalytics("access-a-AAAAAAAA", "sc-domain:kestrel.example", { startDate: "2026-09-15", endDate: "2026-10-12", dimensions: ["date"], rowLimit: 1000 });
    expect(rows).toEqual([{ keys: ["2026-10-01"], clicks: 4, impressions: 90, ctr: 0.0444, position: 7.2 }]);
    expect(sent[1]!.url).toBe("https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Akestrel.example/searchAnalytics/query");
    expect(JSON.parse(sent[1]!.body!)).toEqual({ startDate: "2026-09-15", endDate: "2026-10-12", dimensions: ["date"], rowLimit: 1000, startRow: 0, dataState: "final" });
    expect(sent[1]!.headers).toMatchObject({ authorization: "Bearer access-a-AAAAAAAA", "content-type": "application/json" });
  });

  it("tells a revoked grant (the owner must connect again) from a rate limit or Google's own trouble", async () => {
    const auth = realGoogleClient(SETTINGS, scripted({ status: 400, json: { error: "invalid_grant" } }).fetch);
    await expect(auth.refresh("r")).rejects.toBeInstanceOf(GoogleAuthError);
    const expired = realGoogleClient(SETTINGS, scripted({ status: 401, json: { error: { status: "UNAUTHENTICATED" } } }).fetch);
    await expect(expired.listSites("a")).rejects.toBeInstanceOf(GoogleAuthError);
    const limited = realGoogleClient(SETTINGS, scripted({ status: 429, json: { error: { status: "RESOURCE_EXHAUSTED" } } }).fetch);
    await expect(limited.listSites("a")).rejects.toMatchObject({ name: "GoogleApiError", status: 429, retryable: true });
    const forbidden = realGoogleClient(SETTINGS, scripted({ status: 403, json: { error: { status: "PERMISSION_DENIED" } } }).fetch);
    await expect(forbidden.searchAnalytics("a", "s", { startDate: "2026-01-01", endDate: "2026-01-02", dimensions: ["date"], rowLimit: 1 })).rejects.toMatchObject({ retryable: false });
    await expect(realGoogleClient(SETTINGS, scripted({ status: 200, json: {} }).fetch).exchangeCode("c")).rejects.toBeInstanceOf(GoogleApiError); // no access token in the answer
  });

  it("revoke is best effort and never throws", async () => {
    const c = realGoogleClient(SETTINGS, async () => { throw new Error("offline"); });
    await expect(c.revoke("r")).resolves.toBeUndefined();
  });

  it("refuses to reach Google from a test unless a fetch is injected", async () => {
    await expect(realGoogleClient(SETTINGS).listSites("a")).rejects.toThrow(/tests must inject a Google client/);
  });
});
