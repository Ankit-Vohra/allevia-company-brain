// POST /api/onboard through the real server app and the real onboard(), as the web app calls it (issue #36): the live
// scenario where Chromium crashed at start in the supervised server and every page came back empty, so a site the CLI
// reads fine was reported as "almost no text". Now the pages are read from their HTML, and when they truly cannot be
// opened the reason does not blame the site.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OnboardEvent } from "../../shared/contracts.js";
import { closeAll, graphName, openGraphByName } from "../../src/graph/client.js";
import { crawlSite, type CrawlResult } from "../../src/ingest/sources/website/crawl.js";
import { onboard, type OnboardDeps } from "../../src/onboard/onboard.js";
import { FakeLlm } from "../helpers/fake-llm.js";
import { startSite, type SiteServer } from "../fixtures/website/server.js";
import { harness, post, sseBlocks, type Harness } from "./harness.js";

const fakeEmbed = async (texts: string[]) => texts.map((t) => {
  const h = createHash("sha256").update(t).digest();
  const v = Array.from({ length: 384 }, (_, i) => (h[i % 32]! - 127.5) / 127.5 + i / 1000);
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
});

describe("POST /api/onboard (real onboard, fixture site)", () => {
  let h: Harness;
  let site: SiteServer;
  let dataDir: string;
  const metaGraph = `allevia_test_meta_web${Date.now().toString(36)}`;
  const slugs: string[] = [];
  const crawlLines: string[] = [];

  beforeAll(async () => {
    h = await harness();
    site = await startSite();
    dataDir = mkdtempSync(join(tmpdir(), "allevia-onboard-web-"));
  }, 60_000);
  afterAll(async () => {
    for (const s of slugs) await (await openGraphByName(graphName(s))).drop().catch(() => {});
    await (await openGraphByName(metaGraph)).drop().catch(() => {});
    await h.cleanup();
    await closeAll();
    await site.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const app = (crawl: NonNullable<OnboardDeps["crawl"]>) => h.make({
    loadOnboard: async () => (input, emit, signal) => onboard(input, emit, {
      runner: new FakeLlm(), model: "haiku", dataDir, embed: fakeEmbed, tenantOpts: { metaGraph }, signal, crawl,
      crawlOptions: { allowHosts: [`127.0.0.1:${site.port}`], minDelayMs: 0, maxLinkChecks: 3, maxPages: 8 },
      log: (l) => crawlLines.push(l),
    }),
  });
  const run = async (a: ReturnType<typeof app>, slug: string): Promise<OnboardEvent[]> => {
    slugs.push(slug);
    const res = await post(a, "/api/onboard", { name: "Kestrel & Oak Studio", slug, url: `${site.origin}/`, country: "UK" });
    expect(res.status).toBe(200);
    return sseBlocks(await res.text()).map((b) => JSON.parse(b.data) as OnboardEvent);
  };
  const noBrowser = (url: string, opts: Parameters<typeof crawlSite>[1]): Promise<CrawlResult> =>
    crawlSite(url, { ...opts, launch: async () => { throw new Error("browserType.launch: Target page, context or browser has been closed"); } });

  it("reads the site from its HTML when the browser will not start, and sets the business up", async () => {
    const events = await run(app(noBrowser), `web_nb_${Date.now().toString(36)}`);
    expect(events.filter((e) => e.type === "page").length).toBeGreaterThan(2);
    expect(events.filter((e) => e.type === "error" && /could not read/i.test(e.message))).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect(crawlLines.some((l) => /browser would not start/.test(l))).toBe(true);
  }, 120_000);

  it("when the pages cannot be opened at all, says it is on our side, not that the site has no text", async () => {
    const dead = (url: string, opts: Parameters<typeof crawlSite>[1]) => noBrowser(url, opts).then((r) => ({
      ...r, pages: r.pages.map((p) => ({ ...p, text: "", wordCount: 0, error: "render failed: boom" })),
    }));
    const events = await run(app(dead), `web_dead_${Date.now().toString(36)}`);
    const err = events.find((e) => e.type === "error");
    expect(err).toMatchObject({ type: "error", message: expect.stringMatching(/our side/) });
    expect(JSON.stringify(events)).not.toMatch(/almost no text/);
    expect(events.some((e) => e.type === "done")).toBe(false);
  }, 60_000);
});
