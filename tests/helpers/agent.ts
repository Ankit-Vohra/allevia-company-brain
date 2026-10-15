// Fakes for agent tests: small tools with fixed results, a ToolContext over a stub graph, and an event recorder.
import { z } from "zod";
import type { AgentEvent, ToolResult } from "../../shared/contracts.js";
import type { GraphHandle } from "../../src/graph/client.js";
import { TouchedSet, type AlleviaTool, type ToolContext } from "../../src/agent/tool.js";

export const NOW = Date.parse("2026-10-15T06:00:00Z");

export function result(partial: Partial<ToolResult> & { data: unknown }): ToolResult {
  return { nodes: [], edges: [], sources: [], ...partial };
}

export function fakeTool(
  name: string,
  out: ToolResult | ((args: Record<string, unknown>, ctx: ToolContext) => ToolResult | Promise<ToolResult>),
  input: z.ZodRawShape = { query: z.string().optional(), id: z.string().optional(), metric: z.string().optional() },
): AlleviaTool & { calls: Array<{ args: Record<string, unknown>; agentId: string }> } {
  const calls: Array<{ args: Record<string, unknown>; agentId: string }> = [];
  return {
    name, description: `fake ${name}`, input, calls,
    async run(args, ctx) {
      calls.push({ args: args as Record<string, unknown>, agentId: ctx.agentId });
      return typeof out === "function" ? out(args as Record<string, unknown>, ctx) : out;
    },
  };
}

export function stubCtx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    graph: {} as GraphHandle, tenant: "test", turnId: "turn:t1", agentId: "nobody", asker: "person:founder",
    touched: new TouchedSet(), now: NOW, ...over,
  };
}

export function recorder(): { events: AgentEvent[]; emit: (e: AgentEvent) => void; types: () => string[] } {
  const events: AgentEvent[] = [];
  return { events, emit: (e) => events.push(e), types: () => events.map((e) => e.type) };
}
