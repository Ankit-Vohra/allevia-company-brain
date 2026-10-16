// The map step (rank and groups, G5) is best effort: when it throws, the owner gets one plain soft note, the run still
// reaches done, and everything written before it stays.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OnboardEvent } from "../../shared/contracts.js";
import { closeAll, openGraphByName, type GraphHandle } from "../../src/graph/client.js";
import { onboard, softMessage, type OnboardResult } from "../../src/onboard/onboard.js";
import { testGraph } from "../helpers/graph.js";
import { FakeLlm } from "../helpers/fake-llm.js";
import { startSite, type SiteServer } from "../fixtures/website/server.js";

vi.mock("../../src/ingest/librarian.js", async (orig) => ({
  ...(await orig<typeof import("../../src/ingest/librarian.js")>()),
  rankAndCommunities: async () => { throw new Error("algo.pageRank timed out"); },
}));

describe("onboard: a map that cannot be arranged is a soft note, not a failed onboarding", () => {
  let site: SiteServer;
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  let metaGraph: string;
  let dataDir: string;
  let run: OnboardResult;
  const events: OnboardEvent[] = [];

  beforeAll(async () => {
    site = await startSite();
    ({ g, cleanup } = await testGraph());
    const slug = g.name.replace(/^allevia_/, "");
    metaGraph = `allevia_test_meta_${slug.slice(5)}`;
    dataDir = mkdtempSync(join(tmpdir(), "allevia-onboard-map-"));
    run = await onboard({ name: "Kestrel Studio", slug, url: `${site.origin}/`, industry: "architecture and interior design studio" }, (e) => events.push(e), {
      runner: new FakeLlm(), model: "haiku", dataDir, tenantOpts: { metaGraph }, now: () => Date.parse("2026-10-15T09:00:00.000Z"),
      embed: async (texts) => texts.map(() => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0))),
      crawlOptions: { allowHosts: [`127.0.0.1:${site.port}`], minDelayMs: 0, maxLinkChecks: 0, maxPages: 6 },
    });
  }, 120_000);

  afterAll(async () => {
    await cleanup();
    await (await openGraphByName(metaGraph)).drop();
    await closeAll();
    await site.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("says so in plain words, finishes, and keeps what it wrote", async () => {
    expect(run.ok).toBe(true);
    expect(events.filter((e) => e.type === "error")).toEqual([{ type: "error", message: softMessage("map"), soft: true }]);
    expect(softMessage("map")).not.toMatch(/algo|pageRank|rank|community|graph|node/i);
    expect(run.errors).toEqual([expect.stringMatching(/^map: algo\.pageRank timed out/)]);
    expect(events.at(-1)!.type).toBe("done");
    expect((await g.roQuery<{ c: number }>("MATCH (p:Page) RETURN count(p) AS c"))[0]!.c).toBe(run.pages);
    expect((await g.roQuery<{ c: number }>("MATCH (n:Entity) WHERE n.rank IS NOT NULL RETURN count(n) AS c"))[0]!.c).toBe(0);
  });
});
