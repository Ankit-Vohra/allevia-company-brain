// ask() closes its stream at `final`: anything the turn emits afterwards (a run that outlived its stop) is dropped from
// both the stream and the stored replay log.
import { describe, it, expect, vi, afterAll } from "vitest";
import type { AgentEvent } from "../../shared/contracts.js";
import { closeAll } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { ask } from "../../src/agent/ask.js";
import { getTurnEvents } from "../../src/agent/memory.js";
import { FakeRuntime } from "../../src/agent/runtime.js";
import { TouchedSet } from "../../src/agent/tool.js";
import { testGraph } from "../helpers/graph.js";
import { NOW } from "../helpers/agent.js";

vi.mock("../../src/agent/orchestrator.js", async (importOriginal) => {
  const m = await importOriginal<typeof import("../../src/agent/orchestrator.js")>();
  return {
    ...m,
    runTurn: async (_input: unknown, _deps: unknown, emit: (e: AgentEvent) => void) => {
      emit({ type: "agent_status", agent: "data-analyst", text: "in time" });
      setTimeout(() => {
        emit({ type: "tool_result", agent: "growth-marketer", id: "g#1", name: "propose_action", summary: "late", nodes: [], edges: [], sources: [] });
        emit({ type: "proposal", agent: "growth-marketer", recommendationId: "recommendation:x", approvalId: "approval:x", title: "late", kind: "pause_ad" });
      }, 20);
      return {
        ok: true, answer: "Done.", plan: { steps: [], rationale: "" }, fastPath: true, findings: [], reviews: [], proposals: [],
        agents: ["chief-of-staff"], failed: [], touched: new TouchedSet(),
      };
    },
  };
});

afterAll(async () => { await closeAll(); });

describe("ask(): final is the last event", () => {
  it("drops events the turn emits after final, from the stream and the replay log", async () => {
    const { g, cleanup } = await testGraph();
    await ensureIndexes(g);
    try {
      const events: AgentEvent[] = [];
      const r = await ask({ tenant: "test", question: "Anything?", channel: "cli" }, { runtime: new FakeRuntime({}), getTools: () => [], graph: g, now: () => NOW }, (e) => events.push(e));
      expect(events.some((e) => e.type === "error")).toBe(false);
      await new Promise((res) => setTimeout(res, 60));
      expect(events.at(-1)!.type).toBe("final");
      expect(events.some((e) => e.type === "proposal")).toBe(false);
      const stored = (await getTurnEvents(g, r.turnId))!;
      expect(stored.at(-1)!.type).toBe("final");
      expect(stored.some((e) => e.type === "proposal")).toBe(false);
    } finally {
      await cleanup();
    }
  });
});
