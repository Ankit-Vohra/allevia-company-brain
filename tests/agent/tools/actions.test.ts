import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { GraphHandle } from "../../../src/graph/client.js";
import type { ToolContext } from "../../../src/agent/tool.js";
import { proposeAction } from "../../../src/agent/tools/actions.js";
import { recall } from "../../../src/agent/tools/memory.js";
import { call, ids, makeCtx, seededGraph } from "../../helpers/tools.js";

const args = {
  title: "Add meta description to /jobs", why: "The jobs page fails a high-severity check and has 9000 impressions.",
  kind: "github_issue", payload: { title: "Add meta description to /jobs", body: "Write 150 chars naming Raipur." },
  evidence: ["page:www.aamdani.ai/jobs", "rule:seo-meta-description", "nope:1"], area: "seo", confidence: 0.8,
};

describe("propose_action (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeAll(async () => ({ g, cleanup } = await seededGraph()), 60_000);
  afterAll(async () => cleanup());

  it("refuses in read-only mode and writes nothing", async () => {
    const r = await call(proposeAction, args, makeCtx(g, { readOnly: true, agentId: "tech-lead" }));
    expect(r.data).toMatchObject({ refused: true, error: expect.stringMatching(/read-only/) });
    expect((await g.roQuery<{ c: number }>("MATCH (r:Recommendation {id:'recommendation:add-meta-description-to-jobs'}) RETURN count(r) AS c"))[0]!.c).toBe(0);
    expect(proposeAction.writes).toBe(true);
  });

  it("a stopped run (ctx.signal) writes nothing", async () => {
    const r = await call(proposeAction, args, makeCtx(g, { agentId: "tech-lead", signal: AbortSignal.abort() } as unknown as Partial<ToolContext>));
    expect(r.data).toMatchObject({ refused: true, error: expect.stringMatching(/stopped/) });
    expect((await g.roQuery<{ c: number }>("MATCH (r:Recommendation {id:'recommendation:add-meta-description-to-jobs'}) RETURN count(r) AS c"))[0]!.c).toBe(0);
  });

  it("creates a Recommendation, a pending Approval, evidence links and the agent that produced it", async () => {
    const r = await call(proposeAction, args, makeCtx(g, { agentId: "tech-lead" }));
    expect(r.data).toMatchObject({
      recommendationId: "recommendation:add-meta-description-to-jobs", approvalId: "approval:t-100-1", status: "pending", kind: "github_issue",
      evidence: ["page:www.aamdani.ai/jobs", "rule:seo-meta-description"], skipped: ["nope:1"],
    });
    expect(r.note).toMatch(/nothing has been executed/);
    const [row] = await g.roQuery<Record<string, unknown>>(
      `MATCH (a:Agent {id:'agent:allevia-tech-lead'})-[:PRODUCED]->(rec:Recommendation {id:'recommendation:add-meta-description-to-jobs'})-[:PROPOSES]->(ap:Approval {id:'approval:t-100-1'})
       RETURN a.name AS agent, rec.status AS status, rec.by AS by, rec.confidence AS confidence, rec.area AS area, rec.src AS src,
         ap.status AS apStatus, ap.kind AS kind, ap.payload AS payload`);
    expect(row).toMatchObject({ agent: "Arjun", status: "open", by: "tech-lead", confidence: 0.8, area: "seo", src: "t-100", apStatus: "pending", kind: "github_issue" });
    expect(JSON.parse(String(row!.payload))).toEqual(args.payload);
    const ev = await g.roQuery<{ id: string }>("MATCH (:Entity {id:'recommendation:add-meta-description-to-jobs'})-[:EVIDENCED_BY]->(x) RETURN x.id AS id ORDER BY id");
    expect(ev.map((e) => e.id)).toEqual(["page:www.aamdani.ai/jobs", "rule:seo-meta-description"]);
    expect(ids(r.nodes)).toEqual(expect.arrayContaining(["recommendation:add-meta-description-to-jobs", "approval:t-100-1", "agent:allevia-tech-lead", "page:www.aamdani.ai/jobs"]));
    expect(r.edges.map((e: { type: string }) => e.type).sort()).toEqual(["EVIDENCED_BY", "EVIDENCED_BY", "PRODUCED", "PROPOSES"]);
    expect(ids(r.sources)).toContain("document:gsc-oct");
    // the owner's next recall sees it
    const later = await call(recall, { ids: ["page:www.aamdani.ai/jobs"] }, makeCtx(g));
    expect(later.data.pendingApprovals.map((a: { id: string }) => a.id)).toContain("approval:t-100-1");
  });

  it("re-proposing while the card is still pending adds evidence instead of a second card", async () => {
    const r = await call(proposeAction, { ...args, evidence: ["query:jobs-in-raipur"] }, makeCtx(g, { agentId: "tech-lead", turnId: "t-200" }));
    expect(r.data).toMatchObject({ approvalId: "approval:t-100-1", alreadyPending: true });
    expect(r.note).toMatch(/Already proposed/);
    expect((await g.roQuery<{ c: number }>("MATCH (:Entity {id:'recommendation:add-meta-description-to-jobs'})-[:PROPOSES]->(a) RETURN count(a) AS c"))[0]!.c).toBe(1);
    const ev = await g.roQuery<{ id: string }>("MATCH (:Entity {id:'recommendation:add-meta-description-to-jobs'})-[:EVIDENCED_BY]->(x) RETURN x.id AS id ORDER BY id");
    expect(ev.map((e) => e.id)).toContain("query:jobs-in-raipur");
  });

  it("parallel proposals get distinct approval ids; no valid evidence is refused", async () => {
    const ctx = () => makeCtx(g, { agentId: "growth-marketer" });
    const [a, b] = await Promise.all([
      call(proposeAction, { ...args, title: "Pause the employers campaign", kind: "pause_ad", evidence: ["campaign:meta-employers"] }, ctx()),
      call(proposeAction, { ...args, title: "Shift budget to seekers", kind: "pause_ad", evidence: ["campaign:meta-seekers"] }, ctx()),
    ]);
    expect([a.data.approvalId, b.data.approvalId].sort()).toEqual(["approval:t-100-2", "approval:t-100-3"]);
    expect(ids(a.nodes)).toContain("agent:allevia-growth-marketer");
    const none = await call(proposeAction, { ...args, evidence: ["nope:1"] }, ctx());
    expect(none.data.error).toMatch(/None of the evidence ids exist/);
  });

  // Content trial 2026-10-15: Aamdani's week-of-reels card held {items, fixes, script: "Not yet written"} and no body, so the
  // approved draft was an empty file counted as a first-pass approval.
  it("a content_draft card must carry the text to post in payload.body, whole, not a plan or a to-do list", async () => {
    const ctx = () => makeCtx(g, { agentId: "content-strategist", turnId: "t-300" });
    const base = { title: "Reel plan 16-22 Oct", why: "A week of reels in the best pattern.", kind: "content_draft", evidence: ["page:www.aamdani.ai/jobs"] };
    for (const payload of [{}, { title: "Reel plan", items: ["Fri: hook"], script: "Not yet written" }, { title: "Reel plan", body: "   " }, { title: "Reel plan", body: "tbd" }]) {
      const r = await call(proposeAction, { ...base, payload }, ctx());
      expect(r.data.error).toMatch(/payload\.body/);
    }
    expect((await g.roQuery<{ c: number }>("MATCH (r:Recommendation {id:'recommendation:reel-plan-16-22-oct'}) RETURN count(r) AS c"))[0]!.c).toBe(0);
    const ok = await call(proposeAction, { ...base, payload: { title: "Reel plan", body: "Fri: Applied, then silence? Caption: Aapki arzi, aapka jawab.\n\nScript 0-3s: the hook line." } }, ctx());
    expect(ok.data).toMatchObject({ kind: "content_draft", status: "pending" });
  });
});
