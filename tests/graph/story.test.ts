import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { upsertEdge, upsertNode, addObservation, closeEdge } from "../../src/graph/upsert.js";
import { formatStory, graphStory, kindOfLabel, kindOfRel } from "../../src/graph/story.js";
import { testGraph } from "../helpers/graph.js";

const DAY = 86_400_000;
const MON = Date.parse("2026-10-05T10:00:00Z"); // a Monday

describe("graphStory (how the brain grew)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await ensureIndexes(g);
    // week 1: three nodes and two edges; week 2 (nothing on Thursday): a task that changes, an observation, and one fact that ended
    await upsertNode(g, { type: "Business", id: "business:cafe", name: "Cafe", asOf: "2026-09-01" }, MON);
    await upsertNode(g, { type: "Person", id: "person:asha", name: "Asha", asOf: "2026-09-02" }, MON + DAY);
    await upsertNode(g, { type: "Document", id: "document:menu", name: "Menu", asOf: "2026-09-20" }, MON + 2 * DAY);
    await upsertEdge(g, { from: "person:asha", type: "MEMBER_OF", to: "business:cafe", asOf: "2026-09-02" }, MON + DAY);
    await upsertEdge(g, { from: "person:asha", type: "AUTHORED", to: "document:menu", asOf: "2026-09-20" }, MON + 2 * DAY);
    await upsertNode(g, { type: "Task", id: "task:open", name: "Open", props: { status: "todo" }, asOf: "2026-10-12" }, MON + 7 * DAY);
    await upsertNode(g, { type: "Task", id: "task:open", name: "Open", props: { status: "done" }, asOf: "2026-10-13" }, MON + 8 * DAY); // a Version
    await upsertEdge(g, { from: "person:asha", type: "OWNS", to: "task:open", asOf: "2026-10-12" }, MON + 7 * DAY);
    await closeEdge(g, "person:asha", "AUTHORED", "document:menu", MON + 9 * DAY);
    await addObservation(g, { subject: "business:cafe", metric: "visits", value: 40, asOf: "2026-10-13", src: "document:menu" }, MON + 8 * DAY);
  });
  afterAll(async () => { await cleanup(); await closeAll(); });

  it("counts new nodes and edges per week, by kind, with running totals", async () => {
    const s = await graphStory(g, { bucket: "week" });
    expect(s.axis).toBe("recorded");
    expect(s.points.map((p) => p.start)).toEqual(["2026-10-05", "2026-10-12"]);
    const [w1, w2] = s.points;
    expect(w1!.nodes).toBe(3);
    expect(w1!.nodesByKind).toEqual({ company: 2, knowledge: 1 });
    expect(w1!.edges).toBe(2);
    expect(w1!.totalNodes).toBe(3);
    // week 2: the task, its Version and the Observation are new nodes; the closed AUTHORED edge is retired
    expect(w2!.nodes).toBe(3);
    expect(w2!.nodesByKind).toMatchObject({ work: 1, history: 1, knowledge: 1 });
    expect(w2!.totalNodes).toBe(s.totals.nodes);
    expect(w2!.retired).toBe(1);
    expect(s.totals.versions).toBe(1);
    expect(s.totals.retired).toBe(1);
    expect(s.totals.undatedNodes).toBe(0);
    expect(s.nodesByType.find((t) => t.type === "Task")?.count).toBe(1);
  });

  it("fills quiet days with zero when counting by day", async () => {
    const s = await graphStory(g, { bucket: "day" });
    const byDay = new Map(s.points.map((p) => [p.start, p]));
    expect(byDay.get("2026-10-08")?.nodes).toBe(0); // nothing recorded that Thursday, still a row
    expect(byDay.get("2026-10-06")?.nodes).toBe(1);
    expect(s.points.at(-1)!.totalNodes).toBe(s.totals.nodes);
  });

  it("counts by the date of the source when asked", async () => {
    const s = await graphStory(g, { axis: "source", bucket: "week" });
    expect(s.axis).toBe("source");
    expect(s.points[0]!.start).toBe("2026-08-31"); // 2026-09-01 is a Tuesday
    expect(s.afterLoad).toBeNull();
    expect(s.totals.nodes).toBeGreaterThanOrEqual(6);
  });

  it("says what came after the first big load", async () => {
    const s = await graphStory(g, { bucket: "week" });
    expect(s.afterLoad).toMatchObject({ loadDay: "2026-10-13" });
    const text = formatStory(s);
    expect(text).toMatch(/How .* brain grew, by week/);
    expect(text).toMatch(/Nodes by type:/);
  });

  it("puts every label and relationship type in a kind, and the rest in other", () => {
    expect(kindOfLabel("Lead")).toBe("sales");
    expect(kindOfLabel("Version")).toBe("history");
    expect(kindOfLabel("Nonsense")).toBe("other");
    expect(kindOfRel("TOUCHED")).toBe("memory");
    expect(kindOfRel("MEETING_FOR")).toBe("sales");
  });
});
