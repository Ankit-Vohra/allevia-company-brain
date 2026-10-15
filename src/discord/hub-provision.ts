// Setting up a customer's area on the hub, automatically: provisionCustomer(tenant).
//   role      customer-<slug>        no permissions of its own; it only unlocks the area
//   category  <Business name>        private: only that role, the Allevia staff role and the bot can see it
//   #your-team    ask the team anything; each question opens a thread
//   #approvals    waiting-for-OK cards with Approve / Reject buttons (the customer can read it, not type in it)
//   #todays-note  the daily note (read-only for the customer)
//   #support      humans only: the agents never answer it; the bot copies it to the staff-only #support-inbox
//   a welcome message in plain words, and a single-use join link (1 use, 7 days) on #your-team
// Idempotent: every piece is looked up by the id saved in allevia_meta (then, if the save was lost, by exact name),
// created only when missing, and its permissions are put back to exactly what they should be. Each id is saved the
// moment it exists, so a run that stops half way is finished by the next run and never duplicates anything.
// Permissions are managed here: a hand-added overwrite on a customer channel is removed by the next run, on purpose
// (isolation first); use the roles.
import { graphName } from "../graph/client.js";
import { approvalCard } from "./bot.js";
import { renderCitations, splitMessage } from "./format.js";
import {
  CHANNEL_KINDS, INBOX_NAME, INVITE_MAX_AGE_SECONDS, categoryNameFor, roleNameFor, sameOverwrites,
  type AreaRecord, type ChannelInfo, type ChannelKind, type HubPort, type HubRecord, type HubStore, type InviteRecord, type Overwrite,
  type PermName, type RoleInfo,
} from "./hub-types.js";
import type { ApprovalDto } from "../server/types.js";

export interface ProvisionDeps {
  hub: HubPort;
  store: HubStore;
  staffRoleId: string;
  /** The business as the registry knows it (null: no such business). */
  tenant: (slug: string) => Promise<{ name: string } | null>;
  now?: () => number;
  log?: (line: string) => void;
  redact?: (s: string) => string;
}

export interface ProvisionOpts {
  /** Replace any open join link with a fresh one (reinvite). */
  newInvite?: boolean;
}

export interface ProvisionResult {
  slug: string;
  area: AreaRecord;
  actions: string[];          // what this run did, e.g. "created the role customer-aamdani", "kept #approvals"
  inviteUrl?: string;         // the open join link, when there is one
}

export class ProvisionBusy extends Error {
  override name = "ProvisionBusy";
}

export const MAX_ATTEMPTS = 10;
const LOCK_TTL_MS = 120_000;
export const inviteUrlOf = (code: string): string => `https://discord.gg/${code}`;

// ---------- who may do what, per channel ----------

const READ: PermName[] = ["ViewChannel", "ReadMessageHistory"];
const WRITE: PermName[] = [...READ, "SendMessages", "SendMessagesInThreads", "AttachFiles"];
const NO_NEW_THREADS_OR_PINGS: PermName[] = ["CreatePublicThreads", "CreatePrivateThreads", "MentionEveryone"];
const BOT_IN_AREA: PermName[] = [...WRITE, "CreatePublicThreads", "EmbedLinks"];

export interface Who { everyone: string; role: string; staff: string; bot: string }

export function areaOverwrites(kind: ChannelKind | "category", w: Who): Overwrite[] {
  const everyone: Overwrite = { id: w.everyone, type: "role", allow: [], deny: ["ViewChannel"] };
  const bot: Overwrite = { id: w.bot, type: "member", allow: BOT_IN_AREA, deny: [] };
  const staffRead: Overwrite = { id: w.staff, type: "role", allow: READ, deny: [] };
  switch (kind) {
    case "category": return [everyone, { id: w.role, type: "role", allow: READ, deny: [] }, staffRead, bot];
    case "your-team": return [everyone, { id: w.role, type: "role", allow: WRITE, deny: NO_NEW_THREADS_OR_PINGS }, staffRead, bot];
    case "approvals":
    case "todays-note":
      return [everyone, { id: w.role, type: "role", allow: READ, deny: ["SendMessages", "SendMessagesInThreads", ...NO_NEW_THREADS_OR_PINGS] }, staffRead, bot];
    case "support":
      return [everyone, { id: w.role, type: "role", allow: WRITE, deny: NO_NEW_THREADS_OR_PINGS }, { id: w.staff, type: "role", allow: WRITE, deny: [] }, bot];
  }
}

export function inboxOverwrites(guildId: string, staffRoleId: string, botId: string): Overwrite[] {
  return [
    { id: guildId, type: "role", allow: [], deny: ["ViewChannel"] },
    { id: staffRoleId, type: "role", allow: WRITE, deny: [] },
    { id: botId, type: "member", allow: BOT_IN_AREA, deny: [] },
  ];
}

const CHANNEL_NAME: Record<ChannelKind, string> = { "your-team": "your-team", approvals: "approvals", "todays-note": "todays-note", support: "support" };
const CHANNEL_TOPIC: Record<ChannelKind, string> = {
  "your-team": "Ask your team anything, in your own words. Each question opens a thread and your team answers there.",
  approvals: "Things waiting for your OK. Tap Approve or Reject. Nothing goes out until you say so.",
  "todays-note": "One short note each morning on how the business is doing.",
  support: "Talk to a real person at Allevia. Your team of assistants does not read this channel.",
};

// What the owner reads first, in plain words (docs/owner-words.md).
export function welcomeText(businessName: string, ids: Record<ChannelKind, string>): string {
  return [
    `**Welcome, ${businessName}.** This is your space with your Allevia team.`,
    "",
    `<#${ids["your-team"]}> Ask anything in your own words. Each question gets its own thread, and your team answers there.`,
    `<#${ids.approvals}> Things waiting for your OK. Tap Approve or Reject. Nothing goes out until you say so.`,
    `<#${ids["todays-note"]}> One short note each morning on how the business is doing.`,
    `<#${ids.support}> Talk to a real person at Allevia. Your team of assistants does not read this channel.`,
    "",
    "**Try this first:** ask here, \"What should we fix first on the website?\"",
  ].join("\n");
}

// ---------- the hub itself ----------

// The staff-only #support-inbox, created once and repaired when it goes missing. Fails clearly when the staff role is wrong.
export async function ensureHubInfra(d: ProvisionDeps, snap?: { roles: RoleInfo[]; channels: ChannelInfo[] }): Promise<HubRecord> {
  const { hub, store } = d;
  const now = (d.now ?? Date.now)();
  if (d.staffRoleId === hub.guildId) throw new Error("DISCORD_STAFF_ROLE_ID is the @everyone role. Use the Allevia staff role, or everyone would see everything.");
  const roles = snap?.roles ?? await hub.listRoles();
  if (!roles.some((r) => r.id === d.staffRoleId)) throw new Error("The staff role (DISCORD_STAFF_ROLE_ID) is not in the hub server.");
  const channels = snap?.channels ?? await hub.listChannels();
  const botId = await hub.botUserId();
  const want = inboxOverwrites(hub.guildId, d.staffRoleId, botId);
  const rec = await store.getHub(hub.guildId);
  let inbox = rec?.supportInboxId ? channels.find((c) => c.id === rec.supportInboxId && c.kind === "text") : undefined;
  if (!inbox) inbox = channels.find((c) => c.kind === "text" && c.name === INBOX_NAME && c.parentId === null && sameOverwrites(c.overwrites, want));
  if (!inbox) {
    inbox = await hub.createChannel({ name: INBOX_NAME, kind: "text", topic: "What customers write in #support, with a link to each message. Staff only.", overwrites: want });
    channels.push(inbox);
  } else if (!sameOverwrites(inbox.overwrites, want)) {
    await hub.editChannel(inbox.id, { overwrites: want });
    inbox.overwrites = want;
  }
  const out: HubRecord = { guildId: hub.guildId, supportInboxId: inbox.id, updatedAt: now };
  if (rec?.supportInboxId !== inbox.id) await store.saveHub(out);
  return rec?.supportInboxId === inbox.id ? rec : out;
}

// ---------- one customer ----------

export async function provisionCustomer(slug: string, d: ProvisionDeps, opts: ProvisionOpts = {}): Promise<ProvisionResult> {
  graphName(slug); // validates the slug: lowercase words joined by "_"
  const now = d.now ?? Date.now;
  const log = d.log ?? (() => {});
  const redact = d.redact ?? ((s: string) => s);
  const { hub, store } = d;
  const token = await store.claim(slug, now(), LOCK_TTL_MS);
  if (!token) throw new ProvisionBusy(`${slug} is being set up right now by another run`);
  const before = await store.getArea(slug);
  try {
    const business = await d.tenant(slug);
    if (!business) throw new Error(`no business "${slug}" in the registry`);
    const base = { guildId: hub.guildId, businessName: business.name };
    const actions: string[] = [];
    const did = (s: string) => { actions.push(s); log(`[hub] ${slug}: ${s}`); };

    const roles = await hub.listRoles();
    const channels = await hub.listChannels();
    await ensureHubInfra(d, { roles, channels });
    const botId = await hub.botUserId();
    const area = (await store.getArea(slug)) ?? await store.saveArea(slug, base, {}, now());

    // 1. the role
    const roleName = roleNameFor(slug);
    let role = (area.roleId ? roles.find((r) => r.id === area.roleId) : undefined) ?? roles.find((r) => r.name === roleName);
    if (!role) {
      role = await hub.createRole(roleName);
      roles.push(role);
      did(`created the role ${roleName}`);
    } else did(`kept the role ${roleName}`);
    if (role.id === d.staffRoleId || role.id === hub.guildId) throw new Error(`the customer role for ${slug} resolved to the staff or @everyone role; refusing to continue`);
    await store.saveArea(slug, base, { roleId: role.id }, now());

    const who: Who = { everyone: hub.guildId, role: role.id, staff: d.staffRoleId, bot: botId };

    // 2. the private category (adopt one that is ours but unsaved: same name, our role in its permissions, nobody else's)
    const categoryName = categoryNameFor(business.name);
    const others = (await store.listAreas()).filter((a) => a.slug !== slug);
    const claimedElsewhere = new Set(others.flatMap((a) => [a.categoryId, ...Object.values(a.channels)]).filter(Boolean));
    let category = (area.categoryId ? channels.find((c) => c.id === area.categoryId && c.kind === "category") : undefined)
      ?? channels.find((c) => c.kind === "category" && c.name === categoryName && !claimedElsewhere.has(c.id) && c.overwrites.some((o) => o.id === role!.id));
    const catWant = areaOverwrites("category", who);
    if (!category) {
      category = await hub.createChannel({ name: categoryName, kind: "category", overwrites: catWant });
      channels.push(category);
      did(`created the private category "${categoryName}"`);
    } else {
      if (!sameOverwrites(category.overwrites, catWant)) {
        await hub.editChannel(category.id, { overwrites: catWant });
        category.overwrites = catWant;
        did(`fixed who can see "${categoryName}"`);
      }
      if (category.name !== categoryName) await hub.editChannel(category.id, { name: categoryName });
    }
    await store.saveArea(slug, base, { categoryId: category.id }, now());

    // 3. the four channels
    const ids: Partial<Record<ChannelKind, string>> = {};
    for (const kind of CHANNEL_KINDS) {
      const want = areaOverwrites(kind, who);
      const name = CHANNEL_NAME[kind];
      let ch = (area.channels[kind] ? channels.find((c) => c.id === area.channels[kind] && c.kind === "text") : undefined)
        ?? channels.find((c) => c.kind === "text" && c.name === name && c.parentId === category!.id && !claimedElsewhere.has(c.id));
      if (!ch) {
        ch = await hub.createChannel({ name, kind: "text", parentId: category.id, topic: CHANNEL_TOPIC[kind], overwrites: want });
        channels.push(ch);
        did(`created #${name}`);
      } else {
        const patch: { parentId?: string; topic?: string; overwrites?: Overwrite[] } = {};
        if (ch.parentId !== category.id) patch.parentId = category.id;
        if (ch.topic !== CHANNEL_TOPIC[kind]) patch.topic = CHANNEL_TOPIC[kind];
        if (!sameOverwrites(ch.overwrites, want)) patch.overwrites = want;
        if (Object.keys(patch).length) {
          await hub.editChannel(ch.id, patch);
          Object.assign(ch, { parentId: patch.parentId ?? ch.parentId, topic: patch.topic ?? ch.topic, overwrites: patch.overwrites ?? ch.overwrites });
          did(`fixed #${name}${patch.overwrites ? " (who can see and write)" : ""}`);
        } else did(`kept #${name}`);
      }
      ids[kind] = ch.id;
      // save as we go: a stop after this line never loses the channel
      await store.saveArea(slug, base, { channels: { [kind]: ch.id } }, now());
    }
    await store.setChannels(slug, hub.guildId, ids);
    const all = ids as Record<ChannelKind, string>;

    // 4. the welcome message
    const fresh = (await store.getArea(slug))!;
    if (fresh.welcomeMessageId && await hub.messageExists(all["your-team"], fresh.welcomeMessageId)) {
      did("kept the welcome message");
    } else {
      const m = await hub.sendMessage(all["your-team"], welcomeText(business.name, all));
      await store.saveArea(slug, base, { welcomeMessageId: m.id }, now());
      did("posted the welcome message");
    }

    // 5. the join link
    const invite = await ensureInvite(d, slug, all["your-team"], !!opts.newInvite, did);

    const done = await store.saveArea(slug, base, { status: "ready", attempts: 0, lastError: null, nextAttemptAt: null }, now());
    return { slug, area: done, actions, ...(invite ? { inviteUrl: invite.url } : {}) };
  } catch (e) {
    if (e instanceof ProvisionBusy) throw e;
    const message = redact(e instanceof Error ? e.message : String(e)).slice(0, 300);
    {
      const attempts = (before?.attempts ?? 0) + 1;
      const retryable = attempts < MAX_ATTEMPTS && !(e instanceof Error && /no business/.test(e.message));
      await store.saveArea(slug, { guildId: hub.guildId, businessName: before?.businessName ?? slug },
        { status: "pending", attempts, lastError: message, nextAttemptAt: retryable ? now() + Math.min(60, 2 ** attempts) * 60_000 : null }, now())
        .catch(() => undefined);
    }
    throw new Error(message);
  } finally {
    await store.release(slug, token).catch(() => undefined);
  }
}

// The business has a live join link, or somebody has already joined with one. With newInvite, the old open link is
// revoked first, so one business never has two live links.
async function ensureInvite(d: ProvisionDeps, slug: string, channelId: string, fresh: boolean, did: (s: string) => void): Promise<InviteRecord | null> {
  const { hub, store } = d;
  const now = (d.now ?? Date.now)();
  const all = await store.invites(slug);
  for (const i of all.filter((x) => x.status === "open")) {
    const live = await hub.listInvites(i.channelId);
    const there = live?.some((x) => x.code === i.code) ?? false;
    if (fresh) {
      if (there) await hub.deleteInvite(i.code).catch(() => undefined);
      await store.saveInvite({ ...i, status: "revoked" });
      did("revoked the old join link");
    } else if (i.expiresAt <= now) {
      await store.saveInvite({ ...i, status: "expired" });
    } else if (live !== null && !there) {
      await store.saveInvite({ ...i, status: "gone" }); // used while nobody was watching, or deleted by hand
    }
  }
  const current = (await store.invites(slug));
  const open = current.find((i) => i.status === "open");
  if (open && !fresh) {
    did("kept the join link");
    return open;
  }
  if (!fresh && current.some((i) => i.status === "used")) return null; // someone joined: no new link unless asked
  const made = await hub.createInvite(channelId, { maxUses: 1, maxAgeSeconds: INVITE_MAX_AGE_SECONDS });
  const rec: InviteRecord = {
    code: made.code, slug, guildId: hub.guildId, channelId, url: inviteUrlOf(made.code), maxUses: 1,
    expiresAt: made.expiresAt ?? now + INVITE_MAX_AGE_SECONDS * 1000, uses: made.uses, status: "open", createdAt: now,
  };
  await store.saveInvite(rec);
  did("made a single-use join link (7 days)");
  return rec;
}

// ---------- queued retries ----------

export interface RetryOutcome { slug: string; ok: boolean; error?: string }

// Businesses whose provisioning failed and are due again. Safe to run from several processes (one claim per business).
export async function retryDue(d: ProvisionDeps): Promise<RetryOutcome[]> {
  const now = (d.now ?? Date.now)();
  const due = (await d.store.listAreas()).filter((a) => a.status === "pending" && typeof a.nextAttemptAt === "number" && a.nextAttemptAt <= now);
  const out: RetryOutcome[] = [];
  for (const a of due) {
    try {
      await provisionCustomer(a.slug, d);
      out.push({ slug: a.slug, ok: true });
    } catch (e) {
      if (e instanceof ProvisionBusy) continue;
      out.push({ slug: a.slug, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

// ---------- what the owner sees on the web ----------

export interface DiscordHome {
  enabled: boolean;
  state?: "invite" | "joined" | "expired" | "later";
  inviteUrl?: string;
  openUrl?: string;           // joined: where the team's channel is
}

export async function homeInfo(slug: string, d: Pick<ProvisionDeps, "store" | "hub" | "now">): Promise<DiscordHome> {
  const now = (d.now ?? Date.now)();
  const area = await d.store.getArea(slug);
  if (!area || area.status !== "ready" || !area.channels["your-team"]) return { enabled: true, state: "later" };
  const invites = await d.store.invites(slug);
  const openUrl = `https://discord.com/channels/${d.hub.guildId}/${area.channels["your-team"]}`;
  if (invites.some((i) => i.status === "used")) return { enabled: true, state: "joined", openUrl };
  const live = invites.find((i) => i.status === "open" && i.expiresAt > now);
  if (live) return { enabled: true, state: "invite", inviteUrl: live.url };
  return { enabled: true, state: "expired" };
}

// ---------- approvals and the daily note into the customer's channels ----------

export interface TenantSource {
  pendingApprovals(): Promise<ApprovalDto[]>;
  approval(id: string): Promise<ApprovalDto | null>;
  latestBrief(): Promise<{ id: string; title: string; asOf?: string; text: string } | null>;
}

const MAX_CARDS = 10;

// Posts what is new, once: pending approval cards (with buttons) into #approvals, the newest note into #todays-note;
// and takes the buttons off a card that was decided somewhere else (the web).
export async function syncArea(slug: string, d: Pick<ProvisionDeps, "hub" | "store" | "now" | "log">, src: TenantSource): Promise<{ cards: number; note: boolean; closed: number }> {
  const { hub, store } = d;
  const now = (d.now ?? Date.now)();
  const area = await store.getArea(slug);
  const approvals = area?.channels.approvals;
  const noteChannel = area?.channels["todays-note"];
  const out = { cards: 0, note: false, closed: 0 };
  if (!area || area.status !== "ready" || !approvals || !noteChannel) return out;

  for (const a of (await src.pendingApprovals()).slice(0, MAX_CARDS)) {
    const key = `${slug}|approval|${a.id}`;
    if (await store.getPost(key)) continue;
    const m = await hub.sendMessage(approvals, approvalCard(a));
    await store.savePost({ key, slug, kind: "approval", refId: a.id, channelId: approvals, messageId: m.id, closed: false, postedAt: now });
    out.cards++;
  }
  for (const p of await store.openApprovalPosts(slug)) {
    const a = await src.approval(p.refId);
    if (a && a.status === "pending") continue;
    if (a) {
      const verdict = a.status === "rejected" ? "❌ Rejected" : "✅ Approved";
      await hub.editMessage(p.channelId, p.messageId, { content: `${approvalCard(a, { buttons: false }).content}\n${verdict}`, buttons: [] }).catch(() => undefined);
    }
    await store.savePost({ ...p, closed: true });
    out.closed++;
  }
  const b = await src.latestBrief();
  if (b?.text.trim()) {
    const key = `${slug}|note|${b.id}`;
    if (!(await store.getPost(key))) {
      const parts = splitMessage(`**${b.title}**${b.asOf ? ` · as of ${b.asOf}` : ""}\n\n${renderCitations(b.text, new Map())}`);
      let first: string | undefined;
      for (const part of parts) {
        const m = await hub.sendMessage(noteChannel, part);
        first ??= m.id;
      }
      await store.savePost({ key, slug, kind: "note", refId: b.id, channelId: noteChannel, messageId: first ?? "", closed: true, postedAt: now });
      out.note = true;
    }
  }
  return out;
}
