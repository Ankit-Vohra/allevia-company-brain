// Graph audit G3 and G13: the registry graph (allevia_meta) has relationships, not just nodes, and the business's own graph knows what
// the hub did for it. Registry: Tenant -HAS_AREA-> DiscordArea -HAS_CHANNEL {kind}-> DiscordChannel -POSTED-> DiscordPost, Tenant -ISSUED->
// DiscordInvite, Tenant -HAS_TOKEN-> AuthToken; a channel that stops being a business's is closed, never deleted; linkRegistry() adds what older
// rows lack and can be run again. Business graph: channel:discord PART_OF the Business, Approval -PUBLISHED_ON-> channel:discord with the
// message, Person{discordUserId} -MEMBER_OF-> Business for each person who joins. Discord is a fake guild; every graph is a throwaway one.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decideApproval } from "../../src/actions/approvals.js";
import { issueToken } from "../../src/auth/tokens.js";
import { HubBot, type JoinPort } from "../../src/discord/hub-bot.js";
import { discordPersonId, notePosted, personOfDiscordUser, recordMember } from "../../src/discord/hub-graph.js";
import { provisionCustomer, syncArea, type ProvisionDeps, type TenantSource } from "../../src/discord/hub-provision.js";
import { tenantSource } from "../../src/discord/hub-source.js";
import { GraphHubStore } from "../../src/discord/hub-store.js";
import { CHANNEL_KINDS } from "../../src/discord/hub-types.js";
import { closeAll, openGraph, openGraphByName, type GraphHandle } from "../../src/graph/client.js";
import { businessId, ensureTenant, linkRegistry } from "../../src/graph/tenants.js";
import { upsertNode } from "../../src/graph/upsert.js";
import type { ApprovalDto } from "../../src/server/types.js";
import { FakeHub, MemoryHubStore, snowflake } from "../helpers/hub-fakes.js";
import { testGraphName } from "../helpers/graph.js";

const tag = randomBytes(3).toString("hex");
const SLUG_A = `hubg_${tag}_a`, SLUG_B = `hubg_${tag}_b`;
const dropMe: string[] = [];
const T0 = Date.parse("2026-10-16T08:00:00Z");

let meta: string;
let store: GraphHubStore;
let hub: FakeHub;
let deps: ProvisionDeps;
let clock: { t: number };
let gA: GraphHandle;
let reg: GraphHandle;
const rows = <T>(g: GraphHandle, q: string, p: Record<string, unknown> = {}) => g.roQuery<T>(q, p);
const count = async (g: GraphHandle, q: string, p: Record<string, unknown> = {}) => (await rows<{ c: number }>(g, q, p))[0]?.c ?? 0;

beforeAll(async () => {
  meta = testGraphName();
  dropMe.push(meta);
  store = new GraphHubStore({ metaGraph: meta });
  clock = { t: T0 };
  hub = new FakeHub();
  hub.clock = () => clock.t;
  const staff = hub.addRole("Allevia staff", 10).id;
  // two businesses in the registry, each with its own graph (a throwaway name under the usual allevia_ prefix)
  await ensureTenant({ slug: SLUG_A, name: "Hub Graph A" }, { metaGraph: meta });
  await ensureTenant({ slug: SLUG_B, name: "Hub Graph B" }, { metaGraph: meta });
  dropMe.push(`allevia_${SLUG_A}`, `allevia_${SLUG_B}`);
  gA = await openGraph(SLUG_A);
  reg = await openGraphByName(meta);
  deps = {
    hub, store, staffRoleId: staff, now: () => clock.t, log: () => undefined,
    tenant: async (slug) => ({ name: slug === SLUG_A ? "Hub Graph A" : "Hub Graph B" }),
    graph: (slug) => openGraph(slug),
  };
}, 60_000);
afterAll(async () => {
  for (const n of dropMe) await (await openGraphByName(n)).drop().catch(() => undefined);
  await closeAll();
});

describe("the registry has relationships", () => {
  it("provisioning links the Tenant to its area, the area to its five channels (with their kind), and the Tenant to its join link", async () => {
    const r = await provisionCustomer(SLUG_A, deps);
    expect(r.area.status).toBe("ready");
    expect(await count(reg, "MATCH (:Tenant {slug:$s})-[r:HAS_AREA]->(:DiscordArea {slug:$s}) WHERE r.until IS NULL RETURN count(r) AS c", { s: SLUG_A })).toBe(1);
    const channels = await rows<{ kind: string; edgeKind: string; rid: number }>(reg,
      "MATCH (:Tenant {slug:$s})-[:HAS_AREA]->(:DiscordArea)-[r:HAS_CHANNEL]->(c:DiscordChannel) WHERE r.until IS NULL RETURN c.kind AS kind, r.kind AS edgeKind, id(c) AS rid ORDER BY rid", { s: SLUG_A });
    expect(channels.map((c) => c.kind).sort()).toEqual([...CHANNEL_KINDS].sort());
    for (const c of channels) expect(c.edgeKind).toBe(c.kind);
    expect(await count(reg, "MATCH (:Tenant {slug:$s})-[r:ISSUED]->(i:DiscordInvite {status:'open'}) RETURN count(r) AS c", { s: SLUG_A })).toBe(1);
    // the other business has none of it
    expect(await count(reg, "MATCH (:Tenant {slug:$s})-[r:HAS_AREA]->() RETURN count(r) AS c", { s: SLUG_B })).toBe(0);
  });

  it("a card posted is a DiscordPost in its channel, and the business is two hops up", async () => {
    const approvals = (await store.getArea(SLUG_A))!.channels.approvals!;
    const a = card("approval:hubg-1");
    await syncArea(SLUG_A, deps, source([a]));
    expect(await count(reg, "MATCH (:Tenant {slug:$s})-[:HAS_AREA]->(:DiscordArea)-[:HAS_CHANNEL]->(c:DiscordChannel {channelId:$c})-[r:POSTED]->(p:DiscordPost {refId:$id}) RETURN count(r) AS c", { s: SLUG_A, c: approvals, id: a.id })).toBe(1);
    expect(await count(reg, "MATCH (c:DiscordChannel)-[r:POSTED]->(p:DiscordPost) WHERE c.slug <> $s RETURN count(r) AS c", { s: SLUG_A })).toBe(0);
  });

  it("an owner link hangs off its business (and the secret is nowhere on the graph)", async () => {
    const t = await issueToken(SLUG_A, { label: "test" }, { metaGraph: meta });
    expect(await count(reg, "MATCH (:Tenant {slug:$s})-[r:HAS_TOKEN]->(k:AuthToken {tokenId:$id}) RETURN count(r) AS c", { s: SLUG_A, id: t.tokenId })).toBe(1);
    const [node] = await rows<{ p: Record<string, unknown> }>(reg, "MATCH (k:AuthToken {tokenId:$id}) RETURN properties(k) AS p", { id: t.tokenId });
    expect(JSON.stringify(node!.p)).not.toContain(t.token.split(".")[1]!);
    // an operator link belongs to no business: it gets no edge
    const op = await issueToken("operator", { label: "ops" }, { metaGraph: meta });
    expect(await count(reg, "MATCH ()-[r:HAS_TOKEN]->(k:AuthToken {tokenId:$id}) RETURN count(r) AS c", { id: op.tokenId })).toBe(0);
  });

  it("a channel that stops being the business's is closed, not deleted; the lookup stops answering for it and the history stays", async () => {
    const area = (await store.getArea(SLUG_A))!;
    const support = area.channels.support!;
    const keep = Object.fromEntries(Object.entries(area.channels).filter(([k]) => k !== "support")) as typeof area.channels;
    expect(await store.channel(hub.guildId, support)).toMatchObject({ slug: SLUG_A, kind: "support" });
    await store.setChannels(SLUG_A, hub.guildId, keep, T0 + 5000);
    expect(await store.channel(hub.guildId, support)).toBeNull();
    // still on record, with when it ended
    expect(await rows(reg, "MATCH (c:DiscordChannel {channelId:$c}) RETURN c.slug AS slug, c.until AS until", { c: support })).toEqual([{ slug: SLUG_A, until: T0 + 5000 }]);
    expect(await rows(reg, "MATCH (:DiscordArea {slug:$s})-[r:HAS_CHANNEL]->(c:DiscordChannel {channelId:$c}) RETURN r.kind AS kind, r.until AS until", { s: SLUG_A, c: support })).toEqual([{ kind: "support", until: T0 + 5000 }]);
    expect(await count(reg, "MATCH (:DiscordArea {slug:$s})-[r:HAS_CHANNEL]->(:DiscordChannel) WHERE r.until IS NULL RETURN count(r) AS c", { s: SLUG_A })).toBe(4);
    // the other four are untouched and still answer
    for (const id of Object.values(keep)) expect(await store.channel(hub.guildId, id!)).toMatchObject({ slug: SLUG_A });
    // put it back: the mapping opens again, the same edge, no second one
    await store.setChannels(SLUG_A, hub.guildId, area.channels, T0 + 9000);
    expect(await store.channel(hub.guildId, support)).toMatchObject({ slug: SLUG_A, kind: "support" });
    expect(await count(reg, "MATCH (:DiscordArea {slug:$s})-[r:HAS_CHANNEL]->(:DiscordChannel {channelId:$c}) RETURN count(r) AS c", { s: SLUG_A, c: support })).toBe(1);
    expect(await count(reg, "MATCH (:DiscordArea {slug:$s})-[r:HAS_CHANNEL]->(:DiscordChannel) WHERE r.until IS NULL RETURN count(r) AS c", { s: SLUG_A })).toBe(5);
  });

  it("another business cannot take an open channel, but can take one that was closed", async () => {
    const SLUG_C = `hubg_${tag}_c`, SLUG_D = `hubg_${tag}_d`;
    const ch = "444000000000000001";
    await store.setChannels(SLUG_C, hub.guildId, { support: ch }, T0 + 20_000);
    await expect(store.setChannels(SLUG_D, hub.guildId, { support: ch }, T0 + 21_000)).rejects.toThrow(/already mapped to another business/);
    await store.setChannels(SLUG_C, hub.guildId, {}, T0 + 30_000); // C lets it go: closed
    await store.setChannels(SLUG_D, hub.guildId, { support: ch }, T0 + 31_000);
    expect(await store.channel(hub.guildId, ch)).toMatchObject({ slug: SLUG_D, kind: "support" });
    expect(await rows(reg, "MATCH (c:DiscordChannel {channelId:$c}) RETURN c.slug AS slug, c.until AS until", { c: ch })).toEqual([{ slug: SLUG_D, until: null }]);
  });
});

describe("linkRegistry adds what older rows lack", () => {
  it("links rows written before the relationships existed, reports what it added, and a second run adds nothing", async () => {
    const old = testGraphName();
    dropMe.push(old);
    const og = await openGraphByName(old);
    await ensureTenant({ slug: `${SLUG_A}_old`, name: "Old one" }, { metaGraph: old });
    dropMe.push(`allevia_${SLUG_A}_old`);
    const s = `${SLUG_A}_old`;
    // rows as the first version wrote them: nodes and no edges
    await og.query("CREATE (:DiscordArea {slug:$s, guildId:'g', status:'ready', createdAt:1})", { s });
    await og.query("CREATE (:DiscordChannel {channelId:'555000000000000001', guildId:'g', slug:$s, kind:'approvals'}), (:DiscordChannel {channelId:'555000000000000002', guildId:'g', slug:$s, kind:'support'})", { s });
    await og.query("CREATE (:DiscordInvite {code:'abc', slug:$s, guildId:'g', channelId:'555000000000000001', status:'open', createdAt:2})", { s });
    await og.query("CREATE (:DiscordPost {key:$k, slug:$s, kind:'approval', refId:'approval:x', channelId:'555000000000000001', messageId:'9', closed:false, postedAt:3})", { s, k: `${s}|approval|approval:x` });
    await og.query("CREATE (:AuthToken {tokenId:'tok_old', scope:$s, hash:'h', label:'', createdAt:4})", { s });
    expect(await count(og, "MATCH ()-[r]->() WHERE ID(r) >= 0 AND type(r) IN ['HAS_AREA','HAS_CHANNEL','ISSUED','POSTED','HAS_TOKEN'] RETURN count(r) AS c")).toBe(0);

    const first = await linkRegistry({ metaGraph: old, now: T0 });
    expect(first).toEqual({ areas: 1, channels: 2, invites: 1, posts: 1, tokens: 1 });
    expect(await count(og, "MATCH (:Tenant {slug:$s})-[:HAS_AREA]->(:DiscordArea)-[r:HAS_CHANNEL]->(c:DiscordChannel)-[:POSTED]->(:DiscordPost) WHERE r.kind = 'approvals' AND c.kind = 'approvals' RETURN count(r) AS c", { s })).toBe(1);
    const second = await linkRegistry({ metaGraph: old, now: T0 + 1 });
    expect(second).toEqual({ areas: 0, channels: 0, invites: 0, posts: 0, tokens: 0 });
    expect(await count(og, "MATCH ()-[r]->() WHERE ID(r) >= 0 AND type(r) IN ['HAS_AREA','HAS_CHANNEL','ISSUED','POSTED','HAS_TOKEN'] RETURN count(r) AS c")).toBe(6);
    // the store's own link() is the same call, so the hub can run it at start
    expect(await new GraphHubStore({ metaGraph: old }).link()).toEqual({ areas: 0, channels: 0, invites: 0, posts: 0, tokens: 0 });
  });
});

// ---- the business's own graph ----

const card = (id: string): ApprovalDto => ({
  id, kind: "github_issue", status: "pending", title: "Fix the sitemap", by: "tech-lead", createdAt: new Date(T0).toISOString(),
  payload: { title: "Fix the sitemap", body: "- [ ] fix it", target: "Tasks" },
} as unknown as ApprovalDto);
const source = (cards: ApprovalDto[], over: Partial<TenantSource> = {}): TenantSource => ({
  pendingApprovals: async () => cards, approval: async (id) => cards.find((c) => c.id === id) ?? null, latestBrief: async () => null, ...over,
});

describe("the business's own graph knows about its Discord space", () => {
  it("a ready area is channel:discord, PART_OF the Business", async () => {
    expect(await rows(gA, "MATCH (c:Channel {id:'channel:discord'})-[r:PART_OF]->(b:Business) RETURN c.platform AS platform, c.name AS name, b.id AS biz, r.src AS src", {}))
      .toEqual([{ platform: "discord", name: "Discord", biz: businessId(SLUG_A), src: businessId(SLUG_A) }]);
    // a business with no area yet has no such channel
    const gB = await openGraph(SLUG_B);
    expect(await count(gB, "MATCH (c:Channel {id:'channel:discord'}) RETURN count(c) AS c")).toBe(0);
  });

  it("a card posted is Approval -PUBLISHED_ON-> channel:discord, with the message, when, and which channel it went to", async () => {
    const approvals = (await store.getArea(SLUG_A))!.channels.approvals!;
    const id = "approval:hubg-2";
    await upsertNode(gA, { type: "Approval", id, name: "github_issue: Fix the sitemap", props: { status: "pending", kind: "github_issue", payload: JSON.stringify({ title: "Fix the sitemap", body: "x" }) } }, T0);
    clock.t = T0 + 60_000;
    await syncArea(SLUG_A, deps, source([card(id)], { posted: (approvalId, p) => notePosted(gA, SLUG_A, approvalId, p) }));
    const post = await store.getPost(`${SLUG_A}|approval|${id}`);
    expect(post).toMatchObject({ channelId: approvals, closed: false });
    expect(await rows(gA, "MATCH (:Approval {id:$id})-[e:PUBLISHED_ON]->(c:Channel {id:'channel:discord'}) RETURN e.messageId AS messageId, e.postedAt AS postedAt, e.discordChannelId AS ch, e.surface AS surface, e.src AS src, e.asOf AS asOf", { id }))
      .toEqual([{ messageId: post!.messageId, postedAt: T0 + 60_000, ch: approvals, surface: "approvals", src: id, asOf: "2026-10-16" }]);
    // a card the business's graph does not hold is not made up there
    expect(await notePosted(gA, SLUG_A, "approval:not-here", { channelId: approvals, messageId: "1", postedAt: T0, surface: "approvals" })).toBeUndefined();
    expect(await count(gA, "MATCH (a:Approval {id:'approval:not-here'}) RETURN count(a) AS c")).toBe(0);
  });

  it("tenantSource gives syncArea the same hook, tied to its own graph", async () => {
    const src = tenantSource(gA, SLUG_A);
    expect(typeof src.posted).toBe("function");
    expect(tenantSource(gA).posted).toBeUndefined();
  });
});

describe("a person who joins is a Person in the business's graph", () => {
  const joinPort = (o: Partial<JoinPort> = {}): JoinPort & { gave: string[] } => {
    const gave: string[] = [];
    return { guildId: hub.guildId, userId: snowflake(), isBot: false, async addRole(r: string) { gave.push(r); }, gave, ...o };
  };

  it("joining with the link gives the role and records Person{discordUserId} MEMBER_OF the Business, named by no one's name", async () => {
    const mem = new MemoryHubStore();
    const h2 = new FakeHub();
    h2.clock = () => clock.t;
    const staff = h2.addRole("Allevia staff", 10).id;
    const d2: ProvisionDeps = { hub: h2, store: mem, staffRoleId: staff, now: () => clock.t, tenant: async () => ({ name: "Hub Graph A" }), log: () => undefined };
    const r = await provisionCustomer(SLUG_A, d2, { newInvite: true });
    const joined: string[] = [];
    const bot = new HubBot({
      guildId: h2.guildId, staffRoleId: staff, store: mem, hub: h2, log: () => undefined,
      botFor: async () => { throw new Error("no bot is needed to join"); },
      memberJoined: async (slug, m) => { joined.push(m.userId); await recordMember(await openGraph(slug), slug, m); },
    });
    const j = joinPort({ guildId: h2.guildId });
    h2.join(r.inviteUrl!.split("/").pop()!);
    await bot.onMemberJoin(j);
    expect(j.gave).toEqual([r.area.roleId]);
    expect(joined).toEqual([j.userId]);
    const person = await rows<{ id: string; name: string; discordUserId: string; src: string }>(gA,
      "MATCH (p:Person)-[e:MEMBER_OF]->(b:Business {id:$b}) WHERE p.discordUserId = $u RETURN p.id AS id, p.name AS name, p.discordUserId AS discordUserId, e.src AS src", { b: businessId(SLUG_A), u: j.userId });
    expect(person).toEqual([{ id: discordPersonId(j.userId), name: `Team member on Discord (${j.userId.slice(-4)})`, discordUserId: j.userId, src: businessId(SLUG_A) }]);
    expect(await personOfDiscordUser(gA, j.userId)).toBe(discordPersonId(j.userId));
    expect(await personOfDiscordUser(gA, snowflake())).toBeNull();
    expect(await personOfDiscordUser(gA, "not a snowflake")).toBeNull();
  });

  it("a person who could not be given the role, or came with no link, is not written down", async () => {
    const before = await count(gA, "MATCH (p:Person) WHERE p.discordUserId IS NOT NULL RETURN count(p) AS c");
    const mem = new MemoryHubStore();
    const h2 = new FakeHub();
    const staff = h2.addRole("Allevia staff", 10).id;
    const d2: ProvisionDeps = { hub: h2, store: mem, staffRoleId: staff, now: () => clock.t, tenant: async () => ({ name: "Hub Graph A" }), log: () => undefined };
    const r = await provisionCustomer(SLUG_A, d2, { newInvite: true });
    const bot = new HubBot({
      guildId: h2.guildId, staffRoleId: staff, store: mem, hub: h2, log: () => undefined, botFor: async () => { throw new Error("unused"); },
      memberJoined: async (slug, m) => { await recordMember(await openGraph(slug), slug, m); },
    });
    await bot.onMemberJoin(joinPort({ guildId: h2.guildId })); // no link used
    h2.join(r.inviteUrl!.split("/").pop()!);
    await bot.onMemberJoin(joinPort({ guildId: h2.guildId, async addRole() { throw new Error("Missing Permissions"); } })); // the role was refused
    expect(await count(gA, "MATCH (p:Person) WHERE p.discordUserId IS NOT NULL RETURN count(p) AS c")).toBe(before);
  });

  it("the approver of a card is that Person: Approval -APPROVED_BY-> Person -MEMBER_OF-> Business", async () => {
    const userId = snowflake();
    await recordMember(gA, SLUG_A, { userId, joinedAt: T0 });
    const id = "approval:hubg-3";
    await upsertNode(gA, { type: "Approval", id, name: "github_issue: Fix the title", props: { status: "pending", kind: "github_issue", payload: JSON.stringify({ title: "Fix the title", body: "- [ ] fix" }) } }, T0);
    const actor = (await personOfDiscordUser(gA, userId))!;
    const r = await decideApproval(gA, { approvalId: id, decision: "approve", actor, now: T0 + 1000 }, { tenant: SLUG_A, executors: { dryRun: true } });
    expect(r.approval.status).toMatch(/approved|executed/);
    expect(await rows(gA,
      "MATCH (:Approval {id:$id})-[e:APPROVED_BY]->(p:Person)-[:MEMBER_OF]->(b:Business) RETURN p.discordUserId AS user, b.id AS biz, e.src AS src", { id }))
      .toEqual([{ user: userId, biz: businessId(SLUG_A), src: id }]);
  });
});
