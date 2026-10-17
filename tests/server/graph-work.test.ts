// GET /api/:t/graph/at-work: the Brain page's "The graph at work" panel, read-only, from the agents' own tools.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { plainNames, type GraphAtWorkDto } from "../../src/server/routes/graph-work.js";
import type { BrainMapDto } from "../../src/server/types.js";
import { seedDepthChain } from "../fixtures/seed-depth.js";
import { harness, TENANT, type Harness } from "./harness.js";
import { writeBatch } from "../../src/graph/upsert.js";
import { ensureReference } from "../../src/graph/reference.js";
import { splitReference } from "../../src/graph/reference-split.js";
import { isReferenceId, referenceWrite } from "../../src/ingest/sources/reference.js";

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
    // the order is the selection's (stored PageRank, then links), which the ?limit= test below relies on; the rank shown is
    // worked out within the map and sizes the dots, so it need not fall in that order
    expect(m.nodes.every((n) => n.rank >= 0 && n.rank <= 1)).toBe(true);
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

// General know-how (the shared playbooks, src/graph/reference.ts) is not the business's knowledge: the map, its counts and the
// overview leave it out, before the split (a graph still holding the old copy) and after; ?general=1 draws it, marked.
describe("GET /api/:t/graph/map leaves general know-how out (integration)", () => {
  let h: Harness;
  const copy = referenceWrite();
  const seoPack = new Set(copy.nodes.filter((n) => n.id.includes("open-seo") || n.id.startsWith("rule:seo-check-") || n.id.startsWith("event:google-update")).map((n) => n.id));
  beforeAll(async () => {
    h = await harness();
    await seedDepthChain(h.g);
    // the old copy, as onboarding wrote it before the shared reference graph: one pack's rules, its file, and the Google updates
    await writeBatch(h.g, { nodes: copy.nodes.filter((n) => seoPack.has(n.id) || n.type === "Channel"), edges: copy.edges.filter((e) => seoPack.has(e.from)) });
  }, 120_000);
  afterAll(async () => h.cleanup());

  const get = async (q = ""): Promise<BrainMapDto> => {
    const res = await h.app.request(`/api/${TENANT.slug}/graph/map${q}`);
    expect(res.status).toBe(200);
    return (await res.json()) as BrainMapDto;
  };

  it("the map, its counts and the overview count business knowledge only; ?general=1 draws the copy, marked", async () => {
    const m = await get();
    expect(m.nodes.filter((n) => isReferenceId(n.id) || n.id.startsWith("event:google-update"))).toEqual([]);
    const [own] = await h.g.roQuery<{ c: number }>("MATCH (e:Event) WHERE NOT e.id STARTS WITH 'event:google-update' RETURN count(e) AS c");
    expect(m.counts.Event ?? 0).toBe(own!.c); // the business's own events; the 50-odd copied Google updates are not counted
    const [rules] = await h.g.roQuery<{ c: number }>("MATCH (r:Rule) WHERE NOT r.id STARTS WITH 'rule:seo-check-' RETURN count(r) AS c");
    expect(m.counts.Rule).toBe(rules!.c); // the seed's own rules, not the copied pack's
    expect(m.nodes.some((n) => n.general)).toBe(false);
    expect(m.totals.general).toBeUndefined();
    const o = await (await h.app.request(`/api/${TENANT.slug}/overview`)).json() as { counts: Record<string, number>; freshness: Array<{ source: string; asOf: string }> };
    expect(o.counts).toEqual(m.counts);
    // the seed's own playbook notes (15 Aug) are its sources; the vendored files (October commits) are not
    expect(o.freshness.find((f) => f.source === "Playbooks")?.asOf).toBe("2026-08-15");
    const all = await get("?general=1");
    expect(all.nodes.some((n) => n.general && isReferenceId(n.id))).toBe(true);
    expect(all.nodes.filter((n) => n.general).every((n) => isReferenceId(n.id) || n.id.startsWith("event:google-update"))).toBe(true);
    expect(all.counts).toEqual(m.counts);
    expect(all.totals.things).toBe(m.totals.things);
    expect(all.totals.general).toBeGreaterThan(10);
    expect((await h.app.request(`/api/${TENANT.slug}/graph/map?general=yes`)).status).toBe(400);
  });

  it("after the split, ?general=1 draws the shared reference graph's things", async () => {
    await ensureReference();
    await splitReference(h.g, { apply: true });
    const m = await get();
    expect(m.nodes.some((n) => n.general)).toBe(false);
    const all = await get("?general=1");
    const general = all.nodes.filter((n) => n.general);
    expect(general.length).toBeGreaterThan(10);
    expect(general.some((n) => n.label === "Playbook")).toBe(true);
    expect(all.totals.general).toBeGreaterThan(100);
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
