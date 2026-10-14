import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { GraphHandle } from "../../../src/graph/client.js";
import { whoKnows, whoOwns } from "../../../src/agent/tools/people.js";
import { call, ids, makeCtx, seededGraph } from "../../helpers/tools.js";

describe("who_owns, who_knows (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeAll(async () => ({ g, cleanup } = await seededGraph()), 60_000);
  afterAll(async () => cleanup());

  it("who_owns: the current owner, and the one before (closed edge)", async () => {
    const r = await call(whoOwns, { id: "task:fix-ig-token" }, makeCtx(g));
    expect(r.data.owners).toEqual([{ id: "person:priya", type: "Person", name: "Priya", since: "2026-10-05" }]);
    expect(r.data.previousOwners).toEqual([{ id: "person:founder", type: "Person", name: "Ankit", from: "2026-09-25", until: "2026-10-05" }]);
    expect(r.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: "person:priya", type: "OWNS", until: null }),
      expect.objectContaining({ from: "person:founder", type: "OWNS", until: Date.parse("2026-10-05") }),
    ]));
    expect(ids(r.sources)).toContain("document:pending");
    const then = await call(whoOwns, { id: "task:fix-ig-token", asOf: "2026-10-01" }, makeCtx(g));
    expect(then.data.owners.map((o: { id: string }) => o.id)).toEqual(["person:founder"]);
  });

  it("who_owns: team owners come with members; owners inherit through PART_OF; owners list what they own", async () => {
    const sys = await call(whoOwns, { query: "instagram connector" }, makeCtx(g));
    expect(sys.data.entity.id).toBe("system:ig-connector");
    expect(sys.data.owners.map((o: { id: string }) => o.id)).toEqual(["team:tech"]);
    expect(sys.data.teamMembers["team:tech"].map((m: { id: string }) => m.id)).toEqual(["agent:jarvis"]);
    const page = await call(whoOwns, { id: "page:www.aamdani.ai/jobs" }, makeCtx(g));
    expect(page.data.owners).toEqual([]);
    expect(page.data.ownedVia).toEqual([{ id: "team:tech", type: "Team", name: "Tech team", via: { id: "channel:website", type: "Channel", name: "Website" } }]);
    const team = await call(whoOwns, { id: "team:tech" }, makeCtx(g));
    expect(team.data.owns.map((o: { id: string }) => o.id).sort()).toEqual(["channel:website", "system:ig-connector", "system:reel-publisher"]);
    expect(team.note).toMatch(/No current owner/);
  });

  it("who_knows: ranked by weight, authored mentions and ownership", async () => {
    const r = await call(whoKnows, { id: "channel:instagram" }, makeCtx(g));
    expect(r.data.people.map((p: { id: string; score: number }) => [p.id, p.score])).toEqual([["person:founder", 7], ["person:priya", 3]]);
    expect(r.data.people[0]).toMatchObject({ knowsWeight: 5, docs: ["document:adr-007", "document:adr-003"].sort() });
    expect(r.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: "person:founder", type: "KNOWS_ABOUT", to: "channel:instagram" }),
      expect.objectContaining({ from: "person:founder", type: "AUTHORED" }),
    ]));
    expect(ids(r.nodes)).toEqual(expect.arrayContaining(["channel:instagram", "person:founder", "document:adr-007"]));
    expect(r.sources.length).toBeGreaterThan(0);
  });

  it("who_knows: a query resolves to topics, best match weighs most", async () => {
    const r = await call(whoKnows, { query: "instagram connector" }, makeCtx(g));
    expect(r.data.topics[0].id).toBe("system:ig-connector");
    expect(r.data.people[0].id).toBe("agent:jarvis");
    expect(r.data.people.map((p: { id: string }) => p.id)).toContain("team:tech");
  });
});
