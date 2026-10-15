import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { upsertNode } from "../../src/graph/upsert.js";
import { goalStatus, writeBrief, type Brief } from "../../src/insights/brief.js";
import { ownerJargon } from "../../src/agent/style.js";
import { insightApprovalId, runInsights } from "../../src/insights/recommend.js";
import { decideApproval } from "../../src/actions/approvals.js";
import { D, seedInsights, SEED_NOW } from "../fixtures/insights-graph.js";
import { testGraph } from "../helpers/graph.js";
import { whenFree } from "../helpers/tools.js";

let g: GraphHandle;
let cleanup: () => Promise<void>;
let brief: Brief;
const published: Brief[] = [];

beforeAll(async () => {
  ({ g, cleanup } = await whenFree(async () => {
    const t = await testGraph();
    try {
      await seedInsights(t.g);
    } catch (e) {
      await t.cleanup().catch(() => undefined);
      throw e;
    }
    return t;
  }));
  await runInsights("test", { graph: g, now: SEED_NOW - 3_600_000 });
  await upsertNode(g, { type: "Rule", id: "rule:learned-say-home-not-villa", name: 'Say "home", not "villa".',
    props: { kind: "learned", text: 'Say "home", not "villa".', op: "replace", find: "villa", replace: "home", status: "active", confidence: 0.6, appliedCount: 0 } }, SEED_NOW - 600_000);
  brief = await writeBrief("test", { graph: g, now: SEED_NOW, since: D("2026-10-04"), publish: async (b) => { published.push(b); return "discord:test"; } });
});
afterAll(async () => {
  await cleanup?.();
  await closeAll();
});

const count = async (q: string, p: Record<string, unknown> = {}) => (await g.roQuery<{ c: number }>(q, p))[0]?.c ?? 0;

describe("goal pulse", () => {
  it("rates each goal against baseline, target and the time gone", () => {
    expect(goalStatus({ current: 14, baseline: 5, target: 20, elapsed: 0.13 })).toEqual({ status: "on_track", progress: 0.6 });
    expect(goalStatus({ current: 1400, baseline: 1000, target: 5000, elapsed: 0.33 }).status).toBe("at_risk");
    expect(goalStatus({ current: 900, baseline: 1000, target: 5000, elapsed: 0.33 }).status).toBe("off_track");
    expect(goalStatus({ current: 21, baseline: 5, target: 20, elapsed: 0.5 }).status).toBe("achieved");
    expect(goalStatus({ current: 4, baseline: 10, target: 2, elapsed: 0.5 })).toMatchObject({ status: "on_track", progress: 0.75 }); // a goal to go down
    expect(goalStatus({ current: null, baseline: 5, target: 20, elapsed: 0.5 }).status).toBe("no_data");
  });

  it("reads the current value, the Day-0 baseline (prop or baseline Observation) and writes a changed status back", async () => {
    const [signups, followers] = brief.goals;
    expect(signups).toMatchObject({ id: "goal:signups-per-day", current: 14, baseline: 5, target: 20, status: "on_track", progress: 0.6 });
    expect(followers).toMatchObject({ id: "goal:instagram-followers", current: 1400, baseline: 1000, target: 5000, status: "at_risk", progress: 0.1 });
    expect(await count("MATCH (gl:Goal {id:'goal:instagram-followers'})-[:HAD_VERSION]->(v) WHERE gl.status = 'at_risk' RETURN count(v) AS c")).toBe(1);
    expect(await count("MATCH (gl:Goal {id:'goal:signups-per-day'})-[:HAD_VERSION]->(v) RETURN count(v) AS c")).toBe(0);
  });
});

describe("writeBrief", () => {
  it("is plain text in the right order: goals, what changed, what we noticed, waiting for your OK, next step", () => {
    const t = brief.text;
    const at = (s: string) => t.indexOf(s);
    expect(t.startsWith("Today's note, Aamdani, 15 Oct 2026\n")).toBe(true);
    expect(at("Your goals")).toBeLessThan(at("What changed since 4 Oct"));
    expect(at("What changed since 4 Oct")).toBeLessThan(at("What we noticed"));
    expect(at("What we noticed")).toBeLessThan(at("Waiting for your OK"));
    expect(at("Waiting for your OK")).toBeLessThan(at("Next step"));
    expect(t).toContain("- Signups a day: 14 now, you started at 5. Goal: 20 by 13 Jan. Going well. [[goal:signups-per-day]]");
    expect(t).toContain("- Instagram followers: 1,400 now, you started at 1,000. Goal: 5,000 by 31 Dec. Needs a push: 10% of the way there, 33% of the time used. [[goal:instagram-followers]]");
    expect(t).toContain('- Your team learned: Say "home", not "villa". [[rule:learned-say-home-not-villa]]');
    expect(t).toContain("- Changed: Ankit no longer owns Fix Instagram token refresh.");
    expect(t.split("\n").filter((l) => /^\d\. /.test(l))).toHaveLength(3);
    expect(t).not.toMatch(/[\p{Extended_Pictographic}]/u);
  });

  it("uses the owner's plain words: none of the machinery's terms, and no On call section when nothing is open", () => {
    expect(ownerJargon(brief.text)).toEqual([]);
    expect(brief.text).not.toMatch(/\bOn call\b/);
    expect(brief.text).not.toMatch(/\btarget\b/i);
    expect(brief.text).toContain("things are waiting for your OK");
  });

  it("counts what changed since the last brief, with the biggest moves", () => {
    expect(brief.newObservations).toBeGreaterThan(0);
    expect(brief.closed.count).toBeGreaterThanOrEqual(1);
    expect(brief.learned).toEqual([{ id: "rule:learned-say-home-not-villa", text: 'Say "home", not "villa".' }]);
    expect(brief.changes.length).toBeLessThanOrEqual(2);
    expect(brief.changes[0]).toMatchObject({ metric: "views", subject: "content:reel-salary-reveal", from: 30000, to: 48000 });
    expect(brief.text).toContain("- Views, Salary reveal: what a Raipur delivery job pays: 30,000 -> 48,000 (+60%).");
    expect(brief.text).toMatch(/- \d+ new numbers? came in/);
  });

  it("lists the top 3 open recommendations by score and the approvals waiting, and picks one next action", () => {
    const scores = brief.top.map((r) => r.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(brief.pending.count).toBeGreaterThanOrEqual(10);
    expect(brief.pending.cards).toHaveLength(3);
    expect(brief.next).toMatch(/^Say OK or edit: .+\. \[\[approval:/);
    expect(brief.next).toContain(brief.pending.cards[0]!.id);
  });

  it("is saved as Document{kind:'brief'} PRODUCED by the Chief of Staff, MENTIONS what it summarises, and published", async () => {
    expect(brief.id).toBe("document:brief-test-2026-10-15");
    const [d] = await g.roQuery<{ kind: string; text: string; by: string }>(
      "MATCH (a:Agent)-[:PRODUCED]->(d:Document {id:$id}) RETURN d.kind AS kind, d.text AS text, a.id AS by", { id: brief.id });
    expect(d).toEqual({ kind: "brief", text: brief.text, by: "agent:allevia-chief-of-staff" });
    const mentioned = (await g.roQuery<{ id: string }>("MATCH (:Document {id:$id})-[m:MENTIONS]->(x) WHERE m.until IS NULL RETURN x.id AS id", { id: brief.id })).map((r) => r.id);
    expect(mentioned).toEqual(expect.arrayContaining(["business:aamdani", "goal:signups-per-day", "rule:learned-say-home-not-villa", brief.top[0]!.id, brief.pending.cards[0]!.id]));
    expect(published).toHaveLength(1);
    expect(brief.published).toBe("discord:test");
  });

  it("re-written the same day: one Document, updated in place; since defaults to the previous brief", async () => {
    const again = await writeBrief("test", { graph: g, now: SEED_NOW + 60_000 });
    expect(again.id).toBe(brief.id);
    expect(await count("MATCH (d:Document) WHERE d.kind = 'brief' RETURN count(d) AS c")).toBe(1);
    const tomorrow = await writeBrief("test", { graph: g, now: SEED_NOW + 86_400_000 });
    expect(tomorrow.since).toBe(SEED_NOW + 60_000);
    expect(tomorrow.text).toContain("What changed since yesterday");
    expect(await count("MATCH (d:Document) WHERE d.kind = 'brief' RETURN count(d) AS c")).toBe(2);
  });

  it("reports the learning KPI once the owner has decided something", async () => {
    expect(brief.text).not.toContain("Drafts you approved as they were");
    await decideApproval(g, { approvalId: insightApprovalId("ads.high_cpa:campaign:meta-employers"), decision: "approve", now: SEED_NOW + 90_000 }, { tenant: "test" });
    const b = await writeBrief("test", { graph: g, now: SEED_NOW + 100_000 });
    expect(b.text).toContain("- Drafts you approved as they were: 1 of 1 in the last 30 days (100%). Things your team learned from your edits: 1.");
    expect(ownerJargon(b.text)).toEqual([]);
    expect(b.learning).toMatchObject({ firstPassRate: 1, decided30d: 1 });
  });

  it("an optional model may tighten the text but not change a figure", async () => {
    const ok = await writeBrief("test", { graph: g, now: SEED_NOW + 120_000, llm: true, runner: { structured: async (i) => ({ text: i.prompt.replace("Waiting for your OK", "For you") }) } });
    expect(ok.polished).toBe(true);
    expect(ok.text).toContain("For you");
    const bad = await writeBrief("test", { graph: g, now: SEED_NOW + 180_000, llm: true, runner: { structured: async (i) => ({ text: i.prompt.replace("14 now", "41 now") }) } });
    expect(bad.polished).toBe(false);
    expect(bad.text).toContain("Signups a day: 14 now");
  });
});
