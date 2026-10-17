// The write gate (src/graph/gate.ts), one test per rule: a new node needs a known label, a source and a date (the write's own
// fill in), a refusal is logged with its reason, an update is not gated, and a new person, business or product that is already
// there is linked to instead of created (by name, by email, through a merge).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { upsertNode, writeBatch } from "../../src/graph/upsert.js";
import { RefusedWrite, gateNode, normalName } from "../../src/graph/gate.js";
import { testGraph } from "../helpers/graph.js";

const AS = { src: "document:seed", asOf: "2026-10-01" };

describe("gateNode and normalName (no database)", () => {
  it("refuses an unknown label, a node with no source and one with no date; fills both from the write's own", () => {
    expect(() => gateNode({ type: "Widget" as never, id: "widget:x", name: "X", ...AS }, {})).toThrow(/unknown label "Widget"/);
    expect(() => gateNode({ type: "Task", id: "task:x", name: "X", asOf: "2026-10-01" }, {})).toThrow(RefusedWrite);
    expect(() => gateNode({ type: "Task", id: "task:x", name: "X", src: "turn:1" }, {})).toThrow(/no date/);
    expect(gateNode({ type: "Task", id: "task:x", name: "X" }, { src: "event:run", asOf: "2026-10-02" })).toMatchObject({ src: "event:run", asOf: "2026-10-02" });
    expect(gateNode({ type: "Task", id: "task:x", name: "X", ...AS }, { src: "event:run", asOf: "2026-10-02" })).toMatchObject(AS);
  });

  it("normalises case, punctuation, a leading 'the' and a company suffix", () => {
    expect(normalName("The ACME Co.")).toBe("acme");
    expect(normalName("Acme Pvt. Ltd")).toBe("acme");
    expect(normalName("  Priya   SHARMA ")).toBe("priya sharma");
  });
});

describe("writeBatch with the gate (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  const logged: string[] = [];
  const gate = (o: { src?: string; asOf?: string } = {}) => ({ gate: { who: "test", log: (l: string) => logged.push(l), ...o } });
  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await ensureIndexes(g);
    await upsertNode(g, { type: "Business", id: "business:cafe", name: "Cafe", ...AS });
    await upsertNode(g, { type: "Person", id: "person:priya-sharma", name: "Priya Sharma", ...AS });
    await upsertNode(g, { type: "Person", id: "person:dev", name: "Dev Rao", props: { email: "dev@example.com" }, ...AS });
    await upsertNode(g, { type: "Person", id: "person:rahul", name: "Rahul", ...AS });
    await upsertNode(g, { type: "Supplier", id: "supplier:acme-pvt-ltd", name: "Acme Pvt Ltd", ...AS });
    await upsertNode(g, { type: "Product", id: "product:cold-brew", name: "Cold brew", ...AS });
    await upsertNode(g, { type: "Product", id: "product:cold-brew-coffee", name: "Cold brew coffee", props: { mergedInto: "product:cold-brew" }, ...AS });
    await upsertNode(g, { type: "Task", id: "task:no-source", name: "Written before the gate" });
  }, 60_000);
  afterAll(async () => { await cleanup(); await closeAll(); });

  const exists = async (id: string): Promise<boolean> => (await g.roQuery("MATCH (n:Entity {id:$id}) RETURN n.id", { id })).length > 0;

  it("refuses a new node with an unknown label, with the reason logged and returned", async () => {
    logged.length = 0;
    const s = await writeBatch(g, { nodes: [{ type: "Widget" as never, id: "widget:x", name: "X", ...AS }] }, Date.now(), gate());
    expect(s.errors[0]!.error).toMatch(/^RefusedWrite: unknown label "Widget"/);
    expect(logged[0]).toMatch(/\[gate\] test refused widget:x: unknown label/);
    expect(s.nodesCreated).toBe(0);
  });

  it("refuses a new node with no source, and what needed it; the write's own source and date fill in when given", async () => {
    logged.length = 0;
    const s = await writeBatch(g, {
      nodes: [{ type: "Task", id: "task:orphan", name: "No source", asOf: "2026-10-01" }],
      edges: [{ from: "business:cafe", type: "OWNS", to: "task:orphan", ...AS }],
    }, Date.now(), gate());
    expect(s.errors.map((e) => e.error)).toEqual([
      "RefusedWrite: no source (src): every new node says where it came from", "RefusedWrite: task:orphan was refused",
    ]);
    expect(logged).toHaveLength(1);
    expect(await exists("task:orphan")).toBe(false);
    const ok = await writeBatch(g, { nodes: [{ type: "Task", id: "task:stamped", name: "Stamped" }] }, Date.now(), gate({ src: "event:run-1", asOf: "2026-10-02" }));
    expect(ok.errors).toEqual([]);
    const [t] = await g.roQuery<{ src: string; asOf: string }>("MATCH (t:Entity {id:'task:stamped'}) RETURN t.src AS src, t.asOf AS asOf");
    expect(t).toEqual({ src: "event:run-1", asOf: "2026-10-02" });
  });

  it("refuses a new node with no date", async () => {
    const s = await writeBatch(g, { nodes: [{ type: "Task", id: "task:undated", name: "No date", src: "turn:1" }] }, Date.now(), gate());
    expect(s.errors[0]!.error).toMatch(/no date \(asOf\)/);
    expect(await exists("task:undated")).toBe(false);
  });

  it("does not gate an update of a node that is already there", async () => {
    const s = await writeBatch(g, { nodes: [{ type: "Task", id: "task:no-source", name: "Written before the gate", props: { status: "open" } }] }, Date.now(), gate());
    expect(s.errors).toEqual([]);
    expect(s.nodesUpdated).toBe(1);
  });

  it("links a new person to the one already there by name, and points the write's edges at them", async () => {
    const s = await writeBatch(g, {
      nodes: [{ type: "Person", id: "person:p-sharma-2", name: "priya  SHARMA.", ...AS }],
      edges: [{ from: "person:p-sharma-2", type: "MEMBER_OF", to: "business:cafe", ...AS }],
    }, Date.now(), gate());
    expect(s.errors).toEqual([]);
    expect(s.resolved).toEqual([{ from: "person:p-sharma-2", to: "person:priya-sharma", type: "Person", by: "name" }]);
    expect(await exists("person:p-sharma-2")).toBe(false);
    const [m] = await g.roQuery<{ c: number }>("MATCH (:Entity {id:'person:priya-sharma'})-[r:MEMBER_OF]->(:Entity {id:'business:cafe'}) RETURN count(r) AS c");
    expect(m!.c).toBe(1);
  });

  it("links by email, whatever the name", async () => {
    const s = await writeBatch(g, { nodes: [{ type: "Person", id: "person:d-r", name: "D. R.", props: { email: "DEV@example.com" }, ...AS }] }, Date.now(), gate());
    expect(s.resolved).toEqual([{ from: "person:d-r", to: "person:dev", type: "Person", by: "email" }]);
  });

  it("links a company by its name without the suffix, and a product through the merge the librarian made", async () => {
    const s = await writeBatch(g, {
      nodes: [
        { type: "Supplier", id: "supplier:acme", name: "ACME", ...AS },
        { type: "Product", id: "product:cold-brew-coffee-2", name: "Cold Brew Coffee", ...AS },
      ],
      edges: [{ from: "supplier:acme", type: "SUPPLIES", to: "product:cold-brew-coffee-2", ...AS }],
    }, Date.now(), gate());
    expect(s.resolved).toEqual([
      { from: "supplier:acme", to: "supplier:acme-pvt-ltd", type: "Supplier", by: "name" },
      { from: "product:cold-brew-coffee-2", to: "product:cold-brew", type: "Product", by: "name" },
    ]);
    const [e] = await g.roQuery<{ c: number }>("MATCH (:Entity {id:'supplier:acme-pvt-ltd'})-[r:SUPPLIES]->(:Entity {id:'product:cold-brew'}) RETURN count(r) AS c");
    expect(e!.c).toBe(1);
  });

  it("does not merge a first name alone, or two different types", async () => {
    const s = await writeBatch(g, {
      nodes: [
        { type: "Person", id: "person:rahul-2", name: "Rahul", ...AS },
        { type: "Client", id: "client:acme", name: "Acme", ...AS },
      ],
    }, Date.now(), gate());
    expect(s.resolved).toBeUndefined();
    expect(await exists("person:rahul-2")).toBe(true);
    expect(await exists("client:acme")).toBe(true);
  });

  it("two new nodes of one write that are the same thing become one", async () => {
    const s = await writeBatch(g, {
      nodes: [
        { type: "Partner", id: "partner:bean-co", name: "Bean Co", ...AS },
        { type: "Partner", id: "partner:the-bean", name: "The Bean", ...AS },
      ],
    }, Date.now(), gate());
    expect(s.resolved).toEqual([{ from: "partner:the-bean", to: "partner:bean-co", type: "Partner", by: "name" }]);
    expect(s.nodesCreated).toBe(1);
  });
});
