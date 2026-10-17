// GET /api/:t/week over the seeded graph: what the team did in the last 7 days (drafts approved, things sent or booked
// with practice runs apart, fixes and follow-ups filed, new things learned, questions answered), counted from the graph.
// Older work, refused drafts, failed actions and failed answers are not counted; a quiet week is plain zeros.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { upsertNode } from "../../src/graph/upsert.js";
import type { WeekDto } from "../../shared/week.js";
import { SEED_NOW } from "../fixtures/seed-graph.js";
import { harness, type Harness } from "./harness.js";

const DAY = 86_400_000;
const NOW = SEED_NOW + 3_600_000; // the harness clock
const IN = NOW - 2 * DAY;
const OLD = NOW - 10 * DAY;

describe("server: what your team did this week (integration)", () => {
  let h: Harness;
  let before: WeekDto; // what the seed graph already has inside the week
  const week = async (app = h.app) => {
    const res = await app.request("/api/mini/week");
    expect(res.status, await res.clone().text()).toBe(200);
    return res.json() as Promise<WeekDto>;
  };

  beforeAll(async () => {
    h = await harness();
    before = await week();
    const approval = (id: string, decision: "approve" | "reject", at: number) =>
      upsertNode(h.g, { type: "Approval", id, name: id, props: { kind: "content_draft", status: decision === "approve" ? "executed" : "rejected", decision, decidedAt: at } }, at);
    await approval("approval:w-ok1", "approve", IN);
    await approval("approval:w-ok2", "approve", NOW - DAY);
    await approval("approval:w-no", "reject", IN);
    await approval("approval:w-old", "approve", OLD);
    const action = (id: string, kind: string, status: string, at: number) =>
      upsertNode(h.g, { type: "Action", id, name: id, props: { kind, status, at, result: "r" } }, at);
    await action("action:w-mail", "email_send", "done", IN);
    await action("action:w-meet", "calendar_event", "done", IN);
    await action("action:w-post", "discord_post", "dry_run", IN);
    await action("action:w-failed", "email_send", "failed", IN);
    await action("action:w-oldmail", "email_send", "done", OLD);
    await action("action:w-fix", "github_issue", "done", IN);
    await action("action:w-fixdry", "github_issue", "dry_run", IN);
    await action("action:w-draft", "content_draft", "done", IN); // saved a draft: not sent, not filed
    await upsertNode(h.g, { type: "Task", id: "task:w-follow", name: "Call back Priya", props: { kind: "follow_up", status: "open" } }, IN);
    await upsertNode(h.g, { type: "Task", id: "task:w-ingested", name: "An issue we read", props: { kind: "issue", status: "open" } }, IN);
    await upsertNode(h.g, { type: "Memory", id: "memory:w-sunday", name: "No posts on Sundays", props: { kind: "preference" } }, IN);
    await upsertNode(h.g, { type: "Rule", id: "rule:w-short", name: "Keep posts short", props: { kind: "learned", status: "active" } }, IN);
    await upsertNode(h.g, { type: "Product", id: "product:w-menu", name: "The new menu" }, IN);
    await upsertNode(h.g, { type: "Memory", id: "memory:w-retired", name: "Gone", props: { status: "retired" } }, IN);
    await upsertNode(h.g, { type: "Person", id: "person:w-old", name: "Known before" }, OLD);
    await upsertNode(h.g, { type: "Document", id: "document:w-doc", name: "A page we read" }, IN); // a source, not a fact
    for (const [id, status, at] of [["turn:w1", "ok", IN], ["turn:w2", "ok", NOW - 60_000], ["turn:w3", "failed", IN], ["turn:w4", "ok", OLD]] as const) {
      await upsertNode(h.g, { type: "Turn", id, name: id, props: { question: "q", answer: "a", at, status } }, at);
    }
  }, 90_000);
  afterAll(async () => h.cleanup());

  it("counts the last 7 days' work from the graph, with practice runs apart", async () => {
    const w = await week();
    expect(w.days).toBe(7);
    expect(w.since).toBe(new Date(NOW - 7 * DAY).toISOString());
    expect(w.approved - before.approved).toBe(2);
    expect({ done: w.sent.done - before.sent.done, practice: w.sent.practice - before.sent.practice }).toEqual({ done: 2, practice: 1 });
    expect({ done: w.filed.done - before.filed.done, practice: w.filed.practice - before.filed.practice }).toEqual({ done: 2, practice: 1 });
    expect(w.learned - before.learned).toBe(3);
    expect(w.answered - before.answered).toBe(2);
  });

  it("is plain zeros on a quiet week", async () => {
    const later = h.make({ now: () => NOW + 30 * DAY });
    expect(await week(later)).toMatchObject({ approved: 0, sent: { done: 0, practice: 0 }, filed: { done: 0, practice: 0 }, learned: 0, answered: 0 });
  });

  it("refuses an unknown business", async () => {
    expect((await h.app.request("/api/nope/week")).status).toBe(404);
  });
});
