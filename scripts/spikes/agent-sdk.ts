// Spike: Claude Agent SDK on the founder's subscription, with ONLY our in-process tools, no user settings/hooks,
// streaming events, and a structured (JSON-schema) final answer. Run from an empty cwd so no CLAUDE.md is picked up.
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const calls: string[] = [];
const server = createSdkMcpServer({
  name: "allevia",
  version: "0.0.1",
  tools: [
    tool("lookup_metric", "Look up a metric value for a business from the graph.", { metric: z.string() }, async (args) => {
      calls.push(`lookup_metric:${args.metric}`);
      return { content: [{ type: "text", text: JSON.stringify({ metric: args.metric, value: 55, asOf: "2026-10-05", nodeIds: ["obs:signups:2026-10-05"] }) }] };
    }),
  ],
});

const env = { ...process.env }; delete env.ANTHROPIC_API_KEY;
const started = Date.now();
const kinds: Record<string, number> = {};
let final: unknown;
for await (const m of query({
  prompt: "How many signups did we get in the last 7 days? Use the tool, then answer in one sentence citing the node id.",
  options: {
    cwd: process.argv[2],
    model: "haiku",
    systemPrompt: "You are Allevia, a company brain. Only answer from tool results.",
    settingSources: [],
    mcpServers: { allevia: server },
    allowedTools: ["mcp__allevia__lookup_metric"],
    tools: [],
    permissionMode: "dontAsk",
    includePartialMessages: true,
    maxTurns: 4,
    env,
    outputFormat: { type: "json_schema", schema: { type: "object", properties: { answer: { type: "string" }, citations: { type: "array", items: { type: "string" } } }, required: ["answer", "citations"] } },
  },
})) {
  const k = m.type + ("subtype" in m && m.subtype ? ":" + m.subtype : "");
  kinds[k] = (kinds[k] ?? 0) + 1;
  if (m.type === "system" && m.subtype === "init") console.log("init tools:", (m as any).tools, "| model:", (m as any).model, "| apiKeySource:", (m as any).apiKeySource);
  if (m.type === "result") final = { subtype: m.subtype, structured: (m as any).structured_output, result: (m as any).result, cost: (m as any).total_cost_usd };
}
console.log("event kinds:", kinds);
console.log("tool calls:", calls);
console.log("final:", JSON.stringify(final));
console.log("ms:", Date.now() - started);
