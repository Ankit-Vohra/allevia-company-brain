// "Remember this meeting": the owner pastes notes or a transcript; Memory Keeper pulls out the meeting, decisions, tasks, people and
// numbers (a fake runtime stands in for the model), the writes carry the pasted text as their source and go through the privacy
// filter, Taskmaster files the tasks, Deal Closer's follow-up waits as a card, the answer is charged as a team answer, and
// meetings_read finds it again. Test database only (127.0.0.1:6391).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentEvent } from "../../shared/contracts.js";
import { SAMPLE_MEETING_ASK, SAMPLE_MEETING_NOTES } from "../../shared/sample-meeting.js";
import { ask, type AskDeps } from "../../src/agent/ask.js";
import {
  dayWords, isRememberMeeting, isSampleNotes, meetingAnswer, meetingNotesIn, normaliseExtracted, sameName,
} from "../../src/agent/meeting.js";
import { FakeRuntime, type FakeScript } from "../../src/agent/runtime.js";
import { TouchedSet, type ToolContext } from "../../src/agent/tool.js";
import { toolsByName } from "../../src/agent/tools/index.js";
import { chargedAsk } from "../../src/credits/ask.js";
import { Credits } from "../../src/credits/index.js";
import { closeAll, openGraphByName, type GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { upsertNode } from "../../src/graph/upsert.js";
import { leadIdFor, openDeal, personIdFor, recordEnquiry } from "../../src/sales/graph.js";
import { meetingPrefill } from "../../web/src/lib/chat.js";
import { testGraphName } from "../helpers/graph.js";

const NOW = Date.UTC(2026, 9, 17, 10, 0);
const TENANT = "meet_test";
const RITIKA = "ritika@kettleandcrumb.example";
const AMAN = "aman@kettleandcrumb.example";

// What the model returns for the sample call (the shape MEETING_SCHEMA asks for).
const EXTRACTED = {
  title: "Tasting call with Kettle & Crumb",
  date: "2026-10-16",
  summary: "Kettle & Crumb picked the dark roast as its house espresso and agreed a 40 kg a month wholesale order.",
  attendees: [
    { name: "Ritika Menon", email: RITIKA, company: "Kettle & Crumb", role: "owner", side: "them" },
    { name: "Aman Shetty", email: AMAN, company: "Kettle & Crumb", role: "head barista", side: "them" },
    { name: "Wholesale lead (sample role)", email: "", company: "", role: "wholesale lead", side: "us" },
  ],
  people: [],
  companies: [{ name: "Kettle & Crumb", relation: "client" }],
  products: ["Dark roast"],
  decisions: [
    { text: "Kettle & Crumb switches its house espresso to the dark roast", decidedBy: ["Ritika Menon"], about: ["Kettle & Crumb", "Dark roast"] },
    { text: "40 kg a month, delivered in two drops of 20 kg every two weeks", decidedBy: ["Ritika Menon"], about: ["Kettle & Crumb"] },
    { text: "Rs 1,150 per kg for the first three months, then a review", decidedBy: [], about: ["Kettle & Crumb"] },
    { text: "First delivery on Monday 2 November, before 8 am", decidedBy: [], about: [] },
  ],
  tasks: [
    { text: "Send the written quote and the supply agreement", owner: "Wholesale lead (sample role)", due: "2026-10-20", about: ["Ritika Menon"] },
    { text: "Book a barista training session at the café", owner: "Wholesale lead (sample role)", due: "", about: ["Kettle & Crumb"] },
    { text: "Confirm the delivery window and the billing address", owner: "Ritika Menon", due: "2026-10-21", about: [] },
    { text: "Send the grinder model", owner: "Aman Shetty", due: "2026-10-19", about: [] },
  ],
  numbers: ["40 kg a month", "20 kg every two weeks", "Rs 1,150 per kg", "three months", "40 seats"],
  dates: [{ text: "first delivery", date: "2026-11-02" }, { text: "quote and agreement", date: "2026-10-20" }],
};
const FOLLOW_UP = {
  subject: "Our tasting call: what we agreed",
  body: "Hi Ritika and Aman,\n\nThank you for tasting with us. We agreed the dark roast as your house espresso, 40 kg a month in two drops of 20 kg.\n\nThe team at Blue Tokai",
};
const scripts = (over: Record<string, FakeScript> = {}): Record<string, FakeScript> => ({
  "librarian:work": { structured: EXTRACTED },
  "sales-lead:work": { structured: FOLLOW_UP },
  ...over,
});

describe("meetingNotesIn: is this a meeting to remember?", () => {
  it("finds the notes after the request", () => {
    expect(meetingNotesIn(SAMPLE_MEETING_ASK)).toBe(SAMPLE_MEETING_NOTES);
    expect(isRememberMeeting(`Save the call notes from today\n${SAMPLE_MEETING_NOTES}`)).toBe(true);
    expect(isRememberMeeting(`please remember this meeting transcript: ${"We agreed on the price and the delivery day. ".repeat(12)}`)).toBe(true);
  });
  it("and leaves everything else to the team", () => {
    for (const q of [
      "Remember this meeting with Ritika on Friday",
      "What did we decide with Kettle & Crumb?",
      "What's pending from the meeting on 16 Oct?",
      "Remember that we never post on Sundays",
      `Why did online orders drop this week?\n${"Some more words about the orders. ".repeat(10)}`,
      "",
    ]) expect(isRememberMeeting(q), q).toBe(false);
  });
  it("Chat's \"Remember a meeting\" puts the request in the box: the demo coffee shop's sample call goes straight through", () => {
    expect(isRememberMeeting(meetingPrefill("bluetokai"))).toBe(true);
    expect(meetingPrefill("avs")).toBe("Remember this meeting:\n\n");
    expect(isRememberMeeting(meetingPrefill("avs"))).toBe(false); // nothing pasted yet
    expect(isRememberMeeting(`${meetingPrefill("avs")}${SAMPLE_MEETING_NOTES}`)).toBe(true);
  });
  it("a sample transcript says so in its first lines", () => {
    expect(isSampleNotes(SAMPLE_MEETING_NOTES)).toBe(true);
    expect(isSampleNotes("Call with Priya, 3 Oct\nPriya: we will take 10 kg.")).toBe(false);
  });
});

describe("what the model returns, held to the shape", () => {
  it("keeps what is there, drops what is malformed, fixes the side and the dates", () => {
    const m = normaliseExtracted({
      ...EXTRACTED, date: "16 October",
      attendees: [...EXTRACTED.attendees, { name: "", side: "them" }, { name: "Nisha", email: "not an email", side: "boss" }],
      tasks: [...EXTRACTED.tasks, { text: "  ", owner: "x" }, { text: "Call back", owner: "us", due: "2026-02-30" }],
    })!;
    expect(m.date).toBe("");
    expect(m.attendees.map((a) => a.name)).toEqual(["Ritika Menon", "Aman Shetty", "Wholesale lead (sample role)", "Nisha"]);
    expect(m.attendees[3]).toEqual({ name: "Nisha", side: "unknown" });
    expect(m.tasks).toHaveLength(5);
    expect(m.tasks[4]!.due).toBe("");
  });
  it("nothing in it is no meeting", () => {
    expect(normaliseExtracted({})).toBeNull();
    expect(normaliseExtracted("text")).toBeNull();
    expect(normaliseExtracted({ title: "A call", decisions: [], tasks: [], attendees: [] })).toBeNull();
  });
  it("names match the records by their words", () => {
    expect(sameName("Dark roast", "Dark roast, 500 g (sample product)")).toBe(true);
    expect(sameName("Ritika", "Ritika Menon")).toBe(true);
    expect(sameName("Kettle & Crumb", "Kettle and Crumb Café")).toBe(true);
    expect(sameName("Kettle & Crumb", "Copper Kettle")).toBe(false);
    expect(sameName("the", "The new roast")).toBe(false);
  });
  it("the answer: counts, decisions, tasks with owners, the card", () => {
    const meeting = normaliseExtracted(EXTRACTED)!;
    const a = meetingAnswer({
      meeting, date: "2026-10-16", sample: true, removed: "2 email addresses",
      counts: { decisions: 4, tasks: 4, people: 3, companies: 1, products: 1, peopleAndCompanies: 5, numbersAndDates: 7, linkedToRecords: 2 },
      decisions: [{ id: "decision:a", text: "Dark roast" }], tasks: [{ id: "task:a", text: "Send the quote", ownerName: "Wholesale lead", due: "2026-10-20" }],
      names: ["Ritika Menon", "Aman Shetty"], to: [RITIKA, AMAN], approvalId: "approval:x",
    });
    expect(a).toMatch(/^Saved the meeting with Ritika Menon and Aman Shetty on Fri 16 Oct: 4 decisions, 4 tasks, 5 people and companies, 7 numbers and dates\./);
    expect(a).toContain("sample data");
    expect(a).toContain("- Send the quote: Wholesale lead, by Tue 20 Oct [[task:a]]");
    expect(a).toContain("**Waiting for your OK**\n- Deal Closer wrote the follow-up email to Ritika Menon and Aman Shetty. Nothing goes out until you say OK.");
    expect(a).toContain("I took out 2 email addresses before saving.");
    expect(dayWords("2026-11-02")).toBe("Mon 2 Nov");
  });
});

describe("remember this meeting, end to end (test database)", () => {
  let g: GraphHandle;
  const metaGraph = testGraphName();
  let lead = "", deal = "";
  const ritika = personIdFor(RITIKA, "Ritika Menon");

  beforeAll(async () => {
    g = await openGraphByName(testGraphName());
    await ensureIndexes(g);
    await upsertNode(g, { type: "Business", id: `business:${TENANT}`, name: "Blue Tokai Coffee Roasters", props: { slug: TENANT } }, NOW);
    await upsertNode(g, { type: "Product", id: "product:dark-roast", name: "Dark roast, 500 g (sample product)", props: { sample: true }, src: "document:sample-shopify-export", asOf: "2026-10-16" }, NOW);
    const r = await recordEnquiry(g, { name: "Ritika Menon", email: RITIKA, channel: "email", subject: "Wholesale beans for our café", body: "We would need about 40 kg a month.", at: NOW - 3 * 86_400_000, externalId: "m-1" }, { src: "message:m-1", now: NOW - 3 * 86_400_000, tenant: TENANT });
    lead = r.leadId;
    deal = await openDeal(g, { leadId: lead, title: "Kettle & Crumb: wholesale (sample)", stage: "contacted" }, { src: "message:m-1", now: NOW - 2 * 86_400_000, tenant: TENANT });
  }, 60_000);
  afterAll(async () => {
    await g?.drop().catch(() => undefined);
    await (await openGraphByName(metaGraph)).drop().catch(() => undefined);
    await closeAll();
  });

  const deps = (runtime: FakeRuntime): AskDeps => ({ runtime, getTools: toolsByName, graph: g, now: () => NOW });
  const one = async <T>(cypher: string, params: Record<string, unknown> = {}): Promise<T> => (await g.roQuery<T>(cypher, params))[0]!;

  it("saves the meeting, its decisions and tasks with the pasted text as their source, and charges a team answer", async () => {
    const runtime = new FakeRuntime(scripts());
    const events: AgentEvent[] = [];
    const credits = new Credits({ openGraph: async () => g, tenantOpts: { metaGraph }, now: () => NOW, log: () => {} });
    const notes = `${SAMPLE_MEETING_NOTES}\nAman's mobile, if the gate is shut: +91 98450 12345.`;
    const r = await chargedAsk({ tenant: TENANT, question: `Remember this meeting:\n\n${notes}`, channel: "web" }, deps(runtime), (e) => events.push(e), { credits, g });

    expect(r.ok).toBe(true);
    expect(r.outcome?.fastPath).toBe(false);
    expect(r.agents).toEqual(["chief-of-staff", "librarian", "ops-manager", "sales-lead"]);
    // only Memory Keeper and Deal Closer called the model; the plan was not asked for
    expect(runtime.runs.map((x) => x.agentId)).toEqual(["librarian", "sales-lead"]);
    expect(runtime.runs[0]!.outputSchema).toBeDefined();
    expect(runtime.runs[0]!.prompt).toContain("Rs 1,150 per kg");

    // the pasted text is a Document, cleaned: no email address and no phone number reach the graph
    const doc = await one<{ id: string; text: string; src: string; simulated: boolean }>("MATCH (d:Document {kind:'meeting_notes'}) RETURN d.id AS id, d.text AS text, d.src AS src, d.simulated AS simulated");
    expect(doc.src).toBe(r.turnId);
    expect(doc.text).toContain("Rs 1,150 per kg");
    expect(doc.text).not.toContain("kettleandcrumb.example");
    expect(doc.text).not.toContain("98450");
    expect(doc.text).toContain("[redacted:");
    expect(doc.simulated).toBe(true);

    // the meeting, four decisions and four tasks, each sourced to it and dated the day of the meeting
    const made = await g.roQuery<{ type: string; n: number }>(
      "MATCH (x:Entity) WHERE x.src = $doc WITH [l IN labels(x) WHERE l <> 'Entity' AND l <> 'Searchable'][0] AS type, x RETURN type, count(x) AS n ORDER BY type", { doc: doc.id });
    expect(Object.fromEntries(made.map((m) => [m.type, m.n]))).toEqual({ Client: 1, Decision: 4, Meeting: 1, Person: 2, Task: 4 });
    const asOf = await g.roQuery<{ asOf: string }>("MATCH (x:Entity) WHERE x.src = $doc RETURN DISTINCT x.asOf AS asOf", { doc: doc.id });
    expect(asOf.map((a) => a.asOf)).toEqual(["2026-10-16"]);
    // every edge the notes made carries them as its source
    const unsourced = await one<{ n: number }>(
      "MATCH (m:Meeting {date:'2026-10-16'}) WITH m MATCH (x:Entity)-[r]-(y:Entity) WHERE (x = m OR x.src = m.src) AND type(r) IN ['PART_OF','MEETING_WITH','MEETING_FOR','SOURCED_FROM','BASED_ON','AFFECTS','DECIDED','FOLLOWS_UP','OWNS','MENTIONS'] AND r.src <> m.src RETURN count(r) AS n");
    expect(unsourced.n).toBe(0);

    // linked into the brain, not floating: Ritika's own record (no second Ritika), her deal, the product, the business
    expect((await one<{ n: number }>("MATCH (p:Person) WHERE p.name = 'Ritika Menon' RETURN count(p) AS n")).n).toBe(1);
    const links = await g.roQuery<{ rel: string; to: string }>(
      "MATCH (m:Meeting {date:'2026-10-16'})-[r]->(x:Entity) RETURN type(r) AS rel, x.id AS to ORDER BY rel, to");
    expect(links).toEqual(expect.arrayContaining([
      { rel: "MEETING_WITH", to: ritika }, { rel: "MEETING_FOR", to: deal }, { rel: "PART_OF", to: `business:${TENANT}` }, { rel: "SOURCED_FROM", to: doc.id },
    ]));
    const darkRoast = await one<{ n: number }>("MATCH (d:Decision)-[:AFFECTS]->(:Product {id:'product:dark-roast'}) RETURN count(d) AS n");
    expect(darkRoast.n).toBe(1);
    expect((await one<{ n: number }>("MATCH (:Entity {id:$p})-[:DECIDED]->(d:Decision) RETURN count(d) AS n", { p: ritika })).n).toBe(2);
    expect((await one<{ n: number }>("MATCH (d:Decision)-[:PART_OF]->(:Meeting) RETURN count(d) AS n")).n).toBe(4);
    expect((await one<{ n: number }>("MATCH (:Entity {id:$p})-[:MEMBER_OF]->(c:Client) RETURN count(c) AS n", { p: ritika })).n).toBe(1);

    // Taskmaster filed the tasks: each with its owner, a due date when one was said
    const owned = await g.roQuery<{ task: string; owner: string; due: string | null }>(
      "MATCH (o:Entity)-[r:OWNS]->(t:Task {kind:'meeting_task'}) WHERE r.until IS NULL RETURN t.name AS task, o.name AS owner, t.due AS due, t.id AS tid ORDER BY task, tid");
    expect(owned.map((o) => ({ task: o.task, owner: o.owner, due: o.due }))).toEqual([
      { task: "Book a barista training session at the café", owner: "Wholesale lead (sample role)", due: null },
      { task: "Confirm the delivery window and the billing address", owner: "Ritika Menon", due: "2026-10-21" },
      { task: "Send the grinder model", owner: "Aman Shetty", due: "2026-10-19" },
      { task: "Send the written quote and the supply agreement", owner: "Wholesale lead (sample role)", due: "2026-10-20" },
    ]);
    expect((await one<{ n: number }>("MATCH (:Agent {id:'agent:allevia-ops-manager'})-[:PRODUCED]->(t:Task) RETURN count(t) AS n")).n).toBe(4);

    // Deal Closer's follow-up waits for the OK, addressed to the people on the call
    const card = await one<{ id: string; status: string; kind: string; payload: string }>("MATCH (a:Approval) RETURN a.id AS id, a.status AS status, a.kind AS kind, a.payload AS payload");
    expect(card).toMatchObject({ status: "pending", kind: "email_send" });
    const payload = JSON.parse(card.payload) as { to: string[]; subject: string; send: boolean; body: string };
    expect(payload).toMatchObject({ to: [RITIKA, AMAN], subject: FOLLOW_UP.subject, send: true });
    expect(events.find((e) => e.type === "proposal")).toMatchObject({ agent: "sales-lead", approvalId: card.id, kind: "email_send" });
    const evidence = await g.roQuery<{ id: string }>("MATCH (:Recommendation)-[:EVIDENCED_BY]->(x:Entity) RETURN x.id AS id ORDER BY id");
    expect(evidence.map((e) => e.id)).toEqual([doc.id, "meeting:tasting-call-with-kettle-crumb-2026-10-16"]);

    // a note through remember, for recall
    expect((await one<{ n: number }>("MATCH (:Memory)-[:ABOUT]->(:Meeting) RETURN count(*) AS n")).n).toBe(1);

    // the short answer, and its checks
    expect(r.answer).toMatch(/^Saved the meeting with Ritika Menon and Aman Shetty on Fri 16 Oct: 4 decisions, 4 tasks, 5 people and companies, 7 numbers and dates\./);
    expect(r.answer).toContain("**Decided**");
    expect(r.answer).toMatch(/- Send the grinder model: Aman Shetty, by Mon 19 Oct \[\[task:/);
    expect(r.answer).toContain("Nothing goes out until you say OK.");
    expect(r.answer).toMatch(/I took out .*email address.* before saving/);
    expect(r.checks).toMatchObject({ citationsValid: true, numbersGrounded: true, simulatedDisclosed: true });
    // the path on the map, behind "How we got this"
    const path = events.find((e) => e.type === "path") as Extract<AgentEvent, { type: "path" }>;
    expect(path.nodes[0]!.id).toBe(doc.id);
    expect(path.nodes[1]!.id).toMatch(/^meeting:/);
    expect(path.edges.length).toBeGreaterThan(4);
    expect(events.at(-1)?.type).toBe("final");

    // the Turn is saved, touched what it made, and the answer was charged as a team answer
    expect((await one<{ n: number }>("MATCH (t:Turn {id:$t})-[:TOUCHED]->(:Meeting) RETURN count(*) AS n", { t: r.turnId })).n).toBe(1);
    const charged = (await credits.entries(TENANT, "2026-10", { g })).filter((e) => e.service.startsWith("question"));
    expect(charged.map((e) => [e.service, e.credits])).toEqual([["question_deep", -5]]);
  });

  it("finds it again: what did we decide with Kettle & Crumb, what's pending from the meeting on 16 Oct", async () => {
    const [tool] = toolsByName(["meetings_read"]);
    const ctx: ToolContext = { graph: g, tenant: TENANT, turnId: "turn:2026-10-17-read", agentId: "librarian", asker: "person:founder", touched: new TouchedSet(), now: NOW };
    type Out = { meetings: Array<{ id: string; date: string; with: string[]; simulated?: boolean; decisions: Array<{ text: string }>; tasks: Array<{ text: string; owner: string | null; due: string | null; status: string }>; followUps?: Array<{ status: string }> }>; openTasks: number };

    const withThem = await tool!.run({ with: "Kettle & Crumb" }, ctx);
    const a = withThem.data as Out;
    expect(a.meetings).toHaveLength(1);
    expect(a.meetings[0]).toMatchObject({ date: "2026-10-16", simulated: true, followUps: [{ status: "pending" }] });
    expect(a.meetings[0]!.decisions.map((d) => d.text)).toContain("Rs 1,150 per kg for the first three months, then a review");
    expect(a.meetings[0]!.with).toEqual(expect.arrayContaining(["Ritika Menon", "Aman Shetty"]));
    expect(withThem.note).toMatch(/sample data/);
    expect(withThem.nodes.some((n) => n.id === a.meetings[0]!.id)).toBe(true);

    // by the person too
    expect(((await tool!.run({ with: "Ritika Menon" }, ctx)).data as Out).meetings).toHaveLength(1);

    const pending = (await tool!.run({ date: "2026-10-16", open: true }, ctx)).data as Out;
    expect(pending.openTasks).toBe(4);
    expect(pending.meetings[0]!.tasks.map((t) => [t.text, t.owner, t.due])).toEqual([
      ["Send the grinder model", "Aman Shetty", "2026-10-19"],
      ["Send the written quote and the supply agreement", "Wholesale lead (sample role)", "2026-10-20"],
      ["Confirm the delivery window and the billing address", "Ritika Menon", "2026-10-21"],
      ["Book a barista training session at the café", "Wholesale lead (sample role)", null],
    ]);
    expect(((await tool!.run({ date: "2026-10-01" }, ctx)).data as Out).meetings).toEqual([]);
  });

  it("the same notes pasted again change nothing new: one meeting, one card", async () => {
    const r = await ask({ tenant: TENANT, question: SAMPLE_MEETING_ASK, channel: "discord" }, deps(new FakeRuntime(scripts())), () => {});
    expect(r.ok).toBe(true);
    expect((await one<{ n: number }>("MATCH (m:Meeting {date:'2026-10-16'}) RETURN count(m) AS n")).n).toBe(1);
    expect((await one<{ n: number }>("MATCH (d:Decision) RETURN count(d) AS n")).n).toBe(4);
    expect((await one<{ n: number }>("MATCH (a:Approval) WHERE a.status = 'pending' RETURN count(a) AS n")).n).toBe(1);
  });

  it("text with no meeting in it saves nothing and says so", async () => {
    const count = async () => (await one<{ n: number }>("MATCH (n:Entity) WHERE n:Meeting OR n:Decision OR n:Task OR n:Document OR n:Approval RETURN count(n) AS n")).n;
    const before = await count();
    const events: AgentEvent[] = [];
    const runtime = new FakeRuntime(scripts({ "librarian:work": { structured: { title: "", attendees: [], decisions: [], tasks: [] } } }));
    const r = await ask({ tenant: TENANT, question: `Remember this meeting:\n${"Lorem ipsum dolor sit amet, nothing happened.\n".repeat(6)}`, channel: "web" }, deps(runtime), (e) => events.push(e));
    expect(r.ok).toBe(false);
    expect(runtime.runs.map((x) => x.agentId)).toEqual(["librarian"]);
    expect(events.find((e) => e.type === "error")).toMatchObject({ message: expect.stringMatching(/couldn't find a meeting in that text/) });
    expect(await count()).toBe(before);
    expect(leadIdFor(RITIKA, "Ritika Menon")).toBe(lead);
  });
});
