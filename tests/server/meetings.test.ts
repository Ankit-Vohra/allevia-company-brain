// Meeting capture on the server: "Check for new meetings" reads the demo business's sample Fireflies account and saves the call
// once; the meeting address takes a transcript with its secret and refuses one without it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeRuntime } from "../../src/agent/runtime.js";
import { capturedIds } from "../../src/agent/meeting.js";
import { registerSampleTenant } from "../../src/demo/sample/connections.js";
import { SAMPLE_FIREFLIES_ID } from "../../src/demo/sample/fireflies.js";
import { closeAll } from "../../src/graph/client.js";
import { meetingToken } from "../../src/meetings/address.js";
import { harness, post, resetRuntime, useRuntime, type Harness } from "./harness.js";

const KEY = "meeting-address-test-key-0123456789abcdef";
const EXTRACTED = {
  title: "Follow-up call", date: "2026-10-17", summary: "A sample follow-up.",
  attendees: [{ name: "Ritika Menon", email: "", company: "Kettle & Crumb", role: "owner", side: "them" }], people: [],
  companies: [], products: [],
  decisions: [{ text: "Add 5 kg a month of decaf", decidedBy: ["Ritika Menon"], about: [] }],
  tasks: [{ text: "Send the revised quote", owner: "us", due: "2026-10-20", about: [] }],
  numbers: ["5 kg a month"], dates: [],
};

let h: Harness;
beforeAll(async () => {
  process.env.ALLEVIA_CONNECTOR_KEY = KEY;
  h = await harness();
  registerSampleTenant("mini");
  useRuntime(() => new FakeRuntime({ "librarian:work": { structured: EXTRACTED } }));
}, 90_000);
afterAll(async () => { resetRuntime(); delete process.env.ALLEVIA_CONNECTOR_KEY; await h.cleanup(); await closeAll(); });

describe("server: meeting capture", () => {
  it("Check for new meetings saves the sample call once, as a thread, with the minutes card", async () => {
    const res = await post(h.app, "/api/mini/meetings/check", {});
    expect(res.status).toBe(200);
    const r = await res.json() as { recorders: Array<{ id: string; state: string; message: string }>; saved: Array<{ title: string; ok: boolean; sessionId: string }>; skipped: Array<{ why: string }> };
    expect(r.saved).toEqual([expect.objectContaining({ title: "Kettle & Crumb follow-up call (sample)", ok: true })]);
    expect(r.recorders.find((x) => x.id === "granola")).toMatchObject({ state: "not_connected", message: expect.stringMatching(/Connect it on Your tools/) });
    const again = await (await post(h.app, "/api/mini/meetings/check", {})).json() as typeof r;
    expect(again.saved).toEqual([]);
    expect(again.skipped).toEqual([expect.objectContaining({ why: "already saved" })]);
    const id = capturedIds({ recorder: "fireflies", externalId: SAMPLE_FIREFLIES_ID }).meetingId;
    expect((await h.g.roQuery<{ n: number }>("MATCH (m:Entity:Meeting {id:$id}) RETURN count(m) AS n", { id }))[0]!.n).toBe(1);
  });

  it("the meeting address: its secret is needed, and a transcript posted to it is read in the background", async () => {
    const token = meetingToken(KEY, "mini")!;
    const text = "Supplier call, 15 October\nPriya: The green beans go up 4 percent in November.\nUs: Noted, we will send the revised quote to our cafés.";
    expect((await post(h.app, "/hooks/meetings/mini/not-the-secret", { id: "call-9", transcript: text })).status).toBe(404);
    expect((await post(h.app, `/hooks/meetings/mini/${token}`, { id: "call-9", transcript: "short" })).status).toBe(400);
    const res = await post(h.app, `/hooks/meetings/mini/${token}`, { id: "call-9", title: "Supplier call", transcript: text });
    expect(res.status).toBe(202);
    const id = capturedIds({ recorder: "inbound", externalId: "call-9" }).meetingId;
    let n = 0;
    for (let i = 0; i < 50 && !n; i++) {
      await new Promise((r) => setTimeout(r, 100));
      n = (await h.g.roQuery<{ n: number }>("MATCH (m:Entity:Meeting {id:$id}) RETURN count(m) AS n", { id }))[0]!.n;
    }
    expect(n).toBe(1);
    const addr = await (await h.app.request("/api/mini/meetings/address")).json() as { url: string };
    expect(addr.url).toMatch(new RegExp(`/hooks/meetings/mini/${token}$`));
  });
});
