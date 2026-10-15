// A Channel the playbooks put in every tenant graph as a bare anchor (Instagram, Google Search, Meta Ads) is not a
// profile the business has. A business with no Instagram must not read "Instagram: public pages" in "What your team
// can see": the rung needs a Channel that is PART_OF the business (the crawl found its link, or the owner gave it).
// Found on the trial onboardings of a dentist and a coffee shop, 2026-10-15 (docs/onboarding-trials.md).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { writeBatch } from "../../src/graph/upsert.js";
import { deriveCapabilities } from "../../src/capabilities/ladder.js";
import { testGraph } from "../helpers/graph.js";
import { NOW } from "../helpers/agent.js";

describe("capability ladder: bare playbook channels", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await ensureIndexes(g);
    const biz = "business:tiny-dental";
    const s = await writeBatch(g, {
      nodes: [
        { type: "Business", id: biz, name: "Tiny Dental" },
        { type: "Channel", id: "channel:website", name: "Website" },
        { type: "Channel", id: "channel:facebook", name: "Facebook", props: { handle: "tinydental" } },
        // the playbooks' anchors: no handle, nothing PART_OF the business
        { type: "Channel", id: "channel:instagram", name: "Instagram" },
        { type: "Channel", id: "channel:google-business", name: "Google Business Profile" },
        { type: "Rule", id: "rule:voice-reels", name: "Reels hooks", props: { kind: "voice" } },
        { type: "Page", id: "page:tiny.example/", name: "Home" },
      ],
      observations: [],
      edges: [
        { from: "channel:website", type: "PART_OF", to: biz },
        { from: "channel:facebook", type: "PART_OF", to: biz },
        { from: "page:tiny.example/", type: "PART_OF", to: "channel:website" },
        { from: "rule:voice-reels", type: "APPLIES_TO", to: "channel:instagram" },
      ],
    }, NOW);
    expect(s.errors).toEqual([]);
  });
  afterAll(async () => {
    await cleanup();
    await closeAll();
  });

  it("does not call an anchor with no profile behind it a public Instagram or Google listing", async () => {
    const caps = await deriveCapabilities(g, { now: NOW, businessId: "business:tiny-dental" });
    const mode = (k: string) => caps.find((c) => c.key === k)!.accessMode;
    expect(mode("instagram_insights")).toBe("none");
    expect(mode("gbp")).toBe("none");
    expect(mode("reviews")).toBe("none");
    // the crawl really did read the website
    expect(mode("search_console")).toBe("public");
  });

  it("still reads a channel the business owns as its public profile", async () => {
    await writeBatch(g, {
      nodes: [{ type: "Channel", id: "channel:instagram", name: "Instagram", props: { handle: "tinydental", url: "https://www.instagram.com/tinydental/" } }],
      observations: [],
      edges: [{ from: "channel:instagram", type: "PART_OF", to: "business:tiny-dental" }],
    }, NOW);
    const caps = await deriveCapabilities(g, { now: NOW, businessId: "business:tiny-dental" });
    expect(caps.find((c) => c.key === "instagram_insights")!.accessMode).toBe("public");
  });
});
