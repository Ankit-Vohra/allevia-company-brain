// Graph audit G10b: what approving a card writes says where it came from and when. APPROVED_BY / REJECTED_BY, Approval -RESULTED_IN->
// Action, Action -RESULTED_IN-> what it made and Action -AFFECTS-> carry src and asOf; an action with no named target has no AFFECTS
// edge (it used to fall back to the first piece of evidence); a Discord post and a change on a connected tool leave a Document; a
// task or a draft ADVANCES the goals the card's recommendation advances; an email and an invite keep the Gmail and Calendar ids.
// Every write is read back with a Cypher traversal. The outside world (gh, Discord, Google) is faked.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GraphHandle } from "../../src/graph/client.js";
import { decideApproval, type DecideDeps } from "../../src/actions/approvals.js";
import type { GhRunner, HttpFn } from "../../src/actions/executors.js";
import { executeApproval, type ExecutorDeps } from "../../src/actions/executors.js";
import type { Payload } from "../../src/actions/shared.js";
import type { ConnectionsPort } from "../../src/connections/service.js";
import { upsertEdge, upsertNode } from "../../src/graph/upsert.js";
import { SEED_NOW } from "../fixtures/seed-graph.js";
import { seededGraph } from "../helpers/tools.js";

let g: GraphHandle;
let cleanup: () => Promise<void>;
let dataDir: string;
const DAY = new Date(SEED_NOW).toISOString().slice(0, 10);
const REPO = "Example-Org/example-repo";
let issues = 0;
const gh: GhRunner = async () => `https://github.com/${REPO}/issues/${++issues + 500}\n`;
const decideDeps = (over: Partial<ExecutorDeps> = {}): DecideDeps => ({ tenant: "test", executors: { gh, config: { githubActionRepo: REPO, dataDir, discord: {} }, ...over } });
const execDeps = (over: Partial<ExecutorDeps> = {}): ExecutorDeps => ({ tenant: "test", config: { githubActionRepo: REPO, dataDir, discord: {} }, ...over });
const rows = <T>(q: string, p: Record<string, unknown> = {}) => g.roQuery<T>(q, p);
const count = async (q: string, p: Record<string, unknown> = {}) => (await rows<{ c: number }>(q, p))[0]?.c ?? 0;

let k = 0;
// A card as the product makes it: a Recommendation (advancing a goal, evidenced by a page) that PROPOSES a pending Approval.
async function card(kind: string, payload: Record<string, unknown>, o: { goal?: boolean; evidence?: boolean } = {}): Promise<{ approval: string; rec: string }> {
  const n = ++k;
  const approval = `approval:g10b-${n}`, rec = `recommendation:g10b-${n}`;
  await upsertNode(g, { type: "Recommendation", id: rec, name: `Do ${String(payload.title)}`, props: { status: "proposed", by: "tech-lead" } }, SEED_NOW);
  await upsertNode(g, { type: "Approval", id: approval, name: `${kind}: ${String(payload.title)}`, props: { status: "pending", kind, by: "tech-lead", payload: JSON.stringify(payload) } }, SEED_NOW);
  await upsertEdge(g, { from: rec, type: "PROPOSES", to: approval }, SEED_NOW);
  if (o.goal !== false) await upsertEdge(g, { from: rec, type: "ADVANCES", to: "goal:g10b-leads" }, SEED_NOW);
  if (o.evidence) await upsertEdge(g, { from: rec, type: "EVIDENCED_BY", to: "page:www.aamdani.ai/jobs" }, SEED_NOW);
  return { approval, rec };
}

beforeAll(async () => {
  ({ g, cleanup } = await seededGraph());
  dataDir = mkdtempSync(join(tmpdir(), "allevia-g10b-"));
  await upsertNode(g, { type: "Goal", id: "goal:g10b-leads", name: "More enquiries", props: { status: "active" } }, SEED_NOW);
  // fixes land as tasks in the app unless a test says the business chose a GitHub repo of its own
  await upsertNode(g, { type: "Business", id: await bizId(), name: "Aamdani", props: { actionTarget: "app" } }, SEED_NOW);
});
const bizId = async () => (await rows<{ id: string }>("MATCH (b:Business) RETURN b.id AS id ORDER BY id LIMIT 1"))[0]!.id;
afterAll(async () => {
  await cleanup?.();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("the decision and what it made carry their source and date", () => {
  it("APPROVED_BY, Approval -RESULTED_IN-> Action, Action -RESULTED_IN-> Task and Action -AFFECTS-> a target each say src and asOf", async () => {
    const { approval, rec } = await card("github_issue", { title: "Fix /jobs meta", body: "- [ ] add it", targetId: "page:www.aamdani.ai/jobs" });
    const r = await decideApproval(g, { approvalId: approval, decision: "approve", now: SEED_NOW + 60_000 }, decideDeps());
    expect(r.action).toMatchObject({ status: "done", affects: ["page:www.aamdani.ai/jobs"] });
    const action = r.action!.id;
    type E = { src: string | null; asOf: string | null };
    const approvedBy = await rows<E>("MATCH (:Approval {id:$a})-[e:APPROVED_BY]->(:Person) RETURN e.src AS src, e.asOf AS asOf", { a: approval });
    expect(approvedBy).toEqual([{ src: approval, asOf: DAY }]);
    const resulted = await rows<E>("MATCH (:Approval {id:$a})-[e:RESULTED_IN]->(:Action {id:$x}) RETURN e.src AS src, e.asOf AS asOf", { a: approval, x: action });
    expect(resulted).toEqual([{ src: approval, asOf: DAY }]);
    const made = await rows<E & { kind: string }>("MATCH (:Action {id:$x})-[e:RESULTED_IN]->(t:Task) RETURN e.src AS src, e.asOf AS asOf, t.kind AS kind", { x: action });
    expect(made).toEqual([{ src: action, asOf: DAY, kind: "fix" }]);
    const affects = await rows<E>("MATCH (:Action {id:$x})-[e:AFFECTS]->(:Page {id:'page:www.aamdani.ai/jobs'}) RETURN e.src AS src, e.asOf AS asOf", { x: action });
    expect(affects).toEqual([{ src: action, asOf: DAY }]);
    // the Action node itself says which approval it came from and when
    expect(await rows("MATCH (a:Action {id:$x}) RETURN a.src AS src, a.asOf AS asOf, a.approval AS approval", { x: action })).toEqual([{ src: approval, asOf: DAY, approval }]);
    // the task the card made ADVANCES the goal the card's recommendation advances, from the action
    const adv = await rows<E>("MATCH (:Recommendation {id:$r})-[:ADVANCES]->(gl:Goal)<-[e:ADVANCES]-(:Task {kind:'fix'})<-[:RESULTED_IN]-(:Action {id:$x}) RETURN e.src AS src, e.asOf AS asOf", { r: rec, x: action });
    expect(adv).toEqual([{ src: action, asOf: DAY }]);
  });

  it("REJECTED_BY says src and asOf too, and a rejection runs nothing", async () => {
    const { approval } = await card("github_issue", { title: "Not now", body: "x" });
    const r = await decideApproval(g, { approvalId: approval, decision: "reject", now: SEED_NOW + 5000 }, decideDeps());
    expect(r.action).toBeNull();
    expect(await rows("MATCH (:Approval {id:$a})-[e:REJECTED_BY]->(:Person) RETURN e.src AS src, e.asOf AS asOf", { a: approval })).toEqual([{ src: approval, asOf: DAY }]);
  });

  it("an action whose card named no target has no AFFECTS edge, even when its recommendation has evidence", async () => {
    const { approval, rec } = await card("github_issue", { title: "A fix with no named target", body: "x" }, { evidence: true });
    expect(await count("MATCH (:Recommendation {id:$r})-[:EVIDENCED_BY]->(x) RETURN count(x) AS c", { r: rec })).toBe(1);
    const r = await decideApproval(g, { approvalId: approval, decision: "approve", now: SEED_NOW + 9000 }, decideDeps());
    expect(r.action).toMatchObject({ status: "done", affects: [] });
    expect(await count("MATCH (:Action {id:$x})-[e:AFFECTS]->() RETURN count(e) AS c", { x: r.action!.id })).toBe(0);
  });

  it("an issue opened on the business's own GitHub repo makes a Task that ADVANCES the goal, and a draft makes a Content that does", async () => {
    // the business chose a repo of its own, so gh runs
    const biz = await bizId();
    await upsertNode(g, { type: "Business", id: biz, name: "Aamdani", props: { actionTarget: "github", actionRepo: REPO } }, SEED_NOW + 10_000);
    const issue = await card("github_issue", { title: "Open a real issue", body: "x" });
    const r = await decideApproval(g, { approvalId: issue.approval, decision: "approve", now: SEED_NOW + 11_000 }, decideDeps());
    expect(r.action).toMatchObject({ status: "done", url: expect.stringContaining("github.com") });
    expect(await count("MATCH (:Action {id:$x})-[:RESULTED_IN]->(t:Task {kind:'issue'})-[e:ADVANCES]->(:Goal {id:'goal:g10b-leads'}) WHERE e.src = $x RETURN count(e) AS c", { x: r.action!.id })).toBe(1);
    await upsertNode(g, { type: "Business", id: biz, name: "Aamdani", props: { actionTarget: "app", actionRepo: null } }, SEED_NOW + 12_000);

    const draft = await card("content_draft", { title: "A post about the jobs board", body: "Hiring in Raipur? Post a job in two minutes.", format: "post" });
    const d = await decideApproval(g, { approvalId: draft.approval, decision: "approve", now: SEED_NOW + 13_000 }, decideDeps());
    expect(d.action).toMatchObject({ status: "done" });
    expect(await count("MATCH (:Action {id:$x})-[:RESULTED_IN]->(c:Content)-[e:ADVANCES]->(:Goal {id:'goal:g10b-leads'}) WHERE e.src = $x AND e.asOf = $day RETURN count(e) AS c", { x: d.action!.id, day: DAY })).toBe(1);
  });
});

describe("a Discord post and a change on a connected tool leave a result node", () => {
  const http = (id: string): HttpFn => async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ id, guild_id: "g1" }) });

  it("discord_post: Document{kind:'discord_post', channelId, messageId} PRODUCED by the Chief, and Action -RESULTED_IN-> Document", async () => {
    const { approval } = await card("discord_post", { title: "Morning note", body: "Three things for today." });
    const a = await executeApproval(g, { approvalId: approval, kind: "discord_post", payload: { title: "Morning note", body: "Three things for today." }, now: SEED_NOW + 20_000 },
      execDeps({ http: http("98765"), config: { dataDir, discord: { token: "test-token-not-real", channelId: "4242", guildId: "g1" } } }));
    expect(a).toMatchObject({ status: "done", url: "https://discord.com/channels/g1/4242/98765" });
    const doc = await rows<{ id: string; kind: string; channelId: string; messageId: string; by: string; src: string }>(
      `MATCH (:Approval {id:$a})-[:RESULTED_IN]->(x:Action)-[e:RESULTED_IN]->(d:Document)<-[:PRODUCED]-(ag:Agent)
       WHERE e.src = x.id RETURN d.id AS id, d.kind AS kind, d.channelId AS channelId, d.messageId AS messageId, ag.rosterId AS by, d.src AS src`, { a: approval });
    expect(doc).toEqual([{ id: expect.stringMatching(/^document:discord-post-/), kind: "discord_post", channelId: "4242", messageId: "98765", by: "chief-of-staff", src: approval }]);
    // the bot's token is never written anywhere in the graph
    expect(await count("MATCH (n) WHERE toString(n.summary) CONTAINS 'test-token-not-real' OR toString(n.result) CONTAINS 'test-token-not-real' RETURN count(n) AS c")).toBe(0);
  });

  it("a dry run posts nothing and leaves no Document", async () => {
    const { approval } = await card("discord_post", { title: "Dry note", body: "Nothing goes out." });
    const a = await executeApproval(g, { approvalId: approval, kind: "discord_post", payload: { title: "Dry note", body: "Nothing goes out." }, now: SEED_NOW + 21_000 },
      execDeps({ dryRun: true, config: { dataDir, discord: { token: "t", channelId: "4242" } } }));
    expect(a.status).toBe("dry_run");
    expect(await count("MATCH (:Approval {id:$a})-[:RESULTED_IN]->(:Action)-[:RESULTED_IN]->(d:Document) RETURN count(d) AS c", { a: approval })).toBe(0);
  });

  // A connections port that answers like Google and Composio would, and records what was asked.
  const port = (): ConnectionsPort & { asked: string[] } => {
    const asked: string[] = [];
    const session = {
      allowed: () => true, accessToken: "t",
      apis: {
        sendEmail: async () => { asked.push("sendEmail"); return { id: "gmail-msg-77", threadId: "gmail-thr-77" }; },
        createEvent: async () => { asked.push("createEvent"); return { id: "cal-evt-88", link: "https://calendar.example/cal-evt-88" }; },
      },
      execute: async () => { asked.push("execute"); return { ok: true }; },
    };
    return { tenant: "test", asked, status: async () => ({ state: "connected" as const, message: "" }), list: async () => [], note: async () => "", run: async (_id: string, _op: string, fn: (s: never) => Promise<never>) => fn(session as never) } as unknown as ConnectionsPort & { asked: string[] };
  };

  it("connection_action: Document{kind:'connection_action', connection, tool} PRODUCED by the agent that proposed it", async () => {
    const payload = { title: "Add a note to the Retainer deal", body: "Note: followed up", connection: "hubspot", tool: "HUBSPOT_CREATE_NOTE", args: { body: "x" }, target: "HubSpot" };
    const { approval } = await card("connection_action", payload);
    const p = port();
    const a = await executeApproval(g, { approvalId: approval, kind: "connection_action", payload, agent: "sales-lead", now: SEED_NOW + 22_000 }, execDeps({ connections: p }));
    expect(a.status).toBe("done");
    expect(p.asked).toEqual(["execute"]);
    const doc = await rows(
      `MATCH (:Approval {id:$a})-[:RESULTED_IN]->(x:Action)-[:RESULTED_IN]->(d:Document {kind:'connection_action'})<-[:PRODUCED]-(ag:Agent)
       RETURN d.connection AS connection, d.tool AS tool, ag.rosterId AS by`, { a: approval });
    expect(doc).toEqual([{ connection: "hubspot", tool: "HUBSPOT_CREATE_NOTE", by: "sales-lead" }]);
  });

  it("email_send and calendar_event keep the Gmail message id and the Calendar event id on the Action; the result text is the same", async () => {
    const email = { title: "Your quote", subject: "Your quote", to: ["lead@client.example"], body: "Hello, here is the quote you asked for.", send: true };
    const e = await card("email_send", email);
    const p = port();
    const sent = await executeApproval(g, { approvalId: e.approval, kind: "email_send", payload: email, now: SEED_NOW + 23_000 }, execDeps({ connections: p }));
    expect(sent).toMatchObject({ status: "done", messageId: "gmail-msg-77", result: 'Sent "Your quote" to lead@client.example (message gmail-msg-77).' });
    expect(await rows("MATCH (:Approval {id:$a})-[:RESULTED_IN]->(x:Action) RETURN x.messageId AS messageId, x.threadId AS threadId, x.eventId AS eventId", { a: e.approval })).toEqual([{ messageId: "gmail-msg-77", threadId: "gmail-thr-77", eventId: null }]);

    const meeting = { title: "Kickoff", body: "", start: "2026-10-20T10:00:00Z", end: "2026-10-20T10:30:00Z", attendees: ["lead@client.example"] };
    const m = await card("calendar_event", meeting);
    const booked = await executeApproval(g, { approvalId: m.approval, kind: "calendar_event", payload: meeting as unknown as Payload, now: SEED_NOW + 24_000 }, execDeps({ connections: p }));
    expect(booked).toMatchObject({ status: "done", eventId: "cal-evt-88", url: "https://calendar.example/cal-evt-88" });
    expect(await rows("MATCH (:Approval {id:$a})-[:RESULTED_IN]->(x:Action) RETURN x.eventId AS eventId, x.messageId AS messageId", { a: m.approval })).toEqual([{ eventId: "cal-evt-88", messageId: null }]);
  });
});
