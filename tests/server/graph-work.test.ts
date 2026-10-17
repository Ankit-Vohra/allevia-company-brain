// GET /api/:t/graph/at-work: the Brain page's "The graph at work" panel, read-only, from the agents' own tools.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { plainNames, type GraphAtWorkDto } from "../../src/server/routes/graph-work.js";
import type { BrainMapDto } from "../../src/server/types.js";
import { seedDepthChain } from "../fixtures/seed-depth.js";
import { harness, TENANT, type Harness } from "./harness.js";

describe("GET /api/:t/graph/at-work (integration)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
    await seedDepthChain(h.g);
  }, 90_000);
  afterAll(async () => h.cleanup());

  const get = async (q = ""): Promise<GraphAtWorkDto> => {
    const res = await h.app.request(`/api/${TENANT.slug}/graph/at-work${q}`);
    expect(res.status).toBe(200);
    return (await res.json()) as GraphAtWorkDto;
  };

  it("defaults to the system most depended on, and depth 4 reaches what depth 1 cannot, each with its path", async () => {
    const d = await get();
    expect(d.candidates[0]!.id).toBe("system:ig-connector");
    const f = d.focus!;
    expect(f.id).toBe("system:ig-connector");
    expect(f.status).toBe("impact");
    expect(f.shallow.items.map((i) => i.id).sort()).toEqual(["channel:instagram", "system:reel-publisher", "task:schedule-reels"]);
    const launch = f.deep.items.find((i) => i.id === "task:diwali-launch")!;
    expect(launch.hop).toBe(4);
    expect(launch.path.map((p) => p.id)).toEqual(["system:reel-publisher", "system:reel-scheduler", "task:weekly-reel-batch", "task:diwali-launch"]);
    expect(launch.path.map((p) => p.rel)).toEqual(["DEPENDS_ON", "DEPENDS_ON", "DEPENDS_ON", "BLOCKS"]);
    expect(f.shallow.items.some((i) => i.id === "task:diwali-launch")).toBe(false);
    expect(f.owners.map((o) => o.id)).toContain("team:tech");
    expect(d.important.length).toBeGreaterThan(0);
    expect(d.errors).toEqual([]);
  });

  it("a name is resolved before anything runs: unknown is 'not in your records', known-but-unmapped is not 'no impact'", async () => {
    const missing = await get("?focus=Payroll%20gateway");
    expect(missing.focus).toBeNull();
    expect(missing.notFound!.message).toBe(`I don't have "Payroll gateway" in your records.`);
    const unmapped = await get("?focus=team:marketing");
    expect(unmapped.focus!.status).toBe("not_mapped");
    expect(unmapped.focus!.message).toMatch(/no dependencies are recorded/);
    const byName = await get("?focus=Reels%20scheduler");
    expect(byName.focus!.id).toBe("system:reel-scheduler");
    expect(byName.focus!.deep.items.map((i) => i.id)).toEqual(["task:weekly-reel-batch", "task:diwali-launch"]);
  });
});

describe("GET /api/:t/graph/map (integration)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
    await seedDepthChain(h.g);
  }, 90_000);
  afterAll(async () => h.cleanup());

  const get = async (q = ""): Promise<BrainMapDto> => {
    const res = await h.app.request(`/api/${TENANT.slug}/graph/map${q}`);
    expect(res.status).toBe(200);
    return (await res.json()) as BrainMapDto;
  };

  it("the top things by importance, light: no summaries, when each was learned, links as index triples", async () => {
    const m = await get();
    expect(m.nodes.length).toBeGreaterThan(20);
    expect(m.nodes.length).toBeLessThanOrEqual(400);
    expect(m.nodes.some((n) => ["Version", "Chunk", "Observation", "Turn", "Session"].includes(n.label))).toBe(false);
    expect(m.nodes.some((n) => "summary" in n)).toBe(false);
    expect(Math.max(...m.nodes.map((n) => n.rank))).toBe(1);
    for (let i = 1; i < m.nodes.length; i++) expect(m.nodes[i]!.rank).toBeLessThanOrEqual(m.nodes[i - 1]!.rank + 1e-9);
    expect(m.nodes.every((n) => typeof n.learnedAt === "number" && n.learnedAt > 0)).toBe(true);
    expect(m.links.length).toBeGreaterThan(0);
    const keys = new Set<string>();
    for (const [a, b, t] of m.links) {
      expect(m.nodes[a]).toBeDefined();
      expect(m.nodes[b]).toBeDefined();
      expect(a).not.toBe(b);
      expect(["TOUCHED", "CITED", "HAD_VERSION", "HAS_CHUNK"]).not.toContain(m.types[t]);
      keys.add(`${a}|${t}|${b}`);
    }
    expect(keys.size).toBe(m.links.length); // no link twice
    const dep = m.types.indexOf("DEPENDS_ON");
    const at = (id: string) => m.nodes.findIndex((n) => n.id === id);
    expect(m.links.some(([a, b, t]) => a === at("system:reel-publisher") && b === at("system:ig-connector") && t === dep)).toBe(true);
  });

  it("says how big the whole brain is, plumbing left out, and caps on request", async () => {
    const m = await get();
    expect(m.counts.Task).toBeGreaterThanOrEqual(2);
    const plumbing = (m.counts.Version ?? 0) + (m.counts.Chunk ?? 0);
    expect(m.totals.things).toBe(Object.values(m.counts).reduce((s, c) => s + c, 0) - plumbing);
    expect(m.totals.things).toBeGreaterThanOrEqual(m.nodes.length);
    expect(m.totals.links).toBeGreaterThanOrEqual(m.links.length);
    const five = await get("?limit=5");
    expect(five.nodes).toHaveLength(5);
    expect(five.capped).toBe(true);
    expect(five.nodes.map((n) => n.id)).toEqual(m.nodes.slice(0, 5).map((n) => n.id));
    expect((await h.app.request(`/api/${TENANT.slug}/graph/map?limit=lots`)).status).toBe(400);
  });
});

describe("plainNames", () => {
  it("drops the privacy filter's marker from a name the owner reads", () => {
    const dto = { candidates: [{ id: "system:supabase-prod", name: "Supabase prod ([redacted:supabase-ref])", dependents: 3 }], note: "no marker here" };
    expect(plainNames(dto)).toEqual({ candidates: [{ id: "system:supabase-prod", name: "Supabase prod", dependents: 3 }], note: "no marker here" });
    expect(plainNames({ a: "key [redacted:secret] rest" })).toEqual({ a: "key rest" });
    expect(plainNames({ name: "Supabase prod ([redacted:supabase-ref], Mumbai)" })).toEqual({ name: "Supabase prod (Mumbai)" });
  });
});
