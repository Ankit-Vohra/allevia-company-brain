// "How we know" (graph audit G1): the path an answer shows is kept in the graph (Turn.pathIds, onPath/pathIndex on the TOUCHED
// edges, answersThrough), show_path only draws what a tool returned this turn, and a pair with no link is said and not drawn.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { writeBatch } from "../../src/graph/upsert.js";
import { ask, type AskDeps } from "../../src/agent/ask.js";
import { answersThrough, saveTurn } from "../../src/agent/memory.js";
import { pathIsGrounded } from "../../src/agent/orchestrator.js";
import { FakeRuntime, type FakeScript } from "../../src/agent/runtime.js";
import { TouchedSet, type AlleviaTool } from "../../src/agent/tool.js";
import { showPath } from "../../src/agent/tools/paths.js";
import { nodeDetail } from "../../src/server/reads.js";
import { testGraph } from "../helpers/graph.js";
import { fakeTool, result, NOW } from "../helpers/agent.js";
import { call, makeCtx } from "../helpers/tools.js";

describe("pathIsGrounded reads show_path's own result", () => {
  it("grounded only when something was drawn and nothing was refused, unknown, unlinked or unchecked; unknown for any other tool's data", () => {
    expect(pathIsGrounded({ ordered: ["a", "b"], links: [], unconnected: [], missing: [] })).toBe(true);
    expect(pathIsGrounded({ ordered: ["a", "b"], unconnected: [{ from: "b", to: "c" }], missing: [] })).toBe(false);
    expect(pathIsGrounded({ ordered: ["a"], refused: ["x"], unconnected: [], missing: [] })).toBe(false);
    expect(pathIsGrounded({ ordered: ["a"], missing: ["nope"] })).toBe(false);
    expect(pathIsGrounded({ ordered: ["a"], unchecked: [{ from: "a", to: "b" }] })).toBe(false);
    expect(pathIsGrounded({ ordered: [] })).toBe(false);
    expect(pathIsGrounded({})).toBeUndefined();
    expect(pathIsGrounded(null)).toBeUndefined();
  });
});

describe("How we know: the path under an answer is in the graph", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await ensureIndexes(g);
    const s = await writeBatch(g, {
      nodes: [
        { type: "Decision", id: "decision:pause-stories", name: "Pause daily stories", asOf: "2026-10-01" },
        { type: "Channel", id: "channel:instagram", name: "Instagram" },
        { type: "System", id: "system:ig-connector", name: "Instagram connector" },
        { type: "Product", id: "product:lonely", name: "A product nothing links to" },
        { type: "Metric", id: "metric:never-read", name: "A metric no tool returned" },
      ],
      edges: [
        { from: "decision:pause-stories", type: "AFFECTS", to: "channel:instagram" },
        { from: "channel:instagram", type: "DEPENDS_ON", to: "system:ig-connector" },
      ],
    }, NOW - 86_400_000);
    expect(s.errors).toEqual([]);
  });
  afterAll(async () => { await cleanup(); await closeAll(); });

  // A turn's context: ids in a `turn:` id are held to what the tools returned (ctx.touched).
  const turnCtx = (ids: string[]) => {
    const ctx = makeCtx(g, { turnId: "turn:2026-10-15-feed", touched: new TouchedSet() });
    ctx.touched.add(result({ data: {}, nodes: ids.map((id) => ({ id, label: "Entity", name: id })) }));
    return ctx;
  };

  it("show_path refuses an id no tool returned this turn, and says so in plain words", async () => {
    const r = await call(showPath, { ids: ["decision:pause-stories", "channel:instagram", "metric:never-read"] }, turnCtx(["decision:pause-stories", "channel:instagram"]));
    expect(r.data.ordered).toEqual(["decision:pause-stories", "channel:instagram"]);
    expect(r.data.refused).toEqual(["metric:never-read"]);
    expect(r.nodes.map((n: { id: string }) => n.id)).not.toContain("metric:never-read");
    expect(r.note).toMatch(/Left out of the path: metric:never-read \(no tool returned it this turn/);
  });

  it("the recall brief's ids count as seen (they are in ctx.touched before any tool runs)", async () => {
    const r = await call(showPath, { ids: ["decision:pause-stories", "channel:instagram"] }, turnCtx(["decision:pause-stories", "channel:instagram"]));
    expect(r.data.refused).toBeUndefined();
    expect(r.data.ordered).toEqual(["decision:pause-stories", "channel:instagram"]);
  });

  it("a path of ids nobody looked up draws nothing; a one-off call (no turn) is not held to a touched set", async () => {
    const none = await call(showPath, { ids: ["decision:pause-stories", "channel:instagram"] }, turnCtx([]));
    expect(none.nodes).toEqual([]);
    expect(none.data.refused).toEqual(["decision:pause-stories", "channel:instagram"]);
    const oneOff = await call(showPath, { ids: ["decision:pause-stories", "channel:instagram"] }, makeCtx(g)); // turnId "t-100", like MCP's "mcp-1"
    expect(oneOff.data.ordered).toEqual(["decision:pause-stories", "channel:instagram"]);
  });

  it("an id with no link within the hops is reported but NOT drawn as part of the path", async () => {
    const ids = ["decision:pause-stories", "channel:instagram", "product:lonely"];
    const r = await call(showPath, { ids }, turnCtx(ids));
    expect(r.data.unconnected).toEqual([{ from: "channel:instagram", to: "product:lonely" }]);
    expect(r.data.ordered).toEqual(["decision:pause-stories", "channel:instagram"]);
    expect(r.nodes.map((n: { id: string }) => n.id)).not.toContain("product:lonely");
    expect(r.note).toMatch(/Not linked in the records within 4 hops, so not drawn as part of the path \(say so in the answer\): channel:instagram -> product:lonely/);
    // an unlinked id at the front is left off too, and the linked ones after it are still drawn
    const front = ["product:lonely", "decision:pause-stories", "channel:instagram"];
    const f = await call(showPath, { ids: front }, turnCtx(front));
    expect(f.data.unconnected).toEqual([{ from: "product:lonely", to: "decision:pause-stories" }]);
    expect(f.data.ordered).toEqual(["decision:pause-stories", "channel:instagram"]);
    // ids that link to nothing in the list draw nothing, and the note says so
    const mid = ["decision:pause-stories", "product:lonely", "metric:never-read"];
    const m = await call(showPath, { ids: mid }, turnCtx(mid));
    expect(m.data.ordered).toEqual([]);
    expect(m.note).toMatch(/None of these records are linked to each other/);
  });

  // ---- saved with the Turn ----

  it("saveTurn keeps the path: Turn.pathIds, and onPath + pathIndex on the TOUCHED edge to each node on it", async () => {
    const r = await saveTurn(g, {
      turnId: "turn:2026-10-15-p1", sessionId: "session:2026-10-15-p1", question: "Why did we pause the stories?", answer: "Because of the connector.", asker: "person:founder", at: NOW,
      agents: ["chief-of-staff"], events: [], citations: [], findings: [], reviews: [],
      touched: ["decision:pause-stories", "channel:instagram", "system:ig-connector", "metric:never-read"],
      pathIds: ["decision:pause-stories", "channel:instagram", "system:ig-connector", "node:not-in-the-graph"], pathGrounded: true,
    });
    expect(r.errors).toEqual([]);
    const [t] = await g.roQuery<{ pathIds: string[]; grounded: boolean }>("MATCH (t:Turn {id:'turn:2026-10-15-p1'}) RETURN t.pathIds AS pathIds, t.pathGrounded AS grounded");
    expect(t).toEqual({ pathIds: ["decision:pause-stories", "channel:instagram", "system:ig-connector"], grounded: true });
    const rows = await g.roQuery<{ id: string; idx: number }>(
      "MATCH (:Turn {id:'turn:2026-10-15-p1'})-[r:TOUCHED]->(n) WHERE r.onPath = true RETURN n.id AS id, r.pathIndex AS idx ORDER BY idx, id");
    expect(rows).toEqual([{ id: "decision:pause-stories", idx: 0 }, { id: "channel:instagram", idx: 1 }, { id: "system:ig-connector", idx: 2 }]);
    // touched but not on the path: a TOUCHED edge with no onPath mark
    const [off] = await g.roQuery<{ on: boolean | null }>("MATCH (:Turn {id:'turn:2026-10-15-p1'})-[r:TOUCHED]->(:Metric {id:'metric:never-read'}) RETURN r.onPath AS on");
    expect(off!.on).toBeNull();
  });

  it("answersThrough lists the answers that walked through a node, newest first, with the question and where on the path", async () => {
    await saveTurn(g, {
      turnId: "turn:2026-10-16-p2", sessionId: "session:2026-10-16-p2", question: "Is the connector healthy?", answer: "Yes.", asker: "person:founder", at: NOW + 86_400_000,
      agents: ["chief-of-staff"], events: [], citations: [], findings: [], reviews: [],
      touched: ["channel:instagram", "system:ig-connector"], pathIds: ["channel:instagram", "system:ig-connector"],
    });
    const through = await answersThrough(g, "system:ig-connector");
    expect(through.map((a) => [a.turnId, a.question, a.pathIndex])).toEqual([
      ["turn:2026-10-16-p2", "Is the connector healthy?", 1],
      ["turn:2026-10-15-p1", "Why did we pause the stories?", 2],
    ]);
    expect(through[0]!.at).toBe(NOW + 86_400_000);
    expect(await answersThrough(g, "metric:never-read")).toEqual([]); // touched, never on a path
    expect((await answersThrough(g, "decision:pause-stories")).map((a) => a.turnId)).toEqual(["turn:2026-10-15-p1"]);
  });

  it("the node-detail API carries the answers that walked through the node", async () => {
    const d = await nodeDetail(g, "channel:instagram");
    expect(d!.answers!.map((a) => a.turnId)).toEqual(["turn:2026-10-16-p2", "turn:2026-10-15-p1"]);
    expect(d!.answers![0]).toMatchObject({ question: "Is the connector healthy?", pathIndex: 0 });
    expect((await nodeDetail(g, "product:lonely"))!.answers).toBeUndefined();
  });

  // ---- end to end: a turn through ask() with the real show_path ----

  it("ask() stores the path the real show_path drew: refused and unlinked ids are not on it", async () => {
    const lookup = fakeTool("get_entity", result({ data: { found: true }, nodes: [
      { id: "decision:pause-stories", label: "Decision", name: "Pause daily stories" }, { id: "channel:instagram", label: "Channel", name: "Instagram" },
      { id: "product:lonely", label: "Product", name: "Lonely" },
    ] }));
    const tools: Record<string, AlleviaTool> = { get_entity: lookup, show_path: showPath };
    const scripts: Record<string, FakeScript> = {
      "chief-of-staff:plan": { structured: { steps: [{ agent: "chief-of-staff", task: "Explain the pause" }], rationale: "one desk" } },
      "chief-of-staff": {
        calls: [
          { name: "get_entity", args: { id: "decision:pause-stories" } },
          { name: "show_path", args: { ids: ["decision:pause-stories", "channel:instagram", "product:lonely", "metric:never-read"] } },
        ],
        text: "We paused the stories on Instagram [[decision:pause-stories]]. Nothing in the records links the lonely product to it.",
      },
    };
    const events: Array<{ type: string }> = [];
    const deps: AskDeps = { runtime: new FakeRuntime(scripts), getTools: (names) => names.map((n) => tools[n]).filter((t): t is AlleviaTool => !!t), graph: g, now: () => NOW + 5000 };
    const r = await ask({ tenant: "t", question: "Why did we pause the stories?", channel: "cli" }, deps, (e) => events.push(e));
    expect(r.ok).toBe(true);
    expect(r.outcome?.path?.nodes.map((n) => n.id)).toEqual(["decision:pause-stories", "channel:instagram"]);
    expect(r.outcome?.pathGrounded).toBe(false); // an id was refused and one pair has no link
    const [t] = await g.roQuery<{ pathIds: string[]; grounded: boolean }>("MATCH (t:Turn {id:$id}) RETURN t.pathIds AS pathIds, t.pathGrounded AS grounded", { id: r.turnId });
    expect(t).toEqual({ pathIds: ["decision:pause-stories", "channel:instagram"], grounded: false });
    const on = await g.roQuery<{ id: string; idx: number }>("MATCH (:Turn {id:$id})-[r:TOUCHED]->(n) WHERE r.onPath = true RETURN n.id AS id, r.pathIndex AS idx ORDER BY idx, id", { id: r.turnId });
    expect(on).toEqual([{ id: "decision:pause-stories", idx: 0 }, { id: "channel:instagram", idx: 1 }]);
    // product:lonely was touched (a tool returned it), but is not on the path
    const [lonely] = await g.roQuery<{ on: boolean | null }>("MATCH (:Turn {id:$id})-[r:TOUCHED]->(:Product {id:'product:lonely'}) RETURN r.onPath AS on", { id: r.turnId });
    expect(lonely!.on).toBeNull();
    expect((await answersThrough(g, "channel:instagram")).map((a) => a.turnId)).toEqual(["turn:2026-10-16-p2", r.turnId, "turn:2026-10-15-p1"]); // newest first
  });
});
