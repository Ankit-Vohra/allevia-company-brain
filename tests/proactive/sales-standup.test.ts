// Sales at the morning stand-up: enquiries without a reply, deals quiet for two weeks and calls tomorrow become drafts waiting for
// the owner's OK (an email with the recipient and every word), picked by the same rules as everything else. On the synthetic demo
// business with the sample calendar and fake drafters: no model, nothing sent.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { GROWTH_NOW, GROWTH_TENANT, seedGrowth } from "../../src/demo/growth.js";
import { ownerJargon } from "../../src/agent/style.js";
import { type Drafters, type TextJob } from "../../src/proactive/draft.js";
import { opportunitiesFrom } from "../../src/proactive/opportunities.js";
import { gatherSignals } from "../../src/proactive/signals.js";
import { standupTimes } from "../../src/proactive/wiring.js";
import { readStandup, runStandup } from "../../src/proactive/standup.js";
import { decide } from "../../src/server/approvals.js";
import { approval } from "../../src/server/reads.js";
import { approvalCard, standupCard } from "../../src/discord/bot.js";
import { demoConnections } from "../../src/sales/demo.js";
import { getLead } from "../../src/sales/graph.js";
import { proposeTimes, tomorrowWindow } from "../../src/sales/times.js";
import { findBusinessId } from "../../src/actions/shared.js";
import { upsertNode } from "../../src/graph/upsert.js";
import { testGraph } from "../helpers/graph.js";

let g: GraphHandle;
let cleanup: () => Promise<void>;
const texts: TextJob[] = [];

function drafters(): Drafters {
  return {
    async text(job) {
      texts.push(job);
      return { ok: true, text: `Hi, this is the ${job.kind} for the owner to read first. ${job.facts.find((f) => f.startsWith("Three free times")) ?? ""}`.trim(), hashtags: [], warnings: [] };
    },
    times: standupTimes(g, GROWTH_TENANT),
  };
}

beforeAll(async () => {
  ({ g, cleanup } = await testGraph());
  await seedGrowth(g);
}, 120_000);
afterAll(async () => { await cleanup(); await closeAll(); });

describe("what Sales brings to the stand-up", () => {
  it("reads the records: an enquiry nobody answered, a deal quiet for two weeks, a call tomorrow", async () => {
    const s = await gatherSignals(g, { now: GROWTH_NOW, tenant: GROWTH_TENANT, businessId: await findBusinessId(g, GROWTH_TENANT) });
    expect(s.sales!.waiting.map((w) => [w.name, w.waitingHours])).toEqual([["Rohit Desai", 27]]);
    expect(s.sales!.stalled.map((d) => [d.leadName, d.idleDays, d.value, d.currency])).toEqual([["Sana Qureshi", 18, 180000, "INR"]]);
    expect(s.sales!.tomorrow.map((m) => [m.title, m.guestEmail])).toEqual([["Call with Arjun Mehta (Mehta Logistics)", "arjun@mehtalogistics.example"]]);
  });

  it("turns each into an opportunity whose reason uses only the records' numbers, ahead of the festivals", async () => {
    const s = await gatherSignals(g, { now: GROWTH_NOW, tenant: GROWTH_TENANT, businessId: await findBusinessId(g, GROWTH_TENANT) });
    const sales = opportunitiesFrom(s).filter((o) => o.source === "sales");
    expect(sales.map((o) => o.kind)).toEqual(["sales_reply", "sales_reminder", "sales_nudge"]);
    expect(sales.map((o) => o.agent)).toEqual(["sales-lead", "sales-lead", "sales-lead"]);
    expect(sales[0]!.reason).toMatch(/^Rohit Desai asked about ".+" by WhatsApp 27 hours ago and has had no reply\.$/);
    expect(sales[2]!.reason).toMatch(/Sana Qureshi's deal \(INR 180,000\) has had nothing happen for 18 days/);
    for (const o of sales) expect(ownerJargon(`${o.title} ${o.reason}`), o.key).toEqual([]);
    const all = opportunitiesFrom(s);
    expect(all.slice(0, 3).map((o) => o.source)).toEqual(["sales", "sales", "sales"]); // goal-moving first, festivals only fill spare slots
  });

  it("a business with nothing open in Sales adds nothing", async () => {
    const e = await testGraph();
    try {
      await upsertNode(e.g, { type: "Business", id: "business:empty-biz", name: "Empty Biz" }, GROWTH_NOW - 1000);
      const s = await gatherSignals(e.g, { now: GROWTH_NOW, tenant: "empty_biz", businessId: "business:empty-biz" });
      expect(s.sales).toBeUndefined();
      expect(opportunitiesFrom(s).filter((o) => o.source === "sales")).toEqual([]);
    } finally { await e.cleanup(); }
  });
});

describe("the sample calendar's free times", () => {
  it("three times on different days, never inside a busy block or the next hour", async () => {
    const times = await proposeTimes(demoConnections(GROWTH_TENANT, () => GROWTH_NOW), GROWTH_NOW, { tz: "Asia/Kolkata" });
    expect(times).toHaveLength(3);
    expect(new Set(times.map((t) => t.start.slice(0, 10))).size).toBe(3);
    for (const t of times) expect(t.start).not.toMatch(/T(10:|14:|15:)/);
    expect(times[0]!.label).toMatch(/^Friday 16 October, \d\d:\d\d to \d\d:\d\d GMT\+5:30$/);
  });
  it("with no calendar there are no times, and nothing is made up", async () => {
    expect(await proposeTimes(undefined, GROWTH_NOW)).toEqual([]);
  });
  it("tomorrow in the business's own zone (it is already the 16th in India at 20:00 UTC)", () => {
    const iso = (w: { from: number; to: number }) => [new Date(w.from).toISOString(), new Date(w.to).toISOString()];
    expect(iso(tomorrowWindow(GROWTH_NOW, "UTC"))).toEqual(["2026-10-16T00:00:00.000Z", "2026-10-17T00:00:00.000Z"]);
    expect(iso(tomorrowWindow(GROWTH_NOW, "Asia/Kolkata"))).toEqual(["2026-10-16T18:30:00.000Z", "2026-10-17T18:30:00.000Z"]);
  });
});

describe("the stand-up", () => {
  it("drafts the reply, the reminder and the nudge as emails waiting for the owner's OK, with the recipient and every word", async () => {
    const standup = await runStandup(GROWTH_TENANT, { graph: g, now: GROWTH_NOW, drafters: drafters(), force: true });
    expect(standup.items.map((i) => [i.kind, i.agent, i.status])).toEqual([["sales_reply", "sales-lead", "drafted"], ["sales_reminder", "sales-lead", "drafted"], ["sales_nudge", "sales-lead", "drafted"]]);
    expect(standup.heading).toBe("Your team noticed 3 things and drafted them");
    expect(standup.lines[0]).toMatch(/Neel drafted a reply to Rohit Desai's enquiry/);
    expect(ownerJargon([standup.heading, ...standup.lines].join("\n"))).toEqual([]);

    const reply = (await approval(g, standup.items[0]!.approvalId!))!;
    expect(reply).toMatchObject({ kind: "email_send", status: "pending", by: "sales-lead" });
    expect(reply.payload).toMatchObject({ title: "Your enquiry", target: "Email to rohit@desaicaterers.example" });
    // three real times went to the writer, and they are in the draft
    const job = texts.find((t) => t.kind === "sales_email" && t.facts.some((f) => /Rohit/.test(f) || /Need 12 servers/.test(f)))!;
    expect(job.facts.find((f) => f.startsWith("Three free times"))!.split(";")).toHaveLength(3);
    expect(reply.payload.body).toContain("Friday 16 October");
    // what Discord shows: who it goes to and every word
    const card = standupCard(reply, standup.items[0]!.why).content;
    expect(card).toContain("rohit@desaicaterers.example");
    expect(card).toContain("Friday 16 October");
    expect(approvalCard(reply).content).toContain("Email to rohit@desaicaterers.example");

    const nudge = (await approval(g, standup.items[2]!.approvalId!))!;
    expect(nudge.payload).toMatchObject({ target: "Email to sana@sahyadrihotels.example", title: "Following up: Sana Qureshi" });
    const reminder = (await approval(g, standup.items[1]!.approvalId!))!;
    expect(reminder.payload).toMatchObject({ target: "Email to arjun@mehtalogistics.example" });
    expect(reminder.payload.title).toMatch(/^Our call tomorrow: Call with Arjun Mehta/);
  });

  it("the second run the same day returns the first; a forced run adds nothing new and drafts nothing twice", async () => {
    const again = await runStandup(GROWTH_TENANT, { graph: g, now: GROWTH_NOW + 3600_000, drafters: drafters() });
    expect(again.reused).toBe(true);
    const forced = await runStandup(GROWTH_TENANT, { graph: g, now: GROWTH_NOW + 3600_000, drafters: drafters(), force: true });
    // the three are not drafted again (they are waiting); the free slots may go to other things, never to a second copy of these
    expect(forced.items.filter((i) => i.kind.startsWith("sales_") && i.status === "drafted")).toHaveLength(3);
    const [n] = await g.roQuery<{ n: number }>("MATCH (a:Entity:Approval) WHERE a.standupKind STARTS WITH 'sales_' RETURN count(a) AS n");
    expect(n!.n).toBe(3);
  });

  it("the owner's OK on the reply sends it (the sample inbox: nothing real) and moves Rohit to contacted", async () => {
    const standup = (await readStandup(g))!;
    const done = await decide(g, GROWTH_TENANT, standup.items[0]!.approvalId!, { decision: "approve" }, { now: GROWTH_NOW + 2 * 3600_000 });
    expect(done.action).toMatchObject({ kind: "email_send", status: "done" });
    expect(await getLead(g, "lead:rohit-desaicaterers-example")).toMatchObject({ stage: "contacted", needsReply: false });
    expect(demoConnections(GROWTH_TENANT).apis.sent.at(-1)).toMatchObject({ to: ["rohit@desaicaterers.example"] });
  });
});
