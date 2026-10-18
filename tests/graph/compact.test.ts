// graph:compact (src/graph/compact.ts) on a small graph built for it: which readings fold into a weekly one and which stay
// (a cited week, a lone reading, a week that is not wholly old, recent ones), which passages go (a superseded document's,
// one its document let go of) and which stay (a cited one, a current one), and the facts and versions that ended long ago.
// The dry run changes nothing; apply writes the archive first; restoring the archive gives back the same graph, digest for
// digest; a second restore is refused.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeAll, connect, type GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { addObservation, closeEdge, upsertEdge, upsertNode } from "../../src/graph/upsert.js";
import { compactGraph, formatCompact, readArchive, restoreArchive, rollupId, weekStart } from "../../src/graph/compact.js";
import { readGraph } from "../../src/graph/transfer.js";
import { testGraph } from "../helpers/graph.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-17T12:00:00Z");          // readings before 2026-07-19 are old
const OLD = NOW - 400 * DAY;
const AS = { src: "document:seed", asOf: "2026-06-01" };
const days = (from: string, n: number): string[] => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${from}T00:00:00Z`) + i * DAY).toISOString().slice(0, 10));

describe("weekStart", () => {
  it("is the Monday of the ISO week", () => {
    expect(weekStart("2026-06-01")).toBe("2026-06-01"); // a Monday
    expect(weekStart("2026-06-07")).toBe("2026-06-01"); // its Sunday
    expect(weekStart("2026-06-08T10:00:00Z")).toBe("2026-06-08");
    expect(() => weekStart("soon")).toThrow(/not a date/);
  });
});

describe("graph:compact (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  let dir: string;
  const digest = async () => (await readGraph(g, await connect())).end.digest;

  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    dir = mkdtempSync(join(tmpdir(), "allevia-compact-"));
    await ensureIndexes(g);
    await upsertNode(g, { type: "Business", id: "business:cafe", name: "Cafe", ...AS }, OLD);
    await upsertNode(g, { type: "Document", id: "document:seed", name: "Seed export", ...AS }, OLD);
    await upsertNode(g, { type: "Channel", id: "channel:web", name: "Website", ...AS }, OLD);
    // two whole old weeks of daily sessions (1..7 and 8..14), one with a corrected reading (a Version)
    let v = 0;
    for (const day of days("2026-06-01", 14)) await addObservation(g, { subject: "channel:web", metric: "sessions", unit: "visits", value: ++v, asOf: day, src: "document:seed" }, OLD);
    await addObservation(g, { subject: "channel:web", metric: "sessions", unit: "visits", value: 100, asOf: "2026-06-03", src: "document:seed" }, OLD + 1000);
    // an old week an answer cited: stays daily
    for (const day of days("2026-06-15", 3)) await addObservation(g, { subject: "channel:web", metric: "sessions", unit: "visits", value: 5, asOf: day, src: "document:seed" }, OLD);
    await upsertNode(g, { type: "Turn", id: "turn:asked", name: "How did June go?", ...AS }, OLD);
    await upsertEdge(g, { from: "turn:asked", type: "CITED", to: "obs:sessions:channel:web:2026-06-16", ...AS }, OLD);
    // a turn only looked at one of the folded readings: does not pin it
    await upsertEdge(g, { from: "turn:asked", type: "TOUCHED", to: "obs:sessions:channel:web:2026-06-02", ...AS }, OLD);
    // a lone reading in its week, a week that ends after the cut-off, and a recent reading
    await addObservation(g, { subject: "channel:web", metric: "sessions", unit: "visits", value: 9, asOf: "2026-06-24", src: "document:seed" }, OLD);
    for (const day of ["2026-07-17", "2026-07-18"]) await addObservation(g, { subject: "channel:web", metric: "sessions", unit: "visits", value: 3, asOf: day, src: "document:seed" }, OLD);
    await addObservation(g, { subject: "channel:web", metric: "sessions", unit: "visits", value: 40, asOf: "2026-10-10", src: "document:seed" }, NOW);

    // passages: a superseded document's chunks (one cited), a chunk its document let go of, a current one
    await upsertNode(g, { type: "Document", id: "document:menu-v1", name: "Menu v1", ...AS }, OLD);
    await upsertNode(g, { type: "Document", id: "document:menu-v2", name: "Menu v2", ...AS }, OLD);
    await upsertEdge(g, { from: "document:menu-v2", type: "SUPERSEDES", to: "document:menu-v1", ...AS }, OLD);
    for (const [doc, chunk] of [["document:menu-v1", "chunk:v1-a"], ["document:menu-v1", "chunk:v1-cited"], ["document:menu-v2", "chunk:v2-a"], ["document:menu-v2", "chunk:v2-old"]]) {
      await upsertNode(g, { type: "Chunk", id: chunk!, name: chunk!, props: { text: `text of ${chunk}` }, ...AS }, OLD);
      await upsertEdge(g, { from: doc!, type: "HAS_CHUNK", to: chunk!, ...AS }, OLD);
    }
    await upsertEdge(g, { from: "turn:asked", type: "CITED", to: "chunk:v1-cited", ...AS }, OLD);
    await closeEdge(g, "document:menu-v2", "HAS_CHUNK", "chunk:v2-old", OLD + DAY, "re-read");

    // a fact that ended long ago, and a status that changed long ago (an old Version)
    await upsertNode(g, { type: "Task", id: "task:menu", name: "Print the menu", props: { status: "open" }, src: "document:seed", asOf: "2025-08-01" }, OLD);
    await upsertNode(g, { type: "Task", id: "task:menu", name: "Print the menu", props: { status: "done" }, src: "document:seed", asOf: "2025-08-20" }, OLD + 1000);
    await upsertEdge(g, { from: "business:cafe", type: "OWNS", to: "task:menu", src: "document:seed", asOf: "2025-08-01" }, OLD);
    await closeEdge(g, "business:cafe", "OWNS", "task:menu", OLD + DAY, "done");
    await upsertEdge(g, { from: "business:cafe", type: "OWNS", to: "channel:web", ...AS }, OLD);
  });
  afterAll(async () => {
    await cleanup();
    await closeAll();
  });

  let before: string;
  let archive: string;

  it("plans without changing anything (a dry run)", async () => {
    before = await digest();
    const r = await compactGraph(g, { now: NOW });
    const p = r.rollup!.plan;
    expect(p.weeks.map((w) => [w.weekStart, w.readings.length])).toEqual([["2026-06-01", 7], ["2026-06-08", 7]]);
    expect(p.kept).toEqual({ pinned: 3, single: 1, mixedUnits: 0, partialWeek: 2, rolledBefore: 0 });
    expect(r.rollup!.versions).toBe(1);
    expect(r.chunks!.plan.prune.sort()).toEqual(["chunk:v1-a", "chunk:v2-old"]);
    expect(r.chunks!.plan.kept.cited).toBe(1);
    expect(r.closed!.byType).toEqual({ OWNS: 1 });
    expect(r.closed!.versions).toBe(1);
    expect(r.applied).toBe(false);
    expect(formatCompact("cafe", r)).toMatch(/a dry run/);
    expect(await digest()).toBe(before);
  });

  it("refuses to apply without an archive file", async () => {
    await expect(compactGraph(g, { now: NOW, apply: true })).rejects.toThrow(/archive/);
  });

  it("applies: the archive first, then weekly readings in place of the daily ones", async () => {
    archive = join(dir, "cafe.archive.jsonl");
    const r = await compactGraph(g, { now: NOW, apply: true, archiveFile: archive });
    expect(r.applied).toBe(true);
    const a = readArchive(archive);
    expect(a.nodes.length).toBe(r.removed.nodes);
    expect(a.created).toEqual([rollupId("sessions", "channel:web", "2026-06-01"), rollupId("sessions", "channel:web", "2026-06-08")]);

    const [w] = await g.roQuery<Record<string, unknown>>(
      `MATCH (o:Entity {id:$id})-[m:MEASURES]->(s:Entity) WHERE ID(m) >= 0 OPTIONAL MATCH (o)-[f:SOURCED_FROM]->(d:Entity) WHERE ID(f) >= 0
       RETURN o.value AS value, o.sum AS sum, o.min AS min, o.max AS max, o.samples AS samples, o.rollup AS rollup, o.windowStart AS ws,
              o.windowEnd AS we, o.metricKey AS mk, s.id AS subject, d.id AS doc`, { id: rollupId("sessions", "channel:web", "2026-06-01") });
    // days 1..7, with the 3rd corrected to 100: 1+2+100+4+5+6+7
    expect(w!.value as number).toBeCloseTo(125 / 7, 10); // the server replies with 15 significant digits
    expect({ ...w, value: undefined }).toEqual({ value: undefined, sum: 125, min: 1, max: 100, samples: 7, rollup: "week", ws: "2026-06-01", we: "2026-06-07", mk: "sessions", subject: "channel:web", doc: "document:seed" });

    const left = await g.roQuery<{ id: string }>("MATCH (o:Observation) WHERE o.rollup IS NULL RETURN o.id AS id ORDER BY id");
    expect(left.map((x) => x.id.split(":").pop())).toEqual(["2026-06-15", "2026-06-16", "2026-06-17", "2026-06-24", "2026-07-17", "2026-07-18", "2026-10-10"]);
    const chunks = await g.roQuery<{ id: string }>("MATCH (c:Chunk) RETURN c.id AS id ORDER BY id");
    expect(chunks.map((c) => c.id)).toEqual(["chunk:v1-cited", "chunk:v2-a"]);
    const [owns] = await g.roQuery<{ c: number }>("MATCH (:Entity {id:'business:cafe'})-[r:OWNS]->(:Entity {id:'task:menu'}) WHERE ID(r) >= 0 RETURN count(r) AS c");
    expect(owns?.c).toBe(0);
    const [versions] = await g.roQuery<{ c: number }>("MATCH (v:Version) RETURN count(v) AS c");
    expect(versions?.c).toBe(0);
  });

  it("finds nothing more to do on a second run", async () => {
    const r = await compactGraph(g, { now: NOW });
    expect(r.rollup!.foldedReadings).toBe(0);
    expect(r.removed).toEqual({ nodes: 0, edges: 0 });
  });

  it("restores the archive to the graph it was, digest for digest, and only once", async () => {
    const dry = await restoreArchive(g, archive);
    expect(dry.applied).toBe(false);
    const r = await restoreArchive(g, archive, { apply: true });
    expect(r.edgesSkipped).toBe(0);
    expect(r.rollupsRemoved).toBe(2);
    expect(await digest()).toBe(before);
    expect(existsSync(`${archive}.restored`)).toBe(true);
    await expect(restoreArchive(g, archive, { apply: true })).rejects.toThrow(/restored already/);
  });
});
