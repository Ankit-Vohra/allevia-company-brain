// Brain source on a synthetic vault built as a real git repo (tests/helpers/fixture-vault.ts): privacy filter, documents,
// chunks, wiki-links, authorship from git history (--follow, agent:<name>: subjects, Allevia's reserved namespace
// ignored), PENDING, ADRs, the registry, and a write that applies cleanly and idempotently to a real graph.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { writeBatch } from "../../src/graph/upsert.js";
import { loadBrain, actorFromSubject, parseGitLog, brainDocId, docKind, type BrainResult } from "../../src/ingest/sources/brain.js";
import { scanGraph } from "../../src/ingest/privacy.js";
import { makeFixtureVault } from "../helpers/fixture-vault.js";
import { testGraph } from "../helpers/graph.js";

const doc = (p: string) => brainDocId(p);

describe("brain source helpers", () => {
  it("maps folders to document kinds", () => {
    expect(docKind("60-decisions/007-x.md")).toBe("decision");
    expect(docKind("60-decisions/README.md")).toBe("readme");
    expect(docKind("70-reports/daily/2026-10-10.md")).toBe("report");
    expect(docKind("70-reports/jarvis-eval-2026-10-05.md")).toBe("report");
    expect(docKind("agents/scout.md")).toBe("agent");
    expect(docKind("00-command/PENDING.md")).toBe("pending");
    expect(docKind("README.md")).toBe("readme");
    expect(docKind("CLAUDE.md")).toBe("readme");
    expect(docKind("20-growth/funnel.md")).toBe("note");
  });

  it("credits agent:<name>: subjects to that agent and everything else to the founder; reserved names to nobody", () => {
    expect(actorFromSubject("agent:librarian: nightly filing")).toEqual({ id: "agent:librarian", name: "librarian" });
    expect(actorFromSubject("agent:Claude-Code: fix")).toEqual({ id: "agent:claude-code", name: "claude-code" });
    expect(actorFromSubject("N7: the request is sent")).toEqual({ id: "person:founder", name: "founder" });
    expect(actorFromSubject("agent:allevia-guard: x")).toBeNull();
    expect(actorFromSubject("agent: no name")).toEqual({ id: "person:founder", name: "founder" });
  });

  it("parses git log lines, keeping subjects with pipes whole", () => {
    const out = "abc1234|Some | One|2026-10-11T10:00:00+05:30|agent:x: a | b\n\ndef4567|Other|2026-10-01T09:00:00+05:30|first\nnot a line\n";
    expect(parseGitLog(out)).toEqual([
      { sha: "abc1234", at: "2026-10-11T10:00:00+05:30", subject: "agent:x: a | b" },
      { sha: "def4567", at: "2026-10-01T09:00:00+05:30", subject: "first" },
    ]);
  });
});

describe("loadBrain on a fixture vault", () => {
  let vault: ReturnType<typeof makeFixtureVault>;
  let r: BrainResult;
  beforeAll(async () => {
    vault = makeFixtureVault();
    r = await loadBrain({ vaultPath: vault.dir });
  });
  afterAll(() => vault.cleanup());

  const node = (id: string) => r.write.nodes.find((n) => n.id === id);
  const edges = (type: string) => r.write.edges.filter((e) => e.type === type);
  const has = (from: string, type: string, to: string) => r.write.edges.some((e) => e.from === from && e.type === type && e.to === to);

  it("records the vault HEAD", () => {
    expect(r.vaultHead).toBe(vault.head);
  });

  it("reads only what the path policy allows and says why the rest was skipped", () => {
    const ids = new Set(r.write.nodes.map((n) => n.id));
    expect(ids.has(doc("15-tech/access.md"))).toBe(false);
    expect(ids.has(doc("70-reports/security-audit-2026-10-07.md"))).toBe(false);
    const skipped = new Map(r.skipped.map((s) => [s.ref, s.reason]));
    expect(skipped.get("15-tech/access.md")).toMatch(/^denied/);
    expect(skipped.get("70-reports/security-audit-2026-10-07.md")).toMatch(/^denied/);
    expect(skipped.get("assets/logo.png")).toMatch(/denied|not markdown/);
    expect(JSON.stringify(r.write)).not.toMatch(/box key|Nothing to see/);
  });

  it("emits one Document per allowed markdown file, kind from its folder, asOf = last commit date", () => {
    expect(node(doc("60-decisions/001-human-review.md"))).toMatchObject({ type: "Document", props: { kind: "decision", path: "60-decisions/001-human-review.md" }, asOf: "2026-10-01" });
    expect(node(doc("70-reports/daily/2026-10-10.md"))).toMatchObject({ props: { kind: "report", reportDate: "2026-10-10" }, asOf: "2026-10-10" });
    expect(node(doc("10-company/overview.md"))).toMatchObject({ name: "Company brief", props: { kind: "note" }, asOf: "2026-10-11" });
    expect(node(doc("agents/scout.md"))).toMatchObject({ props: { kind: "agent" } });
    expect(node(doc("00-command/PENDING.md"))).toMatchObject({ props: { kind: "pending" } });
    expect(node(doc("README.md"))).toMatchObject({ props: { kind: "readme" }, name: "Widget Co vault" });
    expect(node(doc("agents/scout.md"))!.summary).toBe("Drafts reels and posts for Widget Co. Reads 001-human-review.");
  });

  it("drops sensitive sections and redacts before anything is emitted", () => {
    const brief = r.docs.find((d) => d.id === doc("10-company/overview.md"))!;
    expect(brief.text).not.toMatch(/Server access|admin password/);
    expect(brief.text).not.toContain("help@widget.example");
    expect(brief.text).toContain("[redacted:email]");
    expect(r.redactions.email).toBeGreaterThanOrEqual(1);
    expect(r.redactions.dropped_section).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(r.write)).not.toMatch(/admin password|help@widget/);
  });

  it("chunks each document and links them with HAS_CHUNK", () => {
    const brief = doc("10-company/overview.md");
    const chunks = edges("HAS_CHUNK").filter((e) => e.from === brief);
    expect(chunks.length).toBeGreaterThan(0);
    const c = node(chunks[0]!.to)!;
    expect(c).toMatchObject({ type: "Chunk", src: brief, props: { ord: 0, path: "10-company/overview.md" } });
    expect(typeof c.props!.text).toBe("string");
    expect(new Set(r.write.nodes.filter((n) => n.type === "Chunk").map((n) => n.id)).size).toBe(r.write.nodes.filter((n) => n.type === "Chunk").length);
  });

  it("turns resolved wiki-links between allowed documents into LINKS_TO, and nothing else", () => {
    expect(has(doc("README.md"), "LINKS_TO", doc("00-command/PENDING.md"))).toBe(true);
    expect(has(doc("README.md"), "LINKS_TO", doc("60-decisions/001-human-review.md"))).toBe(true);
    expect(has(doc("10-company/overview.md"), "LINKS_TO", doc("60-decisions/001-human-review.md"))).toBe(true);
    expect(edges("LINKS_TO").some((e) => e.to.includes("access"))).toBe(false); // denied target
    expect(has(doc("10-company/overview.md"), "LINKS_TO", doc("README.md"))).toBe(false); // inside inline code
  });

  it("credits authorship from git history, following renames, and ignores Allevia's reserved namespace", () => {
    const authored = edges("AUTHORED");
    const brief = authored.filter((e) => e.to === doc("10-company/overview.md")).map((e) => e.from).sort();
    expect(brief).toEqual(["agent:librarian", "person:founder"]); // the founder's commit is before the rename
    expect(has("agent:scout", "AUTHORED", doc("70-reports/daily/2026-10-10.md"))).toBe(true);
    const readme = authored.filter((e) => e.to === doc("README.md"));
    expect(readme.map((e) => e.from)).toEqual(["person:founder"]);
    expect(authored.some((e) => e.from.startsWith("agent:allevia"))).toBe(false);
    const e = authored.find((x) => x.from === "agent:librarian")!;
    expect(e.props).toMatchObject({ commits: 1, at: "2026-10-11T10:00:00+05:30" });
    expect(e.since).toBe(Date.parse("2026-10-11T10:00:00+05:30"));
    // a committer the registry does not know becomes an Agent node; a registry agent keeps the registry's node
    expect(node("agent:librarian")).toMatchObject({ type: "Agent", props: { kind: "vault-committer" } });
    expect(r.write.nodes.filter((n) => n.id === "agent:scout")).toHaveLength(1);
    expect(node("agent:scout")!.name).toBe("Scout (drafts)");
  });

  it("maps PENDING to Tasks with owners, ADRs to Decisions, and the registry", () => {
    expect(node("task:pending-n1")).toMatchObject({ type: "Task", props: { status: "open" } });
    expect(node("task:pending-n2")).toMatchObject({ props: { status: "done" } });
    expect(has("person:founder", "OWNS", "task:pending-n1")).toBe(true);
    expect(node("decision:001-human-review")).toMatchObject({ type: "Decision", props: { status: "accepted", decidedAt: "2026-10-01" } });
    expect(has("person:founder", "DECIDED", "decision:001-human-review")).toBe(true);
    expect(node("system:instagram")).toMatchObject({ type: "System" });
    expect(has("agent:scout", "USES", "system:instagram")).toBe(true);
    expect(node(doc("registry/agents/scout.yaml"))).toMatchObject({ type: "Document", props: { kind: "registry" } });
    expect(has("agent:scout", "AUTHORED", doc("registry/agents/scout.yaml"))).toBe(false); // the founder committed it
    expect(has("person:founder", "AUTHORED", doc("registry/agents/scout.yaml"))).toBe(true);
  });

  it("offers markdown documents for extraction, but not PENDING or the registry", () => {
    const ids = r.docs.map((d) => d.id);
    expect(ids).toContain(doc("60-decisions/001-human-review.md"));
    expect(ids).toContain(doc("10-company/overview.md"));
    expect(ids).not.toContain(doc("00-command/PENDING.md"));
    expect(ids.some((i) => i.includes("registry"))).toBe(false);
    const adr = r.docs.find((d) => d.id === doc("60-decisions/001-human-review.md"))!;
    expect(adr).toMatchObject({ kind: "decision", asOf: "2026-10-01", meta: { decisionId: "decision:001-human-review" } });
    const report = r.docs.find((d) => d.kind === "report")!;
    expect(report.asOf).toBe("2026-10-10");
    expect(report.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.docs.find((d) => d.id === doc("README.md"))!.meta).toMatchObject({ inLinks: 0 });
    expect(r.docs.find((d) => d.id === doc("60-decisions/001-human-review.md"))!.meta).toMatchObject({ inLinks: 4 });
  });

  it("is self-contained: every edge endpoint is a node of the same write", () => {
    const ids = new Set(r.write.nodes.map((n) => n.id));
    const dangling = r.write.edges.filter((e) => !ids.has(e.from) || !ids.has(e.to)).map((e) => `${e.from} ${e.type} ${e.to}`);
    expect(dangling).toEqual([]);
  });

  describe("applied to a graph", () => {
    let g: GraphHandle;
    let cleanup: () => Promise<void>;
    beforeAll(async () => {
      ({ g, cleanup } = await testGraph());
      await ensureIndexes(g);
    });
    afterAll(async () => {
      await cleanup();
      await closeAll();
    });

    it("writes with no errors, passes the privacy scan, and a second load + write changes nothing", async () => {
      const s1 = await writeBatch(g, r.write, 1_760_000_000_000);
      expect(s1.errors.map((e) => e.error)).toEqual([]);
      expect(await scanGraph(g)).toEqual([]);
      const again = await loadBrain({ vaultPath: vault.dir });
      const s2 = await writeBatch(g, again.write, 1_760_000_100_000);
      expect(s2).toMatchObject({ nodesCreated: 0, nodesUpdated: 0, versions: 0, edgesCreated: 0, edgesClosed: 0, errors: [] });
    }, 60_000);
  });
});
