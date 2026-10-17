// Your tools for a public demo business with sample data: Gmail, Google Calendar and Shopify show as connected, each saying it is
// sample data, even on a server where connecting is not switched on; and they cannot be connected, read again or disconnected.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAll } from "../../src/graph/client.js";
import { registerSampleTenant } from "../../src/demo/sample/connections.js";
import { harness, post, type Harness } from "./harness.js";

let h: Harness;

beforeAll(async () => {
  h = await harness();
  registerSampleTenant("mini");
}, 90_000);
afterAll(async () => { await h.cleanup(); await closeAll(); });

describe("server: Your tools on a sample demo business", () => {
  it("lists Gmail, Calendar and Shopify as connected with the sample line, and the jobs they unlock", async () => {
    const r = await (await h.app.request("/api/mini/connections")).json() as {
      ready: boolean; sample: string; recommended: Array<{ id: string; state: string; message: string }>; starters: Array<{ id: string }>;
    };
    expect(r.ready).toBe(true);
    expect(r.sample).toMatch(/^Sample data for this demo/);
    const connected = r.recommended.filter((v) => v.state === "connected");
    expect(connected.map((v) => v.id).sort()).toEqual(["gmail", "google-calendar", "shopify"]);
    for (const v of connected) expect(v.message).toMatch(/Sample data/);
    expect(r.recommended.find((v) => v.id === "hubspot")).toMatchObject({ state: "not_connected" });
    expect(r.starters.map((s) => s.id)).toEqual(expect.arrayContaining(["sales-today", "sales-draft-replies", "sales-invite"]));
  });

  it("refuses to connect, read or disconnect a sample tool, in plain words", async () => {
    for (const path of ["gmail/connect", "shopify/pull", "google-calendar/disconnect"]) {
      const res = await post(h.app, `/api/mini/connections/${path}`, {});
      expect(res.status, path).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/sample data for the demo/);
    }
  });
});
