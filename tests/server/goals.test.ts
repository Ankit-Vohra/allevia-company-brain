// "Your team suggests these goals": GET /api/:t/goals/setup lists the program's goals with whether the owner has said
// OK yet, and POST /api/:t/goals/:id confirms one (optionally with the owner's own number). It writes the Goal's
// target through the same upsert the day-0 baseline uses, so the scorecard's progress follows the new number.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ProgramScorecard } from "../../shared/contracts.js";
import { ensureAgentNode } from "../../src/actions/shared.js";
import { templateFor } from "../../src/onboard/templates.js";
import { baselinesWrite, programAndGoalsWrite, programGoals } from "../../src/program/program.js";
import { writeBatch } from "../../src/graph/upsert.js";
import type { GoalSetupDto } from "../../src/server/routes/goals.js";
import { SEED_NOW } from "../fixtures/seed-graph.js";
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
