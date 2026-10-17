// Google Analytics through Composio: its toolkit has no report action, so the first read calls Google's own Analytics API through
// Composio's proxy with the business's connected account. Checked here on a fake Composio and the throwaway graph only: the proxy
// only reads, every call is audited, and the visits land on the website channel with their source and dates.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAll } from "../../src/graph/client.js";
import { composioUserId, proxyIsRead, realComposioClient, type ProxyRequest } from "../../src/connections/composio.js";
import { connectionsAvailable, ga4Report } from "../../src/agent/tools/connections.js";
import type { ToolContext } from "../../src/agent/tool.js";
import { deriveCapabilities } from "../../src/capabilities/ladder.js";
import { call, makeCtx } from "../helpers/tools.js";
import { connHarness, KEY, NOW, type ConnHarness } from "./harness.js";

const TODAY = new Date(NOW).toISOString().slice(0, 10);
const ADMIN = "https://analyticsadmin.googleapis.com/v1beta";
const DATA = "https://analyticsdata.googleapis.com/v1beta";

let h: ConnHarness;
let kestrelAccount = "";
const ctxFor = (tenant: string, agent = "data-analyst"): ToolContext => makeCtx(h.g, { tenant, agentId: agent, now: NOW, connections: h.svc.port(tenant) });
const row = (dims: string[], vals: number[]) => ({ dimensionValues: dims.map((value) => ({ value })), metricValues: vals.map((v) => ({ value: String(v) })) });

beforeAll(async () => {
  h = await connHarness({ via: "composio" });
  await h.g.query("MATCH (b:Entity:Business) SET b.domain = 'www.kestrel.example'");
  h.composio.proxies.set(`${ADMIN}/accountSummaries`, () => ({
    accountSummaries: [
      { account: "accounts/1", propertySummaries: [{ property: "properties/111", displayName: "Old blog" }] },
      { account: "accounts/2", propertySummaries: [{ property: "properties/222", displayName: "Main site" }] },
    ],
  }));
  h.composio.proxies.set(`${ADMIN}/properties/111/dataStreams`, () => ({ dataStreams: [{ webStreamData: { defaultUri: "https://blog.other.example" } }] }));
  h.composio.proxies.set(`${ADMIN}/properties/222/dataStreams`, () => ({ dataStreams: [{ webStreamData: { defaultUri: "https://kestrel.example/" } }] }));
  h.composio.proxies.set(`${DATA}/properties/222:runReport`, reportOf);
}, 90_000);

function reportOf(req: ProxyRequest) {
  const dim = ((req.body?.dimensions as Array<{ name: string }>) ?? [])[0]?.name;
  if (dim === "date") return { rows: [row(["20261012"], [700, 500, 300, 9]), row(["20261013"], [534, 410, 200, 4])] };
  return { rows: [row(["Organic Search"], [800]), row(["Direct"], [334]), row(["Paid Social"], [100])] };
}
afterAll(async () => { await h.cleanup(); await closeAll(); });

async function connect(tenant: string): Promise<string> {
  const { url } = await h.svc.connect(tenant, "google-analytics");
  const link = h.composio.calls.filter((c) => c.op === "link").at(-1)!.args as { callbackUrl: string };
  const accountId = new URL(url).pathname.split("/").pop()!;
  h.composio.activate(accountId);
  const done = await h.svc.complete(new URL(link.callbackUrl).searchParams.get("state")!, { status: "success", connected_account_id: accountId });
  expect(done?.outcome.result).toBe("connected");
  return accountId;
}

describe("Google Analytics through Composio's proxy", () => {
  it("finds the business's own property, reads 28 days, and writes visits on the website with the source and dates", async () => {
    const accountId = kestrelAccount = await connect("kestrel");
    const r = await h.svc.pull("kestrel", "google-analytics");
    expect(r).toEqual({ ok: true, message: "1,234 visits to your website in the last 28 days" });

    const calls = h.composio.proxied();
    expect(calls.every((c) => c.accountId === accountId && c.userId === composioUserId(KEY, "kestrel"))).toBe(true);
    const reports = calls.filter((c) => c.endpoint.endsWith(":runReport"));
    expect(reports.length).toBeGreaterThanOrEqual(2);
    expect(new Set(reports.map((c) => c.endpoint))).toEqual(new Set([`${DATA}/properties/222:runReport`])); // the property whose website is the business's
    const daily = reports.find((c) => (c.body?.dimensions as Array<{ name: string }>)[0]!.name === "date")!;
    expect(daily.method).toBe("POST");
    expect(daily.body).toMatchObject({ dateRanges: [{ startDate: "2026-09-17", endDate: "2026-10-14" }], metrics: [{ name: "sessions" }, { name: "totalUsers" }, { name: "newUsers" }, { name: "keyEvents" }] });

    const doc = `document:first-read-ga4-${TODAY}`;
    const obs = (await h.g.roQuery<{ metric: string; value: number; ws: string; we: string; id?: string }>(
      "MATCH (:System {id:'system:ga4'})-[:PRODUCED]->(d:Document {id:$doc})<-[:SOURCED_FROM]-(o:Observation)-[:MEASURES]->(:Channel {id:'channel:website'}) RETURN o.metric AS metric, o.value AS value, o.windowStart AS ws, o.windowEnd AS we, o.id AS id ORDER BY metric, ws, id",
      { doc })).map(({ id: _id, ...o }) => o);
    expect(obs.filter((o) => o.metric === "ga4_sessions")).toEqual([
      { metric: "ga4_sessions", value: 700, ws: "2026-10-12", we: "2026-10-12" },
      { metric: "ga4_sessions", value: 534, ws: "2026-10-13", we: "2026-10-13" },
    ]);
    expect(obs.filter((o) => o.ws === "2026-10-12").map((o) => [o.metric, o.value])).toEqual([["ga4_conversions", 9], ["ga4_new_users", 300], ["ga4_sessions", 700], ["ga4_users", 500]]);
    expect(obs.filter((o) => o.metric.startsWith("ga4_sessions_from_")).map((o) => [o.metric, o.value, o.ws, o.we])).toEqual([
      ["ga4_sessions_from_direct", 334, "2026-09-17", "2026-10-14"],
      ["ga4_sessions_from_organic_search", 800, "2026-09-17", "2026-10-14"],
      ["ga4_sessions_from_paid_social", 100, "2026-09-17", "2026-10-14"],
    ]);
    const [sys] = await h.g.roQuery<{ property: string; dataThrough: string; factCount: number }>("MATCH (s:System {id:'system:ga4'}) RETURN s.property AS property, s.dataThrough AS dataThrough, s.factCount AS factCount");
    expect(sys).toEqual({ property: "properties/222", dataThrough: "2026-10-14", factCount: 12 }); // 2 days x 4 + 3 channel groups + the snapshot

    const audited = (await h.audit.recent("kestrel", { connector: "google-analytics" })).map((e) => e.op);
    expect(audited).toContain("proxy GET analyticsadmin/accountSummaries");
    expect(audited.some((op) => op.startsWith("proxy POST analyticsdata/properties/222:runReport"))).toBe(true);
    expect(audited).toContain("daily read");
  });

  it("the agents' ga4_report reads live through the proxy, on the property the daily read found, as this business only", async () => {
    const before = h.composio.proxied().length;
    const r = await call(ga4Report, { by: "source", days: 28 }, ctxFor("kestrel"));
    expect(r.data).toMatchObject({ by: "source", startDate: "2026-09-17", endDate: "2026-10-14" });
    expect(r.data.rows.map((x: { source: string; sessions: number }) => [x.source, x.sessions])).toEqual([["Organic Search", 800], ["Direct", 334], ["Paid Social", 100]]);
    expect(r.sources[0]).toMatchObject({ id: "live:ga4" });
    const calls = h.composio.proxied().slice(before);
    expect(calls.map((c) => c.endpoint)).toEqual([`${DATA}/properties/222:runReport`]); // the kept property: no second look at the accounts
    expect(calls[0]).toMatchObject({ method: "POST", accountId: kestrelAccount, userId: composioUserId(KEY, "kestrel") });
    expect(calls[0]!.body).toMatchObject({ dateRanges: [{ startDate: "2026-09-17", endDate: "2026-10-14" }], dimensions: [{ name: "sessionDefaultChannelGroup" }], metrics: [{ name: "sessions" }, { name: "activeUsers" }, { name: "keyEvents" }] });
    const audited = await h.audit.recent("kestrel", { connector: "google-analytics" });
    expect(audited.find((e) => e.op === "analytics report")).toMatchObject({ ok: true, actor: "data-analyst" });
    expect(audited.some((e) => e.op.startsWith("proxy POST analyticsdata/properties/222:runReport") && e.ok)).toBe(true);
  });

  it("a business connected before the property was kept: ga4_report picks it once through the proxy, then keeps it", async () => {
    h.composio.proxies.set(`${DATA}/properties/222:runReport`, () => new Error("Composio is down")); // the first read fails: no property kept
    await connect("late_ga");
    await h.svc.pull("late_ga", "google-analytics");
    h.composio.proxies.set(`${DATA}/properties/222:runReport`, () => ({ rows: [row(["20261013"], [534, 410, 4])] }));
    const before = h.composio.proxied().length;
    const r = await call(ga4Report, {}, ctxFor("late_ga"));
    expect(r.data.rows).toEqual([{ day: "20261013", sessions: 534, visitors: 410, keyEvents: 4 }]);
    expect(h.composio.proxied().slice(before).map((c) => c.endpoint)).toEqual([`${ADMIN}/accountSummaries`, `${ADMIN}/properties/111/dataStreams`, `${ADMIN}/properties/222/dataStreams`, `${DATA}/properties/222:runReport`]);
    const again = h.composio.proxied().length;
    await call(ga4Report, {}, ctxFor("late_ga"));
    expect(h.composio.proxied().slice(again).map((c) => c.endpoint)).toEqual([`${DATA}/properties/222:runReport`]);
  });

  it("when Google does not answer, ga4_report hands over the GA4 numbers the daily read recorded, with their dates, never 'no data'", async () => {
    h.composio.proxies.set(`${DATA}/properties/222:runReport`, () => ({ status: 503, data: { error: { message: "busy" } } }));
    const r = await call(ga4Report, { by: "source" }, ctxFor("kestrel"));
    expect(r.data).toMatchObject({ live: false, liveRead: { retryable: true } });
    const byMetric = new Map((r.data.recorded as Array<{ metric: string; total: number; from: string; through: string }>).map((x) => [x.metric, x]));
    expect(byMetric.get("ga4_sessions")).toEqual({ metric: "ga4_sessions", total: 1234, from: "2026-10-12", through: "2026-10-13" });
    expect(byMetric.get("ga4_sessions_from_organic_search")).toEqual({ metric: "ga4_sessions_from_organic_search", total: 800, from: "2026-09-17", through: "2026-10-14" });
    expect(byMetric.get("ga4_users")?.total).toBe(910);
    expect(r.data.readMore).toMatch(/metric_trend.*channel:website/);
    expect(r.note).toMatch(/recorded by the daily read/);
    expect(r.nodes.some((n) => n.id.startsWith("obs:ga4_"))).toBe(true); // citable observations
    expect(r.sources.map((s) => s.id)).toContain(`document:first-read-ga4-${TODAY}`);
    h.composio.proxies.set(`${DATA}/properties/222:runReport`, reportOf);
  });

  it("the team is told Analytics is connected and readable, and the ladder has it live", async () => {
    const note = await h.svc.note("kestrel");
    expect(note).toMatch(/Connected tools of this business: [^.]*Google Analytics \(google-analytics\)/);
    expect(note).toMatch(/Google Analytics with ga4_report \(its daily read is also in the records: metric_trend on channel:website, metrics ga4_sessions/);
    const avail = await call(connectionsAvailable, {}, ctxFor("kestrel"));
    expect(avail.data.connected.find((c: { id: string }) => c.id === "google-analytics")).toMatchObject({ readWith: "ga4_report", alsoRecorded: expect.stringMatching(/channel:website/) });
    const ga4 = (await deriveCapabilities(h.g, { now: NOW })).find((c) => c.key === "ga4")!;
    expect(ga4).toMatchObject({ accessMode: "api", status: "ok", dependsOn: ["system:ga4"] });
  });

  it("the proxy only reads, refuses before anything leaves, and says so in the audit log", async () => {
    const before = h.composio.proxied().length;
    const run = (req: ProxyRequest) => h.svc.port("kestrel").run<{ proxy(r: ProxyRequest): Promise<unknown> }, unknown>("google-analytics", "try a change", (s) => s.proxy(req));
    await expect(run({ endpoint: `${ADMIN}/properties/222`, method: "POST", body: { displayName: "x" } })).rejects.toThrow(/can only be read/);
    expect(h.composio.proxied().length).toBe(before);
    expect((await h.audit.recent("kestrel", { connector: "google-analytics" }))[1]).toMatchObject({ op: "proxy POST analyticsadmin/properties/222", ok: false });
    // Google saying no is a failed read, not an empty one
    h.composio.proxies.set(`${ADMIN}/properties/999`, () => ({ status: 403, data: { error: { message: "denied" } } }));
    await expect(run({ endpoint: `${ADMIN}/properties/999`, method: "GET" })).rejects.toThrow(/answered 403/);
  });

  it("a business with no Analytics property reads nothing and says it plainly", async () => {
    h.composio.proxies.set(`${ADMIN}/accountSummaries`, () => ({ accountSummaries: [] }));
    await connect("empty_ga");
    expect(await h.svc.pull("empty_ga", "google-analytics")).toEqual({ ok: false, message: "Google Analytics is connected, but there was nothing to read yet." });
  });
});

describe("the proxy", () => {
  it("counts a GET, or a POST to a report, as a read and nothing else", () => {
    expect(proxyIsRead("GET", `${ADMIN}/accountSummaries`)).toBe(true);
    expect(proxyIsRead("POST", `${DATA}/properties/1:runReport`)).toBe(true);
    expect(proxyIsRead("POST", "https://www.googleapis.com/webmasters/v3/sites/x/searchAnalytics/query")).toBe(true);
    expect(proxyIsRead("POST", `${ADMIN}/properties`)).toBe(false);
    expect(proxyIsRead("DELETE", `${ADMIN}/properties/1`)).toBe(false);
    expect(proxyIsRead("PATCH", `${ADMIN}/properties/1`)).toBe(false);
    expect(proxyIsRead("GET", "http://analyticsadmin.googleapis.com/v1beta/accountSummaries")).toBe(false);
    expect(proxyIsRead("GET", "/v1beta/accountSummaries")).toBe(false);
  });

  it("the real client sends Composio's v3 proxy shape and hands back the provider's status and answer", async () => {
    const sent: Array<{ url: string; method?: string; body?: string; key?: string }> = [];
    const fetchFn = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      sent.push({ url, method: init?.method, body: init?.body, key: init?.headers?.["x-api-key"] });
      const text = JSON.stringify({ data: { rows: [] }, status: 200, headers: {} });
      return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text };
    };
    const out = await realComposioClient("test-key", fetchFn).proxy({ endpoint: `${DATA}/properties/1:runReport`, method: "POST", body: { limit: 1 }, query: { pageSize: "5" }, accountId: "ca_1", userId: "al_x" });
    expect(out).toEqual({ status: 200, data: { rows: [] } });
    expect(sent[0]).toMatchObject({ url: "https://backend.composio.dev/api/v3/tools/execute/proxy", method: "POST", key: "test-key" });
    expect(JSON.parse(sent[0]!.body!)).toEqual({
      endpoint: `${DATA}/properties/1:runReport`, method: "POST", connected_account_id: "ca_1", user_id: "al_x", body: { limit: 1 },
      parameters: [{ name: "pageSize", value: "5", type: "query" }],
    });
  });
});
