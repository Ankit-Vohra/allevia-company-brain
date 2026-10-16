// The Sales demo on the synthetic business (Shiftly) is a story a judge can follow in the graph: each record the seed says came from an
// approval is the end of a real chain, Recommendation -PROPOSES-> Approval -RESULTED_IN-> Action -RESULTED_IN-> Message or Meeting,
// and the leads carry their channel, their campaign or post, and the goal they are for. Every claim is read back by a traversal.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { GROWTH_NOW, seedGrowth } from "../../src/demo/growth.js";
import { getApproval } from "../../src/actions/approvals.js";
import { crmRead } from "../../src/agent/tools/sales.js";
import { call, makeCtx } from "../helpers/tools.js";
import { testGraph } from "../helpers/graph.js";

let g: GraphHandle;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  ({ g, cleanup } = await testGraph());
  await seedGrowth(g);
}, 120_000);
afterAll(async () => { await cleanup(); await closeAll(); });

describe("an approval, followed to the message or meeting it made", () => {
  const CHAINS = [
    ["approval:demo-greenleaf-invite", "action:demo-greenleaf-invite", "meeting:ira-greenleafcafes-example-202609302000"],
    ["approval:demo-greenleaf-reply", "action:demo-greenleaf-reply", "message:email-demo-greenleaf-reply"],
    ["approval:demo-mehta-invite", "action:demo-mehta-invite", "meeting:arjun-mehtalogistics-example-202610160530"],
    ["approval:demo-mehta-reply", "action:demo-mehta-reply", "message:email-demo-mehta-reply"],
    ["approval:demo-mehta-reply-draft", "action:demo-mehta-reply-draft", "message:email-demo-mehta-reply"],
    ["approval:demo-sahyadri-reply", "action:demo-sahyadri-reply", "message:email-demo-sahyadri-reply"],
  ];

  it("every approval ends, two hops on, in the Message or Meeting the seed says it made", async () => {
    const rows = await g.roQuery<{ approval: string; action: string; made: string }>(
      `MATCH (a:Approval)-[r1:RESULTED_IN]->(x:Action)-[r2:RESULTED_IN]->(m:Entity) WHERE r1.until IS NULL AND r2.until IS NULL AND (m:Message OR m:Meeting)
       RETURN a.id AS approval, x.id AS action, m.id AS made ORDER BY approval, made`);
    expect(rows.map((r) => [r.approval, r.action, r.made])).toEqual(CHAINS);
  });

  it("the id the records name as their source is a node that exists: every message and meeting from an approval", async () => {
    const rows = await g.roQuery<{ id: string; src: string; found: string | null }>(
      `MATCH (m:Entity) WHERE (m:Message OR m:Meeting) AND m.src STARTS WITH 'approval:'
       OPTIONAL MATCH (a:Entity:Approval {id: m.src}) RETURN m.id AS id, m.src AS src, a.id AS found ORDER BY m.id`);
    expect(rows.length).toBe(5);
    expect(rows.filter((r) => r.found === null)).toEqual([]);
  });

  it("each approval was decided by the owner, with the recommendation that proposed it and the evidence that recommendation stands on", async () => {
    const rows = await g.roQuery<{ card: string; status: string; by: string; owner: string; rec: string; lead: string }>(
      `MATCH (rec:Recommendation)-[p:PROPOSES]->(a:Approval)-[d:APPROVED_BY]->(o:Person)
       MATCH (rec)-[e:EVIDENCED_BY]->(l:Lead) WHERE p.until IS NULL AND d.until IS NULL AND e.until IS NULL
       RETURN a.id AS card, a.status AS status, a.decidedBy AS by, o.id AS owner, rec.id AS rec, l.id AS lead ORDER BY card, lead`);
    expect(rows).toHaveLength(6);
    for (const r of rows) {
      expect(r).toMatchObject({ status: "executed", by: "person:founder", owner: "person:founder" });
      expect(r.rec).toMatch(/^recommendation:(send|draft)-email|recommendation:meeting-/);
    }
    expect(rows.map((r) => `${r.card} > ${r.lead}`)).toEqual([
      "approval:demo-greenleaf-invite > lead:ira-greenleafcafes-example",
      "approval:demo-greenleaf-reply > lead:ira-greenleafcafes-example",
      "approval:demo-mehta-invite > lead:arjun-mehtalogistics-example",
      "approval:demo-mehta-reply > lead:arjun-mehtalogistics-example",
      "approval:demo-mehta-reply-draft > lead:arjun-mehtalogistics-example",
      "approval:demo-sahyadri-reply > lead:sana-sahyadrihotels-example",
    ]);
  });

  it("the Approvals page's own read sees the card as executed, with its action, owner and the sent words", async () => {
    const card = await getApproval(g, "approval:demo-mehta-reply");
    expect(card).toMatchObject({ id: "approval:demo-mehta-reply", kind: "email_send", status: "executed", decision: "approve", firstPass: true, actionId: "action:demo-mehta-reply", by: "sales-lead" });
    expect(card!.recommendationId).toMatch(/^recommendation:send-email-re-warehouse/);
    expect(card!.payload).toMatchObject({ subject: "Re: Warehouse shift workers", to: ["arjun@mehtalogistics.example"], send: true });
    expect(card!.result).toMatch(/Sent "Re: Warehouse shift workers" to arjun@mehtalogistics.example/);
    // the card moved pending, approved, executed: two Versions keep where it was
    const v = await g.roQuery<{ was: string }>("MATCH (a:Entity {id:$id})-[h:HAD_VERSION]->(v:Version) WHERE 'status' IN v.changed RETURN v.props AS was ORDER BY v.until, v.id", { id: "approval:demo-mehta-reply" });
    expect(v.map((x) => (JSON.parse(x.was) as { status: string }).status)).toEqual(["pending", "approved"]);
  });

  it("an action is marked as sample data (it reached nobody) and affects the lead", async () => {
    const [x] = await g.roQuery<{ simulated: boolean; status: string; lead: string; src: string }>(
      "MATCH (x:Action {id:'action:demo-sahyadri-reply'})-[f:AFFECTS]->(l:Lead) WHERE f.until IS NULL RETURN x.simulated AS simulated, x.status AS status, l.id AS lead, f.src AS src");
    expect(x).toEqual({ simulated: true, status: "done", lead: "lead:sana-sahyadrihotels-example", src: "approval:demo-sahyadri-reply" });
  });

  it("the reply to Arjun was a draft first, then sent: 'draft' is one hop away as a Version, and Gmail's id is on the message", async () => {
    const [m] = await g.roQuery<{ status: string; externalId: string; threadId: string }>(
      "MATCH (m:Entity:Message {id:'message:email-demo-mehta-reply'}) RETURN m.status AS status, m.externalId AS externalId, m.threadId AS threadId");
    expect(m).toEqual({ status: "sent", externalId: "demo-gmail-mehta-reply", threadId: "demo-thr-mehta" });
    const v = await g.roQuery<{ was: string }>("MATCH (m:Entity {id:'message:email-demo-mehta-reply'})-[h:HAD_VERSION]->(v:Version) WHERE 'status' IN v.changed RETURN v.props AS was ORDER BY v.until, v.id");
    expect(v.map((x) => (JSON.parse(x.was) as { status: string }).status)).toEqual(["draft"]);
    const [meeting] = await g.roQuery<{ id: string; calendarEventId: string }>("MATCH (m:Entity:Meeting {id:'meeting:arjun-mehtalogistics-example-202610160530'}) RETURN m.id AS id, m.calendarEventId AS calendarEventId");
    expect(meeting!.calendarEventId).toBe("demo-evt-mehta");
  });
});

describe("where the leads came from, and what they are for", () => {
  it("every message came via a channel, as incoming or outgoing; every meeting via the calendar", async () => {
    const rows = await g.roQuery<{ id: string; ch: string; dir: string }>(
      "MATCH (m:Entity)-[r:CAME_VIA]->(c:Channel) WHERE r.until IS NULL AND (m:Message OR m:Meeting) RETURN m.id AS id, c.id AS ch, r.direction AS dir ORDER BY m.id");
    expect(rows).toHaveLength(9);
    expect(rows.filter((r) => r.id.startsWith("meeting:")).map((r) => [r.ch, r.dir])).toEqual([["channel:calendar", "out"], ["channel:calendar", "out"]]);
    expect(rows.filter((r) => r.id.startsWith("message:")).map((r) => `${r.id} ${r.ch} ${r.dir}`)).toEqual([
      "message:email-demo-greenleaf-1 channel:email in", "message:email-demo-greenleaf-reply channel:email out", "message:email-demo-mehta-1 channel:email in",
      "message:email-demo-mehta-reply channel:email out", "message:email-demo-sahyadri-1 channel:email in", "message:email-demo-sahyadri-reply channel:email out",
      "message:whatsapp-demo-desai-1 channel:whatsapp in",
    ]);
  });

  it("two leads came from the wedding-season campaign and its reel, because their enquiries named them", async () => {
    const rows = await g.roQuery<{ lead: string; via: string; how: string; text: string }>(
      `MATCH (l:Lead)-[r:CAME_VIA]->(x:Entity) WHERE r.until IS NULL AND (x:Campaign OR x:Content)
       RETURN l.id AS lead, x.id AS via, r.matchedOn AS how, r.text AS text ORDER BY l.id, x.id`);
    expect(rows).toEqual([
      { lead: "lead:rohit-desaicaterers-example", via: "content:weekend-wedding-staff-reel", how: "name", text: "Weekend wedding staff reel" },
      { lead: "lead:sana-sahyadrihotels-example", via: "campaign:wedding-season-staffing", how: "utm_campaign", text: "wedding-season" },
    ]);
  });

  it("every lead, deal and meeting advances the demo's goal for enquiries, which the business pursues", async () => {
    const rows = await g.roQuery<{ id: string }>("MATCH (x:Entity)-[r:ADVANCES]->(gl:Goal {id:'goal:employer-enquiries'}) WHERE r.until IS NULL RETURN x.id AS id ORDER BY id");
    const count = (prefix: string) => rows.filter((r) => r.id.startsWith(prefix)).length;
    expect({ deals: count("deal:"), leads: count("lead:"), meetings: count("meeting:"), messages: count("message:") }).toEqual({ deals: 3, leads: 4, meetings: 2, messages: 4 });
    const [pursued] = await g.roQuery<{ id: string }>("MATCH (b:Business)-[r:PURSUES]->(gl:Goal {id:'goal:employer-enquiries'}) WHERE r.until IS NULL RETURN b.id AS id");
    expect(pursued!.id).toBe("business:shiftly");
    const [metric] = await g.roQuery<{ key: string }>("MATCH (:Goal {id:'goal:employer-enquiries'})-[t:TRACKS]->(m:Metric) WHERE t.until IS NULL RETURN m.key AS key");
    expect(metric!.key).toBe("enquiries");
  });

  it("the attribution view reads it all in one answer", async () => {
    const r = await call(crmRead, { view: "attribution" }, makeCtx(g, { tenant: "demo_growth", now: GROWTH_NOW }));
    expect(r.data.leads).toBe(4);
    expect(r.data.campaigns).toMatchObject([{ id: "campaign:wedding-season-staffing", leads: 1, who: [{ who: "Sana Qureshi", stage: "contacted" }] }]);
    expect(r.data.content).toMatchObject([{ id: "content:weekend-wedding-staff-reel", leads: 1, who: [{ who: "Rohit Desai", stage: "new" }] }]);
    expect(r.data.channels.map((c: { id: string; leads: number }) => [c.id, c.leads])).toEqual([["channel:email", 3], ["channel:whatsapp", 1]]);
    expect(r.data.goals).toMatchObject([{ id: "goal:employer-enquiries", leads: 4, deals: 3, meetings: 2 }]);
    expect(r.data.leadsWithNoCampaignOrPost).toBe(2);
  });
});
