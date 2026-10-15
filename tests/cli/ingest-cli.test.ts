// The ingest and privacy-scan commands: registered, arguments validated, report summary printed without values.
import { describe, it, expect } from "vitest";
import { loadCommands } from "../../src/cli.js";
import { formatReport, parseIngestArgs } from "../../src/cli/ingest.js";
import type { PipelineReport } from "../../src/ingest/pipeline.js";
import { TENANT_CONFIGS, tenantConfig } from "../../src/tenant-config.js";

describe("ingest CLI", () => {
  it("registers ingest and privacy-scan", async () => {
    const names = (await loadCommands()).map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["ingest", "privacy-scan"]));
  });

  it("parses sources, the document limit, the model and dry runs", () => {
    expect(parseIngestArgs(["aamdani"])).toEqual({ tenant: "aamdani", dryRun: false });
    expect(parseIngestArgs(["aamdani", "--sources", "brain, ops,brain", "--limit-docs", "10", "--model", "haiku", "--dry-run"]))
      .toEqual({ tenant: "aamdani", sources: ["brain", "ops"], limitDocs: 10, model: "haiku", dryRun: true });
    expect(() => parseIngestArgs(["aamdani", "--sources", "brain,web"])).toThrow(/unknown source.*web/);
    expect(() => parseIngestArgs(["aamdani", "--limit-docs", "ten"])).toThrow(/whole number/);
    expect(() => parseIngestArgs([])).toThrow(/tenant/);
  });

  it("knows the configured tenants; aamdani's founder names and sources are config", () => {
    expect(tenantConfig("aamdani")).toMatchObject({ founderNames: ["Ankit", "the founder"], github: { repos: ["Ankit-Vohra/aamdani-brain"] } });
    expect(tenantConfig("aamdani").sources).toEqual(["brain", "ops", "playbooks", "simads", "github"]);
    expect(() => tenantConfig("nope")).toThrow(/unknown tenant "nope"/);
    for (const [slug, c] of Object.entries(TENANT_CONFIGS)) expect(c.slug).toBe(slug);
  });

  it("summarises a report in a few lines", () => {
    const r = {
      tenant: "aamdani", startedAt: "", finishedAt: "", dryRun: false, model: "haiku", durationMs: 61_000, vaultHead: "8a6f6089baf9aaaa",
      sources: [{ source: "brain", docs: 58, nodes: 1158, edges: 2146, observations: 0, skipped: 66, ms: 1200 }],
      stats: { nodesCreated: 10, nodesUpdated: 2, versions: 1, edgesCreated: 20, edgesClosed: 1, observations: 5, errors: 0 },
      extraction: { docs: 58, cached: 3, entities: 400, relations: 300, observations: 50, olderReadings: 2, dropped: 12, candidates: 58, skipped: 0, failed: 0, order: [], skippedDocs: [], failures: [] },
      embeddings: { entities: 900, chunks: 531 }, retired: { structure: 0, mentions: 0 },
      librarian: { knowsAbout: { edges: 700, created: 700, closed: 0, actors: 5, errors: 0 }, rank: { nodes: 2000 }, community: { nodes: 2000, communities: 80 }, orphans: { count: 3, byType: { Document: 3 }, sample: [] }, ms: 1 },
      graph: { nodes: { Chunk: 531, Document: 300 }, edges: { MENTIONS: 900 } },
      redactions: { email: 5 }, privacyScanHits: 0, privacyScan: { hits: 0, byKind: {}, sample: [] }, skipped: [], writeErrors: [],
    } satisfies PipelineReport;
    const out = formatReport(r, "/tmp/r.json");
    expect(out).toContain("Ingest aamdani · 61.0 s · model haiku · vault 8a6f6089baf9");
    expect(out).toContain("brain      1158 nodes, 2146 edges, 0 observations, 58 docs, 66 skipped");
    expect(out).toContain("Extraction: 58 candidates · 58 extracted (3 cached) · 0 over the limit · 0 failed");
    expect(out).toContain("Librarian: KNOWS_ABOUT 700 (700 new, 0 closed) · 80 communities · 3 orphans (Document 3)");
    expect(out).toContain("Privacy scan: 0 hits");
    expect(out).toContain("Report: /tmp/r.json");
  });
});
