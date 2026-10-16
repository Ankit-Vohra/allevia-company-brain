// Today's note says what changed in the business, not what the filing system did: re-reading a website ends and begins
// "sourced from" edges every time, and a fresh business's first note listed them as "Changed: Cafe no longer sourced from
// Web page: About Us" (audit #39).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { closeEdge, upsertEdge, upsertNode } from "../../src/graph/upsert.js";
import { writeBrief } from "../../src/insights/brief.js";
import { testGraph } from "../helpers/graph.js";

const NOW = Date.parse("2026-10-16T05:00:00Z");
let g: GraphHandle;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  ({ g, cleanup } = await testGraph());
  await upsertNode(g, { type: "Business", id: "business:cafe", name: "Cafe" }, NOW - 3 * 86_400_000);
  await upsertNode(g, { type: "Page", id: "page:cafe/about", name: "About Us" }, NOW - 3 * 86_400_000);
  await upsertNode(g, { type: "Document", id: "document:web-about", name: "Web page: About Us" }, NOW - 3 * 86_400_000);
  await upsertNode(g, { type: "Person", id: "person:sam", name: "Sam" }, NOW - 3 * 86_400_000);
  await upsertNode(g, { type: "Task", id: "task:menu", name: "Update the menu" }, NOW - 3 * 86_400_000);
  await upsertEdge(g, { from: "page:cafe/about", type: "SOURCED_FROM", to: "document:web-about" }, NOW - 3 * 86_400_000);
  await upsertEdge(g, { from: "person:sam", type: "OWNS", to: "task:menu" }, NOW - 3 * 86_400_000);
  await closeEdge(g, "page:cafe/about", "SOURCED_FROM", "document:web-about", NOW - 3_600_000);
  await closeEdge(g, "person:sam", "OWNS", "task:menu", NOW - 3_600_000);
});
afterAll(async () => { await cleanup(); await closeAll(); });

describe("what changed since yesterday", () => {
  it("names a real change and leaves out where a fact was read from", async () => {
    const b = await writeBrief("test", { graph: g, now: NOW, since: NOW - 86_400_000 });
    expect(b.text).toContain("Changed: Sam no longer owns Update the menu.");
    expect(b.text).not.toMatch(/sourced from/i);
    expect(b.closed.examples.map((e) => e.type)).toEqual(["OWNS"]);
  });
});
