// Automatic meeting capture, end to end on a throwaway graph (test database only, 127.0.0.1:6391): the sample Fireflies account
// brings the Kettle & Crumb follow-up call with nobody pasting anything; Memory Keeper reads it (a fake runtime stands in for the
// model) and writes the minutes, cited to the transcript; every action item goes to its person or AI teammate; the minutes email
// waits as a card; the run is a chat thread. A second run saves nothing twice. A recorder that is not connected says how to
// connect it, and a forwarded transcript takes the same path.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AskDeps } from "../../src/agent/ask.js";
import { capturedIds } from "../../src/agent/meeting.js";
import { FakeRuntime } from "../../src/agent/runtime.js";
import { toolsByName } from "../../src/agent/tools/index.js";
import type { ConnectionsPort } from "../../src/connections/service.js";
import { registerSampleTenant, sampleConnections } from "../../src/demo/sample/connections.js";
import { SAMPLE_FIREFLIES_ID } from "../../src/demo/sample/fireflies.js";
import { closeAll, openGraphByName, type GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { upsertNode } from "../../src/graph/upsert.js";
import { captureInbound, captureMeetings, connectWords } from "../../src/meetings/capture.js";
import { fireflies } from "../../src/meetings/recorders.js";
import { captureDue } from "../../src/meetings/schedule.js";
import { testGraphName } from "../helpers/graph.js";

const NOW = Date.UTC(2026, 9, 18, 6, 0);
const TENANT = "meetcap_test";
const RITIKA = "ritika@kettleandcrumb.example";
const AMAN = "aman@kettleandcrumb.example";

// What the model returns for the sample follow-up call (the shape MEETING_SCHEMA asks for).
const EXTRACTED = {
  title: "Follow-up call with Kettle & Crumb",
  date: "2026-10-17",
  summary: "Kettle & Crumb adds 5 kg a month of decaf, moves to 15-day payment terms and asks for a launch-day post; its reorder coupon fails at checkout.",
  attendees: [
    { name: "Ritika Menon", email: "", company: "Kettle & Crumb", role: "owner", side: "them" },
    { name: "Aman Shetty", email: "", company: "Kettle & Crumb", role: "head barista", side: "them" },
    { name: "Wholesale lead (sample role)", email: "", company: "", role: "wholesale lead", side: "us" },
    { name: "Marketing lead (sample role)", email: "", company: "", role: "marketing lead", side: "us" },
  ],
  people: [],
  companies: [{ name: "Kettle & Crumb", relation: "client" }],
  products: [],
  decisions: [
    { text: "Add 5 kg a month of decaf at Rs 1,250 per kg, 45 kg a month in total", decidedBy: ["Ritika Menon"], about: ["Kettle & Crumb"] },
    { text: "Payment 15 days after each delivery", decidedBy: ["Ritika Menon"], about: ["Kettle & Crumb"] },
    { text: "A joint post on launch day, Monday 2 November", decidedBy: [], about: ["Kettle & Crumb"] },
  ],
  tasks: [
    { text: "Send the revised quote with the decaf and the 15-day terms", owner: "Wholesale lead (sample role)", due: "2026-10-20", about: ["Ritika Menon"] },
    { text: "Fix the wholesale checkout so the reorder coupon works", owner: "us", due: "2026-10-21", about: [] },
    { text: "Post about the new roast at Kettle & Crumb on launch day", owner: "Marketing lead (sample role)", due: "2026-11-02", about: ["Kettle & Crumb"] },
    { text: "Schedule the barista training for Tuesday 3 November at 3 pm", owner: "us", due: "", about: ["Kettle & Crumb"] },
    { text: "Share the opening-week menu", owner: "Aman Shetty", due: "2026-10-23", about: [] },
    { text: "Send the GST details for the invoices", owner: "Ritika Menon", due: "2026-10-19", about: [] },
  ],
  numbers: ["5 kg a month", "Rs 1,250 per kg", "45 kg a month", "15 days"],
  dates: [{ text: "launch day", date: "2026-11-02" }],
};

describe("meeting capture, end to end (test database)", () => {
  let g: GraphHandle;
  let runtime: FakeRuntime;
  let port: ConnectionsPort;
  const askDeps = async (): Promise<AskDeps> => ({ runtime, getTools: toolsByName, graph: g, now: () => NOW });
  const one = async <T>(cypher: string, params: Record<string, unknown> = {}): Promise<T> => (await g.roQuery<T>(cypher, params))[0]!;
  const ids = capturedIds({ recorder: "fireflies", externalId: SAMPLE_FIREFLIES_ID });

  beforeAll(async () => {
    g = await openGraphByName(testGraphName());
    await ensureIndexes(g);
    await upsertNode(g, { type: "Business", id: `business:${TENANT}`, name: "Blue Tokai Coffee Roasters", props: { slug: TENANT, timeZone: "Asia/Kolkata" } }, NOW);
    registerSampleTenant(TENANT);
    port = sampleConnections(TENANT, () => NOW);
    runtime = new FakeRuntime({ "librarian:work": { structured: EXTRACTED } });
  }, 60_000);
  afterAll(async () => {
    await g?.drop().catch(() => undefined);
    await closeAll();
  });

  it("the sample Fireflies call arrives by itself: minutes, routed action items, a minutes card, a chat thread", async () => {
    const r = await captureMeetings(TENANT, { graph: g, port, askDeps, now: () => NOW }, { recorder: "fireflies" });
    expect(r.recorders).toEqual([expect.objectContaining({ id: "fireflies", state: "connected" })]);
    expect(r.saved).toEqual([expect.objectContaining({ recorder: "fireflies", externalId: SAMPLE_FIREFLIES_ID, ok: true })]);
    // one model call: Memory Keeper's reading; the minutes and the email are written from it
    expect(runtime.runs.map((x) => x.agentId)).toEqual(["librarian"]);
    expect(runtime.runs[0]!.prompt).toContain("Sample transcript (made up for the demo, nobody real)");
    expect(runtime.runs[0]!.prompt).toContain("Aman Shetty: Small thing");

    // the Meeting, named by the recorder's id, with the recorder's title and day
    const m = await one<{ name: string; date: string; recorder: string; ext: string; kind: string; simulated: boolean }>(
      "MATCH (m:Entity:Meeting {id:$id}) RETURN m.name AS name, m.date AS date, m.recorder AS recorder, m.externalId AS ext, m.kind AS kind, m.simulated AS simulated", { id: ids.meetingId });
    expect(m).toEqual({ name: "Kettle & Crumb follow-up call (sample)", date: "2026-10-17", recorder: "fireflies", ext: SAMPLE_FIREFLIES_ID, kind: "recorded", simulated: true });

    // the transcript is the cited source, cleaned; the minutes come from it and say who picks up each item
    const doc = await one<{ text: string; recorder: string }>("MATCH (d:Entity:Document {id:$id}) RETURN d.text AS text, d.recorder AS recorder", { id: ids.docId });
    expect(doc.recorder).toBe("fireflies");
    expect(doc.text).toContain("KETTLE10 coupon failed at checkout");
    expect(doc.text).not.toContain("kettleandcrumb.example");
    const minutes = await one<{ text: string; kind: string; src: string }>("MATCH (d:Entity:Document {id:$id}) RETURN d.text AS text, d.kind AS kind, d.src AS src", { id: ids.minutesId });
    expect(minutes).toMatchObject({ kind: "minutes", src: ids.docId });
    expect(minutes.text).toMatch(/^Minutes: Kettle & Crumb follow-up call \(sample\)\nSat 17 Oct · from the Fireflies transcript · sample meeting, nobody real/);
    expect(minutes.text).toContain("- Send the revised quote with the decaf and the 15-day terms (Wholesale lead (sample role), by Tue 20 Oct) → Deal Closer");
    expect(minutes.text).toContain("- Send the GST details for the invoices (Ritika Menon, by Mon 19 Oct)\n");
    const links = await g.roQuery<{ rel: string; type: string }>(
      "MATCH (d:Entity:Document {id:$id})-[r]->(x:Entity) WHERE r.until IS NULL RETURN type(r) AS rel, [l IN labels(x) WHERE l <> 'Entity' AND l <> 'Searchable'][0] AS type", { id: ids.minutesId });
    const tally = new Map<string, number>();
    for (const l of links) tally.set(`${l.rel} ${l.type}`, (tally.get(`${l.rel} ${l.type}`) ?? 0) + 1);
    const minuteLinks = [...tally].sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => ({ rel: k.split(" ")[0], type: k.split(" ")[1], n }));
    expect(minuteLinks).toEqual([
      { rel: "MENTIONS", type: "Decision", n: 3 }, { rel: "MENTIONS", type: "Meeting", n: 1 }, { rel: "MENTIONS", type: "Task", n: 6 }, { rel: "SOURCED_FROM", type: "Document", n: 1 },
    ]);
    expect((await one<{ n: number }>("MATCH (a:Entity:Agent {id:'agent:allevia-librarian'})-[r:AUTHORED]->(d:Entity:Document {id:$id}) WHERE r.until IS NULL RETURN count(d) AS n", { id: ids.minutesId })).n).toBe(1);

    // each action item has one owner: the teammate whose job it is, the colleague who took it, or the other side
    const owned = await g.roQuery<{ task: string; owner: string; to: string | null }>(
      "MATCH (o:Entity)-[r:OWNS]->(t:Task {kind:'meeting_task'}) WHERE r.until IS NULL RETURN t.name AS task, o.name AS owner, t.routedTo AS to ORDER BY task, t.id");
    expect(owned.map((o) => [o.task, o.owner])).toEqual([
      ["Fix the wholesale checkout so the reorder coupon works", "Techie"],
      ["Post about the new roast at Kettle & Crumb on launch day", "Miss Influencer"],
      ["Schedule the barista training for Tuesday 3 November at 3 pm", "Taskmaster"],
      ["Send the GST details for the invoices", "Ritika Menon"],
      ["Send the revised quote with the decaf and the 15-day terms", "Deal Closer"],
      ["Share the opening-week menu", "Aman Shetty"],
    ]);
    // on each teammate's to-do list
    const todo = await g.roQuery<{ agent: string; n: number }>(
      "MATCH (a:Entity:Agent)-[r:OWNS]->(t:Task {status:'open'}) WHERE r.until IS NULL WITH a, count(t) AS n RETURN a.name AS agent, n ORDER BY agent, a.id");
    expect(todo).toEqual([{ agent: "Deal Closer", n: 1 }, { agent: "Miss Influencer", n: 1 }, { agent: "Taskmaster", n: 1 }, { agent: "Techie", n: 1 }]);

    // the minutes email waits for the OK: to everyone on the call, the minutes without the internal hand-overs; the card says where each went
    const card = await one<{ status: string; kind: string; payload: string; title: string }>("MATCH (a:Approval) RETURN a.status AS status, a.kind AS kind, a.payload AS payload, a.title AS title");
    expect(card).toMatchObject({ status: "pending", kind: "email_send", title: "Send email: Minutes: Kettle & Crumb follow-up call (sample) (Sat 17 Oct)" });
    const payload = JSON.parse(card.payload) as { to: string[]; body: string; send: boolean; sample: boolean };
    expect(payload).toMatchObject({ send: true, sample: true });
    expect(payload.to).toEqual([RITIKA, AMAN, "wholesale@roaster-sample.example", "marketing@roaster-sample.example"]);
    expect(payload.body).toMatch(/^Hi Ritika, Aman, Wholesale, Marketing,\n\nHere are the minutes of our call on Sat 17 Oct\./);
    expect(payload.body).toContain("Action items");
    expect(payload.body).not.toMatch(/Deal Closer|Techie|→/);
    const rec = await one<{ why: string; by: string }>("MATCH (a:Entity:Agent)-[:PRODUCED]->(r:Recommendation) RETURN r.summary AS why, a.name AS by");
    expect(rec.by).toBe("Memory Keeper");
    expect(rec.why).toContain("Who picks each one up: Send the revised quote with the decaf and the 15-day terms: Deal Closer for Wholesale lead (sample role);");
    expect(rec.why).toContain("Send the GST details for the invoices: Ritika Menon");

    // the run is a chat thread with the summary
    const turn = await one<{ q: string; answer: string; session: string }>(
      "MATCH (t:Entity:Turn {id:$id})-[:IN_SESSION]->(s:Session) RETURN t.question AS q, t.answer AS answer, s.name AS session", { id: r.saved[0]!.turnId });
    expect(turn.q).toBe("New meeting from Fireflies: Kettle & Crumb follow-up call (sample)");
    expect(turn.session).toBe(turn.q);
    expect(turn.answer).toMatch(/^Fireflies brought in "Kettle & Crumb follow-up call \(sample\)" with Ritika Menon and Aman Shetty on Sat 17 Oct, so the team wrote the minutes \[\[document:/);
    expect(turn.answer).toContain("**Who does what**");
    expect(turn.answer).toMatch(/- Fix the wholesale checkout so the reorder coupon works: your team, by Wed 21 Oct → Techie \[\[task:/);
    expect(turn.answer).toContain("Memory Keeper wrote the minutes email to Ritika Menon, Aman Shetty, Wholesale lead (sample role), Marketing lead (sample role). Nothing goes out until you say OK.");
    expect(turn.answer).toContain("sample data");
  });

  it("a second run reads nothing again and saves nothing twice", async () => {
    const before = await one<{ n: number }>("MATCH (n:Entity) RETURN count(n) AS n");
    const runs = runtime.runs.length;
    const r = await captureMeetings(TENANT, { graph: g, port, askDeps, now: () => NOW + 3_600_000 });
    expect(r.saved).toEqual([]);
    expect(r.skipped).toEqual([expect.objectContaining({ externalId: SAMPLE_FIREFLIES_ID, why: "already saved" })]);
    expect(runtime.runs.length).toBe(runs);
    expect((await one<{ n: number }>("MATCH (n:Entity) RETURN count(n) AS n")).n).toBe(before.n);
    expect((await one<{ n: number }>("MATCH (m:Meeting) RETURN count(m) AS n")).n).toBe(1);
    expect((await one<{ n: number }>("MATCH (a:Approval) RETURN count(a) AS n")).n).toBe(1);
    // Granola is not connected in the demo: it says how to connect it, and nothing is called
    expect(r.recorders.find((x) => x.id === "granola")).toMatchObject({ state: "not_connected", message: expect.stringContaining("/connections?connect=granola") });
  });

  it("not connected: a plain line with where to connect it, and no call to the recorder", async () => {
    let ran = 0;
    const off: ConnectionsPort = {
      tenant: TENANT, list: async () => [], note: async () => "",
      status: async () => ({ state: "not_connected", message: "" }),
      run: async () => { ran++; throw new Error("not connected"); },
    };
    const r = await captureMeetings(TENANT, { graph: g, port: off, askDeps, now: () => NOW });
    expect(r.recorders.map((x) => [x.id, x.state])).toEqual([["fireflies", "not_connected"], ["granola", "not_connected"]]);
    expect(r.recorders[0]!.message).toBe(connectWords(fireflies));
    expect(r.recorders[0]!.message).toMatch(/^Fireflies isn't connected yet\. Connect it on Your tools \(\/connections\?connect=fireflies\)/);
    expect(ran).toBe(0);
  });

  it("a transcript sent to the meeting address takes the same path, once", async () => {
    const inbound = new FakeRuntime({ "librarian:work": { structured: { ...EXTRACTED, title: "Supplier call", decisions: [EXTRACTED.decisions[0]], tasks: [EXTRACTED.tasks[1]] } } });
    const deps = { graph: g, port, askDeps: async (): Promise<AskDeps> => ({ runtime: inbound, getTools: toolsByName, graph: g, now: () => NOW }), now: () => NOW };
    const text = "Supplier call, 15 October\nPriya: The green beans go up 4 percent in November.\nUs: Then we fix the checkout coupon first and talk prices next week.";
    const first = await captureInbound(TENANT, { id: "call-77", title: "Supplier call", text }, deps);
    expect(first.status).toBe("saved");
    expect(first.meetingId).toBe(capturedIds({ recorder: "inbound", externalId: "call-77" }).meetingId);
    expect((await captureInbound(TENANT, { id: "call-77", text }, deps)).status).toBe("already_saved");
    expect(inbound.runs).toHaveLength(1);
    await expect(captureInbound(TENANT, { text: "too short" }, deps)).rejects.toThrow(/too short/);
  });

  it("the clock reads only businesses with a real recorder connected", async () => {
    const ran: string[] = [];
    const out = await captureDue({
      tenants: async () => [{ slug: "bluetokai" }, { slug: "a_shop" }, { slug: "b_firm" }],
      isSample: (s) => s === "bluetokai",
      connected: async (s) => (s === "b_firm" ? ["gmail", "fireflies"] : ["gmail"]),
      openGraph: async () => g,
      run: async (s) => { ran.push(s); return { tenant: s, recorders: [], saved: [], skipped: [] }; },
    });
    expect(out).toEqual(["b_firm"]);
    expect(ran).toEqual(["b_firm"]);
  });
});
