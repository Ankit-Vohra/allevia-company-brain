// The shared reference graph (src/graph/reference.ts): loaded once, read by the agents next to the business graph, and a cited
// shared rule still resolves (citation check, a stub in the business graph for the CITED edge). The reference graph is this
// file's own throwaway one (tests/setup/reference.ts), on the test server only.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { upsertNode, upsertEdge } from "../../src/graph/upsert.js";
import { ensureReference, ensureReferenceStubs, openReference, referenceFilter, referenceParams } from "../../src/graph/reference.js";
import { isReferenceEdge, isReferenceId, referenceIds, referenceWrite, refStubNode, seoRuleStubsWrite } from "../../src/ingest/sources/reference.js";
import { ruleId } from "../../src/ingest/sources/playbook-data.js";
import { playbook } from "../../src/agent/tools/playbook.js";
import { getEntity } from "../../src/agent/tools/entity.js";
import { checkTurn } from "../../src/agent/checks.js";
import { saveTurn } from "../../src/agent/memory.js";
import { companyFacts } from "../../src/agent/skills/company.js";
import { testGraph } from "../helpers/graph.js";
import { call, makeCtx } from "../helpers/tools.js";

const HOOK = ruleId("hook", "Cost Confession");
const SEO = ruleId("seo-check", "missing-title");

describe("reference content (no database)", () => {
  it("holds every pack, every industry's benchmark and Allevia's SEO checks; Channel anchors are not reference nodes", () => {
    const w = referenceWrite();
    const types = (t: string) => w.nodes.filter((n) => n.type === t);
    expect(types("Playbook").length).toBe(6); // five vendored packs and Allevia's own SEO checks
    expect(types("Rule").length).toBeGreaterThan(150);
    expect(types("Event").every((e) => e.props?.kind === "google-update")).toBe(true);
    expect(types("Rule").filter((r) => r.props?.kind === "benchmark" && r.props?.industry).length).toBeGreaterThan(3);
    expect(isReferenceId(HOOK)).toBe(true);
    expect(isReferenceId("channel:instagram")).toBe(false);
    expect([...referenceIds()].some((id) => id.startsWith("channel:"))).toBe(false);
    expect(isReferenceEdge(HOOK, "APPLIES_TO", "channel:instagram")).toBe(true);
  });

  it("a stub keeps the id, type, name, kind and severity, not the long text", () => {
    const s = refStubNode(SEO)!;
    expect(s).toMatchObject({ type: "Rule", id: SEO, props: expect.objectContaining({ refStub: true, kind: "seo-check", severity: expect.anything() }) });
    expect(s.props?.text).toBeUndefined();
    expect(refStubNode("channel:website")).toBeUndefined();
    const w = seoRuleStubsWrite({ results: [{ ruleId: SEO } as never, { ruleId: SEO } as never] });
    expect(w.nodes.map((n) => n.id)).toEqual(["channel:website", SEO]);
  });
});

describe("the shared reference graph (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await ensureIndexes(g);
    const r = await ensureReference();
    expect(r.errors).toEqual([]);
    // a business with one fact of its own and a stub (its audit found the missing title)
    await upsertNode(g, { type: "Channel", id: "channel:instagram", name: "Instagram", src: "test", asOf: "2026-10-01" });
    await upsertNode(g, { type: "Page", id: "page:example.com", name: "Home", src: "test", asOf: "2026-10-01" });
    await upsertNode(g, refStubNode(SEO)!);
    await upsertEdge(g, { from: "page:example.com", type: "FAILS", to: SEO, src: "test", asOf: "2026-10-01" });
  }, 120_000);
  afterAll(async () => { await cleanup(); await closeAll(); });

  it("loads once: a second call finds the same version and writes nothing", async () => {
    const again = await ensureReference();
    expect(again.loaded).toBe(false);
    const ref = await openReference();
    const [c] = await ref.roQuery<{ c: number }>("MATCH (r:Rule) RETURN count(r) AS c");
    expect(c!.c).toBe(referenceWrite().nodes.filter((n) => n.type === "Rule").length);
  });

  it("agents find shared rules through the reference graph, with text, playbook and the vendored source", async () => {
    const ctx = makeCtx(g);
    const r = await call(playbook, { topic: "hooks", channel: "instagram", limit: 25 }, ctx);
    const hook = r.data.rules.find((x: { id: string }) => x.id === HOOK);
    expect(hook).toMatchObject({ kind: "hook", general: true, playbook: { type: "Playbook" }, appliesTo: ["channel:instagram"] });
    expect(hook.text).toMatch(/Cost Confession|cost/i);
    expect(r.sources.some((s) => s.id.startsWith("document:vendor-playbooks-"))).toBe(true);
    // a stub in the business graph is answered by the reference copy, which has the text
    const seo = await call(playbook, { kind: "seo_check", limit: 25 }, ctx);
    const title = seo.data.rules.find((x: { id: string }) => x.id === SEO);
    expect(title).toMatchObject({ general: true, howToFix: expect.any(String) });
    expect(title.text).toBeTruthy();
    // a channel only the shared playbooks know (this business has no Google Ads anchor)
    const ads = await call(playbook, { channel: "google-ads", kind: "benchmark" }, ctx);
    expect(ads.data.rules.length).toBeGreaterThan(0);
  });

  it("a cited shared rule passes the citation check, resolves by id, and the saved turn keeps a stub and its CITED edge", async () => {
    const ctx = makeCtx(g, { turnId: "turn:2026-10-17-ref00001" });
    ctx.touched.add(await call(playbook, { topic: "hooks", channel: "instagram", limit: 25 }, ctx));
    const answer = `Open with a cost confession [[${HOOK}]].`;
    expect(checkTurn(answer, ctx.touched).citationsValid).toBe(true);
    const e = await call(getEntity, { id: HOOK }, makeCtx(g));
    expect(e.data.error).toBeUndefined();
    await saveTurn(g, {
      turnId: "turn:2026-10-17-ref00001", sessionId: "session:2026-10-17-ref00001", question: "A hook?", answer, asker: "person:founder", at: Date.parse("2026-10-17T10:00:00Z"),
      agents: ["chief-of-staff"], events: [], touched: ctx.touched, citations: [HOOK], findings: [], reviews: [],
    });
    const rows = await g.roQuery<{ stub: boolean; text: string | null }>(
      "MATCH (t:Turn {id:'turn:2026-10-17-ref00001'})-[:CITED]->(r:Rule {id:$id}) RETURN r.refStub AS stub, r.text AS text", { id: HOOK });
    expect(rows).toEqual([{ stub: true, text: null }]);
    // only what the turn used: other shared rules it merely saw are not copied in
    const [n] = await g.roQuery<{ c: number }>("MATCH (r:Rule) RETURN count(r) AS c");
    expect(n!.c).toBe(2);
  });

  it("stubs only for reference ids, never twice", async () => {
    expect(await ensureReferenceStubs(g, ["page:example.com", "rule:not-a-reference-rule"])).toEqual([]);
    expect(await ensureReferenceStubs(g, [SEO, SEO])).toEqual([SEO]);
  });

  it("the reference filter tells shared know-how (and stubs) from business facts", async () => {
    const rows = await g.roQuery<{ id: string; ref: boolean }>(
      `MATCH (n:Entity) WHERE n:Rule OR n:Page OR n:Channel RETURN n.id AS id, ${referenceFilter("n")} AS ref ORDER BY id`, referenceParams());
    expect(rows).toEqual(expect.arrayContaining([
      { id: "channel:instagram", ref: false }, { id: "page:example.com", ref: false }, { id: SEO, ref: true }, { id: HOOK, ref: true },
    ]));
  });

  it("the company skill lists the shared hook formulas", async () => {
    const f = await companyFacts(g, "test");
    expect(f.hooks.length).toBeGreaterThan(0);
  });
});
