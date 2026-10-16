// The privacy scan at the end of onboarding (graph audit G12): it ran only in ingest and the CLI before, never for a business
// read from a website. A hit never blocks onboarding: it is a soft note in plain words, an Event and a privacy_scan_hits
// Observation that MEASURES the Business, with only ids and prop names kept (never the value). Free text the owner typed
// into the form is redacted like any source.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OnboardEvent } from "../../shared/contracts.js";
import { closeAll, openGraphByName, type GraphHandle } from "../../src/graph/client.js";
import { writeBatch } from "../../src/graph/upsert.js";
import { onboard, softMessage, type OnboardResult } from "../../src/onboard/onboard.js";
import { testGraph } from "../helpers/graph.js";
import { FakeLlm } from "../helpers/fake-llm.js";
import { startSite, type SiteServer } from "../fixtures/website/server.js";

const LEAK = "jane.doe@gmail.com";
const PHONE = "+91 98765 43210";

describe("onboard: a personal detail found by the end-of-run privacy scan is a soft note, an Event and a reading", () => {
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
    dataDir = mkdtempSync(join(tmpdir(), "allevia-onboard-scan-"));
    // something already in the graph that a source boundary never saw (a chat-written node, an old import)
    const s = await writeBatch(g, { nodes: [{ type: "Memory", id: "memory:leak", name: `Reach me at ${LEAK}` }] }, Date.parse("2026-10-14T09:00:00.000Z"));
    expect(s.errors).toEqual([]);
    run = await onboard({ name: "Kestrel Studio", slug, url: `${site.origin}/`, industry: `architecture studio, call ${PHONE}` }, (e) => events.push(e), {
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

  it("never blocks: the run finishes, the owner gets one plain note, and the log keeps ids and prop names only", () => {
    expect(run.ok).toBe(true);
    expect(events.at(-1)!.type).toBe("done");
    expect(events.filter((e) => e.type === "error")).toEqual([{ type: "error", message: softMessage("privacy"), soft: true }]);
    expect(softMessage("privacy")).not.toMatch(/scan|graph|node|redact/i);
    expect(run.errors).toEqual([expect.stringMatching(/^privacy: 1 possible personal detail\(s\) in the graph \(email 1\): memory:leak \.name \(email\)$/)]);
    expect(run.errors.join(" ")).not.toContain("jane.doe");
  });

  it("records the scan as an Event that AFFECTS the business and a privacy_scan_hits reading that MEASURES it, with no value kept", async () => {
    const rows = await g.roQuery<{ hits: number; kinds: string[]; value: number; metric: string; run: string }>(
      `MATCH (e:Event {kind:'privacy-scan'})-[a:AFFECTS]->(b:Business) WHERE a.until IS NULL
       MATCH (o:Observation {metric:'privacy_scan_hits'})-[m:MEASURES]->(b) WHERE m.until IS NULL
       MATCH (o)-[s:SOURCED_FROM]->(e) WHERE s.until IS NULL
       RETURN e.hits AS hits, e.hitKinds AS kinds, o.value AS value, o.metric AS metric, e.kind AS run ORDER BY e.id`);
    expect(rows).toEqual([{ hits: 1, kinds: ["email:1"], value: 1, metric: "privacy_scan_hits", run: "privacy-scan" }]);
    const strings = (await g.roQuery<{ vals: unknown[] }>("MATCH (n:Event) RETURN [k IN keys(n) | n[k]] AS vals ORDER BY n.id")).flatMap((r) => r.vals.flat());
    expect(strings.filter((v) => typeof v === "string" && v.includes("jane.doe"))).toEqual([]);
  });

  it("what the owner typed into the form is redacted before anything reads or writes it", async () => {
    const [form] = await g.roQuery<{ industry: string }>("MATCH (d:Document {kind:'form'}) RETURN d.industry AS industry");
    expect(form!.industry).toBe("architecture studio, call [redacted:phone]");
    const [biz] = await g.roQuery<{ industry: string | null }>("MATCH (b:Business) RETURN b.industry AS industry");
    expect(biz!.industry ?? "").not.toContain("98765");
  });
});
