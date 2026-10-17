// Credits and the plan through the real app (createApp over the seeded graph, a scripted FakeRuntime, a throwaway registry on
// the test database): a question one person answers spends 1 and one the team works on spends 5, each linked to its Turn;
// saying OK spends once; out of credits is a 402 with the owner's sentence before any work starts (questions, OKs, the
// check-up), and the card stays waiting; a teammate cannot change the plan; billing in test mode records the request (or
// applies it at once); the public demo view reads credits and never spends; GET /usage reads the ledger.
import { afterAll, beforeAll, describe, expect, it, afterEach } from "vitest";
import { TEST_MODE_NOTE, type BillingResultDto, type CreditsDto, type SubscriptionDto } from "../../shared/credits.js";
import { FakeRuntime } from "../../src/agent/runtime.js";
import { approveRequest, testProvider } from "../../src/billing/provider.js";
import { putSubscription } from "../../src/billing/subscription.js";
import { CheckupJobs } from "../../src/checkup/jobs.js";
import { Credits } from "../../src/credits/index.js";
import { openGraphByName } from "../../src/graph/client.js";
import { upsertNode } from "../../src/graph/upsert.js";
import { requestView } from "../../src/server/auth.js";
import { OWNER_ONLY } from "../../src/server/roles.js";
import type { UsageDto } from "../../src/server/routes/usage.js";
import { SEED_NOW } from "../fixtures/seed-graph.js";
import { testGraphName } from "../helpers/graph.js";
import { harness, post, resetRuntime, TENANT, useRuntime, type Harness } from "./harness.js";

const NOW = SEED_NOW + 3_600_000; // the harness clock: October 2026
const QUICK = {
  "chief-of-staff:plan": { structured: { rationale: "One lookup", steps: [{ agent: "chief-of-staff", task: "Look up the decision" }] } },
  "chief-of-staff:direct": { text: "We paused daily stories on 20 Sep 2026 [[decision:007-pause-daily-stories]]." },
};
const OUT = "You've used this month's credits. Buy 100 more for $29 or move to Growth.";

describe("server: credits and the plan (integration)", () => {
  let h: Harness;
  const metaGraph = testGraphName();
  const registry = { metaGraph };
  let credits: Credits;
  let app: Harness["app"];
  const checkups = new CheckupJobs({ run: async () => {}, log: () => {} });

  beforeAll(async () => {
    h = await harness();
    credits = new Credits({ openGraph: async () => h.g, tenantOpts: registry, now: () => NOW, log: () => {} });
    app = h.make({ credits, registry, checkupJobs: checkups });
  }, 90_000);
  afterAll(async () => {
    await (await openGraphByName(metaGraph)).drop().catch(() => undefined);
    await h.cleanup();
  });
  afterEach(() => resetRuntime());

  const read = async <T>(path: string, a = app): Promise<T> => {
    const res = await a.request(path);
    expect(res.status, await res.clone().text()).toBe(200);
    return res.json() as Promise<T>;
  };
  const entries = async () => (await h.g.roQuery<{ n: number }>("MATCH (e:CreditEntry) RETURN count(e) AS n"))[0]?.n ?? 0;
  const until = async (ok: () => Promise<boolean>) => {
    for (let i = 0; i < 100 && !(await ok()); i++) await new Promise((r) => setTimeout(r, 30));
  };

  it("the public demo view shows credits and the plan's numbers, writes nothing, and changes nothing", async () => {
    const demo = h.make({
      credits, registry, auth: { enabled: true, verify: async () => null },
      listTenants: async () => [{ ...TENANT, demo: true }],
    });
    const before = await entries();
    const dto = await read<CreditsDto>("/api/mini/credits", demo);
    expect(dto.balance).toMatchObject({ month: "2026-10", plan: "growth", status: "active", allowance: 800, used: 0, left: 800 });
    expect(dto.prices.find((p) => p.service === "question_deep")).toMatchObject({ credits: 5, label: "Deep question (the whole team looks into it)" });
    expect(await entries()).toBe(before); // nothing written
    expect((await demo.request("/api/mini/subscription")).status).toBe(403);
    for (const path of ["/api/mini/subscription/change", "/api/mini/credits/packs", "/api/mini/subscription/pause", "/api/mini/subscription/cancel"]) {
      expect((await post(demo, path, { plan: "pro" })).status, path).toBe(403);
    }
    expect((await post(demo, "/api/mini/approvals/approval%3At-001-1", { decision: "approve" })).status).toBe(403);
    expect(await entries()).toBe(before);
  });

  it("a question one person answers spends 1, linked to its Turn; one the team works on spends 5", async () => {
    useRuntime(() => new FakeRuntime(QUICK));
    const quick = await post(app, "/api/mini/ask", { question: "Why did we pause daily stories?" });
    expect(quick.status).toBe(200);
    await quick.text();
    await until(async () => (await credits.balance("mini")).used === 1);
    let dto = await read<CreditsDto>("/api/mini/credits");
    expect(dto.balance).toMatchObject({ used: 1, left: 799 });
    const q = dto.entries.find((e) => e.service === "question_quick")!;
    expect(q).toMatchObject({ credits: -1, label: "Quick question", by: "You", for: { name: "Why did we pause daily stories?" } });
    expect(q.for!.id).toMatch(/^turn:/);

    resetRuntime(); // the harness script: the Librarian looks into it, the Chief answers
    const deep = await post(app, "/api/mini/ask", { question: "Trace the stories decision" });
    await deep.text();
    await until(async () => (await credits.balance("mini")).used === 6);
    dto = await read<CreditsDto>("/api/mini/credits");
    expect(dto.balance).toMatchObject({ used: 6, left: 794 });
    expect(dto.byService).toEqual([
      { key: "question_deep", label: "Deep question (the whole team looks into it)", credits: 5, times: 1 },
      { key: "question_quick", label: "Quick question", credits: 1, times: 1 },
    ]);
    expect(dto.byPerson).toEqual([{ key: "You", label: "You", credits: 6, times: 2 }]);
  });

  it("saying OK spends what the card costs, once; a teammate's OK is theirs; No thanks costs nothing", async () => {
    const list = await read<Array<{ id: string; credits?: number; status: string }>>("/api/mini/approvals");
    expect(list.find((a) => a.id === "approval:t-001-1")?.credits).toBe(1);
    const before = (await credits.balance("mini")).used;
    const ok = await requestView.run({ publicView: false, role: "member", userId: "user:asha" }, () => post(app, "/api/mini/approvals/approval%3At-001-1", { decision: "approve" }));
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect((await post(app, "/api/mini/approvals/approval%3At-001-1", { decision: "approve" })).status).toBe(409);
    expect((await credits.balance("mini")).used).toBe(before + 1);
    const dto = await read<CreditsDto>("/api/mini/credits");
    expect(dto.entries.find((e) => e.service === "draft_text")).toMatchObject({ credits: -1, label: "Email, reply or caption", by: "Someone on your team", for: { id: "approval:t-001-1" } });

    await upsertNode(h.g, { type: "Approval", id: "approval:cr-no", name: "email_send: Hello", props: { status: "pending", kind: "email_send", title: "Hello", payload: JSON.stringify({ title: "Hello", body: "Hi" }) } }, SEED_NOW);
    expect((await post(app, "/api/mini/approvals/approval%3Acr-no", { decision: "reject" })).status).toBe(200);
    expect((await credits.balance("mini")).used).toBe(before + 1);
  });

  it("GET /usage reads the ledger: the month's spends with what they paid for", async () => {
    const u = await read<UsageDto>("/api/mini/usage?month=2026-10");
    expect(u.credits.used).toBe((await credits.balance("mini")).used);
    expect(u.credits.items.map((i) => i.credits).sort()).toEqual([1, 1, 5]);
    expect(u.credits.items.find((i) => i.subject === "approval:t-001-1")).toMatchObject({ credits: 1, date: "2026-10-15" });
    expect((await read<UsageDto>("/api/mini/usage?month=2026-09")).credits).toEqual({ used: 0, items: [] });
  });

  it("a teammate cannot see or change the plan; the owner's change waits for the Allevia team in test mode", async () => {
    const asMember = <T>(fn: () => T): T => requestView.run({ publicView: false, role: "member", userId: "user:asha" }, fn);
    for (const [path, body] of [["/api/mini/subscription/change", { plan: "pro" }], ["/api/mini/credits/packs", {}], ["/api/mini/subscription/pause", {}], ["/api/mini/subscription/cancel", {}]] as const) {
      const res = await asMember(() => post(app, path, body));
      expect(res.status, path).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe(OWNER_ONLY);
    }
    expect((await asMember(() => app.request("/api/mini/subscription"))).status).toBe(403);
    expect((await asMember(() => app.request("/api/mini/credits"))).status).toBe(200); // credits are for everyone to see

    const sub = await read<SubscriptionDto>("/api/mini/subscription");
    expect(sub).toMatchObject({ plan: "growth", status: "active", implicit: true, provider: "test", billing: "test-request", pending: [] });
    expect((await post(app, "/api/mini/subscription/change", { plan: "growth" })).status).toBe(409);
    const res = await post(app, "/api/mini/subscription/change", { plan: "pro", cycle: "yearly" });
    expect(res.status).toBe(202);
    const r = await res.json() as BillingResultDto;
    expect(r.done).toBe(false);
    expect(r.message).toBe(`We've noted that you want to move to Pro, paid yearly. ${TEST_MODE_NOTE}`);
    expect(r.subscription.pending).toEqual([expect.objectContaining({ kind: "change", plan: "pro", cycle: "yearly", status: "pending" })]);
    // the same tap again is the same request
    expect(((await (await post(app, "/api/mini/subscription/change", { plan: "pro", cycle: "yearly" })).json()) as BillingResultDto).request.id).toBe(r.request.id);

    // the operator approves it: Pro, and this month's plan credits go up to Pro's
    expect(await approveRequest(r.request.id, { credits, tenantOpts: registry, now: () => NOW })).toMatchObject({ ok: true });
    expect(await approveRequest(r.request.id, { credits, tenantOpts: registry, now: () => NOW })).toMatchObject({ ok: false });
    expect(await read<SubscriptionDto>("/api/mini/subscription")).toMatchObject({ plan: "pro", cycle: "yearly", status: "active", pending: [] });
    expect((await read<CreditsDto>("/api/mini/credits")).balance).toMatchObject({ plan: "pro", allowance: 2000 });
  });

  it("with ALLEVIA_BILLING=test-instant a pack is added at once", async () => {
    const instant = h.make({ credits, registry, billing: testProvider("test-instant", { credits, tenantOpts: registry, now: () => NOW }) });
    const left = (await credits.balance("mini")).left;
    const res = await post(instant, "/api/mini/credits/packs", { packId: "pack100" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ done: true, message: "Done: 100 more credits are in your account." });
    expect(await credits.balance("mini")).toMatchObject({ packs: 100, left: left + 100 });
    expect((await post(instant, "/api/mini/credits/packs", { packId: "pack999" })).status).toBe(400);
  });

  it("out of credits: a 402 with the owner's sentence before any work, for a question, an OK and a check-up; the card keeps waiting", async () => {
    await putSubscription({ slug: "mini", plan: "pause", cycle: "monthly", status: "paused", startedAt: NOW, provider: "test", updatedAt: NOW }, registry);
    const b = await credits.balance("mini");
    await credits.grant("mini", -b.left, "Taken back for the test", "drain"); // the month's credits are all gone
    expect((await credits.balance("mini")).left).toBe(0);
    const asks = h.askCalls.length;

    const ask = await post(app, "/api/mini/ask", { question: "Anything new?" });
    expect(ask.status).toBe(402);
    const body = await ask.json() as { error: string; outOfCredits: Record<string, unknown> };
    expect(body.error).toBe(OUT);
    expect(body.outOfCredits).toMatchObject({ left: 0, needed: 1, service: "question_quick", packId: "pack100", nextPlan: "growth" });
    expect(h.askCalls.length).toBe(asks); // no work started

    await upsertNode(h.g, { type: "Approval", id: "approval:cr-wait", name: "email_send: Hi", props: { status: "pending", kind: "email_send", title: "Hi", payload: JSON.stringify({ title: "Hi", body: "Hello" }) } }, SEED_NOW);
    const okRes = await post(app, "/api/mini/approvals/approval%3Acr-wait", { decision: "approve" });
    expect(okRes.status).toBe(402);
    expect(((await okRes.json()) as { error: string }).error).toBe(OUT);
    expect((await read<Array<{ id: string; status: string }>>("/api/mini/approvals")).find((a) => a.id === "approval:cr-wait")?.status).toBe("pending");

    await upsertNode(h.g, { type: "Business", id: TENANT.businessId, name: "Aamdani", props: { domain: "mini.example" } }, SEED_NOW);
    const check = await post(app, "/api/mini/checkup", {});
    expect(check.status).toBe(402);
    expect(checkups.state("mini")).toBeUndefined(); // never started
  });

  it("a check-up the owner runs holds 10 credits and spends them when it finishes", async () => {
    await putSubscription({ slug: "mini", plan: "starter", cycle: "monthly", status: "active", startedAt: NOW, provider: "test", updatedAt: NOW }, registry);
    await credits.grant("mini", 30, "A test top-up", "cr-check");
    const before = await credits.balance("mini");
    const res = await post(app, "/api/mini/checkup", {});
    expect(res.status).toBe(202);
    await until(async () => (await credits.balance("mini")).used === before.used + 10);
    expect((await credits.balance("mini")).left).toBe(before.left - 10);
    const dto = await read<CreditsDto>("/api/mini/credits");
    expect(dto.byService.find((r) => r.key === "website_checkup")).toMatchObject({ credits: 10, times: 1, label: "Website check-up" });
  });
});
