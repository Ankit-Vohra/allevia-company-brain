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
import { ONTOLOGY_VERSION } from "../../src/graph/schema.js";
import { graphSize } from "../../src/ingest/run-record.js";
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
    // the playbooks are not copied in: only stubs of the SEO checks this site's audit used (the rules live in the shared reference graph)
    expect(c.Rule).toBeGreaterThan(5);
    const copied = await q<{ c: number }>(
      "MATCH (n:Entity) WHERE (n:Rule AND n.refStub IS NULL) OR n:Playbook OR (n:Event AND n.kind = 'google-update') OR (n:Document AND n.kind = 'playbook') RETURN count(n) AS c");
    expect(copied[0]!.c).toBe(0);
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

  it("the map is arranged at the end: every page and the business carry a rank and a group, and the site's own links make the groups (issue #38, G5)", async () => {
    const rows = await q<{ id: string; label: string; rank: number | null; community: number | null }>(
      "MATCH (n:Entity) WHERE n:Page OR n:Business OR n:Product RETURN n.id AS id, head([l IN labels(n) WHERE l <> 'Entity' AND l <> 'Searchable']) AS label, n.rank AS rank, n.community AS community ORDER BY id");
    expect(rows.length).toBeGreaterThan(first.pages);
    expect(rows.filter((r) => typeof r.rank !== "number" || typeof r.community !== "number")).toEqual([]);
    // the Brain map reads the stored values (no JavaScript ranking of its own)
    const { overviewGraph } = await import("../../src/server/reads.js");
    const view = await overviewGraph(g);
    const stored = new Map(rows.map((r) => [r.id, r]));
    const shown = view.nodes.filter((n) => stored.has(n.id));
    expect(shown.length).toBeGreaterThan(0);
    for (const n of shown) expect(n.community, n.id).toBe(stored.get(n.id)!.community);
    // pages that link to each other share a group: home links to every key page, so most pages sit in few groups
    const pageGroups = new Set(rows.filter((r) => r.label === "Page").map((r) => r.community));
    expect(pageGroups.size).toBeLessThan(first.pages);
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

  it("each page's SEO score is a reading that MEASURES the Page as well as a property on it (G26)", async () => {
    const rows = await q<{ id: string; prop: number; v: number; day: string; src: string }>(
      `MATCH (o:Observation {metric:'seo_page_score'})-[m:MEASURES]->(p:Page), (o)-[s:SOURCED_FROM]->(d:Document {kind:'report'})
       WHERE m.until IS NULL AND s.until IS NULL RETURN p.id AS id, p.seoScore AS prop, o.value AS v, o.asOf AS day, d.id AS src ORDER BY id`);
    expect(rows).toHaveLength(first.pages);
    expect(rows.every((r) => r.v === r.prop && r.day === "2026-10-15" && /^document:website-seo-audit-/.test(r.src))).toBe(true);
    // the contact page has no viewport (a failing check), so it scores lower than a page that passes everything
    const contact = rows.find((r) => r.id.endsWith("/contact"))!;
    expect(contact.v).toBeLessThan(Math.max(...rows.map((r) => r.v)));
  });

  it("the run is a node with edges (G17): an onboard Event AFFECTS the business and is SOURCED_FROM the form, with the model, ontology and timing", async () => {
    const rows = await q<{ id: string; pages: number; seo: number | null; model: string; onto: number; ms: number; soft: number; biz: string; form: string; formKind: string }>(
      `MATCH (e:Event {kind:'onboard'})-[a:AFFECTS]->(b:Business)
       MATCH (e)-[s:SOURCED_FROM]->(d:Document) WHERE a.until IS NULL AND s.until IS NULL
       RETURN e.id AS id, e.pages AS pages, e.seoScore AS seo, e.model AS model, e.ontologyVersion AS onto, e.durationMs AS ms, e.softErrors AS soft,
              b.id AS biz, d.id AS form, d.kind AS formKind`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pages: first.pages, seo: first.seoScore, model: "haiku", onto: ONTOLOGY_VERSION, soft: 0, formKind: "form" });
    expect(rows[0]!.form).toMatch(/^document:onboarding-form-/);
    expect(rows[0]!.ms).toBeGreaterThanOrEqual(0);
    expect(rows[0]!.biz).toMatch(/^business:/);
    // the edges carry their source and date like every other edge
    const [edge] = await q<{ src: string; asOf: string }>("MATCH (:Event {kind:'onboard'})-[a:AFFECTS]->(:Business) RETURN a.src AS src, a.asOf AS asOf");
    expect(edge).toEqual({ src: rows[0]!.id, asOf: "2026-10-15T09:00:00.000Z" });
  });

  it("graph hygiene is a metric on the business, each reading sourced from the run that measured it (G17)", async () => {
    const rows = await q<{ metric: string; value: number; unit: string; run: string }>(
      `MATCH (o:Observation)-[m:MEASURES]->(b:Business) WHERE o.metric IN ['graph_nodes', 'merged_count', 'privacy_scan_hits'] AND m.until IS NULL
       MATCH (o)-[s:SOURCED_FROM]->(e:Event) WHERE s.until IS NULL
       RETURN o.metric AS metric, o.value AS value, o.unit AS unit, e.kind AS run ORDER BY metric, run, o.id`);
    expect(rows.map((r) => `${r.metric}@${r.run}`)).toEqual(["graph_nodes@onboard", "merged_count@onboard", "privacy_scan_hits@privacy-scan"]);
    const size = rows.find((r) => r.metric === "graph_nodes")!.value;
    expect(size).toBe(await graphSize(g)); // the run records themselves are not counted, so a re-run does not make the graph "bigger"
    expect(size).toBeGreaterThan(first.pages);
    expect(rows.find((r) => r.metric === "privacy_scan_hits")!.value).toBe(0);
  });

  it("the privacy scan ran at the end and is recorded: an Event that AFFECTS the business and a privacy_scan_hits reading of 0 (G12)", async () => {
    const rows = await q<{ hits: number; summary: string }>(
      "MATCH (e:Event {kind:'privacy-scan'})-[a:AFFECTS]->(:Business) WHERE a.until IS NULL RETURN e.hits AS hits, e.summary AS summary");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.hits).toBe(0);
    expect(rows[0]!.summary).toMatch(/found nothing/);
  });

  it("every fact the model read records which model said it and under which ontology (G17c)", async () => {
    const mentions = await q<{ by: string | null; onto: number | null }>(
      "MATCH (:Document {kind:'webpage'})-[m:MENTIONS]->(x:Entity) WHERE m.until IS NULL AND (x:Product OR x:Audience OR x:Need OR x:Content) RETURN m.extractedBy AS by, m.ontologyVersion AS onto");
    expect(mentions.length).toBeGreaterThan(0);
    expect(mentions.every((m) => m.by === "haiku" && m.onto === ONTOLOGY_VERSION)).toBe(true);
    const rel = await q<{ t: string; by: string | null; onto: number | null }>(
      "MATCH (a:Entity)-[r:HAS_NEED|TARGETS]->(b:Entity) WHERE r.until IS NULL AND r.evidence IS NOT NULL RETURN type(r) AS t, r.extractedBy AS by, r.ontologyVersion AS onto");
    expect(rel.length).toBeGreaterThan(0);
    expect(rel.every((r) => r.by === "haiku" && r.onto === ONTOLOGY_VERSION)).toBe(true);
    // a deterministic edge (the crawl's own) is not claimed by a model
    expect(await q("MATCH (:Page)-[r:PART_OF]->(:Channel) WHERE r.extractedBy IS NOT NULL RETURN r")).toEqual([]);
  });

  it("re-runs as a no-op: no new nodes or edges, the LLM is not asked again, the same counts apart from the second run's own record", async () => {
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
    // what the run wrote about itself (an Event for the run and one for the privacy scan, with their edges) is the only
    // difference: the same day's readings are the same Observations, and the graph did not grow
    const own = new Set(["Event", "rel:AFFECTS", "rel:SOURCED_FROM", "edges"]);
    const strip = (c: Record<string, number>) => Object.fromEntries(Object.entries(c).filter(([k]) => !own.has(k)));
    expect(strip(second.counts)).toEqual(strip(first.counts));
    expect(second.counts.Event).toBe(first.counts.Event! + 2);
    expect(second.counts["rel:AFFECTS"]).toBe(first.counts["rel:AFFECTS"]! + 2);
    expect((await q("MATCH (e:Event) WHERE e.kind IN ['onboard', 'privacy-scan'] RETURN e.id")).length).toBe(4);
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
