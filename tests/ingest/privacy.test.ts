import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pathAllowed, dropSensitiveSections, redact, scanGraph, SENSITIVE } from "../../src/ingest/privacy.js";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { upsertNode, upsertEdge } from "../../src/graph/upsert.js";
import { sha256 } from "../../src/util/ids.js";
import { testGraph } from "../helpers/graph.js";

describe("pathAllowed", () => {
  const allowed = [
    "60-decisions/008-x.md",
    "00-command/PENDING.md",
    "00-command/OPERATING-MANUAL.md",
    "00-command/founder-preferences.md",
    "00-command/q4-priorities.md",
    "20-growth/channels/newsletter.md",
    "10-company/overview.md",
    "30-content/videos/INDEX.md",
    "70-reports/daily/2026-10-14.md",
    "70-reports/weekly/2026-W41.md",
    "70-reports/jarvis-eval-2026-10-11.md",
    "agents/scout.md",
    "registry/agents/scout.yaml",
    "registry/connectors/print-shop.yaml",
    "CLAUDE.md",
    "README.md",
    "./60-decisions/001-shared-handbook.md",
  ];
  for (const p of allowed) {
    it(`allows ${p}`, () => {
      const r = pathAllowed(p);
      expect(r.allowed).toBe(true);
      expect(r.reason).toBeTruthy();
    });
  }

  const denied: Array<[string, RegExp]> = [
    ["15-tech/keys.md", /excluded/],
    ["15-tech/README.md", /excluded/],
    ["40-finance/forecast.md", /excluded/],
    ["50-ops/cron.md", /excluded/],
    [".claude/settings.json", /excluded/],
    [".obsidian/workspace.json", /excluded/],
    ["70-reports/security-review-2026-09-30.md", /sensitive/],
    ["70-reports/audit-notes-2026-09-30.md", /allow-list|sensitive/],
    ["00-command/founder-scratchpad.md", /allow-list/],
    ["70-reports/monthly/2026-09.md", /allow-list/],
    ["20-growth/finance-notes.md", /sensitive/],
    ["20-growth/secrets/notes.md", /sensitive/],
    ["registry/connectors/aws-box.yaml", /sensitive/],
    ["registry/agents/token-keeper.yaml", /sensitive/],
    ["60-decisions/007-backup-policy.md", /sensitive/],
    ["10-company/id.pem", /secret|sensitive|key/],
    ["10-company/.env", /secret|sensitive|key/],
    ["CLAUDE.local.md", /allow-list/],
    ["docs/readme.md", /allow-list/],
    ["../outside.md", /outside|escape|vault/],
    ["/etc/passwd", /absolute|vault-relative/],
    ["", /empty|allow-list/],
  ];
  for (const [p, why] of denied) {
    it(`denies ${JSON.stringify(p)}`, () => {
      const r = pathAllowed(p);
      expect(r.allowed).toBe(false);
      expect(r.reason).toMatch(why);
    });
  }

  it("normalises Windows separators and is case sensitive on the allow-list (deny by default)", () => {
    expect(pathAllowed("60-decisions\\001-shared-handbook.md").allowed).toBe(true);
    expect(pathAllowed("60-Decisions/001-shared-handbook.md").allowed).toBe(false);
  });

  it("exports the sensitive-name pattern", () => {
    expect(SENSITIVE.test("Security notes")).toBe(true);
    expect(SENSITIVE.test("Channel mix")).toBe(false);
  });
});

describe("dropSensitiveSections", () => {
  const md = [
    "# Pending",
    "intro line",
    "",
    "## AUDIT FIXES — PROD ROUND 2",
    "- live database change 41 applied",
    "- more audit detail",
    "",
    "### sub detail of the audit",
    "deep text",
    "",
    "## Marketing plan",
    "- keep this line",
    "",
    "## Expiring credentials",
    "| name | expires on |",
    "|---|---|",
    "| a token | 2026-12-01 |",
    "",
    "# Next top-level",
    "kept too",
  ].join("\n");

  it("removes a sensitive section with its body and sub-sections, keeps the next section of the same level", () => {
    const r = dropSensitiveSections(md);
    expect(r.dropped).toEqual(["AUDIT FIXES — PROD ROUND 2", "Expiring credentials"]);
    expect(r.text).not.toMatch(/AUDIT|change 41|sub detail|deep text|Expiring|a token/);
    expect(r.text).toContain("## Marketing plan");
    expect(r.text).toContain("- keep this line");
    expect(r.text).toContain("# Next top-level");
    expect(r.text).toContain("kept too");
    expect(r.text).toContain("intro line");
  });

  it("a sensitive H1 takes everything until the next H1", () => {
    const r = dropSensitiveSections("# Security review\nbody\n## sub\nmore\n# Roadmap\nfine");
    expect(r.dropped).toEqual(["Security review"]);
    expect(r.text.trim()).toBe("# Roadmap\nfine");
  });

  it("ignores headings inside code fences and front matter, and fenced text that looks sensitive", () => {
    const text = "---\ntitle: x\n# not a heading password\n---\n# Doc\n```\n## secret in a fence\n```\n## Fine\ntext";
    const r = dropSensitiveSections(text);
    expect(r.dropped).toEqual([]);
    expect(r.text).toBe(text);
  });

  it("drops a sensitive setext heading too", () => {
    const r = dropSensitiveSections("Intro\n\nBackup procedure\n-----------------\nrun this\n\nOther\n=====\nok");
    expect(r.dropped).toEqual(["Backup procedure"]);
    expect(r.text).not.toMatch(/run this|Backup/);
    expect(r.text).toContain("Other");
  });

  it("returns the text untouched when nothing is sensitive, and keeps CRLF line endings", () => {
    expect(dropSensitiveSections("# A\nb\n## C\nd")).toEqual({ text: "# A\nb\n## C\nd", dropped: [] });
    const r = dropSensitiveSections("# A\r\nb\r\n## Server keys\r\nsecret\r\n## D\r\ne");
    expect(r.text).toBe("# A\r\nb\r\n## D\r\ne");
  });

  it("does not crash on empty input", () => {
    expect(dropSensitiveSections("")).toEqual({ text: "", dropped: [] });
  });
});

describe("redact is re-exported from privacy", () => {
  it("works the same", () => {
    expect(redact("mail a@b.co").text).toBe("mail [redacted:email]");
  });
});

describe("scanGraph (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await upsertNode(g, { type: "Person", id: "person:founder", name: "Founder" });
    await upsertNode(g, {
      type: "Document", id: "document:overview", name: "overview.md",
      props: { kind: "note", hash: sha256("anything"), path: "10-company/overview.md" }, summary: "Company overview, 40 orders since 2026-10-05",
    });
    await upsertNode(g, { type: "Task", id: "task:pending-n7", name: "Renew the widget licence", props: { status: "open", title: "Renew the widget licence", issues: ["#12", "app#42"] } });
    await upsertEdge(g, { from: "person:founder", type: "OWNS", to: "task:pending-n7", props: { note: "ordinary note" } });
  });
  afterAll(async () => {
    await cleanup();
    await closeAll();
  });

  it("reports nothing for a clean graph (hashes, dates, counts and issue refs are fine)", async () => {
    expect(await scanGraph(g)).toEqual([]);
  });

  it("reports one hit for one planted email, without echoing it", async () => {
    await upsertNode(g, { type: "Task", id: "task:planted", name: "Planted", summary: "ask bob.smith@example.org about it" });
    const hits = await scanGraph(g);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: "task:planted", prop: "summary", kind: "email" });
    expect(hits[0]!.sample).not.toContain("bob.smith@example.org");
    expect(hits[0]!.sample.length).toBeGreaterThan(0);
  });

  it("also scans edge properties and string-list properties, and pages through many nodes", async () => {
    await upsertEdge(g, { from: "person:founder", type: "OWNS", to: "task:planted", props: { note: "call +91 98765 43210" } });
    await upsertNode(g, { type: "Task", id: "task:listy", name: "Listy", props: { issues: ["#1", "host 203.0.113.45"] } });
    for (let i = 0; i < 60; i++) await upsertNode(g, { type: "Task", id: `task:bulk-${i}`, name: `Bulk ${i}`, summary: "nothing here" });
    const hits = await scanGraph(g, { pageSize: 25 }); // 60+ nodes: several pages
    const key = (h: { id: string; prop: string; kind: string }) => `${h.id}|${h.prop}|${h.kind}`;
    expect(hits.map(key).sort()).toEqual([
      "person:founder-[:OWNS]->task:planted|note|phone",
      "task:listy|issues|ipv4",
      "task:planted|summary|email",
    ]);
  });
});
