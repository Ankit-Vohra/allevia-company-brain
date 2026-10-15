// Showcase turns (spec §11.3): the turns the public demo replays. setShowcase marks or unmarks a stored turn; only a
// finished turn with a stored event log can be marked, since public mode replays that log.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { listShowcase, saveTurn, setShowcase, startSession } from "../../src/agent/memory.js";
import { turnEvents } from "../../src/server/reads.js";
import { testGraph } from "../helpers/graph.js";
import { NOW } from "../helpers/agent.js";

describe("showcase turns", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  const save = (turnId: string, status: "ok" | "failed", events = true) => saveTurn(g, {
    turnId, sessionId: "session:s1", question: `Question ${turnId}`, answer: "Answer.", asker: "person:founder", at: NOW, status,
    agents: ["chief-of-staff"], events: events ? [{ type: "final", turnId, answer: "Answer.", citations: [], agents: [], ms: 1,
      checks: { citationsValid: true, invalidCitations: [], numbersGrounded: true, ungroundedNumbers: [], simulatedDisclosed: true, freshnessDisclosed: true } }] : [],
    touched: [], citations: [], findings: [], reviews: [],
  });

  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await ensureIndexes(g);
    await startSession(g, { channel: "cli", asker: "person:founder", title: "t", id: "session:s1" }, NOW);
    await save("turn:ok-1", "ok");
    await save("turn:ok-2", "ok");
    await save("turn:failed", "failed");
  });
  afterAll(async () => {
    await cleanup();
    await closeAll();
  });

  it("marks a finished turn, so public mode can replay it, and lists it", async () => {
    expect(await turnEvents(g, "turn:ok-1", { showcaseOnly: true })).toBeNull();
    expect(await setShowcase(g, "turn:ok-1", true)).toMatchObject({ id: "turn:ok-1", question: "Question turn:ok-1", showcase: true });
    expect(await turnEvents(g, "turn:ok-1", { showcaseOnly: true })).toHaveLength(1);
    expect((await listShowcase(g)).map((t) => t.id)).toEqual(["turn:ok-1"]);
  });

  it("is idempotent and can be undone", async () => {
    await setShowcase(g, "turn:ok-2", true);
    await setShowcase(g, "turn:ok-2", true);
    expect((await listShowcase(g)).map((t) => t.id).sort()).toEqual(["turn:ok-1", "turn:ok-2"]);
    expect(await setShowcase(g, "turn:ok-2", false)).toMatchObject({ showcase: false });
    expect((await listShowcase(g)).map((t) => t.id)).toEqual(["turn:ok-1"]);
  });

  it("refuses a missing turn and a failed one", async () => {
    await expect(setShowcase(g, "turn:nope", true)).rejects.toThrow(/No turn turn:nope/);
    await expect(setShowcase(g, "turn:failed", true)).rejects.toThrow(/failed/);
    expect((await listShowcase(g)).map((t) => t.id)).toEqual(["turn:ok-1"]);
  });
});
