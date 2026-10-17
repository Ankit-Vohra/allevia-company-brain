// Tenant isolation, layer 2: a tool call, an MCP request or a free-form Cypher query is bound to ONE graph, chosen by
// the server, never by the caller. Two real graphs (A and B) hold the same seed company plus one secret each; every
// attempt made through A must either be refused or come back with A's data only, and B must be exactly as it was.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { cypher } from "../../src/agent/tools/cypher.js";
import { ALL_TOOLS, toolsByName } from "../../src/agent/tools/index.js";
import { search } from "../../src/agent/tools/search.js";
import { getEntity } from "../../src/agent/tools/entity.js";
import { recall } from "../../src/agent/tools/memory.js";
import type { GraphHandle } from "../../src/graph/client.js";
import { upsertNode } from "../../src/graph/upsert.js";
import { createMcpHttpApp, createMcpServer } from "../../src/mcp/server.js";
import { fakeEmbed, SEED_NOW } from "../fixtures/seed-graph.js";
import { call, makeCtx, seededGraph } from "../helpers/tools.js";

const A_ONLY = "memory:a-only-quillfeather";
const B_ONLY = "memory:b-only-zorblax";
const A_WORD = "Quillfeather";
const B_WORD = "Zorblax";
// What would prove a leak: the other side's unique code, which no query or error message echoes back by itself.
const A_CODE = "QA-1180-floor";
const B_CODE = "ZB-7731-floor";

let a: GraphHandle;
let b: GraphHandle;
let cleanB: () => Promise<void>;

async function secret(g: GraphHandle, id: string, word: string, code: string): Promise<void> {
  const text = `${word} acquisition plan ${code}: the offer is four million and the seller must not know`;
  await upsertNode(g, {
    type: "Memory", id, name: `${word} plan`, summary: text, props: { kind: "note", text, at: SEED_NOW }, embedding: fakeEmbed(`${word} plan ${text}`),
  }, SEED_NOW);
}

const counts = async (g: GraphHandle) => (await g.roQuery<{ n: number; e: number }>("MATCH (n) WITH count(n) AS n OPTIONAL MATCH ()-[r]->() RETURN n, count(r) AS e"))[0]!;
const dump = (v: unknown): string => JSON.stringify(v);

beforeAll(async () => {
  ({ g: a } = await seededGraph());
  ({ g: b, cleanup: cleanB } = await seededGraph());
  await secret(a, A_ONLY, A_WORD, A_CODE);
  await secret(b, B_ONLY, B_WORD, B_CODE);
});
afterAll(async () => { await a?.drop(); await cleanB?.(); }); // cleanB also closes the connections

describe("the cypher tool is read-only and bound to its own graph", () => {
  const run = (g: GraphHandle, query: string, params?: Record<string, unknown>) =>
    call(cypher, { query, ...(params ? { params } : {}) }, makeCtx(g));

  it("sees its own secret and not the other tenant's, by every way of looking", async () => {
    const sides = [
      { g: a, word: A_WORD, mine: A_ONLY, theirs: B_ONLY, theirCode: B_CODE },
      { g: b, word: B_WORD, mine: B_ONLY, theirs: A_ONLY, theirCode: A_CODE },
    ];
    for (const s of sides) {
      const own = await run(s.g, "MATCH (m:Memory) WHERE m.name CONTAINS $w RETURN m.id AS id", { w: s.word });
      expect(dump(own.data)).toContain(s.mine);
      for (const q of [
        "MATCH (n:Entity) WHERE n.id = $id RETURN n.id AS id, n.summary AS summary",
        "MATCH (n:Entity) WHERE n.name CONTAINS 'Zorblax' OR n.name CONTAINS 'Quillfeather' OR n.summary CONTAINS 'four million' RETURN n.id AS id, n.name AS name ORDER BY id",
        "CALL db.idx.fulltext.queryNodes('Searchable', 'Zorblax Quillfeather') YIELD node RETURN node.id AS id",
      ]) {
        const r = await run(s.g, q, { id: s.theirs });
        expect(dump(r.data), q).not.toContain(s.theirCode);
      }
    }
  });

  it("has no way to name or switch to another graph", async () => {
    const attempts = [
      "USE allevia_meta MATCH (n) RETURN n",
      "USE GRAPH allevia_meta RETURN 1",
      "FROM GRAPH b MATCH (n) RETURN n",
      "MATCH (n) IN GRAPH b RETURN n",
      "GRAPH.QUERY allevia_meta \"MATCH (n) RETURN n\"",
      "CALL graph.list() YIELD name RETURN name",
      "CALL db.graphs() YIELD name RETURN name",
      "CALL dbms.listDatabases() YIELD name RETURN name",
      "CALL dbms.showDatabases()",
      "SHOW DATABASES",
      "CALL db.selectGraph('allevia_meta')",
      "CALL apoc.cypher.run('MATCH (n) RETURN n', {}) YIELD value RETURN value",
      "RETURN 1; GRAPH.DELETE allevia_meta",
    ];
    const before = [await counts(a), await counts(b)];
    for (const q of attempts) {
      const r = await run(a, q);
      const text = dump(r.data);
      // refused or failed, or it ran and showed nothing of any other graph
      expect(text, q).not.toContain(B_CODE);
      const rows = dump((r.data as { rows?: unknown }).rows ?? []); // an error message may echo the attacker's own text; rows are what the graph said
      expect(rows, q).not.toMatch(/allevia_(meta|test_)/);
      expect(rows, q).not.toMatch(/"slug"/);
    }
    expect([await counts(a), await counts(b)]).toEqual(before);
  });

  it("refuses every write, however it is spelled, and nothing changes in either graph", async () => {
    const attempts = [
      "CREATE (:Entity:Memory {id:'memory:evil', name:'evil'})",
      "create (n:Entity {id:'x'})", "MERGE (n:Entity:Memory {id:'memory:evil'})",
      "MATCH (n) SET n.name = 'owned'", "MATCH (n) SET n += {name: 'owned'}", "MATCH (n) REMOVE n.name",
      "MATCH (n) DETACH DELETE n", "MATCH (n) DELETE n", "MATCH ()-[r]->() DELETE r",
      "MATCH (n) FOREACH (x IN [1] | SET n.y = x)", "MATCH (n) CALL { WITH n CREATE (m:Evil) } RETURN n",
      "MATCH (n) RETURN n UNION CREATE (m:Evil) RETURN m",
      "MATCH (n) WITH n LIMIT 1 /* x */ SE/**/T n.a = 1", "MATCH (n) WITH n LIMIT 1 CREATE (m:Evil)", "MATCH (n) WITH n LIMIT 1 `CREATE` (m)",
      "MATCH (n) WITH n LIMIT 1\nCREATE\n(m:Evil)", "RETURN 'a' // x\nCREATE (m:Evil)",
      "LOAD CSV FROM 'file:///etc/passwd' AS row RETURN row", "LOAD CSV WITH HEADERS FROM 'http://169.254.169.254/' AS row RETURN row",
      "DROP INDEX ON :Entity(id)", "CREATE INDEX FOR (n:Entity) ON (n.name)",
      "CALL db.idx.fulltext.drop('Searchable')", "CALL db.idx.fulltext.createNodeIndex('Entity', 'name')",
      "CALL db.idx.vector.createNodeIndex({label:'Entity', attribute:'v', dimension: 3})",
      "CALL dbms.setConfig('RESULTSET_SIZE', 1)", "CALL algo.pageRank(null, null)", "CALL db.constraints.drop()",
      "CALL db.idx.fulltext.queryNodes('Searchable', 'x') YIELD node SET node.name = 'owned'",
    ];
    const before = [await counts(a), await counts(b)];
    const names = await a.roQuery<{ name: string }>("MATCH (n:Entity) RETURN n.name AS name, n.id AS id ORDER BY id");
    for (const q of attempts) {
      const r = await run(a, q);
      expect(r.data, q).toMatchObject({ error: expect.any(String) });
    }
    expect([await counts(a), await counts(b)]).toEqual(before);
    expect(await a.roQuery("MATCH (n:Entity) RETURN n.name AS name, n.id AS id ORDER BY id")).toEqual(names);
    expect(await b.roQuery("MATCH (n:Evil) RETURN count(n) AS c")).toEqual([{ c: 0 }]);
  });

  it("the server itself refuses a write sent as a read, so the text guard is not the last line", async () => {
    for (const q of ["CREATE (:Evil)", "MATCH (n) SET n.x = 1", "MATCH (n) DETACH DELETE n"]) {
      await expect(a.roQuery(q), q).rejects.toThrow(/read.?only|write|graph\.ro_query/i);
    }
    expect(await b.roQuery("MATCH (n:Evil) RETURN count(n) AS c")).toEqual([{ c: 0 }]);
  });

  it("parameters are values, never Cypher: a crafted value cannot break out of its quotes", async () => {
    const before = [await counts(a), await counts(b)];
    const nasty = [
      "x\" RETURN 1 //", "x' }) MATCH (n) DETACH DELETE n //", "\\", "\\\" OR 1=1 //", "line1\nline2", "`", "$id", "}) CREATE (:Evil) //",
      "\u0000", " ", "x\", id: \"y",
    ];
    for (const v of nasty) {
      const r = await run(a, "MATCH (n:Entity) WHERE n.name = $v RETURN n.id AS id LIMIT 5", { v });
      expect(r.data, v).not.toMatchObject({ error: expect.stringMatching(/not allowed|refused/i) });
      expect(dump(r.data), v).not.toContain(B_CODE);
    }
    expect([await counts(a), await counts(b)]).toEqual(before);
    // a parameter map with a crafted key is refused before it is sent
    await expect(a.roQuery("RETURN 1", { "x} RETURN 1 //": 1 })).rejects.toThrow(/plain identifier/);
  });
});

describe("no tool lets the caller choose the graph", () => {
  it("none of the tools has an input that names a tenant, a graph or a database", () => {
    const banned = /^(tenant|slug|graph|graphName|database|db|business|org|company|workspace)$/i;
    for (const t of ALL_TOOLS) for (const k of Object.keys(t.input)) expect(k, `${t.name}.${k}`).not.toMatch(banned);
  });

  it("a forged tenant or graph in the arguments is dropped before the tool runs, and the answer is A's", async () => {
    const forged = { tenant: "b", slug: "b", graph: b.name, database: b.name, graphName: b.name };
    for (const tool of ALL_TOOLS.filter((t) => ["search", "get_entity", "neighbors", "recall", "cypher", "who_owns"].includes(t.name))) {
      const base: Record<string, unknown> = {
        search: { query: `${B_WORD} ${A_WORD}` }, get_entity: { id: B_ONLY }, neighbors: { id: B_ONLY }, recall: { ids: [B_ONLY], query: B_WORD },
        cypher: { query: "MATCH (n:Memory) RETURN n.id AS id ORDER BY id" }, who_owns: { id: B_ONLY },
      }[tool.name]!;
      const parsed = z.object(tool.input).parse({ ...base, ...forged }); // what the runtime and the MCP server do first
      expect(Object.keys(parsed)).not.toEqual(expect.arrayContaining(["tenant", "graph"]));
      const r = await tool.run(parsed as never, makeCtx(a));
      expect(dump(r), tool.name).not.toContain(B_CODE);
    }
  });

  it("another tenant's id is simply not found: search, get_entity and recall", async () => {
    const s = await call(search, { query: `${B_WORD} acquisition plan` }, makeCtx(a));
    expect(dump(s)).not.toContain(B_CODE);
    expect(s.nodes.map((n) => n.id)).not.toContain(B_ONLY);
    const g = await call(getEntity, { id: B_ONLY }, makeCtx(a));
    expect(g.nodes).toEqual([]);
    expect(dump(g.data)).not.toContain(B_CODE);
    const r = await call(recall, { ids: [B_ONLY], query: B_WORD }, makeCtx(a));
    expect(dump(r)).not.toContain(B_CODE);
    // and the same in the other direction, so the test is not passing because the data is missing
    const mine = await call(getEntity, { id: B_ONLY }, makeCtx(b));
    expect(mine.nodes.map((n) => n.id)).toContain(B_ONLY);
    expect(dump(mine)).toContain(B_CODE);
  });
});

describe("the MCP server answers for the one tenant it was started with", () => {
  async function connect(g: GraphHandle, tenant: string): Promise<Client> {
    const server = createMcpServer({ tenant, graph: g, embedQuery: async (t) => fakeEmbed(t), now: () => SEED_NOW });
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "allevia-security-test", version: "0.0.0" });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    return client;
  }
  const text = (r: unknown): string => dump((r as { content: unknown }).content);

  it("ignores a forged tenant or graph in a tool call", async () => {
    const client = await connect(a, "a");
    try {
      for (const [name, args] of [
        ["search", { query: B_WORD, tenant: "b", graph: b.name }],
        ["get_entity", { id: B_ONLY, tenant: "b" }],
        ["cypher", { query: "MATCH (n:Memory) RETURN n.id AS id ORDER BY id", tenant: "b", graph: b.name }],
        ["recall", { ids: [B_ONLY], query: B_WORD, tenant: "b" }],
      ] as const) {
        const r = await client.callTool({ name, arguments: args as Record<string, unknown> });
        expect(text(r), name).not.toContain(B_CODE);
        expect((r as { structuredContent?: { nodes?: Array<{ id: string }> } }).structuredContent?.nodes?.map((n) => n.id) ?? [], name).not.toContain(B_ONLY);
      }
      const own = await client.callTool({ name: "cypher", arguments: { query: "MATCH (n:Memory) RETURN n.id AS id ORDER BY id" } });
      expect(text(own)).toContain(A_ONLY);
    } finally {
      await client.close();
    }
  });

  it("over HTTP, a tenant named in the URL, a header or the query string changes nothing: the graph was fixed at start-up", async () => {
    const app = createMcpHttpApp({ tenant: "a", graph: a, port: 8799, now: () => SEED_NOW });
    const body = (id: number) => JSON.stringify({
      jsonrpc: "2.0", id, method: "tools/call",
      params: { name: "get_entity", arguments: { id: B_ONLY, tenant: "b", graph: b.name } },
    });
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", host: "127.0.0.1:8799" };
    for (const [url, extra] of [
      ["http://127.0.0.1:8799/mcp?tenant=b&graph=allevia_b", {}],
      ["http://127.0.0.1:8799/mcp", { "x-tenant": "b", "x-allevia-tenant": "b", "x-graph": b.name }],
      ["http://127.0.0.1:8799/b/mcp", {}],
    ] as const) {
      const res = await app.request(url, { method: "POST", body: body(1), headers: { ...headers, ...extra } });
      const out = await res.text();
      expect(out, url).not.toContain(B_CODE);
    }
  });

  it("registers no tool that could write, so a forged call to one finds nothing", async () => {
    const client = await connect(a, "a");
    try {
      const before = [await counts(a), await counts(b)];
      for (const name of ["remember", "propose_action", "upsert", "query"]) {
        const r = await client.callTool({ name, arguments: { text: "x", tenant: "b", about: [B_ONLY] } }) as { isError?: boolean };
        expect(r.isError, name).toBe(true);
      }
      expect([await counts(a), await counts(b)]).toEqual(before);
    } finally {
      await client.close();
    }
  });

  it("the read-only tool list is the same for every tenant (the code is shared, the data is not)", () => {
    expect(toolsByName(["search", "cypher"]).map((t) => t.name)).toEqual(["search", "cypher"]);
  });
});
