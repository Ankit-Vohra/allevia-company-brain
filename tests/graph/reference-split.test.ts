// graph:reference-split on a business graph that still holds the old copy of the playbooks (as onboarding wrote it until
// 17 Oct 2026), on the test server only: the dry run changes nothing; apply backs the business up, loads the reference graph,
// keeps as stubs exactly the reference nodes business facts point at (and says why), and removes the rest.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { closeAll, openGraph, type GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { upsertEdge, upsertNode, writeBatch } from "../../src/graph/upsert.js";
import { openReference } from "../../src/graph/reference.js";
import { formatSplit, splitReference } from "../../src/graph/reference-split.js";
import { referenceWrite } from "../../src/ingest/sources/reference.js";
import { ruleId } from "../../src/ingest/sources/playbook-data.js";
import { runReferenceSplit } from "../../src/cli/hygiene.js";

const slug = `test_split_${randomBytes(4).toString("hex")}`;
const SEO = ruleId("seo-check", "missing-title");
const HOOK = ruleId("hook", "Cost Confession");
const CITED = ruleId("seo-check", "missing-h1");
const SEEN = ruleId("seo-check", "multiple-h1");
const OLD_EVENT = "event:google-update-an-update-a-newer-pack-dropped-2020-01-01";
const AS = { src: "test", asOf: "2026-10-01" };

const size = async (g: GraphHandle) => {
  const [n] = await g.roQuery<{ c: number }>("MATCH (n) RETURN count(n) AS c");
  const [e] = await g.roQuery<{ c: number }>("MATCH ()-[r]->() WHERE ID(r) >= 0 RETURN count(r) AS c");
  return { nodes: n!.c, edges: e!.c };
};

describe("graph:reference-split (integration)", () => {
  let g: GraphHandle;
  let backups: string;
  beforeAll(async () => {
    g = await openGraph(slug);
    await ensureIndexes(g);
    // the old copy, plus one Google update from an older pack version (a vendored source, an id the current data lacks)
    const s = await writeBatch(g, referenceWrite());
    expect(s.errors).toEqual([]);
    await upsertNode(g, { type: "Event", id: OLD_EVENT, name: "An update a newer pack dropped", src: "document:vendor-playbooks-agricidaniel-claude-seo-google-updates-json", asOf: "2026-09-01", props: { kind: "google-update" } });
    // business facts that point at reference rules
    await upsertNode(g, { type: "Page", id: "page:example.com", name: "Home", ...AS });
    await upsertNode(g, { type: "Content", id: "content:reel-1", name: "A reel", ...AS });
    await upsertNode(g, { type: "Turn", id: "turn:2026-10-01-split001", name: "Which SEO fix first?", ...AS });
    await upsertEdge(g, { from: "page:example.com", type: "FAILS", to: SEO, ...AS });
    await upsertEdge(g, { from: "content:reel-1", type: "USES_RULE", to: HOOK, ...AS });
    await upsertEdge(g, { from: "turn:2026-10-01-split001", type: "CITED", to: CITED, ...AS });
    await upsertEdge(g, { from: "turn:2026-10-01-split001", type: "TOUCHED", to: SEEN, ...AS }); // only seen: not a reason to keep it
    backups = mkdtempSync(join(tmpdir(), "allevia-split-"));
  }, 180_000);
  afterAll(async () => {
    await g.drop();
    rmSync(backups, { recursive: true, force: true });
    await closeAll();
  });

  it("the dry run reports and changes nothing", async () => {
    const before = await size(g);
    const r = await splitReference(g);
    expect(r.applied).toBe(false);
    expect(await size(g)).toEqual(before);
    expect(r.reference.Rule).toBeGreaterThan(150);
    expect(r.reference.Event).toBeGreaterThan(10);
    expect(r.kept.map((k) => k.id).sort()).toEqual([HOOK, CITED, SEO].sort());
    expect(r.kept.find((k) => k.id === SEO)!.why).toEqual(["Page FAILS"]);
    expect(r.kept.find((k) => k.id === HOOK)!.why).toEqual(["Content USES_RULE"]);
    expect(r.touchedDropped).toBe(1);
    const text = formatSplit(slug, r);
    expect(text).toMatch(/would remove/);
    expect(text).toMatch(new RegExp(`${SEO} \\(Rule\\): Page FAILS`));
    console.log(text); // the dry-run output, for the report
  });

  it("apply backs up first, loads the reference graph, keeps the business's dependencies as stubs and removes the rest", async () => {
    const run = await runReferenceSplit({ tenants: [slug], apply: true, backupDir: backups, dataDir: join(backups, "data"), log: () => undefined });
    const t = run.tenants[0]!;
    expect(t.error).toBeUndefined();
    expect(t.backup).toMatch(new RegExp(`pre-split-${slug}-\\d{4}-\\d{2}-\\d{2}\\.export$`));
    expect(existsSync(t.backup!)).toBe(true);
    expect(run.reference?.errors).toEqual([]);
    expect(t.report!.applied).toBe(true);

    // the shared copy has everything
    const ref = await openReference();
    const [rr] = await ref.roQuery<{ c: number }>("MATCH (r:Rule) RETURN count(r) AS c");
    expect(rr!.c).toBe(referenceWrite().nodes.filter((n) => n.type === "Rule").length);

    // the business keeps its facts, their edges, and stubs of what they point at
    const left = await g.roQuery<{ id: string; stub: boolean | null; text: string | null }>(
      "MATCH (r:Entity) WHERE r:Rule OR r:Playbook OR r:Event OR (r:Document AND r.kind = 'playbook') RETURN r.id AS id, r.refStub AS stub, r.text AS text ORDER BY id");
    expect(left).toEqual([HOOK, CITED, SEO].sort().map((id) => ({ id, stub: true, text: null })));
    const [fails] = await g.roQuery<{ c: number }>("MATCH (:Page {id:'page:example.com'})-[f:FAILS]->(:Rule {id:$id}) RETURN count(f) AS c", { id: SEO });
    expect(fails!.c).toBe(1);
    const [cited] = await g.roQuery<{ c: number }>("MATCH (:Turn)-[c:CITED]->(:Rule {id:$id}) RETURN count(c) AS c", { id: CITED });
    expect(cited!.c).toBe(1);
    // a stub keeps no edge of the copy (no APPLIES_TO a channel); the channel anchors stay
    const [applies] = await g.roQuery<{ c: number }>("MATCH (r:Rule)-[a:APPLIES_TO]->() RETURN count(a) AS c");
    expect(applies!.c).toBe(0);
    const [ch] = await g.roQuery<{ c: number }>("MATCH (c:Channel {id:'channel:instagram'}) RETURN count(c) AS c");
    expect(ch!.c).toBe(1);
    const [sev] = await g.roQuery<{ kind: string; sev: string | null }>("MATCH (r:Rule {id:$id}) RETURN r.kind AS kind, r.severity AS sev", { id: SEO });
    expect(sev).toMatchObject({ kind: "seo-check", sev: expect.any(String) });
  });

  it("a second run finds only the stubs and has nothing left to remove", async () => {
    const r = await splitReference(g);
    expect(r.alreadyStubs).toBe(3);
    expect(Object.values(r.removed).reduce((s, x) => s + x, 0)).toBe(0);
  });
});
