import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePending, pendingToWrite, type PendingItem } from "../../src/ingest/sources/pending.js";
import { dropSensitiveSections } from "../../src/ingest/privacy.js";
import { isAllowed } from "../../src/graph/schema.js";
import { entityId } from "../../src/util/ids.js";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { writeBatch, upsertNode } from "../../src/graph/upsert.js";
import { testGraph } from "../helpers/graph.js";
import { BRAIN_PATH } from "../helpers/vault.js";

const FIXTURE = readFileSync(new URL("../fixtures/brain/00-command/PENDING.md", import.meta.url), "utf8");
const items = parsePending(FIXTURE);
const by = (ref: string): PendingItem => {
  const it = items.find((i) => i.ref === ref);
  if (!it) throw new Error(`no item ${ref}`);
  return it;
};
const bullet = (needle: string): PendingItem => {
  const it = items.find((i) => /^b-[0-9a-f]{8}$/.test(i.ref) && i.title.includes(needle));
  if (!it) throw new Error(`no bullet item containing ${needle}`);
  return it;
};

describe("parsePending: table rows", () => {
  it("parses an open founder row: ref, owner from the section, title redacted and trimmed", () => {
    expect(by("N9")).toEqual({
      ref: "N9", owner: "founder", done: false, issues: [],
      section: "Founder only — NOW (agents cannot do these)",
      title: "Renew the widget licence (2026-10-14): open the vendor portal → Billing → Renew, then paste the receipt id into [redacted:secret-path]",
    });
  });

  it("detects a struck-through row with DONE date; title is the struck action", () => {
    expect(by("N10")).toMatchObject({ done: true, doneAt: "2026-10-15", title: "Upload the new product photos", owner: "founder" });
    expect(by("N13")).toMatchObject({ done: true, doneAt: "2026-10-04", title: "Merge app PR #58, then #61, into staging" });
  });

  it("caps the title at 160 characters on a word boundary and never leaks later sentences", () => {
    const t = by("N11").title;
    expect(t.length).toBeLessThanOrEqual(160);
    expect(t.endsWith("…")).toBe(true);
    expect(t.startsWith("Review request (2026-10-16, updated): filed by the founder on 2026-10-16 under Support")).toBe(true);
    expect(JSON.stringify(items)).not.toMatch(/U12345MH2020PTC123456|987654321|widget-secrets|listings-old/);
  });

  it("takes only the first sentence of the action", () => {
    expect(by("N14").title).toBe("Analytics login for the agents (2026-10-12): run analytics login, then add the read-only role");
  });

  it("extracts issue references in every form", () => {
    expect(by("N12").issues).toEqual(["website#29"]);       // website PR #29
    expect(by("N13").issues).toEqual(["app#58", "#61"]);    // app PR #58, then #61
    expect(by("N14").issues).toEqual(["app#734"]);          // app #734
    expect(by("N15").issues).toEqual(["Acme-Org/widget-brain#42"]); // repo#n is not also counted as a bare #42
    expect(by("F1").issues).toEqual(["#10"]);
    expect(by("F2").issues).toEqual(["marketing#17"]);
  });

  it("uses the 'Was:' text as the title when the struck part is a stub", () => {
    expect(by("F2")).toMatchObject({ done: true, doneAt: "2026-10-06", title: "Publish the newsletter templates branch" });
  });

  it("owner comes from an owner column when there is one, else the section, else agent", () => {
    expect(by("R1")).toMatchObject({ owner: "agent", done: true, doneAt: "2026-10-07", title: "Nobody gets an alert when an order fails" });
    expect(by("R2")).toMatchObject({ owner: "ops", done: false });
    expect(by("T1")).toMatchObject({ owner: "founder", done: true, doneAt: "2026-10-06", title: 'Product page says "hand-poured"' });
    expect(by("T2")).toMatchObject({ owner: "founder", done: false, title: "Which sale date is right: 2026-11-20 or 2026-11-27?" });
  });

  it("treats a strike that opens in the action cell and closes in a later cell as one struck row", () => {
    const md = [
      "## Founder only — NOW",
      "| # | action | why |",
      "|---|---|---|",
      "| N20 | ~~**Analytics login (2026-10-12):** run it from ~/work, then add the account. See app #734 | lets agents read the numbers (app #739) — DONE 2026-10-12~~ |",
    ].join("\n");
    const [it] = parsePending(md);
    expect(it).toMatchObject({ ref: "N20", done: true, doneAt: "2026-10-12", owner: "founder", title: "Analytics login (2026-10-12): run it from ~/work, then add the account", issues: ["app#734", "app#739"] });
  });

  it("handles the other column layouts (item/why/blocks)", () => {
    expect(by("F3")).toMatchObject({ owner: "founder", done: false, title: 'Decide: offer gift wrapping at checkout ("wrap it" → +$4 per order)' });
    expect(by("F1").section).toBe("Needs the founder (something waits on it)");
  });

  it("ignores table rows without a ref (the credentials table)", () => {
    expect(items.some((i) => /widget-bot|Shop API key|Repo token/i.test(i.title))).toBe(false);
  });
});

describe("parsePending: bullets", () => {
  it("makes items from action lists, with stable hash refs, issues and the section owner", () => {
    const m0 = bullet("M0 Setup");
    expect(m0).toMatchObject({ owner: "agent", done: false, issues: ["#1", "#4"], section: "Agent work — the roadmap (milestones; issues on GitHub)" });
    expect(m0.title).toBe("M0 Setup (#1–#4): repo ✓ 2026-10-05, shop facts, product sheets, supplier list (agents drafting them now), synced to the shared drive every night");
    expect(bullet("M1 Order tracking").issues).toEqual(["#6", "#9"]);
    expect(bullet("M5 First ads").title).toBe("M5 First ads (#32): $300 on search ads + $200 on a holiday video, 2 weeks");
  });

  it("reads '(owner: x)' annotations, including across wrapped lines, and drops the annotation from the title", () => {
    expect(bullet("free shipping")).toMatchObject({ owner: "agent", done: false, title: "Was free shipping over $50 switched on in the live shop on the morning of 14 Oct?" });
    expect(bullet("ADR-012")).toMatchObject({ owner: "keeper", title: 'Shop ADR-012 says "not live yet" while the changelog says it shipped — ask the shop lead to fix the ADR' });
    expect(bullet("scheduler list")).toMatchObject({ owner: "ops" });
  });

  it("marks struck-through bullets done with their date, and every bullet in a Done section", () => {
    expect(bullet("Shop migrations")).toMatchObject({ done: true, doneAt: "2026-10-13", title: "Shop migrations 31–36: not described in the docs" });
    expect(bullet("Order lookup tools")).toMatchObject({ done: true, doneAt: "2026-10-04", issues: ["#43", "#44"], title: "Order lookup tools for the assistant (phase B)" });
    expect(bullet("shared drive was moved")).toMatchObject({ done: true, doneAt: "2026-10-04" });
  });

  it("keeps open items in 'Known gaps' and skips narrative log sections", () => {
    expect(bullet("Order source: tracked")).toMatchObject({ done: false, owner: "agent" });
    expect(bullet("Gift cards are off")).toMatchObject({ done: false });
    expect(items.some((i) => /Checkout \(prod\)|tracking stays off/.test(i.title))).toBe(false);
  });

  it("a bullet keeps its ref when it is struck through later (so the task flips open -> done, not duplicates)", () => {
    const open = parsePending("## Needs check\n- Rotate the widget key.\n");
    const closed = parsePending("## Needs check\n- ~~Rotate the widget key.~~ — done 2026-10-14 by the lead agent\n");
    expect(open).toHaveLength(1);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.ref).toBe(open[0]!.ref);
    expect(open[0]).toMatchObject({ done: false, title: "Rotate the widget key" });
    expect(closed[0]).toMatchObject({ done: true, doneAt: "2026-10-14", title: "Rotate the widget key" });
  });

  it("refs are deterministic across runs", () => {
    expect(parsePending(FIXTURE).map((i) => i.ref)).toEqual(items.map((i) => i.ref));
  });
});

describe("parsePending: whole file", () => {
  it("finds every table ref once, in order, plus the bullet items", () => {
    const refs = items.map((i) => i.ref).filter((r) => !r.startsWith("b-"));
    expect(refs).toEqual(["N9", "N10", "N11", "N12", "N13", "N14", "N15", "A1", "A2", "A3", "F1", "F2", "F3", "T1", "T2", "R1", "R2"]);
    expect(items.filter((i) => i.ref.startsWith("b-"))).toHaveLength(items.length - refs.length);
    expect(new Set(items.map((i) => i.ref)).size).toBe(items.length);
  });

  it("copes with sensitive sections (parses them) and the caller can drop them first", () => {
    expect(items.some((i) => i.ref === "A3")).toBe(true);
    expect(items.some((i) => /Live database: changes 41/.test(i.title))).toBe(true);
    const { text, dropped } = dropSensitiveSections(FIXTURE);
    expect(dropped.map((d) => d.split(" ")[0])).toEqual(["AUDIT", "Needs", "Expiring"]);
    const kept = parsePending(text);
    expect(kept.some((i) => i.ref === "A1" || i.ref === "A3")).toBe(false);
    expect(kept.some((i) => /Live database: changes 41/.test(i.title))).toBe(false);
    expect(kept.some((i) => i.ref === "N9")).toBe(true);
    expect(kept).toHaveLength(items.length - 3 - 3);
  });

  it("first occurrence wins when a ref appears twice", () => {
    const md = "## Needs the founder\n| # | action |\n|---|---|\n| N1 | First. |\n| N1 | Second. |\n";
    expect(parsePending(md).map((i) => i.title)).toEqual(["First"]);
  });

  it("redacts the title and the section heading", () => {
    const md = "## Needs the founder (call +91 98765 43210)\n| # | action |\n|---|---|\n| N1 | Email ceo@example.org about the licence. Then wait. |\n";
    const [it] = parsePending(md);
    expect(it!.title).toBe("Email [redacted:email] about the licence");
    expect(it!.section).toBe("Needs the founder (call [redacted:phone])");
  });

  it("does not crash on odd input", () => {
    const odd = [
      "", "\n\n", "# only a heading", "|", "| N1 |", "| # | action |\n|---|---|\n| N1 |", "| N1 | x", "- ", "-", "- ~~~~", "- ~~",
      "```\n| N1 | in a fence |\n```", "## S\n| # |\n|---|\n| N1 |\n", "x".repeat(200_000), "| N1 | " + "a ".repeat(100_000) + " |",
      "## Needs\n- " + "word ".repeat(50_000), "\r\n## Needs\r\n- a b\r\n  continued (owner: x)\r\n",
    ];
    for (const md of odd) expect(() => parsePending(md)).not.toThrow();
    expect(parsePending("## Needs\r\n- a b\r\n  continued (owner: zed)\r\n")[0]).toMatchObject({ owner: "zed", title: "A b continued" });
  });
});

describe("pendingToWrite", () => {
  const ctx = { docId: "document:00-command-pending-md", asOf: "2026-10-07" };
  const w = pendingToWrite(items, ctx);
  const nodeById = new Map(w.nodes.map((n) => [n.id, n]));

  it("emits one Task per item with the contract props, provenance and a tracked title", () => {
    const tasks = w.nodes.filter((n) => n.type === "Task");
    expect(tasks).toHaveLength(items.length);
    const n9 = nodeById.get(entityId("Task", "pending N9"))!;
    expect(n9.id).toBe("task:pending-n9");
    expect(n9).toMatchObject({
      type: "Task", name: by("N9").title, src: ctx.docId, asOf: ctx.asOf,
      props: { kind: "pending", status: "open", ref: "N9", owner: "founder", title: by("N9").title },
    });
    expect(nodeById.get("task:pending-n10")!.props).toMatchObject({ status: "done", doneAt: "2026-10-15" });
    expect("doneAt" in nodeById.get("task:pending-n9")!.props!).toBe(false);
    expect(nodeById.get("task:pending-n13")!.props!.issues).toEqual(["app#58", "#61"]);
  });

  it("emits the owners' nodes: the founder as Person, named owners as Agents (never the reserved allevia ids)", () => {
    expect(nodeById.get("person:founder")).toMatchObject({ type: "Person", name: "Founder" });
    for (const id of ["agent:agent", "agent:keeper", "agent:ops"]) expect(nodeById.get(id)?.type).toBe("Agent");
    expect(w.nodes.some((n) => /^(agent|team):allevia-/.test(n.id))).toBe(false);
    const reserved = pendingToWrite(parsePending("## Needs\n- Do it. (owner: allevia-planner)\n"), ctx);
    expect(reserved.nodes.some((n) => n.id.startsWith("agent:allevia-"))).toBe(false);
    expect(reserved.edges.find((e) => e.type === "OWNS")!.from).toBe("agent:agent");
  });

  it("emits OWNS (owner -> task) and SOURCED_FROM (task -> document); every edge is allowed and every endpoint is a node", () => {
    const owns = w.edges.filter((e) => e.type === "OWNS");
    expect(owns).toHaveLength(items.length);
    expect(owns.find((e) => e.to === "task:pending-n9")!.from).toBe("person:founder");
    expect(owns.find((e) => e.to === "task:pending-r2")!.from).toBe("agent:ops");
    const src = w.edges.filter((e) => e.type === "SOURCED_FROM");
    expect(src).toHaveLength(items.length);
    for (const e of src) expect(e.to).toBe(ctx.docId);
    for (const e of w.edges) {
      expect(e).toMatchObject({ src: ctx.docId, asOf: ctx.asOf });
      const from = nodeById.get(e.from);
      expect(from, e.from).toBeDefined();
      const to = nodeById.get(e.to) ?? (e.to === ctx.docId ? { type: "Document" as const } : undefined);
      expect(to, e.to).toBeDefined();
      expect(isAllowed(from!.type, e.type, to!.type)).toBe(true);
    }
    expect(w.observations).toEqual([]);
  });

  it("does not mark OWNS as `functional: true` (that would close the owner's other tasks); the schema's own Task-owner rule applies", () => {
    for (const e of w.edges) expect(e.functional).toBeUndefined();
  });
});

describe("pendingToWrite (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  const ctx = { docId: "document:00-command-pending-md", asOf: "2026-10-07" };
  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await upsertNode(g, { type: "Document", id: ctx.docId, name: "00-command/PENDING.md", props: { kind: "pending" } });
  });
  afterAll(async () => {
    await cleanup();
    await closeAll();
  });
  const one = async (cypher: string, params?: Record<string, unknown>) => (await g.roQuery<{ c: number }>(cypher, params))[0]!.c;
  const FOUNDER_OWNED = "MATCH (:Entity {id:'person:founder'})-[r:OWNS]->(t:Task) WHERE r.until IS NULL RETURN count(t) AS c";

  it("writes cleanly and is idempotent", async () => {
    const w = pendingToWrite(items, ctx);
    const s1 = await writeBatch(g, w);
    expect(s1.errors).toEqual([]);
    expect(s1.nodesCreated).toBeGreaterThan(items.length);
    const founderTasks = items.filter((i) => i.owner === "founder").length;
    expect(await one(FOUNDER_OWNED)).toBe(founderTasks);
    const s2 = await writeBatch(g, pendingToWrite(items, ctx));
    expect(s2.errors).toEqual([]);
    expect(s2.nodesCreated).toBe(0);
    expect(s2.edgesCreated).toBe(0);
    expect(s2.versions).toBe(0);
    expect(await one(FOUNDER_OWNED)).toBe(founderTasks);
  });

  it("reassigning one task closes only that owner edge; closing it writes a Version and keeps one current owner", async () => {
    const before = await one(FOUNDER_OWNED);
    const edited = FIXTURE
      .replace("| N15 | Reply to the partner email thread", "| N15 | ~~Reply to the partner email thread~~ DONE 2026-10-08 (see `Acme-Org/widget-brain#42`)")
      .replace("| N12 | **Card payments:**", "| N12 | **Card payments (now with the agent):**");
    const w2 = pendingToWrite(parsePending(edited).map((i) => (i.ref === "N12" ? { ...i, owner: "agent" } : i)), { ...ctx, asOf: "2026-10-08" });
    const s = await writeBatch(g, w2);
    expect(s.errors).toEqual([]);
    expect(s.edgesClosed).toBe(1); // the founder's OWNS edge into N12, nothing else
    expect(await one(FOUNDER_OWNED)).toBe(before - 1);
    expect(await one("MATCH (:Entity)-[r:OWNS]->(:Entity {id:'task:pending-n12'}) WHERE r.until IS NULL RETURN count(r) AS c")).toBe(1);
    const [n15] = await g.roQuery<{ status: string; doneAt: string }>("MATCH (t:Entity:Task {id:'task:pending-n15'}) RETURN t.status AS status, t.doneAt AS doneAt");
    expect(n15).toEqual({ status: "done", doneAt: "2026-10-08" });
    expect(await one("MATCH (:Entity {id:'task:pending-n15'})-[:HAD_VERSION]->(v:Version) RETURN count(v) AS c")).toBeGreaterThanOrEqual(1);
  });
});

// Structure only: never snapshot real content into the repo.
const VAULT = BRAIN_PATH;
describe.skipIf(!existsSync(join(VAULT, "00-command", "PENDING.md")))("real vault PENDING (structure only)", () => {
  it("parses at least 5 items, with sane shapes, and nothing sensitive survives the title", () => {
    const real = readFileSync(join(VAULT, "00-command", "PENDING.md"), "utf8");
    const parsed = parsePending(dropSensitiveSections(real).text);
    expect(parsed.length).toBeGreaterThanOrEqual(5);
    expect(new Set(parsed.map((p) => p.ref)).size).toBe(parsed.length);
    for (const p of parsed) {
      expect(p.title.length).toBeGreaterThan(0);
      expect(p.title.length).toBeLessThanOrEqual(160);
      expect(p.owner).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(p.done || p.doneAt === undefined).toBe(true);
      if (p.doneAt) expect(p.doneAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(parsed.some((p) => p.done)).toBe(true);
    expect(parsed.some((p) => !p.done)).toBe(true);
  });
});
