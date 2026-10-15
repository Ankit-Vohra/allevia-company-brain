import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { z } from "zod";
import type { AgentEvent } from "../../shared/contracts.js";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { writeBatch } from "../../src/graph/upsert.js";
import { ask, type AskDeps } from "../../src/agent/ask.js";
import { compactEvents, getSession, getTurnEvents } from "../../src/agent/memory.js";
import { FakeRuntime, type FakeScript } from "../../src/agent/runtime.js";
import type { AlleviaTool } from "../../src/agent/tool.js";
import { testGraph } from "../helpers/graph.js";
import { fakeTool, recorder, result, NOW } from "../helpers/agent.js";

const signups = result({
  data: { metric: "signups", points: [{ week: "2026-10-05", value: 41 }, { week: "2026-09-28", value: 55 }] },
  nodes: [{ id: "metric:signups", label: "Metric", name: "Signups", asOf: "2026-10-06" }],
});
const tools: Record<string, AlleviaTool> = {
  metric_trend: fakeTool("metric_trend", signups),
  get_entity: fakeTool("get_entity", result({ data: { status: "broken" }, nodes: [{ id: "system:sitemap", label: "System", name: "Sitemap" }] })),
  show_path: fakeTool("show_path", (a) => result({ data: {}, nodes: (a.ids as string[]).map((id) => ({ id, label: "Entity", name: id })) }), { ids: z.array(z.string()) }),
};
const getTools = (names: string[]) => names.map((n) => tools[n]).filter((t): t is AlleviaTool => !!t);

const deskScripts: Record<string, FakeScript> = {
  "chief-of-staff:plan": { structured: { steps: [{ agent: "data-analyst", task: "Explain the signups trend" }], rationale: "A numbers question" } },
  "data-analyst": { calls: [{ name: "metric_trend", args: { metric: "signups" } }], structured: { text: "Signups fell from 55 to 41 in the week to 2026-10-05 [[metric:signups]].", citations: ["metric:signups"] } },
  "coe-lead": { structured: { verdict: "ok", note: "Figures match." } },
  "fact-checker": { structured: { verdict: "ok", note: "Supported." } },
  "chief-of-staff:synthesis": {
    calls: [{ name: "show_path", args: { ids: ["metric:signups"] } }],
    text: "Signups fell to 56 in the week to 2026-10-05 [[metric:signups]], as of 2026-10-06. Next: check the sitemap.",
  },
};

describe("ask() (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  const count = async (cypher: string, params?: Record<string, unknown>) => (await g.roQuery<{ c: number }>(cypher, params))[0]!.c;
  let clock = NOW;
  const deps = (scripts: Record<string, FakeScript>, over: Partial<AskDeps> = {}): AskDeps =>
    ({ runtime: new FakeRuntime(scripts), getTools, graph: g, now: () => (clock += 60_000), seedSearch: async () => ["metric:signups"], ...over });

  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await ensureIndexes(g);
    const s = await writeBatch(g, { nodes: [
      { type: "Metric", id: "metric:signups", name: "Signups", asOf: "2026-10-06" },
      { type: "System", id: "system:sitemap", name: "Sitemap" },
    ] }, NOW);
    expect(s.errors).toEqual([]);
  });
  afterAll(async () => {
    await cleanup();
    await closeAll();
  });

  let first: { turnId: string; sessionId: string };

  it("emits session -> recall -> plan -> work -> final, flags a fabricated number, and persists the turn", async () => {
    const { events, emit } = recorder();
    const r = await ask({ tenant: "test", question: "Why did signups drop?", channel: "cli" }, deps(deskScripts), emit);
    first = r;

    expect(events[0]).toEqual({ type: "session", tenant: "test", sessionId: r.sessionId, turnId: r.turnId, question: "Why did signups drop?" });
    expect(events[1]).toMatchObject({ type: "recall" });
    expect(events.findIndex((e) => e.type === "plan")).toBeGreaterThan(1);
    expect(events.at(-1)).toEqual({ type: "final", turnId: r.turnId, answer: r.answer, citations: ["metric:signups"], checks: r.checks, agents: r.agents, ms: r.ms });
    expect(events.filter((e) => e.type === "final")).toHaveLength(1);
    expect(r.sessionId).toMatch(/^session:/);
    expect(r.turnId).toMatch(/^turn:2026-10-15-/);

    expect(r.ok).toBe(true);
    expect(r.checks).toEqual({ citationsValid: true, invalidCitations: [], numbersGrounded: false, ungroundedNumbers: ["56"], simulatedDisclosed: true, freshnessDisclosed: true });
    expect(r.agents).toEqual(["chief-of-staff", "data-analyst", "coe-lead"]); // its numbers checked out: one numbers reviewer

    // persisted: the Turn, its session, the full event log (text deltas merged), findings and reviews
    const stored = await getTurnEvents(g, r.turnId);
    expect(stored).toEqual(compactEvents(events));
    const session = await getSession(g, r.sessionId);
    expect(session).toMatchObject({ channel: "cli", asker: "person:founder", title: "Why did signups drop?" });
    expect(session!.turns).toHaveLength(1);
    expect(session!.turns[0]).toMatchObject({ id: r.turnId, status: "ok", checks: r.checks });
    expect(await count("MATCH (:Turn {id:$t})-[:HANDLED_BY]->(a:Agent) RETURN count(a) AS c", { t: r.turnId })).toBe(3);
    expect(await count("MATCH (:Turn {id:$t})-[:TOUCHED]->(:Metric {id:'metric:signups'}) RETURN count(*) AS c", { t: r.turnId })).toBe(1);
    expect(await count("MATCH (f:Finding)-[:PART_OF]->(:Turn {id:$t}) RETURN count(f) AS c", { t: r.turnId })).toBe(1);
    expect(await count("MATCH (:Agent)-[r:REVIEWED]->(:Finding)-[:PART_OF]->(:Turn {id:$t}) RETURN count(r) AS c", { t: r.turnId })).toBe(1);
    expect(await count("MATCH (:Agent {id:'agent:allevia-data-analyst'})-[r:KNOWS_ABOUT]->(:Metric {id:'metric:signups'}) RETURN r.weight AS c")).toBe(1);
  });

  it("a new thread on the same entity recalls the first turn; a reply continues its thread", async () => {
    const a = recorder();
    const r2 = await ask({ tenant: "test", question: "How are signups now?", channel: "web" }, deps(deskScripts), a.emit);
    expect(r2.sessionId).not.toBe(first.sessionId);
    const recall = a.events.find((e) => e.type === "recall") as Extract<AgentEvent, { type: "recall" }>;
    expect(recall.ids).toContain(first.turnId);
    expect(recall.brief).toContain("Why did signups drop?");

    const sessionsBefore = await count("MATCH (s:Session) RETURN count(s) AS c");
    const b = recorder();
    const r3 = await ask({ tenant: "test", question: "And the week before?", channel: "web", sessionId: r2.sessionId }, deps(deskScripts), b.emit);
    expect(r3.sessionId).toBe(r2.sessionId);
    expect(await count("MATCH (s:Session) RETURN count(s) AS c")).toBe(sessionsBefore);
    const brief = (b.events.find((e) => e.type === "recall") as Extract<AgentEvent, { type: "recall" }>).brief;
    expect(brief).toContain("This thread so far");
    expect(brief).toContain(`[[${r2.turnId}]]`);
    expect((await getSession(g, r2.sessionId))!.turns.map((t) => t.id)).toEqual([r2.turnId, r3.turnId]);
  });

  it("when the Chief cannot answer: an error event, final last, and the turn saved as failed", async () => {
    const { events, emit } = recorder();
    const r = await ask({ tenant: "test", question: "Why?", channel: "web" }, deps({ ...deskScripts, "chief-of-staff:synthesis": { fail: "overloaded" } }), emit);
    expect(r.ok).toBe(false);
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(events.at(-1)!.type).toBe("final");
    const [t] = await g.roQuery<Record<string, unknown>>("MATCH (t:Turn {id:$id}) RETURN t.status AS s, t.error AS e", { id: r.turnId });
    expect(t).toEqual({ s: "failed", e: "The Chief of Staff could not write the answer." });
  });

  it("never throws: a broken graph, an empty question or a throwing consumer still end with final", async () => {
    const down = { name: "allevia_down", query: async () => { throw new Error("connection refused"); }, roQuery: async () => { throw new Error("connection refused"); } } as unknown as GraphHandle;
    const a = recorder();
    const r = await ask({ tenant: "test", question: "Anything?", channel: "mcp" }, deps(deskScripts, { graph: down }), a.emit);
    expect(r.ok).toBe(false);
    expect(a.types()).toEqual(["session", "error", "error", "final"]);
    expect(a.events[1]).toMatchObject({ message: "connection refused" });
    expect(a.events[2]).toMatchObject({ message: "Could not save the turn: connection refused" });

    const b = recorder();
    const e = await ask({ tenant: "test", question: "   ", channel: "web" }, deps(deskScripts), b.emit);
    expect(e.ok).toBe(false);
    expect(b.events[1]).toMatchObject({ type: "error", message: "The question is empty." });

    let n = 0;
    const r2 = await ask({ tenant: "test", question: "Why did signups drop?", channel: "web" }, deps(deskScripts), () => { n++; throw new Error("socket closed"); });
    expect(r2.ok).toBe(true);
    expect(n).toBeGreaterThan(10);
    expect(await getTurnEvents(g, r2.turnId)).not.toBeNull();
  });

  it("passes the tenant's time zone to the prompts and the caller's signal to every run (a stopped turn is saved as failed)", async () => {
    const zoned = new FakeRuntime(deskScripts);
    await ask({ tenant: "test", question: "Why did signups drop?", channel: "web" }, deps({}, { runtime: zoned, timeZone: "America/New_York" }), () => {});
    const work = zoned.runs.find((r) => r.phase === "work")!;
    expect(work.system).toMatch(/Today is 2026-10-1\d \(\d\d Oct 2026, \d\d:\d\d (?:GMT-4|EDT)\)/);

    const stopped = new AbortController();
    stopped.abort();
    const runtime = new FakeRuntime(deskScripts);
    const a = recorder();
    const r = await ask({ tenant: "test", question: "Why did signups drop?", channel: "web" }, deps({}, { runtime, signal: stopped.signal }), a.emit);
    expect(r.ok).toBe(false);
    expect(runtime.runs).toHaveLength(0); // nothing was started
    expect(a.events.at(-1)!.type).toBe("final");
    const [t] = await g.roQuery<Record<string, unknown>>("MATCH (t:Turn {id:$id}) RETURN t.status AS s, t.error AS e", { id: r.turnId });
    expect(t).toEqual({ s: "failed", e: "Stopped before the answer was finished." }); // a stop, not a Chief failure
  });
});
