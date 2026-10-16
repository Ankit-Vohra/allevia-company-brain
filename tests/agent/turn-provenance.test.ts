// Provenance of what a turn writes (graph audit G10): the src of a card or a memory is the turn id (not "turn:turn:…"), the Turn and
// its Findings and every edge saveTurn writes carry src and asOf, and what a turn's tools made is SOURCED_FROM that Turn.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { writeBatch } from "../../src/graph/upsert.js";
import { ask, type AskDeps } from "../../src/agent/ask.js";
import { saveTurn } from "../../src/agent/memory.js";
import { FakeRuntime, type FakeScript } from "../../src/agent/runtime.js";
import { TouchedSet, type AlleviaTool } from "../../src/agent/tool.js";
import { proposeAction } from "../../src/agent/tools/actions.js";
import { remember } from "../../src/agent/tools/memory.js";
import { testGraph } from "../helpers/graph.js";
import { fakeTool, result, NOW } from "../helpers/agent.js";
import { call, makeCtx } from "../helpers/tools.js";

describe("provenance of what a turn writes", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  const rows = <T,>(cypher: string, params?: Record<string, unknown>) => g.roQuery<T>(cypher, params);

  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await ensureIndexes(g);
    const s = await writeBatch(g, {
      nodes: [
        { type: "Decision", id: "decision:pause-stories", name: "Pause daily stories", asOf: "2026-10-01" },
        { type: "Channel", id: "channel:instagram", name: "Instagram" },
        { type: "Metric", id: "metric:signups", name: "Signups", asOf: "2026-10-06" },
        { type: "Rule", id: "rule:no-hype", name: "No hype words", props: { kind: "voice", text: "No hype words." } },
        { type: "Memory", id: "memory:owner-note", name: "Owner note", props: { kind: "instruction", text: "Be brief." } },
      ],
      edges: [{ from: "decision:pause-stories", type: "AFFECTS", to: "channel:instagram" }],
    }, NOW - 86_400_000);
    expect(s.errors).toEqual([]);
  });
  afterAll(async () => { await cleanup(); await closeAll(); });

  it("propose_action and remember stamp src = the turn id as it is: no turn:turn: prefix on the nodes or their edges", async () => {
    const turn = "turn:2026-10-15-cafe0001";
    const ctx = makeCtx(g, { turnId: turn, agentId: "chief-of-staff", embedQuery: undefined as never });
    const p = await call(proposeAction, {
      title: "Restart the stories after Diwali", why: "The pause was meant to end then.", kind: "discord_post", payload: { body: "Stories are back." },
      evidence: ["decision:pause-stories"],
    }, ctx);
    expect(p.data.approvalId).toBe(`approval:${turn}-1`);
    const m = await call(remember, { text: "Stories stay paused until Diwali", kind: "fact", about: ["decision:pause-stories"] }, ctx);
    const memId = m.data.id as string;
    const nodes = await rows<{ id: string; src: string }>("MATCH (n:Entity) WHERE n.id IN $ids RETURN n.id AS id, n.src AS src ORDER BY id", { ids: [p.data.recommendationId, p.data.approvalId, memId] });
    expect(nodes.map((n) => n.src)).toEqual([turn, turn, turn]);
    const edges = await rows<{ t: string; src: string }>(
      `MATCH (a:Entity)-[e:PROPOSES|EVIDENCED_BY|PRODUCED|ABOUT|STATED]->(b:Entity) WHERE e.src STARTS WITH 'turn:' AND ID(e) >= 0 RETURN type(e) AS t, e.src AS src`);
    expect(new Set(edges.map((e) => e.t))).toEqual(new Set(["PROPOSES", "EVIDENCED_BY", "PRODUCED", "ABOUT"])); // no STATED: this graph has no person:founder
    expect(edges.every((e) => e.src === turn)).toBe(true);
    expect(await rows("MATCH (n:Entity) WHERE n.src STARTS WITH 'turn:turn:' RETURN n.id AS id")).toEqual([]);
  });

  it("saveTurn: the Turn and its Findings carry src (the turn) and asOf; so does every edge it writes", async () => {
    const turn = "turn:2026-10-15-cafe0002";
    const touched = new TouchedSet();
    touched.add(result({ data: {}, nodes: [{ id: "metric:signups", label: "Metric", name: "Signups" }, { id: "channel:instagram", label: "Channel", name: "Instagram" }, { id: "rule:no-hype", label: "Rule", name: "No hype" }] }));
    const r = await saveTurn(g, {
      turnId: turn, sessionId: "session:2026-10-15-cafe0002", question: "How are signups?", answer: "Signups are up [[metric:signups]].", asker: "person:founder", at: NOW,
      agents: ["data-analyst", "coe-lead"], events: [], touched, citations: ["metric:signups"], guidedBy: ["memory:owner-note"],
      findings: [
        { id: "finding:2026-10-15-cafe0002-data-analyst", agent: "data-analyst", task: "Signups", text: "Up [[metric:signups]].", citations: ["metric:signups"], basedOn: [], proposals: [], revised: false, rejected: false, guidedBy: ["rule:no-hype"] },
        { id: "finding:2026-10-15-cafe0002-coe-lead", agent: "coe-lead", task: "Check", text: "Fine.", citations: ["channel:instagram"], basedOn: ["finding:2026-10-15-cafe0002-data-analyst"], proposals: [], revised: false, rejected: false },
      ],
      reviews: [{ reviewer: "coe-lead", findingId: "finding:2026-10-15-cafe0002-data-analyst", verdict: "ok", note: "ok" }],
      pathIds: ["metric:signups", "channel:instagram"],
    });
    expect(r.errors).toEqual([]);
    const [t] = await rows<{ src: string; asOf: string }>("MATCH (t:Turn {id:$id}) RETURN t.src AS src, t.asOf AS asOf", { id: turn });
    expect(t).toEqual({ src: turn, asOf: "2026-10-15" });
    const f = await rows<{ src: string; asOf: string }>("MATCH (f:Finding)-[:PART_OF]->(:Turn {id:$id}) RETURN f.src AS src, f.asOf AS asOf", { id: turn });
    expect(f).toEqual([{ src: turn, asOf: "2026-10-15" }, { src: turn, asOf: "2026-10-15" }]);
    // every one of these edge types that the turn wrote has src and asOf (none without)
    const types = ["TOUCHED", "CITED", "HANDLED_BY", "PRODUCED", "REVIEWED", "GUIDED_BY", "BASED_ON", "PART_OF"];
    for (const type of types) {
      const [c] = await rows<{ n: number; stamped: number }>(
        `MATCH (a:Entity)-[e:${type}]->(b:Entity) WHERE (a.id = $t OR b.id = $t OR a.id STARTS WITH 'finding:2026-10-15-cafe0002' OR (a:Agent AND b.id STARTS WITH 'finding:2026-10-15-cafe0002'))
         AND ID(e) >= 0 RETURN count(e) AS n, sum(CASE WHEN e.src = $t AND e.asOf = '2026-10-15' THEN 1 ELSE 0 END) AS stamped`, { t: turn });
      expect(c!.n, `${type} edges written`).toBeGreaterThan(0);
      expect(c!.stamped, `${type} edges stamped`).toBe(c!.n);
    }
    // the edge still starts when the turn did, not at midnight of its date
    const [since] = await rows<{ since: number }>("MATCH (:Turn {id:$t})-[e:TOUCHED]->(:Metric {id:'metric:signups'}) RETURN e.since AS since", { t: turn });
    expect(since!.since).toBe(NOW);
  });

  // ---- a real turn through ask(): what its tools made is SOURCED_FROM the Turn ----

  const lookup = fakeTool("get_entity", result({ data: { found: true }, nodes: [
    { id: "decision:pause-stories", label: "Decision", name: "Pause daily stories" }, { id: "channel:instagram", label: "Channel", name: "Instagram" },
  ] }));
  const tools: Record<string, AlleviaTool> = { get_entity: lookup, propose_action: proposeAction, remember };
  const getTools = (names: string[]) => names.map((n) => tools[n]).filter((t): t is AlleviaTool => !!t);
  const scripts = (title: string): Record<string, FakeScript> => ({
    "chief-of-staff:plan": { structured: { steps: [{ agent: "chief-of-staff", task: "Do what the owner asked" }], rationale: "one desk" } },
    "chief-of-staff": {
      calls: [
        { name: "get_entity", args: { id: "decision:pause-stories" } },
        { name: "propose_action", args: { title, why: "The pause was meant to end then.", kind: "discord_post", payload: { body: "Stories are back." }, evidence: ["decision:pause-stories"] } },
        { name: "remember", args: { text: "Stories stay paused until Diwali", kind: "fact", about: ["decision:pause-stories"] } },
      ],
      text: "Done: stories stay paused until Diwali [[decision:pause-stories]].",
    },
  });
  const deps = (title: string, at: number): AskDeps => ({ runtime: new FakeRuntime(scripts(title)), getTools, graph: g, now: () => at });

  it("a card and a memory the turn made are SOURCED_FROM its Turn; a card it only reused is not", async () => {
    const q = "Remember that stories stay paused until Diwali, and propose we restart them then";
    const first = await ask({ tenant: "t", question: q, channel: "cli" }, deps("Restart stories after Diwali", NOW + 1000), () => {});
    expect(first.ok).toBe(true);
    expect(first.outcome?.proposals.length).toBe(1);
    const made = await rows<{ label: string; id: string }>(
      `MATCH (n:Entity)-[s:SOURCED_FROM]->(t:Turn {id:$t}) WHERE ID(s) >= 0 RETURN head([l IN labels(n) WHERE l <> 'Entity' AND l <> 'Searchable']) AS label, n.id AS id ORDER BY label, id`, { t: first.turnId });
    expect(made.map((m) => m.label)).toEqual(["Approval", "Memory", "Recommendation"]);
    expect(made.find((m) => m.label === "Memory")!.id).toBe(`memory:${first.turnId}-1`);
    const [edge] = await rows<{ src: string; asOf: string }>("MATCH (:Recommendation)-[s:SOURCED_FROM]->(:Turn {id:$t}) RETURN s.src AS src, s.asOf AS asOf", { t: first.turnId });
    expect(edge).toEqual({ src: first.turnId, asOf: "2026-10-15" });

    // the same card proposed again in a later turn (it is still waiting) is reused: the new turn did not make it
    const again = await ask({ tenant: "t", question: q, channel: "cli" }, deps("Restart stories after Diwali", NOW + 2000), () => {});
    expect(again.outcome?.proposals.length).toBe(1);
    const second = await rows<{ label: string }>(
      `MATCH (n:Entity)-[s:SOURCED_FROM]->(t:Turn {id:$t}) WHERE ID(s) >= 0 RETURN head([l IN labels(n) WHERE l <> 'Entity' AND l <> 'Searchable']) AS label, n.id AS id ORDER BY label, id`, { t: again.turnId });
    expect(second.map((m) => m.label)).toEqual(["Memory"]); // its own memory only
    expect((await rows<{ c: number }>("MATCH (:Recommendation)-[s:SOURCED_FROM]->(:Turn) WHERE ID(s) >= 0 RETURN count(s) AS c"))[0]!.c).toBe(1);
  });
});
