// A page the crawl found before and no longer finds (graph audit G26): onboarding re-run closes its PART_OF edge with the reason,
// only after a crawl that saw the whole site, and keeps the page, its document and its history. Found again later, it is
// part of the site again. The first crawl is the real one on the fixture site; the later ones replay its pages, minus one.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeAll, openGraphByName, type GraphHandle } from "../../src/graph/client.js";
import { crawlSite, pageId, type CrawlResult, type PageData } from "../../src/ingest/sources/website/index.js";
import { onboard, type OnboardDeps } from "../../src/onboard/onboard.js";
import { VANISHED_REASON, crawlWasComplete } from "../../src/onboard/vanished.js";
import { testGraph } from "../helpers/graph.js";
import { FakeLlm } from "../helpers/fake-llm.js";
import { startSite, type SiteServer } from "../fixtures/website/server.js";

describe("a page that leaves the website", () => {
  let site: SiteServer;
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  let slug: string;
  let metaGraph: string;
  let dataDir: string;
  let first: CrawlResult;
  let gone: PageData;
  // ahead of the pages' own fetch time (real, from the crawl), so a close dated by this clock is never cut back to a page's start
  let clock = Date.now() + 24 * 3600_000;
  const llm = new FakeLlm();
  const q = <T>(cypher: string, params?: Record<string, unknown>) => g.roQuery<T>(cypher, params);

  const deps = (crawl: OnboardDeps["crawl"]): OnboardDeps => ({
    runner: llm, model: "haiku", dataDir, tenantOpts: { metaGraph }, now: () => clock, crawl,
    embed: async (texts) => texts.map(() => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0))),
    crawlOptions: { allowHosts: [`127.0.0.1:${site.port}`], minDelayMs: 0, maxLinkChecks: 0 },
  });
  const input = () => ({ name: "Kestrel & Oak Studio", slug, url: `${site.origin}/`, industry: "architecture and interior design studio" });
  // replays the first crawl's pages minus `without`, as the crawl of the day
  // (a later crawl reads its pages later: their own fetch time moves with the clock, as it does for a real one)
  const replay = (without: PageData | undefined, over: Partial<CrawlResult> = {}): OnboardDeps["crawl"] => async (_url, opts) => {
    const pages = first.pages.filter((p) => p !== without).map((p) => ({ ...p, fetchedAt: new Date(clock).toISOString() }));
    for (const p of pages) await opts.onPage?.(p);
    return { ...first, pages, ...over };
  };
  const edge = () => q<{ open: boolean; reason: string | null; until: number | null }>(
    "MATCH (p:Page {id:$p})-[r:PART_OF]->(:Channel {id:'channel:website'}) RETURN r.until IS NULL AS open, r.closeReason AS reason, r.until AS until ORDER BY r.recordedAt, id(r)", { p: pageId(gone.finalUrl) });

  beforeAll(async () => {
    site = await startSite();
    ({ g, cleanup } = await testGraph());
    slug = g.name.replace(/^allevia_/, "");
    metaGraph = `allevia_test_meta_${slug.slice(5)}`;
    dataDir = mkdtempSync(join(tmpdir(), "allevia-onboard-gone-"));
    const real = await onboard(input(), () => {}, deps(async (url, opts) => (first = await crawlSite(url, opts))));
    expect(real.ok).toBe(true);
    // a page that is a leaf: nothing else on the site needs it
    gone = first.pages.find((p) => /\/projects\/clifton-loft/.test(p.finalUrl)) ?? first.pages.at(-1)!;
  }, 120_000);

  afterAll(async () => {
    await cleanup();
    await (await openGraphByName(metaGraph)).drop();
    await closeAll();
    await site.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("is part of the website after the first crawl", async () => {
    expect(await edge()).toEqual([{ open: true, reason: null, until: null }]);
  });

  it("a crawl that stopped early or lost pages proves nothing: the edge stays open", async () => {
    clock += 24 * 3600_000;
    for (const over of [{ timedOut: true }, { browserError: "no browser" }] as Array<Partial<CrawlResult>>) {
      const r = await onboard(input(), () => {}, deps(replay(gone, over)));
      expect(r.ok).toBe(true);
    }
    expect(await edge()).toEqual([{ open: true, reason: null, until: null }]);
  }, 120_000);

  it("a complete crawl that no longer finds it closes the edge with the reason, and keeps the page and what was written about it", async () => {
    clock += 24 * 3600_000;
    const r = await onboard(input(), () => {}, deps(replay(gone)));
    expect(r.ok).toBe(true);
    expect(r.stats.edgesClosed).toBeGreaterThanOrEqual(1);
    const rows = await edge();
    expect(rows).toEqual([{ open: false, reason: VANISHED_REASON, until: clock }]);
    // it left the website, not the graph: the page, its document and its checks are still there, and the others are untouched
    expect(await q("MATCH (p:Page {id:$p})-[:SOURCED_FROM]->(d:Document {kind:'webpage'}) RETURN p.id AS id", { p: pageId(gone.finalUrl) })).toHaveLength(1);
    const open = await q<{ c: number }>("MATCH (p:Page)-[r:PART_OF]->(:Channel {id:'channel:website'}) WHERE r.until IS NULL RETURN count(p) AS c");
    expect(open[0]!.c).toBe(first.pages.length - 1);
  }, 120_000);

  it("found again, the page is part of the website again (a new edge; the closed one stays as history)", async () => {
    clock += 24 * 3600_000;
    const r = await onboard(input(), () => {}, deps(replay(undefined)));
    expect(r.ok).toBe(true);
    const rows = await edge();
    expect(rows.map((x) => x.open)).toEqual([false, true]);
    expect(rows[0]!.reason).toBe(VANISHED_REASON);
  }, 120_000);
});

describe("crawlWasComplete", () => {
  const page = (error?: string): PageData => ({ finalUrl: "https://x.example/", ...(error ? { error } : {}) }) as PageData;
  it("needs a crawl that did not stop at its time limit, had a browser, found pages under the cap, and lost none", () => {
    expect(crawlWasComplete({}, [page(), page()], 40)).toBe(true);
    expect(crawlWasComplete({ timedOut: true }, [page()], 40)).toBe(false);
    expect(crawlWasComplete({ browserError: "no browser" }, [page()], 40)).toBe(false);
    expect(crawlWasComplete({}, [], 40)).toBe(false);
    expect(crawlWasComplete({}, [page(), page()], 2)).toBe(false); // it hit the page cap: more pages may exist
    expect(crawlWasComplete({}, [page(), page("timeout")], 40)).toBe(false);
  });
});
