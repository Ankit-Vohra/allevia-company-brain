// Every public-data spend is a number in the business's own graph (graph audit G6): an `apify_spend_usd` Observation on the
// Business, sourced from a spend Document, like the paid keyword layer's. The file ledger keeps what only a lock can: the day's
// cap across every business and a reservation held while a run is in flight. The month's budget is the higher of the file's
// and the graph's, so a spend made on another machine still counts. A fake Apify client only: nothing here calls the service.
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GraphHandle } from "../../src/graph/client.js";
import { upsertNode, writeBatch } from "../../src/graph/upsert.js";
import { businessId } from "../../src/graph/tenants.js";
import { ApifyError, type ApifyClient, type ApifyRunRequest } from "../../src/publicdata/apify.js";
import { SpendLedger } from "../../src/publicdata/ledger.js";
import { PublicData } from "../../src/publicdata/service.js";
import { SPEND_METRIC, graphSpend, graphSpentThisMonth, spendDocId, spendWrite } from "../../src/publicdata/spend.js";
import { testGraph } from "../helpers/graph.js";

const NOW = Date.parse("2026-10-15T10:00:00Z");
const TENANT = "acme_bakes";
const BIZ = businessId(TENANT);

class FakeClient implements ApifyClient {
  runs: ApifyRunRequest[] = [];
  constructor(private readonly reply: (r: ApifyRunRequest) => { items: unknown[]; usd?: number } | Error = () => ({ items: [{ ok: 1 }] })) {}
  async run(r: ApifyRunRequest) {
    this.runs.push(r);
    const out = this.reply(r);
    if (out instanceof Error) throw out;
    return { runId: `r${this.runs.length}`, status: "SUCCEEDED", ...out };
  }
}

describe("public-data spend in the business's graph", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  let dir: string;
  let now = NOW;
  const ledger = () => new SpendLedger(dir, { now: () => now });
  const door = (client: ApifyClient, caps = { monthlyPerBusiness: 2, dailyAll: 3 }) =>
    new PublicData({ client, ledger: ledger(), caps, ...graphSpend(async () => g) });
  const spends = () => g.roQuery<{ actor: string; usd: number; day: string; doc: string; kind: string; ok: boolean }>(
    `MATCH (o:Observation {metric:'${SPEND_METRIC}'})-[m:MEASURES]->(b:Business {id:$b}), (o)-[s:SOURCED_FROM]->(d:Document)
     WHERE m.until IS NULL AND s.until IS NULL RETURN d.actor AS actor, o.value AS usd, o.asOf AS day, d.id AS doc, d.kind AS kind, d.ok AS ok ORDER BY day, o.id`, { b: BIZ });

  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await upsertNode(g, { type: "Business", id: BIZ, name: "Acme Bakes" }, NOW);
  });
  afterAll(async () => { await cleanup(); });
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "allevia-apify-")); now = NOW; });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("records each lookup as a reading on the Business sourced from a spend Document, at the higher of the estimate and the reported cost", async () => {
    const pd = door(new FakeClient(() => ({ items: [{ ok: 1 }], usd: 0.5 })));
    const r = await pd.run({ tenant: TENANT, actor: "apify/instagram-post-scraper", input: {}, maxItems: 5 });
    expect(r.ok).toBe(true);
    now += 60_000;
    const second = door(new FakeClient());
    expect((await second.run({ tenant: TENANT, actor: "compass/crawler-google-places", input: {}, maxItems: 1, units: 11 })).ok).toBe(true);
    const estimate = second.quote("compass/crawler-google-places", 11);
    const rows = await spends();
    expect(rows).toEqual([
      { actor: "apify/instagram-post-scraper", usd: 0.5, day: "2026-10-15T10:00:00.000Z", doc: expect.stringMatching(/^document:apify-spend-apify-/), kind: "spend", ok: true },
      { actor: "compass/crawler-google-places", usd: estimate, day: "2026-10-15T10:01:00.000Z", doc: expect.stringMatching(/^document:apify-spend-apify-/), kind: "spend", ok: true },
    ]);
    expect(await graphSpentThisMonth(g, BIZ, "2026-10")).toBeCloseTo(0.5 + estimate, 6);
    expect(await graphSpentThisMonth(g, BIZ, "2026-09")).toBe(0);
    // the file says the same: the graph is a record of it, not a different number
    expect(ledger().spent(TENANT).month).toBeCloseTo(0.5 + estimate, 6);
  });

  it("a lookup that started and failed is charged at its estimate and says so; one that never started leaves nothing", async () => {
    const before = (await spends()).length;
    const failing = door(new FakeClient(() => new ApifyError("timeout", "the run took too long", true)));
    const r = await failing.run({ tenant: TENANT, actor: "apify/instagram-profile-scraper", input: {}, maxItems: 1 });
    expect(r.ok).toBe(false);
    const never = door(new FakeClient(() => new ApifyError("auth", "refused", false)));
    expect((await never.run({ tenant: TENANT, actor: "apify/instagram-profile-scraper", input: {}, maxItems: 1 })).ok).toBe(false);
    const rows = await spends();
    expect(rows).toHaveLength(before + 1);
    const failed = rows.filter((x) => !x.ok);
    expect(failed).toEqual([expect.objectContaining({ actor: "apify/instagram-profile-scraper", ok: false })]);
    expect(failed[0]!.usd).toBeGreaterThan(0);
  });

  it("the month's budget counts what the graph says, even when this machine's file knows nothing of it", async () => {
    // a spend written from another machine: it is in the graph and not in this data folder's ledger file
    const other = spendWrite({ tenant: TENANT, id: "apify_elsewhere", actor: "compass/crawler-google-places", usd: 1.98, at: Date.parse("2026-10-14T08:00:00Z"), ok: true });
    expect((await writeBatch(g, other, NOW)).errors).toEqual([]);
    expect(ledger().spent(TENANT).month).toBeLessThan(1); // the file has only this test's own few cents
    const client = new FakeClient();
    const refused = await door(client).run({ tenant: TENANT, actor: "compass/crawler-google-places", input: {}, maxItems: 1, units: 11 });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("month");
    expect(client.runs).toHaveLength(0);
    // a business with no spend in its graph is not held back by it, and a new month starts clean
    now = Date.parse("2026-11-01T00:05:00Z");
    expect((await door(client).run({ tenant: TENANT, actor: "compass/crawler-google-places", input: {}, maxItems: 1, units: 11 })).ok).toBe(true);
  });

  it("the day's cap across every business is still the file's lock", async () => {
    const client = new FakeClient();
    const pd = door(client, { monthlyPerBusiness: 100, dailyAll: 0.06 });
    now = Date.parse("2026-12-01T09:00:00Z");
    expect((await pd.run({ tenant: "shop_one", actor: "compass/crawler-google-places", input: {}, maxItems: 1, units: 11 })).ok).toBe(true);
    const second = await pd.run({ tenant: "shop_two", actor: "compass/crawler-google-places", input: {}, maxItems: 1, units: 11 });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("day");
    expect(client.runs).toHaveLength(1);
  });

  it("a graph that cannot be reached never stops a lookup or loses its spend: the file still has it", async () => {
    const lines: string[] = [];
    const broken = new PublicData({
      client: new FakeClient(), ledger: ledger(), caps: { monthlyPerBusiness: 2, dailyAll: 3 }, log: (l) => lines.push(l),
      onSpend: async () => { throw new Error("graph down"); }, monthSpent: async () => { throw new Error("graph down"); },
    });
    const before = ledger().spent("quiet_shop").month;
    const r = await broken.run({ tenant: "quiet_shop", actor: "compass/crawler-google-places", input: {}, maxItems: 1, units: 11 });
    expect(r.ok).toBe(true);
    expect(ledger().spent("quiet_shop").month).toBeGreaterThan(before);
    expect(lines.join("\n")).toMatch(/could not be read from the graph[\s\S]*not written to the graph/);
  });

  it("spendWrite is one Document and one Observation, with the run's own id", () => {
    const w = spendWrite({ tenant: TENANT, id: "apify_x", actor: "apify/facebook-ads-scraper", usd: 0.04, at: NOW, ok: true });
    expect(w.nodes).toHaveLength(1);
    expect(w.nodes[0]).toMatchObject({ type: "Document", id: spendDocId("apify_x"), props: { kind: "spend", actor: "apify/facebook-ads-scraper", costUsd: 0.04 } });
    expect(w.observations).toEqual([expect.objectContaining({ subject: BIZ, metric: "apify_spend_usd", value: 0.04, unit: "USD", src: spendDocId("apify_x"), asOf: "2026-10-15T10:00:00.000Z" })]);
  });
});
