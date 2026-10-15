// A website that cannot be read (blocked, rate limited, needs scripts or a login, says nothing) must not end in
// "Casa Lucio is ready". The trial of a restaurant that answered every request with HTTP 429 reported success, 279 things
// in the graph and three goals "we'll know after your first full week": a shell that looked like a finished set-up.
// Now the run says why, in plain words, and stops before it writes a plan for a business it knows nothing about.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OnboardEvent } from "../../shared/contracts.js";
import { closeAll, openGraphByName, type GraphHandle } from "../../src/graph/client.js";
import { onboard, whyUnreadable, type OnboardDeps } from "../../src/onboard/onboard.js";
import type { CrawlResult, PageData } from "../../src/ingest/sources/website/index.js";
import { testGraph } from "../helpers/graph.js";
import { FakeLlm } from "../helpers/fake-llm.js";

const page = (over: Partial<PageData>): PageData => ({
  url: "https://closed.example/", finalUrl: "https://closed.example/", redirects: [], status: 200, fetchedAt: "2026-10-15T09:00:00.000Z", bytes: 10,
  titleCount: 0, metaDescriptionCount: 0, h1: [], h2: [], text: "", wordCount: 0, internalLinks: [], externalLinks: [], images: [], jsonLd: [],
  jsonLdTypes: [], jsonLdErrors: 0, og: {}, timing: { responseMs: 1, fetchMs: 1 }, mixedContent: [], ...over,
});
const crawled = (pages: PageData[], over: Partial<CrawlResult> = {}): CrawlResult => ({
  startUrl: "https://closed.example/", origin: "https://closed.example", pages, skipped: [], robots: { status: 200, disallowAll: false, sitemaps: [] },
  sitemapUrls: 0, linkStatus: {}, screenshots: {}, requests: 3, startedAt: "2026-10-15T09:00:00.000Z", finishedAt: "2026-10-15T09:00:05.000Z", ...over,
});

describe("whyUnreadable", () => {
  it("says it in the owner's words, never in HTTP", () => {
    expect(whyUnreadable(crawled([page({ status: 429 })]))).toMatch(/asked us to slow down/);
    expect(whyUnreadable(crawled([page({ status: 403 })]))).toMatch(/would not let us in/);
    expect(whyUnreadable(crawled([page({ status: 404 })]))).toMatch(/no page at that address/i);
    expect(whyUnreadable(crawled([page({ status: 503 })]))).toMatch(/trouble on its side/);
    expect(whyUnreadable(crawled([], { robots: { status: 200, disallowAll: true, sitemaps: [] } }))).toMatch(/asks robots not to read/);
    expect(whyUnreadable(crawled([page({ status: 200, text: "Loading", wordCount: 1 })]))).toMatch(/log in|scripts/i);
    expect(whyUnreadable(crawled([]))).toMatch(/could not reach/i);
    for (const s of [429, 403, 404, 503]) expect(whyUnreadable(crawled([page({ status: s })]))).not.toMatch(/HTTP|\b\d{3}\b/);
  });
});

describe("onboard: a site that cannot be read", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  let slug: string;
  let metaGraph: string;
  let dataDir: string;
  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    slug = g.name.replace(/^allevia_/, "");
    metaGraph = `allevia_test_meta_${slug.slice(5)}`;
    dataDir = mkdtempSync(join(tmpdir(), "allevia-onboard-unreadable-"));
  });
  afterAll(async () => {
    await cleanup();
    await (await openGraphByName(metaGraph)).drop();
    await closeAll();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("reports why, stops before the plan, asks the model nothing and writes no goals", async () => {
    const llm = new FakeLlm();
    const events: OnboardEvent[] = [];
    const deps: OnboardDeps = {
      runner: llm, model: "haiku", dataDir, tenantOpts: { metaGraph }, now: () => Date.parse("2026-10-15T09:00:00.000Z"),
      crawl: async () => crawled([page({ status: 429 })]),
    };
    const r = await onboard({ name: "Casa Lucio", slug, url: "https://closed.example/", country: "Spain" }, (e) => events.push(e), deps);
    expect(r.ok).toBe(false);
    const errors = events.filter((e): e is Extract<OnboardEvent, { type: "error" }> => e.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/closed\.example/);
    expect(errors[0]!.message).toMatch(/asked us to slow down/);
    expect(events.some((e) => e.type === "done")).toBe(false);
    expect(events.filter((e) => e.type === "stage").map((e) => (e as { stage: string }).stage)).toEqual(["crawl"]);
    expect(llm.calls).toHaveLength(0);
    expect(await g.roQuery("MATCH (gl:Goal) RETURN gl.id")).toEqual([]);
    expect(await g.roQuery("MATCH (p:Program) RETURN p.id")).toEqual([]);
  });
});
