import { describe, it, expect, afterAll } from "vitest";
import {
  graphName, connect, listGraphs, closeAll, openGraph, openGraphByName, projectionName, isProjectionName, sweepProjections,
  type GraphHandle,
} from "../../src/graph/client.js";
import { testGraph } from "../helpers/graph.js";

describe("graphName", () => {
  it("prefixes and validates tenants", () => {
    expect(graphName("aamdani")).toBe("allevia_aamdani");
    expect(graphName("avs_atelier2")).toBe("allevia_avs_atelier2");
    expect(() => graphName("Bad-Name")).toThrow(/tenant/);
    expect(() => graphName("")).toThrow(/tenant/);
    expect(() => graphName("a b")).toThrow(/tenant/);
    // "__" is reserved for projections (<graph>__cur_…), so no tenant graph can look like one
    expect(() => graphName("shop__cur_1_deadbeef")).toThrow(/tenant/);
    expect(() => graphName("shop__x")).toThrow(/tenant/);
    expect(() => graphName("_shop")).toThrow(/tenant/);
    expect(() => graphName("shop_")).toThrow(/tenant/);
  });
});

describe("client (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  afterAll(async () => {
    await cleanup?.();
    await closeAll();
  });

  it("connects once per url", async () => {
    expect(await connect()).toBe(await connect());
  });

  it("writes with query and reads with roQuery", async () => {
    ({ g, cleanup } = await testGraph());
    expect(g.name).toMatch(/^allevia_test_/);
    await g.query("CREATE (:Entity:Task {id: $id, name: $name, tags: $tags})", { id: "task:a", name: "नमस्ते \"quoted\"", tags: ["x", "y"] });
    const rows = await g.roQuery<{ id: string; name: string; tags: string[] }>("MATCH (n:Entity) RETURN n.id AS id, n.name AS name, n.tags AS tags");
    expect(rows).toEqual([{ id: "task:a", name: "नमस्ते \"quoted\"", tags: ["x", "y"] }]);
    expect(await listGraphs()).toContain(g.name);
  });

  it("passes map params", async () => {
    const rows = await g.query<{ s: string; n: number }>("MATCH (n:Entity {id: $id}) SET n += $props RETURN n.status AS s, n.count AS n",
      { id: "task:a", props: { status: "open", count: 3, skipped: undefined } });
    expect(rows).toEqual([{ s: "open", n: 3 }]);
  });

  it("rejects writes on the read-only path", async () => {
    await expect(g.roQuery("CREATE (:X)")).rejects.toThrow(/read-only/);
    await expect(g.roQuery("MATCH (n) SET n.x = 1")).rejects.toThrow(/read-only/);
    await expect(g.roQuery("MATCH (n) DETACH DELETE n")).rejects.toThrow(/read-only/);
    expect(await g.roQuery("MATCH (n:X) RETURN count(n) AS c")).toEqual([{ c: 0 }]);
  });

  it("enforces a server-side timeout on reads", async () => {
    await expect(g.roQuery("UNWIND range(1, 3000000) AS x WITH x WHERE x % 7 = 0 RETURN count(x) AS c", {}, { timeoutMs: 1 }))
      .rejects.toThrow(/timed out/i);
  });

  it("refuses params the wire format cannot carry", async () => {
    await expect(g.roQuery("RETURN $x AS x", { x: Number.NaN })).rejects.toThrow(/finite/);
    await expect(g.roQuery("RETURN $x AS x", { x: { "bad-key": 1 } })).rejects.toThrow(/param key/);
  });

  it("drops the graph and tolerates a second drop", async () => {
    await g.drop();
    expect(await listGraphs()).not.toContain(g.name);
    await g.drop();
  });

  it("names projections, hides them from listGraphs and sweeps only stale ones", async () => {
    const base = g.name;
    const fresh = projectionName(base, "cur");
    expect(fresh.startsWith(`${base}__cur_`) && isProjectionName(fresh)).toBe(true);
    expect(isProjectionName(projectionName(base, "asof"))).toBe(true);
    expect(isProjectionName(base)).toBe(false);
    const stale = projectionName(base, "asof", Date.now() - 60 * 60_000);
    for (const name of [fresh, stale]) await (await openGraphByName(name)).query("CREATE (:X)");
    const raw = await (await connect()).list();
    expect(raw).toEqual(expect.arrayContaining([fresh, stale]));
    const listed = await listGraphs();
    expect(listed).not.toContain(fresh);
    expect(listed).not.toContain(stale);
    const dropped = await sweepProjections();
    expect(dropped).toContain(stale);
    expect(dropped).not.toContain(fresh); // could belong to a live algorithm call in another process
    const after = await (await connect()).list();
    expect(after).not.toContain(stale);
    await (await openGraphByName(fresh)).drop();
  });

  it("opens tenant graphs by slug", async () => {
    const t = await openGraph("test_never_written");
    expect(t.name).toBe("allevia_test_never_written");
    expect(await listGraphs()).not.toContain(t.name); // opening does not create
  });
});
