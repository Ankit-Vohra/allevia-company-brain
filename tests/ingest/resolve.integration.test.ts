// resolveExtraction's output must be writable as is: every node, edge and observation lands with no errors, and
// re-ingesting the same document changes nothing.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { upsertNode, writeBatch } from "../../src/graph/upsert.js";
import { resolveExtraction, type Extraction, type KnownEntity } from "../../src/ingest/extract.js";
import { testGraph } from "../helpers/graph.js";

const text = readFileSync(new URL("../fixtures/extract/bakery-decision.md", import.meta.url), "utf8");
const DOC = "document:crumb-co-decision-pause-facebook";
const business: KnownEntity = { id: "business:crumb-co", type: "Business", name: "Crumb & Co." };
const T0 = 1_760_000_000_000;

// Shaped like the live Haiku output for the same fixture.
const extraction: Extraction = {
  entities: [
    { type: "Person", name: "Meher", summary: "The founder, who decided to pause Facebook posts.", aliases: ["the founder"] },
    { type: "Person", name: "Ravi", summary: "Prepares posts and will plan the October reel calendar." },
    { type: "Channel", name: "Instagram", summary: "Where reels drove 90% of reach." },
    { type: "Channel", name: "Facebook", summary: "Posts paused from 1 October 2026." },
    { type: "Decision", name: "Pause Facebook posts", summary: "Pause Facebook posts from 1 October 2026." },
    { type: "Task", name: "Plan the October reel calendar", summary: "Ravi plans the October reel calendar by 5 Oct." },
  ],
  relations: [
    { from: "Meher", fromType: "Person", type: "DECIDED", to: "Pause Facebook posts", toType: "Decision", evidence: "Decided by: Meher (founder)", conf: 0.95 },
    { from: "Pause Facebook posts", fromType: "Decision", type: "BASED_ON", to: "o1", toType: "Observation", evidence: "Instagram Reels drove 90% of our total reach", conf: 0.85 },
    { from: "Pause Facebook posts", fromType: "Decision", type: "AFFECTS", to: "Facebook", toType: "Channel", evidence: "Pause Facebook posts from 1 October 2026.", conf: 0.9 },
    { from: "Ravi", fromType: "Person", type: "OWNS", to: "Plan the October reel calendar", toType: "Task", evidence: "Ravi to plan the October reel calendar by 5 Oct.", conf: 0.95 },
    { from: "Instagram", fromType: "Channel", type: "PART_OF", to: "Crumb & Co.", toType: "Business", evidence: "We post on Instagram and Facebook.", conf: 0.8 },
  ],
  observations: [
    { ref: "o1", metric: "share_of_total_reach", subject: "Instagram", subjectType: "Channel", value: 90, unit: "%", asOf: "2026-09-28", evidence: "As of 2026-09-28, Instagram Reels drove 90% of our total reach" },
    { ref: "o2", metric: "weekly_hours_preparing_posts", subject: "Ravi", subjectType: "Person", value: 3, unit: "hours", evidence: "Preparing Facebook posts takes Ravi about 3 hours a week." },
  ],
};

describe("resolveExtraction → writeBatch (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await ensureIndexes(g);
    await upsertNode(g, { ...business }, T0);
    await upsertNode(g, { type: "Document", id: DOC, name: "Decision: pause Facebook posts" }, T0);
  });
  afterAll(async () => {
    await cleanup();
    await closeAll();
  });

  const counts = async () => (await g.roQuery<{ n: number; r: number }>(
    "MATCH (n:Entity) OPTIONAL MATCH (n)-[r]->() RETURN count(DISTINCT n) AS n, count(r) AS r"))[0]!;
  const resolve = () => resolveExtraction(extraction, {
    docId: DOC, asOf: "2026-09-30", text, existing: new Map([[business.id, business]]), founderNames: ["Meher"],
  });

  it("writes everything with no errors, and a second run creates nothing new", async () => {
    const first = await resolve();
    expect(first.dropped).toEqual([]);
    const s1 = await writeBatch(g, first.write, T0 + 1000);
    expect(s1.errors).toEqual([]);
    expect(s1).toMatchObject({ nodesCreated: 6, observations: 2, edgesCreated: first.write.edges.length });
    const path = await g.roQuery<Record<string, unknown>>(
      "MATCH (:Person {id:'person:founder'})-[:DECIDED]->(d:Decision)-[:BASED_ON]->(o:Observation)-[:MEASURES]->(c:Channel) RETURN d.id AS d, o.value AS v, c.id AS c");
    expect(path).toEqual([{ d: "decision:pause-facebook-posts", v: 90, c: "channel:instagram" }]);
    const after1 = await counts();

    const second = await resolve();
    const s2 = await writeBatch(g, second.write, T0 + 2000);
    expect(s2.errors).toEqual([]);
    expect(s2).toMatchObject({ nodesCreated: 0, nodesUpdated: 0, versions: 0, edgesCreated: 0, edgesClosed: 0 });
    expect(await counts()).toEqual(after1);
  });
});
