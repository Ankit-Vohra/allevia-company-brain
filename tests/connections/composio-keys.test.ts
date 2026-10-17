// Tools connected with a key the owner pastes (Composio toolkits with no sign-in app of Composio's own, such as Higgsfield), against
// the fake Composio: Connect asks for the key instead of sending the owner away; the key goes to Composio and nowhere else (not the
// sealed store, the audit log, the server log or any answer); only the connected account's id is kept, sealed; a harmless read
// says how it stands ("Higgsfield connected: 1,200 credits left."); every Composio failure is one plain sentence and a 4xx. Tools
// with Composio's own sign-in connect exactly as before.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { closeAll } from "../../src/graph/client.js";
import { checkHeadline, ComposioError, composioUserId, keyScheme, realComposioClient, type ToolkitAuth } from "../../src/connections/composio.js";
import { ConnectProblem } from "../../src/connections/types.js";
import { harness, post, type Harness } from "../server/harness.js";
import { connHarness, KEY, WEB, type ConnHarness } from "./harness.js";

const TENANT = "mini";
const KEY_ID = "hf-keyid-TEST-4f1c2a";
const SECRET = "hf-secret-TEST-9d8e7b6a";

// Higgsfield as Composio described it on 17 Oct 2026 (GET /toolkits/higgsfield): no managed auth, API_KEY with two fields.
const HIGGSFIELD: ToolkitAuth = {
  name: "Higgsfield", managed: [], hint: "https://cloud.higgsfield.ai/api-keys",
  schemes: [{
    mode: "API_KEY", needsConfig: false, hint: "https://cloud.higgsfield.ai/api-keys",
    fields: [
      { name: "generic_api_key", label: "API Key ID", description: "The key ID from the Higgsfield Cloud API Keys page.", secret: true },
      { name: "generic_token", label: "API Key Secret", description: "The secret paired with your key ID.", secret: true },
    ],
  }],
};
// Higgsfield MCP: sign-in with dynamic client registration, nothing of ours to set up.
const HIGGSFIELD_MCP: ToolkitAuth = { name: "Higgsfield MCP", managed: [], schemes: [{ mode: "DCR_OAUTH", needsConfig: false, fields: [] }] };

let c: ConnHarness;
let h: Harness;
let app: Harness["app"];
let logs: string[] = [];
let spies: MockInstance[] = [];

beforeAll(async () => {
  c = await connHarness({ via: "composio" });
  h = await harness();
  app = h.make({ connections: async () => ({ service: c.svc, webBaseUrl: WEB }), log: (l) => logs.push(l) });
}, 90_000);
afterAll(async () => { await c.cleanup(); await h.cleanup(); await closeAll(); });
beforeEach(() => {
  logs = [];
  c.composio.auth.set("higgsfield", HIGGSFIELD);
  c.composio.auth.set("higgsfield_mcp", HIGGSFIELD_MCP);
  c.composio.auth.set("onekey", { name: "OneKey", managed: [], schemes: [{ mode: "API_KEY", needsConfig: false, fields: [] }] });
  c.composio.auth.set("ownapp", { name: "OwnApp", managed: [], schemes: [{ mode: "OAUTH2", needsConfig: true, fields: [] }] });
  c.composio.goodKeys.set("higgsfield", { generic_api_key: KEY_ID, generic_token: SECRET });
  c.composio.toolList.set("higgsfield", [
    { slug: "HIGGSFIELD_GENERATE_IMAGE", name: "Generate", description: "", params: { required: ["prompt"], properties: ["prompt"] } },
    { slug: "HIGGSFIELD_GET_BALANCE", name: "Balance", description: "", params: { required: [], properties: [] } },
  ]);
  c.composio.results.set("HIGGSFIELD_GET_BALANCE", { data: { credits: 1200 } });
  const keep = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  spies = (["log", "error", "warn", "info", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(keep));
});
afterEach(async () => {
  for (const s of spies) s.mockRestore();
  for (const id of ["app-higgsfield", "app-onekey"]) await c.svc.disconnect(TENANT, id).catch(() => undefined);
});

/** Every byte the connections service wrote to disk (the sealed store), as text. */
function onDisk(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else out.push(readFileSync(p).toString("latin1")); } };
  walk(dir);
  return out.join("\n");
}
const leaked = (text: string) => text.includes(KEY_ID) || text.includes(SECRET);

describe("how a toolkit signs in", () => {
  it("picks the key scheme an owner can paste, API keys first, and never one needing our own app", () => {
    expect(keyScheme(HIGGSFIELD)?.mode).toBe("API_KEY");
    expect(keyScheme(HIGGSFIELD_MCP)).toBeUndefined();
    expect(keyScheme({ name: "x", managed: [], schemes: [{ mode: "BASIC", needsConfig: false, fields: [] }, { mode: "BEARER_TOKEN", needsConfig: false, fields: [] }] })?.mode).toBe("BEARER_TOKEN");
    expect(keyScheme({ name: "x", managed: [], schemes: [{ mode: "API_KEY", needsConfig: true, fields: [] }] })).toBeUndefined();
  });

  it("reads the balance a tool answers as one line", () => {
    expect(checkHeadline("HIGGSFIELD_GET_BALANCE", { data: { credits: 1200 } })).toBe("1,200 credits left");
    expect(checkHeadline("X_GET_BALANCE", { balance: "1" })).toBe("balance 1");
    expect(checkHeadline("X_GET_CREDITS", { remaining: 1 })).toBe("1 credit left");
    expect(checkHeadline("X_GET_ME", { name: "Ana" })).toBeUndefined();
  });

  it("the real client reads Composio's toolkit description and sends the key in the connection's state, to Composio only", async () => {
    const sent: Array<{ url: string; body: unknown }> = [];
    const fetchFn = (async (url: string, init?: { body?: string }) => {
      sent.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
      const json = url.endsWith("/toolkits/higgsfield")
        ? { name: "Higgsfield", composio_managed_auth_schemes: [], auth_config_details: [{ mode: "API_KEY", auth_hint_url: "https://cloud.higgsfield.ai/api-keys", fields: { auth_config_creation: { required: [] }, connected_account_initiation: { required: [{ name: "generic_api_key", displayName: "API Key ID", is_secret: true }, { name: "generic_token", displayName: "API Key Secret", is_secret: true }] } } }] }
        : url.includes("/auth_configs?") ? { items: [{ id: "ac_managed", auth_scheme: "OAUTH2", is_composio_managed: true }] }
        : url.endsWith("/auth_configs") ? { auth_config: { id: "ac_key" } }
        : { id: "ca_9", status: "ACTIVE" };
      return new Response(JSON.stringify(json), { status: 200 });
    }) as unknown as Parameters<typeof realComposioClient>[1];
    const real = realComposioClient("test-key", fetchFn);
    const a = await real.authInfo("higgsfield");
    expect(a).toMatchObject({ name: "Higgsfield", managed: [], schemes: [{ mode: "API_KEY", needsConfig: false, hint: "https://cloud.higgsfield.ai/api-keys", fields: [{ name: "generic_api_key", label: "API Key ID" }, { name: "generic_token" }] }] });
    // a managed config for the same toolkit is not reused for a key: ours is made with use_custom_auth and the scheme
    expect(await real.authConfigId("higgsfield", "API_KEY")).toBe("ac_key");
    expect(sent.at(-1)!.body).toEqual({ toolkit: { slug: "higgsfield" }, auth_config: { type: "use_custom_auth", authScheme: "API_KEY", credentials: {} } });
    expect(await real.createAccount({ authConfigId: "ac_key", userId: "al_x", scheme: "API_KEY", values: { generic_api_key: KEY_ID, generic_token: SECRET } })).toEqual({ id: "ca_9", status: "ACTIVE" });
    expect(sent.at(-1)).toEqual({
      url: "https://backend.composio.dev/api/v3/connected_accounts",
      body: { auth_config: { id: "ac_key" }, connection: { user_id: "al_x", state: { authScheme: "API_KEY", val: { status: "ACTIVE", generic_api_key: KEY_ID, generic_token: SECRET } } } },
    });
  });
});

describe("connecting with a key", () => {
  it("a tool with Composio's own sign-in connects as before: the hosted page, no key asked", async () => {
    const { url, key } = await c.svc.connect(TENANT, "app-notion");
    expect(key).toBeUndefined();
    expect(url).toMatch(/^https:\/\/composio\.example\/connect\/ca_/);
    expect(c.composio.calls.filter((x) => x.op === "authConfigId").at(-1)!.args).toBe("notion");
  });

  it("Connect on Higgsfield asks for its key: the fields Composio lists, where to find them, and no trip anywhere", async () => {
    const links = c.composio.calls.filter((x) => x.op === "link").length;
    const start = await c.svc.connect(TENANT, "app-higgsfield");
    expect(start.key).toEqual({
      tool: "Higgsfield", hint: "https://cloud.higgsfield.ai/api-keys",
      fields: [
        { name: "generic_api_key", label: "API Key ID", help: expect.any(String), secret: true },
        { name: "generic_token", label: "API Key Secret", help: expect.any(String), secret: true },
      ],
    });
    expect(start.url).toBe(`${WEB}/connections?connect=app-higgsfield`); // a link opened from Discord lands on the sheet's page
    expect(c.composio.calls.filter((x) => x.op === "link")).toHaveLength(links);
  });

  it("the pasted key reaches Composio, only the account id is sealed, and nothing anywhere holds the key", async () => {
    const r = await c.svc.connectWithKey(TENANT, "app-higgsfield", { generic_api_key: ` ${KEY_ID} `, generic_token: SECRET });
    expect(r.message).toBe("Higgsfield connected: 1,200 credits left.");
    expect(r.view).toMatchObject({ id: "app-higgsfield", name: "Higgsfield", state: "connected", message: "Higgsfield connected: 1,200 credits left." });
    expect(c.composio.received.at(-1)).toEqual({ generic_api_key: KEY_ID, generic_token: SECRET });
    expect(c.composio.calls.filter((x) => x.op === "authConfigId").at(-1)!.args).toEqual({ toolkit: "higgsfield", custom: "API_KEY" });
    const stored = await c.svc.vault.get(TENANT, "app-higgsfield") as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(["accountId", "at", "headline", "name", "readAt", "userId"]);
    expect(stored.userId).toBe(composioUserId(KEY, TENANT));
    expect(leaked(JSON.stringify(stored))).toBe(false);
    expect(leaked(onDisk(c.dir))).toBe(false);
    const audit = await c.audit.recent(TENANT, { limit: 50 });
    expect(audit.map((e) => e.op)).toContain("connected with a key");
    expect(leaked(JSON.stringify(audit))).toBe(false);
    expect(leaked(logs.join("\n"))).toBe(false);
    // the check ran a harmless read, as this business, and nothing that makes anything
    expect(c.composio.executed().filter((x) => x.accountId === stored.accountId).map((x) => x.tool)).toEqual(["HIGGSFIELD_GET_BALANCE"]);
    // shown in the list, and Disconnect works as for any tool
    expect((await c.svc.list(TENANT)).find((v) => v.id === "app-higgsfield")?.state).toBe("connected");
    await c.svc.disconnect(TENANT, "app-higgsfield");
    expect(c.composio.calls.filter((x) => x.op === "deleteAccount").at(-1)!.args).toBe(stored.accountId);
    expect(await c.svc.vault.get(TENANT, "app-higgsfield")).toBeNull();
  });

  it("a missing key, a key the tool refuses, and Composio failing are each one plain sentence; nothing is kept", async () => {
    await expect(c.svc.connectWithKey(TENANT, "app-higgsfield", { generic_api_key: KEY_ID })).rejects.toThrow("Higgsfield needs your API Key Secret.");
    await expect(c.svc.connectWithKey(TENANT, "app-onekey", {})).rejects.toThrow("OneKey needs your API key.");
    const bad = c.svc.connectWithKey(TENANT, "app-higgsfield", { generic_api_key: KEY_ID, generic_token: "wrong-TEST" });
    await expect(bad).rejects.toMatchObject({ name: "ConnectProblem", status: 422, message: "Higgsfield didn't accept that key. Check it and paste it again." });
    expect(c.composio.calls.at(-1)!.op).toBe("deleteAccount"); // the half-made account is removed at Composio too
    c.composio.failNext.set("createAccount", new ComposioError("Composio answered 400.", 400, `Invalid value ${SECRET} for generic_token.`, "ConnectedAccount_Invalid"));
    const failed = await c.svc.connectWithKey(TENANT, "app-higgsfield", { generic_api_key: KEY_ID, generic_token: SECRET }).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(ConnectProblem);
    expect((failed as Error).message).toBe("Composio couldn't set up Higgsfield: invalid value … for generic_token.");
    c.composio.failNext.set("createAccount", new ComposioError("Composio answered 400.", 400, "x", "ConnectedAccount_CredentialValidationRejected"));
    await expect(c.svc.connectWithKey(TENANT, "app-higgsfield", { generic_api_key: KEY_ID, generic_token: SECRET })).rejects.toMatchObject({ status: 422 });
    expect(await c.svc.vault.get(TENANT, "app-higgsfield")).toBeNull();
    await expect(c.svc.connectWithKey(TENANT, "app-notion", { generic_api_key: KEY_ID })).rejects.toThrow("doesn't take a key here");
    const audit = await c.audit.recent(TENANT, { limit: 50 });
    expect(leaked(JSON.stringify(audit)) || leaked(logs.join("\n")) || leaked(onDisk(c.dir))).toBe(false);
  });

  it("a sign-in that needs nothing of ours gets its own auth config and the hosted page; one needing our own app says so", async () => {
    const { url, key } = await c.svc.connect(TENANT, "app-higgsfield_mcp");
    expect(key).toBeUndefined();
    expect(url).toMatch(/^https:\/\/composio\.example\/connect\//);
    expect(c.composio.calls.filter((x) => x.op === "authConfigId").at(-1)!.args).toEqual({ toolkit: "higgsfield_mcp", custom: "DCR_OAUTH" });
    await expect(c.svc.connect(TENANT, "app-ownapp")).rejects.toThrow("Composio couldn't set up OwnApp: it needs its own sign-in app registered first, which your team has to do.");
  });
});

describe("over HTTP", () => {
  it("connect answers the key form, the key route connects, and every failure is a 4xx with the sentence, never 'something went wrong'", async () => {
    const start = await post(app, `/api/${TENANT}/connections/app-higgsfield/connect`, { returnTo: "connections" });
    expect(start.status).toBe(200);
    expect(((await start.json()) as { key: { tool: string } }).key.tool).toBe("Higgsfield");

    const missing = await post(app, `/api/${TENANT}/connections/app-higgsfield/key`, { values: { generic_api_key: KEY_ID } });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "Higgsfield needs your API Key Secret." });

    c.composio.failNext.set("authConfigId", new ComposioError("Composio did not make an auth config.", 502));
    const broke = await post(app, `/api/${TENANT}/connections/app-higgsfield/key`, { values: { generic_api_key: KEY_ID, generic_token: SECRET } });
    expect(broke.status).toBe(400);
    expect(((await broke.json()) as { error: string }).error).toBe("Composio couldn't set up Higgsfield: it answered 502.");

    c.composio.auth.set("noway", { name: "NoWay", managed: [], schemes: [] });
    const none = await post(app, `/api/${TENANT}/connections/app-noway/connect`, {});
    expect(none.status).toBe(400);
    expect(((await none.json()) as { error: string }).error).toMatch(/^Composio couldn't set up NoWay: /);

    const ok = await post(app, `/api/${TENANT}/connections/app-higgsfield/key`, { values: { generic_api_key: KEY_ID, generic_token: SECRET } });
    expect(ok.status).toBe(200);
    const body = await ok.text();
    expect(JSON.parse(body)).toMatchObject({ message: "Higgsfield connected: 1,200 credits left.", view: { state: "connected" } });
    expect(leaked(body)).toBe(false);
    expect(leaked(logs.join("\n"))).toBe(false);
    expect(logs.join("\n")).not.toMatch(/Something went wrong/);

    const off = await post(app, `/api/${TENANT}/connections/app-higgsfield/disconnect`, {});
    expect(((await off.json()) as { state: string }).state).toBe("not_connected");
  });
});

describe("classifyTool for MCP toolkits (Higgsfield MCP, 17 Oct)", () => {
  it("balance, status, presets and costs only read; generating waits for the OK", async () => {
    const { classifyTool } = await import("../../src/connections/composio.js");
    const hf = (s: string) => `HIGGSFIELD_MCP_${s}`;
    for (const s of ["BALANCE", "JOB_STATUS", "JOBS_WAIT", "MODELS_EXPLORE", "MARKETING_STUDIO_V2_COSTS"].map(hf)) expect(classifyTool(s), s).toBe("read");
    for (const s of ["GENERATE_IMAGE", "GENERATE_VIDEO", "MEDIA_UPLOAD", "CONFIRM_BILLING_PURCHASE", "DEPLOY_WEBSITE"].map(hf)) expect(classifyTool(s), s).toBe("act");
  });
});
