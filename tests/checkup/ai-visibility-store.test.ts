// AI visibility runs stored in a throwaway graph: the report Document is the source of the Business's reading, and the
// latest runs read back newest first.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GraphHandle } from "../../src/graph/client.js";
import { upsertNode, writeBatch } from "../../src/graph/upsert.js";
import { aiVisibilityWrite, storedAiRuns, type AiVisibilityRun } from "../../src/checkup/ai-visibility.js";
import { testGraph } from "../helpers/graph.js";

const run = (asOf: string, mentioned: number): AiVisibilityRun => ({
  asOf, model: "sonnet", business: { name: "AV's Atelier", category: "interior architect", city: "Raipur" }, asked: 4, answered: 4, mentioned,
  mentionPct: mentioned * 25,
  answers: Array.from({ length: 4 }, (_, i) => ({ question: `q${i}`, answered: true, answer: "a", named: [], mentioned: i < mentioned, cited: false, position: null, others: ["Studio Tara"] })),
});

describe("stored AI visibility runs", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await upsertNode(g, { type: "Business", id: "business:avs", name: "AV's Atelier" }, Date.now());
  });
  afterAll(async () => { await cleanup(); });

  it("reads back the latest runs with their mention share", async () => {
    for (const r of [run("2026-09-15T09:00:00Z", 0), run("2026-10-15T09:00:00Z", 1)]) {
      const s = await writeBatch(g, aiVisibilityWrite(r, "business:avs"), Date.now());
      expect(s.errors).toEqual([]);
    }
    const got = await storedAiRuns(g, 2);
    expect(got.map((x) => [x.asOf, x.mentionPct])).toEqual([["2026-10-15T09:00:00Z", 25], ["2026-09-15T09:00:00Z", 0]]);
    expect(got[0]!.others).toEqual(["Studio Tara|4"]);
  });
});
