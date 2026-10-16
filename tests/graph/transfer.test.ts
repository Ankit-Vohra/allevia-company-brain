// db:export / db:import (src/graph/transfer.ts): a logical copy of a graph that keeps every label, property type,
// vector, edge, index and constraint, refuses to overwrite, refuses a damaged file, and proves the copy by reading it
// back. Throwaway graphs on the test server only.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCommands } from "../../src/cli.js";
import { closeAll, connect, describeUrl, openGraphByName, redactUrl } from "../../src/graph/client.js";
import { ensureSchema, listIndexes } from "../../src/graph/indexes.js";
import { readDump, summarize } from "../../src/graph/transfer.js";
import { resolveUrl, sourceGraph } from "../../src/cli/db-transfer.js";
import { testGraphName } from "../helpers/graph.js";

const url = process.env.ALLEVIA_FALKORDB_URL!;
const src = testGraphName();
const dst = testGraphName();
const dir = mkdtempSync(join(tmpdir(), "allevia-transfer-"));
const file = join(dir, "g.jsonl");
const vec = (seed: number) => Array.from({ length: 384 }, (_, k) => Math.sin(seed * 31 + k) / 3);

const run = async (name: string, args: string[]): Promise<{ code: number | void; out: string }> => {
  const cmd = (await loadCommands()).find((c) => c.name === name)!;
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...a) => { lines.push(a.join(" ")); });
  const err = vi.spyOn(console, "error").mockImplementation((...a) => { lines.push(a.join(" ")); });
  try {
    return { code: await cmd.run(args), out: lines.join("\n") };
  } finally {
    log.mockRestore();
    err.mockRestore();
  }
};

describe("db:export and db:import (integration)", () => {
  beforeAll(async () => {
    const g = await openGraphByName(src);
    await ensureSchema(g); // labels registered in the product's order, the indexes and constraints
    await g.query(
      `CREATE (b:Entity:Business:Searchable {id:'business:t', name:'Tést "quoted" \\\\ back', summary:'line one\nline two', founded:2019, live:true, score:3.0, ratio:0.25, tags:['a','b'], validFrom:1700000000000}),
              (t:Entity:Task:Searchable {id:'task:1', name:'Ship it', recordedAt:1700000000001, validTo:null}),
              (o:Entity:Observation {id:'obs:1', metric:'Signups', metricKey:'signups', subject:'business:t', asOf:'2026-10-01', value:12.0}),
              (c:Entity:Chunk {id:'chunk:1', text:'chunk text'}),
              (b)-[:OWNS {since:1700000000000, weight:1.0, note:'x'}]->(t),
              (o)-[:MEASURES {since:1}]->(b),
              (b)-[:HAS_CHUNK]->(c),
              (t)-[:DEPENDS_ON {since:2, until:3}]->(t)`);
    await g.query("MATCH (n:Entity {id:'business:t'}) SET n.embedding = vecf32($v)", { v: vec(1) });
    await g.query("MATCH (n:Entity {id:'task:1'}) SET n.embedding = vecf32($v)", { v: vec(2) });
    await g.query("MATCH (n:Entity {id:'chunk:1'}) SET n.textEmbedding = vecf32($v)", { v: vec(3) });
  });
  afterAll(async () => {
    for (const n of [src, dst]) await (await openGraphByName(n)).drop();
    await closeAll();
    rmSync(dir, { recursive: true, force: true });
  });

  it("exports every node and edge with the keys that hold Floats and vectors marked", async () => {
    const r = await run("db:export", [src, file]);
    expect(r.out).toContain(`${src} from ${describeUrl(url)}`);
    expect(r.code).toBe(0);
    const d = readDump(file);
    expect(d.nodes).toHaveLength(4);
    expect(d.edges).toHaveLength(4);
    const biz = d.nodes.find((n) => n.p.id === "business:t")!;
    expect(biz.f?.sort()).toEqual(["ratio", "score"]);
    expect(biz.v).toEqual(["embedding"]);
    expect(d.header.labels.indexOf("Searchable")).toBeGreaterThan(d.header.labels.indexOf("Task"));
    expect(d.header.indexes.map((i) => `${i.type} ${i.label}.${i.prop}`)).toContain("VECTOR Searchable.embedding");
    expect(d.header.constraints.map((c) => c.type).sort()).toEqual(["MANDATORY", "UNIQUE"]);
  });

  it("imports into a new graph and proves the copy equal: types, vectors, label order, indexes, constraints", async () => {
    const r = await run("db:import", [file, "--to", url, "--graph", dst]);
    expect(r.out).toContain("verify: ok");
    expect(r.code).toBe(0);
    const g = await openGraphByName(dst);
    const [b] = await g.roQuery<{ s: string; r: string; f: string; sum: string; name: string; e: number[] }>(
      "MATCH (n:Entity {id:'business:t'}) RETURN typeOf(n.score) AS s, typeOf(n.ratio) AS r, typeOf(n.founded) AS f, n.summary AS sum, n.name AS name, n.embedding AS e");
    expect(b).toMatchObject({ s: "Float", r: "Float", f: "Integer", sum: "line one\nline two", name: 'Tést "quoted" \\ back' });
    expect(b!.e.map(Math.fround)).toEqual(vec(1).map(Math.fround));
    const [w] = await g.roQuery<{ t: string }>("MATCH (:Entity {id:'business:t'})-[r:OWNS]->() RETURN typeOf(r.weight) AS t");
    expect(w!.t).toBe("Float");
    const [l] = await g.roQuery<{ l: string[] }>("MATCH (n:Entity {id:'task:1'}) RETURN labels(n) AS l");
    expect(l!.l).toEqual(["Entity", "Task", "Searchable"]);
    const idx = (await listIndexes(g)).map((i) => `${i.type} ${i.label}.${i.prop}`);
    expect(idx).toEqual(expect.arrayContaining(["RANGE Entity.id", "FULLTEXT Searchable.name", "VECTOR Chunk.textEmbedding"]));
    expect((await g.constraints()).map((c) => `${c.type} ${c.status}`).sort()).toEqual(["MANDATORY OPERATIONAL", "UNIQUE OPERATIONAL"]);
    const [hit] = await g.roQuery<{ id: string }>(
      "CALL db.idx.vector.queryNodes('Searchable', 'embedding', 1, vecf32($v)) YIELD node RETURN node.id AS id", { v: vec(2) });
    expect(hit!.id).toBe("task:1");
  });

  it("refuses a graph that already exists, and replaces it only with --replace", async () => {
    const r = await run("db:import", [file, "--to", url, "--graph", dst]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("already exists on the target (4 nodes, 4 edges): pass --replace");
    const again = await run("db:import", [file, "--to", url, "--graph", dst, "--replace"]);
    expect(again.out).toContain("verify: ok");
    const [c] = await (await openGraphByName(dst)).roQuery<{ c: number }>("MATCH (n) RETURN count(n) AS c");
    expect(c!.c).toBe(4);
  });

  it("refuses a file that was cut short or edited, before writing anything", async () => {
    const lines = readFileSync(file, "utf8").trim().split("\n");
    const cut = join(dir, "cut.jsonl");
    writeFileSync(cut, lines.slice(0, -2).join("\n"));
    const r = await run("db:import", [cut, "--to", url, "--graph", `${dst}x`]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("has no end line");
    const edited = join(dir, "edited.jsonl");
    writeFileSync(edited, lines.map((l) => l.replace("Ship it", "Ship that")).join("\n"));
    expect((await run("db:import", [edited, "--to", url, "--graph", `${dst}x`])).out).toContain("does not match its digest");
    expect((await (await connect()).list())).not.toContain(`${dst}x`);
  });

  it("refuses at export a property it cannot carry faithfully", async () => {
    const g = await openGraphByName(testGraphName());
    try {
      await g.query("CREATE (:Entity {id:'p', where:point({latitude:1.0, longitude:2.0})}), (:Entity {id:'l', xs:[1.0, 2.5]})");
      const r = await run("db:export", [g.name, join(dir, "bad.jsonl")]);
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/node \d+ has properties of a type the export does not carry: (where|xs)/);
    } finally {
      await g.drop();
    }
  });

  it("the digest does not depend on internal ids", () => {
    const d = readDump(file);
    const shift = (k: number) => k + 1000;
    const moved = summarize(
      d.nodes.map((n) => ({ ...n, i: shift(n.i) })),
      d.edges.map((e) => ({ ...e, i: shift(e.i), s: shift(e.s), d: shift(e.d) })));
    expect(moved.digest).toBe(d.end.digest);
  });

  it("names servers without their credentials, and resolves env:NAME", () => {
    const secret = "redis://alice:s3cr3t-pass@db.example.test:12345";
    expect(describeUrl(secret)).toBe("redis://***@<remote>:12345");
    expect(redactUrl(`connect failed: ${secret} and db.example.test:12345 s3cr3t-pass`, secret)).not.toMatch(/s3cr3t|example|alice/);
    expect(describeUrl("redis://127.0.0.1:6391")).toBe("redis://127.0.0.1:6391");
    expect(resolveUrl("env:SOME_URL", { SOME_URL: secret, ALLEVIA_ENV_FILE: "/nonexistent" })).toBe(secret);
    expect(() => resolveUrl("env:NOPE_URL", { ALLEVIA_ENV_FILE: "/nonexistent" })).toThrow("NOPE_URL is not set");
    expect(sourceGraph("meta")).toBe("allevia_meta");
    expect(sourceGraph("avs_atelier")).toBe("allevia_avs_atelier");
  });
});
