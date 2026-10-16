// The Connections page's API over HTTP, against fake Composio and Google: the grouped list ordered for the kind of business, the
// trip out and back (callback), Discord's one-time /c/<code> link, picking, disconnecting, the audit log, public mode, and one
// business never seeing or changing another's connections.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAll } from "../../src/graph/client.js";
import { connHarness, WEB, type ConnHarness } from "../connections/harness.js";
import { harness, post, type Harness } from "./harness.js";

let h: Harness;
let c: ConnHarness;
let app: Harness["app"];
let pub: Harness["app"];

beforeAll(async () => {
  h = await harness();
  c = await connHarness({ via: "composio", graph: false });
  const wiring = async () => ({ service: c.svc, webBaseUrl: WEB });
  app = h.make({ connections: wiring });
  pub = h.make({ connections: wiring, publicMode: true });
}, 90_000);
afterAll(async () => { await c.cleanup(); await h.cleanup(); await closeAll(); });

const list = async (a = app) => (await a.request("/api/mini/connections")).json() as Promise<{ ready: boolean; fit: string | null; recommended: Array<{ id: string; state: string }>; more: Array<{ id: string }>; groups: Array<{ id: string; label: string; items: unknown[] }>; starters: Array<{ id: string }>; never: string; setup: unknown[] }>;

describe("server: connections", () => {
  it("lists them grouped, the recommended ones first, with the promise in words; and says plainly when it isn't switched on", async () => {
    const r = await list();
    expect(r.ready).toBe(true);
    expect(r.recommended).toHaveLength(16); // the fifteen, with Shopify and Stripe both at 10
    expect(r.recommended[0]!.id).toBeTruthy();
    expect(r.groups.map((g) => g.label)).toEqual(["Google", "Meta", "Commerce and money", "Customers", "Team"]);
    expect(r.never).toMatch(/never post, send, spend or book without your OK/);
    const bare = await (await h.app.request("/api/mini/connections")).json() as { ready: boolean; message: string };
    expect(bare).toMatchObject({ ready: false, message: expect.stringMatching(/isn't switched on yet/) });
    expect((await post(h.app, "/api/mini/connections/gmail/connect", {})).status).toBe(503);
  });

  it("orders the recommended set for the business: a jobs platform puts analytics and ads before a shop's tools", async () => {
    const r = await list();
    const ids = r.recommended.map((x) => x.id);
    expect(ids.indexOf("google-analytics")).toBeLessThan(ids.indexOf("shopify"));
  });

  it("connect gives the provider's address, the callback finishes it and lands on the Connections page, and the row says connected", async () => {
    const res = await post(app, "/api/mini/connections/hubspot/connect", { returnTo: "connections" });
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    expect(url).toMatch(/^https:\/\/composio\.example\/connect\/ca_/);
    const link = c.composio.calls.filter((x) => x.op === "link").at(-1)!.args as { callbackUrl: string };
    const accountId = new URL(url).pathname.split("/").pop()!;
    c.composio.activate(accountId);
    const cb = new URL(link.callbackUrl);
    const back = await app.request(`${cb.pathname}${cb.search}&status=success&connected_account_id=${accountId}`, { redirect: "manual" });
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe(`${WEB}/connections?connect=hubspot&result=connected`);
    expect((await list()).recommended.find((x) => x.id === "hubspot")!.state).toBe("connected");
    // the same address again does nothing: the state was single use
    const again = await app.request(`${cb.pathname}${cb.search}&status=success&connected_account_id=${accountId}`, { redirect: "manual" });
    expect(again.status).toBe(400);
  });

  it("an owner who says no on the provider's page comes back with 'denied'; onboarding comes back to onboarding", async () => {
    const res = await post(app, "/api/mini/connections/slack/connect", { returnTo: "onboard" });
    const link = c.composio.calls.filter((x) => x.op === "link").at(-1)!.args as { callbackUrl: string };
    expect(((await res.json()) as { url: string }).url).toBeTruthy();
    const cb = new URL(link.callbackUrl);
    const back = await app.request(`${cb.pathname}${cb.search}&status=failed`, { redirect: "manual" });
    expect(back.headers.get("location")).toBe(`${WEB}/onboard?connect=slack&result=denied`);
  });

  it("connecting from Home comes back to Home (issue #43)", async () => {
    const res = await post(app, "/api/mini/connections/calendly/connect", { returnTo: "home" });
    expect(res.status).toBe(200);
    const link = c.composio.calls.filter((x) => x.op === "link").at(-1)!.args as { callbackUrl: string };
    const accountId = new URL(((await res.json()) as { url: string }).url).pathname.split("/").pop()!;
    c.composio.activate(accountId);
    const cb = new URL(link.callbackUrl);
    const back = await app.request(`${cb.pathname}${cb.search}&status=success&connected_account_id=${accountId}`, { redirect: "manual" });
    expect(back.headers.get("location")).toBe(`${WEB}/?connect=calendly&result=connected`);
    expect((await post(app, "/api/mini/connections/calendly/disconnect", {})).status).toBe(200);
  });

  it("Discord's one-time link redirects to the provider once, and never twice", async () => {
    const code = c.svc.connectLink("mini", "stripe").split("/c/")[1]!;
    const first = await app.request(`/c/${code}`, { redirect: "manual" });
    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toMatch(/^https:\/\/composio\.example\/connect\//);
    const second = await app.request(`/c/${code}`, { redirect: "manual" });
    expect(second.status).toBe(400);
    expect(await second.text()).toMatch(/run out/);
    expect((await app.request("/c/forged", { redirect: "manual" })).status).toBe(400);
  });

  it("disconnect forgets it; the audit log shows what was done and by whom, without secrets", async () => {
    const res = await post(app, "/api/mini/connections/hubspot/disconnect", {});
    expect(((await res.json()) as { state: string }).state).toBe("not_connected");
    const audit = (await (await app.request("/api/mini/connections/audit")).json()) as Array<{ connection: string; did: string; worked: boolean }>;
    expect(audit.map((a) => a.did)).toEqual(expect.arrayContaining(["disconnected", "connect finished", "connect started"]));
    expect(JSON.stringify(audit)).not.toMatch(/ca_\d|state=|access/);
  });

  it("finds toolkits beyond the listed ones, and refuses an unknown connection in words", async () => {
    const r = (await (await app.request("/api/mini/connections/search?q=notion")).json()) as { results: Array<{ id: string }> };
    expect(r.results[0]!.id).toBe("app-notion");
    expect((await post(app, "/api/mini/connections/nonsense/connect", {})).status).toBe(404);
  });

  it("is read-only in public mode, and another business's name in the path is no business of ours", async () => {
    expect((await post(pub, "/api/mini/connections/gmail/connect", {})).status).toBe(403);
    expect((await app.request("/api/other_shop/connections")).status).toBe(404);
  });
});
