// The credit ledger (src/credits): the arithmetic on its own (buckets, the order credits are used in, what carries into the
// next month), then the service over a throwaway graph on the test database (6391) with a throwaway registry: the lazy
// monthly grant, spends once per (service, ref), rollover at most one month's allowance for one month, packs that do not
// run out, the trial and its end, holds that keep two answers from spending the last credit, and the FOR edge.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CREDIT_PRICES } from "../../shared/plans.js";
import { outOfCreditsSentence } from "../../shared/credits.js";
import { putSubscription } from "../../src/billing/subscription.js";
import { Credits, OutOfCredits } from "../../src/credits/index.js";
import { carryOver, monthOf, monthState, monthsAfter, neededFor, nextMonth, prevMonth, totals, type EntryRow } from "../../src/credits/ledger.js";
import { closeAll, openGraphByName, type GraphHandle } from "../../src/graph/client.js";
import { upsertNode } from "../../src/graph/upsert.js";
import { testGraphName } from "../helpers/graph.js";

const row = (service: string, credits: number, at = 0, key = `${service}:${credits}:${at}`): EntryRow => ({ key, service, credits, at });

describe("the arithmetic", () => {
  it("puts each entry in its bucket and adds up what was used", () => {
    const t = totals([row("plan", 800), row("rollover", 120), row("pack", 100), row("pack_carry", 50), row("grant", 5), row("trial", 100), row("owed", -4),
      row("question_quick", -1), row("question_deep", -5), row("picture", -5)]);
    expect(t).toEqual({ plan: 800, rollover: 120, trial: 100, packs: 155, owed: 4, used: 11, usedBeforeTrialEnd: 11 });
  });

  it("uses rollover first, then the trial, then the plan, then packs; what is left is all of it less what was used", () => {
    const s = monthState(totals([row("plan", 300), row("rollover", 50), row("pack", 100), row("question_deep", -5), row("picture", -60)]));
    expect(s.left).toBe(300 + 50 + 100 - 65);
    expect(s.remaining).toEqual({ rollover: 0, trial: 0, plan: 285, packs: 100, over: 0 });
    const over = monthState(totals([row("plan", 20), row("pack", 10), row("video_short", -40)]));
    expect(over.left).toBe(-10);
    expect(over.remaining).toEqual({ rollover: 0, trial: 0, plan: 0, packs: 0, over: 10 });
  });

  it("takes the trial's unused credits away when it ends, keeping what was used of them before", () => {
    const end = 1_000;
    const rows = [row("plan", 0), row("trial", 100), row("question_quick", -1, 10), row("question_deep", -5, 20), row("picture", -5, 2_000)];
    expect(monthState(totals(rows, end)).left).toBe(89);
    const ended = monthState(totals(rows, end), { trialEnded: true });
    expect(ended.trial).toBe(6); // used before it ended
    expect(ended.left).toBe(-5); // the picture after the end had nothing to come from
  });

  it("carries unused plan credits (capped at next month's allowance, never a rollover again), packs, a running trial and what went over", () => {
    const s = monthState(totals([row("plan", 800), row("rollover", 300), row("pack", 100), row("question_deep", -5)]));
    // 5 used come out of the rollover, so all 800 plan credits are unused
    expect(carryOver(s, { nextAllowance: 800, trialRuns: false })).toEqual({ rollover: 800, packs: 100, trial: 0, owed: 0 });
    expect(carryOver(s, { nextAllowance: 300, trialRuns: false }).rollover).toBe(300);
    expect(carryOver(s, { nextAllowance: 800, trialRuns: false, gap: true }).rollover).toBe(0);
    const t = monthState(totals([row("plan", 0), row("trial", 100), row("question_quick", -1)]));
    expect(carryOver(t, { nextAllowance: 0, trialRuns: true })).toEqual({ rollover: 0, packs: 0, trial: 99, owed: 0 });
    expect(carryOver(t, { nextAllowance: 0, trialRuns: false }).trial).toBe(0);
    const over = monthState(totals([row("plan", 1), row("video_short", -40)]));
    expect(carryOver(over, { nextAllowance: 300, trialRuns: false }).owed).toBe(39);
  });

  it("knows its months and what a check needs", () => {
    expect(monthOf(Date.UTC(2026, 9, 31, 23, 59))).toBe("2026-10");
    expect(nextMonth("2026-12")).toBe("2027-01");
    expect(prevMonth("2027-01")).toBe("2026-12");
    expect(monthsAfter("2026-10", "2027-01")).toEqual(["2026-11", "2026-12", "2027-01"]);
    expect(neededFor("website_checkup")).toBe(10);     // charged when it runs: the whole price
    expect(neededFor("question_deep")).toBe(1);        // charged when the answer arrives: one credit to start
    expect(neededFor("picture")).toBe(1);
    expect(neededFor("todays_note")).toBe(0);
  });
});

describe("the credits service (test database)", () => {
  const metaGraph = testGraphName();
  const tenantOpts = { metaGraph };
  const graphs: GraphHandle[] = [];
  let clock = Date.UTC(2026, 9, 17, 9, 0);
  const at = (ms: number) => { clock = ms; };

  const setup = async (slug: string) => {
    const g = await openGraphByName(testGraphName());
    graphs.push(g);
    const c = new Credits({ openGraph: async () => g, tenantOpts, now: () => clock, log: () => {} });
    return { g, c, slug };
  };
  const count = async (g: GraphHandle) => (await g.roQuery<{ n: number }>("MATCH (e:CreditEntry) RETURN count(e) AS n").catch(() => [{ n: 0 }]))[0]?.n ?? 0;

  beforeAll(() => { at(Date.UTC(2026, 9, 17, 9, 0)); });
  afterAll(async () => {
    for (const g of graphs) await g.drop().catch(() => undefined);
    await (await openGraphByName(metaGraph)).drop().catch(() => undefined);
    await closeAll();
  });

  it("starts a business with no subscription on Growth, granted lazily on the first read; a read-only read writes nothing", async () => {
    at(Date.UTC(2026, 9, 17, 9, 0));
    const { g, c } = await setup("cr_default");
    const ro = await c.balance("cr_default", { readOnly: true });
    expect(ro).toMatchObject({ month: "2026-10", plan: "growth", status: "active", allowance: 800, used: 0, left: 800, resetsAt: "2026-11-01T00:00:00.000Z" });
    expect(await count(g)).toBe(0);
    expect((await c.balance("cr_default")).left).toBe(800);
    expect(await count(g)).toBe(1);
    expect((await c.balance("cr_default")).left).toBe(800); // opened once
    expect(await count(g)).toBe(1);
  });

  it("spends once per service and ref, links what it paid for, and says who", async () => {
    at(Date.UTC(2026, 9, 17, 10, 0));
    const { g, c } = await setup("cr_spend");
    await upsertNode(g, { type: "Turn", id: "turn:cr-1", name: "Why did enquiries drop?", props: { question: "q", at: clock } }, clock);
    expect(await c.spend("cr_spend", "question_deep", { ref: "turn:cr-1", by: "owner", for: ["turn:cr-1"] })).toMatchObject({ charged: 5 });
    expect(await c.spend("cr_spend", "question_deep", { ref: "turn:cr-1", by: "owner" })).toMatchObject({ charged: 0, duplicate: true });
    expect(await c.spend("cr_spend", "question_quick", { ref: "turn:cr-2", by: "user:asha" })).toMatchObject({ charged: 1 });
    expect(await c.spend("cr_spend", "todays_note", { ref: "x" })).toEqual({ charged: 0 }); // free: nothing written
    const b = await c.balance("cr_spend");
    expect(b).toMatchObject({ used: 6, left: 794 });
    const rows = await c.entries("cr_spend", "2026-10");
    const deep = rows.find((r) => r.service === "question_deep")!;
    expect(deep).toMatchObject({ credits: -5, by: "owner", for: { id: "turn:cr-1", name: "Why did enquiries drop?" } });
    expect(rows.find((r) => r.service === "question_quick")?.by).toBe("user:asha");
    expect(rows.filter((r) => r.service === "plan")).toHaveLength(1);
  });

  it("refuses a spend that does not fit with the owner's sentence, unless the work was already checked", async () => {
    at(Date.UTC(2026, 9, 18, 9, 0));
    const { c } = await setup("cr_out");
    await putSubscription({ slug: "cr_out", plan: "pause", cycle: "monthly", status: "paused", startedAt: clock, provider: "test", updatedAt: clock }, tenantOpts);
    expect((await c.balance("cr_out")).left).toBe(20);
    await c.spend("cr_out", "website_checkup", { ref: "run1" });
    await c.spend("cr_out", "website_checkup", { ref: "run2" });
    expect((await c.balance("cr_out")).left).toBe(0);
    const err = await c.spend("cr_out", "picture", { ref: "card1" }).catch((e) => e);
    expect(err).toBeInstanceOf(OutOfCredits);
    expect((err as OutOfCredits).message).toBe(outOfCreditsSentence({ plan: "pause" }));
    expect((err as OutOfCredits).message).toBe("You've used this month's credits. Buy 100 more for $29 or move to Growth.");
    expect((err as OutOfCredits).info).toMatchObject({ left: 0, needed: 1, service: "picture", packId: "pack100", nextPlan: "growth" });
    expect(await c.canSpend("cr_out", "question_quick")).toBe(false);
    expect(await c.canSpend("cr_out", "todays_note")).toBe(true);
    // an approval checked when it started may take it below zero, by that one card
    expect(await c.spend("cr_out", "picture", { ref: "card1", allowNegative: true })).toMatchObject({ charged: 5 });
    expect((await c.balance("cr_out")).left).toBe(-5);
  });

  it("holds the credit an answer needs, so two at once cannot both spend the last one; a failed answer costs nothing", async () => {
    at(Date.UTC(2026, 9, 18, 10, 0));
    const { c } = await setup("cr_lock");
    await putSubscription({ slug: "cr_lock", plan: "pause", cycle: "monthly", status: "paused", startedAt: clock, provider: "test", updatedAt: clock }, tenantOpts);
    for (let i = 0; i < 19; i++) await c.spend("cr_lock", "question_quick", { ref: `t${i}` });
    expect((await c.balance("cr_lock")).left).toBe(1);
    const [a, b] = await Promise.allSettled([c.hold("cr_lock", "question_quick"), c.hold("cr_lock", "question_quick")]);
    const won = [a, b].filter((x) => x.status === "fulfilled");
    const lost = [a, b].filter((x) => x.status === "rejected") as PromiseRejectedResult[];
    expect(won).toHaveLength(1);
    expect(lost[0]!.reason).toBeInstanceOf(OutOfCredits);
    const hold = (won[0] as PromiseFulfilledResult<Awaited<ReturnType<Credits["hold"]>>>).value;
    hold.release(); // the answer failed
    expect((await c.balance("cr_lock")).left).toBe(1);
    const again = await c.hold("cr_lock", "question_quick");
    // it went deep: the answer is charged in full, going below zero by at most this one answer
    expect(await again.commit({ service: "question_deep", ref: "t-deep" })).toMatchObject({ charged: 5 });
    expect((await c.balance("cr_lock")).left).toBe(-4);
    await expect(c.hold("cr_lock", "question_quick")).rejects.toBeInstanceOf(OutOfCredits);
  });

  it("rolls unused plan credits over for one month, at most one month's allowance, and keeps packs; what went over is owed", async () => {
    at(Date.UTC(2026, 9, 20, 9, 0));
    const { c } = await setup("cr_roll");
    await putSubscription({ slug: "cr_roll", plan: "starter", cycle: "monthly", status: "active", startedAt: clock, provider: "test", updatedAt: clock }, tenantOpts);
    await c.grant("cr_roll", 100, "pack", "bill_1");
    expect(await c.grant("cr_roll", 100, "pack", "bill_1")).toEqual({ granted: 0, duplicate: true });
    for (let i = 0; i < 10; i++) await c.spend("cr_roll", "picture", { ref: `oct${i}` }); // 50 of Starter's 300
    expect(await c.balance("cr_roll")).toMatchObject({ allowance: 300, packs: 100, used: 50, left: 350 });

    at(Date.UTC(2026, 10, 2, 9, 0)); // November: 250 unused plan credits roll over, the pack stays
    expect(await c.balance("cr_roll")).toMatchObject({ month: "2026-11", allowance: 300, rollover: 250, packs: 100, used: 0, left: 650 });
    for (let i = 0; i < 4; i++) await c.spend("cr_roll", "video_short", { ref: `nov${i}` }); // 160: rollover first
    expect(await c.balance("cr_roll")).toMatchObject({ used: 160, left: 490 });

    at(Date.UTC(2026, 11, 3, 9, 0)); // December: November's rollover ended (90 of it unused); the 300 plan credits roll over
    expect(await c.balance("cr_roll")).toMatchObject({ month: "2026-12", allowance: 300, rollover: 300, packs: 100, left: 700 });
    for (let i = 0; i < 17; i++) await c.spend("cr_roll", "video_short", { ref: `dec${i}`, allowNegative: true }); // 680
    expect((await c.balance("cr_roll")).left).toBe(20);
    await c.spend("cr_roll", "video_short", { ref: "dec-last", allowNegative: true });
    expect((await c.balance("cr_roll")).left).toBe(-20);

    at(Date.UTC(2027, 1, 1, 9, 0)); // February, with a quiet January between: owed 20 in January, January's plan rolls into February
    expect(await c.balance("cr_roll")).toMatchObject({ month: "2027-02", allowance: 300, rollover: 280, packs: 0, owed: 0, left: 580 });
    const jan = await c.entries("cr_roll", "2027-01");
    expect(jan.map((e) => [e.service, e.credits])).toEqual(expect.arrayContaining([["plan", 300], ["owed", -20]]));
  });

  it("starts the 14-day trial from a grant (taking back a default month opened before it), and ends it", async () => {
    at(Date.UTC(2026, 9, 18, 12, 0));
    const { c } = await setup("cr_trial");
    expect((await c.balance("cr_trial")).left).toBe(800); // read during set-up, before the trial started
    expect(await c.grant("cr_trial", 100, "trial", "user:new")).toEqual({ granted: 100 });
    expect(await c.grant("cr_trial", 100, "trial", "user:new")).toEqual({ granted: 0, duplicate: true });
    const b = await c.balance("cr_trial");
    expect(b).toMatchObject({ plan: null, status: "trial", allowance: 0, trial: 100, left: 100, trialEndsAt: new Date(Date.UTC(2026, 10, 1, 12, 0)).toISOString() });
    await c.spend("cr_trial", "question_deep", { ref: "t1" });
    expect((await c.balance("cr_trial")).left).toBe(95);

    at(Date.UTC(2026, 9, 30, 12, 0)); // still on: what is unused carries into November until the trial ends
    at(Date.UTC(2026, 10, 1, 9, 0));
    expect(await c.balance("cr_trial")).toMatchObject({ month: "2026-11", trial: 95, left: 95, status: "trial" });
    at(Date.UTC(2026, 10, 1, 13, 0)); // the trial has ended
    const done = await c.balance("cr_trial");
    expect(done.left).toBe(0);
    const err = await c.hold("cr_trial", "question_quick").catch((e) => e);
    expect(err).toBeInstanceOf(OutOfCredits);
    expect((err as OutOfCredits).message).toBe("You've used your trial credits. Buy 100 more for $29 or move to Growth.");
  });

  it("tops this month's plan credits up after an upgrade, never down", async () => {
    at(Date.UTC(2026, 9, 21, 9, 0));
    const { c } = await setup("cr_up");
    await putSubscription({ slug: "cr_up", plan: "starter", cycle: "monthly", status: "active", startedAt: clock, provider: "test", updatedAt: clock }, tenantOpts);
    expect((await c.balance("cr_up")).allowance).toBe(300);
    await putSubscription({ slug: "cr_up", plan: "pro", cycle: "yearly", status: "active", startedAt: clock, provider: "test", updatedAt: clock }, tenantOpts);
    expect(await c.topUpPlan("cr_up", "bill_up")).toBe(1700);
    expect(await c.topUpPlan("cr_up", "bill_up")).toBe(0);
    expect((await c.balance("cr_up")).allowance).toBe(2000);
    await putSubscription({ slug: "cr_up", plan: "starter", cycle: "monthly", status: "active", startedAt: clock, provider: "test", updatedAt: clock }, tenantOpts);
    expect(await c.topUpPlan("cr_up", "bill_down")).toBe(0);
    expect((await c.balance("cr_up")).allowance).toBe(2000); // this month's credits stay; Starter's start next month
  });

  it("prices from the shared list", () => {
    expect(CREDIT_PRICES.question_quick.credits).toBe(1);
    expect(CREDIT_PRICES.question_deep.credits).toBe(5);
  });
});
