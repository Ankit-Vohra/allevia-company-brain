// A website states claims, not internal work: a "Decision" or "Task" read off a public page is marketing copy or a job
// advert, not something the team decided or has to do. On the trial onboardings the extraction made "Decision" nodes from
// blog posts ("Close garden care to new customers") and "Task" nodes from a jobs page, and the knowledge detector then
// told the owner "2 decisions with no evidence on record" on day one (docs/onboarding-trials.md).
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractPages, type PageData } from "../../../src/ingest/sources/website/index.js";
import type { LlmRunner } from "../../../src/ingest/llm.js";
import type { KnownEntity } from "../../../src/ingest/extract.js";

const O = "https://www.shop.example";
const text = "We sell plants, pots and coffee, and we are family run since 2011. ".repeat(8);
const page: PageData = {
  url: `${O}/`, finalUrl: `${O}/`, redirects: [], status: 200, fetchedAt: "2026-10-15T09:00:00.000Z", bytes: 1, title: "Home", titleCount: 1,
  metaDescriptionCount: 0, h1: [], h2: [], text, wordCount: text.split(/\s+/).length, internalLinks: [], externalLinks: [], images: [],
  jsonLd: [], jsonLdTypes: [], jsonLdErrors: 0, og: {}, timing: { responseMs: 1, fetchMs: 1 }, mixedContent: [],
};
const runner: LlmRunner = {
  async structured() {
    return {
      entities: [
        { type: "Product", name: "Garden plants", summary: "Plants for the garden." },
        { type: "Decision", name: "Close garden care to new customers", summary: "The business stopped taking new garden care customers." },
        { type: "Task", name: "Fill barista opening", summary: "A job advert for a barista." },
      ],
      relations: [
        { from: "Garden plants", fromType: "Product", type: "AFFECTS", to: "Close garden care to new customers", toType: "Decision", evidence: "we are family run", conf: 0.8 },
        { from: "Fill barista opening", fromType: "Task", type: "BLOCKS", to: "Garden plants", toType: "Product", evidence: "we are family run", conf: 0.8 },
      ],
      observations: [],
    };
  },
};

describe("extractPages from a public website", () => {
  it("keeps products and drops decisions and tasks, with every relation that touched them", async () => {
    const cache = mkdtempSync(join(tmpdir(), "allevia-webtypes-"));
    try {
      const biz: KnownEntity = { id: "business:shop", type: "Business", name: "Shop" };
      const docs = await extractPages([page], {
        business: { id: biz.id, name: biz.name }, runner, model: "haiku", cacheDir: cache, existing: new Map([[biz.id, biz]]), websiteHost: "www.shop.example",
      });
      const w = docs[0]!.write;
      expect(w.nodes.map((n) => n.type)).toEqual(["Product"]);
      expect(w.edges.filter((e) => !["SOURCED_FROM", "MENTIONS"].includes(e.type))).toEqual([]); // no AFFECTS or BLOCKS survive
      expect(JSON.stringify(w)).not.toMatch(/Close garden care|barista/i);
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });
});
