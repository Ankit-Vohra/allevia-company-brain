// onboard() filters what ANY crawler hands it, not only the built-in one: a crawl function that returns raw pages (an
// older build, a test double, a future source) still ends with placeholders in the graph and in every model prompt.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { OnboardEvent } from "../../shared/contracts.js";
import { closeAll, openGraphByName, type GraphHandle } from "../../src/graph/client.js";
import { scanGraph } from "../../src/ingest/privacy.js";
import type { CrawlResult, PageData } from "../../src/ingest/sources/website/index.js";
import { onboard } from "../../src/onboard/onboard.js";
import { FakeLlm } from "../helpers/fake-llm.js";
import { testGraph } from "../helpers/graph.js";

const ORIGIN = "https://www.example-studio.test";
const EMAIL = "hello@example-studio.test";
const PHONE = "+91 98765 43210";

const fakeEmbed = async (texts: string[]) => texts.map((t) => {
  const h = createHash("sha256").update(t).digest();
  const v = Array.from({ length: 384 }, (_, i) => (h[i % 32]! - 127.5) / 127.5 + i / 1000);
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
});

const words = (s: string) => Array.from({ length: 40 }, (_, i) => `${s}${i}`).join(" ");
const page = (path: string, over: Partial<PageData>): PageData => ({
  url: `${ORIGIN}${path}`, finalUrl: `${ORIGIN}${path}`, redirects: [], status: 200, fetchedAt: "2026-10-15T09:00:00.000Z", bytes: 4000,
  titleCount: 1, metaDescriptionCount: 1, h1: ["Example Studio"], h2: [], text: "", wordCount: 80, internalLinks: [], externalLinks: [],
  images: [], jsonLd: [], jsonLdTypes: [], jsonLdErrors: 0, og: {}, lang: "en", viewport: "width=device-width", timing: { responseMs: 50, fetchMs: 90 }, mixedContent: [], ...over,
});

// raw: every page says its email and phone, the way an unfiltered crawler would report it
const PAGES: PageData[] = [
  page("/", {
    title: "Example Studio", metaDescription: `An architecture studio. Call ${PHONE}.`,
    text: `We design calm homes. ${words("home")}\n\nWrite to ${EMAIL}.`, internalLinks: [`${ORIGIN}/contact`],
    externalLinks: ["https://www.instagram.com/avs_atelier/", "https://www.linkedin.com/company/avs-atelier/"],
    jsonLd: [{ "@type": "LocalBusiness", email: EMAIL, telephone: PHONE, address: { "@type": "PostalAddress", addressLocality: "Raipur", addressCountry: "IN" },
      sameAs: ["https://www.instagram.com/avs_atelier/"] }],
    jsonLdTypes: ["LocalBusiness", "PostalAddress"],
  }),
  page("/contact", { title: `Contact | ${EMAIL}`, metaDescription: `Email ${EMAIL}`, text: `Email ${EMAIL} or call ${PHONE}. ${words("contact")}`, h1: [`Write to ${EMAIL}`] }),
];

const crawl = async (_url: string, opts: { onPage?: (p: PageData) => void | Promise<void> }): Promise<CrawlResult> => {
  for (const p of PAGES) await opts.onPage?.(p);
  return {
    startUrl: `${ORIGIN}/`, origin: ORIGIN, pages: PAGES, skipped: [], robots: { status: 200, disallowAll: false, sitemaps: [] }, sitemapUrls: 0,
    linkStatus: {}, screenshots: {}, requests: 3, startedAt: "2026-10-15T09:00:00.000Z", finishedAt: "2026-10-15T09:00:05.000Z",
  };
};

describe("onboard filters raw pages from any crawler", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  let metaGraph: string;
  let dataDir: string;
  const llm = new FakeLlm();
  const events: OnboardEvent[] = [];

  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    const slug = g.name.replace(/^allevia_/, "");
    metaGraph = `allevia_test_meta_${slug.slice(5)}`;
    dataDir = mkdtempSync(join(tmpdir(), "allevia-onboard-privacy-"));
    await onboard({ name: "Example Studio", slug, url: `${ORIGIN}/`, industry: "architecture studio" }, (e) => events.push(e), {
      runner: llm, model: "haiku", dataDir, embed: fakeEmbed, tenantOpts: { metaGraph }, crawl, now: () => Date.parse("2026-10-15T09:00:00.000Z"),
    });
  }, 120_000);

  afterAll(async () => {
    await cleanup();
    await (await openGraphByName(metaGraph)).drop();
    await closeAll();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("wrote the pages, and wrote them redacted", async () => {
    expect(events.filter((e) => e.type === "error")).toEqual([]);
    const t = await g.roQuery<{ id: string; t: string }>("MATCH (c:Chunk) RETURN c.id AS id, c.text AS t ORDER BY c.id");
    expect(t.length).toBeGreaterThanOrEqual(2);
    expect(t.map((c) => c.t).join("\n")).toContain("[redacted:email]");
    const p = await g.roQuery<{ title: string; summary: string | null }>("MATCH (p:Page) WHERE p.path = '/contact' RETURN p.title AS title, p.summary AS summary");
    expect(p).toEqual([{ title: "Contact | [redacted:email]", summary: "Email [redacted:email]" }]);
  });

  it("no node or edge holds the address or the number, and the privacy scan is clean", async () => {
    const nodes = await g.roQuery<{ vals: unknown[] }>("MATCH (n) RETURN [k IN keys(n) WHERE NOT k IN ['embedding', 'textEmbedding'] | n[k]] AS vals ORDER BY id(n)");
    const edges = await g.roQuery<{ vals: unknown[] }>("MATCH ()-[r]->() RETURN [k IN keys(r) | r[k]] AS vals ORDER BY id(r)");
    const strings = [...nodes, ...edges].flatMap((r) => r.vals.flat()).filter((v): v is string => typeof v === "string");
    expect(strings.filter((s) => /hello@|98765|43210/.test(s))).toEqual([]);
    expect(await scanGraph(g)).toEqual([]);
  });

  it("no prompt carries them either, and the profile links still become Channels", async () => {
    expect(llm.calls.length).toBeGreaterThan(3);
    expect(llm.calls.filter((c) => /hello@|98765|43210/.test(`${c.system}\n${c.prompt}`))).toEqual([]);
    const ch = await g.roQuery<{ id: string; handle: string }>("MATCH (c:Channel)-[:PART_OF]->(:Business) WHERE c.id IN ['channel:instagram', 'channel:linkedin'] RETURN c.id AS id, c.handle AS handle ORDER BY c.id");
    expect(ch).toEqual([{ id: "channel:instagram", handle: "avs_atelier" }, { id: "channel:linkedin", handle: "avs-atelier" }]);
  });
});
