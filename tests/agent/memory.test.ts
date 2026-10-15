import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { AGENTS, DEPARTMENTS } from "../../shared/roster.js";
import type { AgentEvent, TurnChecks } from "../../shared/contracts.js";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { writeBatch } from "../../src/graph/upsert.js";
import { noteGraphWrite } from "../../src/graph/projection.js";
import {
  agentNodeId, compactEvents, ensureRoster, getSession, getTurnEvents, listSessions, recallBrief, saveTurn, startSession,
  type SaveTurnInput,
} from "../../src/agent/memory.js";
import { testGraph } from "../helpers/graph.js";
import { NOW } from "../helpers/agent.js";

// Spy on the projection cache's write counter (the real one still runs).
vi.mock("../../src/graph/projection.js", async (importOriginal) => {
  const m = await importOriginal<typeof import("../../src/graph/projection.js")>();
  return { ...m, noteGraphWrite: vi.fn(m.noteGraphWrite) };
});

const CHECKS: TurnChecks = { citationsValid: true, invalidCitations: [], numbersGrounded: true, ungroundedNumbers: [], simulatedDisclosed: true, freshnessDisclosed: true };

describe("memory (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  const count = async (cypher: string, params?: Record<string, unknown>) => (await g.roQuery<{ c: number }>(cypher, params))[0]!.c;

  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await ensureIndexes(g);
    const s = await writeBatch(g, {
      nodes: [
        { type: "Business", id: "business:test", name: "Test Co" },
        { type: "Metric", id: "metric:signups", name: "Signups" },
        { type: "System", id: "system:sitemap", name: "Sitemap" },
        { type: "Decision", id: "decision:pause-stories", name: "Pause daily stories" },
        { type: "Memory", id: "memory:signups-note", name: "Signups note", props: { kind: "note", text: "Signups count only verified employers." } },
        { type: "Memory", id: "memory:pref-brief", name: "Brevity", props: { kind: "preference", text: "Keep answers under five bullets." } },
        { type: "Recommendation", id: "recommendation:fix-sitemap", name: "Fix the sitemap", props: { status: "open" } },
        { type: "Approval", id: "approval:fix-sitemap", name: "Approve: fix the sitemap", props: { status: "pending" } },
        { type: "Recommendation", id: "recommendation:old", name: "Old idea", props: { status: "rejected" } },
      ],
      edges: [
        { from: "memory:signups-note", type: "ABOUT", to: "metric:signups" },
        { from: "recommendation:fix-sitemap", type: "BASED_ON", to: "metric:signups" },
        { from: "recommendation:fix-sitemap", type: "PROPOSES", to: "approval:fix-sitemap" },
        { from: "recommendation:old", type: "BASED_ON", to: "metric:signups" },
      ],
    }, NOW - 86_400_000);
    expect(s.errors).toEqual([]);
  });
  afterAll(async () => {
    await cleanup();
    await closeAll();
  });

  it("ensureRoster writes every agent and department, MEMBER_OF its team, and is idempotent", async () => {
    await ensureRoster(g, { businessId: "business:test" }, NOW);
    const snapshot = async () => ({
      agents: await count("MATCH (a:Agent) RETURN count(a) AS c"),
      teams: await count("MATCH (t:Team) RETURN count(t) AS c"),
      member: await count("MATCH (:Agent)-[r:MEMBER_OF]->(:Team) RETURN count(r) AS c"),
      partOf: await count("MATCH (:Team)-[r:PART_OF]->(:Business) RETURN count(r) AS c"),
    });
    const first = await snapshot();
    expect(first).toEqual({ agents: AGENTS.length, teams: DEPARTMENTS.length, member: AGENTS.length, partOf: DEPARTMENTS.length });
    await ensureRoster(g, { businessId: "business:test" }, NOW + 1000);
    expect(await snapshot()).toEqual(first);
    const [kabir] = await g.roQuery<Record<string, unknown>>(
      "MATCH (a:Agent {id:'agent:allevia-data-analyst'})-[:MEMBER_OF]->(t:Team) RETURN a.name AS name, a.title AS title, a.department AS department, t.id AS team");
    expect(kabir).toEqual({ name: "Kabir", title: "Data Analyst", department: "analytics", team: "team:allevia-analytics" });
  });

  let firstTurn: SaveTurnInput;

  it("saveTurn writes the Turn, its edges, Findings, reviews and grows KNOWS_ABOUT", async () => {
    const session = await startSession(g, { channel: "web", asker: "person:founder", title: "Why did signups drop?" }, NOW);
    expect(session.id).toMatch(/^session:2026-10-15-[0-9a-f]{8}$/);
    const events: AgentEvent[] = [
      { type: "session", tenant: "test", sessionId: session.id, turnId: "turn:a1", question: "Why did signups drop?" },
      { type: "text", agent: "chief-of-staff", delta: "Signups " },
      { type: "text", agent: "chief-of-staff", delta: "dropped." },
    ];
    firstTurn = {
      turnId: "turn:a1", sessionId: session.id, question: "Why did signups drop?", asker: "person:founder", at: NOW, ms: 1234,
      answer: "Signups dropped because the sitemap broke [[system:sitemap]] [[metric:signups]].",
      checks: CHECKS, agents: ["chief-of-staff", "data-analyst", "tech-lead", "coe-lead"], events,
      touched: ["metric:signups", "system:sitemap", "page:does-not-exist"],
      citations: ["system:sitemap", "metric:signups"],
      findings: [
        { id: "finding:a1-data-analyst", agent: "data-analyst", task: "Signups", text: "Signups fell [[metric:signups]].", citations: ["metric:signups"], basedOn: [], proposals: [], revised: false, rejected: false },
        { id: "finding:a1-tech-lead", agent: "tech-lead", task: "Site", text: "Sitemap broke [[system:sitemap]].", citations: ["system:sitemap", "page:does-not-exist"], basedOn: ["finding:a1-data-analyst"], proposals: ["Fix it"], revised: true, rejected: false },
      ],
      reviews: [{ reviewer: "coe-lead", findingId: "finding:a1-data-analyst", verdict: "fix", note: "Add the week." }],
    };
    const r = await saveTurn(g, firstTurn);
    expect(r.errors).toEqual([]);

    const [turn] = await g.roQuery<Record<string, unknown>>("MATCH (t:Turn {id:'turn:a1'}) RETURN t.question AS q, t.answer AS a, t.at AS at, t.status AS status, t.agents AS agents, t.checks AS checks, t.ms AS ms");
    expect(turn).toMatchObject({ q: "Why did signups drop?", at: NOW, status: "ok", agents: firstTurn.agents, ms: 1234 });
    expect(JSON.parse(String(turn!.checks))).toEqual(CHECKS);

    expect(await count("MATCH (:Turn {id:'turn:a1'})-[:IN_SESSION]->(:Session {id:$s}) RETURN count(*) AS c", { s: session.id })).toBe(1);
    expect(await count("MATCH (:Person {id:'person:founder'})-[:ASKED]->(:Turn {id:'turn:a1'}) RETURN count(*) AS c")).toBe(1);
    expect(await count("MATCH (:Turn {id:'turn:a1'})-[:HANDLED_BY]->(a:Agent) RETURN count(a) AS c")).toBe(4);
    expect((await g.roQuery<{ id: string }>("MATCH (:Turn {id:'turn:a1'})-[:TOUCHED]->(x) RETURN x.id AS id ORDER BY id")).map((x) => x.id)).toEqual(["metric:signups", "system:sitemap"]);
    expect(await count("MATCH (:Turn {id:'turn:a1'})-[:CITED]->(x) RETURN count(x) AS c")).toBe(2);

    expect(await count("MATCH (f:Finding)-[:PART_OF]->(:Turn {id:'turn:a1'}) RETURN count(f) AS c")).toBe(2);
    expect(await count("MATCH (:Agent {id:'agent:allevia-tech-lead'})-[:PRODUCED]->(:Finding {id:'finding:a1-tech-lead'}) RETURN count(*) AS c")).toBe(1);
    expect(await count("MATCH (:Finding {id:'finding:a1-tech-lead'})-[:CITED]->(x) RETURN count(x) AS c")).toBe(1); // missing page skipped
    expect(await count("MATCH (:Finding {id:'finding:a1-tech-lead'})-[:BASED_ON]->(:Finding {id:'finding:a1-data-analyst'}) RETURN count(*) AS c")).toBe(1);
    const [f] = await g.roQuery<Record<string, unknown>>("MATCH (f:Finding {id:'finding:a1-tech-lead'}) RETURN f.text AS text, f.agent AS agent, f.revised AS revised, f.proposals AS proposals");
    expect(f).toEqual({ text: "Sitemap broke [[system:sitemap]].", agent: "tech-lead", revised: true, proposals: ["Fix it"] });
    const [rev] = await g.roQuery<Record<string, unknown>>("MATCH (:Agent {id:'agent:allevia-coe-lead'})-[r:REVIEWED]->(:Finding {id:'finding:a1-data-analyst'}) RETURN r.verdict AS verdict, r.note AS note");
    expect(rev).toEqual({ verdict: "fix", note: "Add the week." });

    const [k] = await g.roQuery<Record<string, unknown>>("MATCH (:Agent {id:$a})-[r:KNOWS_ABOUT]->(:Metric {id:'metric:signups'}) RETURN r.weight AS w, r.since AS since", { a: agentNodeId("data-analyst") });
    expect(k).toEqual({ w: 1, since: NOW });
  });

  it("a second turn grows KNOWS_ABOUT weights, and re-saving the same turn does not", async () => {
    const second: SaveTurnInput = {
      ...firstTurn, turnId: "turn:a2", at: NOW + 60_000, question: "And now?",
      findings: [{ id: "finding:a2-data-analyst", agent: "data-analyst", task: "x", text: "Still down [[metric:signups]].", citations: ["metric:signups"], basedOn: [], proposals: [], revised: false, rejected: false }],
      reviews: [],
    };
    await saveTurn(g, second);
    await saveTurn(g, second);
    const w = await count("MATCH (:Agent {id:$a})-[r:KNOWS_ABOUT]->(:Entity {id:'metric:signups'}) RETURN r.weight AS c", { a: agentNodeId("data-analyst") });
    expect(w).toBe(2);
    expect(await count("MATCH (:Agent {id:$a})-[r:KNOWS_ABOUT]->(:Entity {id:'metric:signups'}) RETURN count(r) AS c", { a: agentNodeId("data-analyst") })).toBe(1);
  });

  it("the raw-Cypher writes (KNOWS_ABOUT growth, Session.lastAt) each tell the projection cache the graph changed", async () => {
    const own = await testGraph(); // its own graph, so the extra turn doesn't disturb the threads tested below
    const note = vi.mocked(noteGraphWrite);
    const query = vi.spyOn(own.g, "query");
    try {
      await writeBatch(own.g, { nodes: [{ type: "Metric", id: "metric:signups", name: "Signups" }] }, NOW);
      note.mockClear();
      await saveTurn(own.g, { ...firstTurn, sessionId: "session:raw-writes", reviews: [],
        findings: [{ id: "finding:a1-data-analyst", agent: "data-analyst", task: "x", text: "Down [[metric:signups]].", citations: ["metric:signups"], basedOn: [], proposals: [], revised: false, rejected: false }] });
      const raw = query.mock.calls.map((c, i) => ({ cypher: String(c[0]), order: query.mock.invocationCallOrder[i]! }));
      const knows = raw.find((r) => r.cypher.includes("KNOWS_ABOUT"));
      const lastAt = raw.find((r) => r.cypher.includes("s.lastAt"));
      expect(knows && lastAt).toBeTruthy();
      const noted = note.mock.calls.map((c, i) => ({ graph: c[0], order: note.mock.invocationCallOrder[i]! }));
      for (const w of [knows!, lastAt!]) {
        // a noteGraphWrite for this graph follows this raw write, before the next one
        const next = raw.find((r) => r.order > w.order)?.order ?? Infinity;
        expect(noted.some((n) => n.graph === own.g.name && n.order > w.order && n.order < next)).toBe(true);
      }
    } finally {
      query.mockRestore();
      await own.cleanup();
    }
  });

  it("a fast-path turn (no findings) grows the Chief's KNOWS_ABOUT from the answer's citations", async () => {
    await saveTurn(g, { ...firstTurn, turnId: "turn:a3", at: NOW + 120_000, findings: [], reviews: [], agents: ["chief-of-staff"], citations: ["decision:pause-stories"], answer: "Paused [[decision:pause-stories]].", touched: ["decision:pause-stories"] });
    expect(await count("MATCH (:Agent {id:$a})-[r:KNOWS_ABOUT]->(:Entity {id:'decision:pause-stories'}) RETURN r.weight AS c", { a: agentNodeId("chief-of-staff") })).toBe(1);
  });

  it("getTurnEvents returns the stored log with consecutive text deltas merged", async () => {
    const ev = await getTurnEvents(g, "turn:a1");
    expect(ev).toEqual([firstTurn.events[0], { type: "text", agent: "chief-of-staff", delta: "Signups dropped." }]);
    expect(await getTurnEvents(g, "turn:nope")).toBeNull();
    expect(compactEvents([{ type: "text", agent: "a", delta: "x" }, { type: "agent_status", agent: "a", text: "s" }, { type: "text", agent: "a", delta: "y" }])).toHaveLength(3);
  });

  it("recallBrief for a new session on the same entity brings back the earlier turn, notes, open work and preferences", async () => {
    const brief = await recallBrief(g, { question: "How are signups doing?", seedIds: ["metric:signups"] });
    expect(brief.ids).toContain("turn:a1");
    expect(brief.ids).toContain("memory:signups-note");
    expect(brief.ids).toContain("recommendation:fix-sitemap");
    expect(brief.ids).toContain("approval:fix-sitemap");
    expect(brief.ids).toContain("memory:pref-brief");
    expect(brief.ids).not.toContain("recommendation:old"); // rejected work is not "open"
    expect(brief.text).toContain("[[turn:a1]]");
    expect(brief.text).toContain("Why did signups drop?");
    expect(brief.text).not.toContain("[[system:sitemap]]"); // earlier answers' citations are stripped (not citable now)
    expect(brief.text).toContain("Keep answers under five bullets.");
    expect(brief.text.length).toBeLessThanOrEqual(6_000);
    expect(brief.nodes?.find((n) => n.id === "turn:a1")).toMatchObject({ label: "Turn" });
  });

  it("recallBrief includes this thread's earlier turns when continuing a session, and only preferences when nothing is known", async () => {
    const turn = (await g.roQuery<{ s: string }>("MATCH (:Turn {id:'turn:a1'})-[:IN_SESSION]->(s:Session) RETURN s.id AS s"))[0]!;
    const brief = await recallBrief(g, { question: "and?", seedIds: [], sessionId: turn.s });
    expect(brief.text).toContain("This thread so far");
    expect(brief.ids).toContain("turn:a1");
    const empty = await recallBrief(g, { question: "x", seedIds: ["nothing:here"] });
    expect(empty.ids).toEqual(["memory:pref-brief"]); // preferences always come along
  });

  it("failed turns are stored but not recalled", async () => {
    await saveTurn(g, { ...firstTurn, turnId: "turn:bad", at: NOW + 200_000, status: "failed", error: "boom", answer: "", findings: [], reviews: [], checks: undefined });
    const [t] = await g.roQuery<Record<string, unknown>>("MATCH (t:Turn {id:'turn:bad'}) RETURN t.status AS s, t.error AS e");
    expect(t).toEqual({ s: "failed", e: "boom" });
    const brief = await recallBrief(g, { question: "x", seedIds: ["metric:signups"] });
    expect(brief.ids).not.toContain("turn:bad");
  });

  it("getSession and listSessions show threads with their turns, newest activity first", async () => {
    const s2 = await startSession(g, { channel: "discord", asker: "person:founder", title: "Second thread" }, NOW + 300_000);
    await saveTurn(g, { ...firstTurn, sessionId: s2.id, turnId: "turn:b1", at: NOW + 310_000, question: "Second?", findings: [], reviews: [] });
    const list = await listSessions(g);
    expect(list[0]).toMatchObject({ id: s2.id, channel: "discord", title: "Second thread", turnCount: 1, lastAt: NOW + 310_000 });
    const first = list.find((s) => s.id !== s2.id)!;
    expect(first.turnCount).toBe(4); // a1, a2, a3, bad: all in the first session
    const detail = await getSession(g, first.id);
    expect(detail?.turns.map((t) => t.id)).toEqual(["turn:a1", "turn:a2", "turn:a3", "turn:bad"]);
    expect(detail?.turns[0]).toMatchObject({ question: "Why did signups drop?", status: "ok", checks: CHECKS });
    expect(await getSession(g, "session:none")).toBeNull();
  });

  it("saveTurn creates a missing session and a missing person asker instead of failing", async () => {
    const r = await saveTurn(g, { ...firstTurn, sessionId: "session:discord-123", asker: "person:guest", turnId: "turn:c1", at: NOW + 400_000, findings: [], reviews: [] });
    expect(r.errors).toEqual([]);
    expect(await count("MATCH (:Person {id:'person:guest'})-[:ASKED]->(:Turn {id:'turn:c1'})-[:IN_SESSION]->(:Session {id:'session:discord-123'}) RETURN count(*) AS c")).toBe(1);
  });
});
