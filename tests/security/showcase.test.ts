// A showcase (`auth:demo <slug> --showcase`): a real business the public may look at. Over real HTTP through the real server with
// ALLEVIA_AUTH=1: a stranger gets every route of the showcase with people, customers, leads, messages, the recipients and text of
// email cards and private documents hidden or masked, while numbers, insights, the map's shape, goals and answer paths stay; its
// owner (with the owner link) gets everything; and a plain demo with the same private data is exactly what it was (a stranger and
// the owner get the same answers). Throwaway graphs and registry on the test database; a free port.
import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ensureRoster } from "../../src/agent/memory.js";
import { FakeRuntime } from "../../src/agent/runtime.js";
import { createAskDeps } from "../../src/agent/wiring.js";
import { issueToken } from "../../src/auth/tokens.js";
import { closeAll, openGraphByName, type GraphHandle } from "../../src/graph/client.js";
import { listTenants, setDemo, setShowcase } from "../../src/graph/tenants.js";
import { upsertEdge, upsertNode } from "../../src/graph/upsert.js";
import { startServer } from "../../src/server/main.js";
import { HIDDEN_TEXT } from "../../src/server/showcase.js";
import { fakeEmbed, SEED_NOW } from "../fixtures/seed-graph.js";
import { testGraphName } from "../helpers/graph.js";
import { seededGraph } from "../helpers/tools.js";
import { SCRIPTS } from "../server/harness.js";

const metaGraph = testGraphName();
const opts = { metaGraph };
const saved = process.env.ALLEVIA_META_GRAPH;
let show: GraphHandle;
let demo: GraphHandle;
let url = "";
let stop: () => Promise<void>;
const links: Record<string, string> = {};

// what must never reach a stranger on the showcase
const SECRETS = [
  "Rahul", "Mehta", "rahul.mehta@example.com", "7700 900123", "oak dining table quote", "Dear Rahul", "the walnut finish he liked",
  "Hollis Interiors", "Supplier price list (private)", "cost price is 40%", "Ankit", "lead:rahul", "message:m-1", "person:rahul",
];

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const s = createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); });
});
const get = (path: string, headers: Record<string, string> = {}) => fetch(`${url}${path}`, { headers });
const owner = (slug: string) => ({ authorization: `Bearer ${links[slug]}` });

// the same private data in both businesses: a lead from the inbox, the message, the person, a customer, an email card, a private
// upload, Today's note and a recorded thread that names them
async function addPrivate(g: GraphHandle): Promise<void> {
  const at = SEED_NOW - 3_600_000;
  const n = (x: Parameters<typeof upsertNode>[1]) => upsertNode(g, x, at);
  const e = (from: string, type: Parameters<typeof upsertEdge>[1]["type"], to: string) => upsertEdge(g, { from, type, to }, at);
  await n({ type: "Person", id: "person:rahul-mehta-example-com", name: "Rahul Mehta", props: { role: "lead", email: "rahul.mehta@example.com", phone: "+44 7700 900123" } });
  await n({ type: "Lead", id: "lead:rahul-mehta-example-com", name: "Rahul Mehta: oak dining table quote", summary: "Hello, I'd like the walnut finish he liked. Call me on +44 7700 900123.",
    props: { stage: "contacted", source: "Email", email: "rahul.mehta@example.com", subject: "oak dining table quote" } });
  await n({ type: "Message", id: "message:m-1", name: "Rahul Mehta: oak dining table quote", summary: "Hello, I'd like the walnut finish he liked.",
    props: { direction: "in", status: "received", channel: "Email", subject: "oak dining table quote", externalId: "gmail-123" } });
  await n({ type: "Client", id: "client:hollis-interiors", name: "Hollis Interiors", summary: "Buys 20 tables a year" });
  await n({ type: "Document", id: "document:upload-prices", name: "Supplier price list (private)", summary: "Our cost price is 40% of retail.", props: { kind: "upload", filename: "prices.xlsx" } });
  await n({ type: "Document", id: "document:brief-showcase", name: "Today's note", summary: "Enquiries up 12% on last week; Rahul Mehta asked for a quote.",
    asOf: "2099-01-01",
    props: { kind: "brief", text: "Enquiries up 12% on last week. Rahul Mehta (rahul.mehta@example.com) asked for an oak dining table quote." } });
  await e("lead:rahul-mehta-example-com", "ENQUIRED_BY", "person:rahul-mehta-example-com");
  await e("message:m-1", "MESSAGE_IN", "lead:rahul-mehta-example-com");
  await e("message:m-1", "SOURCED_FROM", "document:upload-prices").catch(() => undefined);
  await n({ type: "Approval", id: "approval:email-1", name: "email_send: Reply to Rahul Mehta", props: {
    status: "pending", kind: "email_send", by: "sales-lead",
    payload: JSON.stringify({ title: "Reply to Rahul Mehta", to: "rahul.mehta@example.com", subject: "Your oak dining table quote", body: "Dear Rahul, the walnut finish he liked is £1,200." }),
  } });
  // a recorded thread whose answer and work log name the lead
  await n({ type: "Session", id: "session:show-1", name: "Who asked for a quote?", props: { channel: "web", startedAt: at } });
  const events = [
    { type: "tool_call", agent: "sales-lead", id: "c1", name: "lead_lookup", args: { email: "rahul.mehta@example.com" } },
    { type: "tool_result", agent: "sales-lead", id: "c1", name: "lead_lookup", summary: "Rahul Mehta, contacted", nodes: [{ id: "lead:rahul-mehta-example-com", label: "Lead", name: "Rahul Mehta: oak dining table quote" }], edges: [], sources: [] },
    { type: "text", agent: "chief-of-staff", delta: "Ra" },
    { type: "text", agent: "chief-of-staff", delta: "hul Mehta asked for a quote; enquiries are up 12%." },
    { type: "path", nodes: [{ id: "lead:rahul-mehta-example-com", label: "Lead", name: "Rahul Mehta: oak dining table quote" }, { id: "person:rahul-mehta-example-com", label: "Person", name: "Rahul Mehta" }],
      edges: [{ from: "lead:rahul-mehta-example-com", type: "ENQUIRED_BY", to: "person:rahul-mehta-example-com" }] },
    { type: "final", turnId: "turn:show-1", answer: "Rahul Mehta asked for a quote; enquiries are up 12%.", citations: ["lead:rahul-mehta-example-com"], checks: {}, agents: ["chief-of-staff"], ms: 10 },
  ];
  await n({ type: "Turn", id: "turn:show-1", name: "Who asked for a quote?", props: {
    question: "Who asked for a quote?", answer: "Rahul Mehta asked for a quote; enquiries are up 12%.", at, showcase: true, status: "ok", sessionId: "session:show-1",
    events: JSON.stringify(events), agents: ["chief-of-staff"], citations: ["lead:rahul-mehta-example-com"],
  } });
  await e("turn:show-1", "IN_SESSION", "session:show-1");
}

beforeAll(async () => {
  process.env.ALLEVIA_META_GRAPH = metaGraph;
  ({ g: show } = await seededGraph());
  ({ g: demo } = await seededGraph());
  for (const g of [show, demo]) {
    await ensureRoster(g, { businessId: "business:aamdani" }, SEED_NOW);
    await addPrivate(g);
  }
  const meta = await openGraphByName(metaGraph);
  const base = { graph: "x", businessId: "business:aamdani", ontologyVersion: 2, createdAt: 1, updatedAt: 1 };
  await meta.query("CREATE (:Tenant {slug:'show_co', name:'Oak & Grain', domain:'oakgrain.example'}), (:Tenant {slug:'demo_co', name:'Demo Cafe', domain:'demo.example'})", {});
  await meta.query("MATCH (t:Tenant) SET t += $base", { base });
  expect(await setShowcase("show_co", true, opts)).toBe(true);
  expect(await setDemo("demo_co", true, opts)).toBe(true);
  for (const s of ["show_co", "demo_co"]) links[s] = (await issueToken(s, { label: "owner" }, opts)).token;
  const graphs: Record<string, GraphHandle> = { show_co: show, demo_co: demo };
  vi.spyOn(console, "error").mockImplementation(() => {});
  const s = await startServer({
    port: await freePort(), host: "127.0.0.1", publicMode: false, authRequired: true, staticDir: null,
    over: {
      listTenants: () => listTenants(opts),
      openGraph: async (slug) => graphs[slug] ?? Promise.reject(new Error(`no graph for ${slug}`)),
      askDeps: async (tenant) => createAskDeps({ tenant }, { graph: graphs[tenant]!, runtime: new FakeRuntime(SCRIPTS), embedQuery: async (t) => fakeEmbed(t) }),
      tenantCacheMs: 0, heartbeatMs: 0, replaySpeed: 0, log: () => {},
    },
  });
  url = s.url;
  stop = s.close;
}, 120_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await stop?.();
  await show?.drop();
  await demo?.drop();
  await (await openGraphByName(metaGraph)).drop();
  if (saved === undefined) delete process.env.ALLEVIA_META_GRAPH; else process.env.ALLEVIA_META_GRAPH = saved;
  await closeAll();
});

const ROUTES = [
  "overview", "brief", "sessions", "sessions/session:show-1", "turns/turn:show-1/events", "turns/turn:show-1/replay", "approvals",
  "recommendations", "graph/overview", "graph/map", "graph/at-work", "search?q=Rahul", "search?q=quote", "agents", "agents/sales-lead",
  "graph/at-work?focus=Rahul%20Mehta", "graph/at-work?focus=lead:rahul-mehta-example-com", "learning", "program", "goals/setup", "standup", "usage", "numbers", "publish", "connections", "node/business:aamdani",
  "graph?focus=business:aamdani&depth=2",
];

describe("a stranger at a showcase", () => {
  it("sees it listed read-only and marked as a showcase", async () => {
    const list = await (await get("/api/tenants")).json() as Array<Record<string, unknown>>;
    expect(list.find((t) => t.id === "show_co")).toMatchObject({ readOnly: true, showcase: true, name: "Oak & Grain" });
    expect(list.find((t) => t.id === "demo_co")?.showcase).toBeUndefined();
  });

  it("gets no name, email, phone, subject, message, customer or private document from any route", async () => {
    for (const r of ROUTES) {
      const res = await get(`/api/show_co/${r}`);
      const text = await res.text();
      if (!/^(connections|goals|standup|numbers|publish|program)/.test(r)) expect(res.status, r).toBe(200);
      for (const s of SECRETS) expect(text, `${r} shows "${s}"`).not.toContain(s);
    }
  });

  it("keeps the numbers, the insights, the map's shape and the answer path, with masked labels", async () => {
    const overview = await (await get("/api/show_co/overview")).json() as { counts: Record<string, number>; brief: string };
    expect(overview.counts.Lead).toBe(1);
    expect(overview.counts.Message).toBe(1);
    const brief = await (await get("/api/show_co/brief")).json() as { text: string };
    expect(brief.text).toContain("Enquiries up 12% on last week.");
    expect(brief.text).toContain("a lead ((email hidden)) asked for an (subject hidden).");

    const map = await (await get("/api/show_co/graph/map")).json() as { nodes: Array<{ id: string; label: string; name: string }>; links: unknown[] };
    const lead = map.nodes.find((x) => x.label === "Lead");
    expect(lead).toMatchObject({ name: "A lead" });
    expect(lead!.id).toMatch(/^lead:hidden-[0-9a-f]{12}$/);
    expect(map.nodes.find((x) => x.label === "Client")?.name).toBe("A customer");
    expect(map.nodes.find((x) => x.id === "business:aamdani")?.name).toBeTruthy();
    expect(map.links.length).toBeGreaterThan(0);

    // a tap on the masked lead opens its card: plain facts only, its neighbours masked
    const card = await (await get(`/api/show_co/node/${encodeURIComponent(lead!.id)}`)).json() as { node: { name: string }; props: Record<string, unknown>; neighbors: Array<{ node: { name: string } }> };
    expect(card.node.name).toBe("A lead");
    expect(card.props).toMatchObject({ stage: "contacted", source: "Email" });
    expect(card.props).not.toHaveProperty("subject");
    expect(card.neighbors.map((x) => x.node.name)).toEqual(expect.arrayContaining(["A lead", "A message"])); // the person who asked is a lead too
    // asked for by its real id, it is not there
    expect((await get("/api/show_co/node/lead:rahul-mehta-example-com")).status).toBe(404);
    expect((await get("/api/show_co/graph?focus=person:rahul-mehta-example-com")).status).toBe(404);

    // the recorded thread: the answer and its path stay, the names do not; the typing is one piece
    const events = await (await get("/api/show_co/turns/turn:show-1/events")).json() as { events: Array<Record<string, unknown>> };
    const path = events.events.find((x) => x.type === "path") as { nodes: Array<{ name: string; id: string }>; edges: Array<{ from: string; to: string }> };
    expect(path.nodes.map((x) => x.name)).toEqual(["A lead", "A lead"]);
    expect(path.edges[0]!.from).toBe(path.nodes[0]!.id);
    expect(events.events.filter((x) => x.type === "text")).toEqual([{ type: "text", agent: "chief-of-staff", delta: "a lead asked for a quote; enquiries are up 12%." }]);
    expect(events.events.find((x) => x.type === "tool_call")).toMatchObject({ name: "lead_lookup", args: {} });

    // search leaves private things out altogether
    expect(await (await get("/api/show_co/search?q=Rahul")).json()).toEqual([]);
    expect(await (await get("/api/show_co/search?q=rahul.mehta%40example.com")).json()).toEqual([]);
    expect((await (await get("/api/show_co/search?q=enquiries")).json() as unknown[]).length).toBeGreaterThan(0); // Today's note is found
    // "what breaks if it stops" for a private name says it is not there, without repeating the name
    const atWork = await (await get("/api/show_co/graph/at-work?focus=Rahul%20Mehta")).json() as { focus: unknown; notFound: { message: string } };
    expect(atWork).toMatchObject({ focus: null, notFound: { message: "I don't have that in your records." } });
  });

  it("sees an email card waiting for an OK without its recipient, subject or text", async () => {
    const cards = await (await get("/api/show_co/approvals")).json() as Array<Record<string, unknown>>;
    const email = cards.find((c) => c.kind === "email_send")!;
    expect(email).toMatchObject({ title: "An email to a customer", payload: { title: "An email to a customer", body: HIDDEN_TEXT } });
    expect(email.preview ?? {}).not.toHaveProperty("to");
    expect(email.preview ?? {}).not.toHaveProperty("subject");
    expect((cards.find((c) => c.kind === "content_draft") as { title: string }).title).toBe("Double down on salary reels"); // a public post is kept
  });

  it("watches a recorded thread as an event stream with no typing and no names, and cannot start a live one", async () => {
    const res = await fetch(`${url}/api/show_co/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "", turnId: "turn:show-1" }) });
    const text = await res.text();
    for (const s of SECRETS) expect(text).not.toContain(s);
    expect(text).not.toMatch(/event: text/);
    expect(text).toMatch(/event: final\ndata: .*a lead asked for a quote/);
    const live = await fetch(`${url}/api/show_co/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "Who are my customers?" }) });
    expect(await live.text()).toMatch(/Live chat needs the owner's model access/);
  });
});

describe("the showcase's owner", () => {
  it("gets everything, unmasked", async () => {
    const cards = await (await get("/api/show_co/approvals", owner("show_co"))).json() as Array<{ kind: string; payload: { body: string }; preview?: { to?: string } }>;
    const email = cards.find((c) => c.kind === "email_send")!;
    expect(email.payload.body).toContain("Dear Rahul");
    expect(email.preview?.to).toBe("rahul.mehta@example.com");
    const card = await (await get("/api/show_co/node/lead:rahul-mehta-example-com", owner("show_co"))).json() as { node: { name: string } };
    expect(card.node.name).toBe("Rahul Mehta: oak dining table quote");
    const brief = await (await get("/api/show_co/brief", owner("show_co"))).json() as { text: string };
    expect(brief.text).toContain("Rahul Mehta (rahul.mehta@example.com)");
    const list = await (await get("/api/tenants", owner("show_co"))).json() as Array<Record<string, unknown>>;
    expect(list.find((t) => t.id === "show_co")).toMatchObject({ role: "owner" });
    expect(list.find((t) => t.id === "show_co")?.showcase).toBeUndefined();
  });
});

describe("a plain demo", () => {
  it("is unchanged: a stranger gets exactly what its owner gets", async () => {
    for (const r of ["approvals", "graph/map", "brief", "sessions/session:show-1", "turns/turn:show-1/events", "node/lead:rahul-mehta-example-com", "recommendations"]) {
      // a list's order is not fixed by its query (approvals), so the items are compared as a set
      const norm = (t: string): unknown => { const v = JSON.parse(t) as unknown; return Array.isArray(v) ? v.map((x) => JSON.stringify(x)).sort() : v; };
      const stranger = await (await get(`/api/demo_co/${r}`)).text();
      const own = await (await get(`/api/demo_co/${r}`, owner("demo_co"))).text();
      expect(norm(stranger), r).toEqual(norm(own));
    }
    expect(await (await get("/api/demo_co/brief")).text()).toContain("Rahul Mehta");
  });
});
