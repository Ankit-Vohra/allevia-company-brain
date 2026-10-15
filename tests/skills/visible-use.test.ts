// Visible use: a skill opened in a turn is recorded on the Turn and its Finding (queryable), kept in the replay log, shown
// on the session's turns, and said in plain words in the work log (the web lanes read skill_used; their types are checked by the web build).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentEvent } from "../../shared/contracts.js";
import { ask } from "../../src/agent/ask.js";
import { ensureRoster, getTurnEvents } from "../../src/agent/memory.js";
import { FakeRuntime } from "../../src/agent/runtime.js";
import { codeCatalog } from "../../src/agent/skills/catalog.js";
import { toolsByName } from "../../src/agent/tools/index.js";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { writeBatch } from "../../src/graph/upsert.js";
import { sessionDetail } from "../../src/server/reads.js";
import { testGraph } from "../helpers/graph.js";
import { NOW } from "../helpers/agent.js";

describe("a skill used in a turn (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  const events: AgentEvent[] = [];
  let turnId = "";
  let sessionId = "";

  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await ensureIndexes(g);
    await writeBatch(g, { nodes: [{ type: "Business", id: "business:kestrel-oak", name: "Kestrel & Oak" }, { type: "Person", id: "person:founder", name: "Founder" }] }, NOW);
    await ensureRoster(g, { businessId: "business:kestrel-oak" }, NOW);
    const runtime = new FakeRuntime({
      "chief-of-staff:plan": { structured: { steps: [{ agent: "content-strategist", task: "Write the post" }], rationale: "content" } },
      "content-strategist": { calls: [{ name: "use_skill", args: { id: "instagram-post" } }], structured: { text: "A draft caption.", citations: [] } },
      "copy-editor": { calls: [{ name: "use_skill", args: { id: "brand-voice-check" } }], structured: { verdict: "ok", note: "On brand." } },
      "chief-of-staff:synthesis": { text: "Here is the post." },
    });
    const r = await ask({ tenant: "test", question: "Write an Instagram post", channel: "cli" }, { runtime, getTools: toolsByName, graph: g, now: () => NOW, skills: codeCatalog() }, (e) => events.push(e));
    turnId = r.turnId;
    sessionId = r.sessionId;
  }, 60_000);
  afterAll(async () => { await cleanup(); await closeAll(); });

  it("is saved on the Turn as agent/skill ids, and on the Finding of the person who used it", async () => {
    const [t] = await g.roQuery<{ skills: string[] }>("MATCH (t:Entity:Turn {id:$id}) RETURN t.skills AS skills", { id: turnId });
    expect(t!.skills).toEqual(["content-strategist/instagram-post", "copy-editor/brand-voice-check"]);
    const [f] = await g.roQuery<{ skills: string[] }>("MATCH (f:Finding)-[:PART_OF]->(t:Entity:Turn {id:$id}) RETURN f.skills AS skills", { id: turnId });
    expect(f!.skills).toEqual(["instagram-post"]);
  });

  it("can be asked for: which turns used this skill", async () => {
    const rows = await g.roQuery<{ id: string }>("MATCH (t:Turn) WHERE 'content-strategist/instagram-post' IN t.skills RETURN t.id AS id ORDER BY t.id");
    expect(rows.map((r) => r.id)).toEqual([turnId]);
  });

  it("is in the replay log and on the session's turns", async () => {
    const log = (await getTurnEvents(g, turnId))!;
    expect(log.filter((e) => e.type === "skill_used").map((e) => e.type === "skill_used" && e.skillId)).toEqual(["instagram-post", "brand-voice-check"]);
    const detail = (await sessionDetail(g, sessionId, { showcaseOnly: false }))!;
    expect(detail.turns[0]!.skills).toEqual(["content-strategist/instagram-post", "copy-editor/brand-voice-check"]);
  });

  it("says so in plain words on the office floor: 'Tara is using: Instagram post craft'", () => {
    const said = events.filter((e) => e.type === "agent_status").map((e) => e.type === "agent_status" && e.text);
    expect(said).toContain("Tara is using: Instagram post craft");
    expect(said).toContain("Dev is using: Brand voice check");
  });
});
