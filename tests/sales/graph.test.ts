// The Sales records: leads, deals, meetings and messages in one business's graph, with stages that keep their history.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { upsertNode } from "../../src/graph/upsert.js";
import { testGraph } from "../helpers/graph.js";
import {
  DAY, addFollowUp, getLead, listDeals, listLeads, logMessage, meetingsBetween, moveStage, openDeal, pipeline, recordEnquiry, recordMeeting,
  stalledDeals, unanswered, whatMoved, type Src,
} from "../../src/sales/graph.js";

const T0 = Date.parse("2026-10-05T09:00:00Z"); // a Monday
const HOUR = 3_600_000;
const at = (ms: number): Src => ({ src: "gmail:test", now: ms });

let g: GraphHandle;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  ({ g, cleanup } = await testGraph());
  await upsertNode(g, { type: "Business", id: "business:kestrel", name: "Kestrel Interiors", props: { slug: "kestrel" } }, T0);
  await upsertNode(g, { type: "Agent", id: "agent:allevia-sales-lead", name: "Neel", props: { rosterId: "sales-lead" } }, T0);
});
afterAll(async () => { await cleanup(); await closeAll(); });

const priya = { name: "Priya Shah", email: "Priya@Example.com", channel: "email", subject: "Kitchen remodel quote", body: "Hi, we want a quote for a full kitchen remodel in Raipur. Can we talk this week?", at: T0, externalId: "gm-1" };

describe("sales graph", () => {
  it("records an enquiry as a Person, a Lead, a Message and their links, each with its source", async () => {
    const r = await recordEnquiry(g, priya, at(T0));
    expect(r).toMatchObject({ leadId: "lead:priya-example-com", personId: "person:priya-example-com", isNew: true, repeated: false });
    const lead = await getLead(g, r.leadId);
    expect(lead).toMatchObject({ stage: "new", needsReply: true, source: "Email", email: "priya@example.com", src: "gmail:test" });
    const links = await g.roQuery<{ rel: string; to: string }>(
      "MATCH (a:Entity)-[r]->(b:Entity) WHERE a.id IN [$lead, $msg] AND r.until IS NULL RETURN type(r) AS rel, b.id AS to ORDER BY rel, to", { lead: r.leadId, msg: r.messageId });
    expect(links.map((l) => `${l.rel}>${l.to}`)).toEqual([
      "CAME_VIA>channel:email", "CAME_VIA>channel:email", "ENQUIRED_BY>person:priya-example-com", "MESSAGE_IN>lead:priya-example-com", "PART_OF>business:kestrel", "PART_OF>business:kestrel", "SENT_BY>person:priya-example-com",
    ]);
    const [edge] = await g.roQuery<{ src: string; asOf: string }>("MATCH (:Lead {id:$id})-[r:ENQUIRED_BY]->(p:Person) RETURN r.src AS src, r.asOf AS asOf ORDER BY p.id", { id: r.leadId });
    expect(edge).toEqual({ src: "gmail:test", asOf: new Date(T0).toISOString() });
  });

  it("is repeatable: the same message again changes nothing", async () => {
    const again = await recordEnquiry(g, priya, at(T0 + 60_000));
    expect(again.repeated).toBe(true);
    const [m] = await g.roQuery<{ n: number }>("MATCH (m:Entity:Message) RETURN count(m) AS n");
    expect(m!.n).toBe(1);
    const [l] = await g.roQuery<{ n: number }>("MATCH (m:Entity:Lead) RETURN count(m) AS n");
    expect(l!.n).toBe(1);
  });

  it("lists enquiries nobody answered, oldest first, with how long they waited", async () => {
    await recordEnquiry(g, { name: "Omar Khan", email: "omar@example.com", channel: "whatsapp", body: "Do you do offices?", at: T0 + HOUR, externalId: "wa-9" }, at(T0 + HOUR));
    const list = await unanswered(g, T0 + 5 * HOUR);
    expect(list.map((l) => [l.id, l.waitingHours])).toEqual([["lead:priya-example-com", 5], ["lead:omar-example-com", 4]]);
    expect((await unanswered(g, T0 + 5 * HOUR, { minHours: 5 })).map((l) => l.id)).toEqual(["lead:priya-example-com"]);
  });

  it("an outbound message that was sent answers the lead and moves a new lead to contacted", async () => {
    const t = T0 + 6 * HOUR;
    await logMessage(g, {
      leadId: "lead:priya-example-com", direction: "out", channel: "email", subject: "Re: Kitchen remodel quote", body: "Hi Priya, happy to help. Thursday 11:00, Friday 15:00 or Monday 10:00?",
      at: t, status: "sent", externalId: "sent-1", by: "agent:allevia-sales-lead", toPersonId: "person:priya-example-com",
    }, at(t));
    expect(await getLead(g, "lead:priya-example-com")).toMatchObject({ stage: "contacted", needsReply: false, lastOutboundAt: t });
    expect((await unanswered(g, t)).map((l) => l.id)).toEqual(["lead:omar-example-com"]);
  });

  it("keeps every stage change, so what moved this week is a query", async () => {
    const id = await openDeal(g, { leadId: "lead:priya-example-com", title: "Kitchen remodel, Priya Shah", value: 8000, currency: "USD" }, at(T0 + 7 * HOUR));
    expect(id).toBe("deal:priya-example-com");
    const mtg = T0 + 3 * DAY + 2 * HOUR; // Thursday
    await recordMeeting(g, { leadId: "lead:priya-example-com", dealId: id, title: "Call with Priya Shah", start: mtg, end: mtg + 1_800_000, status: "booked", where: "Google Meet" }, at(T0 + DAY));
    expect(await getLead(g, "lead:priya-example-com")).toMatchObject({ stage: "meeting" });
    await moveStage(g, id, "won", { ...at(T0 + 4 * DAY), reason: "signed" });
    await moveStage(g, "lead:priya-example-com", "won", { ...at(T0 + 4 * DAY + HOUR), reason: "signed" });
    const week = await whatMoved(g, T0, T0 + 7 * DAY);
    expect(week.filter((m) => m.id === "lead:priya-example-com").map((m) => [m.from, m.to])).toEqual([[null, "new"], ["new", "contacted"], ["contacted", "meeting"], ["meeting", "won"]]);
    expect(week.filter((m) => m.id === id).map((m) => [m.from, m.to])).toEqual([["contacted", "meeting"], ["meeting", "won"]]);
    // a narrower window sees only its own moves
    const late = await whatMoved(g, T0 + 2 * DAY, T0 + 7 * DAY);
    expect(late.map((m) => `${m.kind}:${m.from}>${m.to}`)).toEqual(["Deal:meeting>won", "Lead:meeting>won"]);
  });

  it("moving to the stage it is already in is not a move", async () => {
    const r = await moveStage(g, "deal:priya-example-com", "won", at(T0 + 5 * DAY));
    expect(r.changed).toBe(false);
  });

  it("finds booked meetings in a window, and the pipeline's shape", async () => {
    const thu = T0 + 3 * DAY;
    expect(await meetingsBetween(g, thu - DAY, thu)).toHaveLength(0);
    const w = await meetingsBetween(g, thu, thu + DAY);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ name: "Call with Priya Shah", status: "booked", personEmail: "priya@example.com", leadId: "deal:priya-example-com" });
    const p = await pipeline(g);
    expect(p.byStage).toMatchObject({ new: 1, won: 1 });
    expect(p.wonValue).toBe(8000);
  });

  it("finds deals with nothing happening for two weeks, most idle first", async () => {
    const t = T0 + 30 * DAY;
    await recordEnquiry(g, { name: "Lena Ortiz", email: "lena@example.com", channel: "form", body: "Bathroom refit", at: T0 + DAY, externalId: "f-1" }, at(T0 + DAY));
    await openDeal(g, { leadId: "lead:lena-example-com", title: "Bathroom refit, Lena Ortiz", value: 3000, currency: "USD", stage: "contacted" }, at(T0 + DAY));
    await openDeal(g, { leadId: "lead:omar-example-com", title: "Office fit-out, Omar Khan", value: 12000, currency: "USD", stage: "contacted" }, at(T0 + 20 * DAY));
    expect((await stalledDeals(g, t)).map((d) => [d.id, d.idleDays])).toEqual([["deal:lena-example-com", 29]]);
    expect((await listDeals(g, t, { open: true })).map((d) => d.id).sort()).toEqual(["deal:lena-example-com", "deal:omar-example-com"]);
  });

  it("a person who wrote before and won comes back as a new enquiry, with the history kept", async () => {
    await recordEnquiry(g, { ...priya, subject: "Bathroom too", body: "Loved the kitchen. Can you do the bathroom?", at: T0 + 40 * DAY, externalId: "gm-2" }, at(T0 + 40 * DAY));
    expect(await getLead(g, "lead:priya-example-com")).toMatchObject({ stage: "new", needsReply: true });
    const moves = await whatMoved(g, T0 + 39 * DAY, T0 + 41 * DAY);
    expect(moves.map((m) => `${m.id}:${m.from}>${m.to}`)).toEqual(["lead:priya-example-com:won>new"]);
  });

  it("links a follow-up Task to the lead, owned by the person who will do it", async () => {
    const id = await addFollowUp(g, { forId: "lead:lena-example-com", title: "Ask Lena about the bathroom tiles", due: T0 + 31 * DAY, owner: "agent:allevia-sales-lead" }, at(T0 + 30 * DAY));
    const rows = await g.roQuery<{ rel: string; fromId: string; toId: string }>(
      "MATCH (a:Entity)-[r]->(b:Entity) WHERE (a.id = $id OR b.id = $id) AND r.until IS NULL RETURN type(r) AS rel, a.id AS fromId, b.id AS toId ORDER BY rel, a.id", { id });
    expect(rows.map((r) => `${r.fromId} ${r.rel} ${r.toId}`)).toEqual([`${id} FOLLOWS_UP lead:lena-example-com`, `agent:allevia-sales-lead OWNS ${id}`]);
  });

  it("lists leads, filtered by stage", async () => {
    expect((await listLeads(g, { stage: "new" })).map((l) => l.id).sort()).toEqual(["lead:lena-example-com", "lead:omar-example-com", "lead:priya-example-com"]);
    expect((await listLeads(g, { stage: "won" }))).toHaveLength(0);
  });
});
