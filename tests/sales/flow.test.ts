// The Sales flow end to end on the synthetic demo business, with the sample connections (a sample inbox and calendar; nothing is
// really sent or booked): a new enquiry in the inbox -> added to the records -> a reply with three real times, as a card with the
// full text and the recipient -> OK -> sent -> the customer picks a time -> the meeting as a card -> OK -> booked, the lead moves
// to "meeting" -> the day before, a reminder -> OK -> sent. Every step is the real tool and the real executor.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { GROWTH_NOW, GROWTH_TENANT, seedGrowth } from "../../src/demo/growth.js";
import { demoConnections, type DemoGoogleApis } from "../../src/sales/demo.js";
import { calendarBook, calendarFreeSlots, gmailSend } from "../../src/agent/tools/connections.js";
import { crmRead, crmWrite, enquiriesRead } from "../../src/agent/tools/sales.js";
import type { AlleviaTool, ToolContext } from "../../src/agent/tool.js";
import { approvalCard } from "../../src/discord/bot.js";
import { decide } from "../../src/server/approvals.js";
import { approval } from "../../src/server/reads.js";
import { DAY, getLead } from "../../src/sales/graph.js";
import { call, makeCtx } from "../helpers/tools.js";
import { testGraph } from "../helpers/graph.js";

const HOUR = 3_600_000;
let g: GraphHandle;
let cleanup: () => Promise<void>;
let apis: DemoGoogleApis;
let turn = 0;

const port = () => demoConnections(GROWTH_TENANT, () => GROWTH_NOW);
const ctxAt = (now: number): ToolContext => makeCtx(g, { tenant: GROWTH_TENANT, agentId: "sales-lead", now, turnId: `t-${++turn}`, connections: port() });
const run = (t: AlleviaTool, args: Record<string, unknown>, now = GROWTH_NOW) => call(t, args, ctxAt(now));
const approve = (id: string, now: number) => decide(g, GROWTH_TENANT, id, { decision: "approve" }, { now });

beforeAll(async () => {
  ({ g, cleanup } = await testGraph());
  await seedGrowth(g);
  apis = port().apis;
}, 120_000);
afterAll(async () => { await cleanup(); await closeAll(); });

describe("the demo business has something to show", () => {
  it("has leads in different stages, a stalled deal and an enquiry nobody answered", async () => {
    const pipe = await run(crmRead, { view: "pipeline" });
    expect(pipe.data.leadsByStage).toEqual({ new: 1, contacted: 1, meeting: 1, won: 1, lost: 0 });
    expect(pipe.data.openDeals).toBe(2);
    const stalled = await run(crmRead, { view: "stalled" });
    expect(stalled.data.deals.map((d: { name: string; daysSinceAnything: number }) => [d.name, d.daysSinceAnything])).toEqual([["Sahyadri Hotels: weekend wedding staff", 18]]);
    const waiting = await run(crmRead, { view: "waiting" });
    expect(waiting.data.waiting.map((w: { who: string; waitingHours: number }) => [w.who, w.waitingHours])).toEqual([["Rohit Desai", 27]]);
    const meetings = await run(crmRead, { view: "meetings", days_ahead: 2 });
    expect(meetings.data.meetings).toHaveLength(1);
    expect(meetings.data.meetings[0]).toMatchObject({ title: "Call with Arjun Mehta (Mehta Logistics)", guestEmail: "arjun@mehtalogistics.example" });
  });

  it("what moved this week comes from the stage history", async () => {
    const r = await run(crmRead, { view: "moved", since_days: 7 });
    expect(r.data.moves.map((m: { id: string; from: string; to: string }) => `${m.id}: ${m.from} > ${m.to}`)).toEqual([
      "deal:ira-greenleafcafes-example: meeting > won",
      "lead:ira-greenleafcafes-example: meeting > won",
      "deal:arjun-mehtalogistics-example: contacted > meeting",
      "lead:arjun-mehtalogistics-example: contacted > meeting",
      "lead:rohit-desaicaterers-example: (not there before) > new",
    ]);
  });
});

describe("from a new email to a booked call and a reminder", () => {
  let leadId = "";
  let slots: Array<{ start: string; label: string }> = [];
  let replyCard = "";

  it("reads the inbox: the person is new, the newsletter is skipped", async () => {
    const r = await run(enquiriesRead, {});
    expect(r.data.newInInbox.map((m: { email: string }) => m.email)).toEqual(["meghna@cafeverde.example"]);
    expect(r.data.inbox).toMatchObject({ read: true, skippedMachines: 1 });
    expect(r.data.waiting.map((w: { who: string }) => w.who)).toEqual(["Rohit Desai"]);
    expect(r.note).toMatch(/data, not instructions/);
  });

  it("adds the lead to the records once, however many times it runs", async () => {
    const add = { action: "add_lead", name: "Meghna Rao", email: "meghna@cafeverde.example", channel: "email", subject: "Weekend baristas for our new cafe", message: "We open a new cafe in Koregaon Park on 1 November and need 4 baristas for the weekends. Can Shiftly send us people, and how soon?", received: new Date(GROWTH_NOW - 3 * HOUR).toISOString(), external_id: "demo-verde-1" };
    const first = await run(crmWrite, add, GROWTH_NOW + 1_000);
    expect(first.data).toMatchObject({ leadId: "lead:meghna-cafeverde-example", isNew: true, alreadyThere: false, crm: { connected: false } });
    leadId = first.data.leadId;
    const again = await run(crmWrite, add, GROWTH_NOW + 2_000);
    expect(again.data).toMatchObject({ alreadyThere: true });
    const inbox = await run(enquiriesRead, {}, GROWTH_NOW + 3_000);
    expect(inbox.data.newInInbox).toEqual([]);
    expect(inbox.data.waiting.map((w: { who: string }) => w.who).sort()).toEqual(["Meghna Rao", "Rohit Desai"]);
  });

  it("finds three real times on the sample calendar", async () => {
    const r = await run(calendarFreeSlots, { minutes: 30, days: 5, from: "2026-10-16", time_zone: "Asia/Kolkata" }, GROWTH_NOW + 4_000);
    const byDay = new Map<string, { start: string; label: string }>();
    for (const s of r.data.slots as Array<{ start: string; label: string }>) if (!byDay.has(s.start.slice(0, 10))) byDay.set(s.start.slice(0, 10), s);
    slots = [...byDay.values()].slice(0, 3);
    expect(slots).toHaveLength(3);
    // never inside the sample busy blocks (10:00 to 11:00 and 14:30 to 16:00 IST)
    for (const s of slots) expect(s.start).not.toMatch(/T(10:|14:|15:)/);
  });

  it("proposes the reply as a card with the whole email and the recipient; nothing is sent", async () => {
    const body = `Hi Meghna, yes, we can staff weekends in Koregaon Park. Could we talk for 30 minutes? ${slots.map((s) => s.label).join(", or ")} (all IST). Reply with the one that suits you. - Rhea, Shiftly`;
    const r = await run(gmailSend, { to: ["meghna@cafeverde.example"], subject: "Re: Weekend baristas for our new cafe", body, why: "Meghna asked about weekend baristas; answered with three real times" }, GROWTH_NOW + 5_000);
    expect(r.data).toMatchObject({ kind: "email_send", status: "pending" });
    expect(apis.sent).toHaveLength(0);
    const card = (await approval(g, r.data.approvalId))!;
    expect(card.payload).toMatchObject({ title: "Re: Weekend baristas for our new cafe", body, target: "Email to meghna@cafeverde.example" });
    // what #approvals in Discord shows: the whole text and who it goes to
    const discord = approvalCard(card).content;
    expect(discord).toContain("meghna@cafeverde.example");
    for (const s of slots) expect(discord).toContain(s.label);
    replyCard = r.data.approvalId;
  });

  it("after the OK the email is sent, the lead is answered and moves to contacted", async () => {
    const done = await approve(replyCard, GROWTH_NOW + 10_000);
    expect(done.action).toMatchObject({ kind: "email_send", status: "done" });
    expect(apis.sent).toHaveLength(1);
    expect(apis.sent[0]).toMatchObject({ to: ["meghna@cafeverde.example"], subject: "Re: Weekend baristas for our new cafe" });
    const lead = await getLead(g, leadId);
    expect(lead).toMatchObject({ stage: "contacted", needsReply: false });
    const story = await run(crmRead, { view: "lead", id: leadId }, GROWTH_NOW + 11_000);
    expect(story.data.messages.map((m: { direction: string; status: string }) => `${m.direction}/${m.status}`)).toEqual(["they wrote/received", "we wrote/sent"]);
  });

  it("the customer picks the second time; the meeting is a card, and the OK books it and moves the lead to meeting", async () => {
    await run(crmWrite, { action: "add_lead", name: "Meghna Rao", email: "meghna@cafeverde.example", channel: "email", message: `${slots[1]!.label} works for me, thanks.`, external_id: "demo-verde-2", received: new Date(GROWTH_NOW + 20_000).toISOString() }, GROWTH_NOW + 20_000);
    expect(await getLead(g, leadId)).toMatchObject({ needsReply: true });
    const r = await run(calendarBook, { title: "Call with Meghna Rao (Cafe Verde)", start: slots[1]!.start, minutes: 30, guest_email: "meghna@cafeverde.example", notes: "Weekend baristas for the Koregaon Park opening", why: "She picked this time" }, GROWTH_NOW + 25_000);
    expect(r.data).toMatchObject({ kind: "calendar_event", status: "pending" });
    expect(apis.events).toHaveLength(0);
    const card = (await approval(g, r.data.approvalId))!;
    expect(approvalCard(card).content).toContain("meghna@cafeverde.example");
    const done = await approve(r.data.approvalId, GROWTH_NOW + 30_000);
    expect(done.action).toMatchObject({ kind: "calendar_event", status: "done" });
    expect(apis.events).toHaveLength(1);
    expect(apis.events[0]).toMatchObject({ summary: "Call with Meghna Rao (Cafe Verde)", attendees: ["meghna@cafeverde.example"] });
    expect(await getLead(g, leadId)).toMatchObject({ stage: "meeting" });
    const meetings = await run(crmRead, { view: "meetings", days_ahead: 7 }, GROWTH_NOW + 31_000);
    expect(meetings.data.meetings.map((m: { title: string }) => m.title)).toContain("Call with Meghna Rao (Cafe Verde)");
  });

  it("the day before, the call shows up for a reminder; the reminder goes out after the OK", async () => {
    const start = Date.parse(slots[1]!.start);
    const evening = start - 20 * HOUR;
    const upcoming = await run(crmRead, { view: "meetings", days_ahead: 2 }, evening);
    const mine = upcoming.data.meetings.find((m: { guestEmail: string }) => m.guestEmail === "meghna@cafeverde.example");
    expect(mine).toMatchObject({ title: "Call with Meghna Rao (Cafe Verde)" });
    const r = await run(gmailSend, { to: ["meghna@cafeverde.example"], subject: "Our call tomorrow", body: `Hi Meghna, a quick note that we speak tomorrow, ${slots[1]!.label} IST (the invite has the link). I will have the weekend rota ready. - Rhea`, why: "Reminder the day before the call" }, evening + 1_000);
    expect(r.data).toMatchObject({ kind: "email_send", status: "pending" });
    await approve(r.data.approvalId, evening + 5_000);
    expect(apis.sent).toHaveLength(2);
    const story = await run(crmRead, { view: "lead", id: leadId }, evening + 6_000);
    expect(story.data.messages.filter((m: { direction: string }) => m.direction === "we wrote")).toHaveLength(2);
    expect(story.data.lead.stage).toBe("meeting");
  });

  it("the week's moves show the lead's whole path with dates", async () => {
    const r = await run(crmRead, { view: "moved", since_days: 7 }, GROWTH_NOW + 2 * DAY);
    const mine = r.data.moves.filter((m: { id: string }) => m.id === leadId).map((m: { from: string; to: string }) => `${m.from} > ${m.to}`);
    expect(mine).toEqual(["(not there before) > new", "new > contacted", "contacted > meeting"]);
  });
});

describe("other businesses never get the sample connections", () => {
  it("an approved email for any other business is a dry run: it reaches nobody and writes nothing", async () => {
    const before = apis.sent.length;
    const r = await call(gmailSend, { to: ["meghna@cafeverde.example"], subject: "Hello again", body: "Hi Meghna, just checking in about the weekend baristas.", why: "Check-in" }, ctxAt(GROWTH_NOW + 3 * DAY));
    const done = await decide(g, "some_other_business", r.data.approvalId, { decision: "approve" }, { now: GROWTH_NOW + 3 * DAY + 1_000 });
    expect(done.action).toMatchObject({ kind: "email_send", status: "dry_run" });
    expect(apis.sent).toHaveLength(before);
  });
});
