// The Allevia MCP server (spec §10): read-only graph tools for one tenant, over MCP. An in-memory MCP client talks to
// it over a seeded throwaway graph, the way Jarvis will over stdio.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ToolResult } from "../../shared/contracts.js";
import { isWriteTool } from "../../src/agent/runtime.js";
import { ALL_TOOLS, toolsByName } from "../../src/agent/tools/index.js";
import type { GraphHandle } from "../../src/graph/client.js";
import { MCP_TOOL_NAMES, createMcpHttpApp, createMcpServer } from "../../src/mcp/server.js";
import { fakeEmbed, SEED_NOW } from "../fixtures/seed-graph.js";
import { seededGraph } from "../helpers/tools.js";

interface CallOut { isError?: boolean; content: Array<{ type: string; text?: string }>; structuredContent?: unknown }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const parse = (r: CallOut): ToolResult<any> => JSON.parse(r.content[0]!.text!) as ToolResult;

let g: GraphHandle;
let cleanup: () => Promise<void>;
beforeAll(async () => { ({ g, cleanup } = await seededGraph()); });
afterAll(async () => { await cleanup?.(); });

describe("Allevia MCP server", () => {
  let client: Client;

  beforeAll(async () => {
    const server = createMcpServer({ tenant: "mini", graph: g, embedQuery: async (t) => fakeEmbed(t), now: () => SEED_NOW });
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "allevia-test", version: "0.0.0" });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  });
  afterAll(async () => { await client?.close(); });

  it("lists exactly the read-only graph tools, each marked read-only, and no write tool", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...MCP_TOOL_NAMES].sort());
    expect(names).toEqual(["cypher", "find_paths", "get_entity", "impact_of", "metric_trend", "neighbors", "recall", "search", "trace_decision", "who_knows", "who_owns"]);
    const writers = ALL_TOOLS.filter(isWriteTool).map((t) => t.name);
    expect(writers.length).toBeGreaterThan(0);
    for (const w of [...writers, "show_path"]) expect(names).not.toContain(w);
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.description).toBeTruthy();
      expect(t.inputSchema.type).toBe("object");
    }
  });

  it("search returns the tool's ToolResult JSON: data, nodes and sources", async () => {
    const r = await client.callTool({ name: "search", arguments: { query: "daily stories" } }) as CallOut;
    expect(r.isError).toBeFalsy();
    const out = parse(r);
    expect(Object.keys(out)).toEqual(expect.arrayContaining(["data", "nodes", "edges", "sources"]));
    const hits = (out.data.hits as Array<{ id: string }>).map((h) => h.id);
    expect(hits).toContain("decision:007-pause-daily-stories");
    expect(out.nodes.map((n) => n.id)).toContain("decision:007-pause-daily-stories");
    expect(out.sources.length).toBeGreaterThan(0);
    expect(r.structuredContent).toEqual(out);
  });

  it("trace_decision walks a decision to its evidence, sources and what it superseded", async () => {
    const r = await client.callTool({ name: "trace_decision", arguments: { id: "decision:007-pause-daily-stories" } }) as CallOut;
    expect(r.isError).toBeFalsy();
    const out = parse(r);
    expect(out.data.decision.id).toBe("decision:007-pause-daily-stories");
    const ids = out.nodes.map((n) => n.id);
    expect(ids).toContain("decision:003-daily-stories");
    expect(out.sources.map((s) => s.id)).toContain("document:adr-007");
  });

  it("a write through cypher is refused and changes nothing", async () => {
    const r = await client.callTool({
      name: "cypher", arguments: { query: "CREATE (n:Entity:Memory {id:'memory:mcp-sneak', name:'sneak'}) RETURN n.id" },
    }) as CallOut;
    expect(r.isError).toBe(true);
    const out = parse(r);
    expect(String(out.data.error)).toMatch(/read-only/i);
    expect(out.data.refused).toBe(true);
    const rows = await g.roQuery<{ c: number }>("MATCH (n:Entity {id:'memory:mcp-sneak'}) RETURN count(n) AS c");
    expect(rows[0]?.c).toBe(0);
  });

  it("a read through cypher works and its ids come back citable", async () => {
    const r = await client.callTool({
      name: "cypher", arguments: { query: "MATCH (d:Decision) RETURN d.id AS id ORDER BY id" },
    }) as CallOut;
    expect(r.isError).toBeFalsy();
    expect(parse(r).nodes.map((n) => n.id)).toEqual(expect.arrayContaining(["decision:003-daily-stories", "decision:007-pause-daily-stories"]));
  });

  it("write tools cannot be called: they are not registered", async () => {
    const r = await client.callTool({ name: "remember", arguments: { text: "x", about: ["decision:007-pause-daily-stories"] } }) as CallOut;
    expect(r.isError).toBe(true);
    const rows = await g.roQuery<{ c: number }>("MATCH (m:Memory) WHERE m.text = 'x' RETURN count(m) AS c");
    expect(rows[0]?.c).toBe(0);
  });

  it("refuses to be built with a write tool", () => {
    expect(() => createMcpServer({ tenant: "mini", graph: g, tools: toolsByName(["search", "remember"]) })).toThrow(/remember/);
  });
});

describe("Allevia MCP over Streamable HTTP", () => {
  const PORT = 8799;

  it("serves the same read-only tools statelessly, in process (no socket)", async () => {
    const app = createMcpHttpApp({ tenant: "mini", graph: g, port: PORT, now: () => SEED_NOW });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
      fetch: async (url, init) => app.request(String(url), init as RequestInit),
    });
    const client = new Client({ name: "allevia-http-test", version: "0.0.0" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());
      const r = await client.callTool({ name: "who_owns", arguments: { id: "system:reel-publisher" } }) as CallOut;
      expect(() => parse(r)).not.toThrow();
    } finally {
      await client.close();
    }
  });

  it("refuses a Host that is not loopback (DNS rebinding) and a foreign Origin", async () => {
    const app = createMcpHttpApp({ tenant: "mini", graph: g, port: PORT });
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    const evil = await app.request(`http://127.0.0.1:${PORT}/mcp`, { method: "POST", body, headers: { ...headers, host: `evil.example:${PORT}` } });
    expect(evil.status).toBe(403);
    const cross = await app.request(`http://127.0.0.1:${PORT}/mcp`, { method: "POST", body, headers: { ...headers, host: `127.0.0.1:${PORT}`, origin: "https://evil.example" } });
    expect(cross.status).toBe(403);
  });
});
