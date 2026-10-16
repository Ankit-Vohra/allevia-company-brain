// onboard() end to end on the synthetic fixture site: the real crawler (local server, opt-in host), a FAKE LlmRunner,
// fake embeddings and a throwaway FalkorDB graph from testGraph() (the tenant slug is the test graph's suffix, and the
// tenant registry is a throwaway meta graph). Checks the event order, what lands in the graph, that a second run
// creates nothing, that a failing stage reports an error and the run still finishes, and that bad URLs are refused.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { OnboardEvent } from "../../shared/contracts.js";
import { closeAll, openGraphByName, type GraphHandle } from "../../src/graph/client.js";
import { getTenant } from "../../src/graph/tenants.js";
import { onboard, softMessage, startUrl, type OnboardDeps, type OnboardResult } from "../../src/onboard/onboard.js";
import { localRuleId } from "../../src/ingest/sources/website/seo.js";
import { scanGraph } from "../../src/ingest/privacy.js";
import { testGraph } from "../helpers/graph.js";
import { FakeLlm } from "../helpers/fake-llm.js";
import { startSite, type SiteServer } from "../fixtures/website/server.js";

const fakeEmbed = async (texts: string[]) => texts.map((t) => {
  const h = createHash("sha256").update(t).digest();
  const v = Array.from({ length: 384 }, (_, i) => (h[i % 32]! - 127.5) / 127.5 + i / 1000);
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
});

describe("onboard (fixture site, fake LLM, test graph)", () => {
  let site: SiteServer;
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  let slug: string;
  let metaGraph: string;
  let dataDir: string;
  let llm: FakeLlm;
  const events: OnboardEvent[] = [];
  let first: OnboardResult;
  let clock = Date.parse("2026-10-15T09:00:00.000Z");

  const deps = (runner = llm, dir = dataDir): OnboardDeps => ({
    runner, model: "haiku", dataDir: dir, embed: fakeEmbed, tenantOpts: { metaGraph }, now: () => clock,
    crawlOptions: { allowHosts: [`127.0.0.1:${site.port}`], minDelayMs: 0, maxLinkChecks: 5 },
  });
  const input = () => ({ name: "Kestrel & Oak Studio", slug, url: `${site.origin}/`, instagram: "kestrel.oak", industry: "architecture and interior design studio" });
  const q = <T = Record<string, unknown>>(cypher: string, params?: Record<string, unknown>) => g.roQuery<T>(cypher, params);

  beforeAll(async () => {
    site = await startSite();
    ({ g, cleanup } = await testGraph());
    slug = g.name.replace(/^allevia_/, "");
    metaGraph = `allevia_test_meta_${slug.slice(5)}`;
    dataDir = mkdtempSync(join(tmpdir(), "allevia-onboard-"));
    llm = new FakeLlm();
    first = await onboard(input(), (e) => events.push(e), deps());
  }, 120_000);

  afterAll(async () => {
    await cleanup();
    await (await openGraphByName(metaGraph)).drop();
    await closeAll();
    await site.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("streams the stages in order, page events during the crawl, nodes as the graph grows, then done", () => {
    expect(events.filter((e) => e.type === "error")).toEqual([]);
    const stages = events.flatMap((e) => (e.type === "stage" ? [e.stage] : []));
    expect(stages).toEqual(["crawl", "brand", "seo", "understand", "profile", "playbooks", "goals", "baseline", "index", "capabilities", "done"]);
    const idx = (pred: (e: OnboardEvent) => boolean) => events.findIndex(pred);
    const crawlAt = idx((e) => e.type === "stage" && e.stage === "crawl");
    const brandAt = idx((e) => e.type === "stage" && e.stage === "brand");
    const pageAts = events.map((e, i) => (e.type === "page" ? i : -1)).filter((i) => i >= 0);
    expect(pageAts.length).toBe(first.pages);
    expect(pageAts.every((i) => i > crawlAt && i < brandAt)).toBe(true);
    for (const s of ["crawl", "brand", "seo", "understand", "profile", "playbooks", "goals", "baseline", "capabilities"]) {
      const from = idx((e) => e.type === "stage" && e.stage === s);
      expect(events.slice(from + 1).some((e) => e.type === "nodes"), s).toBe(true);
    }
    const last = events.at(-1)!;
    expect(last).toMatchObject({ type: "done", tenant: slug });
    expect(first.ok).toBe(true);
  });

  it("creates the tenant and writes pages, documents, brand, SEO, understanding and playbooks", async () => {
    expect((await getTenant(slug, { metaGraph }))!.city).toBe("Bristol");
    const c = first.counts;
    expect(c.pagesCrawled).toBe(first.pages);
    expect(c.Page).toBe(first.pages);
    expect(c.BrandAsset).toBeGreaterThanOrEqual(5);
    expect(c.Product).toBe(3);
    expect(c.Rule).toBeGreaterThan(20);
    expect(c.seoScore).toBeGreaterThan(0);
    const [biz] = await q<{ s: string; city: string; country: string; style: string }>(
      "MATCH (b:Business) RETURN b.summary AS s, b.city AS city, b.country AS country, b.designStyle AS style");
    expect(biz).toMatchObject({ city: "Bristol", country: "United Kingdom", style: expect.stringMatching(/terracotta/) });
    // every page is part of the website and sourced from its document
    const orphans = await q<{ c: number }>(
      "MATCH (p:Page) WHERE NOT (p)-[:PART_OF]->(:Channel {id:'channel:website'}) OR NOT (p)-[:SOURCED_FROM]->(:Document {kind:'webpage'}) RETURN count(p) AS c");
    expect(orphans[0]!.c).toBe(0);
    // every extracted entity is sourced from a page document
    const unsourced = await q<{ id: string }>(
      "MATCH (n:Entity) WHERE (n:Product OR n:Audience OR n:Need OR n:Content OR n:Person) AND NOT (n)-[:SOURCED_FROM]->(:Document {kind:'webpage'}) RETURN n.id AS id");
    expect(unsourced).toEqual([]);
    expect(await q("MATCH (o:Observation) WHERE o.metric = 'homes_completed' RETURN o")).toEqual([]);
    // SEO: contact has no viewport, harbour house has two h1s, the home page links to a 404
    const fails = await q<{ p: string; r: string; ev: string; sev: string }>(
      "MATCH (p:Page)-[x:FAILS]->(r:Rule) WHERE x.until IS NULL RETURN p.path AS p, r.id AS r, x.evidence AS ev, x.severity AS sev");
    expect(fails).toContainEqual(expect.objectContaining({ p: "/contact", r: localRuleId("missing-viewport") }));
    expect(fails).toContainEqual(expect.objectContaining({ p: "/projects/harbour-house", r: "rule:seo-check-multiple-h1" }));
    expect(fails.find((f) => f.p === "/" && f.r === "rule:seo-check-broken-internal-link")!.ev).toMatch(/\/missing \(HTTP 404\)/);
    expect(fails.find((f) => f.p === "/services" && f.r === "rule:seo-check-duplicate-title")).toBeDefined();
    // projects are content on the website; services are part of the business; channels found
    expect(await q("MATCH (c:Content {format:'project'})-[:PUBLISHED_ON]->(:Channel {id:'channel:website'}) RETURN c.id")).toHaveLength(2);
    expect(await q("MATCH (:Product)-[:PART_OF]->(:Business) RETURN 1")).toHaveLength(3);
    const ig = await q<{ h: string }>("MATCH (c:Channel {id:'channel:instagram'})-[:PART_OF]->(:Business) RETURN c.handle AS h");
    expect(ig[0]!.h).toBe("kestrel.oak");
    // embeddings: searchable entities and chunks are indexed
    const missing = await q<{ c: number }>("MATCH (n:Product) WHERE n.embedding IS NULL RETURN count(n) AS c");
    expect(missing[0]!.c).toBe(0);
    expect((await q<{ c: number }>("MATCH (c:Chunk) WHERE c.textEmbedding IS NULL RETURN count(c) AS c"))[0]!.c).toBe(0);
  });

  it("keeps the business's own contact details out of the graph and away from the model: placeholders, and the privacy scan finds nothing else", async () => {
    // the fixture's contact page says "Email hello@example.com or call 0117 496 0000."
    const chunk = await q<{ t: string }>("MATCH (c:Chunk) WHERE c.url ENDS WITH '/contact' RETURN c.text AS t ORDER BY c.id");
    expect(chunk.map((c) => c.t).join("\n")).toMatch(/Email \[redacted:email\] or call/);
    const nodes = await q<{ id: string; vals: unknown[] }>("MATCH (n) RETURN n.id AS id, [k IN keys(n) WHERE NOT k IN ['embedding', 'textEmbedding'] | n[k]] AS vals ORDER BY id(n)");
    const edges = await q<{ vals: unknown[] }>("MATCH ()-[r]->() RETURN [k IN keys(r) | r[k]] AS vals ORDER BY id(r)");
    const strings = [...nodes, ...edges].flatMap((r) => r.vals.flat()).filter((v): v is string => typeof v === "string");
    expect(strings.length).toBeGreaterThan(500);
    expect(strings.filter((s) => s.includes("hello@example.com"))).toEqual([]);
    expect(llm.calls.filter((c) => `${c.system}\n${c.prompt}`.includes("hello@example.com"))).toEqual([]);
    // the fixture site is served from 127.0.0.1:<port>, so every url and domain is an address; nothing else may be found
    expect((await scanGraph(g)).filter((h) => h.kind !== "ipv4")).toEqual([]);
    // what is not personal data stays: the Instagram profile link is still a Channel
    expect(await q("MATCH (c:Channel {id:'channel:instagram'}) WHERE c.url STARTS WITH 'https://www.instagram.com/' RETURN c.id")).toHaveLength(1);
  });

  it("v2: country defaults from the site, the studio template's goals with unknown baselines, the program and its Day-0 checkpoint", async () => {
    const [b] = await q("MATCH (b:Business) WHERE b.templateKey IS NOT NULL RETURN b.currency AS currency, b.locale AS locale, b.timeZone AS tz, b.templateKey AS tk");
    expect(b).toEqual({ currency: "GBP", locale: "en-GB", tz: "Europe/London", tk: "architecture_studio" });
    const goals = await q<{ name: string; baseline: number | null; conf: string }>(
      "MATCH (:Business)-[:PURSUES]->(gl:Goal)-[:PART_OF]->(:Program) RETURN gl.name AS name, gl.baseline AS baseline, gl.baselineConf AS conf ORDER BY gl.priority, gl.id");
    expect(goals).toEqual([
      { name: "Qualified enquiries per month", baseline: null, conf: "unknown" },
      { name: "Instagram reach", baseline: null, conf: "unknown" },
      { name: "Search clicks", baseline: null, conf: "unknown" },
    ]);
    expect(await q("MATCH (c:Checkpoint {day:0})-[:PART_OF]->(:Program {kind:'allevia90'}) RETURN c.id")).toHaveLength(1);
    expect(first.capabilities?.map((c) => c.key)).toContain("search_console");
  });

  it("day one: the address read from the footer is a fact on the business with its page and quote; the graph comes out clean (issue #24)", async () => {
    const [b] = await q<{ address: string; src: string; via: string; ev: string }>(
      "MATCH (b:Business) WHERE b.address IS NOT NULL RETURN b.address AS address, b.addressSrc AS src, b.addressVia AS via, b.addressEvidence AS ev");
    expect(b).toMatchObject({ address: "12 Harbour Lane, Bristol, United Kingdom", via: "page text", ev: expect.stringContaining("12 Harbour Lane") });
    expect(await q("MATCH (:Business)-[s:SOURCED_FROM]->(d:Document {id:$d}) WHERE s.until IS NULL RETURN d.id", { d: b!.src })).toHaveLength(1);
    // the phone number in the footer stays redacted, and no fact quotes it
    expect(b!.ev).not.toMatch(/0117/);
    const { graphQuality } = await import("../../src/ingest/quality.js");
    const r = await graphQuality(g, `business:${slug.replace(/_/g, "-")}`);
    expect(r.duplicates.certain).toBe(0);
    expect(r.mistyped.total).toBe(0);
    expect(r.unsourced.facts).toBe(0);
    expect(r.facts.address).toBe(true);
  });

  it("re-runs as a no-op: no new nodes or edges, the LLM is not asked again, the same counts", async () => {
    const calls = llm.calls.length;
    clock += 60 * 60 * 1000;
    const again: OnboardEvent[] = [];
    const second = await onboard(input(), (e) => again.push(e), deps());
    expect(again.filter((e) => e.type === "error")).toEqual([]);
    expect(second.stats.nodesCreated).toBe(0);
    expect(second.stats.edgesCreated).toBe(0);
    expect(second.stats.versions).toBe(0);
    expect(second.stats.edgesClosed).toBe(0);
    expect(llm.calls.length).toBe(calls);
    expect(second.counts).toEqual(first.counts);
  }, 120_000);

  it("reports a failing step as an error event, keeps what it has, and still finishes", async () => {
    const other = mkdtempSync(join(tmpdir(), "allevia-onboard-"));
    try {
      const failing = new FakeLlm({ failPaths: ["/about"] });
      const evs: OnboardEvent[] = [];
      const r = await onboard(input(), (e) => evs.push(e), deps(failing, other));
      // the owner reads a plain sentence and the set-up goes on (the raw reason stays in the run report)
      expect(evs.filter((e) => e.type === "error")).toEqual([{ type: "error", message: softMessage("understand"), soft: true }]);
      expect(r.errors).toEqual([expect.stringMatching(/^understand: \/about: extraction failed/)]);
      expect(evs.at(-1)!.type).toBe("done");
      expect(r.counts.Page).toBe(first.counts.Page);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  }, 120_000);

  it("refuses private, local and non-web URLs before touching the graph", async () => {
    for (const url of ["http://10.0.0.1/", "file:///etc/passwd", "http://localhost:8080/", "http://169.254.169.254/latest/meta-data/"]) {
      const evs: OnboardEvent[] = [];
      const r = await onboard({ name: "X", slug: "never_created", url }, (e) => evs.push(e), { runner: llm, model: "haiku", dataDir });
      expect(evs).toEqual([{ type: "error", message: expect.stringMatching(/^input: /) }]);
      expect(r.ok).toBe(false);
    }
    expect(await getTenant("never_created", { metaGraph })).toBeNull();
    expect(startUrl("kestrel.example.com")).toBe("https://kestrel.example.com/");
  });
});
