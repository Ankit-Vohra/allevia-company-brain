// One live check against Apify, only when APIFY_TOKEN is set in the environment (skipped otherwise, so the suite never
// spends or needs the network). It reads one public business profile (Instagram's own account), spends well under a
// cent, and can never spend more than $0.20: the run goes through the same budget door with a $0.20 cap and its own
// ledger in a temp folder. Nothing is written to any graph.
//   APIFY_TOKEN=... npx vitest run tests/publicdata/live-smoke.test.ts
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RestApifyClient } from "../../src/publicdata/apify.js";
import { SpendLedger } from "../../src/publicdata/ledger.js";
import { PublicData } from "../../src/publicdata/service.js";
import { igProfileFrom } from "../../src/publicdata/normalize.js";

const TOKEN = process.env.APIFY_TOKEN;
const CAP_USD = 0.2;

describe.skipIf(!TOKEN)("Apify, live (APIFY_TOKEN set)", () => {
  const dir = mkdtempSync(join(tmpdir(), "allevia-apify-live-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reads one public business profile inside a $0.20 cap", async () => {
    const ledger = new SpendLedger(dir);
    const pd = new PublicData({ client: new RestApifyClient(TOKEN!), ledger, caps: { monthlyPerBusiness: CAP_USD, dailyAll: CAP_USD } });
    const r = await pd.run({ tenant: "live_smoke", actor: "apify/instagram-profile-scraper", input: { usernames: ["instagram"], resultsType: "details" }, maxItems: 1 });
    expect(r.ok, r.ok ? "" : r.why).toBe(true);
    if (!r.ok) return;
    const p = igProfileFrom(r.items[0]);
    expect(p?.handle).toBe("instagram");
    expect(p?.followers ?? 0).toBeGreaterThan(1_000_000);
    expect(pd.budget("live_smoke").spentThisMonth).toBeLessThanOrEqual(CAP_USD);
  }, 180_000);
});
