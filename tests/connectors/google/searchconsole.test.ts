// The Search Console connector against a fake Google: connect (OAuth shape), tokens sealed per tenant, the daily pull into
// Observations, the ladder reading "api", the Search clicks goal flipping to a real number, refresh, expiry and disconnect.
// Nothing here reaches Google or needs a credential: the client is a fake and the real one refuses to run under vitest.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAll, openGraphByName, type GraphHandle } from "../../../src/graph/client.js";
import { businessId as bizIdOf } from "../../../src/graph/tenants.js";
import { upsertNode } from "../../../src/graph/upsert.js";
import { deriveCapabilities } from "../../../src/capabilities/ladder.js";
import { verifyState } from "../../../src/connectors/google/crypto.js";
import {
  authorizationUrl, chooseProperty, connectionStatus, disconnectSearchConsole, handleCallback, matchProperty, pullSearchConsole, tenantFromState,
  CONNECTOR, ConnectError, SCOPE, type GoogleDeps,
} from "../../../src/connectors/google/searchconsole.js";
import { googleSettings, NotConfiguredError } from "../../../src/connectors/google/settings.js";
import { FileTokenStore } from "../../../src/connectors/google/store.js";
import { scanGraph } from "../../../src/ingest/privacy.js";
import { onboard } from "../../../src/onboard/onboard.js";
import { getProgram } from "../../../src/program/scorecard.js";
import { analyticsFor, FakeGoogle, READONLY, tokens } from "../../helpers/fake-google.js";
import { testGraph } from "../../helpers/graph.js";

const KEY = "test-connector-key-0123456789abcdef0123456789abcdef";
const CONFIG = { clientId: "test-client-id.apps.example", clientSecret: "test-client-secret-xxxxxxxxxxxx", redirectUri: "https://allevia.example/api/connectors/google/callback", connectorKey: KEY };
const NOW0 = Date.parse("2026-10-15T09:00:00Z");
const DAY = 86_400_000;

describe("settings, in plain words", () => {
  it("lists exactly what the founder still has to set up, and never an owner-facing env name", () => {
    expect(googleSettings({ redirectUri: "https://x.example/cb" })).toMatchObject({
      configured: false,
      missing: [
        { setting: "ALLEVIA_GOOGLE_CLIENT_ID", words: "Allevia's Google client ID" }, { setting: "ALLEVIA_GOOGLE_CLIENT_SECRET", words: "Allevia's Google client secret" },
        { setting: "ALLEVIA_CONNECTOR_KEY", words: expect.stringMatching(/key that locks stored Google access/) },
      ],
    });
    expect(googleSettings({ ...CONFIG, connectorKey: "too short" }).missing.map((m) => m.setting)).toEqual(["ALLEVIA_CONNECTOR_KEY"]);
    expect(googleSettings(CONFIG)).toMatchObject({ configured: true, missing: [] });
  });
});

describe("matching the business's website among its properties", () => {
  const site = (siteUrl: string, permissionLevel = "siteOwner") => ({ siteUrl, permissionLevel });
  it("prefers the domain property, then the https address on its own host, and asks when it cannot tell", () => {
    expect(matchProperty([site("https://other.example/"), site("sc-domain:kestrel.example"), site("https://www.kestrel.example/")], "www.kestrel.example")).toEqual({ site: "sc-domain:kestrel.example" });
    expect(matchProperty([site("https://www.kestrel.example/"), site("https://kestrel.example/")], "www.kestrel.example")).toEqual({ site: "https://www.kestrel.example/" });
    expect(matchProperty([site("https://www.kestrel.example/"), site("https://kestrel.example/")], "kestrel.example")).toEqual({ site: "https://kestrel.example/" });
    expect(matchProperty([site("https://www.kestrel.example/"), site("https://m.kestrel.example/")], "shop.example")).toEqual({ choose: ["https://www.kestrel.example/", "https://m.kestrel.example/"] });
    expect(matchProperty([site("https://kestrel.example/", "siteUnverifiedUser")], "kestrel.example")).toEqual({ none: true });
    expect(matchProperty([site("https://kestrel.example/")], null)).toEqual({ site: "https://kestrel.example/" });
    expect(matchProperty([], "kestrel.example")).toEqual({ none: true });
  });
});

describe("Search Console connector (integration)", () => {
  let g: GraphHandle;
  let gOther: GraphHandle;
  let cleanup: () => Promise<void>;
  let cleanupOther: () => Promise<void>;
  let dir: string;
  let slug: string;
  let biz: string;
  let metaGraph: string;
  let clock = NOW0;
  let store: FileTokenStore;
  let google: FakeGoogle;
  let deps: GoogleDeps;

  const q = <T = Record<string, unknown>>(cypher: string, params?: Record<string, unknown>) => g.roQuery<T>(cypher, params);
  const searchMode = async () => (await deriveCapabilities(g, { now: clock, businessId: biz })).find((c) => c.key === "search_console")!;
  const connect = async (code = "code-1") => handleCallback(deps, g, slug, code, biz);

  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    ({ g: gOther, cleanup: cleanupOther } = await testGraph());
    await upsertNode(gOther, { type: "Business", id: "business:other-shop", name: "Other Shop" }, NOW0);
    dir = mkdtempSync(join(tmpdir(), "allevia-gsc-"));
    slug = g.name.replace(/^allevia_/, "");
    biz = bizIdOf(slug);
    metaGraph = `allevia_test_meta_${slug.slice(5)}`;
    await upsertNode(g, { type: "Business", id: biz, name: "Kestrel Dental", props: { domain: "kestrel.example" } }, NOW0 - 30 * DAY);
    for (const p of ["services", "team"]) await upsertNode(g, { type: "Page", id: `page:www.kestrel.example/${p}`, name: p, props: { url: `https://www.kestrel.example/${p}` } }, NOW0 - 30 * DAY);
    await onboard({ name: "Kestrel Dental", slug, website: false, industry: "dental clinic", country: "United Kingdom", domain: "kestrel.example" }, () => undefined,
      { tenantOpts: { metaGraph }, now: () => NOW0, dataDir: `/tmp/${slug}-unused`, model: "haiku" });
    store = new FileTokenStore(dir, KEY);
    google = new FakeGoogle({
      codes: { "code-1": tokens("one"), "code-no-refresh": tokens("two", { refreshToken: undefined }), "code-no-scope": tokens("three", { scope: "openid email" }) },
      sites: [{ siteUrl: "sc-domain:kestrel.example", permissionLevel: "siteOwner" }, { siteUrl: "https://other.example/", permissionLevel: "siteOwner" }],
      analytics: analyticsFor({
        pages: ["https://www.kestrel.example/services", "https://www.kestrel.example/team", "https://www.kestrel.example/not-crawled"],
        queries: ["dentist tiffin", "emergency dentist", "call jane@example.com dentist"], quietDays: ["2026-10-01"],
      }),
    });
    deps = { settings: googleSettings(CONFIG), store, client: google, now: () => clock };
  }, 90_000);

  afterAll(async () => {
    await cleanup();
    await cleanupOther();
    await (await openGraphByName(metaGraph)).drop().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
    await closeAll();
  });

  // ---------- not configured ----------

  it("says in plain words what is missing, and does nothing, when the server has no Google credentials", async () => {
    const off: GoogleDeps = { ...deps, settings: googleSettings({ redirectUri: CONFIG.redirectUri }), client: new FakeGoogle() };
    const s = await connectionStatus(off, g, slug, biz);
    expect(s.state).toBe("not_configured");
    expect(s.message).toBe("Connecting Search Console isn't switched on yet. Your team is setting up Allevia's Google access and will let you know when it's ready.");
    expect(s.missing).toEqual(["Allevia's Google client ID", "Allevia's Google client secret", expect.stringMatching(/key that locks stored Google access/)]);
    expect(() => authorizationUrl(off, slug)).toThrow(NotConfiguredError);
    expect(await pullSearchConsole(off, g, slug)).toMatchObject({ status: "not_connected" });
    expect((off.client as FakeGoogle).calls).toEqual([]);
  });

  // ---------- connecting ----------

  it("before anyone connects: not connected, and the ladder says what a connection would add", async () => {
    expect(await connectionStatus(deps, g, slug, biz)).toMatchObject({ state: "not_connected", message: expect.stringMatching(/^Connect Search Console/) });
    expect((await searchMode()).accessMode).not.toBe("api");
  });

  it("builds the Google address: client, redirect, read-only scope, offline access, and a state that names the tenant", () => {
    const url = new URL(authorizationUrl(deps, slug));
    expect(`${url.origin}${url.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries([...url.searchParams].filter(([k]) => k !== "state"))).toEqual({
      client_id: CONFIG.clientId, redirect_uri: CONFIG.redirectUri, response_type: "code", scope: "https://www.googleapis.com/auth/webmasters.readonly",
      access_type: "offline", prompt: "consent", include_granted_scopes: "true",
    });
    expect(SCOPE).toBe(READONLY);
    expect(verifyState(KEY, url.searchParams.get("state")!)).toMatchObject({ t: slug });
  });

  it("accepts a returning state once, while it is fresh, and never a forged, old or moved one", () => {
    const fresh = new URL(authorizationUrl(deps, slug)).searchParams.get("state")!;
    expect(tenantFromState(deps, fresh)).toBe(slug);
    expect(tenantFromState(deps, fresh)).toBeNull(); // used
    expect(tenantFromState(deps, `${fresh.slice(0, -3)}AAA`)).toBeNull(); // forged
    const old = new URL(authorizationUrl(deps, slug)).searchParams.get("state")!;
    clock += 11 * 60_000;
    expect(tenantFromState(deps, old)).toBeNull(); // expired
    clock -= 11 * 60_000;
    const other = new URL(authorizationUrl({ ...deps, settings: googleSettings({ ...CONFIG, connectorKey: `${KEY}-another` }) }, slug)).searchParams.get("state")!;
    expect(tenantFromState(deps, other)).toBeNull(); // signed with another key
    expect(tenantFromState(deps, "not-a-state")).toBeNull();
  });

  it("refuses a sign-in that left out the permission, or that gave no lasting access, and stores nothing", async () => {
    await expect(connect("code-no-scope")).rejects.toThrow(ConnectError);
    await expect(connect("code-no-scope")).rejects.toThrow(/permission to read your Search Console/);
    await expect(connect("code-no-refresh")).rejects.toThrow(/lasting access/);
    await expect(connect("bad-code")).rejects.toThrow(/did not accept that sign-in/);
    expect(await store.get(slug, CONNECTOR)).toBeNull();
  });

  it("connects: the code becomes tokens sealed on disk, the property is picked, and the graph holds no token", async () => {
    const r = await connect("code-1");
    expect(r).toEqual({ state: "connected", property: "sc-domain:kestrel.example" });
    expect(await store.get(slug, CONNECTOR)).toMatchObject({ refreshToken: "refresh-token-one-BBBBBBBBBBBBBB", scope: READONLY, expiresAt: NOW0 + 3_600_000 });
    // on disk: only the sealed file, and nothing readable in it
    const files = readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith(".sealed"));
    expect(files).toEqual([`connectors/${slug}/search-console.sealed`]);
    expect(readFileSync(join(dir, files[0]!), "utf8")).not.toMatch(/token|webmasters/);
    // in the graph: the System node says it is connected, never the tokens
    const [sys] = await q<{ status: string; property: string }>("MATCH (s:System {id:'system:search-console'}) RETURN s.status AS status, s.property AS property");
    expect(sys).toEqual({ status: "ok", property: "sc-domain:kestrel.example" });
    const everything = JSON.stringify(await q("MATCH (n) RETURN properties(n) AS p"));
    expect(everything).not.toMatch(/-token-/);
    expect(await connectionStatus(deps, g, slug, biz)).toMatchObject({ state: "connected", property: "sc-domain:kestrel.example" });
  });

  it("another business has nothing: its own graph, its own (empty) token folder", async () => {
    expect(await store.get("other_shop", CONNECTOR)).toBeNull();
    expect(await gOther.roQuery<{ c: number }>("MATCH (s:System) RETURN count(s) AS c")).toEqual([{ c: 0 }]);
    expect(await connectionStatus({ ...deps, store }, gOther, "other_shop")).toMatchObject({ state: "not_connected" });
  });

  // ---------- the daily pull ----------

  it("pulls: daily numbers with the quiet day as zero, known pages, safe searches; the ladder reads api and the goal a number", async () => {
    google.calls.length = 0;
    const r = await pullSearchConsole(deps, g, slug, { businessId: biz });
    expect(r).toMatchObject({ status: "ok", property: "sc-domain:kestrel.example", through: "2026-10-12", days: 90, zeroDays: 1, pages: 2, skippedPages: 1, queries: 2 });
    // three reads: by date, by page, by query; the first from 90 days back
    const asked = google.calls.filter((c) => c.op === "searchAnalytics").map((c) => c.args[2] as { startDate: string; endDate: string; dimensions: string[] });
    expect(asked).toEqual([
      { startDate: "2026-07-15", endDate: "2026-10-12", dimensions: ["date"], rowLimit: 1000 },
      { startDate: "2026-09-15", endDate: "2026-10-12", dimensions: ["page"], rowLimit: 250 },
      { startDate: "2026-09-15", endDate: "2026-10-12", dimensions: ["query"], rowLimit: 50 },
    ]);
    expect(google.calls.every((c) => c.op !== "searchAnalytics" || c.args[0] === tokens("one").accessToken)).toBe(true);

    const [daily] = await q<{ c: number; zero: number }>("MATCH (o:Observation {metric:'gsc_clicks'})-[:MEASURES]->(:Channel {id:'channel:google-search'}) RETURN count(o) AS c, sum(CASE WHEN o.value = 0 THEN 1 ELSE 0 END) AS zero");
    expect(daily).toEqual({ c: 90, zero: 1 });
    const [quiet] = await q<{ v: number; src: string; asOf: string; conf: number | null }>("MATCH (o:Observation {id:'obs:gsc_clicks:channel:google-search:2026-10-01'}) RETURN o.value AS v, o.src AS src, o.asOf AS asOf, o.conf AS conf");
    expect(quiet).toEqual({ v: 0, src: "document:gsc-pull-2026-10-15", asOf: "2026-10-15", conf: null });
    expect(await q("MATCH (o:Observation {id:'obs:gsc_ctr_pct:channel:google-search:2026-10-01'}) RETURN o.id")).toEqual([]); // no rate for a day with no impressions
    // pages: the crawl's own pages only; searches: the one carrying an email address is dropped
    const pageRows = await q<{ s: string; v: number; ws: string; we: string }>("MATCH (o:Observation {metric:'gsc_clicks'})-[:MEASURES]->(p:Page) RETURN p.id AS s, o.value AS v, o.windowStart AS ws, o.windowEnd AS we ORDER BY p.id");
    expect(pageRows).toEqual([{ s: "page:www.kestrel.example/services", v: 40, ws: "2026-09-15", we: "2026-10-12" }, { s: "page:www.kestrel.example/team", v: 35, ws: "2026-09-15", we: "2026-10-12" }]);
    expect((await q<{ n: string }>("MATCH (x:Query) RETURN x.name AS n ORDER BY x.id")).map((x) => x.n)).toEqual(["dentist tiffin", "emergency dentist"]);
    expect(await scanGraph(g)).toEqual([]);

    // the ladder: live connector data, under 7 days old
    const cap = await searchMode();
    expect(cap).toMatchObject({ accessMode: "api", status: "ok" });
    expect(cap.lastOkAt).not.toBeNull();
    expect(cap.upgradeHint).toMatch(/Connected and current/);

    // the goal: "Search clicks" read "We'll know after your first full week"; now it reads the last 28 days, measured
    const goal = (await getProgram(g, { now: clock, businessId: biz }))!.goals.find((x) => x.metricKey === "gsc_clicks")!;
    const days = Array.from({ length: 28 }, (_, i) => new Date(Date.parse("2026-10-12T00:00:00Z") - i * DAY).toISOString().slice(0, 10));
    const expected = days.reduce((s, d) => s + (d === "2026-10-01" ? 0 : 10 + (Number(d.slice(8)) % 5)), 0); // the quiet day had no clicks
    expect(goal).toMatchObject({ current: expected, currentAt: "2026-10-12", baseline: expected, baselineConf: "measured" });
    expect(goal.status).not.toBe("no_data");
  });

  it("pulling again the same day writes nothing new", async () => {
    const versions = (await q<{ c: number }>("MATCH (v:Version) RETURN count(v) AS c"))[0]!.c;
    const nodes = (await q<{ c: number }>("MATCH (n) RETURN count(n) AS c"))[0]!.c;
    google.calls.length = 0;
    const r = await pullSearchConsole(deps, g, slug, { businessId: biz });
    expect(r.status).toBe("ok");
    // only the last days are re-read, with a few days' overlap, because Google revises them
    expect((google.calls.find((c) => c.op === "searchAnalytics")!.args[2] as { startDate: string }).startDate).toBe("2026-10-09");
    expect((await q<{ c: number }>("MATCH (v:Version) RETURN count(v) AS c"))[0]!.c).toBe(versions);
    expect((await q<{ c: number }>("MATCH (n) RETURN count(n) AS c"))[0]!.c).toBe(nodes);
  });

  it("the next day: only the new days are added, a revised number keeps its earlier value, the access token is refreshed once", async () => {
    clock += 2 * DAY; // the 17th; the access token (1 hour) has run out
    google.script.analytics = analyticsFor({ pages: ["https://www.kestrel.example/services"], queries: ["dentist tiffin"], clicksOn: (d) => (d === "2026-10-10" ? 99 : 10 + (Number(d.slice(8)) % 5)) });
    google.calls.length = 0;
    const r = await pullSearchConsole(deps, g, slug, { businessId: biz });
    expect(r).toMatchObject({ status: "ok", through: "2026-10-14" });
    expect(google.calls.filter((c) => c.op === "refresh")).toHaveLength(1);
    expect(google.calls.filter((c) => c.op === "searchAnalytics")[0]!.args[0]).toMatch(/^fresh-access-token-1-/);
    const stored = await store.get(slug, CONNECTOR);
    expect(stored).toMatchObject({ refreshToken: "refresh-token-one-BBBBBBBBBBBBBB", accessToken: expect.stringMatching(/^fresh-access-token-1-/) }); // Google gave no new refresh token: the old one stays
    expect((await q<{ v: number }>("MATCH (o:Observation {id:'obs:gsc_clicks:channel:google-search:2026-10-10'}) RETURN o.value AS v"))[0]!.v).toBe(99);
    const hist = await q<{ props: string }>("MATCH (:Observation {id:'obs:gsc_clicks:channel:google-search:2026-10-10'})-[:HAD_VERSION]->(v:Version) RETURN v.props AS props");
    expect(hist.map((h) => (JSON.parse(h.props) as { value: number }).value)).toEqual([10 + (10 % 5)]);
    // a second pull while the token is fresh does not refresh again
    google.calls.length = 0;
    await pullSearchConsole(deps, g, slug, { businessId: biz });
    expect(google.calls.filter((c) => c.op === "refresh")).toHaveLength(0);
  });

  it("a rate limit or a Google outage is recorded and retried later: the capability stays live and nothing half-written", async () => {
    clock += DAY;
    const before = (await q<{ c: number }>("MATCH (o:Observation) RETURN count(o) AS c"))[0]!.c;
    google.failAnalytics = "api";
    const r = await pullSearchConsole(deps, g, slug, { businessId: biz });
    expect(r).toMatchObject({ status: "error", message: "Google is busy or slow right now. We will try again tomorrow." });
    google.failAnalytics = null;
    expect((await q<{ c: number }>("MATCH (o:Observation) RETURN count(o) AS c"))[0]!.c).toBe(before);
    expect((await searchMode()).accessMode).toBe("api");
    expect(await connectionStatus(deps, g, slug, biz)).toMatchObject({ state: "connected", message: expect.stringMatching(/last try had a problem/) });
    await pullSearchConsole(deps, g, slug, { businessId: biz }); // and the next try clears it
    expect(await connectionStatus(deps, g, slug, biz)).toMatchObject({ message: expect.not.stringMatching(/last try had a problem/) });
  });

  it("when Google refuses the refresh, the connection is marked expired in words, the ladder drops a rung, and connecting again restores it", async () => {
    clock += 2 * DAY;
    google.failRefresh = "auth";
    const r = await pullSearchConsole(deps, g, slug, { businessId: biz });
    expect(r).toEqual({ status: "needs_reconnect", message: "Google stopped letting us read Search Console (the access was removed or has run out). Connect it again." });
    google.failRefresh = null;
    expect(await connectionStatus(deps, g, slug, biz)).toMatchObject({ state: "needs_reconnect", message: expect.stringMatching(/Connect it again/) });
    const cap = await searchMode();
    expect(cap.accessMode).not.toBe("api");
    expect(cap.status).toBe("down");
    await connect("code-1");
    expect(await connectionStatus(deps, g, slug, biz)).toMatchObject({ state: "connected" });
    expect((await pullSearchConsole(deps, g, slug, { businessId: biz })).status).toBe("ok");
    expect((await searchMode()).accessMode).toBe("api");
  });

  it("disconnect forgets the tokens and asks Google to revoke them; what was already read stays", async () => {
    const stored = (await store.get(slug, CONNECTOR))!;
    await disconnectSearchConsole(deps, g, slug);
    expect(google.revoked).toEqual([stored.refreshToken]);
    expect(await store.get(slug, CONNECTOR)).toBeNull();
    expect(await connectionStatus(deps, g, slug, biz)).toMatchObject({ state: "not_connected" });
    expect((await pullSearchConsole(deps, g, slug)).status).toBe("not_connected");
    expect((await q<{ c: number }>("MATCH (o:Observation {metric:'gsc_clicks'}) RETURN count(o) AS c"))[0]!.c).toBeGreaterThan(90);
  });

  it("asks which website when the account has no clear match, and refuses one the account cannot read", async () => {
    google.script.sites = [{ siteUrl: "https://a.example/", permissionLevel: "siteOwner" }, { siteUrl: "https://b.example/", permissionLevel: "siteFullUser" }];
    expect(await connect("code-1")).toEqual({ state: "choose_property" });
    expect(await connectionStatus(deps, g, slug, biz)).toMatchObject({ state: "choose_property", sites: ["https://a.example/", "https://b.example/"] });
    expect(await pullSearchConsole(deps, g, slug)).toMatchObject({ status: "needs_property" });
    await expect(chooseProperty(deps, g, slug, "https://not-mine.example/")).rejects.toThrow(/isn't one your Google account can read/);
    await chooseProperty(deps, g, slug, "https://b.example/");
    expect(await connectionStatus(deps, g, slug, biz)).toMatchObject({ state: "connected", property: "https://b.example/" });
  });
});
