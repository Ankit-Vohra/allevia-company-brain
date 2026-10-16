// The Google connections against a fake Google: the owner's trip (PKCE, a single-use state, per-business grants), "not switched
// on" naming the settings, the permissions the owner ticked, refresh and "needs attention", picking a property, the daily reads
// feeding the capability ladder, revocation, and one business never reaching another's grant.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAll } from "../../src/graph/client.js";
import { deriveCapabilities } from "../../src/capabilities/ladder.js";
import { NeedsAttentionError, NotConfiguredError, NotConnectedError } from "../../src/connections/types.js";
import { ga4Days } from "../helpers/fake-google-apis.js";
import { connectVia, connHarness, grant, NOW, type ConnHarness } from "./harness.js";
import type { GoogleSession } from "../../src/connections/google/product.js";

let h: ConnHarness;
beforeAll(async () => {
  h = await connHarness({
    codes: {},
    apis: { busy: [{ start: "2026-10-16T05:00:00Z", end: "2026-10-16T06:00:00Z" }], properties: [{ property: "properties/111", displayName: "Shop site" }], ga4: ga4Days(), customers: [{ id: "1234567890" }], campaigns: [{ id: "1", name: "Search", status: "ENABLED", costMicros: 25_000_000, clicks: 100, impressions: 4000, conversions: 5 }] },
  });
  h.google.script.codes = {
    cal: grant("cal", "calendar.freebusy", "calendar.events"), "cal-partial": grant("calp", "calendar.events"),
    gm: grant("gm", "gmail.send"), ga: grant("ga", "analytics.readonly"), ads: grant("ads", "adwords"),
  };
}, 90_000);
afterAll(async () => { await h.cleanup(); await closeAll(); });

describe("not switched on", () => {
  it("names the settings the founder is missing, and says nothing technical to an owner", async () => {
    const bare = await connHarness({ env: { ALLEVIA_GOOGLE_CLIENT_ID: "", ALLEVIA_GOOGLE_CLIENT_SECRET: "" }, graph: false });
    try {
      const cal = bare.svc.connector("google-calendar").availability();
      expect(cal.ok).toBe(false);
      expect(cal.missing.map((m) => m.setting)).toEqual(["ALLEVIA_GOOGLE_CLIENT_ID", "ALLEVIA_GOOGLE_CLIENT_SECRET"]);
      expect(cal.message).toMatch(/isn't switched on yet/);
      expect(cal.message).not.toMatch(/ALLEVIA_|client|secret|token/i);
      await expect(bare.svc.connect("kestrel", "google-calendar")).rejects.toBeInstanceOf(NotConfiguredError);
      expect(bare.google.calls).toEqual([]);
    } finally { await bare.cleanup(); }
  });

  it("Google Ads also needs the developer token", async () => {
    const bare = await connHarness({ env: { ALLEVIA_GOOGLE_ADS_DEVELOPER_TOKEN: "" }, graph: false });
    try {
      expect(bare.svc.connector("google-ads").availability().missing.map((m) => m.setting)).toEqual(["ALLEVIA_GOOGLE_ADS_DEVELOPER_TOKEN"]);
      expect(bare.svc.connector("google-calendar").availability().ok).toBe(true);
    } finally { await bare.cleanup(); }
  });
});

describe("the owner's trip", () => {
  it("asks only for this product's permissions, with PKCE, and not the other products'", async () => {
    const { url } = await h.svc.connect("kestrel", "google-calendar");
    const q = url.startsWith("https://accounts.google.com/o/oauth2/v2/auth?") ? new URL(url).searchParams : null;
    expect(q).not.toBeNull();
    expect(q!.get("scope")!.split(" ").sort()).toEqual(["email", "https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.freebusy", "openid"]);
    expect(q!.get("code_challenge_method")).toBe("S256");
    expect(q!.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q!.get("include_granted_scopes")).toBe("false");
    expect(q!.get("access_type")).toBe("offline");
    expect((await h.svc.connect("kestrel", "gmail")).url).not.toMatch(/calendar/);
  });

  it("sends the verifier that matches the challenge when the code is exchanged", async () => {
    const { createHash } = await import("node:crypto");
    const r = await connectVia(h, "kestrel", "google-calendar", "cal");
    expect(r.done).toMatchObject({ tenant: "kestrel", id: "google-calendar", outcome: { result: "connected" } });
    const call = h.google.calls.filter((c) => c.op === "exchangeCode").at(-1)!;
    const verifier = call.args[1] as string;
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(r.url.searchParams.get("code_challenge"));
    expect(r.url.toString()).not.toContain(verifier);
  });

  it("a state works once, expires, and cannot be forged or moved to another business", async () => {
    const { url } = await h.svc.connect("kestrel", "gmail");
    const state = new URL(url).searchParams.get("state")!;
    expect(await h.svc.complete("forged.state", { code: "gm" })).toBeNull();
    expect(await h.svc.complete(state.split(".")[0] + ".AAAA", { code: "gm" })).toBeNull();
    expect((await h.svc.complete(state, { code: "gm" }))?.outcome.result).toBe("connected");
    expect(await h.svc.complete(state, { code: "gm" })).toBeNull(); // used up
    const { url: u2 } = await h.svc.connect("kestrel", "gmail");
    h.clock.now = NOW + 11 * 60_000;
    expect(await h.svc.complete(new URL(u2).searchParams.get("state")!, { code: "gm" })).toBeNull();
    h.clock.now = NOW;
  });

  it("denied, a missing permission and no lasting access each end in words, storing nothing", async () => {
    const t = "denied_shop";
    const { url } = await h.svc.connect(t, "google-calendar");
    expect((await h.svc.complete(new URL(url).searchParams.get("state")!, { error: "access_denied" }))?.outcome.result).toBe("denied");
    const r = await connectVia(h, t, "google-calendar", "cal-partial");
    expect(r.done?.outcome).toEqual({ result: "problem", reason: "missing_scope" });
    h.google.script.codes!.norefresh = { ...grant("nr", "gmail.send"), refreshToken: undefined };
    const r2 = await connectVia(h, t, "gmail", "norefresh");
    expect(r2.done?.outcome).toEqual({ result: "problem", reason: "no_refresh" });
    expect((await h.svc.view(t, "google-calendar")).state).toBe("not_connected");
    expect(await h.svc.vault.list(t)).toEqual([]);
  });

  it("keeps each business's grant apart: one business's connection is not another's", async () => {
    await connectVia(h, "alpha_shop", "gmail", "gm");
    expect((await h.svc.view("alpha_shop", "gmail")).state).toBe("connected");
    expect((await h.svc.view("beta_shop", "gmail")).state).toBe("not_connected");
    await expect(h.svc.port("beta_shop").run("gmail", "send", async () => 1)).rejects.toBeInstanceOf(NotConnectedError);
    // a state made for one business cannot finish a connection for another
    const { url } = await h.svc.connect("alpha_shop", "google-analytics");
    const done = await h.svc.complete(new URL(url).searchParams.get("state")!, { code: "ga" });
    expect(done?.tenant).toBe("alpha_shop");
    expect(await h.svc.vault.list("beta_shop")).toEqual([]);
  });

  it("a one-time link for Discord starts the trip once, for the business it was made for", () => {
    const link = h.svc.connectLink("kestrel", "google-calendar");
    expect(link.startsWith("https://allevia.example/c/")).toBe(true);
    const code = link.split("/c/")[1]!;
    expect(h.svc.redeemLink(code)).toEqual({ tenant: "kestrel", id: "google-calendar", options: {} });
    expect(h.svc.redeemLink(code)).toBeNull();
    expect(h.svc.redeemLink("nonsense")).toBeNull();
  });
});

describe("using a connection", () => {
  it("refreshes an old access token, and the call and the refresh are audited without secrets", async () => {
    const t = "refresh_shop";
    await connectVia(h, t, "google-calendar", "cal");
    h.clock.now = NOW + 2 * 3_600_000;
    const before = h.google.refreshes;
    const busy = await h.svc.port(t, { actor: "ops-manager" }).run<GoogleSession, unknown>("google-calendar", "find free times", (s) => s.apis.freeBusy(s.accessToken, { timeMin: "a", timeMax: "b" }));
    h.clock.now = NOW;
    expect(busy).toHaveLength(1);
    expect(h.google.refreshes).toBe(before + 1);
    const log = await h.audit.recent(t);
    expect(log[0]).toMatchObject({ connector: "google-calendar", op: "find free times", ok: true, actor: "ops-manager" });
    expect(JSON.stringify(log)).not.toMatch(/access-token|refresh-token/);
  });

  it("when Google refuses the token once it refreshes and tries again; when it keeps refusing the connection needs attention and the ladder drops", async () => {
    const t = "attention_shop";
    await connectVia(h, t, "google-calendar", "cal");
    h.apis.authFailuresLeft = 1;
    const ok = await h.svc.port(t).run<GoogleSession, unknown>("google-calendar", "find free times", (s) => s.apis.freeBusy(s.accessToken, { timeMin: "a", timeMax: "b" }));
    expect(ok).toHaveLength(1);
    h.apis.failWith = "auth";
    await expect(h.svc.port(t).run<GoogleSession, unknown>("google-calendar", "find free times", (s) => s.apis.freeBusy(s.accessToken, { timeMin: "a", timeMax: "b" }))).rejects.toBeInstanceOf(NeedsAttentionError);
    h.apis.failWith = null;
    const v = await h.svc.view(t, "google-calendar");
    expect(v.state).toBe("needs_attention");
    await expect(h.svc.port(t).run("google-calendar", "again", async () => 1)).rejects.toThrow(/connect it again/i);
    expect((await h.audit.recent(t)).some((e) => !e.ok)).toBe(true);
  });

  it("a revoked refresh token marks it needs attention at the next refresh", async () => {
    const t = "revoked_shop";
    await connectVia(h, t, "gmail", "gm");
    h.google.failRefresh = "auth";
    h.clock.now = NOW + 2 * 3_600_000;
    await expect(h.svc.port(t).run("gmail", "send", async () => 1)).rejects.toBeInstanceOf(NeedsAttentionError);
    h.google.failRefresh = null;
    h.clock.now = NOW;
    expect((await h.svc.view(t, "gmail")).state).toBe("needs_attention");
    expect((await h.svc.health(t, "gmail")).ok).toBe(false);
  });

  it("an opted-in inbox is reported as an extra the owner allowed, and only then", async () => {
    await connectVia(h, "inbox_shop", "gmail", "gm");
    expect((await h.svc.view("inbox_shop", "gmail")).extras).toBeUndefined();
    h.google.script.codes!.gmr = grant("gmr", "gmail.send", "gmail.readonly");
    const r = await connectVia(h, "inbox_shop2", "gmail", "gmr", { inbox: "1" });
    expect(r.url.searchParams.get("scope")).toContain("gmail.readonly");
    expect((await h.svc.view("inbox_shop2", "gmail")).extras).toEqual(["Your team can read your inbox"]);
  });
});

describe("Analytics and Ads: picking, the daily read, the ladder", () => {
  // the ladder is per graph and the businesses above share one, so this block has its own
  let h2: ConnHarness;
  beforeAll(async () => {
    h2 = await connHarness({ apis: { properties: [{ property: "properties/111", displayName: "Shop site" }], ga4: ga4Days(), customers: [{ id: "1234567890" }], campaigns: [{ id: "1", name: "Search", status: "ENABLED", costMicros: 25_000_000, clicks: 100, impressions: 4000, conversions: 5 }] } });
    h2.google.script.codes = { ...h.google.script.codes };
  }, 60_000);
  afterAll(async () => { await h2.cleanup(); });
  it("one property is used at once; the daily read writes numbers and the ladder reads them live", async () => {
    const t = "ga_shop";
    const r = await connectVia(h2, t, "google-analytics", "ga");
    expect(r.done?.outcome.result).toBe("connected");
    expect((await h2.svc.view(t, "google-analytics")).selected).toBe("Shop site (111)");
    const pulled = await h2.svc.pull(t, "google-analytics");
    expect(pulled.ok).toBe(true);
    const caps = await deriveCapabilities(h2.g, { now: NOW });
    expect(caps.find((c) => c.key === "ga4")).toMatchObject({ accessMode: "api", status: "ok" });
    expect((await h2.svc.view(t, "google-analytics")).lastReadAt).toBeDefined();
  });

  it("several accounts are left for the owner to pick, and picking one starts the read", async () => {
    h2.apis.script.properties = [{ property: "properties/1", displayName: "Shop" }, { property: "properties/2", displayName: "Blog" }];
    const t = "pick_shop";
    const r = await connectVia(h2, t, "google-analytics", "ga");
    expect(r.done?.outcome.result).toBe("choose");
    const v = await h2.svc.view(t, "google-analytics");
    expect(v.choose?.options).toEqual(["Shop (1)", "Blog (2)"]);
    await expect(h2.svc.port(t).run("google-analytics", "report", async () => 1)).rejects.toBeInstanceOf(NeedsAttentionError);
    await expect(h2.svc.select(t, "google-analytics", "nope")).rejects.toThrow(/isn't one/);
    expect((await h2.svc.select(t, "google-analytics", "Blog (2)")).selected).toBe("Blog (2)");
    h2.apis.script.properties = [{ property: "properties/111", displayName: "Shop site" }];
  });

  it("Ads: the account is found, the read writes spend and the ladder moves to live", async () => {
    const t = "ads_shop";
    await connectVia(h2, t, "google-ads", "ads");
    expect((await h2.svc.pull(t, "google-ads")).ok).toBe(true);
    expect((await deriveCapabilities(h2.g, { now: NOW })).find((c) => c.key === "ads")).toMatchObject({ accessMode: "api" });
    const spend = await h2.g.roQuery<{ v: number }>("MATCH (o:Observation {metric:'ads_spend'}) RETURN o.value AS v");
    expect(spend[0]!.v).toBe(25);
  });

  it("Calendar and Gmail connections put the doing capabilities live, and disconnecting takes them down", async () => {
    await connectVia(h2, "cap_shop", "google-calendar", "cal");
    await connectVia(h2, "cap_shop", "gmail", "gm");
    let caps = await deriveCapabilities(h2.g, { now: NOW });
    expect(caps.find((c) => c.key === "calendar")).toMatchObject({ accessMode: "api", status: "ok" });
    expect(caps.find((c) => c.key === "email")).toMatchObject({ accessMode: "api", status: "ok" });
    await h2.svc.disconnect("cap_shop", "google-calendar");
    await h2.svc.disconnect("cap_shop", "gmail");
    caps = await deriveCapabilities(h2.g, { now: NOW });
    expect(caps.find((c) => c.key === "calendar")).toMatchObject({ accessMode: "none" });
    expect(caps.find((c) => c.key === "email")?.upgradeHint).toMatch(/Connect Gmail on the Connections page/);
  });
});

describe("revocation", () => {
  it("disconnect asks Google to revoke and forgets the sealed grant; revokeAll forgets every connection of that business only", async () => {
    await connectVia(h, "rev_shop", "gmail", "gm");
    await connectVia(h, "rev_shop", "google-calendar", "cal");
    await connectVia(h, "keep_shop", "gmail", "gm");
    const revoked = h.google.revoked.length;
    await h.svc.disconnect("rev_shop", "gmail");
    expect(h.google.revoked.length).toBe(revoked + 1);
    expect(await h.svc.vault.list("rev_shop")).toEqual(["google-calendar"]);
    const r = await h.svc.revokeAll("rev_shop");
    expect(r.disconnected).toEqual(["google-calendar"]);
    expect(await h.svc.vault.list("rev_shop")).toEqual([]);
    expect(await h.svc.vault.list("keep_shop")).toEqual(["gmail"]);
    expect((await h.audit.recent("rev_shop")).some((e) => e.op === "revoked everything")).toBe(true);
  });
});
