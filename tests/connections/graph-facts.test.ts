// A connection is a fact in the business's own graph (graph audit G6): the System says when it was connected and by whom, how
// many facts its last read wrote and how it stands (each change of status leaves a Version); the business OWNS it, the channel it
// feeds DEPENDS_ON it, and each read's snapshot Document is PRODUCED by it, so "which numbers came from Instagram" is the
// traversal System -PRODUCED-> Document <-SOURCED_FROM- Observation. Every read is checked back with Cypher, on fakes only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findBusiness } from "../../src/capabilities/ladder.js";
import { closeAll } from "../../src/graph/client.js";
import { calendarFreeSlots, connectionRead, gmailInbox, gscReport } from "../../src/agent/tools/connections.js";
import { analyticsFor } from "../helpers/fake-google.js";
import { ga4Days } from "../helpers/fake-google-apis.js";
import { call, makeCtx } from "../helpers/tools.js";
import { connectVia, connHarness, grant, NOW, type ConnHarness } from "./harness.js";

const HOUR = 3_600_000;
const ISO = new Date(NOW).toISOString();
const TODAY = ISO.slice(0, 10);

let c: ConnHarness; // Composio, the main path
let o: ConnHarness; // our own Google app
let biz: string;

beforeAll(async () => {
  c = await connHarness({ via: "composio" });
  c.composio.results.set("INSTAGRAM_GET_USER_INFO", { data: { followers_count: 2340 } });
  c.composio.results.set("GOOGLECALENDAR_EVENTS_LIST", { items: [{ id: "a" }, { id: "b" }, { id: "c" }] });
  c.composio.results.set("STRIPE_RETRIEVE_BALANCE", { available: [{ amount: 123_456, currency: "usd" }] });
  c.composio.results.set("SHOPIFY_GET_ORDER_LIST", { orders: [{}, {}, {}, {}, {}] });
  c.composio.results.set("GMAIL_GET_PROFILE", { messagesTotal: 812 });
  c.composio.results.set("GOOGLE_SEARCH_CONSOLE_LIST_SITES", { siteEntry: [{ siteUrl: "sc-domain:shop.example", permissionLevel: "siteOwner" }] });
  c.composio.results.set("GOOGLE_SEARCH_CONSOLE_SEARCH_ANALYTICS_QUERY", { rows: [{ keys: ["2026-10-10"], clicks: 7, impressions: 90 }, { keys: ["2026-10-11"], clicks: 5, impressions: 60 }] });
  c.composio.results.set("GOOGLECALENDAR_FREE_BUSY_QUERY", { data: { calendars: { primary: { busy: [] } } } });
  c.composio.results.set("GMAIL_FETCH_EMAILS", { messages: [{ messageId: "m1", sender: "lead@client.example", subject: "Quote?", preview: "Can you send a quote", messageTimestamp: "2026-10-15" }] });
  c.composio.results.set("HUBSPOT_LIST_DEALS", { results: [{ id: "d1" }] });
  biz = (await findBusiness(c.g))!;

  o = await connHarness({ via: "own", apis: { properties: [{ property: "properties/111", displayName: "Shop site" }], ga4: ga4Days(), customers: [{ id: "1234567890" }], campaigns: [{ id: "1", name: "Search", status: "ENABLED", costMicros: 25_000_000, clicks: 100, impressions: 4000, conversions: 5 }] } });
  o.google.script.codes = { ga: grant("ga", "analytics.readonly"), ads: grant("ads", "adwords"), sc: grant("sc", "webmasters.readonly"), cal: grant("cal", "calendar.freebusy", "calendar.events"), gm: grant("gm", "gmail.send") };
  o.google.script.sites = [{ siteUrl: "sc-domain:aamdani.example", permissionLevel: "siteOwner" }];
  o.google.script.analytics = analyticsFor({ pages: [], queries: ["jobs in raipur"] });
}, 90_000);
afterAll(async () => { await c.cleanup(); await o.cleanup(); await closeAll(); });

async function connectC(tenant: string, id: string): Promise<void> {
  const { url } = await c.svc.connect(tenant, id);
  const link = c.composio.calls.filter((x) => x.op === "link").at(-1)!.args as { callbackUrl: string };
  const accountId = new URL(url).pathname.split("/").pop()!;
  c.composio.activate(accountId);
  const done = await c.svc.complete(new URL(link.callbackUrl).searchParams.get("state")!, { status: "success", connected_account_id: accountId });
  expect(done?.outcome.result).toBe("connected");
  await c.svc.pull(tenant, id); // the first look runs by itself; this joins it (or repeats it, which writes the same facts)
}

interface SystemRow {
  status: string | null; kind: string | null; provider: string | null; connector: string | null; connectedAt: number | null; connectedBy: string | null;
  factCount: number | null; lastPullAt: number | null; dataThrough: string | null; src: string | null; asOf: string | null; property: string | null;
}
const system = async (h: ConnHarness, id: string): Promise<SystemRow> => (await h.g.roQuery<SystemRow>(
  `MATCH (s:Entity:System {id:$id}) RETURN s.status AS status, s.kind AS kind, s.provider AS provider, s.connector AS connector, s.connectedAt AS connectedAt,
   s.connectedBy AS connectedBy, s.factCount AS factCount, s.lastPullAt AS lastPullAt, s.dataThrough AS dataThrough, s.src AS src, s.asOf AS asOf, s.property AS property`, { id }))[0]!;
const edge = async (h: ConnHarness, cypher: string, params: Record<string, unknown> = {}): Promise<number> =>
  (await h.g.roQuery<{ n: number }>(cypher, params))[0]!.n;

const owns = (h: ConnHarness, sys: string, from = biz) =>
  edge(h, "MATCH (b:Business {id:$b})-[r:OWNS]->(s:System {id:$s}) WHERE r.until IS NULL RETURN count(r) AS n", { b: from, s: sys });
const dependsOn = (h: ConnHarness, channel: string, sys: string) =>
  edge(h, "MATCH (c:Channel {id:$c})-[r:DEPENDS_ON]->(s:System {id:$s}) WHERE r.until IS NULL RETURN count(r) AS n", { c: channel, s: sys });
const produced = async (h: ConnHarness, sys: string) => h.g.roQuery<{ id: string; kind: string; provider: string; headline: string | null }>(
  "MATCH (s:System {id:$s})-[r:PRODUCED]->(d:Document) WHERE r.until IS NULL RETURN d.id AS id, d.kind AS kind, d.provider AS provider, d.headline AS headline ORDER BY d.id", { s: sys });
const versionsOf = async (h: ConnHarness, sys: string) => (await h.g.roQuery<{ props: string }>(
  "MATCH (:System {id:$s})-[:HAD_VERSION]->(v:Version) RETURN v.props AS props, v.since AS since, v.id AS id ORDER BY v.since, v.id", { s: sys })).map((v) => JSON.parse(v.props) as Record<string, unknown>);

describe("a Composio connection is a fact in the graph", () => {
  it("connecting records who, when and how it stands; the business owns it and the read is a node the System PRODUCED", async () => {
    await connectC("ig_shop", "instagram");
    const s = await system(c, "system:instagram");
    expect(s).toMatchObject({ status: "ok", kind: "connector", provider: "composio", connector: "instagram", connectedAt: NOW, connectedBy: "person:founder", factCount: 2, lastPullAt: NOW, src: "person:founder", asOf: ISO });
    expect(await owns(c, "system:instagram")).toBe(1);
    // the channel it feeds depends on it (the read made sure the channel exists first)
    expect(await dependsOn(c, "channel:instagram", "system:instagram")).toBe(1);
    // "which facts came from Instagram": System -PRODUCED-> Document <-SOURCED_FROM- Observation
    expect(await produced(c, "system:instagram")).toEqual([{ id: `document:first-read-instagram-${TODAY}`, kind: "snapshot", provider: "instagram", headline: "2,340 followers on Instagram" }]);
    const facts = await c.g.roQuery<{ metric: string; value: number }>(
      "MATCH (:System {id:'system:instagram'})-[:PRODUCED]->(d:Document)<-[:SOURCED_FROM]-(o:Observation)-[:MEASURES]->(:Channel {id:'channel:instagram'}) RETURN o.metric AS metric, o.value AS value ORDER BY o.id");
    expect(facts).toEqual([{ metric: "followers", value: 2340 }]);
    // no token anywhere on the node
    const [raw] = await c.g.roQuery<{ p: Record<string, unknown> }>("MATCH (s:System {id:'system:instagram'}) RETURN properties(s) AS p");
    expect(JSON.stringify(raw!.p)).not.toMatch(/token|secret|accountId|ca_\d/i);
  });

  it("each change of status leaves a Version: connected, expired, reconnected, removed", async () => {
    await connectC("hist_shop", "stripe");
    expect((await system(c, "system:stripe")).status).toBe("ok");
    // the connection service stops accepting the account: the health check says so and the graph keeps when
    c.clock.now = NOW + HOUR;
    const acct = [...c.composio.accounts.values()].find((a) => a.toolkit === "stripe")!;
    c.composio.accounts.set(acct.id, { ...acct, status: "INACTIVE" });
    expect((await c.svc.health("hist_shop", "stripe")).ok).toBe(false);
    expect(await system(c, "system:stripe")).toMatchObject({ status: "expired", asOf: new Date(NOW + HOUR).toISOString() });
    // the owner connects again
    c.clock.now = NOW + 2 * HOUR;
    c.composio.activate(acct.id);
    await connectC("hist_shop", "stripe");
    expect(await system(c, "system:stripe")).toMatchObject({ status: "ok", connectedAt: NOW + 2 * HOUR });
    c.clock.now = NOW + 3 * HOUR;
    await c.svc.disconnect("hist_shop", "stripe");
    const now = await system(c, "system:stripe");
    expect(now.status).toBe("not_connected");
    const seen = (await versionsOf(c, "system:stripe")).map((v) => v.status);
    expect(seen).toEqual(["ok", "expired", "ok"]); // what it was before each change
    const [gone] = await c.g.roQuery<{ at: number | null }>("MATCH (s:System {id:'system:stripe'}) RETURN s.disconnectedAt AS at");
    expect(gone!.at).toBe(NOW + 3 * HOUR);
    c.clock.now = NOW;
  });

  it("Search Console's read writes its numbers, and its channels (Google Search and the website) depend on it", async () => {
    await connectC("gsc_fact_shop", "search-console");
    const s = await system(c, "system:search-console");
    expect(s).toMatchObject({ status: "ok", provider: "composio", factCount: 5 }); // 2 days x (clicks, impressions) + the snapshot
    expect(s.dataThrough).toBe("2026-10-12");
    expect(await dependsOn(c, "channel:google-search", "system:search-console")).toBe(1);
    expect(await dependsOn(c, "channel:website", "system:search-console")).toBe(1);
    const n = await edge(c, "MATCH (:System {id:'system:search-console'})-[:PRODUCED]->(:Document)<-[:SOURCED_FROM]-(o:Observation) RETURN count(o) AS n");
    expect(n).toBe(4);
  });

  it("Calendar, Gmail, Stripe and Shopify, which wrote no facts before, each leave a snapshot Document and the number they computed", async () => {
    const cases: Array<[string, string, string, string, number, string]> = [
      ["google-calendar", "system:google-calendar", "calendar", "meetings_next_7d", 3, "3 meetings on your calendar in the next 7 days"],
      ["gmail", "system:gmail", "gmail", "gmail_messages_total", 812, "812 emails in your mailbox"],
      ["shopify", "system:shopify", "shopify", "shopify_orders_7d", 5, "5 orders in the last 7 days"],
    ];
    for (const [id, sys, provider, metric, value, headline] of cases) {
      await connectC("firstfacts_shop", id);
      expect(await produced(c, sys), id).toEqual([{ id: `document:first-read-${provider}-${TODAY}`, kind: "snapshot", provider, headline }]);
      const m = await c.g.roQuery<{ metric: string; value: number; doc: string }>(
        "MATCH (:System {id:$s})-[:PRODUCED]->(d:Document)<-[:SOURCED_FROM]-(o:Observation)-[:MEASURES]->(:System {id:$s}) RETURN o.metric AS metric, o.value AS value, d.id AS doc", { s: sys });
      expect(m, id).toEqual([{ metric, value, doc: `document:first-read-${provider}-${TODAY}` }]);
      expect(await system(c, sys), id).toMatchObject({ status: "ok", factCount: 2, connectedBy: "person:founder" });
      expect(await owns(c, sys), id).toBe(1);
    }
    // Stripe's balance is in dollars, not cents
    await connectC("firstfacts_shop", "stripe");
    const [bal] = await c.g.roQuery<{ v: number; e: string }>("MATCH (o:Observation {metric:'stripe_balance_available'}) RETURN o.value AS v, o.evidence AS e");
    expect(bal).toEqual({ v: 1234.56, e: "1,235 USD available in your balance" });
  });

  it("a read repeated the same day writes the same nodes again, not new ones", async () => {
    const count = () => edge(c, "MATCH (d:Document) WHERE d.id STARTS WITH 'document:first-read-' RETURN count(d) AS n");
    const before = await count();
    await c.svc.pull("ig_shop", "instagram");
    await c.svc.pull("firstfacts_shop", "gmail");
    expect(await count()).toBe(before);
    expect(await edge(c, "MATCH (:System {id:'system:instagram'})-[r:PRODUCED]->(:Document) RETURN count(r) AS n")).toBe(1);
  });
});

describe("our own Google app writes the same facts", () => {
  it("Analytics: the read is a Document the System PRODUCED, the website depends on the System, and the property is kept", async () => {
    const r = await connectVia(o, "own_ga_shop", "google-analytics", "ga");
    expect(r.done?.outcome.result).toBe("connected");
    expect((await o.svc.pull("own_ga_shop", "google-analytics")).ok).toBe(true);
    const s = await system(o, "system:ga4");
    expect(s).toMatchObject({ status: "ok", provider: "google", connector: "google-analytics", connectedBy: "person:founder", property: "properties/111", dataThrough: "2026-10-14" });
    expect(s.factCount).toBe(28 * 3 + 1);
    expect(await owns(o, "system:ga4")).toBe(1);
    expect(await dependsOn(o, "channel:website", "system:ga4")).toBe(1);
    expect(await produced(o, "system:ga4")).toMatchObject([{ id: `document:ga4-pull-${TODAY}`, kind: "snapshot", provider: "ga4" }]);
    const n = await edge(o, "MATCH (:System {id:'system:ga4'})-[:PRODUCED]->(:Document)<-[:SOURCED_FROM]-(x:Observation {metric:'ga4_sessions'}) RETURN count(x) AS n");
    expect(n).toBe(28);
  });

  it("Ads and Search Console: the channel is made by the read and linked after it; the legacy reader's snapshot is PRODUCED too", async () => {
    await connectVia(o, "own_ads_shop", "google-ads", "ads");
    expect((await o.svc.pull("own_ads_shop", "google-ads")).ok).toBe(true);
    expect(await system(o, "system:google-ads")).toMatchObject({ status: "ok", factCount: 5, property: null });
    expect(await dependsOn(o, "channel:google-ads", "system:google-ads")).toBe(1);

    const sc = await connectVia(o, "own_sc_shop", "search-console", "sc");
    expect(sc.done?.outcome.result).toBe("connected");
    expect((await o.svc.pull("own_sc_shop", "search-console")).ok).toBe(true);
    const s = await system(o, "system:search-console");
    expect(s).toMatchObject({ status: "ok", provider: "google", connectedBy: "person:founder", property: "sc-domain:aamdani.example" });
    expect(s.factCount).toBeGreaterThan(1);
    expect(await owns(o, "system:search-console")).toBe(1);
    expect(await dependsOn(o, "channel:google-search", "system:search-console")).toBe(1);
    expect(await dependsOn(o, "channel:website", "system:search-console")).toBe(1);
    expect(await produced(o, "system:search-console")).toMatchObject([{ id: `document:gsc-pull-${TODAY}`, kind: "snapshot", provider: "search-console" }]);
  });

  it("Calendar and Gmail: connecting is recorded, going to 'needs attention' is a Version, and disconnecting says not_connected", async () => {
    await connectVia(o, "own_cal_shop", "google-calendar", "cal");
    expect(await system(o, "system:google-calendar")).toMatchObject({ status: "ok", connectedBy: "person:founder", provider: "google" });
    o.google.failRefresh = "auth";
    o.clock.now = NOW + 2 * HOUR;
    await expect(o.svc.port("own_cal_shop").run("google-calendar", "find free times", async () => 1)).rejects.toThrow(/connect it again/i);
    o.google.failRefresh = null;
    expect(await system(o, "system:google-calendar")).toMatchObject({ status: "expired" });
    o.clock.now = NOW + 3 * HOUR;
    await o.svc.disconnect("own_cal_shop", "google-calendar");
    expect(await system(o, "system:google-calendar")).toMatchObject({ status: "not_connected" });
    expect((await versionsOf(o, "system:google-calendar")).map((v) => v.status)).toEqual(["ok", "expired"]);
    o.clock.now = NOW;
  });

  it("the Search Console that was connected here can be removed: the System says not_connected, not 'disconnected' (which the ladder reads as broken)", async () => {
    await o.svc.disconnect("own_sc_shop", "search-console");
    expect((await system(o, "system:search-console")).status).toBe("not_connected");
  });
});

describe("a live read is a node the turn touched", () => {
  const ctxC = (over = {}) => makeCtx(c.g, { tenant: "live_shop", agentId: "chief-of-staff", now: NOW, turnId: "turn:t-live-1", connections: c.svc.port("live_shop"), ...over });

  it("gsc_report, calendar_free_slots, gmail_inbox and connection_read each return the day's live_read Document for their connection", async () => {
    for (const id of ["search-console", "google-calendar", "gmail", "hubspot"]) await connectC("live_shop", id);
    const cases: Array<[string, () => Promise<{ nodes: Array<{ id: string; label: string }> }>, string, string]> = [
      ["search-console", () => call(gscReport, {}, ctxC()), "system:search-console", "search-console"],
      ["google-calendar", () => call(calendarFreeSlots, { time_zone: "UTC" }, ctxC()), "system:google-calendar", "google-calendar"],
      ["gmail", () => call(gmailInbox, { query: "is:unread" }, ctxC()), "system:gmail", "gmail"],
      ["hubspot", () => call(connectionRead, { connection: "hubspot", tool: "HUBSPOT_LIST_DEALS" }, ctxC({ agentId: "chief-of-staff" })), "system:hubspot", "hubspot"],
    ];
    for (const [id, run, sys, provider] of cases) {
      const r = await run();
      const docId = `document:live-${id}-${TODAY}`;
      expect(r.nodes, id).toEqual([expect.objectContaining({ id: docId, label: "Document" })]);
      // a judge can see which connection a turn used: System -PRODUCED-> Document, and the turn TOUCHED the Document
      const row = await c.g.roQuery<{ kind: string; provider: string; date: string; src: string }>(
        "MATCH (:System {id:$s})-[:PRODUCED]->(d:Document {id:$d}) RETURN d.kind AS kind, d.provider AS provider, d.date AS date, d.src AS src", { s: sys, d: docId });
      expect(row, id).toEqual([{ kind: "live_read", provider, date: TODAY, src: "turn:t-live-1" }]);
    }
  });

  it("a second read the same day is the same node; a read-only surface writes nothing", async () => {
    await call(gscReport, {}, ctxC({ turnId: "turn:t-live-2" }));
    expect(await edge(c, "MATCH (d:Document {id:$d}) RETURN count(d) AS n", { d: `document:live-search-console-${TODAY}` })).toBe(1);
    const before = await edge(c, "MATCH (d:Document {kind:'live_read'}) RETURN count(d) AS n");
    const r = await call(calendarFreeSlots, {}, ctxC({ readOnly: true }));
    expect(r.data).toMatchObject({ error: expect.stringMatching(/read-only/) });
    expect(await edge(c, "MATCH (d:Document {kind:'live_read'}) RETURN count(d) AS n")).toBe(before);
  });

  it("a connection that is not connected leaves no node", async () => {
    const before = await edge(c, "MATCH (d:Document {kind:'live_read'}) RETURN count(d) AS n");
    const r = await call(gmailInbox, { query: "x" }, makeCtx(c.g, { tenant: "never_shop", now: NOW, connections: c.svc.port("never_shop") }));
    expect(r.nodes).toEqual([]);
    expect(await edge(c, "MATCH (d:Document {kind:'live_read'}) RETURN count(d) AS n")).toBe(before);
  });
});
