// LIVE: one real directive parse through the Agent SDK on the founder's subscription (haiku), for the parts the rules
// can't read. Skipped unless ALLEVIA_LIVE_LLM=1; it costs plan usage, so run it by hand when the prompt or schema changes.
import { describe, it, expect } from "vitest";
import { closeAll } from "../../src/graph/client.js";
import { ensureRoster } from "../../src/agent/memory.js";
import { writeBatch } from "../../src/graph/upsert.js";
import { previewDirective } from "../../src/settings/directives.js";
import { testGraph } from "../helpers/graph.js";

describe.skipIf(process.env.ALLEVIA_LIVE_LLM !== "1")("live directive parse (Agent SDK, haiku)", () => {
  it("turns what the rules can't read into valid patches", { timeout: 180_000 }, async () => {
    const { g, cleanup } = await testGraph();
    try {
      await writeBatch(g, { nodes: [{ type: "Channel", id: "channel:linkedin", name: "LinkedIn" }, { type: "Channel", id: "channel:instagram", name: "Instagram" }] });
      await ensureRoster(g);
      const started = Date.now();
      // Rules read the first clause (a toggle); the second goes to haiku.
      const pv = await previewDirective(g, { text: "Switch Arjun off till the new site launches; give Rohan a lighter load this month and keep Tara's LinkedIn captions under 30 words" });
      console.log(JSON.stringify({ ms: Date.now() - started, parser: pv.parser, patches: pv.patches, unparsed: pv.unparsed, notes: pv.notes }, null, 1));
      expect(pv.parser).toBe("rules+llm");
      expect(pv.patches[0]).toEqual({ kind: "agent.enabled", agent: "tech-lead", enabled: false, note: "till the new site launches" });
      expect(pv.patches.length).toBeGreaterThan(1);
      expect(pv.patches.some((p) => p.kind === "memory.instruction" && p.agents.includes("content-strategist"))).toBe(true);
    } finally {
      await cleanup();
      await closeAll();
    }
  });
});
