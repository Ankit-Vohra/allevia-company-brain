// The Sales records' links into the rest of the graph (graph audit G11): a message or meeting came via a channel, a lead came via the
// campaign or post its enquiry names, and leads, deals, meetings and messages advance the goal that counts enquiries. Each write is
// read back with a traversal, not by a property. Also the message's status story through the executor's path (a draft that goes out).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { upsertEdge, upsertNode } from "../../src/graph/upsert.js";
import { testGraph } from "../helpers/graph.js";
import { crmRead } from "../../src/agent/tools/sales.js";
import { recordSalesOutcome } from "../../src/sales/after.js";
import { attributionReport, enquiryGoal, moveStage, openDeal, recordEnquiry, recordMeeting, resolveAttribution, type Src } from "../../src/sales/graph.js";
import { call, makeCtx } from "../helpers/tools.js";

const T0 = Date.parse("2026-10-05T09:00:00Z");
const HOUR = 3_600_000;
const at = (ms: number, warn?: (w: string) => void): Src => ({ src: "gmail:test", now: ms, ...(warn ? { warn } : {}) });

interface Edge { to: string; kinds: string[]; props: Record<string, unknown> }

// the current edges of one type out of a node, with the far end's labels and the edge's own properties
async function out(g: GraphHandle, from: string, type: string): Promise<Edge[]> {
  return g.roQuery<Edge>(
    `MATCH (a:Entity {id:$id})-[r:${type}]->(b:Entity) WHERE r.until IS NULL RETURN b.id AS to, labels(b) AS kinds, properties(r) AS props ORDER BY b.id`, { id: from });
}

describe("with a campaign, a post and a goal for enquiries", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await upsertNode(g, { type: "Business", id: "business:kestrel", name: "Kestrel Interiors", props: { slug: "kestrel" } }, T0);
    await upsertNode(g, { type: "Campaign", id: "campaign:diwali-offer", name: "Diwali offer", props: { status: "active", utm_campaign: "diwali-2026" } }, T0);
    await upsertNode(g, { type: "Content", id: "content:reel-modular-kitchens", name: "Reel: modular kitchens", props: { status: "published" } }, T0);
    // a metric and a goal that have nothing to do with enquiries come first; the plan's own priority orders the rest
    await upsertNode(g, { type: "Metric", id: "metric:ga4-sessions", name: "Website visits", props: { key: "ga4_sessions" } }, T0);
    await upsertNode(g, { type: "Goal", id: "goal:website-visits", name: "Website visits", props: { metricKey: "ga4_sessions", priority: 1 } }, T0);
    await upsertEdge(g, { from: "goal:website-visits", type: "TRACKS", to: "metric:ga4-sessions" }, T0);
    await upsertNode(g, { type: "Metric", id: "metric:enquiries", name: "Enquiries", props: { key: "enquiries" } }, T0);
    await upsertNode(g, { type: "Goal", id: "goal:qualified-enquiries", name: "Qualified enquiries per month", props: { metricKey: "enquiries", priority: 2 } }, T0);
    await upsertEdge(g, { from: "goal:qualified-enquiries", type: "TRACKS", to: "metric:enquiries" }, T0);
  }, 60_000);
  afterAll(async () => { await cleanup(); await closeAll(); });

  const priya = { name: "Priya Shah", email: "priya@example.com", channel: "email", subject: "Kitchen remodel quote", body: "We want a quote for a kitchen remodel.", at: T0, externalId: "gm-1" };

  it("an enquiry's message came via the channel it came through, as an incoming one", async () => {
    const r = await recordEnquiry(g, priya, at(T0));
    const via = await out(g, r.messageId, "CAME_VIA");
    expect(via).toHaveLength(1);
    expect(via[0]).toMatchObject({ to: "channel:email", props: { direction: "in", src: "gmail:test" } });
    expect(via[0]!.props.asOf).toBe(new Date(T0).toISOString());
    expect(via[0]!.kinds).toContain("Channel");
  });

  it("the enquiry's UTM campaign, in any case, links the lead to that campaign, and says how it matched", async () => {
    const r = await recordEnquiry(g, { ...priya, name: "Omar Khan", email: "omar@example.com", externalId: "gm-2", utmCampaign: "DIWALI-2026" }, at(T0 + HOUR));
    const via = await out(g, r.leadId, "CAME_VIA");
    expect(via.map((v) => v.to)).toEqual(["campaign:diwali-offer", "channel:email"]);
    expect(via[0]!.props).toMatchObject({ matchedOn: "utm_campaign", text: "DIWALI-2026", src: "gmail:test" });
  });

  it("source text that is a post's exact name, in any case, links the lead to the post; an id works too", async () => {
    const a = await recordEnquiry(g, { ...priya, name: "Lena Ortiz", email: "lena@example.com", externalId: "gm-3", sourceText: "reel: MODULAR kitchens" }, at(T0 + 2 * HOUR));
    expect((await out(g, a.leadId, "CAME_VIA")).map((v) => `${v.to}:${v.props.matchedOn ?? ""}`)).toEqual(["channel:email:", "content:reel-modular-kitchens:name"]);
    const b = await recordEnquiry(g, { ...priya, name: "Ravi Nair", email: "ravi@example.com", externalId: "gm-4", sourceText: "campaign:diwali-offer" }, at(T0 + 3 * HOUR));
    expect((await out(g, b.leadId, "CAME_VIA")).map((v) => `${v.to}:${v.props.matchedOn ?? ""}`)).toEqual(["campaign:diwali-offer:id", "channel:email:"]);
  });

  it("never guesses: a near miss, a part of a name, or a body that mentions a campaign names none", async () => {
    const r = await recordEnquiry(g, {
      ...priya, name: "Sam Roy", email: "sam@example.com", externalId: "gm-5", body: "Saw your Diwali offer on Instagram, want a kitchen", sourceText: "diwali", utmCampaign: "diwali 2026",
    }, at(T0 + 4 * HOUR));
    expect((await out(g, r.leadId, "CAME_VIA")).map((v) => v.to)).toEqual(["channel:email"]);
    expect(await resolveAttribution(g, ["Diwali offer sale", "", undefined])).toBeNull();
  });

  it("a text that names two nodes names none", async () => {
    await upsertNode(g, { type: "Campaign", id: "campaign:spring-sale", name: "Spring sale", props: { status: "active" } }, T0);
    await upsertNode(g, { type: "Content", id: "content:spring-sale-post", name: "spring sale", props: { status: "published" } }, T0);
    expect(await resolveAttribution(g, ["Spring Sale"])).toBeNull();
    // the next candidate is tried only when the first named nothing at all; an ambiguous one stops the search
    expect(await resolveAttribution(g, ["Spring Sale", "diwali-2026"])).toBeNull();
    expect(await resolveAttribution(g, ["nothing", "diwali-2026"])).toMatchObject({ id: "campaign:diwali-offer", matchedOn: "utm_campaign" });
  });

  it("every lead and its first message advance the goal that tracks enquiries, not the one that tracks visits", async () => {
    expect(await enquiryGoal(g)).toBe("goal:qualified-enquiries");
    const r = await recordEnquiry(g, { ...priya, name: "Tia Das", email: "tia@example.com", externalId: "gm-6" }, at(T0 + 5 * HOUR));
    for (const id of [r.leadId, r.messageId]) {
      const adv = await out(g, id, "ADVANCES");
      expect(adv.map((x) => x.to)).toEqual(["goal:qualified-enquiries"]);
      expect(adv[0]!.props).toMatchObject({ src: "gmail:test" });
    }
    const [reach] = await g.roQuery<{ n: number }>("MATCH (x:Entity)-[r:ADVANCES]->(gl:Goal {id:'goal:qualified-enquiries'}) WHERE ID(r) >= 0 AND r.until IS NULL AND x:Lead RETURN count(x) AS n");
    expect(reach!.n).toBeGreaterThanOrEqual(6);
  });

  it("a deal, a meeting and a stage move advance it too, and a meeting came via the calendar", async () => {
    const lead = "lead:tia-example-com";
    const deal = await openDeal(g, { leadId: lead, title: "Kitchen for Tia", value: 5000, currency: "USD" }, at(T0 + 6 * HOUR));
    expect((await out(g, deal, "ADVANCES")).map((x) => x.to)).toEqual(["goal:qualified-enquiries"]);
    const start = T0 + 3 * 86_400_000;
    const mtg = await recordMeeting(g, { leadId: lead, dealId: deal, title: "Call with Tia", start, end: start + 1_800_000, status: "booked" }, at(T0 + 7 * HOUR));
    expect((await out(g, mtg, "ADVANCES")).map((x) => x.to)).toEqual(["goal:qualified-enquiries"]);
    const via = await out(g, mtg, "CAME_VIA");
    expect(via).toHaveLength(1);
    expect(via[0]).toMatchObject({ to: "channel:calendar", props: { direction: "out" } });
    expect(via[0]!.kinds).toContain("Channel");
    // a lead written before the goal existed gets its link when it next moves; one that has it keeps its edge as it is
    await upsertNode(g, { type: "Lead", id: "lead:old-timer", name: "Old Timer", props: { stage: "new", needsReply: true }, src: "sheet:old" }, T0);
    expect(await out(g, "lead:old-timer", "ADVANCES")).toEqual([]);
    await moveStage(g, "lead:old-timer", "contacted", { ...at(T0 + 8 * HOUR), reason: "rang" });
    expect((await out(g, "lead:old-timer", "ADVANCES")).map((x) => x.to)).toEqual(["goal:qualified-enquiries"]);
    const [before] = await out(g, lead, "ADVANCES");
    await moveStage(g, lead, "contacted", { ...at(T0 + 9 * HOUR) });
    const [after] = await out(g, lead, "ADVANCES");
    expect(after!.props.src).toBe(before!.props.src);
    expect(after!.props.asOf).toBe(before!.props.asOf);
  });

  it("the attribution view groups leads by what they came through and the goal they advance", async () => {
    const r = await attributionReport(g);
    expect(r.campaigns.map((c) => [c.id, c.leads])).toEqual([["campaign:diwali-offer", ["lead:omar-example-com", "lead:ravi-example-com"]]]);
    expect(r.content.map((c) => [c.id, c.leads])).toEqual([["content:reel-modular-kitchens", ["lead:lena-example-com"]]]);
    expect(r.campaigns[0]!.goals).toEqual([{ id: "goal:qualified-enquiries", name: "Qualified enquiries per month", leads: ["lead:omar-example-com", "lead:ravi-example-com"] }]);
    expect(r.channels.map((c) => [c.id, c.leads.length])).toEqual([["channel:email", 6]]);
    expect(r.goals).toEqual([{ id: "goal:qualified-enquiries", name: "Qualified enquiries per month", leads: 7, deals: 1, meetings: 1, messages: 6 }]);
    expect(r.unattributed).toContain("lead:priya-example-com");
    expect(r.unattributed).not.toContain("lead:omar-example-com");

    const res = await call(crmRead, { view: "attribution" }, makeCtx(g, { tenant: "kestrel", now: T0 + 10 * HOUR }));
    expect(res.data.campaigns[0]).toMatchObject({ id: "campaign:diwali-offer", name: "Diwali offer", leads: 2, forGoals: [{ id: "goal:qualified-enquiries", leads: 2 }] });
    expect(res.data.content[0]).toMatchObject({ id: "content:reel-modular-kitchens", leads: 1 });
    expect(res.data.goals[0]).toMatchObject({ name: "Qualified enquiries per month", leads: 7, deals: 1, meetings: 1 });
    expect(res.note).toMatch(/nothing is guessed/);
  });

  it("a failed link never fails the write: it is said to whoever listens, and the record is still there", async () => {
    const said: string[] = [];
    const flaky = new Proxy(g, {
      get(target, prop) {
        const v = Reflect.get(target, prop, target) as unknown;
        if (prop === "query") return (q: string, ...rest: unknown[]) => (/ADVANCES/.test(q) ? Promise.reject(new Error("the link failed")) : (v as (...a: unknown[]) => unknown).call(target, q, ...rest));
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const r = await recordEnquiry(flaky, { ...priya, name: "Wen Li", email: "wen@example.com", externalId: "gm-7" }, at(T0 + 11 * HOUR, (w) => said.push(w)));
    expect(r.isNew).toBe(true);
    expect(said.length).toBeGreaterThanOrEqual(1);
    expect(said[0]).toMatch(/could not link .* to its goal: .*the link failed/);
    expect((await out(g, r.leadId, "ENQUIRED_BY")).map((x) => x.to)).toEqual(["person:wen-example-com"]);
    expect(await out(g, r.leadId, "ADVANCES")).toEqual([]);
  });
});

describe("with no goal for enquiries", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await upsertNode(g, { type: "Business", id: "business:kestrel", name: "Kestrel Interiors", props: { slug: "kestrel" } }, T0);
    await upsertNode(g, { type: "Goal", id: "goal:website-visits", name: "Website visits", props: { metricKey: "ga4_sessions" } }, T0);
  }, 60_000);
  afterAll(async () => { await cleanup(); await closeAll(); });

  it("writes the lead and links nothing to a goal", async () => {
    expect(await enquiryGoal(g)).toBeNull();
    const r = await recordEnquiry(g, { name: "Priya Shah", email: "priya@example.com", channel: "whatsapp", body: "Hi, a quote please", at: T0, externalId: "wa-1" }, at(T0));
    expect(await out(g, r.leadId, "ADVANCES")).toEqual([]);
    expect(await out(g, r.messageId, "ADVANCES")).toEqual([]);
    expect((await out(g, r.messageId, "CAME_VIA")).map((x) => x.to)).toEqual(["channel:whatsapp"]);
    expect((await attributionReport(g)).goals).toEqual([]);
  });

  it("falls back to a goal whose name says enquiries, leads or bookings", async () => {
    await upsertNode(g, { type: "Goal", id: "goal:more-bookings", name: "More bookings from the website", props: { priority: 2 } }, T0);
    expect(await enquiryGoal(g)).toBe("goal:more-bookings");
    await upsertNode(g, { type: "Goal", id: "goal:old-leads", name: "Old leads goal", props: { status: "retired", priority: 1 } }, T0);
    expect(await enquiryGoal(g)).toBe("goal:more-bookings");
  });
});

describe("the status of a message through the executor's path", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  const lead = "lead:priya-example-com";
  const payload = { title: "Your quote", subject: "Your quote", to: ["priya@example.com"], body: "Hello Priya, here is the quote you asked for.", send: false };
  const ctx = { tenant: "kestrel" };

  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await upsertNode(g, { type: "Business", id: "business:kestrel", name: "Kestrel Interiors", props: { slug: "kestrel" } }, T0);
    await recordEnquiry(g, { name: "Priya Shah", email: "priya@example.com", channel: "email", subject: "Quote", body: "A quote please", at: T0, externalId: "gm-1" }, at(T0));
  }, 60_000);
  afterAll(async () => { await cleanup(); await closeAll(); });

  const versions = (id: string) => g.roQuery<{ until: number; was: string }>(
    "MATCH (m:Entity {id:$id})-[h:HAD_VERSION]->(v:Version) WHERE 'status' IN v.changed RETURN v.until AS until, v.props AS was ORDER BY v.until, v.id", { id });

  it("an approved 'don't send yet' is saved as a draft", async () => {
    const r = await recordSalesOutcome(g, { approvalId: "approval:t-1-1", kind: "email_send", payload, now: T0 + HOUR, ...ctx });
    expect(r.produced).toHaveLength(1);
    const [m] = await g.roQuery<{ status: string; externalId: string; direction: string }>("MATCH (m:Entity:Message {id:$id}) RETURN m.status AS status, m.externalId AS externalId, m.direction AS direction", { id: r.produced[0] });
    expect(m).toEqual({ status: "draft", externalId: "approval:t-1-1-priya@example.com", direction: "out" });
    expect(await versions(r.produced[0]!)).toEqual([]);
  });

  it("the same words approved to send make that draft sent, with Gmail's ids, and keep 'draft' as a Version", async () => {
    const r = await recordSalesOutcome(g, { approvalId: "approval:t-2-1", kind: "email_send", payload: { ...payload, send: true }, now: T0 + 2 * HOUR, ...ctx }, { url: "ignored", messageId: "18c0ffee", threadId: "thr-9" });
    const all = await g.roQuery<{ id: string }>("MATCH (m:Entity:Message) WHERE m.direction = 'out' RETURN m.id AS id ORDER BY m.id");
    expect(all).toHaveLength(1);
    expect(r.produced).toEqual([all[0]!.id]);
    const [m] = await g.roQuery<{ status: string; externalId: string; threadId: string; src: string }>(
      "MATCH (m:Entity:Message {id:$id}) RETURN m.status AS status, m.externalId AS externalId, m.threadId AS threadId, m.src AS src", { id: all[0]!.id });
    expect(m).toEqual({ status: "sent", externalId: "18c0ffee", threadId: "thr-9", src: "approval:t-2-1" });
    const v = await versions(all[0]!.id);
    expect(v.map((x) => (JSON.parse(x.was) as { status: string }).status)).toEqual(["draft"]);
    // the lead is answered, and the message is in its story, via the email channel as an outgoing one
    expect(await g.roQuery("MATCH (l:Entity:Lead {id:$id}) WHERE l.needsReply = false AND l.stage = 'contacted' RETURN l.id AS id", { id: lead })).toHaveLength(1);
    expect((await out(g, all[0]!.id, "MESSAGE_IN")).map((x) => x.to)).toEqual([lead]);
    expect((await out(g, all[0]!.id, "CAME_VIA"))[0]).toMatchObject({ to: "channel:email", props: { direction: "out" } });
  });

  it("different words are a new message, not an update of the draft; a repeat of the approval is the same message", async () => {
    const r1 = await recordSalesOutcome(g, { approvalId: "approval:t-3-1", kind: "email_send", payload: { ...payload, body: "Something else entirely, with a different offer.", send: true }, now: T0 + 3 * HOUR, ...ctx }, { messageId: "18c0ffef" });
    const r1b = await recordSalesOutcome(g, { approvalId: "approval:t-3-1", kind: "email_send", payload: { ...payload, body: "Something else entirely, with a different offer.", send: true }, now: T0 + 3 * HOUR, ...ctx }, { messageId: "18c0ffef" });
    expect(r1.produced).toEqual(r1b.produced);
    expect((await g.roQuery("MATCH (m:Entity:Message) WHERE m.direction = 'out' RETURN m.id AS id")).length).toBe(2);
  });

  it("a booked meeting keeps the calendar event's id, and its link; a plain link string still works", async () => {
    const start = "2026-10-09T05:30:00.000Z", end = "2026-10-09T06:00:00.000Z";
    const a = await recordSalesOutcome(g, { approvalId: "approval:t-4-1", kind: "calendar_event", payload: { title: "Call with Priya", body: "", start, end, attendees: ["priya@example.com"] }, now: T0 + 4 * HOUR, ...ctx }, { url: "https://cal.example/e1", eventId: "evt-123" });
    const [m] = await g.roQuery<{ calendarEventId: string; link: string; status: string }>("MATCH (m:Entity:Meeting {id:$id}) RETURN m.calendarEventId AS calendarEventId, m.link AS link, m.status AS status", { id: a.produced[0] });
    expect(m).toEqual({ calendarEventId: "evt-123", link: "https://cal.example/e1", status: "booked" });
    const b = await recordSalesOutcome(g, { approvalId: "approval:t-5-1", kind: "calendar_event", payload: { title: "Second call", body: "", start: "2026-10-10T05:30:00.000Z", end: "2026-10-10T06:00:00.000Z", attendees: ["priya@example.com"] }, now: T0 + 5 * HOUR, ...ctx }, "https://cal.example/e2");
    const [m2] = await g.roQuery<{ calendarEventId: string | null; link: string }>("MATCH (m:Entity:Meeting {id:$id}) RETURN m.calendarEventId AS calendarEventId, m.link AS link", { id: b.produced[0] });
    expect(m2).toEqual({ calendarEventId: null, link: "https://cal.example/e2" });
  });

  it("a meeting that was proposed and is now booked keeps 'proposed' as a Version", async () => {
    const start = T0 + 6 * 86_400_000;
    const id = await recordMeeting(g, { leadId: lead, title: "Site visit", start, end: start + 3_600_000, status: "proposed" }, at(T0 + 6 * HOUR));
    await recordMeeting(g, { leadId: lead, title: "Site visit", start, end: start + 3_600_000, status: "booked", calendarEventId: "evt-9" }, at(T0 + 7 * HOUR));
    const v = await g.roQuery<{ was: string }>("MATCH (m:Entity {id:$id})-[h:HAD_VERSION]->(v:Version) WHERE 'status' IN v.changed RETURN v.props AS was ORDER BY v.until, v.id", { id });
    expect(v.map((x) => (JSON.parse(x.was) as { status: string }).status)).toEqual(["proposed"]);
  });
});
