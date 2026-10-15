// A stand-in for the aamdani-ops MCP server, spoken to over stdio by tests/ingest/ops.test.ts so the real OpsClient
// (listTools, callTool, per-call timeout, close) is exercised without SSH or the production box. Synthetic answers only.
// Every call is appended to the file named by FAKE_OPS_CALL_LOG, so a test can prove which tools were really called.
import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const TOOLS: Array<{ name: string; readOnly?: boolean }> = [
  { name: "users_summary", readOnly: true },
  { name: "ai_features", readOnly: true },      // answers slowly: the timeout test
  { name: "marketplace", readOnly: false },     // on the allow-list, but this server says it is not read-only
  { name: "new_users" },                        // on the allow-list, no readOnlyHint at all
  { name: "brain_add_note", readOnly: false },  // a write the client must never call
  { name: "server_health", readOnly: true },    // infrastructure: listed but not on the allow-list
];

const server = new Server({ name: "fake-aamdani-ops", version: "0.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({
    name: t.name, description: `fake ${t.name}`, inputSchema: { type: "object" as const, properties: {} },
    ...(t.readOnly === undefined ? {} : { annotations: { readOnlyHint: t.readOnly } }),
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  if (process.env.FAKE_OPS_CALL_LOG) appendFileSync(process.env.FAKE_OPS_CALL_LOG, `${name}\n`);
  if (name === "ai_features") await new Promise((r) => setTimeout(r, 3_000));
  const envelope = {
    tool: name, status: "ok", asOf: "2026-10-15T03:00:00.000Z", asOfIST: "2026-10-15 08:30 IST", sources: ["fake"],
    data: { totals: { all: 17 }, args: req.params.arguments ?? {} },
  };
  return { content: [{ type: "text" as const, text: JSON.stringify(envelope) }], structuredContent: envelope };
});

await server.connect(new StdioServerTransport());
