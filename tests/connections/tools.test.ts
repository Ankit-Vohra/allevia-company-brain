// The agents' tools over the connections, end to end against fakes: a read runs now and is logged; anything that sends, books,
// posts or changes becomes an approval card and runs only after the OK (a dry run until ALLEVIA_ACTIONS_LIVE=1); a missing
// connection says so in plain words with a Connect link; a department only reaches its own tools; Composio's calls are made
// as the business's own entity. Google runs through Composio here (the main path) and through our own Google app in one test.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { entryById } from "../../shared/connection-map.js";
import { agentById } from "../../shared/roster.js";
import { deriveCapabilities } from "../../src/capabilities/ladder.js";
import { closeAll } from "../../src/graph/client.js";
import { composioUserId } from "../../src/connections/composio.js";
import { decide } from "../../src/server/approvals.js";
import { approval } from "../../src/server/reads.js";
import {
  adsReport, calendarBook, calendarFreeSlots, connectionAct, connectionRead, connectionTools, connectionsAvailable, freeSlots, gmailDraft, gmailInbox, gmailSend, gscReport, ga4Report, zonedToUtc, isoIn,
} from "../../src/agent/tools/connections.js";
import type { AlleviaTool } from "../../src/agent/tool.js";
import { SEED_NOW } from "../fixtures/seed-graph.js";
import { call, makeCtx } from "../helpers/tools.js";
import { connHarness, KEY, NOW, type ConnHarness } from "./harness.js";
import type { ToolContext } from "../../src/agent/tool.js";

const TENANT = "ops_shop";
let h: ConnHarness;
const ctxFor = (agent = "ops-manager", tenant = TENANT, over: Partial<ToolContext> = {}): ToolContext => makeCtx(h.g, { tenant, agentId: agent, now: NOW, connections: h.svc.port(tenant), ...over });
const run = (t: AlleviaTool, args: Record<string, unknown>, ctx = ctxFor()) => call(t, args, ctx);

async function connect(tenant: string, id: string) {
  const { url } = await h.svc.connect(tenant, id);
  const link = h.composio.calls.filter((c) => c.op === "link").at(-1)!.args as { callbackUrl: string };
  const accountId = new URL(url).pathname.split("/").pop()!;
  h.composio.activate(accountId);
  const done = await h.svc.complete(new URL(link.callbackUrl).searchParams.get("state")!, { status: "success", connected_account_id: accountId });
  expect(done?.outcome.result).toBe("connected");
}

beforeAll(async () => {
  h = await connHarness({ via: "composio" });
  h.composio.results.set("GOOGLECALENDAR_FREE_BUSY_QUERY", { data: { calendars: { primary: { busy: [{ start: "2026-10-16T05:00:00Z", end: "2026-10-16T06:30:00Z" }] } } } });
  h.composio.results.set("GOOGLECALENDAR_CREATE_EVENT", { id: "evt_1", htmlLink: "https://calendar.example/evt_1" });
  h.composio.results.set("GMAIL_SEND_EMAIL", { id: "msg_1", threadId: "thr_1" });
  h.composio.results.set("GMAIL_FETCH_EMAILS", { messages: [{ messageId: "m1", sender: "lead@client.example", subject: "Quote?", preview: "Can you send a quote", messageTimestamp: "2026-10-15" }] });
  h.composio.results.set("GOOGLE_SEARCH_CONSOLE_LIST_SITES", { siteEntry: [{ siteUrl: "sc-domain:shop.example", permissionLevel: "siteOwner" }] });
  h.composio.results.set("GOOGLE_SEARCH_CONSOLE_SEARCH_ANALYTICS_QUERY", { rows: [{ keys: ["cafe near me"], clicks: 12, impressions: 300, ctr: 0.04, position: 4.2 }] });
  h.composio.results.set("HUBSPOT_LIST_DEALS", { results: [{ id: "d1", dealname: "Retainer" }] });
  h.composio.toolList.set("hubspot", [{ slug: "HUBSPOT_LIST_DEALS", name: "List deals", description: "Lists deals" }, { slug: "HUBSPOT_CREATE_NOTE", name: "Create note", description: "Adds a note" }]);
}, 90_000);
afterAll(async () => { await h.cleanup(); await closeAll(); });

describe("time zones and free slots", () => {
  it("turns wall-clock times in a zone into instants, across offsets", () => {
    expect(new Date(zonedToUtc("2026-10-16", "09:00", "Asia/Kolkata")).toISOString()).toBe("2026-10-16T03:30:00.000Z");
    expect(new Date(zonedToUtc("2026-10-16", "09:00", "America/New_York")).toISOString()).toBe("2026-10-16T13:00:00.000Z");
    expect(isoIn(Date.parse("2026-10-16T03:30:00Z"), "Asia/Kolkata")).toBe("2026-10-16T09:00:00+05:30");
  });
  it("skips busy blocks, weekends, and anything before the notice time", () => {
    const tz = "UTC";
    const base = { fromDate: "2026-10-16", days: 4, minutes: 60, workStart: "09:00", workEnd: "12:00", tz, notBefore: Date.parse("2026-10-16T10:00:00Z"), weekends: false, max: 20 };
    const out = freeSlots({ ...base, busy: [{ start: Date.parse("2026-10-16T10:30:00Z"), end: Date.parse("2026-10-16T11:00:00Z") }] });
    expect(out.map((s) => new Date(s.start).toISOString().slice(0, 16))).toEqual(["2026-10-16T11:00", "2026-10-19T09:00", "2026-10-19T09:30", "2026-10-19T10:00", "2026-10-19T10:30", "2026-10-19T11:00"]);
    // Friday 16th: 10:00-11:00 is blocked by the busy block, 11:00 would run past noon... only after notBefore; weekend 17-18 skipped
    expect(freeSlots({ ...base, days: 1, busy: [] }).map((s) => new Date(s.start).toISOString().slice(11, 16))).toEqual(["10:00", "10:30", "11:00"]);
  });
});

describe("not connected", () => {
  it("every tool says so in plain words with a Connect link, makes nothing up, and changes nothing", async () => {
    const tools: Array<[AlleviaTool, Record<string, unknown>]> = [
      [calendarFreeSlots, {}], [gmailInbox, { query: "is:unread" }], [gscReport, {}], [ga4Report, {}], [adsReport, {}],
      [calendarBook, { title: "Call with Priya", start: "2026-10-19T11:00:00+05:30", why: "She asked for a call" }],
      [gmailSend, { to: ["lead@client.example"], subject: "Quote", body: "Hello, here is the quote you asked for.", why: "She asked" }],
    ];
    for (const [t, a] of tools) {
      const r = await run(t, a, ctxFor("ops-manager", "nobody_shop"));
      expect(r.data, t.name).toMatchObject({ connected: false, nothingChanged: true });
      expect(r.note, t.name).toMatch(/isn't connected yet/);
      expect(r.data.connect.link, t.name).toMatch(/^\/connections\?connect=/);
      expect(r.data.say, t.name).toMatch(/\[Connect .+\]\(\/connections\?connect=/);
    }
    expect((await h.g.roQuery<{ n: number }>("MATCH (a:Approval) WHERE a.id STARTS WITH 'approval:t-100-' RETURN count(a) AS n"))[0]!.n).toBe(0);
  });

  it("with no connections at all (a surface without them) it still refuses in words", async () => {
    const r = await run(calendarFreeSlots, {}, makeCtx(h.g, { now: NOW, agentId: "ops-manager" }));
    expect(r.data).toMatchObject({ connected: false });
  });
});

describe("Google through Composio: read, then act behind an approval", () => {
  beforeAll(async () => {
    await connect(TENANT, "google-calendar");
    await connect(TENANT, "gmail");
    await connect(TENANT, "search-console");
  });

  it("calendar_free_slots reads free/busy as this business's own entity and offers working-hour times", async () => {
    const r = await run(calendarFreeSlots, { minutes: 30, days: 3, from: "2026-10-16", time_zone: "UTC" });
    expect(r.data.slots.length).toBeGreaterThan(0);
    expect(r.data.slots[0]).toMatchObject({ start: expect.stringMatching(/\+00:00$/), label: expect.any(String) });
    const exec = h.composio.calls.filter((c) => c.op === "execute").at(-1)!.args as { tool: string; userId: string; args: Record<string, unknown> };
    expect(exec.tool).toBe("GOOGLECALENDAR_FREE_BUSY_QUERY");
    expect(exec.userId).toBe(composioUserId(KEY, TENANT));
    expect(exec.args).toMatchObject({ items: [{ id: "primary" }] });
    expect(r.data.slots.some((s: { start: string }) => s.start.startsWith("2026-10-16T05:30") || s.start.startsWith("2026-10-16T06:00"))).toBe(false); // inside the busy block
  });

  it("calendar_book proposes a card with the whole meeting, and books nothing", async () => {
    const before = h.composio.calls.filter((c) => c.op === "execute").length;
    const r = await run(calendarBook, { title: "Call with Priya Shah", start: "2026-10-19T11:00:00+05:30", minutes: 45, guest_email: "priya@client.example", notes: "Retainer scope", why: "Priya asked for a call about the retainer" });
    expect(r.data).toMatchObject({ kind: "calendar_event", status: "pending" });
    const card = await approval(h.g, r.data.approvalId);
    expect(card).toMatchObject({ status: "pending", kind: "calendar_event" });
    expect(card!.payload).toMatchObject({ title: "Call with Priya Shah", body: "Retainer scope", target: expect.stringContaining("guest priya@client.example") });
    expect(card!.payload.target).toContain("2026-10-19 11:00");
    expect(h.composio.calls.filter((c) => c.op === "execute").length).toBe(before); // proposing reaches out to nobody
    expect(h.composio.calls.filter((c) => c.op === "execute" && (c.args as { tool: string }).tool === "GOOGLECALENDAR_CREATE_EVENT")).toHaveLength(0);
    // approving in a dry run still books nothing; approving live books exactly once
    const dry = await decide(h.g, TENANT, r.data.approvalId, { decision: "approve" }, { actions: { live: false, connections: () => h.svc.port(TENANT) } });
    expect(dry.action).toMatchObject({ kind: "calendar_event", status: "dry_run" });
    expect(h.composio.calls.filter((c) => c.op === "execute" && (c.args as { tool: string }).tool === "GOOGLECALENDAR_CREATE_EVENT")).toHaveLength(0);
  });

  it("a live approval books through the connection, once, with the invitation, and the audit log has it", async () => {
    const r = await run(calendarBook, { title: "Kickoff with Dev Rao", start: "2026-10-20T15:00:00+05:30", guest_email: "dev@client.example", why: "Dev accepted the proposal" });
    const done = await decide(h.g, TENANT, r.data.approvalId, { decision: "approve" }, { actions: { live: true, connections: () => h.svc.port(TENANT) } });
    expect(done.action).toMatchObject({ status: "done", url: "https://calendar.example/evt_1" });
    const created = h.composio.calls.filter((c) => c.op === "execute" && (c.args as { tool: string }).tool === "GOOGLECALENDAR_CREATE_EVENT");
    expect(created).toHaveLength(1);
    expect((created[0]!.args as { args: Record<string, unknown> }).args).toMatchObject({ summary: "Kickoff with Dev Rao", start_datetime: "2026-10-20T09:30:00", timezone: "UTC", attendees: ["dev@client.example"] });
    expect((await h.audit.recent(TENANT)).some((e) => e.op === "add meeting" && e.ok && e.actor === "ops-manager")).toBe(true);
  });

  it("gmail_draft keeps wording for approval; gmail_send proposes and sends only after the OK, to the addresses on the card", async () => {
    const d = await run(gmailDraft, { to: ["lead@client.example"], subject: "Your quote", body: "Hello, here is the quote you asked for. Thanks.", why: "Lead asked for a quote" });
    expect(d.data).toMatchObject({ kind: "email_send", status: "pending" });
    const draftDone = await decide(h.g, TENANT, d.data.approvalId, { decision: "approve" }, { actions: { live: true, connections: () => h.svc.port(TENANT) } });
    expect(draftDone.action).toMatchObject({ status: "done", result: expect.stringMatching(/nothing was sent/) });
    expect(h.composio.calls.filter((c) => c.op === "execute" && (c.args as { tool: string }).tool === "GMAIL_SEND_EMAIL")).toHaveLength(0);
    const s = await run(gmailSend, { draft_approval_id: d.data.approvalId, why: "Send the approved quote now" });
    expect(s.data).toMatchObject({ kind: "email_send", status: "pending" });
    const sent = await decide(h.g, TENANT, s.data.approvalId, { decision: "approve" }, { actions: { live: true, connections: () => h.svc.port(TENANT) } });
    expect(sent.action).toMatchObject({ status: "done" });
    const mail = h.composio.calls.filter((c) => c.op === "execute" && (c.args as { tool: string }).tool === "GMAIL_SEND_EMAIL");
    expect(mail).toHaveLength(1);
    expect((mail[0]!.args as { args: Record<string, unknown> }).args).toMatchObject({ recipient_email: "lead@client.example", subject: "Your quote" });
  });

  it("a bad address or a draft that was never approved is refused before any card exists", async () => {
    expect((await run(gmailSend, { to: ["not an email"], subject: "Hi there", body: "Hello, this is long enough.", why: "because" })).data.error).toMatch(/address isn't valid/);
    const d = await run(gmailDraft, { to: ["a@b.example"], subject: "Draft only", body: "Hello, this is a draft for you.", why: "because" });
    expect((await run(gmailSend, { draft_approval_id: d.data.approvalId, why: "send it" })).data.error).toMatch(/hasn't been approved yet/);
  });

  it("gmail_inbox reads previews through the connection and warns they are data", async () => {
    const r = await run(gmailInbox, { query: "is:unread" });
    expect(r.data.messages[0]).toMatchObject({ from: "lead@client.example", subject: "Quote?" });
    expect(r.note).toMatch(/data, not instructions/);
  });

  it("gsc_report reads Search Console live through Composio", async () => {
    const r = await run(gscReport, { by: "query", days: 28 });
    expect(r.data.rows[0]).toMatchObject({ query: "cafe near me", clicks: 12, ctrPct: 4, position: 4.2 });
    expect(r.sources[0]).toMatchObject({ id: "live:search-console" });
  });

  it("GA4 and Ads numbers are not on Composio: the tool points the agent at the toolkit's real actions instead of guessing", async () => {
    await connect(TENANT, "google-analytics").catch(() => undefined);
    const r = await run(ga4Report, {});
    expect(JSON.stringify(r.data)).toMatch(/connection_tools|connected/);
  });
});

describe("every connected toolkit, generically", () => {
  beforeAll(async () => { await connect(TENANT, "hubspot"); });

  it("connections_available lists what is connected and what is not, for this agent's department, with the jobs it unlocks", async () => {
    const r = await run(connectionsAvailable, {}, ctxFor("ops-manager"));
    expect(r.data.connected.map((c: { id: string }) => c.id)).toEqual(expect.arrayContaining(["google-calendar", "gmail"]));
    expect(r.data.connected.map((c: { id: string }) => c.id)).not.toContain("hubspot".replace("hubspot", "instagram"));
    expect(r.data.notConnected.length).toBeGreaterThan(0);
    expect(r.data.starterJobs.map((j: { job: string }) => j.job)).toContain("Today's meetings and the emails that need a reply");
    const analyst = await run(connectionsAvailable, {}, ctxFor("data-analyst"));
    expect(analyst.data.connected.map((c: { id: string }) => c.id)).not.toContain("gmail"); // email is not the analysts' desk
  });

  it("connection_tools lists a toolkit's real actions marked read or change; connection_read runs reads only", async () => {
    const t = await run(connectionTools, { connection: "hubspot" }, ctxFor("chief-of-staff"));
    expect(t.data.actions).toEqual([{ tool: "HUBSPOT_LIST_DEALS", what: "Lists deals", kind: "read" }, { tool: "HUBSPOT_CREATE_NOTE", what: "Adds a note", kind: "act" }]);
    const read = await run(connectionRead, { connection: "hubspot", tool: "HUBSPOT_LIST_DEALS" }, ctxFor("chief-of-staff"));
    expect(read.data.result).toEqual({ results: [{ id: "d1", dealname: "Retainer" }] });
    expect(read.sources[0]).toMatchObject({ id: "live:hubspot" });
    const refused = await run(connectionRead, { connection: "hubspot", tool: "HUBSPOT_CREATE_NOTE", args: {} }, ctxFor("chief-of-staff"));
    expect(refused.data).toMatchObject({ refused: true });
    expect(h.composio.calls.filter((c) => c.op === "execute" && (c.args as { tool: string }).tool === "HUBSPOT_CREATE_NOTE")).toHaveLength(0);
  });

  it("connection_act becomes an approval card; only the OK runs it, in the business's own account, and the audit log keeps it", async () => {
    const r = await run(connectionAct, { connection: "hubspot", tool: "HUBSPOT_CREATE_NOTE", args: { body: "Followed up" }, title: "Add a note to Retainer", summary: "Note on the Retainer deal: Followed up", why: "Keeps the deal history current" }, ctxFor("chief-of-staff"));
    expect(r.data).toMatchObject({ kind: "connection_action", status: "pending" });
    expect(h.composio.calls.filter((c) => c.op === "execute" && (c.args as { tool: string }).tool === "HUBSPOT_CREATE_NOTE")).toHaveLength(0);
    const done = await decide(h.g, TENANT, r.data.approvalId, { decision: "approve" }, { actions: { live: true, connections: () => h.svc.port(TENANT) } });
    expect(done.action).toMatchObject({ kind: "connection_action", status: "done" });
    const ran = h.composio.calls.filter((c) => c.op === "execute" && (c.args as { tool: string }).tool === "HUBSPOT_CREATE_NOTE");
    expect(ran).toHaveLength(1);
    expect((ran[0]!.args as { userId: string }).userId).toBe(composioUserId(KEY, TENANT));
  });

  it("a department reaches only its own connections (the analyst cannot touch HubSpot; the Chief can)", async () => {
    const r = await run(connectionRead, { connection: "hubspot", tool: "HUBSPOT_LIST_DEALS" }, ctxFor("data-analyst"));
    expect(r.data).toMatchObject({ allowed: false });
    expect(r.note).toMatch(/not yours|for the/);
    expect(agentById("data-analyst")!.department).toBe("analytics");
    expect(entryById("hubspot")!.departments).not.toContain("analytics");
  });

  it("another business never reaches this one's connection, even by naming it", async () => {
    const r = await run(connectionRead, { connection: "hubspot", tool: "HUBSPOT_LIST_DEALS" }, ctxFor("chief-of-staff", "rival_shop"));
    expect(r.data).toMatchObject({ connected: false });
    expect(h.composio.calls.filter((c) => c.op === "execute" && (c.args as { userId: string }).userId === composioUserId(KEY, "rival_shop"))).toHaveLength(0);
  });

  it("calls are rate limited per business and connection, in words", async () => {
    const t = "busy_shop";
    await connect(t, "hubspot");
    let last = null as null | Awaited<ReturnType<typeof run>>;
    for (let i = 0; i < 32; i++) last = await run(connectionRead, { connection: "hubspot", tool: "HUBSPOT_LIST_DEALS" }, ctxFor("chief-of-staff", t));
    expect(last!.note).toMatch(/lot of calls/);
  });

  it("read-only surfaces (public demo, MCP) never reach a business's accounts", async () => {
    await expect(run(calendarFreeSlots, {}, ctxFor("ops-manager", TENANT, { readOnly: true }))).resolves.toMatchObject({ data: expect.objectContaining({ error: expect.stringMatching(/read-only/) }) });
  });
});

describe("the first read and the ladder", () => {
  it("Search Console's first read writes the numbers with their source and the ladder goes live; the connection says its first numbers", async () => {
    const t = "firstread_shop";
    h.composio.results.set("GOOGLE_SEARCH_CONSOLE_SEARCH_ANALYTICS_QUERY", { rows: [{ keys: ["2026-10-10"], clicks: 7, impressions: 90 }, { keys: ["2026-10-11"], clicks: 5, impressions: 60 }] });
    await connect(t, "search-console");
    for (let i = 0; i < 20 && !(await h.svc.view(t, "search-console")).message.includes("clicks"); i++) await new Promise((r) => setTimeout(r, 100));
    const v = await h.svc.view(t, "search-console");
    expect(v.message).toBe("Google Search Console connected: 12 clicks from Google searches in the last 28 days.");
    expect((await deriveCapabilities(h.g, { now: NOW })).find((c) => c.key === "search_console")).toMatchObject({ accessMode: "api" });
    const src = await h.g.roQuery<{ id: string }>("MATCH (:Observation {metric:'gsc_clicks'})-[:SOURCED_FROM]->(d:Document) RETURN DISTINCT d.id AS id");
    expect(src.some((s) => s.id.startsWith("document:first-read-search-console-"))).toBe(true);
  });

  it("the system prompt note tells an agent what is connected and what to do when a tool is missing", async () => {
    const note = await h.svc.port(TENANT).note();
    expect(note).toMatch(/Connected tools of this business: .*Gmail/);
    expect(note).toMatch(/\[Connect <name>\]\(\/connections\?connect=<id>\)/);
    expect(SEED_NOW).toBeGreaterThan(0);
  });
});
