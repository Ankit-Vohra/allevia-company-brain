// The DataForSEO layer against a fake API: off and explained when not configured, the cost checked against the month's
// budget before every call, the real cost recorded, and the credentials never in an error, a log line or a write.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  BudgetError, DataForSeo, DfsError, NOT_CONFIGURED, backlinksCall, competitorsCall, dfsConfig, estimateUsd, keywordIdeasCall, keywordsWrite,
  marketFor, memoryLedger, rankedKeywordsCall, withinBudget, type DfsFetch,
} from "../../src/checkup/dataforseo.js";

const CREDS = { login: "owner@example.test", password: "s3cret-pass-123" };
const NOW = Date.parse("2026-10-16T10:00:00Z");

function fakeApi(result: unknown, opts: { status?: number; cost?: number; statusCode?: number; message?: string } = {}) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
  const f: DfsFetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return {
      status: opts.status ?? 200,
      json: async () => ({ status_code: 20000, cost: opts.cost ?? 0.0156, tasks: [{ status_code: opts.statusCode ?? 20000, status_message: opts.message ?? "Ok.", cost: opts.cost ?? 0.0156, result: [result] }] }),
    };
  };
  return { f, calls };
}

describe("configuration", () => {
  const dir = mkdtempSync(join(tmpdir(), "allevia-dfs-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  it("is off without both keys, with a plain explanation", () => {
    const file = join(dir, "none.env");
    writeFileSync(file, "DATAFORSEO_LOGIN=someone\n");
    const c = dfsConfig({ ALLEVIA_ENV_FILE: file });
    expect(c.credentials).toBeNull();
    expect(c.monthlyBudgetUsd).toBe(1);
    expect(NOT_CONFIGURED).toMatch(/off/);
    expect(NOT_CONFIGURED).toMatch(/\$1 a month/);
  });
  it("reads both keys and a budget from the env file", () => {
    const file = join(dir, "on.env");
    writeFileSync(file, `DATAFORSEO_LOGIN=${CREDS.login}\nDATAFORSEO_PASSWORD=${CREDS.password}\nDATAFORSEO_MONTHLY_BUDGET_USD=2.5\n`);
    const c = dfsConfig({ ALLEVIA_ENV_FILE: file });
    expect(c.credentials).toEqual(CREDS);
    expect(c.monthlyBudgetUsd).toBe(2.5);
  });
});

describe("prices", () => {
  it("estimates per task plus per row", () => {
    expect(estimateUsd("keyword_ideas", 30)).toBeCloseTo(0.0156, 4);
    expect(estimateUsd("ranked_keywords", 100)).toBeCloseTo(0.024, 4);
    expect(estimateUsd("backlinks", 1)).toBeCloseTo(0.024, 3);
  });
  it("picks the market by country", () => {
    expect(marketFor("IN").locationCode).toBe(2356);
    expect(marketFor("gb").locationCode).toBe(2826);
    expect(marketFor(undefined).locationCode).toBe(2356);
  });
});

describe("calls", () => {
  it("asks for keyword ideas with basic auth and reads volume, cost per click, difficulty and intent", async () => {
    const api = fakeApi({ items: [{ keyword: "interior designer raipur", keyword_info: { search_volume: 880, cpc: 0.42 }, keyword_properties: { keyword_difficulty: 12 }, search_intent_info: { main_intent: "commercial" } }] });
    const ledger = memoryLedger();
    const r = await withinBudget(keywordIdeasCall(new DataForSeo(CREDS, { fetch: api.f }), ["interior designer raipur"], marketFor("IN")), ledger, 1, NOW);
    expect(api.calls[0]!.url).toBe("https://api.dataforseo.com/v3/dataforseo_labs/google/keyword_ideas/live");
    expect(api.calls[0]!.headers.authorization).toBe(`Basic ${Buffer.from(`${CREDS.login}:${CREDS.password}`).toString("base64")}`);
    expect(api.calls[0]!.body).toEqual([expect.objectContaining({ keywords: ["interior designer raipur"], location_code: 2356, language_code: "en" })]);
    expect(r.value).toEqual([{ keyword: "interior designer raipur", volume: 880, cpcUsd: 0.42, difficulty: 12, intent: "commercial" }]);
    expect(r.costUsd).toBeCloseTo(0.0156, 4);
    expect(ledger.entries).toHaveLength(1);
  });

  it("reads rankings, competitors (without the business itself) and backlinks", async () => {
    const ranked = fakeApi({ items: [{ keyword_data: { keyword: "avs atelier", keyword_info: { search_volume: 30 } }, ranked_serp_element: { serp_item: { rank_absolute: 1, url: "https://www.avsatelier.in/" } } }] });
    const comp = fakeApi({ items: [{ domain: "www.avsatelier.in", intersections: 40 }, { domain: "studiotara.in", intersections: 12, avg_position: 8.5, full_domain_metrics: { organic: { etv: 120 } } }] });
    const back = fakeApi({ backlinks: 210, referring_domains: 33, rank: 18 }, { cost: 0.02 });
    const l = memoryLedger();
    expect((await withinBudget(rankedKeywordsCall(new DataForSeo(CREDS, { fetch: ranked.f }), "avsatelier.in", marketFor("IN")), l, 1, NOW)).value)
      .toEqual([{ keyword: "avs atelier", position: 1, url: "https://www.avsatelier.in/", volume: 30 }]);
    expect((await withinBudget(competitorsCall(new DataForSeo(CREDS, { fetch: comp.f }), "avsatelier.in", marketFor("IN")), l, 1, NOW)).value)
      .toEqual([{ domain: "studiotara.in", sharedKeywords: 12, avgPosition: 8.5, traffic: 120 }]);
    expect((await withinBudget(backlinksCall(new DataForSeo(CREDS, { fetch: back.f }), "avsatelier.in"), l, 1, NOW)).value)
      .toEqual({ backlinks: 210, referringDomains: 33, rank: 18 });
  });

  it("refuses a call that would go over this month's budget, before calling", async () => {
    const api = fakeApi({ items: [] });
    const ledger = memoryLedger(0.99);
    await expect(withinBudget(keywordIdeasCall(new DataForSeo(CREDS, { fetch: api.f }), ["x"], marketFor("IN")), ledger, 1, NOW)).rejects.toThrow(BudgetError);
    expect(api.calls).toHaveLength(0);
    await expect(withinBudget(keywordIdeasCall(new DataForSeo(CREDS, { fetch: api.f }), ["x"], marketFor("IN")), ledger, 1, NOW))
      .rejects.toThrow(/about \$0\.016 .* budget of \$1\.00 has \$0\.010 left/);
  });

  it("never puts the credentials in an error", async () => {
    const leaky: DfsFetch = async () => { throw new Error(`connect failed for ${CREDS.login}:${CREDS.password}`); };
    const e = await withinBudget(keywordIdeasCall(new DataForSeo(CREDS, { fetch: leaky }), ["x"], marketFor("IN")), memoryLedger(), 1, NOW).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(DfsError);
    expect(String((e as Error).message)).not.toContain(CREDS.password);
    expect(String((e as Error).message)).not.toContain(CREDS.login);
    const refused = fakeApi({}, { status: 401 });
    await expect(new DataForSeo(CREDS, { fetch: refused.f }).post("/x", {})).rejects.toThrow(/refused the login/);
    const bad = fakeApi({}, { statusCode: 40501, message: "Invalid Field" });
    await expect(new DataForSeo(CREDS, { fetch: bad.f }).post("/x", {})).rejects.toThrow(/Invalid Field/);
  });
});

describe("keywordsWrite", () => {
  it("writes searches as Query nodes with monthly volume, and which page ranks for them", () => {
    const w = keywordsWrite({ asOf: "2026-10-16T10:00:00Z", host: "avsatelier.in", ideas: [{ keyword: "Interior designer Raipur", volume: 880, cpcUsd: null, difficulty: null, intent: null }],
      ranked: [{ keyword: "avs atelier", position: 1, url: "https://www.avsatelier.in/", volume: 30 }] });
    expect(w.nodes.filter((n) => n.type === "Query").map((n) => n.name)).toEqual(["Interior designer Raipur", "avs atelier"]);
    expect(w.edges).toEqual([expect.objectContaining({ type: "RANKS_FOR", props: { position: 1 } })]);
    expect(w.observations.map((o) => o.value)).toEqual([880, 30]);
    expect(JSON.stringify(w)).not.toContain(CREDS.password);
  });
});
