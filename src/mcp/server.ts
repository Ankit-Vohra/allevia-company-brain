// The Allevia MCP server (spec §10): the company brain's READ-ONLY graph tools for one tenant, over MCP. This is how
// another agent (Jarvis, the founder's Discord agent, in phase 2) asks Allevia's graph questions. See
// docs/jarvis-integration.md.
//
// Read-only, three times over:
// 1. Only the tools in MCP_TOOL_NAMES are registered, and createMcpServer refuses any tool runtime.ts counts as a
//    write tool (remember, propose_action, anything flagged `writes`), so a write tool cannot be exposed by mistake.
// 2. Every call runs with ctx.readOnly = true, so a write tool would refuse even if one got through.
// 3. cypher runs through GRAPH.RO_QUERY behind its own write guard (tools/cypher.ts).
//
// One server is bound to one tenant's graph, chosen when it starts (`--tenant`): a client cannot reach another tenant.
// A tool's result is its ToolResult as JSON ({data, nodes, edges, sources, note?}), as text content and as
// structuredContent. Input mistakes the model can fix (unknown id, refused write) come back as a ToolResult with
// data.error and isError: true.
//
// Transports: stdio (the default; stdout carries only protocol frames) and Streamable HTTP behind `--http`, stateless
// (a fresh server per request), JSON responses, bound to 127.0.0.1 and refusing other Host headers (DNS rebinding).
import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { ToolResult } from "../../shared/contracts.js";
import { isWriteTool } from "../agent/runtime.js";
import { TouchedSet, type AlleviaTool, type ToolContext } from "../agent/tool.js";
import { toolsByName } from "../agent/tools/index.js";
import type { GraphHandle } from "../graph/client.js";

export const MCP_SERVER_NAME = "allevia";
export const MCP_SERVER_VERSION = "0.1.0";

// The read-only tools Jarvis gets (spec §10, plus the other pure reads it needs to explain an answer).
export const MCP_TOOL_NAMES = [
  "search", "get_entity", "neighbors", "find_paths", "trace_decision", "who_owns", "who_knows", "impact_of",
  "metric_trend", "recall", "cypher",
] as const;

// Who the calls are attributed to in a ToolContext. Read tools do not record it; it only names the caller in errors.
const MCP_AGENT_ID = "mcp-client";

export interface McpServerOpts {
  tenant: string;
  graph: GraphHandle;
  embedQuery?: ToolContext["embedQuery"]; // vector search; absent = full-text only
  asker?: string;                         // default person:founder (Jarvis is the founder's agent)
  now?: () => number;
  tools?: AlleviaTool[];                  // default: MCP_TOOL_NAMES (tests pass others to prove writes are refused)
}

const INSTRUCTIONS =
  "Allevia's company brain for one business, read-only. Start with `search` to find ids, then follow them with " +
  "get_entity, neighbors, trace_decision, who_owns/who_knows, impact_of, metric_trend, find_paths or recall. Every " +
  "result is JSON: data plus the nodes and sources it came from, so cite node ids and source titles. `cypher` is " +
  "GRAPH.RO_QUERY only. Nothing here can change the graph.";

let callSeq = 0;

export function createMcpServer(opts: McpServerOpts): McpServer {
  const tools = opts.tools ?? toolsByName([...MCP_TOOL_NAMES]);
  const writers = tools.filter(isWriteTool).map((t) => t.name);
  if (writers.length) throw new Error(`The MCP server is read-only; refusing to expose ${writers.join(", ")}.`);

  const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION }, { instructions: INSTRUCTIONS });
  const now = opts.now ?? (() => Date.now());
  for (const tool of tools) {
    server.registerTool(tool.name, {
      description: tool.description,
      inputSchema: tool.input,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async (args: unknown) => {
      const ctx: ToolContext = {
        graph: opts.graph, tenant: opts.tenant, turnId: `mcp-${++callSeq}`, agentId: MCP_AGENT_ID,
        asker: opts.asker ?? "person:founder", touched: new TouchedSet(), now: now(), readOnly: true,
        ...(opts.embedQuery ? { embedQuery: opts.embedQuery } : {}),
      };
      const result: ToolResult = await tool.run(args as never, ctx);
      const failed = !!result.data && typeof result.data === "object" && "error" in (result.data as object);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
        ...(failed ? { isError: true } : {}),
      };
    });
  }
  return server;
}

// ---------- stdio ----------

// Serves MCP on this process's stdin/stdout until stdin closes or the process is told to stop.
export async function serveStdio(opts: McpServerOpts): Promise<void> {
  const server = createMcpServer(opts);
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    const done = () => resolve();
    process.stdin.once("end", done);
    process.stdin.once("close", done);
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
    transport.onclose = done;
  });
  await server.connect(transport);
  await closed;
  await server.close().catch(() => undefined);
}

// ---------- Streamable HTTP ----------

// Decides whether an HTTP request may use this server (the server is bound to one business, so this is "may it read that
// business"). Absent: loopback-only is the whole guard (local development). The CLI passes a bearer-token check when
// ALLEVIA_AUTH=1 (src/cli/mcp.ts).
export type McpAuthorize = (req: Request) => Promise<boolean>;

export interface McpHttpOpts extends McpServerOpts {
  authorize?: McpAuthorize;
  port: number;
  host?: string; // default 127.0.0.1
  path?: string; // default /mcp
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

// A Hono app serving MCP at `path`, stateless: each POST gets a fresh server and transport over the same graph.
// Requests whose Host is not a loopback name (with this port) are refused, so a web page cannot rebind DNS onto it.
export function createMcpHttpApp(opts: McpServerOpts & { port: number; path?: string; authorize?: McpAuthorize }): Hono {
  const path = opts.path ?? "/mcp";
  const allowed = new Set([...LOOPBACK].map((h) => `${h}:${opts.port}`));
  const app = new Hono();
  app.use("*", async (c, next) => {
    const host = (c.req.header("host") ?? new URL(c.req.url).host).toLowerCase(); // node-server builds the URL from Host
    if (!allowed.has(host)) return c.json({ error: "Allevia's MCP server only answers on localhost." }, 403);
    const origin = c.req.header("origin");
    if (origin) {
      let ok = false;
      try { ok = LOOPBACK.has(new URL(origin).hostname === "::1" ? "[::1]" : new URL(origin).hostname); } catch { ok = false; }
      if (!ok) return c.json({ error: "Cross-origin requests are not allowed." }, 403);
    }
    if (opts.authorize && !(await opts.authorize(c.req.raw))) {
      return c.json({ error: "This business is private. Send its owner link as `Authorization: Bearer <token>`." }, 401);
    }
    await next();
  });
  app.post(path, async (c) => {
    const server = createMcpServer(opts);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });
  app.all(path, (c) => c.json({ error: "This MCP server is stateless: POST JSON-RPC messages here." }, 405));
  app.notFound((c) => c.json({ error: `Not found. MCP is served at ${path}.` }, 404));
  return app;
}

export async function serveHttp(opts: McpHttpOpts): Promise<{ url: string; close: () => Promise<void> }> {
  const { serve } = await import("@hono/node-server");
  const host = opts.host ?? "127.0.0.1";
  const app = createMcpHttpApp(opts);
  const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    const s = serve({ fetch: app.fetch, port: opts.port, hostname: host }, () => resolve(s));
    s.once("error", reject);
  });
  return {
    url: `http://${host}:${opts.port}${opts.path ?? "/mcp"}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
