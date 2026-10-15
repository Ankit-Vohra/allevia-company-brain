// Harness for agent-tool tests: a seeded throwaway graph, a ToolContext bound to it (pinned clock, fake embedder),
// and call(), which validates args through the tool's zod shape the way the runtime does before run().
import { z } from "zod";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { TouchedSet, type AlleviaTool, type ToolContext } from "../../src/agent/tool.js";
import type { ToolResult } from "../../shared/contracts.js";
import { fakeEmbed, seedMini, SEED_NOW } from "../fixtures/seed-graph.js";
import { testGraph } from "./graph.js";

// The test server is shared (and small: 2 threads, 25 queued queries); when its queue is full it refuses a query
// before running it, so a refused seed is dropped and tried again. Any other failure drops the graph and throws.
const BUSY = /max pending queries/i;
export const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function whenFree<T>(fn: () => Promise<T>, tries = 5): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= tries || !BUSY.test(String((e as Error)?.message))) throw e;
      await pause(250 * 2 ** attempt * (0.5 + Math.random()));
    }
  }
}

export async function seededGraph(): Promise<{ g: GraphHandle; cleanup: () => Promise<void> }> {
  return whenFree(async () => {
    const { g, cleanup } = await testGraph();
    try {
      await seedMini(g);
    } catch (e) {
      await cleanup().catch(() => undefined); // a failed seed must not leave its graph on the shared server
      throw e;
    }
    return { g, cleanup: async () => { await cleanup(); await closeAll(); } };
  });
}

export function makeCtx(g: GraphHandle, over: Partial<ToolContext> = {}): ToolContext {
  return {
    graph: g, tenant: "test", turnId: "t-100", agentId: "chief-of-staff", asker: "person:founder", touched: new TouchedSet(),
    now: SEED_NOW, embedQuery: async (text: string) => fakeEmbed(text), ...over,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function call(tool: AlleviaTool, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult<any>> {
  return tool.run(z.object(tool.input).parse(args), ctx);
}

export const ids = (xs: Array<{ id: string }>): string[] => xs.map((x) => x.id);
