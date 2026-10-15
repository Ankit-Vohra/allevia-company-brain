import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GraphHandle } from "../../src/graph/client.js";
import { ApprovalNotFound, decideApproval, getApproval, listApprovals, makeOnDecision, type DecideDeps } from "../../src/actions/approvals.js";
import type { GhRunner } from "../../src/actions/executors.js";
import type { Candidate } from "../../src/insights/detectors.js";
import { writeRecommendation } from "../../src/insights/recommend.js";
import { SEED_NOW } from "../fixtures/seed-graph.js";
import { seededGraph } from "../helpers/tools.js";

let g: GraphHandle;
let cleanup: () => Promise<void>;
let dataDir: string;
let issues = 0;
const ghCalls: string[][] = [];
const gh: GhRunner = async (args) => {
  ghCalls.push(args);
  return `https://github.com/Example-Org/example-repo/issues/${++issues}\n`;
};
const deps = (): DecideDeps => ({ tenant: "test", executors: { gh, config: { githubActionRepo: "Example-Org/example-repo", dataDir, discord: {} } } });
const count = async (q: string, p: Record<string, unknown> = {}) => (await g.roQuery<{ c: number }>(q, p))[0]?.c ?? 0;

let k = 0;
async function issueCard(title = `Fix thing ${k + 1}`): Promise<{ rec: string; approval: string }> {
  const c: Candidate = {
    key: `test:issue-${++k}`, detector: "seo.high_severity_fails", area: "seo", agent: "tech-lead", title, why: "Synthetic.",
    evidence: ["page:www.aamdani.ai/jobs"], numbers: { failing: 1 }, score: 0.5, confidence: 0.8,
    suggestedAction: { kind: "github_issue", payload: { title, body: "- [ ] Add a meta description", targetId: "page:www.aamdani.ai/jobs" } },
  };
  const r = await writeRecommendation(g, c, { now: SEED_NOW });
  return { rec: r.id, approval: r.approvalId! };
}

beforeAll(async () => {
  ({ g, cleanup } = await seededGraph());
  dataDir = mkdtempSync(join(tmpdir(), "allevia-approvals-"));
});
afterAll(async () => {
  await cleanup?.();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("decideApproval", () => {
  it("approve with no edit: first pass, timing, a Version per status change, the executor's Action", async () => {
    const { rec, approval } = await issueCard("SEO: fix /jobs");
    const now = SEED_NOW + 90_000;
    const r = await decideApproval(g, { approvalId: approval, decision: "approve", now }, deps());
    expect(r.alreadyDecided).toBeUndefined();
    expect(r.approval).toMatchObject({
      status: "executed", decision: "approve", firstPass: true, decisionMs: 90_000, editDistance: 0, by: "tech-lead", recommendationId: rec,
      result: "https://github.com/Example-Org/example-repo/issues/1",
    });
    expect(r.action).toMatchObject({ kind: "github_issue", status: "done", affects: ["page:www.aamdani.ai/jobs"] });
    // pending -> approved -> executed: two Versions, oldest first
    const versions = await g.roQuery<{ s: string }>(
      "MATCH (:Approval {id:$id})-[:HAD_VERSION]->(v:Version) RETURN v.props AS s ORDER BY v.since, v.until, id(v)", { id: approval });
    expect(versions.map((v) => JSON.parse(v.s).status)).toEqual(["pending", "approved"]);
    expect(await count("MATCH (:Approval {id:$id})-[:APPROVED_BY]->(:Person {id:'person:founder'}) RETURN count(*) AS c", { id: approval })).toBe(1);
    expect(await count("MATCH (r:Recommendation {id:$id}) WHERE r.status = 'approved' RETURN count(r) AS c", { id: rec })).toBe(1);
    expect(r.metrics).toMatchObject({ firstPassRate: 1, deliverablesApproved: 1 });
  });

  it("is exactly once: a second approve (or a racing one) changes nothing and runs nothing", async () => {
    const { approval } = await issueCard();
    const before = ghCalls.length;
    const [a, b] = await Promise.all([
      decideApproval(g, { approvalId: approval, decision: "approve", now: SEED_NOW + 1000 }, deps()),
      decideApproval(g, { approvalId: approval, decision: "approve", now: SEED_NOW + 1000 }, deps()),
    ]);
    expect([a.alreadyDecided, b.alreadyDecided].filter(Boolean)).toHaveLength(1);
    expect(ghCalls.length).toBe(before + 1);
    const again = await decideApproval(g, { approvalId: approval, decision: "reject", now: SEED_NOW + 5000 }, deps());
    expect(again).toMatchObject({ alreadyDecided: true, approval: { status: "executed" }, action: { status: "done" } });
    expect(ghCalls.length).toBe(before + 1);
    expect(await count("MATCH (:Approval {id:$id})-[:HAD_VERSION]->(v) RETURN count(v) AS c", { id: approval })).toBe(2);
  });

  it("reject: REJECTED_BY, the recommendation is dismissed, nothing runs", async () => {
    const { rec, approval } = await issueCard();
    const before = ghCalls.length;
    const r = await decideApproval(g, { approvalId: approval, decision: "reject", actor: "person:priya", now: SEED_NOW + 2000 }, deps());
    expect(r.action).toBeNull();
    expect(r.approval).toMatchObject({ status: "rejected", decision: "reject", firstPass: false });
    expect(ghCalls.length).toBe(before);
    expect(await count("MATCH (:Approval {id:$id})-[:REJECTED_BY]->(:Person {id:'person:priya'}) RETURN count(*) AS c", { id: approval })).toBe(1);
    expect(await count("MATCH (r:Recommendation {id:$id}) WHERE r.status = 'dismissed' RETURN count(r) AS c", { id: rec })).toBe(1);
  });

  it("approve with an edit: status edited then executed, the edit runs, editDistance recorded, not first pass", async () => {
    const { approval } = await issueCard("SEO: fix the home page title");
    const r = await decideApproval(g, {
      approvalId: approval, decision: "approve", now: SEED_NOW + 3000, editedPayload: { title: "SEO: rewrite the home page title for Raipur jobs" },
    }, deps());
    expect(r.approval).toMatchObject({ status: "executed", firstPass: false, editedPayload: { title: "SEO: rewrite the home page title for Raipur jobs" } });
    expect(r.approval.editDistance).toBeGreaterThan(0);
    expect(ghCalls[ghCalls.length - 1]).toEqual(expect.arrayContaining(["--title", "SEO: rewrite the home page title for Raipur jobs"]));
    const versions = await g.roQuery<{ s: string }>("MATCH (:Approval {id:$id})-[:HAD_VERSION]->(v:Version) RETURN v.props AS s ORDER BY v.since, v.until, id(v)", { id: approval });
    expect(versions.map((v) => JSON.parse(v.s).status)).toEqual(["pending", "edited"]);
  });

  it("handles an agent-proposed card with an empty payload, and an unknown id", async () => {
    const r = await decideApproval(g, { approvalId: "approval:t-001-1", decision: "approve", now: SEED_NOW + 4000 }, deps());
    expect(r.approval.status).toBe("executed");
    expect(r.action).toMatchObject({ kind: "content_draft", status: "done" });
    await expect(decideApproval(g, { approvalId: "approval:nope", decision: "approve" }, deps())).rejects.toBeInstanceOf(ApprovalNotFound);
  });

  it("lists cards in the web app's shape", async () => {
    await issueCard("Pending one");
    const pending = await listApprovals(g, { status: "pending" });
    expect(pending.length).toBeGreaterThanOrEqual(1);
    const v = pending.find((p) => p.title === "Pending one")!;
    expect(v).toMatchObject({ kind: "github_issue", status: "pending", by: "tech-lead", payload: { title: "Pending one", body: expect.any(String) } });
    expect(v.createdAt).toBe(new Date(SEED_NOW).toISOString());
    expect(await getApproval(g, "approval:nope")).toBeNull();
  });
});

describe("onDecision (the API server's hook)", () => {
  it("takes (tenant, {id, decision, editedPayload}) or a status, opens the tenant's graph", async () => {
    const opened: string[] = [];
    const hook = makeOnDecision({ open: async (t) => { opened.push(t); return g; }, now: () => SEED_NOW + 6000, executors: deps().executors });
    const { approval } = await issueCard();
    const r = await hook("aamdani", { id: approval, decision: "approve" });
    expect(opened).toEqual(["aamdani"]);
    expect(r.approval.status).toBe("executed");
    const second = await issueCard();
    expect((await hook("aamdani", { id: second.approval, status: "rejected" })).approval.status).toBe("rejected");
    await expect(hook("aamdani", { id: second.approval })).rejects.toThrow(/no decision/);
  });
});
