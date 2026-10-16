// Issue #24: onboarding's tidy pass on a small graph shaped like the trials' noise (docs/onboarding-trials.md): Twitter
// and X, three funnel features, a roaster and the business's own legal name typed Business, a staff first name as a
// Person. A fake model check answers; everything it does is undone with undoTidy (db:unmerge), and stays undone.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { writeBatch, type EdgeInput, type NodeInput } from "../../src/graph/upsert.js";
import { tidyGraph, undoTidy, type TidyDeps } from "../../src/ingest/tidy.js";
import { graphQuality } from "../../src/ingest/quality.js";
import type { Ask, AskInput } from "../../src/ingest/sources/website/ask.js";
import { testGraph } from "../helpers/graph.js";

const AS_OF = "2026-10-15T09:00:00.000Z";
const NOW = Date.parse("2026-10-15T10:00:00.000Z");
const DOC = "document:web-cafe-example-com";
const OWNER = { id: "business:cafe", name: "Cafe Example", domain: "cafe.example.com" };

// The model check: a funnel analysis IS the funnels feature; nothing else is the same. Royal Mail is the courier; the
// mystery company is unclear.
class FakeAsk implements Ask {
  calls: AskInput[] = [];
  async structured(i: AskInput): Promise<unknown> {
    this.calls.push(i);
    const lines = i.data.split("\n").filter(Boolean);
    if (i.label === "tidy-pairs") {
      return { verdicts: lines.map((l, k) => ({ pair: k + 1, same: /"Funnels"/.test(l) && /"Funnel analysis"/.test(l) })) };
    }
    if (i.label === "tidy-businesses") {
      return { businesses: lines.map((l, k) => ({ n: k + 1, kind: /Royal Mail/.test(l) ? "supplier" : "unclear", role: /Royal Mail/.test(l) ? "courier" : "" })) };
    }
    throw new Error(`unexpected question ${i.label}`);
  }
}

const DIM = 40;
const norm = (v: number[]) => { const n = Math.hypot(...v); return v.map((a) => a / n); };
const vec = (x: number) => norm([1, x, 0.1, ...Array<number>(DIM - 3).fill(0)]);
// anything else: its own direction, far from every other name
const other = (t: string) => { const v = Array<number>(DIM).fill(0); v[3 + ([...t].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % (DIM - 3))] = 1; return v; };
const VECTORS: Record<string, number[]> = {
  "Funnels": vec(0.1), "Funnel analysis": vec(0.12), "Funnels and user journeys": vec(0.6), "Goal conversions": vec(9),
};
const embed = async (texts: string[]) => texts.map((t) => VECTORS[t.replace(/ \(.*$/, "")] ?? other(t));

describe("tidyGraph (test graph)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  let ask: FakeAsk;
  const deps = (): TidyDeps => ({ owner: OWNER, ask, embed, now: NOW });
  const q = <T = Record<string, unknown>>(c: string, p?: Record<string, unknown>) => g.roQuery<T>(c, p);

  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    ask = new FakeAsk();
    const src = { src: DOC, asOf: AS_OF };
    const nodes: NodeInput[] = [
      { type: "Business", id: OWNER.id, name: OWNER.name, props: { domain: OWNER.domain } },
      { type: "Document", id: DOC, name: "Home", props: { kind: "webpage" } },
      { type: "Product", id: "product:analytics", name: "Analytics", ...src },
      { type: "Channel", id: "channel:x", name: "X (Twitter)", props: { platform: "x", url: "https://x.com/cafe" }, ...src },
      { type: "Channel", id: "channel:twitter", name: "Twitter", ...src },
      { type: "Feature", id: "feature:funnels", name: "Funnels", ...src },
      { type: "Feature", id: "feature:funnel-analysis", name: "Funnel analysis", ...src },
      { type: "Feature", id: "feature:funnels-and-user-journeys", name: "Funnels and user journeys", ...src },
      { type: "Feature", id: "feature:goal-conversions", name: "Goal conversions", ...src },
      { type: "Business", id: "business:square-mile-roasters", name: "Square Mile Roasters", summary: "Coffee roaster that supplies the beans for the espresso.", ...src },
      { type: "Business", id: "business:cafe-example-ltd", name: "Cafe Example Ltd", summary: "The company that runs the cafe.", ...src },
      { type: "Business", id: "business:royal-mail", name: "Royal Mail", summary: "Sends the cafe's online orders.", ...src },
      { type: "Business", id: "business:mystery-co", name: "Mystery Co", summary: "Named in the footer.", ...src },
      { type: "Person", id: "person:sam", name: "Sam", summary: "Thanked on the about page.", ...src },
      { type: "Person", id: "person:ruth", name: "Ruth", summary: "Our head barista.", ...src },
    ];
    const ids = nodes.filter((n) => n.type !== "Document" && n.id !== OWNER.id).map((n) => n.id);
    const edges: EdgeInput[] = [
      ...ids.map((id) => ({ from: id, type: "SOURCED_FROM" as const, to: DOC, ...src })),
      ...ids.map((id) => ({ from: DOC, type: "MENTIONS" as const, to: id, ...src })),
      { from: "channel:x", type: "PART_OF", to: OWNER.id, ...src },
      { from: "channel:twitter", type: "PART_OF", to: OWNER.id, ...src },
      ...["feature:funnels", "feature:funnel-analysis", "feature:funnels-and-user-journeys", "feature:goal-conversions"].map((id) => ({ from: id, type: "PART_OF" as const, to: "product:analytics", ...src })),
      { from: "business:square-mile-roasters", type: "OWNS", to: "product:analytics", ...src }, // a Supplier cannot OWN: closed, not moved
    ];
    const s = await writeBatch(g, { nodes, edges, observations: [] }, Date.parse(AS_OF));
    expect(s.errors).toEqual([]);
  });
  afterAll(async () => {
    await cleanup();
    await closeAll();
  });

  it("dry run: says what it would do and writes nothing", async () => {
    const before = await q("MATCH (n) RETURN n.id AS id, n.mergedInto AS m, n.retired AS r ORDER BY id");
    const r = await tidyGraph(g, { ...deps(), dryRun: true });
    expect(r.merged).toBe(2);
    expect(r.retyped).toBe(3);
    expect(r.retired).toBe(1);
    expect(await q("MATCH (n) RETURN n.id AS id, n.mergedInto AS m, n.retired AS r ORDER BY id")).toEqual(before);
  });

  it("merges X and Twitter at once and the funnels the model calls one feature; remembers the pairs it called different", async () => {
    ask.calls = [];
    const r = await tidyGraph(g, deps());
    expect(r.errors).toEqual([]);
    expect(r.byHow).toEqual({ "same channel": 1, "model check": 1 });
    const merged = await q<{ id: string; into: string }>("MATCH (n:Entity) WHERE n.mergedInto IS NOT NULL AND n:Searchable AND (n:Channel OR n:Feature) RETURN n.id AS id, n.mergedInto AS into ORDER BY id");
    // equally connected: the name written out in full is canonical
    expect(merged).toEqual([{ id: "channel:twitter", into: "channel:x" }, { id: "feature:funnels", into: "feature:funnel-analysis" }]);
    // the duplicate's edges now hang off the canonical node, and SAME_AS records why
    expect(await q("MATCH (:Channel {id:'channel:twitter'})-[r]->() WHERE r.until IS NULL AND type(r) <> 'SAME_AS' RETURN r")).toEqual([]);
    const [same] = await q<{ by: string; basis: string }>("MATCH (:Feature {id:'feature:funnels'})-[s:SAME_AS]->(:Feature {id:'feature:funnel-analysis'}) RETURN s.derivedBy AS by, s.basis AS basis");
    expect(same).toMatchObject({ by: "onboarding", basis: expect.stringMatching(/^model check: same thing/) });
    const [d] = await q<{ d: string[] }>("MATCH (f:Feature {id:'feature:funnels'}) RETURN f.distinctFrom AS d");
    expect(d!.d).toContain("feature:funnels-and-user-journeys");
  });

  it("retypes the roaster as a Supplier, merges the legal name into the owner, asks the model only about the rest", async () => {
    const [sup] = await q<{ name: string; from: string; role: string | null; basis: string }>(
      "MATCH (s:Supplier {id:'supplier:square-mile-roasters'})-[r:SUPPLIES]->(:Business {id:'business:cafe'}) WHERE r.until IS NULL RETURN s.name AS name, s.retypedFrom AS from, r.role AS role, r.basis AS basis");
    expect(sup).toMatchObject({ name: "Square Mile Roasters", from: "business:square-mile-roasters", basis: "another business: supplier (what the page says)" });
    expect(await q("MATCH (:Supplier {id:'supplier:square-mile-roasters'})-[r:SOURCED_FROM]->(:Document) WHERE r.until IS NULL RETURN r")).toHaveLength(1);
    // the OWNS a Supplier cannot hold is closed on the Business, not moved
    expect(await q("MATCH (:Business {id:'business:square-mile-roasters'})-[r:OWNS]->() RETURN r.until AS until, r.closeReason AS why")).toEqual([{ until: NOW, why: "merged into supplier:square-mile-roasters" }]);
    const [mail] = await q<{ role: string }>("MATCH (:Supplier {id:'supplier:royal-mail'})-[r:SUPPLIES]->(:Business) RETURN r.role AS role");
    expect(mail!.role).toBe("courier");
    expect(await q("MATCH (b:Business {id:'business:cafe-example-ltd'}) RETURN b.mergedInto AS m")).toEqual([{ m: "business:cafe" }]);
    expect(await q("MATCH (b:Business {id:'business:mystery-co'}) RETURN b.mergedInto AS m")).toEqual([{ m: null }]);
    const asked = ask.calls.find((c) => c.label === "tidy-businesses")!;
    expect(asked.data).toMatch(/Royal Mail/);
    expect(asked.data).not.toMatch(/Square Mile|Cafe Example Ltd/); // the summary and the name already said
  });

  it("retires the first name with no role, keeps the head barista", async () => {
    expect(await q("MATCH (p:Person) RETURN p.id AS id, p.retired AS r ORDER BY id")).toEqual([{ id: "person:ruth", r: null }, { id: "person:sam", r: true }]);
    expect(await q("MATCH (:Person {id:'person:sam'})-[r]-() WHERE r.until IS NULL RETURN r")).toEqual([]);
  });

  it("leaves a graph the quality report calls clean, and a second run changes nothing and asks nothing", async () => {
    const r = await graphQuality(g, OWNER.id);
    expect(r.duplicates.certain).toBe(0);
    expect(r.mistyped).toMatchObject({ otherBusinesses: 1, firstNamePeople: 0 }); // Mystery Co, which nobody could place
    expect(r.tidied).toEqual({ merged: 3, retyped: 2, retired: 1 });
    const calls = ask.calls.length;
    const again = await tidyGraph(g, deps());
    expect(again.merged + again.retired).toBe(0);
    expect(again.retyped).toBe(0);
    expect(ask.calls.length - calls).toBe(1); // only Mystery Co is asked about again (the cached ask answers that in production)
  });

  it("undoes each kind of change with db:unmerge, and never redoes it", async () => {
    expect(await undoTidy(g, "channel:twitter", NOW + 1)).toMatch(/its own node again/);
    expect(await q("MATCH (c:Channel {id:'channel:twitter'})-[r:PART_OF]->(:Business) WHERE r.until IS NULL RETURN c.mergedInto AS m")).toEqual([{ m: null }]);

    expect(await undoTidy(g, "business:square-mile-roasters", NOW + 1)).toMatch(/merged into supplier:square-mile-roasters/);
    expect(await q("MATCH (:Supplier {id:'supplier:square-mile-roasters'})-[r]-() WHERE r.until IS NULL RETURN type(r) AS t")).toEqual([]);
    expect(await q("MATCH (s:Supplier {id:'supplier:square-mile-roasters'}) RETURN s.mergedInto AS m")).toEqual([{ m: "business:square-mile-roasters" }]);
    expect(await q("MATCH (:Business {id:'business:square-mile-roasters'})-[r:OWNS]->() WHERE r.until IS NULL RETURN r")).toHaveLength(1);

    expect(await undoTidy(g, "person:sam", NOW + 1)).toMatch(/is back/);
    const back = await q<{ t: string }>("MATCH (:Person {id:'person:sam'})-[r]-() WHERE r.until IS NULL RETURN type(r) AS t");
    expect(back.map((r) => r.t).sort()).toEqual(["MENTIONS", "SOURCED_FROM"]);
    expect(await undoTidy(g, "person:ruth", NOW + 1)).toBeUndefined();

    const again = await tidyGraph(g, deps());
    expect(again.merged + again.retyped + again.retired).toBe(0);
  });
});
