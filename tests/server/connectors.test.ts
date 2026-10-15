// "Connect Search Console" over HTTP, against a fake Google: the status in plain words, the Google address, the redirect back
// (the tenant comes from the signed state), the first read, pick-a-website, read now and disconnect. Nothing reaches Google.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CapabilityState } from "../../shared/contracts.js";
import type { GoogleDeps } from "../../src/connectors/google/searchconsole.js";
import { googleSettings } from "../../src/connectors/google/settings.js";
import { FileTokenStore } from "../../src/connectors/google/store.js";
import { analyticsFor, FakeGoogle, tokens } from "../helpers/fake-google.js";
import { harness, post, type Harness } from "./harness.js";

const KEY = "test-connector-key-0123456789abcdef0123456789abcdef";
const CONFIG = { clientId: "test-client-id.apps.example", clientSecret: "test-client-secret-xxxxxxxxxxxx", redirectUri: "https://allevia.example/api/connectors/google/callback", connectorKey: KEY };
const WEB = "https://allevia.example";
const NOW = Date.parse("2026-10-15T00:00:00Z") + 3_600_000; // the harness clock

describe("server: connect Search Console (integration)", () => {
  let h: Harness;
  let dir: string;
  let google: FakeGoogle;
  let app: Harness["app"];
  let off: Harness["app"];

  beforeAll(async () => {
    h = await harness();
    dir = mkdtempSync(join(tmpdir(), "allevia-conn-"));
    google = new FakeGoogle({
      codes: { good: tokens("one"), "no-scope": tokens("two", { scope: "openid" }) },
      sites: [{ siteUrl: "sc-domain:aamdani.example", permissionLevel: "siteOwner" }],
      analytics: analyticsFor({ pages: ["https://www.aamdani.example/jobs"], queries: ["jobs in raipur"] }),
    });
    const deps: GoogleDeps = { settings: googleSettings(CONFIG), store: new FileTokenStore(dir, KEY), client: google, now: () => NOW };
    app = h.make({ google: async () => ({ deps, webBaseUrl: WEB }) });
    off = h.make({ google: async () => ({ deps: { ...deps, settings: googleSettings({ redirectUri: CONFIG.redirectUri }), client: new FakeGoogle() }, webBaseUrl: WEB }) });
  }, 90_000);
  afterAll(async () => { await h.cleanup(); rmSync(dir, { recursive: true, force: true }); });

  const status = async (a = app) => (await a.request("/api/mini/connectors/search-console")).json() as Promise<{ state: string; message: string; property?: string; missing?: string[]; capabilityMode?: string }>;
  const startState = async () => {
    const res = await post(app, "/api/mini/connectors/search-console/connect", {});
    expect(res.status, await res.clone().text()).toBe(200);
    const { url } = (await res.json()) as { url: string };
    expect(url.startsWith("https://accounts.google.com/o/oauth2/v2/auth?")).toBe(true);
    return new URL(url).searchParams.get("state")!;
  };
  const callback = (query: Record<string, string>) => app.request(`/api/connectors/google/callback?${new URLSearchParams(query).toString()}`, { redirect: "manual" });

  it("says plainly it isn't switched on, and never asks Google, when the server has no credentials (or no Google wiring)", async () => {
    expect(await status(off)).toMatchObject({ state: "not_configured", message: expect.stringMatching(/isn't switched on yet/), missing: expect.arrayContaining(["Allevia's Google client ID"]) });
    const bare = await h.app.request("/api/mini/connectors/search-console"); // no wiring at all
    expect(await bare.json()).toEqual({ state: "not_configured", message: expect.stringMatching(/isn't switched on yet/) });
    const res = await post(off, "/api/mini/connectors/search-console/connect", {});
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(/isn't switched on yet/);
    expect(google.calls).toEqual([]);
  });

  it("starts as not connected", async () => {
    expect(await status()).toMatchObject({ state: "not_connected" });
  });

  it("a returning link that is forged, or was never made here, is turned away in words", async () => {
    const forged = await callback({ code: "good", state: "forged.state" });
    expect(forged.status).toBe(400);
    expect(((await forged.json()) as { error: string }).error).toMatch(/run out, or it didn't come from the app/);
    expect((await callback({ code: "good" })).status).toBe(400);
  });

  it("when the owner says no on Google's page, they land back in the app and nothing is stored", async () => {
    const res = await callback({ error: "access_denied", state: await startState() });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${WEB}/?connect=search-console&result=denied`);
    expect(await status()).toMatchObject({ state: "not_connected" });
  });

  it("a sign-in without the Search Console permission lands back with the reason, and stores nothing", async () => {
    const res = await callback({ code: "no-scope", state: await startState() });
    expect(res.headers.get("location")).toBe(`${WEB}/?connect=search-console&result=problem&reason=missing_scope`);
    expect(await status()).toMatchObject({ state: "not_connected" });
  });

  it("connects: the first read happens, and Search Console now reads 'api' in the capability ladder", async () => {
    const res = await callback({ code: "good", state: await startState() });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${WEB}/?connect=search-console&result=connected`);
    const s = await status();
    expect(s).toMatchObject({ state: "connected", property: "sc-domain:aamdani.example", capabilityMode: "api" });
    expect(s.message).toMatch(/^Reading sc-domain:aamdani.example from Google\. The newest numbers are from 2026-10-12\./);
    const caps = (await (await app.request("/api/mini/capabilities")).json()) as CapabilityState[];
    expect(caps.find((c) => c.key === "search_console")).toMatchObject({ accessMode: "api", status: "ok" });
  });

  it("the same state cannot be used twice", async () => {
    const state = await startState();
    expect((await callback({ code: "good", state })).status).toBe(302);
    expect((await callback({ code: "good", state })).status).toBe(400);
  });

  it("reads now on request", async () => {
    const res = await post(app, "/api/mini/connectors/search-console/pull", {});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", property: "sc-domain:aamdani.example", through: "2026-10-12" });
  });

  it("disconnects: back to not connected, the access revoked at Google", async () => {
    const res = await post(app, "/api/mini/connectors/search-console/disconnect", {});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: "not_connected" });
    expect(google.revoked).toHaveLength(1);
  });

  it("with several websites on the account, the owner picks one; one the account cannot read is refused", async () => {
    google.script.sites = [{ siteUrl: "https://a.example/", permissionLevel: "siteOwner" }, { siteUrl: "https://b.example/", permissionLevel: "siteOwner" }];
    const res = await callback({ code: "good", state: await startState() });
    expect(res.headers.get("location")).toBe(`${WEB}/?connect=search-console&result=choose`);
    expect(await status()).toMatchObject({ state: "choose_property", sites: ["https://a.example/", "https://b.example/"] } as object);
    const bad = await post(app, "/api/mini/connectors/search-console/property", { siteUrl: "https://nope.example/" });
    expect(bad.status).toBe(404);
    expect(((await bad.json()) as { error: string }).error).toMatch(/isn't one your Google account can read/);
    const ok = await post(app, "/api/mini/connectors/search-console/property", { siteUrl: "https://b.example/" });
    expect(await ok.json()).toMatchObject({ state: "connected", property: "https://b.example/" });
  });

  it("public mode refuses every write and the callback, and unknown businesses are a 404", async () => {
    const deps: GoogleDeps = { settings: googleSettings(CONFIG), store: new FileTokenStore(dir, KEY), client: google, now: () => NOW };
    const pub = h.make({ publicMode: true, google: async () => ({ deps, webBaseUrl: WEB }) });
    for (const p of ["connect", "pull", "disconnect", "property"]) expect((await post(pub, `/api/mini/connectors/search-console/${p}`, { siteUrl: "https://a.example/" })).status).toBe(403);
    expect((await pub.request("/api/connectors/google/callback?code=x&state=y", { redirect: "manual" })).status).toBe(403);
    expect((await app.request("/api/nobody/connectors/search-console")).status).toBe(404);
  });
});
