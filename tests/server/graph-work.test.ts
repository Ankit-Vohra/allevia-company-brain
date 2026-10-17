// GET /api/:t/graph/at-work: the Brain page's "The graph at work" panel, read-only, from the agents' own tools.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { plainNames, type GraphAtWorkDto } from "../../src/server/routes/graph-work.js";
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

describe("plainNames", () => {
  it("drops the privacy filter's marker from a name the owner reads", () => {
    const dto = { candidates: [{ id: "system:supabase-prod", name: "Supabase prod ([redacted:supabase-ref])", dependents: 3 }], note: "no marker here" };
    expect(plainNames(dto)).toEqual({ candidates: [{ id: "system:supabase-prod", name: "Supabase prod", dependents: 3 }], note: "no marker here" });
    expect(plainNames({ a: "key [redacted:secret] rest" })).toEqual({ a: "key rest" });
    expect(plainNames({ name: "Supabase prod ([redacted:supabase-ref], Mumbai)" })).toEqual({ name: "Supabase prod (Mumbai)" });
  });
});
