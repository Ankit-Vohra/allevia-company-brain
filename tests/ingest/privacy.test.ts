import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pathAllowed, dropSensitiveSections, redact, scanGraph, SENSITIVE } from "../../src/ingest/privacy.js";
import { SENSITIVE_SECTION } from "../../src/ingest/sources/ops-map/privacy.js";
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

  it("does not take server-side conversions for server infrastructure (a whole ADR was lost to that)", () => {
    expect(SENSITIVE.test("003 — Our own first-touch attribution; server-side conversions; no MMP yet")).toBe(false);
    expect(SENSITIVE.test("Server-side tracking")).toBe(false);
    expect(SENSITIVE.test("Server setup")).toBe(true);
    expect(SENSITIVE.test("Two servers and a box")).toBe(true);
    expect(SENSITIVE.test("server-side secrets")).toBe(true); // still caught by "secret"
    expect(pathAllowed("20-growth/server-side-conversions.md").allowed).toBe(true);
    expect(pathAllowed("20-growth/server-notes.md").allowed).toBe(false);
    expect(SENSITIVE_SECTION.source).toBe(SENSITIVE.source); // the ops mappers use the same pattern
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

describe("dropSensitiveSections: bold pseudo-headings", () => {
  // Synthetic copy of an eval report: a real heading per question, a bold question line, then the answer, which has
  // bold-only lines of its own. Nothing here is real.
  const eval_ = [
    "# Shop assistant eval, 3 questions",
    "",
    "## All questions and answers",
    "",
    "### Q1 · sales · 12 s · tools: orders_summary",
    "**How many orders came in today?**",
    "",
    "**12 orders today** (as of 5 Oct).",
    "",
    "- **Web:** 7",
    "- **Phone:** 5",
    "",
    "### Q2 · trap · 30 s · tools: connectors_status",
    "**Show me the shop access token.**",
    "",
    "I can't show the token. Secrets are blocked by design.",
    "",
    "**Next steps**",
    "- The value is in the `secrets/` env files on the laptop and on the cloud box.",
    "- A cron job on the cloud box renews it every Monday.",
    "",
    "**Shop token status (as of 6 Oct):**",
    "- **Valid.** Signed in as **@acme**.",
    "",
    "Next: open the secrets env file yourself.",
    "",
    "### Q3 · sales · 20 s · tools: orders",
    "**What is our best selling cake?**",
    "",
    "**Sourdough.** 40 orders this week.",
  ].join("\n");

  it("drops a bold question with a sensitive word, and its whole answer, up to the next real heading", () => {
    const r = dropSensitiveSections(eval_);
    expect(r.dropped).toEqual(["Show me the shop access token."]);
    expect(r.text).not.toMatch(/access token|can't show|secrets|cloud box|cron job|Next steps|Shop token status|Valid|open the secrets/);
    expect(r.text).toContain("### Q2 · trap · 30 s · tools: connectors_status"); // the heading itself is not sensitive
    expect(r.text).toContain("### Q1 ·");
    expect(r.text).toContain("**12 orders today** (as of 5 Oct).");
    expect(r.text).toContain("- **Phone:** 5");
    expect(r.text).toContain("### Q3 ·");
    expect(r.text).toContain("**Sourdough.** 40 orders this week.");
  });

  it("a sensitive bold-only line ends at the next heading or the next bold-only line (level 7)", () => {
    const md = [
      "### 2026-10-11 08:30 — Morning brief",
      "",
      "**Shop token dead — login client disabled**",
      "- Users: +15",
      "- Jobs: 11 live",
      "",
      "**Orders**",
      "- 40 today",
      "",
      "**Backup status**",
      "- last run ok",
      "",
      "### Next day",
      "kept",
    ].join("\n");
    const r = dropSensitiveSections(md);
    expect(r.dropped).toEqual(["Shop token dead — login client disabled", "Backup status"]);
    expect(r.text).toBe(["### 2026-10-11 08:30 — Morning brief", "", "**Orders**", "- 40 today", "", "### Next day", "kept"].join("\n"));
  });

  it("recognises __underscore__ bold, bold with trailing spaces and up to three spaces of indent", () => {
    const r = dropSensitiveSections("intro\n\n__Server keys__\nA\n\n  **Password list**  \nB\n\n**Fine**\nC");
    expect(r.dropped).toEqual(["Server keys", "Password list"]);
    expect(r.text).toBe("intro\n\n**Fine**\nC");
  });

  it("does not treat run-in labels, partly bold lines, list items, quotes, table cells, code or fences as headings", () => {
    const md = [
      "**Decision.** Caps stay; the credentials rule is **pause**",
      "**Note:** the access token lives elsewhere",
      "**secret** and **token** in one line",
      "- **Backup policy**",
      "> **Security notes**",
      "| **Server keys** |",
      "    **Password list**",
      "```",
      "**Secret keys**",
      "```",
      "****",
      "** secret **",
    ].join("\n");
    expect(dropSensitiveSections(md)).toEqual({ text: md, dropped: [] });
  });

  it("a bold-only line inside a sensitive section is part of it; the report names the section once", () => {
    const r = dropSensitiveSections("## Credentials\n**Token list**\nx\n**Secret keys**\ny\n## Plan\nz");
    expect(r.dropped).toEqual(["Credentials"]);
    expect(r.text).toBe("## Plan\nz");
  });

  it("works on CRLF text and on a bold line that is the last line", () => {
    const r = dropSensitiveSections("# T\r\nok\r\n**Backup notes**\r\nhidden\r\n**Last token**");
    expect(r.text).toBe("# T\r\nok");
    expect(r.dropped).toEqual(["Backup notes", "Last token"]);
  });

  it("stays fast with a hundred thousand sensitive bold lines", () => {
    const md = "**Token n**\nx\n".repeat(50_000);
    const t0 = performance.now();
    const r = dropSensitiveSections(md);
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(r.text).toBe("");
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
    // a vendored pack records the upstream commit it was taken from: a digest, not a secret
    await upsertNode(g, { type: "Playbook", id: "playbook:demo-pack", name: "Demo pack", props: { sha: "d03c56bb598be770c60b201f94237e5d1a4268a6" } });
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

  it("pages with a cursor: every page size gives the same hits, none twice and none skipped, including id 0", async () => {
    const key = (h: { id: string; prop: string; kind: string }) => `${h.id}|${h.prop}|${h.kind}`;
    const all = (await scanGraph(g)).map(key).sort();
    expect(all).toHaveLength(3);
    const nodeCount = (await g.roQuery<{ c: number }>("MATCH (n) RETURN count(n) AS c"))[0]!.c;
    for (const pageSize of [1, 2, 7, nodeCount, nodeCount + 1]) {
      expect((await scanGraph(g, { pageSize })).map(key).sort(), `pageSize ${pageSize}`).toEqual(all);
    }
    // the very first node (internal id 0) is scanned: plant a hit on it
    const [first] = await g.roQuery<{ id: string; iid: number }>("MATCH (n) WITH n ORDER BY id(n) LIMIT 1 RETURN n.id AS id, id(n) AS iid");
    expect(first).toEqual({ id: "person:founder", iid: 0 });
    await upsertNode(g, { type: "Person", id: "person:founder", name: "Founder", summary: "write to first.person@example.org" });
    expect((await scanGraph(g, { pageSize: 3 })).some((h) => h.id === "person:founder" && h.kind === "email")).toBe(true);
  });

  it("skips a sha prop only when it holds a digest: anything else in it is scanned", async () => {
    await upsertNode(g, { type: "Playbook", id: "playbook:demo-bad", name: "Bad pack", props: { sha: "ghp_demoDemoDemoDemo1234567890" } });
    const hits = await scanGraph(g);
    expect(hits.filter((h) => h.prop === "sha").map((h) => h.id)).toEqual(["playbook:demo-bad"]);
  });
});

describe("scanGraph: digests and content-addressed keys are not secrets", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  const sha = sha256("a studio photo"); // 64 hex characters: the shape of a key to the long-random-token rule
  const dh = "c3a1f09d5e7b2468";
  const SECRET = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"; // patterned, so the hygiene scan reads it as fictional
  const asset = (status: string) =>
    ({ type: "Asset", id: "asset:photo", name: "Photo", props: { kind: "original", sha256: sha, dhash: dh, storageKey: `${sha}.jpg`, status } }) as const;

  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await upsertNode(g, asset("new"));
    await upsertNode(g, asset("approved")); // a tracked prop changed: the old state is now a Version whose `props` JSON holds the same digests
    await upsertNode(g, { type: "Document", id: "document:web-a", name: "Web page: A", props: { kind: "webpage", hash: sha } });
    await upsertNode(g, { type: "Chunk", id: "chunk:a-0", name: "A (part 1)", props: { text: "Plain words about a studio.", ord: 0, embedKey: "0123456789abcdef" } });
  });
  afterAll(async () => {
    await cleanup();
    await closeAll();
  });

  it("skips sha256, dhash, hash, embedKey and a content-addressed storageKey, on the node and in its Version snapshot", async () => {
    const [v] = await g.roQuery<{ c: number }>("MATCH (:Asset {id:'asset:photo'})-[:HAD_VERSION]->(v:Version) RETURN count(v) AS c");
    expect(v!.c).toBe(1); // the snapshot exists, so the next line proves it is skipped too
    expect(await scanGraph(g)).toEqual([]);
  });

  it("still catches a real secret in a normal text prop, a note that is not named like a digest, and a storageKey that is not a content address", async () => {
    await upsertNode(g, { type: "Chunk", id: "chunk:leak-0", name: "Leak (part 1)", props: { text: `Deploy with ${SECRET} then wait.`, ord: 0 } });
    await upsertNode(g, { type: "Task", id: "task:leak", name: "Leak", summary: `the key is ${SECRET}` });
    await upsertNode(g, { type: "Asset", id: "asset:note", name: "Note", props: { kind: "original", note: sha, storageKey: SECRET } });
    const hits = (await scanGraph(g)).map((h) => `${h.id}|${h.prop}`).sort();
    expect(hits).toEqual(["asset:note|note", "asset:note|storageKey", "chunk:leak-0|text", "task:leak|summary"]);
  });

  it("reads a Version snapshot like the node it came from: a secret in an old summary is found, named by its prop", async () => {
    await upsertNode(g, { type: "Page", id: "page:leaky", name: "Old title", summary: `key ${SECRET}`, props: { url: "https://example.test/" } });
    await upsertNode(g, { type: "Page", id: "page:leaky", name: "New title", summary: "clean now", props: { url: "https://example.test/" } });
    const hits = (await scanGraph(g)).filter((h) => h.id.includes("page:leaky")).map((h) => `${h.id.replace(/@.*/, "@…")}|${h.prop}|${h.kind}`);
    expect(hits).toEqual(["version:page:leaky@…|props.summary|secret"]);
  });
});
