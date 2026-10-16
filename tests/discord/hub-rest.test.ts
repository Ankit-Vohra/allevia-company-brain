// The REST adapter (what actually goes to Discord) with a fake REST client, and `discord-hub status`'s checks over a
// fake guild. No network. The status checks are read-only: the fake records every call and the test holds it to reads.
import { describe, expect, it } from "vitest";
import { checkHub, formatChecks } from "../../src/discord/hub-check.js";
import { RestHubPort } from "../../src/discord/hub-rest.js";
import { hubInviteUrl, hubSettings } from "../../src/discord/hub-service.js";
import { BOT_PERMISSION_INTEGER, BOT_PERMISSIONS, PERM, normalizeOverwrites, roleNameFor } from "../../src/discord/hub-types.js";
import { loadConfig } from "../../src/config.js";
import { FakeHub, snowflake } from "../helpers/hub-fakes.js";

// ---------- the REST adapter ----------

interface Call { method: string; route: string; body?: Record<string, any>; files?: Array<{ name: string; data: Buffer }> }
function fakeRest(answers: Record<string, unknown | ((c: Call) => unknown)>) {
  const calls: Call[] = [];
  const handle = (method: string) => async (route: string, o?: { body?: Record<string, any>; files?: Array<{ name: string; data: Buffer }> }) => {
    const c: Call = { method, route, ...(o?.body ? { body: o.body } : {}), ...(o?.files ? { files: o.files } : {}) };
    calls.push(c);
    const a = answers[`${method} ${route}`];
    const v = typeof a === "function" ? (a as (c: Call) => unknown)(c) : a;
    if (v instanceof Error) throw v;
    return v ?? {};
  };
  const rest = { get: handle("GET"), post: handle("POST"), patch: handle("PATCH"), put: handle("PUT"), delete: handle("DELETE") };
  return { rest: rest as never, calls };
}
const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

describe("RestHubPort", () => {
  const G = "700000000000009001";
  const C = "700000000000009002";

  it("makes the customer role with no permissions, and channels with explicit permission overwrites", async () => {
    const { rest, calls } = fakeRest({
      [`POST /guilds/${G}/roles`]: { id: "r1", name: "customer-aamdani", position: 1 },
      [`POST /guilds/${G}/channels`]: (c: Call) => ({ id: "c1", name: c.body!.name, type: c.body!.type, parent_id: c.body!.parent_id ?? null, topic: c.body!.topic ?? null, permission_overwrites: c.body!.permission_overwrites }),
    });
    const hub = new RestHubPort(rest, G);
    expect(await hub.createRole("customer-aamdani")).toMatchObject({ id: "r1" });
    expect(calls[0]!.body).toEqual({ name: "customer-aamdani", permissions: "0", hoist: false, mentionable: false });
    const ch = await hub.createChannel({
      name: "approvals", kind: "text", parentId: "cat", topic: "Waiting for OK",
      overwrites: [{ id: G, type: "role", allow: [], deny: ["ViewChannel"] }, { id: "bot", type: "member", allow: ["ViewChannel", "SendMessages"], deny: [] }],
    });
    const body = calls[1]!.body!;
    expect(body).toMatchObject({ name: "approvals", type: 0, parent_id: "cat", topic: "Waiting for OK" });
    expect(body.permission_overwrites).toEqual([
      { id: G, type: 0, allow: "0", deny: String(PERM.ViewChannel) },
      { id: "bot", type: 1, allow: String(PERM.ViewChannel | PERM.SendMessages), deny: "0" },
    ]);
    // and reads them back the same way
    expect(normalizeOverwrites(ch.overwrites)).toEqual(normalizeOverwrites([
      { id: G, type: "role", allow: [], deny: ["ViewChannel"] },
      { id: "bot", type: "member", allow: ["ViewChannel", "SendMessages"], deny: [] },
    ]));
    expect(ch).toMatchObject({ kind: "text", parentId: "cat" });
  });

  it("moves a role with PATCH on the role list and reads every role's new place from the answer", async () => {
    const after = [{ id: G, name: "@everyone", position: 0 }, { id: "r1", name: "customer-aamdani", position: 6 }, { id: "bot", name: "Allevia", position: 7 }];
    const { rest, calls } = fakeRest({ [`PATCH /guilds/${G}/roles`]: after });
    const placed = await new RestHubPort(rest, G).setRolePosition("r1", 6);
    expect(calls[0]).toMatchObject({ method: "PATCH", route: `/guilds/${G}/roles`, body: [{ id: "r1", position: 6 }] });
    expect(placed.find((r) => r.id === "r1")).toEqual({ id: "r1", name: "customer-aamdani", position: 6 });
    // an answer that is not a list is no list of roles
    expect(await new RestHubPort(fakeRest({}).rest, G).setRolePosition("r1", 6)).toEqual([]);
    // a refusal reaches the caller as it is
    await expect(new RestHubPort(fakeRest({ [`PATCH /guilds/${G}/roles`]: httpError(403) }).rest, G).setRolePosition("r1", 6)).rejects.toThrow(/403/);
  });

  it("creates categories as type 4", async () => {
    const { rest, calls } = fakeRest({ [`POST /guilds/${G}/channels`]: { id: "k", name: "Aamdani", type: 4 } });
    const c = await new RestHubPort(rest, G).createChannel({ name: "Aamdani", kind: "category", overwrites: [] });
    expect(calls[0]!.body!.type).toBe(4);
    expect(c.kind).toBe("category");
  });

  it("every message goes out with no mentions allowed, and buttons become one action row", async () => {
    const { rest, calls } = fakeRest({ [`POST /channels/${C}/messages`]: { id: "m1" }, [`PATCH /channels/${C}/messages/m1`]: {} });
    const hub = new RestHubPort(rest, G);
    expect(await hub.sendMessage(C, "hello @everyone")).toEqual({ id: "m1" });
    expect(calls[0]!.body).toEqual({ content: "hello @everyone", allowed_mentions: { parse: [] } });
    await hub.sendMessage(C, { content: "card", buttons: [{ customId: "allevia:approve:x", label: "Approve", style: "success" }, { customId: "allevia:reject:x", label: "Reject", style: "danger" }] });
    expect(calls[1]!.body).toEqual({
      content: "card", allowed_mentions: { parse: [] },
      components: [{ type: 1, components: [
        { type: 2, style: 3, label: "Approve", custom_id: "allevia:approve:x" }, { type: 2, style: 4, label: "Reject", custom_id: "allevia:reject:x" },
      ] }],
    });
    await hub.editMessage(C, "m1", { content: "done", buttons: [] });
    expect(calls[2]!.body).toMatchObject({ content: "done", components: [], allowed_mentions: { parse: [] } });
  });

  it("sends a card's pictures as attachments with the message, and none when there are none (audit #39)", async () => {
    const { rest, calls } = fakeRest({ [`POST /channels/${C}/messages`]: { id: "m9" } });
    const hub = new RestHubPort(rest, G);
    await hub.sendMessage(C, { content: "card", files: [{ name: "option-a.jpg", data: Buffer.from("jpg") }] });
    expect(calls[0]!.files).toEqual([{ name: "option-a.jpg", data: Buffer.from("jpg") }]);
    await hub.sendMessage(C, { content: "plain" });
    expect(calls[1]!.files).toBeUndefined();
  });

  it("makes a single-use, seven-day invite; reads a channel's invites; treats 'cannot see' as unknown, not as empty", async () => {
    const { rest, calls } = fakeRest({
      [`POST /channels/${C}/invites`]: { code: "abc", uses: 0, max_uses: 1, channel: { id: C }, expires_at: "2026-10-22T00:00:00.000Z" },
      [`GET /channels/${C}/invites`]: [{ code: "abc", uses: 1, max_uses: 1, channel: { id: C }, expires_at: null }],
      [`GET /channels/${G}/invites`]: httpError(403),
    });
    const hub = new RestHubPort(rest, G);
    const inv = await hub.createInvite(C, { maxUses: 1, maxAgeSeconds: 604800 });
    expect(calls[0]!.body).toEqual({ max_age: 604800, max_uses: 1, unique: true, temporary: false });
    expect(inv).toMatchObject({ code: "abc", maxUses: 1, expiresAt: Date.parse("2026-10-22T00:00:00.000Z") });
    expect(await hub.listInvites(C)).toEqual([{ code: "abc", channelId: C, uses: 1, maxUses: 1, expiresAt: null }]);
    expect(await hub.listInvites(G)).toBeNull();
  });

  it("deleting an invite that is already gone is fine; messageExists says no on 404 and rethrows other errors", async () => {
    const { rest } = fakeRest({ "DELETE /invites/gone": httpError(404), "DELETE /invites/bad": httpError(500), [`GET /channels/${C}/messages/m404`]: httpError(404), [`GET /channels/${C}/messages/m500`]: httpError(500), [`GET /channels/${C}/messages/ok`]: { id: "ok" } });
    const hub = new RestHubPort(rest, G);
    await expect(hub.deleteInvite("gone")).resolves.toBeUndefined();
    await expect(hub.deleteInvite("bad")).rejects.toThrow(/500/);
    expect(await hub.messageExists(C, "m404")).toBe(false);
    expect(await hub.messageExists(C, "ok")).toBe(true);
    await expect(hub.messageExists(C, "m500")).rejects.toThrow(/500/);
  });

  it("gives a member a role with PUT", async () => {
    const { rest, calls } = fakeRest({});
    await new RestHubPort(rest, G).addMemberRole("u1", "r1");
    expect(calls[0]).toMatchObject({ method: "PUT", route: `/guilds/${G}/members/u1/roles/r1` });
  });

  it("works out the bot's permissions from all its roles (Administrator is everything) and reads the intents from the application", async () => {
    const need = Number(BOT_PERMISSION_INTEGER);
    const roles = [
      { id: G, name: "@everyone", position: 0, permissions: "0" },
      { id: "botrole", name: "Allevia", position: 7, permissions: String(need) },
      { id: "other", name: "Other", position: 3, permissions: String(PERM.Administrator) },
    ];
    const answers = { "GET /users/%40me": { id: "bot1" }, [`GET /guilds/${G}/roles`]: roles, [`GET /guilds/${G}/members/bot1`]: { roles: ["botrole"] } };
    const hub = new RestHubPort(fakeRest(answers).rest, G);
    expect(await hub.botTopRolePosition()).toBe(7);
    const have = await hub.botPermissions();
    for (const p of BOT_PERMISSIONS) expect((have & PERM[p]) === PERM[p]).toBe(true);
    expect((have & PERM.MentionEveryone) === PERM.MentionEveryone).toBe(false);
    const admin = new RestHubPort(fakeRest({ ...answers, [`GET /guilds/${G}/members/bot1`]: { roles: ["other"] } }).rest, G);
    expect((await admin.botPermissions() & PERM.ManageRoles) === PERM.ManageRoles).toBe(true);

    const flags = (n: bigint) => new RestHubPort(fakeRest({ "GET /applications/@me": { flags: Number(n) } }).rest, G).intents();
    expect(await flags((1n << 14n) | (1n << 18n))).toEqual({ serverMembers: true, messageContent: true });
    expect(await flags((1n << 15n) | (1n << 19n))).toEqual({ serverMembers: true, messageContent: true }); // the "limited" flags of a small bot
    expect(await flags(0n)).toEqual({ serverMembers: false, messageContent: false });
  });
});

// ---------- the settings ----------

describe("hub settings", () => {
  const cfg = (env: Record<string, string>) => loadConfig({ ALLEVIA_ENV_FILE: "/nonexistent/allevia.env", ...env } as never);

  it("hub mode is on exactly when DISCORD_HUB_GUILD_ID is set, and says which names are missing, never values", () => {
    expect(hubSettings(cfg({}))).toEqual({ configured: false, missing: [] });
    expect(hubSettings(cfg({ DISCORD_GUILD_ID: "1", DISCORD_CHANNEL_ID: "2", DISCORD_BOT_TOKEN: "t" })).configured).toBe(false); // the old demo settings alone
    expect(hubSettings(cfg({ DISCORD_HUB_GUILD_ID: "5" }))).toEqual({ configured: true, missing: ["DISCORD_BOT_TOKEN", "DISCORD_STAFF_ROLE_ID"] });
    const ok = hubSettings(cfg({ DISCORD_HUB_GUILD_ID: "5", DISCORD_STAFF_ROLE_ID: "6", DISCORD_BOT_TOKEN: "t", DISCORD_APPLICATION_ID: "9" }));
    expect(ok.missing).toEqual([]);
    expect(ok.settings).toMatchObject({ guildId: "5", staffRoleId: "6", appId: "9" });
  });

  it("the invite link asks for exactly the bot's permissions", () => {
    const url = new URL(hubInviteUrl("9"));
    expect(url.searchParams.get("client_id")).toBe("9");
    expect(url.searchParams.get("permissions")).toBe(BOT_PERMISSION_INTEGER);
    expect(url.searchParams.get("scope")).toBe("bot applications.commands");
    // no Administrator, no Manage Server, no Manage Messages
    expect(BigInt(BOT_PERMISSION_INTEGER) & (PERM.Administrator | (1n << 5n) | (1n << 13n))).toBe(0n);
  });
});

// ---------- discord-hub status ----------

describe("discord-hub status checks", () => {
  const READS = new Set(["guildName", "botTopRolePosition", "botPermissions", "intents", "listRoles", "listChannels"]);
  const setup = () => {
    const hub = new FakeHub();
    const staff = hub.addRole("Allevia staff", 10);
    return { hub, staff };
  };
  const full = (staffRoleId: string | undefined) => ({ token: true, appId: true, guildId: "set", staffRoleId });
  const failing = (cs: Awaited<ReturnType<typeof checkHub>>) => cs.filter((c) => !c.ok).map((c) => c.label);

  it("passes everything on a healthy hub, and only ever reads", async () => {
    const { hub, staff } = setup();
    const cs = await checkHub({ settings: full(staff.id), hub });
    expect(failing(cs)).toEqual([]);
    expect(cs.length).toBeGreaterThanOrEqual(8);
    for (const c of hub.calls) expect(READS.has(c.split(":")[0]!)).toBe(true);
    expect(formatChecks(cs)).toMatch(/^PASS {2}The bot is in the hub server/m);
  });

  it("settings missing: says which, and does not call Discord at all", async () => {
    const { hub } = setup();
    const cs = await checkHub({ settings: { token: false, appId: true, guildId: undefined, staffRoleId: undefined }, hub });
    expect(failing(cs)).toEqual(["The hub server is named in the settings", "The Allevia staff role is named in the settings", "The bot's token is in the settings"]);
    expect(cs.find((c) => /hub server is named/.test(c.label))!.fix).toContain("DISCORD_HUB_GUILD_ID");
    expect(cs.find((c) => /staff role is named/.test(c.label))!.fix).toContain("DISCORD_STAFF_ROLE_ID");
    expect(hub.calls).toEqual([]);
  });

  it("the bot is not in the hub yet: the fix is the invite link with the right permissions", async () => {
    const { hub, staff } = setup();
    hub.inGuild = false;
    const cs = await checkHub({ settings: full(staff.id), hub, inviteUrl: hubInviteUrl("9") });
    expect(failing(cs)).toEqual(["The bot is in the hub server"]);
    expect(cs.at(-1)!.fix).toContain(`permissions=${BOT_PERMISSION_INTEGER}`);
  });

  it("a rejected token (reset) is reported as such, without ever printing it", async () => {
    const { hub, staff } = setup();
    hub.tokenValid = false;
    const cs = await checkHub({ settings: full(staff.id), hub });
    expect(failing(cs)).toEqual(["Discord accepts the bot's token"]);
    expect(formatChecks(cs)).toMatch(/probably reset/);
  });

  it("missing permissions are named in plain words", async () => {
    const { hub, staff } = setup();
    hub.botPerms = PERM.ViewChannel | PERM.SendMessages;
    const cs = await checkHub({ settings: full(staff.id), hub });
    const bad = cs.find((c) => /every permission/.test(c.label))!;
    expect(bad.ok).toBe(false);
    expect(bad.fix).toMatch(/Manage Roles/);
    expect(bad.fix).toMatch(/Manage Channels/);
    expect(bad.fix).toMatch(/Create Invite/);
    expect(bad.fix).not.toMatch(/ViewChannel|ManageRoles/); // the words a person reads, not the code names
  });

  it("the two privileged switches are checked separately", async () => {
    const { hub, staff } = setup();
    hub.appIntents = { serverMembers: false, messageContent: true };
    expect(failing(await checkHub({ settings: full(staff.id), hub }))).toEqual(["Server Members is switched on for the bot"]);
    hub.appIntents = { serverMembers: true, messageContent: false };
    expect(failing(await checkHub({ settings: full(staff.id), hub }))).toEqual(["Message Content is switched on for the bot"]);
  });

  it("a staff role that is missing from the server, or is @everyone, fails", async () => {
    const { hub } = setup();
    expect(failing(await checkHub({ settings: full("123"), hub }))).toEqual(["The Allevia staff role exists in the hub server"]);
    expect(failing(await checkHub({ settings: full(hub.guildId), hub }))).toEqual(["The Allevia staff role exists in the hub server"]);
  });

  it("the bot's role must sit above the customer roles", async () => {
    const { hub, staff } = setup();
    hub.addRole(roleNameFor("aamdani"), 60);
    hub.botPosition = 50;
    const cs = await checkHub({ settings: full(staff.id), hub });
    expect(failing(cs)).toEqual(["The bot's role sits above the customer roles"]);
    expect(cs.find((c) => !c.ok)!.fix).toContain("customer-aamdani");
  });

  it("a customer role level with the bot's role is explained as a tie, in plain words, with what to do", async () => {
    const { hub, staff } = setup();
    hub.botPosition = 1;
    hub.addRole(roleNameFor("aamdani"), 1);
    hub.addRole(roleNameFor("avs_atelier"), 1);
    const cs = await checkHub({ settings: full(staff.id), hub });
    expect(failing(cs)).toEqual(["The bot's role sits above the customer roles"]);
    const fix = cs.find((c) => !c.ok)!.fix!;
    expect(fix).toContain("customer-aamdani, customer-avs_atelier are level with the bot's role");
    expect(fix).toContain("they share place 1 in the role list");
    expect(fix).toMatch(/counts them as level, not as one above the other/);
    expect(fix).toMatch(/very bottom of the list/); // nothing can sit below place 1: only dragging helps
    expect(fix).not.toMatch(/discord-hub provision/);
    expect(formatChecks(cs)).toMatch(/^FAIL {2}The bot's role sits above the customer roles\n {6}customer-aamdani/m);
  });

  it("a tie higher up says so and offers both fixes (drag, or provision again); roles above the bot are named apart", async () => {
    const { hub, staff } = setup();
    hub.botPosition = 50;
    hub.addRole(roleNameFor("aamdani"), 50);
    hub.addRole(roleNameFor("avs_atelier"), 60);
    hub.addRole(roleNameFor("fine"), 49);
    const cs = await checkHub({ settings: full(staff.id), hub });
    const fix = cs.find((c) => !c.ok)!.fix!;
    expect(fix).toContain("customer-aamdani is level with the bot's role: it shares place 50 in the role list with it.");
    expect(fix).toContain("customer-avs_atelier sits above the bot's role (the bot's is at place 50).");
    expect(fix).toContain("drag the bot's role above them");
    expect(fix).toContain("discord-hub provision aamdani ; discord-hub provision avs_atelier");
    expect(fix).not.toContain("customer-fine");
  });

  it("a customer role just below the bot's role passes", async () => {
    const { hub, staff } = setup();
    hub.botPosition = 50;
    hub.addRole(roleNameFor("aamdani"), 49);
    expect(failing(await checkHub({ settings: full(staff.id), hub }))).toEqual([]);
  });

  it("warns before the server's role and channel limits", async () => {
    const { hub, staff } = setup();
    for (let i = 0; i < 245; i++) hub.addRole(`r${i}`, 1);
    const cs = await checkHub({ settings: full(staff.id), hub });
    expect(failing(cs)).toEqual(["There is room for more customers (247 of 250 roles used)"]);
  });

  it("ffmpeg is optional: its absence is said, never a FAIL", async () => {
    const { hub, staff } = setup();
    const without = await checkHub({ settings: full(staff.id), hub, ffmpeg: false });
    expect(failing(without)).toEqual([]);
    expect(without.find((c) => /ffmpeg/.test(c.label))!.label).toMatch(/videos are kept but not looked at/);
    expect((await checkHub({ settings: full(staff.id), hub, ffmpeg: true })).find((c) => /ffmpeg/.test(c.label))!.label).toMatch(/videos can be looked at/);
  });

  it("an unexpected Discord outage is reported, not thrown", async () => {
    const { hub, staff } = setup();
    hub.fail = (op) => (op === "guildName" ? "socket hang up" : undefined);
    const cs = await checkHub({ settings: full(staff.id), hub });
    expect(failing(cs)).toEqual(["Discord could be reached"]);
    void snowflake;
  });
});
