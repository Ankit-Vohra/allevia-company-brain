// The cached projections (throwaway copies of a graph's current edges that the graph algorithms run on) are kept per graph
// name, with a write stamp per graph. Two businesses served by one process never see each other's, however the calls
// interleave, and a write to one invalidates only its own.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pageRank } from "../../src/graph/algorithms.js";
import { closeAll, connect, listGraphs, type GraphHandle } from "../../src/graph/client.js";
import { upsertEdge, upsertNode } from "../../src/graph/upsert.js";
import { SEED_NOW } from "../fixtures/seed-graph.js";
import { seededGraph } from "../helpers/tools.js";

let a: GraphHandle;
let b: GraphHandle;
const A_ONLY = "memory:a-only-projection";
const B_ONLY = "memory:b-only-projection";

async function add(g: GraphHandle, id: string): Promise<void> {
  await upsertNode(g, { type: "Memory", id, name: id, props: { kind: "note", text: id, at: SEED_NOW } }, SEED_NOW);
  await upsertEdge(g, { from: id, type: "ABOUT", to: "decision:007-pause-daily-stories" }, SEED_NOW);
}
const ids = async (g: GraphHandle) => (await pageRank(g, "Entity")).map((r) => r.id);

beforeAll(async () => {
  ({ g: a } = await seededGraph());
  ({ g: b } = await seededGraph());
  await add(a, A_ONLY);
  await add(b, B_ONLY);
}, 60_000);
afterAll(async () => { await a?.drop(); await b?.drop(); await closeAll(); });

describe("projection cache", () => {
  it("each graph's algorithm sees its own nodes, on a cold cache and a warm one, in any order", async () => {
    for (const order of [[a, b], [b, a], [a, a, b, b, a, b]]) {
      for (const g of order) {
        const seen = await ids(g);
        expect(seen).toContain(g === a ? A_ONLY : B_ONLY);
        expect(seen).not.toContain(g === a ? B_ONLY : A_ONLY);
      }
    }
  });

  it("a write to one graph rebuilds that graph's projection only", async () => {
    await ids(a); await ids(b); // both warm
    await add(a, "memory:a-second-projection");
    expect(await ids(a)).toContain("memory:a-second-projection");
    expect(await ids(b)).not.toContain("memory:a-second-projection");
  });

  it("a projection is named after its own graph, and is not a business of its own", async () => {
    await ids(a);
    const names = await (await connect()).list();
    const mine = names.filter((n) => n.startsWith(`${a.name}__`));
    const theirs = names.filter((n) => n.startsWith(`${b.name}__`));
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((n) => !n.startsWith(`${b.name}__`))).toBe(true);
    expect(theirs.every((n) => !n.startsWith(`${a.name}__`))).toBe(true);
    expect((await listGraphs()).some((n) => n.includes("__"))).toBe(false); // listGraphs (what tenantGraph checks) never returns one
  });
});
