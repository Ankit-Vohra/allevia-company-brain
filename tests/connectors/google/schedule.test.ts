// The daily pull across businesses: it reads the ones that are due, skips the ones read recently, never connected or needing
// the owner, and one business failing does not stop the next. Two businesses, two graphs, one fake Google.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeAll, type GraphHandle } from "../../../src/graph/client.js";
import { upsertNode } from "../../../src/graph/upsert.js";
import { handleCallback, CONNECTOR, readSystem, type GoogleDeps } from "../../../src/connectors/google/searchconsole.js";
import { pullDue, startSchedule } from "../../../src/connectors/google/schedule.js";
import { googleSettings } from "../../../src/connectors/google/settings.js";
import { FileTokenStore } from "../../../src/connectors/google/store.js";
import { analyticsFor, FakeGoogle, tokens } from "../../helpers/fake-google.js";
import { testGraph } from "../../helpers/graph.js";

vi.setConfig({ testTimeout: 90_000 }); // a first read writes about 400 numbers per business; a loaded suite needs room

const KEY = "test-connector-key-0123456789abcdef0123456789abcdef";
const NOW0 = Date.parse("2026-10-15T09:00:00Z");
const HOUR = 3_600_000;

describe("pullDue", () => {
  const graphs: Record<string, GraphHandle> = {};
  const cleanups: Array<() => Promise<void>> = [];
  let dir: string;
  let clock = NOW0;
  let google: FakeGoogle;
  let deps: GoogleDeps;
  const tenants = ["alpha_shop", "bravo_shop", "charlie_shop", "delta_shop"];
  const list = async () => tenants.map((slug) => ({ slug }));
  const logs: string[] = [];
  const due = () => pullDue({ google: deps, tenants: list, openGraph: async (s) => graphs[s]!, log: (l) => logs.push(l) });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "allevia-gsc-sched-"));
    google = new FakeGoogle({
      codes: Object.fromEntries(tenants.map((t) => [`code-${t}`, tokens(t.slice(0, 5))])),
      sites: [{ siteUrl: "sc-domain:shop.example", permissionLevel: "siteOwner" }],
      analytics: analyticsFor({}),
    });
    deps = { settings: googleSettings({ clientId: "test-client-id.apps.example", clientSecret: "test-client-secret-xxxxxxxxxxxx", redirectUri: "https://allevia.example/cb", connectorKey: KEY }), store: new FileTokenStore(dir, KEY), client: google, now: () => clock };
    for (const t of tenants) {
      const { g, cleanup } = await testGraph();
      graphs[t] = g;
      cleanups.push(cleanup);
      await upsertNode(g, { type: "Business", id: `business:${t.replace(/_/g, "-")}`, name: t, props: { domain: "shop.example" } }, NOW0);
    }
    // alpha and bravo connect; charlie never does; delta connected but still has to pick a website
    await handleCallback(deps, graphs.alpha_shop!, "alpha_shop", "code-alpha_shop");
    await handleCallback(deps, graphs.bravo_shop!, "bravo_shop", "code-bravo_shop");
    google.script.sites = [{ siteUrl: "https://a.example/", permissionLevel: "siteOwner" }, { siteUrl: "https://b.example/", permissionLevel: "siteOwner" }];
    await handleCallback(deps, graphs.delta_shop!, "delta_shop", "code-delta_shop");
    google.script.sites = [{ siteUrl: "sc-domain:shop.example", permissionLevel: "siteOwner" }];
  }, 60_000);

  afterAll(async () => {
    for (const c of cleanups) await c();
    rmSync(dir, { recursive: true, force: true });
    await closeAll();
  });

  it("reads the connected businesses once, and says nothing about the ones that never connected", async () => {
    const out = await due();
    expect(out.map((o) => [o.tenant, "result" in o ? o.result.status : o.skipped])).toEqual([["alpha_shop", "ok"], ["bravo_shop", "ok"], ["delta_shop", "no website chosen"]]);
    expect(google.calls.filter((c) => c.op === "searchAnalytics")).toHaveLength(6); // three reads each for two businesses
    expect((await readSystem(graphs.alpha_shop!))?.lastPullAt).toBe(NOW0);
  });

  it("does not read a business again within the day", async () => {
    clock += 10 * HOUR;
    google.calls.length = 0;
    const out = await due();
    expect(out.filter((o) => "skipped" in o && o.skipped === "read recently").map((o) => o.tenant)).toEqual(["alpha_shop", "bravo_shop"]);
    expect(google.calls).toEqual([]);
  });

  it("reads again after a day; one business failing does not stop the next", async () => {
    clock += 12 * HOUR;
    // alpha's access is refused for good; bravo is fine
    const alpha = (await deps.store.get("alpha_shop", CONNECTOR))!;
    await deps.store.put("alpha_shop", CONNECTOR, { ...alpha, expiresAt: 0 });
    google.refusedRefreshTokens.add(alpha.refreshToken);
    const out = await due();
    const by = Object.fromEntries(out.map((o) => [o.tenant, "result" in o ? o.result.status : o.skipped]));
    expect(by).toEqual({ alpha_shop: "needs_reconnect", bravo_shop: "ok", delta_shop: "no website chosen" });
    expect(logs.join("\n")).toMatch(/alpha_shop: needs_reconnect: Google stopped letting us read Search Console/);
    // an expired connection is not retried every hour: it waits for the owner
    google.calls.length = 0;
    const again = await due();
    expect(again.find((o) => o.tenant === "alpha_shop")).toEqual({ tenant: "alpha_shop", skipped: "needs the owner to connect again" });
  });

  it("does nothing at all when the server has no Google credentials", async () => {
    const off = await pullDue({ google: { ...deps, settings: googleSettings({ redirectUri: "https://allevia.example/cb" }) }, tenants: list, openGraph: async (s) => graphs[s]!, log: () => undefined });
    expect(off).toEqual([]);
  });

  it("starts a timer that can be stopped", async () => {
    const stop = startSchedule({ google: { ...deps, settings: googleSettings({ redirectUri: "https://allevia.example/cb" }) }, tenants: list, openGraph: async (s) => graphs[s]!, log: () => undefined }, { everyMs: 5, firstDelayMs: 1 });
    await new Promise((r) => setTimeout(r, 30));
    stop();
  });
});
