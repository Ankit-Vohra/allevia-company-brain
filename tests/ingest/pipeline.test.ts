// runIngest end to end on synthetic inputs: the fixture vault (a real git repo in a temp dir), the recorded ops fixture
// snapshot, the vendored playbooks, simulated ads, GitHub issues through a fake gh, a FAKE LlmRunner and fake embeddings.
// The run must write everything, pass the privacy scan, save a report, and be idempotent: a second run makes 0 nodes and
// 0 edges and calls no model. Changing one PENDING owner then closes one OWNS edge and opens one.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, createHash } from "node:crypto";
import { closeAll, openGraph, openGraphByName, type GraphHandle } from "../../src/graph/client.js";
import { runIngest, alignAdrDecision, extractionOrder, type IngestRun } from "../../src/ingest/pipeline.js";
import type { Extraction } from "../../src/ingest/extract.js";
import type { LlmRunner, StructuredInput } from "../../src/ingest/llm.js";
import type { RawDoc } from "../../src/ingest/types.js";
import type { TenantConfig } from "../../src/tenant-config.js";
import { makeFixtureVault, VAULT_FILES } from "../helpers/fixture-vault.js";

const OPS_DIR = fileURLToPath(new URL("../fixtures/ops/snapshot/2026-10-15", import.meta.url));
const ISSUES = readFileSync(new URL("../fixtures/github/issues.ndjson", import.meta.url), "utf8");
const NOW = new Date("2026-10-15T06:00:00Z");

// ---------- fakes ----------

const EXTRACTIONS: Array<[string, Extraction]> = [
  ["path: 60-decisions/001-human-review.md", {
    entities: [
      { type: "Decision", name: "Require human review for every post", summary: "Every post and reel waits for the founder's approval." },
      { type: "Event", name: "Wrong prices on two reels", summary: "Two auto-posted reels had the wrong price in September." },
      { type: "Person", name: "the founder", summary: "Approves every post." },
    ],
    relations: [
      { from: "Require human review for every post", fromType: "Decision", type: "BASED_ON", to: "Wrong prices on two reels", toType: "Event", evidence: "Two auto-posted reels had the wrong price in September.", conf: 0.9 },
      { from: "the founder", fromType: "Person", type: "DECIDED", to: "Require human review for every post", toType: "Decision", evidence: "Every post and reel waits for the founder's approval before it is published.", conf: 0.9 },
    ],
    observations: [],
  }],
  ["path: 70-reports/daily/2026-10-10.md", {
    entities: [{ type: "Channel", name: "Instagram", summary: "Reels reached 1,200 accounts." }],
    relations: [],
    observations: [{ ref: "o1", metric: "reels_reach", subject: "Instagram", subjectType: "Channel", value: 1200, evidence: "Instagram reels reached 1,200 accounts yesterday." }],
  }],
  ["path: 10-company/overview.md", {
    entities: [
      { type: "Business", name: "Widget Co", summary: "Sells hand-made widgets." },
      { type: "Channel", name: "Instagram", summary: "The main channel." },
      { type: "Person", name: "Meera", summary: "The founder; reviews every post." },
      { type: "Product", name: "Hand-made widgets", summary: "What Widget Co sells." },
    ],
    relations: [
      { from: "Instagram", fromType: "Channel", type: "PART_OF", to: "Widget Co", toType: "Business", evidence: "Instagram is the main channel", conf: 0.8 },
    ],
    observations: [],
  }],
];

class FakeRunner implements LlmRunner {
  calls = 0;
  async structured(input: StructuredInput): Promise<unknown> {
    this.calls++;
    const hit = EXTRACTIONS.find(([marker]) => input.prompt.includes(marker));
    return hit ? structuredClone(hit[1]) : { entities: [], relations: [], observations: [] };
  }
}

// Deterministic unit vectors from the text's hash: equal texts get equal vectors, different texts unrelated ones.
async function fakeEmbed(texts: string[]): Promise<number[][]> {
  return texts.map((t) => {
    const h = createHash("sha256").update(t).digest();
    const v = Array.from({ length: 384 }, (_, i) => ((h[i % 32]! ^ (i * 31)) % 255) / 255 - 0.5);
    const n = Math.hypot(...v);
    return v.map((x) => x / n);
  });
}

// ---------- unit: ordering and ADR alignment ----------

describe("extractionOrder", () => {
  const d = (id: string, kind: RawDoc["kind"], meta: RawDoc["meta"] = {}, path = id): RawDoc => ({ id, kind, title: id, path, text: "", hash: "", meta });
  it("puts decisions first, then the 14 most recent daily reports, then the rest by in-links and commits", () => {
    const daily = Array.from({ length: 16 }, (_, i) => d(`r${i}`, "report", {}, `70-reports/daily/2026-10-${String(i + 1).padStart(2, "0")}.md`));
    const docs = [d("n1", "note", { inLinks: 1 }), d("n2", "note", { inLinks: 5 }), d("dec2", "decision", {}, "60-decisions/002-b.md"),
      ...daily, d("dec1", "decision", {}, "60-decisions/001-a.md"), d("weekly", "report", { inLinks: 2 }, "70-reports/weekly/w40.md")];
    const order = extractionOrder(docs).map((x) => x.id);
    expect(order.slice(0, 2)).toEqual(["dec1", "dec2"]);
    expect(order.slice(2, 16)).toEqual(Array.from({ length: 14 }, (_, i) => `r${15 - i}`));
    expect(order.slice(16)).toEqual(["n2", "weekly", "n1", "r1", "r0"]);
  });
});

describe("alignAdrDecision", () => {
  const ex = (names: string[]): Extraction => ({
    entities: names.map((name) => ({ type: "Decision" as const, name, summary: "" })), relations: [], observations: [],
  });
  it("renames the decision that is the ADR itself to the ADR's name, keeping the model's name as an alias", () => {
    const out = alignAdrDecision(ex(["Require human review for every post", "Use a calendar"]), "ADR 001: Human review for every post");
    expect(out.entities[0]).toMatchObject({ name: "ADR 001: Human review for every post", aliases: ["Require human review for every post"] });
    expect(out.entities[1]!.name).toBe("Use a calendar");
  });
  it("takes a lone decision as the ADR's, and leaves several unrelated ones alone", () => {
    expect(alignAdrDecision(ex(["Pause posting"]), "ADR 002: Something else").entities[0]!.name).toBe("ADR 002: Something else");
    const two = alignAdrDecision(ex(["Pause posting", "Hire a designer"]), "ADR 003: Budget rules");
    expect(two.entities.map((e) => e.name)).toEqual(["Pause posting", "Hire a designer"]);
  });
});

// ---------- integration ----------

describe("runIngest (integration, fixture vault, fake model)", () => {
  const hex = randomBytes(4).toString("hex");
  const tenant: TenantConfig = {
    slug: `test_${hex}`, name: "Widget Co", industry: "jobs", city: "Testville", founderNames: ["Meera"],
    sources: ["brain", "ops", "playbooks", "simads", "github"],
    github: { repos: ["Widget-Org/widget-brain"], founderLogins: ["Widget-Founder"] },
    ads: { profile: "jobs-platform", seed: 7, days: 2 },
  };
  const metaGraph = `allevia_test_meta_${hex}`;
  let vault: ReturnType<typeof makeFixtureVault>;
  let dataDir: string;
  let g: GraphHandle;
  const runner = new FakeRunner();
  let first: IngestRun;
  let ghCalls = 0;
  const run = (now = NOW) => runIngest(tenant, {
    metaGraph, brainPath: vault.dir, dataDir, opsSnapshotDir: OPS_DIR, runner, embed: fakeEmbed, now,
    gh: async () => { ghCalls++; return ISSUES; },
  });

  beforeAll(async () => {
    vault = makeFixtureVault();
    dataDir = mkdtempSync(join(tmpdir(), "allevia-data-"));
    first = await run();
    g = await openGraph(tenant.slug);
  }, 240_000);
  afterAll(async () => {
    await g?.drop();
    await (await openGraphByName(metaGraph)).drop();
    vault.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
    await closeAll();
  });

  const counts = async () => (await g.roQuery<{ n: number; r: number }>(
    "MATCH (n:Entity) WHERE NOT n.id STARTS WITH 'event:ingest-' OPTIONAL MATCH (n)-[r]->() RETURN count(DISTINCT n) AS n, count(r) AS r"))[0]!;

  it("writes every source with no errors, extracts each candidate once, and passes the privacy scan", () => {
    const r = first.report;
    expect(r.stats.errors).toBe(0);
    expect(r.writeErrors).toEqual([]);
    expect(r.sources.map((s) => s.source)).toEqual(["brain", "ops", "playbooks", "simads", "github"]);
    expect(r.extraction).toMatchObject({ candidates: 5, docs: 5, cached: 0, failed: 0, skipped: 0 });
    expect(runner.calls).toBe(5);
    expect(r.extraction.entities).toBeGreaterThan(0);
    expect(r.privacyScanHits).toBe(0);
    expect(r.vaultHead).toBe(vault.head);
    expect(ghCalls).toBe(1);
  });

  it("saves the report under <dataDir>/runs/<tenant>/ and records the run as an ingest Event", async () => {
    const dir = join(dataDir, "runs", tenant.slug);
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(existsSync(first.reportPath)).toBe(true);
    expect(JSON.parse(readFileSync(first.reportPath, "utf8"))).toMatchObject({ tenant: tenant.slug, privacyScanHits: 0 });
    const ev = await g.roQuery<{ kind: string; head: string }>("MATCH (e:Event) WHERE e.id STARTS WITH 'event:ingest-' RETURN e.kind AS kind, e.vaultHead AS head");
    expect(ev).toEqual([{ kind: "ingest", head: vault.head.slice(0, 12) }]);
  });

  it("merges the ADR's extracted decision into the ADR Decision, with its evidence and the founder", async () => {
    const decisions = await g.roQuery<{ id: string }>("MATCH (d:Decision) RETURN d.id AS id ORDER BY id");
    expect(decisions.map((d) => d.id)).toEqual(["decision:001-human-review"]);
    const path = await g.roQuery<{ ev: string; doc: string }>(
      `MATCH (:Person {id:'person:founder'})-[:DECIDED]->(d:Decision {id:'decision:001-human-review'})-[:BASED_ON]->(e:Event)-[:SOURCED_FROM]->(doc:Document)
       RETURN e.name AS ev, doc.id AS doc`);
    expect(path).toEqual([{ ev: "Wrong prices on two reels", doc: "document:60-decisions-001-human-review-md" }]);
    const al = await g.roQuery<{ a: string[] }>("MATCH (d:Decision {id:'decision:001-human-review'}) RETURN d.aliases AS a");
    expect(al[0]!.a).toEqual(["Require human review for every post"]);
  });

  it("resolves the founder's name, reuses existing channels, and keeps report numbers as observations", async () => {
    const people = await g.roQuery<{ id: string }>("MATCH (p:Person) RETURN p.id AS id ORDER BY id");
    expect(people.map((p) => p.id)).toEqual(["person:founder", "person:octo-dev"]);
    const obs = await g.roQuery<{ v: number; c: string }>(
      "MATCH (o:Observation {metric:'reels_reach'})-[:MEASURES]->(c:Channel) RETURN o.value AS v, c.id AS c");
    expect(obs).toEqual([{ v: 1200, c: "channel:instagram" }]);
  });

  it("embeds searchable nodes and chunks, derives KNOWS_ABOUT, and stores rank", async () => {
    const [e] = await g.roQuery<{ missing: number }>(
      "MATCH (n:Entity) WHERE (n:Channel OR n:System OR n:Decision OR n:Document OR n:Task) AND n.embedding IS NULL RETURN count(n) AS missing");
    expect(e!.missing).toBe(0);
    const [c] = await g.roQuery<{ missing: number; all: number }>(
      "MATCH (c:Chunk) RETURN sum(CASE WHEN c.textEmbedding IS NULL THEN 1 ELSE 0 END) AS missing, count(c) AS all");
    expect(c!.all).toBeGreaterThan(0);
    expect(c!.missing).toBe(0);
    const k = await g.roQuery<{ x: string }>("MATCH (:Person {id:'person:founder'})-[r:KNOWS_ABOUT]->(x) WHERE r.until IS NULL RETURN x.id AS x");
    expect(k.map((r) => r.x)).toContain("decision:001-human-review");
    expect(first.report.librarian!.rank.nodes).toBeGreaterThan(0);
  });

  it("is idempotent: a second run creates no nodes or edges and calls no model", async () => {
    const before = await counts();
    const calls = runner.calls;
    const second = await run(new Date(NOW.getTime() + 60_000));
    expect(second.report.stats).toMatchObject({ nodesCreated: 0, edgesCreated: 0, edgesClosed: 0, versions: 0, errors: 0 });
    expect(second.report.extraction).toMatchObject({ docs: 5, cached: 5 });
    expect(second.report.librarian!.knowsAbout).toMatchObject({ created: 0, closed: 0 });
    expect(runner.calls).toBe(calls);
    expect(await counts()).toEqual(before);
  }, 240_000);

  it("closes one OWNS edge and opens one when a PENDING owner changes", async () => {
    const pending = VAULT_FILES["00-command/PENDING.md"]!.replace(
      "| N1 | **Approve the October reels** | they are drafted |\n", "").replace(
      "## Agent work", "## Agent queue\n| # | action | why |\n|---|---|---|\n| N1 | **Approve the October reels** | they are drafted |\n\n## Agent work");
    vault.commit({ subject: "move N1 to the agents", date: "2026-10-14T09:00:00+05:30", files: { "00-command/PENDING.md": pending } });
    const third = await run(new Date(NOW.getTime() + 120_000));
    expect(third.report.stats.errors).toBe(0);
    const owns = await g.roQuery<{ from: string; until: number | null }>(
      "MATCH (a)-[r:OWNS]->(:Task {id:'task:pending-n1'}) RETURN a.id AS from, r.until AS until ORDER BY from");
    expect(owns.map((o) => [o.from, o.until === null])).toEqual([["agent:agent", true], ["person:founder", false]]);
    expect(third.report.stats.edgesClosed).toBeGreaterThanOrEqual(1);
  }, 240_000);
});
