// "The code stays the same, but their knowledge and tweaks are different." Everything a business can tweak (agents on or
// off, autonomy, standing instructions, brand rules, learned rules, goals) is data in that business's own graph, and the
// starting point of a new business comes from code (the roster, the industry template, the vendored playbooks), never from
// another business's graph. A business is customised, then two new businesses are set up the same way: they must come out
// identical to each other and carry nothing of the first.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activeRules } from "../../src/actions/learning.js";
import { learnedRules } from "../../src/actions/feed.js";
import { closeAll, openGraph, openGraphByName, type GraphHandle } from "../../src/graph/client.js";
import { upsertNode } from "../../src/graph/upsert.js";
import { onboard } from "../../src/onboard/onboard.js";
import { applyDirective, previewDirective, setAgentSettings, loadTeamSettings, listAgentsWithSettings } from "../../src/settings/directives.js";
import { entityId } from "../../src/util/ids.js";
import { testGraphName } from "../helpers/graph.js";

const suffix = Math.random().toString(36).slice(2, 8);
const [A, B, C] = [`test_cfg_a${suffix}`, `test_cfg_b${suffix}`, `test_cfg_c${suffix}`];
const metaGraph = testGraphName();
const SECRET = "ALPHA-HOUSE-STYLE-7731";
const LEARNED = entityId("Rule", "alpha learned");
let dataDir: string;
const graphs: Record<string, GraphHandle> = {};

const setup = (slug: string, name: string) => onboard({ name, slug, website: false, industry: "architecture studio", country: "India" }, () => {}, { dataDir, model: "haiku", tenantOpts: { metaGraph } });

async function snapshot(g: GraphHandle) {
  const labels = await g.roQuery<{ l: string; c: number }>("MATCH (n:Entity) WITH [x IN labels(n) WHERE x <> 'Entity' AND x <> 'Searchable'][0] AS l RETURN l, count(*) AS c ORDER BY l");
  const team = await listAgentsWithSettings(g);
  const goals = await g.roQuery<{ name: string; target: number | null; unit: string | null }>("MATCH (x:Goal) RETURN x.name AS name, x.target AS target, x.unit AS unit ORDER BY name, x.id");
  const rules = await g.roQuery<{ kind: string | null; c: number }>("MATCH (r:Rule) RETURN r.kind AS kind, count(*) AS c ORDER BY kind");
  return { labels, team, goals, rules };
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "allevia-cfg-"));
  expect((await setup(A, "Alpha House")).ok).toBe(true);
  graphs[A] = await openGraph(A);

  // Alpha's tweaks: a desk off, autonomy raised, a standing instruction, a brand rule, a learned rule with a secret in it
  const g = graphs[A]!;
  await setAgentSettings(g, "growth-marketer", { enabled: false, statusNote: `paused for ${SECRET}` });
  await setAgentSettings(g, "content-strategist", { autonomy: 2 });
  const preview = await previewDirective(g, { text: `No emojis on LinkedIn. Always write in the ${SECRET} voice.` }, { llm: null });
  await applyDirective(g, preview.id);
  await upsertNode(g, { type: "BrandRule", id: entityId("BrandRule", "alpha secret"), name: SECRET, summary: `Never mention ${SECRET}`, props: { kind: "voice" } });
  await upsertNode(g, { type: "Rule", id: LEARNED, name: SECRET, props: { kind: "learned", status: "active", text: `Say ${SECRET}`, op: "instruction", confidence: 0.9 } });

  expect((await setup(B, "Bravo House")).ok).toBe(true);
  expect((await setup(C, "Charlie House")).ok).toBe(true);
  graphs[B] = await openGraph(B);
  graphs[C] = await openGraph(C);
}, 120_000);

afterAll(async () => {
  for (const s of [A, B, C]) await (await openGraph(s)).drop();
  await (await openGraphByName(metaGraph)).drop();
  rmSync(dataDir, { recursive: true, force: true });
  await closeAll();
});

describe("a tenant's tweaks live in its own graph", () => {
  it("Alpha has them", async () => {
    const g = graphs[A]!;
    const team = await loadTeamSettings(g);
    expect(JSON.stringify(team)).toContain(SECRET);
    const agents = await listAgentsWithSettings(g);
    expect(agents.find((a) => a.id === "growth-marketer")).toMatchObject({ enabled: false });
    expect(agents.find((a) => a.id === "content-strategist")).toMatchObject({ autonomy: 2 });
    expect((await learnedRules(g)).map((r) => r.id)).toContain(LEARNED);
    expect((await activeRules(g, {}, { brand: true })).map((r) => r.id)).toEqual(expect.arrayContaining([LEARNED]));
  });

  it("a business set up afterwards has none of them", async () => {
    const g = graphs[B]!;
    const agents = await listAgentsWithSettings(g);
    expect(agents.every((a) => a.enabled && a.mode === "full" && a.autonomy === 0)).toBe(true);
    expect(JSON.stringify(await loadTeamSettings(g))).not.toContain(SECRET);
    expect(await learnedRules(g)).toEqual([]);
    expect(await activeRules(g, {}, { brand: true })).toEqual([]);
    const all = JSON.stringify(await g.roQuery("MATCH (n) RETURN properties(n) AS p ORDER BY id(n)"));
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain("Alpha");
  });

  it("two new businesses, set up the same way after Alpha was customised, come out the same: the starting point is code, not a copy", async () => {
    const [b, c] = await Promise.all([snapshot(graphs[B]!), snapshot(graphs[C]!)]);
    expect(b).toEqual(c);
    expect(b.labels.length).toBeGreaterThan(5);
    expect(b.goals.length).toBeGreaterThan(0);
  });

  it("the registry holds each business's own name and nothing of another's tweaks", async () => {
    const meta = await openGraphByName(metaGraph);
    const text = JSON.stringify(await meta.roQuery("MATCH (n) RETURN properties(n) AS p ORDER BY id(n)"));
    expect(text).not.toContain(SECRET);
    for (const slug of [A, B, C]) expect(text).toContain(slug);
  });
});
