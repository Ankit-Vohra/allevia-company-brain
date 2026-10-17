// GET /api/:t/usage?month=YYYY-MM over the seeded graph: the credits spent that month as the ledger has them (src/credits:
// CreditEntry nodes, newest first, with what they paid for), what the work cost to make (usd_cost), the answers the team
// gave, and the honest flags (billing not connected, actions as dry runs).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { addObservation } from "../../src/graph/observations.js";
import { upsertNode } from "../../src/graph/upsert.js";
import { Credits } from "../../src/credits/index.js";
import type { UsageDto } from "../../src/server/routes/usage.js";
import { SEED_NOW } from "../fixtures/seed-graph.js";
import { harness, type Harness } from "./harness.js";

describe("server: usage (integration)", () => {
  let h: Harness;
  const seeded: Record<string, number> = {}; // answers the seed graph already has, per month
  beforeAll(async () => {
    h = await harness();
    for (const m of ["2026-09", "2026-10"]) seeded[m] = ((await (await h.app.request(`/api/mini/usage?month=${m}`)).json()) as UsageDto).answers;
    // what the Studio's work cost us (usd_cost), and the owner's OK on it spending credits (the ledger, at the time of the OK)
    const post = async (id: string, name: string, asOf: string, service: "picture" | "carousel", usd: number) => {
      await upsertNode(h.g, { type: "Content", id, name, props: { format: "post", status: "draft" }, src: "approval:u", asOf }, SEED_NOW);
      await addObservation(h.g, { subject: id, metric: "usd_cost", value: usd, unit: "USD", asOf, src: `approval:${id}`, conf: 0.5 }, SEED_NOW);
      const at = Date.parse(`${asOf}T10:00:00Z`);
      await new Credits({ openGraph: async () => h.g, now: () => at, log: () => {} }).spend("mini", service, { ref: `approval:${id}`, for: [id] });
    };
    await post("content:u-villa", "Post: the villa", "2026-10-03", "picture", 0.5);
    await post("content:u-carousel", "Carousel: three homes", "2026-10-12", "carousel", 0.35);
    await post("content:u-old", "Post: last month", "2026-09-28", "picture", 0.5);
    // two answered questions in October, one failed one, and one in September
    for (const [id, at, status] of [["turn:u1", "2026-10-02T10:00:00Z", "ok"], ["turn:u2", "2026-10-14T23:59:00Z", "ok"], ["turn:u3", "2026-10-05T10:00:00Z", "failed"], ["turn:u4", "2026-09-30T23:00:00Z", "ok"]] as const) {
      await upsertNode(h.g, { type: "Turn", id, name: `Question ${id}`, props: { question: "q", answer: "a", at: Date.parse(at), status } }, SEED_NOW);
    }
  }, 90_000);
  afterAll(async () => h.cleanup());

  const usage = async (q = "") => {
    const res = await h.app.request(`/api/mini/usage${q}`);
    expect(res.status, await res.clone().text()).toBe(200);
    return res.json() as Promise<UsageDto>;
  };

  it("sums the month's credits from the ledger and the Studio's costs, newest first, and counts the answers", async () => {
    const u = await usage("?month=2026-10");
    expect(u.month).toBe("2026-10");
    expect(u.credits.used).toBe(15);
    expect(u.credits.items).toEqual([
      { subject: "content:u-carousel", name: "Carousel: three homes", credits: 10, date: "2026-10-12" },
      { subject: "content:u-villa", name: "Post: the villa", credits: 5, date: "2026-10-03" },
    ]);
    expect(u.costUsd).toBe(0.85);
    expect(u.answers).toBe(seeded["2026-10"]! + 2); // the failed one and September's are not counted
    expect(u.billingConnected).toBe(false);
    expect(u.actionsLive).toBe(false); // the test env has no ALLEVIA_ACTIONS_LIVE
  });

  it("defaults to the current month and reads any other", async () => {
    expect((await usage()).month).toBe(new Date(SEED_NOW + 3_600_000).toISOString().slice(0, 7)); // the harness clock
    const sep = await usage("?month=2026-09");
    expect(sep).toMatchObject({ month: "2026-09", credits: { used: 5 }, costUsd: 0.5, answers: seeded["2026-09"]! + 1 });
    expect(await usage("?month=2026-08")).toMatchObject({ credits: { used: 0, items: [] }, costUsd: 0, answers: 0 });
  });

  it("says when actions run live, and refuses a bad month or an unknown business", async () => {
    const live = await (await h.make({ actions: { live: true } }).request("/api/mini/usage")).json() as UsageDto;
    expect(live.actionsLive).toBe(true);
    for (const m of ["2026-13", "26-10", "2026-1", "x"]) expect((await h.app.request(`/api/mini/usage?month=${m}`)).status).toBe(400);
    expect((await h.app.request("/api/nope/usage")).status).toBe(404);
  });
});
