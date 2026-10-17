// "Your team suggests these goals": GET /api/:t/goals/setup lists the program's goals with whether the owner has said
// OK yet, and POST /api/:t/goals/:id confirms one (optionally with the owner's own number). It writes the Goal's
// target through the same upsert the day-0 baseline uses, so the scorecard's progress follows the new number.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ProgramScorecard } from "../../shared/contracts.js";
import { ensureAgentNode } from "../../src/actions/shared.js";
import { templateFor } from "../../src/onboard/templates.js";
import { baselinesWrite, programAndGoalsWrite, programGoals } from "../../src/program/program.js";
import { writeBatch } from "../../src/graph/upsert.js";
import { traceDecision } from "../../src/agent/tools/decisions.js";
import type { GoalSetupDto } from "../../src/server/routes/goals.js";
import { SEED_NOW } from "../fixtures/seed-graph.js";
import { call, makeCtx } from "../helpers/tools.js";
import { harness, post, TENANT, type Harness } from "./harness.js";

const NOW = SEED_NOW + 3_600_000; // the harness clock
const today = new Date(NOW).toISOString().slice(0, 10);

describe("server: goal setup (integration)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  }, 90_000);
  afterAll(async () => h.cleanup());

  const setup = async (app = h.app) => {
    const res = await app.request("/api/mini/goals/setup");
    expect(res.status, await res.clone().text()).toBe(200);
    return res.json() as Promise<{ goals: GoalSetupDto[] }>;
  };

  it("is an empty list until the business is enrolled", async () => {
    expect(await setup()).toEqual({ goals: [] });
  });

  it("lists the suggested goals unconfirmed; OK confirms one; an edit changes its target and the scorecard follows", async () => {
    for (const o of ["growth-marketer", "content-strategist", "data-analyst"]) await ensureAgentNode(h.g, o, NOW);
    const p = await programAndGoalsWrite(h.g, { slug: "mini", businessId: TENANT.businessId, businessName: "Aamdani", template: templateFor("jobs"), now: NOW, startDate: today, timeZone: "Asia/Kolkata" });
    expect((await writeBatch(h.g, p.write, NOW)).errors).toEqual([]);
    const b = await baselinesWrite(h.g, { goals: await programGoals(h.g, p.program), businessId: TENANT.businessId, today });
    expect((await writeBatch(h.g, b.write, NOW)).errors).toEqual([]);

    const first = (await setup()).goals;
    expect(first.map((g) => g.name)).toEqual(["Weekly signups", "Instagram reach", "Search clicks"]);
    expect(first.every((g) => g.confirmed === false && typeof g.target === "number" && g.period)).toBe(true);

    // OK as suggested: the target stays
    const ok = await post(h.app, `/api/mini/goals/${encodeURIComponent(first[0]!.id)}`, { confirm: true });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await ok.json()).toMatchObject({ id: first[0]!.id, confirmed: true, target: first[0]!.target });

    // an edit: the owner's number replaces the suggestion (and counts as OK)
    const edited = await post(h.app, `/api/mini/goals/${encodeURIComponent(first[1]!.id)}`, { target: 2500 });
    expect(await edited.json()).toMatchObject({ id: first[1]!.id, confirmed: true, target: 2500 });

    const after = (await setup()).goals;
    expect(after.map((g) => g.confirmed)).toEqual([true, true, false]);
    expect(after[1]!.target).toBe(2500);
    const card = await (await h.app.request("/api/mini/program")).json() as ProgramScorecard;
    expect(card.goals.find((g) => g.id === first[1]!.id)!.target).toBe(2500);

    // confirming again changes nothing
    expect((await post(h.app, `/api/mini/goals/${encodeURIComponent(first[0]!.id)}`, { confirm: true })).status).toBe(200);
    expect((await setup()).goals.map((g) => g.confirmed)).toEqual([true, true, false]);
  });

  it("the owner's number is a decision: DECIDED by the owner, AFFECTing the goal, BASED_ON where they started; the goal's update names it as its source", async () => {
    const goals = (await setup()).goals;
    const [signups, reach] = goals;
    // the edit of the second goal (to 2500) and the OK of the first, from the test above
    const decisions = await h.g.roQuery<{ id: string; goal: string; target: number; prev: number | null; chose: string; by: string; kind: string; status: string; src: string; owner: string }>(
      `MATCH (p:Person)-[d:DECIDED]->(x:Decision)-[a:AFFECTS]->(gl:Goal) WHERE d.until IS NULL AND a.until IS NULL AND x.kind = 'goal_target'
       RETURN x.id AS id, gl.id AS goal, x.target AS target, x.previousTarget AS prev, x.chose AS chose, x.by AS by, x.kind AS kind, x.status AS status, x.src AS src, p.id AS owner ORDER BY goal, id`);
    const mine = (id: string) => decisions.find((d) => d.goal === id)!;
    expect(decisions).toHaveLength(2);
    expect(mine(signups!.id)).toMatchObject({ target: signups!.target, chose: "the suggestion", status: "accepted" });
    expect(mine(reach!.id)).toMatchObject({ target: 2500, chose: "own number", status: "accepted" });
    for (const d of decisions) expect(d).toMatchObject({ owner: d.by, kind: "goal_target", src: d.by });
    // saying OK again, or the same number again, wrote nothing more
    expect((await post(h.app, `/api/mini/goals/${encodeURIComponent(signups!.id)}`, { confirm: true })).status).toBe(200);
    expect((await post(h.app, `/api/mini/goals/${encodeURIComponent(reach!.id)}`, { target: 2500 })).status).toBe(200);
    const [count] = await h.g.roQuery<{ n: number }>("MATCH (x:Decision) WHERE x.kind = 'goal_target' RETURN count(x) AS n");
    expect(count!.n).toBe(2);

    // the Goal's update carries the decision as its source and the time as its date; the number before is a Version with where it came from
    const [goal] = await h.g.roQuery<{ src: string; asOf: string; target: number }>("MATCH (gl:Goal {id:$id}) RETURN gl.src AS src, gl.asOf AS asOf, gl.target AS target", { id: reach!.id });
    expect(goal).toMatchObject({ src: mine(reach!.id).id, asOf: new Date(NOW).toISOString(), target: 2500 });
    const was = await h.g.roQuery<{ props: string; src: string }>(
      "MATCH (gl:Entity {id:$id})-[h:HAD_VERSION]->(v:Version) WHERE 'target' IN v.changed RETURN v.props AS props, v.src AS src ORDER BY v.until, v.id", { id: reach!.id });
    expect(was).toHaveLength(1);
    expect(typeof mine(reach!.id).prev).toBe("number");
    expect(JSON.parse(was[0]!.props)).toMatchObject({ target: mine(reach!.id).prev });

    // where they started: the decision is BASED_ON the baseline reading, when the goal has one
    const based = await h.g.roQuery<{ goal: string; obs: string }>(
      "MATCH (x:Decision)-[b:BASED_ON]->(o:Observation) WHERE b.until IS NULL AND x.kind = 'goal_target' RETURN x.goal AS goal, o.id AS obs ORDER BY goal, obs");
    for (const gl of goals) {
      const has = based.filter((b) => b.goal === gl.id);
      expect(has.length, gl.id).toBe(gl.baseline === null ? 0 : 1);
    }
  });

  it("trace_decision answers 'why is the target 2,500': the decision, who made it, what it affects, and what it replaced", async () => {
    const reach = (await setup()).goals[1]!;
    const ctx = makeCtx(h.g, { tenant: "mini", now: NOW + 60_000 });
    const first = await call(traceDecision, { id: reach.id }, ctx);
    expect(first.data.decision).toMatchObject({ status: "accepted" });
    expect(first.data.decision.name).toMatch(/^Target for "Instagram reach": 2,500 accounts a month$/);
    expect(first.data.decision.summary).toMatch(/^You set the target for "Instagram reach" to 2,500 accounts a month, instead of the [\d,]+ your team suggested\./);
    expect(first.data.decidedBy.map((p: { id: string }) => p.id)).toHaveLength(1);
    expect(first.data.affects.map((x: { id: string }) => x.id)).toEqual([reach.id]);
    expect(first.data.current).toBe(true);
    expect(first.note).toMatch(/is not a Decision; traced decision:target-/);

    // a second change, later: the new decision replaces the first, which is kept as superseded
    const later = h.make({ now: () => NOW + 86_400_000 });
    const res = await post(later, `/api/mini/goals/${encodeURIComponent(reach.id)}`, { target: 3000 });
    expect(await res.json()).toMatchObject({ target: 3000, decisionId: expect.stringMatching(/^decision:target-/) });
    const second = await call(traceDecision, { id: reach.id }, ctx);
    expect(second.data.decision.name).toMatch(/: 3,000 accounts a month$/);
    expect(second.data.supersedes).toHaveLength(1);
    expect(second.data.supersedes[0]).toMatchObject({ id: first.data.decision.id, status: "superseded" });
    expect(second.data.current).toBe(true);
    const old = await call(traceDecision, { id: first.data.decision.id }, ctx);
    expect(old.data.current).toBe(false);
    expect(old.note).toMatch(/Superseded by /);
  });

  it("refuses a missing or bad body, a goal that is not this business's, and public mode", async () => {
    const id = encodeURIComponent((await setup()).goals[2]!.id);
    expect((await post(h.app, `/api/mini/goals/${id}`, {})).status).toBe(400);
    for (const target of [0, -5, "lots", 1e12]) expect((await post(h.app, `/api/mini/goals/${id}`, { target })).status).toBe(400);
    expect((await post(h.app, "/api/mini/goals/goal%3Anope", { confirm: true })).status).toBe(404);
    expect((await post(h.app, "/api/nope/goals/x", { confirm: true })).status).toBe(404);
    expect((await post(h.make({ publicMode: true }), `/api/mini/goals/${id}`, { confirm: true })).status).toBe(403);
    expect((await setup()).goals[2]!.confirmed).toBe(false);
  });
});
