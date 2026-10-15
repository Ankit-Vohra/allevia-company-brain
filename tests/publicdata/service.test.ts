// The public-data door: off without a token, budgets per business per month and for everyone per day (refused in plain
// words before anything runs), a run that never started is not counted, one that started is, and the reported cost wins
// when it is higher than the estimate.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OFF_WORDS, PublicData, productionPublicData } from "../../src/publicdata/service.js";
import { SpendLedger, spendCaps, spendLedgerPath, DEFAULT_DAILY_USD, DEFAULT_MONTHLY_USD } from "../../src/publicdata/ledger.js";
import { ApifyError, type ApifyClient, type ApifyRunRequest } from "../../src/publicdata/apify.js";
import { loadConfig } from "../../src/config.js";

const NOW = Date.parse("2026-10-15T10:00:00Z");

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

let dir: string;
let now = NOW;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "allevia-apify-")); now = NOW; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const ledger = () => new SpendLedger(dir, { now: () => now });

describe("public data lookups", () => {
  it("without a token: off, says so plainly, and runs nothing", async () => {
    const env = { ALLEVIA_ENV_FILE: join(dir, "none.env"), ALLEVIA_DATA_DIR: dir };
    const pd = productionPublicData(loadConfig(env));
    expect(pd.enabled).toBe(false);
    const r = await pd.run({ tenant: "acme_bakes", actor: "apify/instagram-profile-scraper", input: {}, maxItems: 1 });
    expect(r).toEqual({ ok: false, reason: "off", why: OFF_WORDS });
    expect(OFF_WORDS).toBe("Public data lookups aren't switched on.");
  });

  it("reads the token and the budgets from config, with $2 a month and $3 a day as defaults", () => {
    const c = loadConfig({ ALLEVIA_ENV_FILE: join(dir, "none.env"), APIFY_TOKEN: "apify_api_fake_xxxxxxxx", ALLEVIA_APIFY_MONTHLY_USD: "5" });
    expect(c.apify).toEqual({ token: "apify_api_fake_xxxxxxxx", monthlyUsd: "5", dailyUsd: undefined });
    expect(spendCaps({ monthly: c.apify.monthlyUsd })).toEqual({ monthlyPerBusiness: 5, dailyAll: DEFAULT_DAILY_USD });
    expect(spendCaps()).toEqual({ monthlyPerBusiness: DEFAULT_MONTHLY_USD, dailyAll: DEFAULT_DAILY_USD });
    expect(spendCaps({ monthly: "lots", daily: "-1" })).toEqual({ monthlyPerBusiness: 2, dailyAll: 3 });
    expect(loadConfig({ ALLEVIA_ENV_FILE: join(dir, "none.env") }).apify.token).toBeUndefined();
  });

  it("caps results to the actor's cap, reserves the estimate and keeps the higher reported cost", async () => {
    const client = new FakeClient(() => ({ items: Array.from({ length: 40 }, (_, i) => i), usd: 0.5 }));
    const pd = new PublicData({ client, ledger: ledger(), caps: spendCaps() });
    const r = await pd.run({ tenant: "acme_bakes", actor: "apify/instagram-post-scraper", input: { username: ["acme"] }, maxItems: 500 });
    expect(r.ok).toBe(true);
    expect(client.runs[0]!.maxItems).toBe(24);
    expect(client.runs[0]!.maxUsd).toBe(pd.quote("apify/instagram-post-scraper", 24));
    if (r.ok) expect(r.items).toHaveLength(24);
    expect(pd.budget("acme_bakes").spentThisMonth).toBe(0.5);
    const file = JSON.parse(readFileSync(spendLedgerPath(dir), "utf8")) as { entries: Array<Record<string, unknown>> };
    expect(file.entries[0]).toEqual(expect.objectContaining({ tenant: "acme_bakes", actor: "apify/instagram-post-scraper", status: "done", usd: 0.5, month: "2026-10", day: "2026-10-15" }));
  });

  it("refuses above the business's monthly budget, in plain words, before anything runs", async () => {
    const client = new FakeClient();
    const pd = new PublicData({ client, ledger: ledger(), caps: { monthlyPerBusiness: 0.06, dailyAll: 3 } });
    const first = await pd.run({ tenant: "acme_bakes", actor: "compass/crawler-google-places", input: {}, maxItems: 1, units: 11 });
    expect(first.ok).toBe(true);
    const second = await pd.run({ tenant: "acme_bakes", actor: "compass/crawler-google-places", input: {}, maxItems: 1, units: 11 });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe("month");
      expect(second.why).toBe("This lookup would cost about $0.05, and this month's budget for public lookups ($0.06) has under 1 cent left. It starts again on 1 Nov.");
    }
    expect(client.runs).toHaveLength(1);
    // another business has its own month
    expect((await pd.run({ tenant: "other_shop", actor: "compass/crawler-google-places", input: {}, maxItems: 1, units: 11 })).ok).toBe(true);
    // and the month starts again
    now = Date.parse("2026-11-01T00:05:00Z");
    expect((await pd.run({ tenant: "acme_bakes", actor: "compass/crawler-google-places", input: {}, maxItems: 1, units: 11 })).ok).toBe(true);
  });

  it("refuses when every business together has used today's limit", async () => {
    const pd = new PublicData({ client: new FakeClient(), ledger: ledger(), caps: { monthlyPerBusiness: 2, dailyAll: 0.15 } });
    expect((await pd.run({ tenant: "a_shop", actor: "apify/facebook-ads-scraper", input: {}, maxItems: 20 })).ok).toBe(true);
    const r = await pd.run({ tenant: "b_shop", actor: "apify/facebook-ads-scraper", input: {}, maxItems: 20 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("day");
      expect(r.why).toBe("Today's limit for public lookups ($0.15 across all businesses) is used up. Try again tomorrow.");
    }
  });

  it("a run refused before it started costs nothing; one that started and failed keeps its estimate", async () => {
    let fail: ApifyError = new ApifyError("auth", "refused", false);
    const pd = new PublicData({ client: new FakeClient(() => fail), ledger: ledger(), caps: spendCaps() });
    const a = await pd.run({ tenant: "acme_bakes", actor: "apify/instagram-profile-scraper", input: {}, maxItems: 1 });
    expect(a).toEqual(expect.objectContaining({ ok: false, reason: "error" }));
    if (!a.ok) expect(a.why).toMatch(/refused our key/);
    expect(pd.budget("acme_bakes").spentThisMonth).toBe(0);
    fail = new ApifyError("timeout", "slow", true);
    const b = await pd.run({ tenant: "acme_bakes", actor: "apify/instagram-profile-scraper", input: {}, maxItems: 1 });
    if (!b.ok) expect(b.why).toMatch(/took too long/);
    expect(pd.budget("acme_bakes").spentThisMonth).toBe(0.007);
  });

  it("refuses an actor that is not allowed and a business id that is not a slug", async () => {
    const client = new FakeClient();
    const pd = new PublicData({ client, ledger: ledger(), caps: spendCaps() });
    expect((await pd.run({ tenant: "acme_bakes", actor: "x/people-finder", input: {}, maxItems: 1 })).ok).toBe(false);
    expect((await pd.run({ tenant: "../etc", actor: "apify/instagram-profile-scraper", input: {}, maxItems: 1 })).ok).toBe(false);
    expect(client.runs).toHaveLength(0);
  });
});
