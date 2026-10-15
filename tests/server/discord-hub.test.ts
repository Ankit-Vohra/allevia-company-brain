// The onboarding hook and the Home page's Discord endpoints, over the real API app with a fake hub (no Discord, no
// network): the "done" event carries the join link, a failed set-up never fails onboarding and says "later", a retry
// finishes it, and a server with no hub (or the public demo) shows nothing Discord at all.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DiscordHome, OnboardEvent } from "../../shared/contracts.js";
import { createHubService } from "../../src/discord/hub-service.js";
import { provisionCustomer } from "../../src/discord/hub-provision.js";
import type { OnboardFn } from "../../src/server/app.js";
import { FakeHub, MemoryHubStore } from "../helpers/hub-fakes.js";
import { harness, post, sseBlocks, sseEvents, type Harness } from "./harness.js";

const done = (tenant: string): OnboardEvent => ({ type: "done", tenant, counts: { Page: 1 } });
const onboardOk: OnboardFn = async (input, emit) => {
  emit({ type: "stage", stage: "crawl", text: "Reading the website" });
  emit({ type: "page", url: "https://kestrel.example/", title: "Kestrel & Oak" });
  emit(done(input.slug));
};

function hubRig() {
  const hub = new FakeHub();
  const staff = hub.addRole("Allevia staff", 10).id;
  const store = new MemoryHubStore();
  const clock = { t: Date.now() };
  hub.clock = () => clock.t;
  const names: Record<string, string> = { kestrel_oak: "Kestrel & Oak", mini: "Mini Jobs" };
  const svc = createHubService({ hub, store, staffRoleId: staff, now: () => clock.t, log: () => {}, tenant: async (s) => (names[s] ? { name: names[s]! } : null) });
  return { hub, store, svc, clock };
}

describe("the Discord hub in the API", () => {
  let h: Harness;
  beforeAll(async () => { h = await harness(); });
  afterAll(async () => { await h.cleanup(); });

  const events = async (res: Response) => sseEvents(await res.text()) as unknown as OnboardEvent[];
  const body = { name: "Kestrel & Oak", url: "kestrel.example" };

  it("sets the business up on the hub after onboarding and hands the owner the join link in the done event", async () => {
    const { hub, svc, store } = hubRig();
    const app = h.make({ loadOnboard: async () => onboardOk, discordHub: async () => svc });
    const res = await post(app, "/api/onboard", body);
    const blocks = sseBlocks(await res.text());
    expect(blocks.map((b) => b.event)).toEqual(["stage", "page", "done"]); // the one done event, last
    const last = JSON.parse(blocks.at(-1)!.data) as Extract<OnboardEvent, { type: "done" }>;
    expect(last).toMatchObject({ tenant: "kestrel_oak", counts: { Page: 1 } });
    expect(last.discord!.inviteUrl).toMatch(/^https:\/\/discord\.gg\/\w+$/);
    expect(last.discord!.later).toBeUndefined();
    const area = (await store.getArea("kestrel_oak"))!;
    expect(area.status).toBe("ready");
    expect(hub.byName("Kestrel & Oak")!.kind).toBe("category");
    const [inv] = [...hub.invites.values()];
    expect(inv!.maxUses).toBe(1);
    expect(last.discord!.inviteUrl).toBe(`https://discord.gg/${inv!.code}`);
  });

  it("when the set-up fails, onboarding still succeeds and says the link is coming; a retry then finishes it", async () => {
    const { hub, svc, store, clock } = hubRig();
    let down = true;
    hub.fail = (op) => (down && op === "createRole" ? "Discord is down" : undefined);
    const app = h.make({ loadOnboard: async () => onboardOk, discordHub: async () => svc });
    const evs = await events(await post(app, "/api/onboard", body));
    expect(evs.map((e) => e.type)).toEqual(["stage", "page", "done"]); // no error event
    expect(evs.at(-1)).toEqual({ type: "done", tenant: "kestrel_oak", counts: { Page: 1 }, discord: { later: true } });
    expect((await store.getArea("kestrel_oak"))!.status).toBe("pending");
    expect(JSON.stringify(evs)).not.toMatch(/Discord is down/); // the owner is not shown the technical reason

    down = false;
    clock.t += 5 * 60_000;
    expect(await svc.retryDue()).toEqual([{ slug: "kestrel_oak", ok: true }]);
    expect((await svc.home("kestrel_oak")).state).toBe("invite");
  });

  it("a set-up that is taking too long does not hold the owner up: later now, ready in the background", async () => {
    const { hub, svc, store } = hubRig();
    const slow = hub.createRole.bind(hub);
    hub.createRole = async (n) => { await new Promise((r) => setTimeout(r, 120)); return slow(n); };
    expect(await svc.afterOnboarding("kestrel_oak", 20)).toEqual({ later: true });
    await new Promise((r) => setTimeout(r, 400));
    expect((await store.getArea("kestrel_oak"))!.status).toBe("ready");
    expect((await svc.home("kestrel_oak")).state).toBe("invite");
  });

  it("a failed onboarding sets up nothing on the hub", async () => {
    const { hub, svc } = hubRig();
    const app = h.make({ loadOnboard: async () => async (_i, emit) => { emit({ type: "error", message: "no pages" }); }, discordHub: async () => svc });
    const evs = await events(await post(app, "/api/onboard", body));
    expect(evs.map((e) => e.type)).toEqual(["error"]);
    expect(hub.calls).toEqual([]);
  });

  it("a server with no hub gives no discord field and shows nothing Discord", async () => {
    const app = h.make({ loadOnboard: async () => onboardOk });
    const evs = await events(await post(app, "/api/onboard", body));
    expect(evs.at(-1)).toEqual({ type: "done", tenant: "kestrel_oak", counts: { Page: 1 } });
    expect(await (await app.request("/api/mini/discord")).json()).toEqual({ enabled: false });
    expect((await post(app, "/api/mini/discord/invite", {})).status).toBe(501);
  });

  it("a hub that cannot even start is like no hub: onboarding is unaffected", async () => {
    const app = h.make({ loadOnboard: async () => onboardOk, discordHub: async () => { throw new Error("bad config"); } });
    const evs = await events(await post(app, "/api/onboard", body));
    expect(evs.at(-1)).toEqual({ type: "done", tenant: "kestrel_oak", counts: { Page: 1 } });
  });

  it("the Home page's endpoint follows the business from a link, to joined, to a new link", async () => {
    const { hub, svc, store, clock } = hubRig();
    const app = h.make({ discordHub: async () => svc });
    const get = async () => (await (await app.request("/api/mini/discord")).json()) as DiscordHome;

    expect(await get()).toEqual({ enabled: true, state: "later" }); // not set up yet
    await provisionCustomer("mini", svc.deps);
    const first = await get();
    expect(first).toMatchObject({ enabled: true, state: "invite", inviteUrl: expect.stringMatching(/^https:\/\/discord\.gg\//) });

    const inv = (await store.invites("mini"))[0]!;
    hub.join(inv.code);
    await store.saveInvite({ ...inv, status: "used", usedAt: clock.t });
    const joined = await get();
    expect(joined.state).toBe("joined");
    expect(joined.inviteUrl).toBeUndefined();
    expect(joined.openUrl).toMatch(/^https:\/\/discord\.com\/channels\/\d+\/\d+$/);

    // a fresh link for another person; asking again straight away is turned back
    const fresh = await post(app, "/api/mini/discord/invite", {});
    expect(fresh.status).toBe(200);
    expect(((await fresh.json()) as DiscordHome).state).toBe("joined");
    expect((await store.invites("mini")).filter((i) => i.status === "open")).toHaveLength(1);
    const again = await post(app, "/api/mini/discord/invite", {});
    expect(again.status).toBe(429);
    expect(await again.json()).toEqual({ error: expect.stringMatching(/give it a minute/i) });
  });

  it("a new-link request that cannot be done says so plainly, without the reason", async () => {
    const { hub, svc } = hubRig();
    const app = h.make({ discordHub: async () => svc });
    await provisionCustomer("mini", svc.deps);
    hub.fail = (op) => (op === "createInvite" ? "token SECRET failed" : undefined);
    const res = await post(app, "/api/mini/discord/invite", {});
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toMatch(/SECRET/);
  });

  it("an unknown business is a 404, and the public demo shows and does nothing", async () => {
    const { svc } = hubRig();
    const app = h.make({ discordHub: async () => svc });
    expect((await app.request("/api/nobody/discord")).status).toBe(404);
    expect((await post(app, "/api/nobody/discord/invite", {})).status).toBe(404);
    const pub = h.make({ publicMode: true, discordHub: async () => svc });
    expect(await (await pub.request("/api/mini/discord")).json()).toEqual({ enabled: false });
    expect((await post(pub, "/api/mini/discord/invite", {})).status).toBe(403);
  });
});
