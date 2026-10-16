// provisionCustomer against a fake Discord guild: what gets created, who can see it, that a re-run repairs instead of
// duplicating, the join link rules, queued retries, and the card / note sync. Every test runs twice: over an
// in-memory store and over the real allevia_meta store (a throwaway graph on the local FalkorDB).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ApprovalDto } from "../../src/server/types.js";
import { GraphHubStore } from "../../src/discord/hub-store.js";
import { formatCompanies, listCompanies } from "../../src/discord/hub-check.js";
import {
  MAX_ATTEMPTS, ProvisionBusy, areaOverwrites, ensureHubInfra, homeInfo, provisionCustomer, retryDue, syncArea, welcomeText,
  type ProvisionDeps, type TenantSource,
} from "../../src/discord/hub-provision.js";
import { CHANNEL_KINDS, INVITE_MAX_AGE_SECONDS, type HubStore } from "../../src/discord/hub-types.js";
import { openGraphByName } from "../../src/graph/client.js";
import { FakeHub, MemoryHubStore } from "../helpers/hub-fakes.js";
import { testGraphName } from "../helpers/graph.js";

const NAMES: Record<string, string> = { aamdani: "Aamdani", avs_atelier: "AVS Atelier", twin_one: "Twin", twin_two: "Twin" };

interface Rig { hub: FakeHub; store: HubStore; staff: string; deps: ProvisionDeps; clock: { t: number }; logs: string[] }

const metaGraphs: string[] = [];
afterAll(async () => { for (const n of metaGraphs) await (await openGraphByName(n)).drop().catch(() => undefined); });

function rig(kind: "memory" | "graph", over: Partial<ProvisionDeps> = {}): Rig {
  const hub = new FakeHub();
  const staff = hub.addRole("Allevia staff", 10).id;
  const clock = { t: Date.now() };
  hub.clock = () => clock.t;
  let store: HubStore;
  if (kind === "memory") store = new MemoryHubStore();
  else {
    const name = testGraphName();
    metaGraphs.push(name);
    store = new GraphHubStore({ metaGraph: name });
  }
  const logs: string[] = [];
  const deps: ProvisionDeps = {
    hub, store, staffRoleId: staff, now: () => clock.t, log: (l) => logs.push(l),
    tenant: async (slug) => (NAMES[slug] ? { name: NAMES[slug]! } : null), ...over,
  };
  return { hub, store, staff, deps, clock, logs };
}

describe.each(["memory", "graph"] as const)("provisionCustomer (%s store)", (kind) => {
  let r: Rig;
  beforeAll(() => { r = rig(kind); });

  it("builds the role, the private category, the four channels, the welcome message and a single-use link", async () => {
    const res = await provisionCustomer("aamdani", r.deps);
    const { hub } = r;
    const role = [...hub.roles.values()].find((x) => x.name === "customer-aamdani")!;
    expect(role).toBeTruthy();
    const cat = hub.byName("Aamdani")!;
    expect(cat.kind).toBe("category");
    const inside = hub.channelsIn(cat.id);
    expect(inside.map((c) => c.name).sort()).toEqual(["approvals", "studio", "support", "todays-note", "your-team"]);
    // always in the same order, with a one-line topic each
    expect([...inside].sort((a, b) => a.position - b.position).map((c) => c.name)).toEqual(["your-team", "studio", "approvals", "todays-note", "support"]);
    for (const c of inside) expect(c.topic).toBeTruthy();
    expect(res.area.status).toBe("ready");
    expect(res.area.roleId).toBe(role.id);
    expect(res.area.categoryId).toBe(cat.id);

    // the mapping: each channel id leads to this business, and to which channel it is
    for (const k of CHANNEL_KINDS) {
      const id = res.area.channels[k]!;
      expect(hub.channels.get(id)!.name).toBe(k);
      expect(await r.store.channel(hub.guildId, id)).toMatchObject({ slug: "aamdani", kind: k });
    }
    // the role has no permissions of its own
    expect(hub.roles.get(role.id)!.name).toBe("customer-aamdani");

    // welcome: plain words, every channel named, no jargon
    const welcome = [...hub.messages.values()].find((m) => m.channelId === res.area.channels["your-team"] && m.content.includes("Welcome"))!;
    expect(welcome.content).toContain(`<#${res.area.channels["your-team"]}>`);
    expect(welcome.content).toContain(`<#${res.area.channels.approvals}>`);
    expect(welcome.content).toContain(`<#${res.area.channels["todays-note"]}>`);
    expect(welcome.content).toContain(`<#${res.area.channels.support}>`);
    expect(welcome.content).toMatch(/Try this first/);
    expect(welcome.content).not.toMatch(/agent|graph|orchestrat|approval card|brief\b/i);

    // the join link: one use, seven days, on the customer's own #your-team
    const [inv] = [...hub.invites.values()];
    expect(hub.invites.size).toBe(1);
    expect(inv!.maxUses).toBe(1);
    expect(inv!.channelId).toBe(res.area.channels["your-team"]);
    expect(inv!.expiresAt! - r.clock.t).toBe(INVITE_MAX_AGE_SECONDS * 1000);
    expect(res.inviteUrl).toBe(`https://discord.gg/${inv!.code}`);

    // the staff-only #support-inbox exists in the hub
    const inbox = hub.byName("support-inbox")!;
    expect((await r.store.getHub(hub.guildId))!.supportInboxId).toBe(inbox.id);
  });

  it("who can see what: the customer role, the staff role and the bot only; nobody else; customers cannot type in the read-only channels", async () => {
    const { hub } = r;
    const area = (await r.store.getArea("aamdani"))!;
    const customer = { roles: [area.roleId!] };
    const staff = { roles: [r.staff] };
    const nobody = { roles: [] as string[] };
    for (const id of [area.categoryId!, ...Object.values(area.channels)]) {
      expect(hub.canView(id, customer)).toBe(true);
      expect(hub.canView(id, staff)).toBe(true);
      expect(hub.canView(id, nobody)).toBe(false);
    }
    expect(hub.canView(hub.byName("support-inbox")!.id, staff)).toBe(true);
    expect(hub.canView(hub.byName("support-inbox")!.id, customer)).toBe(false);
    expect(hub.can(area.channels["your-team"]!, customer, "SendMessages")).toBe(true);
    expect(hub.can(area.channels.support!, customer, "SendMessages")).toBe(true);
    expect(hub.can(area.channels.approvals!, customer, "SendMessages")).toBe(false);
    expect(hub.can(area.channels["todays-note"]!, customer, "SendMessages")).toBe(false);
    expect(hub.can(area.channels["your-team"]!, customer, "CreatePublicThreads")).toBe(false);
    // staff can answer in #support; in the others they only read
    expect(hub.can(area.channels.support!, staff, "SendMessages")).toBe(true);
    // the bot has its own overwrite everywhere
    for (const id of [area.categoryId!, ...Object.values(area.channels)]) {
      expect(hub.channels.get(id)!.overwrites.some((o) => o.type === "member" && o.id === hub.botId && o.allow.includes("ViewChannel"))).toBe(true);
    }
  });

  it("a second business is walled off from the first: each role sees only its own category", async () => {
    await provisionCustomer("avs_atelier", r.deps);
    const a = (await r.store.getArea("aamdani"))!;
    const b = (await r.store.getArea("avs_atelier"))!;
    expect(a.roleId).not.toBe(b.roleId);
    expect(a.categoryId).not.toBe(b.categoryId);
    for (const id of Object.values(b.channels)) expect(r.hub.canView(id, { roles: [a.roleId!] })).toBe(false);
    for (const id of Object.values(a.channels)) expect(r.hub.canView(id, { roles: [b.roleId!] })).toBe(false);
    expect(new Set([...Object.values(a.channels), ...Object.values(b.channels)]).size).toBe(10);
  });

  it("is idempotent: running again changes nothing and creates nothing", async () => {
    const before = { roles: r.hub.roles.size, channels: r.hub.channels.size, messages: r.hub.messages.size, invites: r.hub.invites.size };
    const again = await provisionCustomer("aamdani", r.deps);
    expect({ roles: r.hub.roles.size, channels: r.hub.channels.size, messages: r.hub.messages.size, invites: r.hub.invites.size }).toEqual(before);
    expect(again.actions.filter((a) => a.startsWith("created") || a.startsWith("posted") || a.startsWith("made"))).toEqual([]);
    expect(again.actions).toEqual(expect.arrayContaining(["kept the role customer-aamdani", "kept #approvals", "kept the welcome message", "kept the join link"]));
    expect(again.inviteUrl).toBeTruthy();
  });

  it("repairs what was deleted or changed, and nothing else", async () => {
    const { hub } = r;
    const area = (await r.store.getArea("aamdani"))!;
    // a channel deleted by hand, a permission opened by mistake, the welcome message deleted
    const oldApprovals = area.channels.approvals!;
    hub.channels.delete(oldApprovals);
    const support = hub.channels.get(area.channels.support!)!;
    support.overwrites.find((o) => o.id === hub.guildId)!.deny = [];
    hub.messages.delete(area.welcomeMessageId!);
    const roles = hub.roles.size;
    const channels = hub.channels.size;

    const res = await provisionCustomer("aamdani", r.deps);
    expect(hub.roles.size).toBe(roles);
    expect(hub.channels.size).toBe(channels + 1);
    expect(res.area.channels.approvals).not.toBe(oldApprovals);
    expect(hub.channels.get(res.area.channels.approvals!)!.name).toBe("approvals");
    expect(res.actions).toEqual(expect.arrayContaining(["created #approvals", "posted the welcome message"]));
    expect(res.actions.some((a) => a.startsWith("fixed #support"))).toBe(true);
    expect(hub.canView(res.area.channels.support!, { roles: [] })).toBe(false);
    // the dead channel id maps to nobody any more
    expect(await r.store.channel(hub.guildId, oldApprovals)).toBeNull();
    expect(await r.store.channel(hub.guildId, res.area.channels.approvals!)).toMatchObject({ slug: "aamdani", kind: "approvals" });
  });

  it("removes a permission someone added by hand to a customer channel (the roles are the way in)", async () => {
    const { hub } = r;
    const area = (await r.store.getArea("aamdani"))!;
    const stranger = hub.addRole("somebody-else").id;
    hub.channels.get(area.channels["your-team"]!)!.overwrites.push({ id: stranger, type: "role", allow: ["ViewChannel"], deny: [] });
    expect(hub.canView(area.channels["your-team"]!, { roles: [stranger] })).toBe(true);
    await provisionCustomer("aamdani", r.deps);
    expect(hub.canView(area.channels["your-team"]!, { roles: [stranger] })).toBe(false);
  });

  it("recreates a deleted role and re-points the category at it", async () => {
    const { hub } = r;
    const area = (await r.store.getArea("avs_atelier"))!;
    hub.roles.delete(area.roleId!);
    const res = await provisionCustomer("avs_atelier", r.deps);
    expect(res.area.roleId).not.toBe(area.roleId);
    expect(hub.roles.get(res.area.roleId!)!.name).toBe("customer-avs_atelier");
    expect(hub.canView(res.area.categoryId!, { roles: [res.area.roleId!] })).toBe(true);
    expect(hub.canView(res.area.categoryId!, { roles: [area.roleId!] })).toBe(false);
  });
});

describe.each(["memory", "graph"] as const)("a run that stops half way (%s store)", (kind) => {
  it("is finished by the next run with no duplicates, and the failure is queued for a retry", async () => {
    const r = rig(kind);
    let boom = true;
    r.hub.fail = (op, arg) => (boom && op === "createChannel" && arg === "approvals" ? "Discord is having a moment" : undefined);
    await expect(provisionCustomer("aamdani", r.deps)).rejects.toThrow(/having a moment/);
    const mid = (await r.store.getArea("aamdani"))!;
    expect(mid.status).toBe("pending");
    expect(mid.attempts).toBe(1);
    expect(mid.lastError).toMatch(/having a moment/);
    expect(mid.nextAttemptAt).toBeGreaterThan(r.clock.t);
    expect(mid.roleId).toBeTruthy();
    expect(mid.channels["your-team"]).toBeTruthy(); // saved the moment it existed

    boom = false;
    const res = await provisionCustomer("aamdani", r.deps);
    expect(res.area.status).toBe("ready");
    expect(res.area.attempts).toBe(0);
    expect(res.area.lastError).toBeUndefined();
    expect(res.area.nextAttemptAt).toBeUndefined();
    const names = [...r.hub.channels.values()].map((c) => c.name).sort();
    expect(names).toEqual(["Aamdani", "Allevia Staff", "approvals", "studio", "support", "support-inbox", "todays-note", "your-team"]);
    expect([...r.hub.roles.values()].filter((x) => x.name === "customer-aamdani")).toHaveLength(1);
  });

  it("adopts what is already in Discord when the saved ids were lost, instead of building a second copy", async () => {
    const r = rig(kind);
    await provisionCustomer("aamdani", r.deps);
    const channels = r.hub.channels.size;
    const roles = r.hub.roles.size;
    // a fresh, empty store over the same Discord server (as if the saves never happened)
    const fresh = rig(kind, { hub: r.hub, staffRoleId: r.staff });
    const res = await provisionCustomer("aamdani", { ...fresh.deps, hub: r.hub, staffRoleId: r.staff, now: r.deps.now });
    expect(r.hub.channels.size).toBe(channels);
    expect(r.hub.roles.size).toBe(roles);
    expect(res.actions.filter((a) => a.startsWith("created") && !a.includes("link"))).toEqual([]);
    expect(res.area.status).toBe("ready");
  });

  it("two businesses with the same name get separate categories and never adopt each other's", async () => {
    const r = rig(kind);
    const one = await provisionCustomer("twin_one", r.deps);
    const two = await provisionCustomer("twin_two", r.deps);
    expect(one.area.categoryId).not.toBe(two.area.categoryId);
    expect([...r.hub.channels.values()].filter((c) => c.kind === "category")).toHaveLength(3); // two companies and Allevia Staff
    expect(r.hub.canView(two.area.channels.support!, { roles: [one.area.roleId!] })).toBe(false);
  });

  it("refuses to run twice at once for the same business", async () => {
    const r = rig(kind);
    const results = await Promise.allSettled([provisionCustomer("aamdani", r.deps), provisionCustomer("aamdani", r.deps)]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((x) => x.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(ProvisionBusy);
    expect([...r.hub.roles.values()].filter((x) => x.name === "customer-aamdani")).toHaveLength(1);
    expect([...r.hub.channels.values()].filter((c) => c.name === "support")).toHaveLength(1);
  });
});

describe.each(["memory", "graph"] as const)("the join link (%s store)", (kind) => {
  it("is not made again once someone has joined, until reinvite; reinvite leaves exactly one live link", async () => {
    const r = rig(kind);
    const first = await provisionCustomer("aamdani", r.deps);
    const code = [...r.hub.invites.keys()][0]!;
    // someone joins with it: the bot (hub-join.ts) records that; here we record it the way it does
    const inv = (await r.store.invites("aamdani"))[0]!;
    r.hub.join(code);
    await r.store.saveInvite({ ...inv, status: "used", usedAt: r.clock.t });
    const quiet = await provisionCustomer("aamdani", r.deps);
    expect(quiet.inviteUrl).toBeUndefined();
    expect(r.hub.invites.size).toBe(0);
    expect(await homeInfo("aamdani", r.deps)).toEqual({ enabled: true, state: "joined", openUrl: `https://discord.com/channels/${r.hub.guildId}/${first.area.channels["your-team"]}` });

    const more = await provisionCustomer("aamdani", r.deps, { newInvite: true });
    expect(more.inviteUrl).toBeTruthy();
    const again = await provisionCustomer("aamdani", r.deps, { newInvite: true });
    expect(r.hub.invites.size).toBe(1); // the older one was revoked
    expect(again.inviteUrl).not.toBe(more.inviteUrl);
    expect((await r.store.invites("aamdani")).filter((i) => i.status === "open")).toHaveLength(1);
    expect((await r.store.invites("aamdani")).filter((i) => i.status === "revoked")).toHaveLength(1);
  });

  it("a link that ran out unused is replaced by the next run, and the Home page says so until then", async () => {
    const r = rig(kind);
    await provisionCustomer("aamdani", r.deps);
    r.clock.t += (INVITE_MAX_AGE_SECONDS + 60) * 1000;
    r.hub.invites.clear(); // Discord removes an expired link
    expect(await homeInfo("aamdani", r.deps)).toEqual({ enabled: true, state: "expired" });
    const res = await provisionCustomer("aamdani", r.deps);
    expect(res.inviteUrl).toBeTruthy();
    expect(r.hub.invites.size).toBe(1);
    expect(await homeInfo("aamdani", r.deps)).toMatchObject({ enabled: true, state: "invite", inviteUrl: res.inviteUrl });
  });
});

describe.each(["memory", "graph"] as const)("grouped channels and a stable order (%s store)", (kind) => {
  it("puts #support-inbox in an Allevia Staff category at the top, and keeps it there", async () => {
    const r = rig(kind);
    await provisionCustomer("aamdani", r.deps);
    await provisionCustomer("avs_atelier", r.deps);
    const staff = r.hub.byName("Allevia Staff")!;
    const inbox = r.hub.byName("support-inbox")!;
    expect(inbox.parentId).toBe(staff.id);
    const cats = [...r.hub.channels.values()].filter((c) => c.kind === "category").sort((a, b) => a.position - b.position);
    expect(cats.map((c) => c.name)).toEqual(["Allevia Staff", "Aamdani", "AVS Atelier"]);
    // customers never see it; staff do
    const a = (await r.store.getArea("aamdani"))!;
    expect(r.hub.canView(staff.id, { roles: [a.roleId!] })).toBe(false);
    expect(r.hub.canView(inbox.id, { roles: [a.roleId!] })).toBe(false);
    expect(r.hub.canView(inbox.id, { roles: [r.staff] })).toBe(true);
    // someone drags another company above it: the next run puts it back on top
    const avs = r.hub.byName("AVS Atelier")!;
    await r.hub.editChannel(avs.id, { position: 0 });
    expect([...r.hub.channels.values()].filter((c) => c.kind === "category").sort((x, y) => x.position - y.position)[0]!.name).toBe("AVS Atelier");
    await provisionCustomer("aamdani", r.deps);
    expect([...r.hub.channels.values()].filter((c) => c.kind === "category").sort((x, y) => x.position - y.position)[0]!.name).toBe("Allevia Staff");
  });

  it("repairs the order of a company's channels, and moves an old root-level inbox into the staff category", async () => {
    const r = rig(kind);
    const first = await provisionCustomer("aamdani", r.deps);
    const order = () => r.hub.channelsIn(first.area.categoryId!).sort((a, b) => a.position - b.position).map((c) => c.name);
    expect(order()).toEqual(["your-team", "studio", "approvals", "todays-note", "support"]);
    await r.hub.editChannel(first.area.channels.support!, { position: 0 });
    await r.hub.editChannel(first.area.channels.studio!, { position: 4 });
    expect(order()).not.toEqual(["your-team", "studio", "approvals", "todays-note", "support"]);
    const res = await provisionCustomer("aamdani", r.deps);
    expect(order()).toEqual(["your-team", "studio", "approvals", "todays-note", "support"]);
    expect(res.actions).toContain("put the channels back in order");
    // already in order: nothing to do
    expect((await provisionCustomer("aamdani", r.deps)).actions).not.toContain("put the channels back in order");
    // an inbox that was made at the top level before the staff category existed is moved in, not duplicated
    const inbox = r.hub.byName("support-inbox")!;
    await r.hub.editChannel(inbox.id, { parentId: undefined });
    r.hub.channels.get(inbox.id)!.parentId = null;
    await provisionCustomer("aamdani", r.deps);
    expect([...r.hub.channels.values()].filter((c) => c.name === "support-inbox")).toHaveLength(1);
    expect(r.hub.byName("support-inbox")!.parentId).toBe(r.hub.byName("Allevia Staff")!.id);
  });

  it("each channel's topic says in one line what it is for", async () => {
    const r = rig(kind);
    const res = await provisionCustomer("aamdani", r.deps);
    const topics = Object.fromEntries(Object.entries(res.area.channels).map(([k, id]) => [k, r.hub.channels.get(id!)!.topic!]));
    expect(topics.studio).toMatch(/photos and videos/i);
    expect(topics["your-team"]).toMatch(/ask your team anything/i);
    for (const t of Object.values(topics)) { expect(t.length).toBeLessThan(140); expect(t).not.toMatch(/\n/); }
  });

  it("a business set up before #studio existed gets it added on the next run, in its place", async () => {
    const r = rig(kind);
    const first = await provisionCustomer("aamdani", r.deps);
    r.hub.channels.delete(first.area.channels.studio!); // as if this company was made before the Studio channel existed
    const res = await provisionCustomer("aamdani", r.deps);
    expect(res.actions).toContain("created #studio");
    expect(r.hub.channelsIn(first.area.categoryId!).sort((a, b) => a.position - b.position).map((c) => c.name)).toEqual(["your-team", "studio", "approvals", "todays-note", "support"]);
  });

  it("discord-hub list shows every company with its channels and says what is wrong", async () => {
    const r = rig(kind);
    await provisionCustomer("aamdani", r.deps);
    const avs = await provisionCustomer("avs_atelier", r.deps);
    r.hub.channels.delete(avs.area.channels.approvals!);
    const rows = await listCompanies({ hub: r.hub, store: r.store, now: r.deps.now });
    expect(rows.map((x) => x.name)).toEqual(["Aamdani", "AVS Atelier"]);
    expect(rows[0]).toMatchObject({ status: "ready", roleHere: true, inOrder: true, join: "invite" });
    expect(rows[0]!.channels.map((c) => c.kind)).toEqual(["your-team", "studio", "approvals", "todays-note", "support"]);
    const text = formatCompanies(rows);
    expect(text).toContain("Aamdani (aamdani): ready; link sent, nobody has joined yet");
    expect(text).toContain("#approvals  gone from Discord: run provision");
    expect(text).toContain("#studio  ok");
    expect(formatCompanies([])).toBe("No company is set up on the hub yet.");
  });
});

describe("what the hub refuses to build on", () => {
  it("a staff role that is really @everyone: nothing is created", async () => {
    const r = rig("memory");
    const bad = { ...r.deps, staffRoleId: r.hub.guildId };
    await expect(provisionCustomer("aamdani", bad)).rejects.toThrow(/@everyone/);
    expect(r.hub.channels.size).toBe(0);
    expect([...r.hub.roles.values()].some((x) => x.name.startsWith("customer-"))).toBe(false);
  });

  it("a staff role that is not in the server: nothing is created", async () => {
    const r = rig("memory");
    await expect(provisionCustomer("aamdani", { ...r.deps, staffRoleId: "123" })).rejects.toThrow(/staff role/i);
    expect(r.hub.channels.size).toBe(0);
  });

  it("a business that is not in the registry: nothing is created and it is not retried", async () => {
    const r = rig("memory");
    await expect(provisionCustomer("ghost", r.deps)).rejects.toThrow(/no business/);
    expect(r.hub.channels.size).toBe(0);
    const area = (await r.store.getArea("ghost"))!;
    expect(area.status).toBe("pending");
    expect(area.nextAttemptAt).toBeUndefined();
  });

  it("a bad slug is refused before anything happens", async () => {
    const r = rig("memory");
    await expect(provisionCustomer("Not A Slug!", r.deps)).rejects.toThrow(/slug/);
    expect(r.hub.calls).toEqual([]);
  });

  it("hides the bot's token if Discord echoes it in an error", async () => {
    const r = rig("memory", { redact: (s) => s.split("SECRET-TOKEN-VALUE").join("[token]") });
    r.hub.fail = (op) => (op === "createRole" ? "Bot SECRET-TOKEN-VALUE was refused" : undefined);
    const e = await provisionCustomer("aamdani", r.deps).catch((x: Error) => x);
    expect((e as Error).message).toBe("Bot [token] was refused");
    expect((await r.store.getArea("aamdani"))!.lastError).toBe("Bot [token] was refused");
  });

  it("maps a channel to one business only", async () => {
    const r = rig("memory");
    const a = await provisionCustomer("aamdani", r.deps);
    await expect(r.store.setChannels("avs_atelier", r.hub.guildId, { support: a.area.channels.support! })).rejects.toThrow(/already mapped/);
  });

  it("ensureHubInfra repairs a missing #support-inbox", async () => {
    const r = rig("memory");
    const rec = await ensureHubInfra(r.deps);
    r.hub.channels.delete(rec.supportInboxId!);
    const again = await ensureHubInfra(r.deps);
    expect(again.supportInboxId).not.toBe(rec.supportInboxId);
    expect(r.hub.channels.get(again.supportInboxId!)!.name).toBe("support-inbox");
  });
});

// Discord lets a bot give out only roles strictly below its own highest role, and a role at the bot's own place counts as
// level (issue #42: every hub role was made at place 1, the bot's included, so nobody could be given their role).
describe("the customer role's place in the role list", () => {
  const place = (r: Rig, name: string) => [...r.hub.roles.values()].find((x) => x.name === name)!.position;

  it("a new customer role is put just below the bot's role, and each later one too", async () => {
    const r = rig("memory");
    r.hub.botPosition = 7;
    const move = vi.spyOn(r.hub, "setRolePosition");
    const first = await provisionCustomer("aamdani", r.deps);
    // asked for place 6, one below the bot's 7; Discord makes room by moving the others up, the bot's role with them
    expect(move).toHaveBeenLastCalledWith(first.area.roleId, 6);
    expect(first.actions).toContain("put the role customer-aamdani just below the bot's role");
    const second = await provisionCustomer("avs_atelier", r.deps);
    expect(move).toHaveBeenLastCalledWith(second.area.roleId, 7); // the bot's role was at 8 by then (moved up when the first was seated)
    for (const n of ["customer-aamdani", "customer-avs_atelier"]) expect(place(r, n)).toBeLessThan(r.hub.botPosition);
    expect(place(r, "customer-aamdani")).not.toBe(place(r, "customer-avs_atelier")); // no tie between customers either
    expect(r.hub.count("setRolePosition")).toBe(2);
  });

  it("running again moves nothing while the role is below the bot's role", async () => {
    const r = rig("memory");
    r.hub.botPosition = 7;
    await provisionCustomer("aamdani", r.deps);
    const before = place(r, "customer-aamdani");
    const again = await provisionCustomer("aamdani", r.deps);
    expect(r.hub.count("setRolePosition")).toBe(1);
    expect(place(r, "customer-aamdani")).toBe(before);
    expect(again.actions.some((a) => a.startsWith("put the role"))).toBe(false);
  });

  it("no move is asked for when the new role already landed just below the bot's role", async () => {
    const r = rig("memory");
    r.hub.botPosition = 2; // a new role lands at place 1: exactly one below
    const res = await provisionCustomer("aamdani", r.deps);
    expect(res.area.status).toBe("ready");
    expect(r.hub.count("setRolePosition")).toBe(0);
  });

  it("the bot's role at the very bottom (place 1): stops with the fix in plain words, and a later run finishes once it is dragged up", async () => {
    const r = rig("memory");
    r.hub.botPosition = 1;
    const e = await provisionCustomer("aamdani", r.deps).catch((x: Error) => x);
    expect((e as Error).message).toMatch(/at the very bottom of the role list/);
    expect((e as Error).message).toMatch(/drag the bot's role above the customer roles, then run provision again/);
    const area = (await r.store.getArea("aamdani"))!;
    expect(area.status).toBe("pending");
    expect(area.lastError).toMatch(/very bottom/);
    expect(area.nextAttemptAt).toBeGreaterThan(r.clock.t); // queued: the retry loop picks it up
    expect(r.hub.byName("Aamdani")).toBeUndefined();        // nothing else was built on a role nobody can be given
    expect([...r.hub.roles.values()].filter((x) => x.name === "customer-aamdani")).toHaveLength(1);

    r.hub.botPosition = 9;                                   // the owner drags the bot's role up
    const res = await provisionCustomer("aamdani", r.deps);
    expect(res.area.status).toBe("ready");
    expect([...r.hub.roles.values()].filter((x) => x.name === "customer-aamdani")).toHaveLength(1); // the same role, not a second
    expect(place(r, "customer-aamdani")).toBeLessThan(r.hub.botPosition);
  });

  it("a role that is level with the bot's role (the tie): tries to move it, and when Discord refuses says what to do", async () => {
    const r = rig("memory");
    r.hub.botPosition = 5;
    r.hub.addRole("customer-aamdani", 5);
    const e = await provisionCustomer("aamdani", r.deps).catch((x: Error) => x);
    expect((e as Error).message).toMatch(/would not let the bot move customer-aamdani below its own role/);
    expect((e as Error).message).toMatch(/drag the bot's role above the customer roles, then run provision again/);
    expect(r.hub.count("setRolePosition")).toBe(1);
    expect(((await r.store.getArea("aamdani"))!).status).toBe("pending");
    expect(r.hub.byName("Aamdani")).toBeUndefined();
  });

  it("when Discord answers but the role is still not below the bot's, that is said too", async () => {
    const r = rig("memory");
    r.hub.botPosition = 7;
    const hub = r.hub;
    const move = hub.setRolePosition.bind(hub);
    hub.setRolePosition = async (id, pos) => { const all = await move(id, pos); hub.botPosition = pos; return all; }; // the bot's role lands level with it
    const e = await provisionCustomer("aamdani", r.deps).catch((x: Error) => x);
    expect((e as Error).message).toMatch(/still level with the bot's role \(both at place 6 in the list\)/);
  });

  it("a token that would be echoed by Discord on the move is hidden like any other error", async () => {
    const r = rig("memory", { redact: (s) => s.split("SECRET-TOKEN-VALUE").join("[token]") });
    r.hub.botPosition = 7;
    r.hub.fail = (op) => (op === "setRolePosition" ? "Bot SECRET-TOKEN-VALUE was refused" : undefined);
    const e = await provisionCustomer("aamdani", r.deps).catch((x: Error) => x);
    expect((e as Error).message).toContain("[token]");
    expect((e as Error).message).not.toContain("SECRET-TOKEN-VALUE");
  });
});

describe("queued retries", () => {
  it("retries a failed business when it is due, not before, and stops after the last attempt", async () => {
    const r = rig("memory");
    let down = true;
    r.hub.fail = (op) => (down && op === "createRole" ? "down" : undefined);
    await expect(provisionCustomer("aamdani", r.deps)).rejects.toThrow();
    expect(await retryDue(r.deps)).toEqual([]); // not due yet
    r.clock.t += 3 * 60_000;
    expect(await retryDue(r.deps)).toEqual([{ slug: "aamdani", ok: false, error: "down" }]);
    down = false;
    r.clock.t += 10 * 60_000;
    expect(await retryDue(r.deps)).toEqual([{ slug: "aamdani", ok: true }]);
    expect((await r.store.getArea("aamdani"))!.status).toBe("ready");
    expect(await retryDue(r.deps)).toEqual([]);

    const s = rig("memory");
    s.hub.fail = (op) => (op === "createRole" ? "down" : undefined);
    for (let i = 0; i < MAX_ATTEMPTS; i++) await provisionCustomer("aamdani", s.deps).catch(() => undefined);
    const area = (await s.store.getArea("aamdani"))!;
    expect(area.attempts).toBe(MAX_ATTEMPTS);
    expect(area.nextAttemptAt).toBeUndefined(); // left for staff: discord-hub provision
  });
});

describe("welcome and channel rules are in plain words", () => {
  it("names no machinery", () => {
    const text = welcomeText("Aamdani", { "your-team": "1", studio: "5", approvals: "2", "todays-note": "3", support: "4" });
    expect(text).not.toMatch(/agent|orchestr|graph|baseline|approval card/i);
    expect(text).toMatch(/Today's note|One short note each morning/);
  });
  it("only the customer role is ever allowed to write in #your-team, and nobody can ping everyone", () => {
    const o = areaOverwrites("your-team", { everyone: "e", role: "r", staff: "s", bot: "b" });
    expect(o.find((x) => x.id === "r")!.deny).toEqual(expect.arrayContaining(["MentionEveryone"]));
    expect(o.find((x) => x.id === "s")!.allow).not.toContain("SendMessages");
  });
});

describe.each(["memory", "graph"] as const)("cards and the daily note go to the customer's channels once (%s store)", (kind) => {
  const card = (id: string, status: ApprovalDto["status"] = "pending"): ApprovalDto => ({
    id, kind: "github_issue", status, title: `Fix ${id}`, by: "technical-seo" as ApprovalDto["by"], payload: { title: `Fix ${id}`, body: "Do it." }, createdAt: "2026-10-15T09:00:00.000Z",
  });

  it("posts each pending card with buttons once, takes the buttons off a card decided elsewhere, and posts the note once", async () => {
    const r = rig(kind);
    const prov = await provisionCustomer("aamdani", r.deps);
    const approvals = prov.area.channels.approvals!;
    const state = { cards: [card("approval:a1"), card("approval:a2")], note: { id: "document:brief-1", title: "Today's note", asOf: "2026-10-15", text: "Signups held steady." } };
    const src: TenantSource = {
      pendingApprovals: async () => state.cards.filter((c) => c.status === "pending"),
      approval: async (id) => state.cards.find((c) => c.id === id) ?? null,
      latestBrief: async () => state.note,
    };
    const first = await syncArea("aamdani", r.deps, src);
    expect(first).toEqual({ cards: 2, note: true, closed: 0 });
    const posted = [...r.hub.messages.values()].filter((m) => m.channelId === approvals);
    expect(posted).toHaveLength(2);
    expect(posted[0]!.buttons).toEqual(["allevia:approve:approval:a1", "allevia:change:approval:a1", "allevia:reject:approval:a1"]);
    const noteMsgs = [...r.hub.messages.values()].filter((m) => m.channelId === prov.area.channels["todays-note"]);
    expect(noteMsgs).toHaveLength(1);
    expect(noteMsgs[0]!.content).toContain("Signups held steady.");

    expect(await syncArea("aamdani", r.deps, src)).toEqual({ cards: 0, note: false, closed: 0 }); // quiet the second time

    state.cards[0] = card("approval:a1", "approved"); // decided on the web
    const third = await syncArea("aamdani", r.deps, src);
    expect(third.closed).toBe(1);
    expect(posted[0]!.buttons).toEqual([]);
    expect(posted[0]!.content).toMatch(/Approved/);
    expect(posted[1]!.buttons).toHaveLength(3);

    state.note = { id: "document:brief-2", title: "Today's note", asOf: "2026-10-16", text: "A new day." };
    expect((await syncArea("aamdani", r.deps, src)).note).toBe(true);
  });

  it("posts today's stand-up drafts under the note with Approve, Change and No thanks, once, and re-posts a note that gained the stand-up", async () => {
    const r = rig(kind);
    const prov = await provisionCustomer("aamdani", r.deps);
    const noteCh = prov.area.channels["todays-note"]!;
    const draft = { ...card("approval:standup-diwali"), kind: "content_draft" as const, title: "A Diwali post with a poster", by: "content-strategist" as ApprovalDto["by"], payload: { title: "A Diwali post with a poster", body: "Diwali greetings from Raipur.", target: "Instagram post" } };
    const state = { note: { id: "document:brief-1", title: "Today's note", asOf: "2026-10-16", text: "Signups held steady." }, drafts: [] as ApprovalDto[] };
    const src: TenantSource = {
      pendingApprovals: async () => state.drafts.filter((c) => c.status === "pending"),
      approval: async (id) => state.drafts.find((c) => c.id === id) ?? null,
      latestBrief: async () => state.note,
      standupCards: async () => state.drafts.map((a) => ({ approval: a, why: "Diwali is in about 23 days." })),
    };
    await syncArea("aamdani", r.deps, src);
    state.note = { ...state.note, text: "Your team noticed 1 thing and drafted it\n1. Tara drafted a Diwali post with a poster: Diwali is in about 23 days. [[approval:standup-diwali]]\n\nSignups held steady." };
    state.drafts = [draft];
    const out = await syncArea("aamdani", r.deps, src);
    expect(out).toMatchObject({ note: true, today: 1 });
    const inNote = [...r.hub.messages.values()].filter((m) => m.channelId === noteCh);
    expect(inNote).toHaveLength(3); // the first note, the note with the stand-up, the draft
    const posted = inNote.at(-1)!;
    expect(posted.content).toContain("drafted by Tara");
    expect(posted.content).toContain("Why: Diwali is in about 23 days.");
    expect(posted.buttons).toEqual(["allevia:approve:approval:standup-diwali", "allevia:change:approval:standup-diwali", "allevia:reject:approval:standup-diwali"]);
    expect((await syncArea("aamdani", r.deps, src)).today).toBeUndefined(); // once
    state.drafts[0] = { ...draft, status: "approved" };
    await syncArea("aamdani", r.deps, src);
    expect(posted.buttons).toEqual([]);
  });

  it("does nothing for a business that is not ready", async () => {
    const r = rig(kind);
    r.hub.fail = (op) => (op === "createRole" ? "down" : undefined);
    await provisionCustomer("aamdani", r.deps).catch(() => undefined);
    const src: TenantSource = { pendingApprovals: async () => [card("approval:x")], approval: async () => null, latestBrief: async () => null };
    expect(await syncArea("aamdani", r.deps, src)).toEqual({ cards: 0, note: false, closed: 0 });
  });
});
