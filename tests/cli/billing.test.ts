// The operator's billing commands (src/cli/billing.ts), over a throwaway registry and business graph on the test database:
// billing:requests lists what owners asked for in plain words, billing:approve applies one and says what the business is on
// now and what it has left, billing:decline changes nothing, and a request cannot be approved twice.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { addRequest, getSubscription } from "../../src/billing/subscription.js";
import { closeAll, openGraph, openGraphByName } from "../../src/graph/client.js";
import { testGraphName } from "../helpers/graph.js";

const metaGraph = testGraphName();
const SLUG = `test_${Math.random().toString(36).slice(2, 8)}`;

async function run(name: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  const { commands } = await import("../../src/cli/billing.js");
  const out: string[] = [];
  const err: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.join(" ")); });
  const error = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { err.push(a.join(" ")); });
  try {
    const code = (await commands.find((c) => c.name === name)!.run(args)) ?? 0;
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

describe("cli: billing", () => {
  beforeAll(async () => {
    process.env.ALLEVIA_META_GRAPH = metaGraph;
    const meta = await openGraphByName(metaGraph);
    await meta.query("CREATE (t:Tenant {slug:$slug, name:'Kestrel Bakery', createdAt:$at})", { slug: SLUG, at: Date.UTC(2026, 8, 1) });
  });
  afterAll(async () => {
    delete process.env.ALLEVIA_META_GRAPH;
    await (await openGraphByName(metaGraph)).drop().catch(() => undefined);
    await (await openGraph(SLUG)).drop().catch(() => undefined);
    await closeAll();
  });

  it("says when nothing is waiting", async () => {
    expect(await run("billing:requests", [])).toMatchObject({ code: 0, out: "Nothing waiting. (Use --all to see the ones already decided.)" });
  });

  it("lists a waiting request in words and approves it, saying the plan and the credits now", async () => {
    const r = await addRequest({ slug: SLUG, kind: "change", plan: "pro", cycle: "yearly", at: Date.UTC(2026, 9, 17, 9, 30), by: "owner" });
    const list = await run("billing:requests", []);
    expect(list.out).toContain("1 billing request waiting for your OK:");
    expect(list.out).toContain(r.requestId);
    expect(list.out).toContain("move to Pro, paid yearly");
    expect(list.out).toContain("asked 2026-10-17 09:30 UTC by owner");
    expect(list.out).toContain("Approve one:  npm run cli -- billing:approve <id>");

    const ok = await run("billing:approve", [r.requestId]);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain(`Approved ${r.requestId} for Kestrel Bakery (${SLUG}): move to Pro, paid yearly.`);
    expect(ok.out).toMatch(/Plan: {4}Pro \(yearly\), active, renews \d{4}-\d{2}-\d{2}/);
    expect(ok.out).toMatch(/Credits: 2,000 credits left this month \(\d{4}-\d{2}\): 2000 from the plan; 0 used\./);
    expect((await getSubscription(SLUG))?.plan).toBe("pro");

    const again = await run("billing:approve", [r.requestId]);
    expect(again).toMatchObject({ code: 1, err: `${r.requestId} was already done.` });
    expect((await run("billing:approve", ["bill_nope"])).err).toBe("No billing request bill_nope.");
    expect((await run("billing:requests", ["--all"])).out).toContain("done");
  });

  it("declines one without changing anything, and shows a business", async () => {
    const r = await addRequest({ slug: SLUG, kind: "pack", packId: "pack100", at: Date.now() });
    expect(await run("billing:decline", [r.requestId])).toMatchObject({ code: 0, out: `Declined ${r.requestId}. Nothing changed for the business.` });
    const show = await run("billing:show", [SLUG]);
    expect(show.out).toContain(`Kestrel Bakery (${SLUG})`);
    expect(show.out).toContain("100 more credits");
    expect(show.out).toContain("declined");
    expect((await run("billing:set", [SLUG, "nope"])).code).toBe(2);
  });
});
