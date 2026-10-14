import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { GraphHandle } from "../../../src/graph/client.js";
import { recall, remember } from "../../../src/agent/tools/memory.js";
import { SEED_NOW } from "../../fixtures/seed-graph.js";
import { call, ids, makeCtx, seededGraph } from "../../helpers/tools.js";

describe("recall, remember (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeAll(async () => ({ g, cleanup } = await seededGraph()), 60_000);
  afterAll(async () => cleanup());
  const count = async (cypher: string) => (await g.roQuery<{ c: number }>(cypher))[0]!.c;

  it("recall: past turns, memories and preferences about an entity", async () => {
    const r = await call(recall, { ids: ["decision:007-pause-daily-stories"] }, makeCtx(g));
    expect(r.data.turns).toHaveLength(1);
    expect(r.data.turns[0]).toMatchObject({
      id: "turn:t-001", question: "Why did we pause daily stories?", at: "2026-10-14T09:00:00.000Z", session: "session:s-001",
      agents: ["chief-of-staff", "librarian"], touched: ["decision:007-pause-daily-stories"],
    });
    expect(r.data.turns[0].answer.length).toBeLessThanOrEqual(300);
    expect(r.data.turns[0].answer).toMatch(/^We paused daily stories/);
    expect(r.data.memories).toEqual([expect.objectContaining({ id: "memory:t-001-1", kind: "fact", statedBy: ["person:founder"], about: ["decision:007-pause-daily-stories"] })]);
    expect(r.data.preferences.map((p: { id: string }) => p.id)).toEqual(["memory:t-000-1"]);
    expect(r.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: "turn:t-001", type: "TOUCHED", to: "decision:007-pause-daily-stories" }),
      expect.objectContaining({ from: "memory:t-001-1", type: "ABOUT", to: "decision:007-pause-daily-stories" }),
    ]));
    expect(ids(r.nodes)).toEqual(expect.arrayContaining(["decision:007-pause-daily-stories", "turn:t-001", "memory:t-001-1"]));
    expect(ids(r.sources)).toContain("document:adr-007");
  });

  it("recall: open recommendations and pending approvals evidenced by an entity", async () => {
    const r = await call(recall, { ids: ["content:reel-salary-reveal"] }, makeCtx(g));
    expect(r.data.openRecommendations).toEqual([expect.objectContaining({
      id: "recommendation:double-down-on-salary-reels", area: "content", confidence: 0.8,
      approvals: [{ id: "approval:t-001-1", status: "pending", kind: "content_draft" }],
    })]);
    expect(r.data.pendingApprovals).toEqual([{ id: "approval:t-001-1", name: "content_draft: Double down on salary reels", kind: "content_draft", recommendation: "recommendation:double-down-on-salary-reels" }]);
    expect(r.data.pendingApprovalsTotal).toBe(1);
    const types = new Set(r.edges.map((e: { type: string }) => e.type));
    expect(types.has("EVIDENCED_BY") && types.has("PROPOSES")).toBe(true);
  });

  it("recall: by query, and input errors", async () => {
    const r = await call(recall, { query: "daily stories" }, makeCtx(g));
    expect(r.data.turns.map((t: { id: string }) => t.id)).toContain("turn:t-001");
    expect((await call(recall, {}, makeCtx(g))).data.error).toMatch(/ids .*or a query/);
    const unknown = await call(recall, { ids: ["decision:nope"] }, makeCtx(g));
    expect(unknown.data.unknown).toEqual(["decision:nope"]);
    expect(unknown.note).toMatch(/Unknown ids/);
  });

  it("remember: refuses in read-only mode and writes nothing", async () => {
    const r = await call(remember, { text: "x", kind: "fact", about: ["channel:instagram"] }, makeCtx(g, { readOnly: true }));
    expect(r.data).toMatchObject({ refused: true, error: expect.stringMatching(/read-only/) });
    expect(await count("MATCH (m:Memory) WHERE m.id STARTS WITH 'memory:t-100-' RETURN count(m) AS c")).toBe(0);
    expect(remember.writes).toBe(true);
  });

  it("remember: a Memory ABOUT existing entities, STATED by the asker, sourced to the turn; ids never collide", async () => {
    const ctx = makeCtx(g);
    const r = await call(remember, { text: "Prefer reels over stories for hiring posts", kind: "preference", about: ["channel:instagram", "channel:nope"] }, ctx);
    expect(r.data).toMatchObject({ id: "memory:t-100-1", kind: "preference", about: ["channel:instagram"], skipped: ["channel:nope"], statedBy: "person:founder" });
    expect(ids(r.nodes)).toEqual(["memory:t-100-1", "channel:instagram", "person:founder"]);
    expect(r.edges.map((e: { type: string }) => e.type).sort()).toEqual(["ABOUT", "STATED"]);
    const [m] = await g.roQuery<Record<string, unknown>>(
      "MATCH (p:Entity {id:'person:founder'})-[:STATED]->(m:Memory {id:'memory:t-100-1'})-[:ABOUT]->(c:Entity {id:'channel:instagram'}) RETURN m.kind AS kind, m.src AS src, m.at AS at, m.text AS text");
    expect(m).toEqual({ kind: "preference", src: "turn:t-100", at: SEED_NOW, text: "Prefer reels over stories for hiring posts" });
    const both = await Promise.all([
      call(remember, { text: "A", kind: "fact", about: ["channel:instagram"] }, makeCtx(g)),
      call(remember, { text: "B", kind: "instruction", about: ["channel:instagram"] }, makeCtx(g)),
    ]);
    expect(both.map((b) => b.data.id).sort()).toEqual(["memory:t-100-2", "memory:t-100-3"]);
    const later = await call(recall, { ids: ["channel:instagram"] }, makeCtx(g));
    expect(later.data.memories.map((x: { id: string }) => x.id)).toEqual(expect.arrayContaining(["memory:t-100-1", "memory:t-100-2", "memory:t-100-3"]));
    expect(later.data.preferences.map((x: { id: string }) => x.id)).toContain("memory:t-100-1");
    const none = await call(remember, { text: "x", kind: "fact", about: ["channel:nope"] }, makeCtx(g));
    expect(none.data.error).toMatch(/None of the about ids exist/);
  });
});
