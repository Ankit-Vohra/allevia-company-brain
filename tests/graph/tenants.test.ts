import { describe, it, expect, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { closeAll, openGraph, openGraphByName, MAX_PAGE } from "../../src/graph/client.js";
import { listIndexes } from "../../src/graph/indexes.js";
import { ensureTenant, getTenant, listTenants, businessId } from "../../src/graph/tenants.js";
import { entityId } from "../../src/util/ids.js";
import { testGraphName } from "../helpers/graph.js";

// Never touches the real allevia_meta: the registry goes into a throwaway allevia_test_* graph, and the tenant slug
// starts with test_ so its graph is allevia_test_* too.
const metaGraph = testGraphName();
const slug = `test_${randomBytes(5).toString("hex")}`;
const opts = { metaGraph };

describe("tenants (integration)", () => {
  afterAll(async () => {
    await (await openGraphByName(metaGraph)).drop();
    await (await openGraph(slug)).drop();
    await closeAll();
  });

  it("derives the Business id with the same rule as entityId", () => {
    expect(businessId("avs_atelier")).toBe("business:avs-atelier");
    expect(businessId("avs_atelier")).toBe(entityId("Business", "avs_atelier"));
    expect(businessId(slug)).toBe(entityId("Business", slug)); // the test slug has an underscore too
  });

  it("lists nothing before the registry exists", async () => {
    expect(await listTenants(opts)).toEqual([]);
    expect(await getTenant(slug, opts)).toBeNull();
  });

  it("creates the tenant, its Business node and its indexes", async () => {
    const t = await ensureTenant({ slug, name: "Aamdani Test", domain: "aamdani.ai", industry: "jobs", city: "Raipur" }, opts);
    expect(t).toMatchObject({ slug, name: "Aamdani Test", domain: "aamdani.ai", industry: "jobs", city: "Raipur",
      graph: `allevia_${slug}`, businessId: entityId("Business", slug), ontologyVersion: 1 });
    expect(typeof t.createdAt).toBe("number");
    const g = await openGraph(slug);
    const [b] = await g.roQuery<Record<string, unknown>>("MATCH (b:Entity:Business {id:$id}) RETURN b.name AS name, b.domain AS domain, b.city AS city", { id: businessId(slug) });
    expect(b).toEqual({ name: "Aamdani Test", domain: "aamdani.ai", city: "Raipur" });
    expect((await listIndexes(g)).length).toBeGreaterThanOrEqual(6);
  });

  it("is idempotent and updates in place", async () => {
    const first = (await getTenant(slug, opts))!;
    const again = await ensureTenant({ slug, name: "Aamdani Test" }, opts);
    expect(again).toEqual(first); // omitted optional fields keep their values; nothing changed
    const renamed = await ensureTenant({ slug, name: "Aamdani" }, opts);
    expect(renamed.createdAt).toBe(first.createdAt);
    expect(renamed.name).toBe("Aamdani");
    expect(renamed.domain).toBe("aamdani.ai");
    const meta = await openGraphByName(metaGraph);
    expect(await meta.roQuery("MATCH (t:Tenant) RETURN count(t) AS c")).toEqual([{ c: 1 }]);
    const g = await openGraph(slug);
    expect(await g.roQuery("MATCH (b:Business) RETURN count(b) AS c, collect(b.name) AS names")).toEqual([{ c: 1, names: ["Aamdani"] }]);
    expect((await listTenants(opts)).map((t) => t.slug)).toEqual([slug]);
  });

  it("rejects bad slugs and empty names", async () => {
    await expect(ensureTenant({ slug: "Bad-Slug", name: "x" }, opts)).rejects.toThrow(/tenant slug/);
    await expect(ensureTenant({ slug, name: " " }, opts)).rejects.toThrow(/name/);
  });

  it("lists every tenant, past the 10,000 rows one result can hold", async () => {
    const big = testGraphName();
    const meta = await openGraphByName(big);
    try {
      const n = MAX_PAGE * 2 + 3;
      await meta.query("UNWIND range(1, $n) AS i CREATE (:Tenant {slug: 'test_t' + toString(100000 + i), name: 'T', graph: 'x', businessId: 'b', ontologyVersion: 1, createdAt: 1, updatedAt: 1})", { n });
      const all = await listTenants({ metaGraph: big });
      expect(all).toHaveLength(n);
      expect(all[0]!.slug).toBe("test_t100001");
      expect(all.at(-1)!.slug).toBe(`test_t${100000 + n}`);
      expect(new Set(all.map((t) => t.slug)).size).toBe(n);
    } finally {
      await meta.drop();
    }
  });
});
