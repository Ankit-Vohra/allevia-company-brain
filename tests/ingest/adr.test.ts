import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAdr, isAdrPath, adrToWrite, adrDecisionId, adrIdIndex, type Adr } from "../../src/ingest/sources/adr.js";
import { isAllowed } from "../../src/graph/schema.js";
import { entityId } from "../../src/util/ids.js";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { writeBatch, upsertNode } from "../../src/graph/upsert.js";
import { testGraph } from "../helpers/graph.js";
import { BRAIN_PATH } from "../helpers/vault.js";

const DIR = new URL("../fixtures/brain/60-decisions/", import.meta.url);
const files = readdirSync(DIR).filter((f) => isAdrPath(`60-decisions/${f}`)).sort();
const adrs = new Map(files.map((f) => [f.slice(0, 3), parseAdr(`60-decisions/${f}`, readFileSync(new URL(f, DIR), "utf8"))]));
const adr = (n: string): Adr => adrs.get(n)!;

describe("isAdrPath", () => {
  it("accepts numbered decision files only", () => {
    expect(isAdrPath("60-decisions/008-weekly-stock-count.md")).toBe(true);
    expect(isAdrPath("60-decisions/README.md")).toBe(false);
    expect(isAdrPath("60-decisions/notes.md")).toBe(false);
    expect(files).toHaveLength(6);
  });
});

describe("parseAdr: bold run-in style", () => {
  it("reads number, title, status, date, decider and the three sections", () => {
    expect(adr("001")).toEqual({
      file: "001-shared-handbook",
      number: "001",
      title: "Keep the shop handbook in one shared folder",
      status: "accepted",
      date: "2026-10-02",
      decidedBy: "founder",
      context: "Supplier notes lived in three inboxes and a spreadsheet. New helpers could not find the packing rules.",
      decision: "`Acme-Org/widget-brain`: plain markdown, synced to the shop laptop and the cloud drive, read by all agents; each adds its weekly notes as commits. Sales figures stay in the shop system.",
      consequences: "Every agent starts from `HANDBOOK.md`. The keeper agent keeps it current. Passwords never go in.",
    });
  });

  it("normalises a long status, joins a wrapped meta line, takes the founder from a Source field, ignores other labelled blocks", () => {
    const a = adr("002");
    expect(a.status).toBe("accepted");
    expect(a.decidedBy).toBe("founder");
    expect(a.date).toBe("2026-10-03");
    expect(a.context).toBe("The shop needs helpers that start on a timetable, pick up tasks and stop at a spending cap.");
    expect(a.decision.startsWith("Run the scheduler ourselves (open source, one small database) as the switchboard")).toBe(true);
    expect(a.decision).not.toContain("Bookkeeping, ad budgets");
    expect(a.consequences).toBe("Lives on the shop laptop. Anything the scheduler cannot show gets a small page of its own.");
  });

  it("has no decider when none is stated", () => {
    expect(adr("003").decidedBy).toBeUndefined();
    expect(adr("003").status).toBe("accepted");
    expect("supersedes" in adr("003")).toBe(false);
  });

  it("reads Supersedes from a wiki-link and an 'ADR n' mention", () => {
    expect(adr("004")).toMatchObject({ number: "004", date: "2026-10-12", decidedBy: "founder", supersedes: ["002", "003"] });
    expect(adr("004").title).toBe("Replace the job scheduler with a hosted one");
    expect(adr("004").decision).toBe("Move the timetable to the hosted scheduler. The old one is switched off after one week.");
  });

  it("falls back to the body as the decision when there are no labels (table-style record), and has no date when none is given", () => {
    const a = adr("005");
    expect(a).toMatchObject({ number: "005", title: "Where we post (as of 2026-10-03)", status: "accepted", context: "", consequences: "" });
    expect(a.date).toBeUndefined();
    expect(a.decision).toContain("| Short videos | main channel; one video at 18:00 once approved | numbers 2026-09-21 |");
    expect(a.decision.split("\n")).toHaveLength(5);
  });
});

describe("parseAdr: heading style with front matter", () => {
  it("reads ADR-nnn headings, ## Context/Decision/Consequences, and front matter fields", () => {
    expect(adr("006")).toEqual({
      file: "006-heading-style",
      number: "006",
      title: "Use heading-style records",
      status: "accepted",
      date: "2026-10-14",
      decidedBy: "founder",
      supersedes: ["005"],
      context: "Some decision records use headings instead of bold run-in labels. They wrap long lines like this one.",
      decision: "Both styles are parsed.",
      consequences: "- Records stay readable in any viewer.\n- The parser handles both.",
    });
  });
});

describe("parseAdr: edge cases", () => {
  it("takes the number from the file name when the heading has none, and pads short numbers", () => {
    expect(parseAdr("60-decisions/012-use-x.md", "# Use X\n**Status** accepted\n\n**Decision.** Do X.").number).toBe("012");
    expect(parseAdr("60-decisions/x.md", "# ADR-37 — Foo\n**Status** proposed").number).toBe("037");
    expect(parseAdr("60-decisions/x.md", "# 8: Eight\n").number).toBe("008");
  });

  it("does not take a year or date at the start of a title for a number", () => {
    const a = parseAdr("60-decisions/x.md", "# 2026 planning\n**Status** accepted");
    expect(a.number).toBe("");
    expect(a.title).toBe("2026 planning");
  });

  it("copes with a missing number, status, date and sections", () => {
    const a = parseAdr("60-decisions/some-decision.md", "# Some decision\n\nplain body text");
    expect(a).toMatchObject({ number: "", title: "Some decision", status: "unknown", decision: "plain body text", context: "", consequences: "" });
    expect(a.date).toBeUndefined();
  });

  it("status words: first known keyword wins, else the first clause", () => {
    const st = (s: string) => parseAdr("60-decisions/001-x.md", `# 001 — T\n**Status** ${s}`).status;
    expect(st("Accepted")).toBe("accepted");
    expect(st("superseded by 007")).toBe("superseded");
    expect(st("proposed (needs founder)")).toBe("proposed");
    expect(st("on hold, revisit in November")).toBe("on hold");
  });

  it("strips emphasis and code ticks from titles", () => {
    expect(parseAdr("60-decisions/004-x.md", "# 004 — The `orders` sheet lives in **the cloud drive**\n").title).toBe("The orders sheet lives in the cloud drive");
  });

  it("redacts every text field", () => {
    const a = parseAdr("60-decisions/009-x.md",
      "# 009 — Mail ceo@example.org\n**Date** 2026-10-05 · **Status** accepted\n\n**Context.** Call +91 98765 43210.\n\n**Decision.** Use FOO_TOKEN=abc1234567.\n\n**Consequences.** Host 203.0.113.45.");
    expect(JSON.stringify(a)).not.toMatch(/ceo@example|98765|abc123|203\.0\.113/);
    expect(a.title).toBe("Mail [redacted:email]");
    expect(a.decision).toBe("Use FOO_TOKEN=[redacted:secret].");
  });

  it("ignores 'superseded by' and years when collecting supersedes, and never lists itself", () => {
    expect(parseAdr("60-decisions/005-x.md", "# 005 — T\n**Status** superseded by 007 · **Supersedes** 003 and 005 and [[2026-10-12-plan]]").supersedes).toEqual(["003"]);
    expect("supersedes" in parseAdr("60-decisions/005-x.md", "# 005 — T\n**Status** superseded by 007")).toBe(false);
  });

  it("records the file name without directory or .md (any case) as `file`", () => {
    expect(parseAdr("60-decisions/008-weekly-stock-count.md", "# 008 — T").file).toBe("008-weekly-stock-count");
    expect(parseAdr("a\\b\\012-Use-X.MD", "# 012 — T").file).toBe("012-Use-X");
    expect(parseAdr("012-no-dir.md", "# 012 — T").file).toBe("012-no-dir");
  });

  it("does not crash on odd input", () => {
    for (const md of ["", "\n", "# ", "**Status**", "---\n:\n---\n# T", "# 001 — T\n" + "**x** ".repeat(50_000), "x".repeat(200_000)]) {
      expect(() => parseAdr("60-decisions/001-x.md", md)).not.toThrow();
    }
  });
});

describe("adrToWrite", () => {
  const ctx = { docId: "document:60-decisions-004-hosted-scheduler-md", asOf: "2026-10-12" };
  const index = adrIdIndex([...adrs.values()]);

  it("builds the Decision node: id from the file name, tracked status/title, decidedAt", () => {
    const w = adrToWrite(adr("001"), { ...ctx, docId: "document:001" });
    const d = w.nodes.find((n) => n.type === "Decision")!;
    expect(d.id).toBe(entityId("Decision", "001-shared-handbook"));
    expect(d.id).toBe("decision:001-shared-handbook");
    expect(d.id).toBe(adrDecisionId(adr("001")));
    expect(d.name).toBe("ADR 001: Keep the shop handbook in one shared folder");
    expect(d.props).toEqual({ status: "accepted", title: "Keep the shop handbook in one shared folder", number: "001", decidedAt: "2026-10-02" });
    expect(d.summary).toContain("plain markdown, synced to the shop laptop");
    expect(d).toMatchObject({ src: "document:001", asOf: ctx.asOf });
  });

  it("keeps the Decision id when the title or the number in the heading changes: the file name is the identity", () => {
    const id = (md: string) => adrDecisionId(parseAdr("60-decisions/021-pick-a-courier.md", md));
    const a = id("# 021 — Pick a courier\n**Status** proposed");
    expect(a).toBe("decision:021-pick-a-courier");
    expect(id("# 021 — Pick a different courier after all\n**Status** accepted")).toBe(a);
    expect(id("# ADR-22: Renumbered in the heading\n**Status** accepted")).toBe(a);
  });

  it("resolves SUPERSEDES through file-name ids; a number two files claim is ambiguous and is left out, not guessed", () => {
    const mk = (file: string, md: string) => parseAdr(`60-decisions/${file}.md`, md);
    const old1 = mk("010-first-plan", "# 010 — First plan\n**Status** superseded by 012");
    const old2 = mk("011-second-plan", "# 011 — Second plan\n**Status** superseded by 012");
    const dup = mk("011-second-plan-copy", "# 011 — Second plan, copy\n**Status** accepted");
    const newer = mk("012-third-plan", "# 012 — Third plan\n**Status** accepted · **Supersedes** 010, 011");
    expect(newer.supersedes).toEqual(["010", "011"]);

    const idx = adrIdIndex([old1, old2, newer]);
    expect(idx.get("010")).toBe("decision:010-first-plan");
    expect(idx.get("011")).toBe("decision:011-second-plan");
    const edges = (i: ReadonlyMap<string, string>) =>
      adrToWrite(newer, { docId: "document:x", asOf: ctx.asOf, adrIds: i }).edges.filter((e) => e.type === "SUPERSEDES").map((e) => `${e.from} -> ${e.to}`);
    expect(edges(idx)).toEqual(["decision:012-third-plan -> decision:010-first-plan", "decision:012-third-plan -> decision:011-second-plan"]);

    const ambiguous = adrIdIndex([old1, old2, dup, newer]);
    expect(ambiguous.has("011")).toBe(false);
    expect(edges(ambiguous)).toEqual(["decision:012-third-plan -> decision:010-first-plan"]);
    // the same file listed twice is not ambiguous
    expect(adrIdIndex([old2, old2]).get("011")).toBe("decision:011-second-plan");
  });

  it("DECIDED from the founder only when the ADR says the founder decided, and emits the founder node", () => {
    const w1 = adrToWrite(adr("001"), ctx);
    expect(w1.nodes.some((n) => n.id === "person:founder")).toBe(true);
    expect(w1.edges.find((e) => e.type === "DECIDED")).toMatchObject({ from: "person:founder", to: adrDecisionId(adr("001")), since: Date.parse("2026-10-02"), props: { at: "2026-10-02" } });
    const w3 = adrToWrite(adr("003"), ctx);
    expect(w3.edges.some((e) => e.type === "DECIDED")).toBe(false);
    expect(w3.nodes.some((n) => n.id === "person:founder")).toBe(false);
  });

  it("emits SUPERSEDES (new -> old) for every referenced ADR the index knows, and SOURCED_FROM to the document", () => {
    const w = adrToWrite(adr("004"), { ...ctx, adrIds: index });
    const sup = w.edges.filter((e) => e.type === "SUPERSEDES");
    expect(sup.map((e) => [e.from, e.to])).toEqual([
      [adrDecisionId(adr("004")), adrDecisionId(adr("002"))],
      [adrDecisionId(adr("004")), adrDecisionId(adr("003"))],
    ]);
    expect(w.edges.find((e) => e.type === "SOURCED_FROM")).toMatchObject({ from: adrDecisionId(adr("004")), to: ctx.docId });
    // without an index (or with unknown numbers) there is nothing to point at, so no edge
    expect(adrToWrite(adr("004"), ctx).edges.some((e) => e.type === "SUPERSEDES")).toBe(false);
    expect(adrToWrite(adr("004"), { ...ctx, adrIds: new Map([["002", "decision:x"]]) }).edges.filter((e) => e.type === "SUPERSEDES")).toHaveLength(1);
  });

  it("every edge is allowed by the ontology and no edge carries functional: true", () => {
    for (const a of adrs.values()) {
      const w = adrToWrite(a, { ...ctx, adrIds: index });
      const types = new Map(w.nodes.map((n) => [n.id, n.type]));
      types.set(ctx.docId, "Document");
      for (const id of index.values()) if (!types.has(id)) types.set(id, "Decision");
      for (const e of w.edges) {
        expect(isAllowed(types.get(e.from)!, e.type, types.get(e.to)!)).toBe(true);
        expect(e.functional).toBeUndefined();
      }
    }
  });
});

describe("adrToWrite (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
  });
  afterAll(async () => {
    await cleanup();
    await closeAll();
  });

  it("writes all fixture ADRs cleanly, idempotently, with one current successor per superseded decision", async () => {
    const index = adrIdIndex([...adrs.values()]);
    const write = () => [...adrs.entries()].map(([n, a]) => {
      const docId = entityId("Document", `60-decisions/${files.find((f) => f.startsWith(n))}`);
      return { docId, w: adrToWrite(a, { docId, asOf: "2026-10-14", adrIds: index }) };
    });
    for (const { docId } of write()) await upsertNode(g, { type: "Document", id: docId, name: docId, props: { kind: "decision" } });
    for (const { w } of write()) expect((await writeBatch(g, w)).errors).toEqual([]);
    const again = { nodesCreated: 0, edgesCreated: 0, versions: 0 };
    for (const { w } of write()) {
      const s = await writeBatch(g, w);
      again.nodesCreated += s.nodesCreated; again.edgesCreated += s.edgesCreated; again.versions += s.versions;
    }
    expect(again).toEqual({ nodesCreated: 0, edgesCreated: 0, versions: 0 });
    const count = async (cypher: string) => (await g.roQuery<{ c: number }>(cypher))[0]!.c;
    expect(await count("MATCH (d:Entity:Decision) RETURN count(d) AS c")).toBe(6);
    expect(await count("MATCH (:Entity {id:'person:founder'})-[r:DECIDED]->(:Decision) WHERE r.until IS NULL RETURN count(r) AS c")).toBe(4);
    expect(await count("MATCH (:Decision)-[r:SUPERSEDES]->(:Decision) WHERE r.until IS NULL RETURN count(r) AS c")).toBe(3);
    expect(await count("MATCH (d:Decision)-[:SOURCED_FROM]->(:Document) RETURN count(d) AS c")).toBe(6);
    // every Decision id is its file name
    const ids = (await g.roQuery<{ id: string }>("MATCH (d:Entity:Decision) RETURN d.id AS id")).map((r) => r.id).sort();
    expect(ids).toEqual(files.map((f) => `decision:${f.replace(/\.md$/, "")}`));
  });

  it("a retitled ADR updates the same Decision (with a Version of the old title) instead of minting a second node", async () => {
    const f = files.find((x) => x.startsWith("001"))!;
    const md = readFileSync(new URL(f, DIR), "utf8").replace("Keep the shop handbook in one shared folder", "Keep the shop handbook in one shared place");
    const a = parseAdr(`60-decisions/${f}`, md);
    expect(a.title).toBe("Keep the shop handbook in one shared place");
    const docId = entityId("Document", `60-decisions/${f}`);
    const s = await writeBatch(g, adrToWrite(a, { docId, asOf: "2026-10-15" }));
    expect(s).toMatchObject({ nodesCreated: 0, errors: [] });
    expect(s.nodesUpdated).toBeGreaterThanOrEqual(1);
    expect(s.versions).toBeGreaterThanOrEqual(1);
    const count = async (cypher: string) => (await g.roQuery<{ c: number }>(cypher))[0]!.c;
    expect(await count("MATCH (d:Entity:Decision) RETURN count(d) AS c")).toBe(6);
    expect(await count("MATCH (:Entity {id:'decision:001-shared-handbook'})-[:HAD_VERSION]->(v:Version) RETURN count(v) AS c")).toBeGreaterThanOrEqual(1);
  });
});

// Structure only: never snapshot real content into the repo.
const VAULT = join(BRAIN_PATH, "60-decisions");
describe.skipIf(!existsSync(VAULT))("real vault ADRs (structure only)", () => {
  it("every numbered decision file has a number, a title and a status", () => {
    const real = readdirSync(VAULT).filter((f) => isAdrPath(`60-decisions/${f}`));
    expect(real.length).toBeGreaterThanOrEqual(5);
    for (const f of real) {
      const a = parseAdr(`60-decisions/${f}`, readFileSync(join(VAULT, f), "utf8"));
      expect(a.number, f).toMatch(/^\d{3}$/);
      expect(a.title.length, f).toBeGreaterThan(0);
      expect(a.status.length, f).toBeGreaterThan(0);
      expect(a.decision.length, f).toBeGreaterThan(0);
      if (a.date) expect(a.date, f).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
