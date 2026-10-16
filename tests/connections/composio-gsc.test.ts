// Composio (fake) for the long tail, Search Console through the framework, and the page's list: groups, one line each, states.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAll } from "../../src/graph/client.js";
import { composioUserId } from "../../src/connections/composio.js";
import { GROUP_ORDER, NotConnectedError } from "../../src/connections/types.js";
import { analyticsFor } from "../helpers/fake-google.js";
import { connectVia, connHarness, grant, KEY, type ConnHarness } from "./harness.js";

let h: ConnHarness;
beforeAll(async () => {
  h = await connHarness();
  h.google.script.codes = { sc: grant("sc", "webmasters.readonly") };
  h.google.script.sites = [{ siteUrl: "sc-domain:aamdani.example", permissionLevel: "siteOwner" }];
  h.google.script.analytics = analyticsFor({ pages: [], queries: ["jobs in raipur"] });
}, 90_000);
afterAll(async () => { await h.cleanup(); await closeAll(); });

async function connectShopify(tenant: string) {
  const { url } = await h.svc.connect(tenant, "shopify");
  const link = h.composio.calls.filter((c) => c.op === "link").at(-1)!.args as { callbackUrl: string; userId: string };
  const accountId = new URL(url).pathname.split("/").pop()!;
  h.composio.activate(accountId);
  const state = new URL(link.callbackUrl).searchParams.get("state")!;
  return { state, accountId, link };
}

describe("Composio", () => {
  it("is off, and plainly explained, without a key", async () => {
    const off = await connHarness({ graph: false });
    try {
      const noKey = new (await import("../../src/connections/composio.js")).ComposioConnector(
        (await import("../../src/connections/composio.js")).COMPOSIO_SPECS[4]!, { apiKey: "", client: null, connectorKey: KEY });
      const a = noKey.availability();
      expect(a.ok).toBe(false);
      expect(a.missing.map((m) => m.setting)).toEqual(["COMPOSIO_API_KEY"]);
      expect(a.message).toMatch(/isn't switched on yet/);
      expect(a.message).not.toMatch(/COMPOSIO|key/i);
    } finally { await off.cleanup(); }
  });

  it("connects through a link made for this business's own opaque user id, and stores only the account id, sealed", async () => {
    const { state, accountId, link } = await connectShopify("kestrel");
    expect(link.userId).toBe(composioUserId(KEY, "kestrel"));
    expect(link.userId).not.toContain("kestrel");
    const done = await h.svc.complete(state, { status: "success", connected_account_id: accountId });
    expect(done?.outcome.result).toBe("connected");
    expect((await h.svc.view("kestrel", "shopify")).state).toBe("connected");
    expect(await h.svc.vault.list("kestrel")).toEqual(["shopify"]);
  });

  it("will not take an account that is another business's, inactive, or for another toolkit", async () => {
    const mine = await connectShopify("zed_shop");
    const other = await connectShopify("kestrel");
    // the address bar says zed_shop's state but kestrel's account
    const bad = await h.svc.complete(mine.state, { status: "success", connected_account_id: other.accountId });
    expect(bad?.outcome).toEqual({ result: "problem", reason: "not_active" });
    expect((await h.svc.view("zed_shop", "shopify")).state).toBe("not_connected");
    const { state, accountId } = await (async () => {
      const { url } = await h.svc.connect("late_shop", "shopify");
      const l = h.composio.calls.filter((c) => c.op === "link").at(-1)!.args as { callbackUrl: string };
      return { state: new URL(l.callbackUrl).searchParams.get("state")!, accountId: new URL(url).pathname.split("/").pop()! };
    })();
    expect((await h.svc.complete(state, { status: "success", connected_account_id: accountId }))?.outcome).toEqual({ result: "problem", reason: "not_active" }); // never activated
    expect((await (async () => { const s = await h.svc.connect("x_shop", "hubspot"); const l = h.composio.calls.filter((c) => c.op === "link").at(-1)!.args as { callbackUrl: string }; const id = new URL(s.url).pathname.split("/").pop()!; h.composio.activate(id); return h.svc.complete(new URL(l.callbackUrl).searchParams.get("state")!, { status: "success", connected_account_id: id }); })())?.outcome.result).toBe("connected");
  });

  it("a tool call runs as the business and refuses for a business that has not connected", async () => {
    h.composio.results.set("SHOPIFY_LIST_ORDERS", { orders: 3 });
    const out = await h.svc.port("kestrel").run<{ execute(t: string, a: Record<string, unknown>): Promise<unknown> }, unknown>("shopify", "list orders", (s) => s.execute("SHOPIFY_LIST_ORDERS", {}));
    expect(out).toEqual({ orders: 3 });
    const call = h.composio.calls.filter((c) => c.op === "execute").at(-1)!.args as { userId: string };
    expect(call.userId).toBe(composioUserId(KEY, "kestrel"));
    await expect(h.svc.port("nobody_shop").run("shopify", "list orders", async () => 1)).rejects.toBeInstanceOf(NotConnectedError);
    expect((await h.audit.recent("nobody_shop"))[0]).toMatchObject({ op: "list orders", ok: false });
  });

  it("disconnect deletes the Composio account and the stored id", async () => {
    await h.svc.disconnect("kestrel", "shopify");
    expect((await h.svc.view("kestrel", "shopify")).state).toBe("not_connected");
    expect(h.composio.calls.some((c) => c.op === "deleteAccount")).toBe(true);
  });

  it("WhatsApp is coming soon and cannot be connected", async () => {
    const v = await h.svc.view("kestrel", "whatsapp");
    expect(v).toMatchObject({ available: false, soon: true });
    await expect(h.svc.connect("kestrel", "whatsapp")).rejects.toThrow(/coming soon/);
  });
});

describe("Search Console through the framework", () => {
  it("connects with PKCE, reads, and answers live questions through the same port", async () => {
    const r = await connectVia(h, "gsc_shop", "search-console", "sc");
    expect(r.url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(r.done?.outcome.result).toBe("connected");
    const v = await h.svc.view("gsc_shop", "search-console");
    expect(v).toMatchObject({ state: "connected", selected: "sc-domain:aamdani.example" });
    const rows = await h.svc.port("gsc_shop").run<{ query(q: { startDate: string; endDate: string; dimensions: Array<"query"> }): Promise<unknown[]> }, unknown[]>("search-console", "top searches", (s) => s.query({ startDate: "2026-09-01", endDate: "2026-09-28", dimensions: ["query"] }));
    expect(rows.length).toBe(1);
    await expect(h.svc.port("other_gsc").run("search-console", "top searches", async () => 1)).rejects.toBeInstanceOf(NotConnectedError);
  });
});

describe("the list an owner reads", () => {
  it("is grouped Google, Meta, Commerce and money, Customers, Team, each with one line on what the team does", async () => {
    const list = await h.svc.list("kestrel");
    const groups = [...new Set(list.map((c) => c.group))];
    expect(groups).toEqual(GROUP_ORDER);
    for (const c of list) { expect(c.blurb.length, c.id).toBeGreaterThan(20); expect(c.blurb, c.id).not.toMatch(/\b(token|scope|API|OAuth)\b/i); }
    expect(list.map((c) => c.id)).toEqual(expect.arrayContaining(["google-calendar", "gmail", "search-console", "google-analytics", "google-ads", "shopify", "hubspot", "stripe", "slack", "instagram"]));
  });

  it("the daily read visits only connected businesses and says what it skipped", async () => {
    const out = await h.svc.pullDue([{ slug: "gsc_shop" }, { slug: "never_shop" }], { force: true, log: () => undefined });
    expect(out.map((o) => `${o.tenant}/${o.connector}`)).toEqual(["gsc_shop/search-console"]);
    expect(out[0]).toMatchObject({ ok: true });
    const again = await h.svc.pullDue([{ slug: "gsc_shop" }], { log: () => undefined });
    expect(again[0]).toMatchObject({ skipped: "read recently" });
  });
});
