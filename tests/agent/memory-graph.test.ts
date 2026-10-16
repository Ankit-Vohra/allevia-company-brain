// Memory as a graph (graph audit G18): a Turn is embedded, so an earlier question can be found by meaning; `remember` makes a
// changed preference or fact SUPERSEDE the old one (so there are not two active); a proposal made in chat ADVANCES the goal it moves.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes, VECTOR_DIM } from "../../src/graph/indexes.js";
import { writeBatch } from "../../src/graph/upsert.js";
import { ask, type AskDeps } from "../../src/agent/ask.js";
import { recallBrief, saveTurn } from "../../src/agent/memory.js";
import { FakeRuntime, type FakeScript } from "../../src/agent/runtime.js";
import type { AlleviaTool } from "../../src/agent/tool.js";
import { proposeAction } from "../../src/agent/tools/actions.js";
import { changesTheSame, recall, remember } from "../../src/agent/tools/memory.js";
import { fakeEmbed } from "../fixtures/seed-graph.js";
import { testGraph } from "../helpers/graph.js";
import { fakeTool, result, NOW } from "../helpers/agent.js";
import { call, makeCtx } from "../helpers/tools.js";

describe("Turns are embedded: earlier questions are found by meaning", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  const rows = <T>(q: string, p: Record<string, unknown> = {}) => g.roQuery<T>(q, p);

  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await ensureIndexes(g);
    await writeBatch(g, { nodes: [{ type: "Channel", id: "channel:instagram", name: "Instagram" }] }, NOW - 86_400_000);
  });
  afterAll(async () => { await cleanup(); await closeAll(); });

  const tools: Record<string, AlleviaTool> = { get_entity: fakeTool("get_entity", result({ data: {}, nodes: [{ id: "channel:instagram", label: "Channel", name: "Instagram" }] })) };
  const scripts: Record<string, FakeScript> = {
    "chief-of-staff:plan": { structured: { steps: [{ agent: "chief-of-staff", task: "Answer" }], rationale: "one desk" } },
    "chief-of-staff": { calls: [{ name: "get_entity", args: { id: "channel:instagram" } }], text: "Signups dropped because of the connector [[channel:instagram]]." },
  };
  const deps = (over: Partial<AskDeps>): AskDeps => ({ runtime: new FakeRuntime(scripts), getTools: (n) => n.map((x) => tools[x]).filter((t): t is AlleviaTool => !!t), graph: g, now: () => NOW, ...over });

  it("ask() saves the question's vector on the Turn, and the vector index finds the Turn by it", async () => {
    const q = "Why did our signups drop last week";
    const r = await ask({ tenant: "t", question: q, channel: "cli" }, deps({ embedQuery: async (t) => fakeEmbed(t) }), () => {});
    expect(r.ok).toBe(true);
    const [t] = await rows<{ has: boolean }>("MATCH (t:Turn {id:$id}) RETURN t.embedding IS NOT NULL AS has", { id: r.turnId });
    expect(t!.has).toBe(true);
    const near = await rows<{ id: string; score: number }>(
      `CALL db.idx.vector.queryNodes('Searchable', 'embedding', 5, vecf32($v)) YIELD node, score WITH node, score WHERE node:Turn RETURN node.id AS id, score ORDER BY score ASC, id`, { v: fakeEmbed(q) });
    expect(near[0]!.id).toBe(r.turnId);
    expect(near[0]!.score).toBeLessThan(0.01);
  });

  it("no embedder, a broken one or a wrong-sized vector: the Turn is saved all the same, without a vector", async () => {
    const cases: Array<[string, Partial<AskDeps>]> = [
      ["no embedder", {}],
      ["an embedder that throws", { embedQuery: async () => { throw new Error("model missing"); } }],
      ["a vector of the wrong size", { embedQuery: async () => [0.1, 0.2, 0.3] }],
    ];
    for (const [i, [why, over]] of cases.entries()) {
      const r = await ask({ tenant: "t", question: `Question number ${i} about hours`, channel: "cli" }, deps(over), () => {});
      expect(r.ok, why).toBe(true);
      const [t] = await rows<{ has: boolean; ok: string }>("MATCH (t:Turn {id:$id}) RETURN t.embedding IS NOT NULL AS has, t.status AS ok", { id: r.turnId });
      expect(t, why).toEqual({ has: false, ok: "ok" });
    }
  });

  it("recall finds an earlier question by meaning when the words do not match (a Turn whose own words say nothing of it)", async () => {
    // saved with the vector of the question it answered, under a name and an answer that share no word with the query
    await saveTurn(g, {
      turnId: "turn:2026-10-14-vec00001", sessionId: "session:2026-10-14-vec00001", question: "Numbers for the quarter", answer: "Flat.", asker: "person:founder", at: NOW - 86_400_000,
      agents: ["chief-of-staff"], events: [], touched: [], citations: [], findings: [], reviews: [], embedding: fakeEmbed("Why did our signups drop last week"),
    });
    const query = "Why did our signups drop last week please"; // the same question with a word added: close, not equal
    const withVec = await call(recall, { query }, makeCtx(g, { embedQuery: async (t) => fakeEmbed(t) }));
    expect(withVec.data.turns.map((t: { id: string }) => t.id)).toContain("turn:2026-10-14-vec00001");
    const noVec = await call(recall, { query }, makeCtx(g, { embedQuery: undefined as never }));
    expect(noVec.data.turns.map((t: { id: string }) => t.id)).not.toContain("turn:2026-10-14-vec00001");
    // an unrelated question does not pull it in
    const other = await call(recall, { query: "Pause the daily stories until Diwali" }, makeCtx(g, { embedQuery: async (t) => fakeEmbed(t) }));
    expect(other.data.turns.map((t: { id: string }) => t.id)).not.toContain("turn:2026-10-14-vec00001");
    expect(VECTOR_DIM).toBe(384);
  });
});

describe("remember: a changed preference replaces the old one", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  const rows = <T>(q: string, p: Record<string, unknown> = {}) => g.roQuery<T>(q, p);
  const ctxAt = (n: number) => makeCtx(g, { turnId: `turn:2026-10-15-mem0000${n}`, agentId: "chief-of-staff", embedQuery: undefined as never, now: NOW + n * 60_000 });
  const say = (n: number, text: string, kind: "preference" | "fact" | "instruction", about = ["decision:pause-stories"]) => call(remember, { text, kind, about }, ctxAt(n));

  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await ensureIndexes(g);
    await writeBatch(g, { nodes: [
      { type: "Decision", id: "decision:pause-stories", name: "Pause daily stories" },
      { type: "Channel", id: "channel:instagram", name: "Instagram" },
    ] }, NOW - 86_400_000);
  });
  afterAll(async () => { await cleanup(); await closeAll(); });

  it("the same subject said differently: the new note SUPERSEDES the old, with src and asOf; the old stays as history", async () => {
    const first = await say(1, "Stories stay paused until Diwali", "fact");
    expect(first.data.replaces).toBeUndefined();
    const second = await say(2, "Stories resume after Diwali", "fact");
    expect(second.data.replaces).toEqual([first.data.id]);
    expect(second.note).toMatch(/It replaces the earlier note/);
    const [e] = await rows<{ from: string; to: string; src: string; asOf: string }>(
      "MATCH (a:Memory)-[s:SUPERSEDES]->(b:Memory) WHERE s.until IS NULL RETURN a.id AS from, b.id AS to, s.src AS src, s.asOf AS asOf");
    expect(e).toEqual({ from: second.data.id, to: first.data.id, src: "turn:2026-10-15-mem00002", asOf: "2026-10-15" });
    // exactly one active note about it: recall (and the brief) show the new one, never the old
    const r = await call(recall, { ids: ["decision:pause-stories"] }, makeCtx(g));
    expect(r.data.memories.map((m: { id: string }) => m.id)).toEqual([second.data.id]);
    const brief = await recallBrief(g, { question: "stories", seedIds: ["decision:pause-stories"] });
    expect(brief.text).toContain(second.data.id);
    expect(brief.text).not.toContain(first.data.id);
    expect((await rows<{ c: number }>("MATCH (m:Memory {id:$id}) RETURN count(m) AS c", { id: first.data.id }))[0]!.c).toBe(1); // nothing deleted
  });

  it("a third change replaces only the one still active; the first is not touched again", async () => {
    const third = await say(3, "Stories stay off until Holi, after Diwali", "fact");
    const heads = await rows<{ id: string }>(
      "MATCH (m:Memory) WHERE m.kind = 'fact' OPTIONAL MATCH (n:Memory)-[s:SUPERSEDES]->(m) WHERE s.until IS NULL WITH m, count(n) AS newer WHERE newer = 0 RETURN m.id AS id ORDER BY id");
    expect(heads.map((h) => h.id)).toEqual([third.data.id]);
    expect(third.data.replaces).toHaveLength(1);
  });

  it("not a change: the same words again, another kind, or something else about the same entity", async () => {
    const pref = await say(4, "Prefer reels over stories for hiring posts", "preference", ["channel:instagram"]);
    const again = await say(5, "prefer reels over  stories for hiring posts", "preference", ["channel:instagram"]);
    expect(again.data.replaces).toBeUndefined(); // the same thing said again is not a change
    const other = await say(6, "Always post in the evening", "preference", ["channel:instagram"]);
    expect(other.data.replaces).toBeUndefined(); // another subject on the same entity
    const asFact = await say(7, "Reels beat stories for hiring posts", "fact", ["channel:instagram"]);
    expect(asFact.data.replaces).toBeUndefined(); // another kind
    const active = await rows<{ id: string }>(
      `MATCH (m:Memory)-[:ABOUT]->(:Channel {id:'channel:instagram'}) OPTIONAL MATCH (n:Memory)-[s:SUPERSEDES]->(m) WHERE s.until IS NULL
       WITH m, count(n) AS newer WHERE newer = 0 RETURN m.id AS id ORDER BY id`);
    expect(active.map((a) => a.id)).toEqual([pref.data.id, again.data.id, other.data.id, asFact.data.id].sort());
    // but a real change of that preference is
    const changed = await say(8, "Prefer stories over reels for hiring posts now", "preference", ["channel:instagram"]);
    expect(changed.data.replaces.sort()).toEqual([pref.data.id, again.data.id].sort());
  });

  it("changesTheSame: two shared words that are at least half of the shorter note, and not the same words", () => {
    expect(changesTheSame("Stories resume after Diwali", "Stories stay paused until Diwali")).toBe(true);
    expect(changesTheSame("Stories stay paused until Diwali", "stories  stay paused until diwali")).toBe(false);
    expect(changesTheSame("No emojis in captions", "Prices in rupees")).toBe(false);
    expect(changesTheSame("Prefer short captions", "Prefer evening posts")).toBe(false); // one shared word
  });
});

describe("propose_action in chat advances the goal it moves", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  const rows = <T>(q: string, p: Record<string, unknown> = {}) => g.roQuery<T>(q, p);
  const args = (title: string, evidence: string[], area?: string) => ({
    title, why: "Because the numbers say so.", kind: "discord_post" as const, payload: { body: "A message to post." }, evidence, ...(area ? { area } : {}),
  });

  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await ensureIndexes(g);
    await writeBatch(g, { nodes: [
      { type: "Metric", id: "metric:signups", name: "Signups", props: { key: "signups.weekly" } },
      { type: "Metric", id: "metric:reel-views", name: "Reel views", props: { key: "ig.reel_views" } },
      { type: "Goal", id: "goal:more-signups", name: "Get to 400 signups a week", props: { metricKey: "signups.weekly", status: "active" } },
      { type: "Goal", id: "goal:more-views", name: "Double the reel views", props: { metricKey: "ig.reel_views", status: "active" } },
      { type: "Channel", id: "channel:instagram", name: "Instagram" },
    ] }, NOW - 86_400_000);
  });
  afterAll(async () => { await cleanup(); await closeAll(); });

  it("the goal tracking a metric the card is evidenced by: Recommendation and Approval ADVANCES it", async () => {
    const r = await call(proposeAction, args("Fix the signup form", ["metric:signups"]), makeCtx(g, { turnId: "turn:2026-10-15-adv00001", agentId: "chief-of-staff" }));
    expect(r.data.advances).toEqual(["goal:more-signups"]);
    const ads = await rows<{ from: string; src: string }>("MATCH (a:Entity)-[e:ADVANCES]->(:Goal {id:'goal:more-signups'}) WHERE e.until IS NULL RETURN a.id AS from, e.src AS src ORDER BY from");
    expect(ads).toEqual([{ from: r.data.approvalId, src: "turn:2026-10-15-adv00001" }, { from: r.data.recommendationId, src: "turn:2026-10-15-adv00001" }]);
    expect(r.edges.filter((e: { type: string }) => e.type === "ADVANCES")).toHaveLength(1);
  });

  it("else the goals of its area; a card about nothing a goal tracks has none", async () => {
    const byArea = await call(proposeAction, args("Post a reel about the new menu", ["channel:instagram"], "content"), makeCtx(g, { turnId: "turn:2026-10-15-adv00002", agentId: "chief-of-staff" }));
    expect(byArea.data.advances).toEqual(["goal:more-views"]); // content -> the reel views goal
    const none = await call(proposeAction, args("Tidy the notes", ["channel:instagram"], "ops"), makeCtx(g, { turnId: "turn:2026-10-15-adv00003", agentId: "chief-of-staff" }));
    expect(none.data.advances).toBeUndefined();
    expect(await rows("MATCH (a:Approval {id:$id})-[e:ADVANCES]->() RETURN count(e) AS c", { id: none.data.approvalId })).toEqual([{ c: 0 }]);
  });

  it("a goal lookup that fails never fails the proposal", async () => {
    // a handle whose reads of goals fail; everything else (and `this`) stays the real handle's
    const broken = new Proxy(g, {
      get(target, prop) {
        if (prop === "roQuery") {
          return async (cypher: string, params?: Record<string, unknown>, opts?: { timeoutMs?: number }) => {
            if (/\(gl:Goal\)/.test(cypher)) throw new Error("goal read failed");
            return target.roQuery(cypher, params, opts);
          };
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const r = await call(proposeAction, args("Fix the signup form again", ["metric:signups"]), makeCtx(broken, { turnId: "turn:2026-10-15-adv00004", agentId: "chief-of-staff" }));
    expect(r.data.status).toBe("pending");
    expect(r.data.advances).toBeUndefined();
  });
});
