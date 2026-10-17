// What moved a goal: the growth plan reads, for each goal, everything with a current ADVANCES edge into it (grouped by what it is and its
// status) and, for each post that advances it, the post's newest reading. Written the way the product writes them (a card and the idea
// behind it both advance a goal; a post, a lead, a deal), read back through the scorecard the Program page and GET /api/:t/program return.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { ensureAgentNode } from "../../src/actions/shared.js";
import { closeEdge, upsertEdge, upsertNode, writeBatch } from "../../src/graph/upsert.js";
import { templateFor } from "../../src/onboard/templates.js";
import { aimSentence, goalAims } from "../../src/program/aimed.js";
import { goalOwners, programAndGoalsWrite } from "../../src/program/program.js";
import { getProgram } from "../../src/program/scorecard.js";
import { testGraph } from "../helpers/graph.js";

const NOW = Date.parse("2026-10-15T06:00:00Z");
const DAY = 86_400_000;
const BIZ = "business:kestrel";
let g: GraphHandle;
let cleanup: () => Promise<void>;
let enquiries = "";
let reach = "";

const card = async (n: number, kind: string, status: string, goal: string, opts: { idea?: boolean } = {}) => {
  const rec = `recommendation:aim-${n}`, appr = `approval:aim-${n}`;
  await upsertNode(g, { type: "Recommendation", id: rec, name: `Idea ${n}`, props: { status: "open", kind, area: "content" } }, NOW - 5 * DAY);
  await upsertNode(g, { type: "Approval", id: appr, name: `${kind}: Card ${n}`, props: { kind, status, title: `Card ${n}` } }, NOW - 5 * DAY);
  await upsertEdge(g, { from: rec, type: "PROPOSES", to: appr }, NOW - 5 * DAY);
  await upsertEdge(g, { from: appr, type: "ADVANCES", to: goal }, NOW - 4 * DAY);
  if (opts.idea !== false) await upsertEdge(g, { from: rec, type: "ADVANCES", to: goal }, NOW - 4 * DAY);
  return appr;
};

beforeAll(async () => {
  ({ g, cleanup } = await testGraph());
  await upsertNode(g, { type: "Business", id: BIZ, name: "Kestrel Interiors", props: { timeZone: "Asia/Kolkata" } }, NOW - 30 * DAY);
  const template = templateFor("architecture studio");
  for (const o of goalOwners(template)) await ensureAgentNode(g, o, NOW - 30 * DAY);
  const p = await programAndGoalsWrite(g, { slug: "kestrel", businessId: BIZ, businessName: "Kestrel Interiors", template, now: NOW - 10 * DAY, startDate: "2026-10-05", timeZone: "Asia/Kolkata" });
  expect((await writeBatch(g, p.write, NOW - 10 * DAY)).errors).toEqual([]);
  enquiries = p.goals.find((x) => x.endsWith("qualified-enquiries"))!;
  reach = p.goals.find((x) => x.endsWith("instagram-reach"))!;
  expect(enquiries).toBeTruthy();
  expect(reach).toBeTruthy();
}, 90_000);
afterAll(async () => { await cleanup(); await closeAll(); });

describe("what is aimed at each goal", () => {
  beforeAll(async () => {
    // two approved drafts (one edited then approved, one already run), one fix that ran, one draft still waiting for the owner, a rejected one
    await card(1, "content_draft", "executed", enquiries);
    await card(2, "content_draft", "approved", enquiries);
    await card(3, "github_issue", "executed", enquiries);
    await card(4, "content_draft", "pending", enquiries);
    await card(5, "content_draft", "rejected", enquiries);
    // a card whose aim ended: it moved on to another goal, so the old edge is closed and does not count
    const moved = await card(6, "content_draft", "executed", enquiries, { idea: false });
    await closeEdge(g, moved, "ADVANCES", enquiries, NOW - 2 * DAY, "aimed at another goal");
    await upsertEdge(g, { from: moved, type: "ADVANCES", to: reach }, NOW - 2 * DAY);
    // a post that carries the goal, with two readings (the newest is the one the plan shows) and a post nobody has measured
    await upsertNode(g, { type: "Content", id: "content:reel-kitchens", name: "Reel: kitchens", props: { status: "published", format: "reel" } }, NOW - 6 * DAY);
    await upsertEdge(g, { from: "content:reel-kitchens", type: "ADVANCES", to: enquiries }, NOW - 6 * DAY);
    await upsertNode(g, { type: "Content", id: "content:post-unmeasured", name: "Post: unmeasured", props: { status: "draft", format: "post" } }, NOW - 3 * DAY);
    await upsertEdge(g, { from: "content:post-unmeasured", type: "ADVANCES", to: enquiries }, NOW - 3 * DAY);
    await writeBatch(g, {
      nodes: [], edges: [],
      observations: [
        { subject: "content:reel-kitchens", metric: "views", value: 100, unit: "count", windowStart: "2026-10-01", windowEnd: "2026-10-03", asOf: "2026-10-03", src: "document:ig" },
        { subject: "content:reel-kitchens", metric: "views", value: 140, unit: "count", windowStart: "2026-10-04", windowEnd: "2026-10-08", asOf: "2026-10-08", src: "document:ig" },
        { subject: "content:reel-kitchens", metric: "saves", value: 12, unit: "count", windowStart: "2026-10-04", windowEnd: "2026-10-06", asOf: "2026-10-06", src: "document:ig" },
      ],
    }, NOW - DAY);
    // sales: a lead and its first message came in for the same goal
    await upsertNode(g, { type: "Lead", id: "lead:priya", name: "Priya Shah", props: { stage: "new" } }, NOW - 2 * DAY);
    await upsertNode(g, { type: "Message", id: "message:priya-1", name: "From Priya", props: { status: "received", direction: "in" } }, NOW - 2 * DAY);
    for (const n of ["lead:priya", "message:priya-1"]) await upsertEdge(g, { from: n, type: "ADVANCES", to: enquiries }, NOW - 2 * DAY);
  }, 90_000);

  it("groups everything that advances a goal by what it is and where it stands, closed aims left out", async () => {
    const m = await goalAims(g, [{ id: enquiries, name: "Qualified enquiries per month" }, { id: reach, name: "Instagram reach" }]);
    const aim = m.get(enquiries)!;
    expect(aim.groups).toEqual([
      { kind: "Approval", what: "content_draft", status: "approved", count: 1 },
      { kind: "Approval", what: "content_draft", status: "executed", count: 1 },
      { kind: "Approval", what: "content_draft", status: "pending", count: 1 },
      { kind: "Approval", what: "content_draft", status: "rejected", count: 1 },
      { kind: "Approval", what: "github_issue", status: "executed", count: 1 },
      { kind: "Recommendation", what: "content_draft", status: "open", count: 4 },
      { kind: "Recommendation", what: "github_issue", status: "open", count: 1 },
      { kind: "Content", what: "post", status: "draft", count: 1 },
      { kind: "Content", what: "reel", status: "published", count: 1 },
      { kind: "Lead", what: null, status: null, count: 1 },
      { kind: "Message", what: null, status: "received", count: 1 },
    ]);
    expect(aim.total).toBe(14); // five cards, the five ideas behind them, two posts, a lead and a message
    // the other goal got only the card that moved there
    expect(m.get(reach)!.groups).toEqual([{ kind: "Approval", what: "content_draft", status: "executed", count: 1 }]);
  });

  it("says it in the owner's words: the approved cards, counted once, and what is still waiting", async () => {
    const m = await goalAims(g, [{ id: enquiries, name: "Qualified enquiries per month" }, { id: reach, name: "Instagram reach" }]);
    expect(m.get(enquiries)!.sentence).toBe('2 approved drafts and 1 fix are aimed at "Qualified enquiries per month". 1 more is waiting for your OK.');
    expect(m.get(reach)!.sentence).toBe('1 approved draft is aimed at "Instagram reach".');
  });

  it("gives each post its newest reading, and says nothing for a post nobody has measured", async () => {
    const m = await goalAims(g, [{ id: enquiries, name: "Qualified enquiries per month" }]);
    expect(m.get(enquiries)!.content).toEqual([
      { id: "content:post-unmeasured", name: "Post: unmeasured", status: "draft", latest: null },
      { id: "content:reel-kitchens", name: "Reel: kitchens", status: "published", latest: { metric: "views", value: 140, unit: "count", at: "2026-10-08", obsId: expect.stringMatching(/^obs:views:content:reel-kitchens:/) } },
    ]);
  });

  it("is part of the scorecard: each goal carries what is aimed at it, and a goal nothing is aimed at says so", async () => {
    const p = (await getProgram(g, { now: NOW, businessId: BIZ, write: false }))!;
    const by = new Map(p.goals.map((x) => [x.id, x]));
    expect(by.get(enquiries)!.aimed).toMatchObject({ total: 14, sentence: '2 approved drafts and 1 fix are aimed at "Qualified enquiries per month". 1 more is waiting for your OK.' });
    expect(by.get(enquiries)!.aimed!.content.map((c) => c.id)).toEqual(["content:post-unmeasured", "content:reel-kitchens"]);
    const search = p.goals.find((x) => x.metricKey === "gsc_clicks")!;
    expect(search.aimed).toEqual({ total: 0, groups: [], content: [], sentence: null });
    // read-only (public mode) answers the same
    const again = (await getProgram(g, { now: NOW, businessId: BIZ, write: false }))!;
    expect(again.goals.find((x) => x.id === enquiries)!.aimed!.sentence).toBe(by.get(enquiries)!.aimed!.sentence);
  });
});

describe("the plan's sentence", () => {
  const g1 = (what: string | null, status: string | null, count: number, kind = "Approval") => ({ kind, what, status, count });
  it("counts approved cards by what they are, the biggest group first, and names the goal", () => {
    expect(aimSentence("Enquiries", [g1("content_draft", "executed", 3), g1("github_issue", "approved", 1)])).toBe('3 approved drafts and 1 fix are aimed at "Enquiries".');
    expect(aimSentence("Enquiries", [g1("email_send", "executed", 1)])).toBe('1 approved email is aimed at "Enquiries".');
    expect(aimSentence("Enquiries", [g1("calendar_event", "executed", 2), g1("email_send", "edited", 2), g1("publish_post", "executed", 1)])).toBe('2 approved invites, 2 emails and 1 post are aimed at "Enquiries".');
  });
  it("only counts the owner's cards: the idea behind a card, posts, leads and the rest do not add to it", () => {
    expect(aimSentence("Enquiries", [g1("content_draft", "open", 4, "Recommendation"), g1("reel", "published", 2, "Content"), g1(null, null, 3, "Lead")])).toBeNull();
  });
  it("says when ideas are only waiting", () => {
    expect(aimSentence("Enquiries", [g1("content_draft", "pending", 1)])).toBe('1 idea is waiting for your OK to help with "Enquiries".');
    expect(aimSentence("Enquiries", [g1("content_draft", "pending", 2)])).toBe('2 ideas are waiting for your OK to help with "Enquiries".');
    expect(aimSentence("Enquiries", [g1("content_draft", "executed", 1), g1("content_draft", "pending", 2)])).toBe('1 approved draft is aimed at "Enquiries". 2 more are waiting for your OK.');
  });
});
