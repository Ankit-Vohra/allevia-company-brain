// The Apify REST client, against a fake fetch: it starts an allow-listed actor with caps, waits, pages the dataset, stops
// a run that passes the time limit, and never lets the token into a URL or an error.
import { describe, expect, it } from "vitest";
import { ApifyError, RestApifyClient } from "../../src/publicdata/apify.js";
import { ACTOR_IDS, ACTORS, capItems, estimateUsd, isAllowedActor } from "../../src/publicdata/actors.js";

const TOKEN = "apify_api_fake_token_xxxxxxxx";

interface Call { method: string; url: string; auth: string | undefined; body?: string }

function fakeFetch(script: (c: Call) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  const fn = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const c: Call = { method: init.method, url, auth: init.headers.Authorization, ...(init.body ? { body: init.body } : {}) };
    calls.push(c);
    const r = script(c);
    return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body };
  };
  return { fn, calls };
}

describe("the actor allow-list", () => {
  it("is exactly the eight public-data actors, each with a cap, a price and a time limit", () => {
    expect([...ACTOR_IDS].sort()).toEqual([
      "apify/facebook-ads-scraper", "apify/google-search-scraper", "apify/instagram-post-scraper", "apify/instagram-profile-scraper",
      "apify/instagram-reel-scraper", "apify/website-content-crawler", "compass/crawler-google-places", "s-r/google-ads-transparency",
    ]);
    for (const id of ACTOR_IDS) {
      expect(ACTORS[id].maxItems).toBeGreaterThan(0);
      expect(ACTORS[id].maxItems).toBeLessThanOrEqual(25);
      expect(ACTORS[id].usdPer1000).toBeGreaterThan(0);
      expect(ACTORS[id].timeoutMs).toBeLessThanOrEqual(240_000);
    }
    expect(isAllowedActor("apify/instagram-profile-scraper")).toBe(true);
    expect(isAllowedActor("someone/linkedin-people-scraper")).toBe(false);
  });

  it("estimates in dollars before a run, rounded up, and never above the actor's cap", () => {
    expect(estimateUsd("apify/instagram-profile-scraper", 1)).toBe(0.007); // 0.005 + 0.0016, rounded up
    expect(estimateUsd("compass/crawler-google-places", 11)).toBe(0.054);
    expect(estimateUsd("apify/facebook-ads-scraper", 1000)).toBe(estimateUsd("apify/facebook-ads-scraper", ACTORS["apify/facebook-ads-scraper"].maxItems));
    expect(capItems("apify/instagram-post-scraper", 500)).toBe(24);
    expect(capItems("apify/instagram-post-scraper", 0)).toBe(1);
  });
});

describe("RestApifyClient", () => {
  it("starts the actor with its caps, waits, and pages the dataset up to maxItems", async () => {
    let polls = 0;
    const items = Array.from({ length: 150 }, (_, i) => ({ n: i }));
    const { fn, calls } = fakeFetch((c) => {
      if (c.method === "POST" && c.url.includes("/v2/acts/")) return { status: 201, body: { data: { id: "run1", status: "RUNNING", defaultDatasetId: "ds1" } } };
      if (c.url.includes("/v2/actor-runs/run1")) return { status: 200, body: { data: { id: "run1", status: ++polls < 2 ? "RUNNING" : "SUCCEEDED", defaultDatasetId: "ds1", usageTotalUsd: 0.012 } } };
      if (c.url.includes("/v2/datasets/ds1/items")) {
        const u = new URL(c.url);
        const off = Number(u.searchParams.get("offset"));
        const lim = Number(u.searchParams.get("limit"));
        return { status: 200, body: items.slice(off, off + lim) };
      }
      return { status: 404, body: {} };
    });
    const client = new RestApifyClient(TOKEN, { fetch: fn });
    const r = await client.run({ actor: "apify/instagram-post-scraper", input: { username: ["acme_bakes"] }, maxItems: 24, maxUsd: 0.03, timeoutMs: 60_000 });
    expect(r.items).toHaveLength(24);
    expect(r.usd).toBe(0.012);
    const start = new URL(calls[0]!.url);
    expect(start.pathname).toBe("/v2/acts/apify~instagram-post-scraper/runs");
    expect(start.searchParams.get("maxItems")).toBe("24");
    expect(start.searchParams.get("maxTotalChargeUsd")).toBe("0.03");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ username: ["acme_bakes"] });
    // the token travels only in the header
    for (const c of calls) {
      expect(c.auth).toBe(`Bearer ${TOKEN}`);
      expect(c.url).not.toContain(TOKEN);
    }
  });

  it("stops a run that passes the time limit, and says so without the token", async () => {
    let t = 0;
    const { fn, calls } = fakeFetch((c) => {
      t += 40_000;
      if (c.url.endsWith("/abort")) return { status: 200, body: { data: { id: "run2", status: "ABORTING" } } };
      return { status: 200, body: { data: { id: "run2", status: "RUNNING", defaultDatasetId: "ds2" } } };
    });
    const client = new RestApifyClient(TOKEN, { fetch: fn, now: () => t });
    const e = await client.run({ actor: "apify/website-content-crawler", input: {}, maxItems: 5, maxUsd: 0.05, timeoutMs: 60_000 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApifyError);
    expect((e as ApifyError).kind).toBe("timeout");
    expect((e as ApifyError).started).toBe(true);
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/v2/actor-runs/run2/abort"))).toBe(true);
    expect(String((e as Error).message)).not.toContain(TOKEN);
  });

  it("names a refused token, an empty account and a failed run in plain words, never with the token", async () => {
    for (const [status, kind] of [[401, "auth"], [402, "no_credit"], [500, "http"]] as const) {
      const { fn } = fakeFetch(() => ({ status, body: { error: { message: `bad token ${TOKEN}` } } }));
      const e = await new RestApifyClient(TOKEN, { fetch: fn }).run({ actor: "apify/instagram-profile-scraper", input: {}, maxItems: 1, maxUsd: 0.01, timeoutMs: 30_000 }).catch((x: unknown) => x);
      expect((e as ApifyError).kind).toBe(kind);
      expect((e as ApifyError).started).toBe(false);
      expect((e as Error).message).not.toContain(TOKEN);
    }
    const { fn } = fakeFetch((c) => (c.url.includes("/v2/acts/")
      ? { status: 201, body: { data: { id: "run3", status: "FAILED" } } }
      : { status: 200, body: [] }));
    const e = await new RestApifyClient(TOKEN, { fetch: fn }).run({ actor: "apify/instagram-profile-scraper", input: {}, maxItems: 1, maxUsd: 0.01, timeoutMs: 30_000 }).catch((x: unknown) => x);
    expect((e as ApifyError).kind).toBe("failed");
    expect((e as ApifyError).started).toBe(true);
  });

  it("refuses an actor that is not on the allow-list before calling anything", async () => {
    const { fn, calls } = fakeFetch(() => ({ status: 200, body: {} }));
    const e = await new RestApifyClient(TOKEN, { fetch: fn }).run({ actor: "x/linkedin-people" as never, input: {}, maxItems: 1, maxUsd: 0.01, timeoutMs: 1000 }).catch((x: unknown) => x);
    expect((e as ApifyError).kind).toBe("not_allowed");
    expect(calls).toHaveLength(0);
  });
});
