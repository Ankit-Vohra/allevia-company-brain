// Setting up a customer's area on the hub, automatically: provisionCustomer(tenant).
//   role      customer-<slug>        no permissions of its own; it only unlocks the area
//   category  <Business name>        private: only that role, the Allevia staff role and the bot can see it
//   #your-team    ask the team anything; each question opens a thread
//   #approvals    waiting-for-OK cards with the thing itself and Approve / Change / No thanks buttons (the customer can read it, not type in it)
//   #todays-note  the daily note (read-only for the customer)
//   #support      humans only: the agents never answer it; the bot copies it to the staff-only #support-inbox
//   a welcome message in plain words, and a single-use join link (1 use, 7 days) on #your-team
// Idempotent: every piece is looked up by the id saved in allevia_meta (then, if the save was lost, by exact name),
// created only when missing, and its permissions are put back to exactly what they should be. Each id is saved the
// moment it exists, so a run that stops half way is finished by the next run and never duplicates anything.
// Permissions are managed here: a hand-added overwrite on a customer channel is removed by the next run, on purpose
// (isolation first); use the roles.
import { graphName } from "../graph/client.js";
import { oneLineWhy, renderApproval, verdictLine, type CardExtras, type CardOpts } from "./approval-card.js";
import type { ActionTarget } from "../actions/target.js";
import { renderCitations, splitMessage } from "./format.js";
import {
  CHANNEL_KINDS, INBOX_NAME, INVITE_MAX_AGE_SECONDS, STAFF_CATEGORY_NAME, categoryNameFor, roleNameFor, sameOverwrites,
  type AreaRecord, type ChannelInfo, type ChannelKind, type HubPort, type HubRecord, type HubStore, type InviteRecord, type Overwrite,
  type PermName, type RoleInfo,
} from "./hub-types.js";
import type { DiscordHome } from "../../shared/contracts.js";
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
    case "your-team":
    case "studio":
      return [everyone, { id: w.role, type: "role", allow: WRITE, deny: NO_NEW_THREADS_OR_PINGS }, staffRead, bot];
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

const CHANNEL_NAME: Record<ChannelKind, string> = { "your-team": "your-team", studio: "studio", approvals: "approvals", "todays-note": "todays-note", support: "support" };
const CHANNEL_TOPIC: Record<ChannelKind, string> = {
  "your-team": "Ask your team anything, in your own words. Each question opens a thread and your team answers there.",
  studio: "Drop photos and videos here. Your team turns a photo into post options for your OK.",
  approvals: "Things waiting for your OK. Tap Approve, Change or No thanks. Nothing goes out until you say so.",
  "todays-note": "One short note each morning on how the business is doing.",
  support: "Talk to a real person at Allevia. Your team of assistants does not read this channel.",
};

// What the owner reads first, in plain words (docs/owner-words.md).
export function welcomeText(businessName: string, ids: Record<ChannelKind, string>): string {
  return [
    `**Welcome, ${businessName}.** This is your space with your Allevia team.`,
    "",
    `<#${ids["your-team"]}> Ask anything in your own words. Each question gets its own thread, and your team answers there.`,
    `<#${ids.studio}> Drop a photo or a video. Your team makes post options from a photo, and you pick one.`,
    `<#${ids.approvals}> Things waiting for your OK. Tap Approve, Change or No thanks. Nothing goes out until you say so.`,
    `<#${ids["todays-note"]}> One short note each morning on how the business is doing.`,
    `<#${ids.support}> Talk to a real person at Allevia. Your team of assistants does not read this channel.`,
    "",
    "**Try this first:** ask here, \"What should we fix first on the website?\"",
  ].join("\n");
}

// ---------- the hub itself ----------

// The "Allevia Staff" category at the top of the server, with the staff-only #support-inbox in it. Created once and
// repaired when it goes missing, out of place or open to the wrong people. Fails clearly when the staff role is wrong.
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

  // the category
  let cat = rec?.staffCategoryId ? channels.find((c) => c.id === rec.staffCategoryId && c.kind === "category") : undefined;
  if (!cat) cat = channels.find((c) => c.kind === "category" && c.name === STAFF_CATEGORY_NAME && sameOverwrites(c.overwrites, want));
  if (!cat) {
    cat = await hub.createChannel({ name: STAFF_CATEGORY_NAME, kind: "category", position: 0, overwrites: want });
    channels.push(cat);
  } else {
    if (!sameOverwrites(cat.overwrites, want)) { await hub.editChannel(cat.id, { overwrites: want }); cat.overwrites = want; }
    if (cat.name !== STAFF_CATEGORY_NAME) await hub.editChannel(cat.id, { name: STAFF_CATEGORY_NAME });
  }
  // at the top: first among the server's categories
  const first = channels.filter((c) => c.kind === "category").sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1))[0];
  if (first && first.id !== cat.id) {
    await hub.editChannel(cat.id, { position: 0 });
    for (const c of channels) if (c.kind === "category" && c.id !== cat.id && c.position <= cat.position) c.position += 1;
    cat.position = 0;
  }

  // the inbox, inside it
  let inbox = rec?.supportInboxId ? channels.find((c) => c.id === rec.supportInboxId && c.kind === "text") : undefined;
  if (!inbox) inbox = channels.find((c) => c.kind === "text" && c.name === INBOX_NAME && sameOverwrites(c.overwrites, want));
  if (!inbox) {
    inbox = await hub.createChannel({ name: INBOX_NAME, kind: "text", parentId: cat.id, topic: "What customers write in #support, with a link to each message. Staff only.", overwrites: want });
    channels.push(inbox);
  } else {
    const patch: { parentId?: string; overwrites?: Overwrite[] } = {};
    if (inbox.parentId !== cat.id) patch.parentId = cat.id;
    if (!sameOverwrites(inbox.overwrites, want)) patch.overwrites = want;
    if (Object.keys(patch).length) {
      await hub.editChannel(inbox.id, patch);
      if (patch.parentId) inbox.parentId = patch.parentId;
      if (patch.overwrites) inbox.overwrites = want;
    }
  }
  const out: HubRecord = { guildId: hub.guildId, staffCategoryId: cat.id, supportInboxId: inbox.id, updatedAt: now };
  if (rec?.supportInboxId !== inbox.id || rec?.staffCategoryId !== cat.id) await store.saveHub(out);
  return rec?.supportInboxId === inbox.id && rec?.staffCategoryId === cat.id ? rec : out;
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

    // 3. the five channels, always in the same order
    const ids: Partial<Record<ChannelKind, string>> = {};
    for (const kind of CHANNEL_KINDS) {
      const want = areaOverwrites(kind, who);
      const name = CHANNEL_NAME[kind];
      let ch = (area.channels[kind] ? channels.find((c) => c.id === area.channels[kind] && c.kind === "text") : undefined)
        ?? channels.find((c) => c.kind === "text" && c.name === name && c.parentId === category!.id && !claimedElsewhere.has(c.id));
      if (!ch) {
        ch = await hub.createChannel({ name, kind: "text", parentId: category.id, topic: CHANNEL_TOPIC[kind], position: CHANNEL_KINDS.indexOf(kind), overwrites: want });
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
    // the order: your-team, studio, approvals, todays-note, support (put back when someone drags them about)
    const mine = CHANNEL_KINDS.map((k) => channels.find((c) => c.id === ids[k])!);
    const actual = [...mine].sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1)).map((c) => c.id);
    if (actual.join() !== mine.map((c) => c.id).join()) {
      for (const [i, c] of mine.entries()) await hub.editChannel(c.id, { position: i });
      mine.forEach((c, i) => { c.position = i; });
      did("put the channels back in order");
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

export type { DiscordHome };

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
  // where the business's approved fixes go, for the plain wording on a fix card (absent: "a to-do in your tasks")
  actionTarget?(): Promise<ActionTarget | undefined>;
  // Today's stand-up drafts still waiting for the owner, with the one-line reason for each (src/proactive). Absent: none.
  standupCards?(): Promise<Array<{ approval: ApprovalDto; why: string }>>;
  // What goes on a card besides its text: the one-line reason, the pictures or clips, what the page says now, who a message
  // goes to (approval-extras.ts). Absent: the card is the text alone.
  extras?(a: ApprovalDto, standupWhy?: string): Promise<CardExtras>;
}

// A backlog is posted over a few syncs rather than all at once (Discord limits how fast a bot may post).
export const MAX_CARDS_PER_SYNC = 20;
const cardOpts = async (t: Promise<ActionTarget | undefined>): Promise<{ target?: ActionTarget }> => { const x = await t; return x ? { target: x } : {}; };
const SYNC_LOCK_MS = 3 * 60_000;

export interface SyncResult { cards: number; note: boolean; closed: number; today?: number; more?: number }

// Posts what is new, once: every pending approval into #approvals as a card with the thing itself (the full text, the
// picture or clip attached, who a message goes to, what the page says now), the reason in a line, and Approve, Change and
// No thanks; the newest note into #todays-note, then today's stand-up drafts under it the same way; and, for a card that was
// decided (here or on the web), takes the buttons off and shows the result. A note that gained the stand-up after it was first
// posted is posted once more. One poster per business at a time, across processes (the web server posts a new card at once,
// the bot syncs every minute).
export async function syncArea(slug: string, d: Pick<ProvisionDeps, "hub" | "store" | "now" | "log">, src: TenantSource): Promise<SyncResult> {
  const now = (d.now ?? Date.now)();
  const token = await d.store.claimSync?.(slug, now, SYNC_LOCK_MS);
  if (d.store.claimSync && !token) return { cards: 0, note: false, closed: 0 }; // someone else is posting for this business right now
  try {
    return await syncAreaLocked(slug, d, src, now);
  } finally {
    if (token) await d.store.releaseSync?.(slug, token).catch(() => undefined);
  }
}

async function syncAreaLocked(slug: string, d: Pick<ProvisionDeps, "hub" | "store" | "now" | "log">, src: TenantSource, now: number): Promise<SyncResult> {
  const { hub, store } = d;
  const area = await store.getArea(slug);
  const approvals = area?.channels.approvals;
  const noteChannel = area?.channels["todays-note"];
  const out: SyncResult = { cards: 0, note: false, closed: 0 };
  if (!area || area.status !== "ready" || !approvals || !noteChannel) return out;

  // One card: the first message carries the attachments and the buttons, a long text follows in plain messages. A card whose
  // pictures Discord refuses is posted again without them (and says so) rather than not at all.
  const post = async (channelId: string, a: ApprovalDto, extras: CardExtras, opts: CardOpts): Promise<string> => {
    const card = renderApproval(a, extras, opts);
    let m: { id: string };
    try {
      m = await hub.sendMessage(channelId, { content: card.first.content, buttons: card.first.buttons, ...(card.first.files ? { files: card.first.files } : {}) });
    } catch (e) {
      if (!card.first.files) throw e;
      d.log?.(`[hub] ${slug}: could not attach files to ${a.id} (${e instanceof Error ? e.message : String(e)}); posting it without them`);
      const plain = renderApproval(a, { ...extras, files: undefined, notAttached: (extras.notAttached ?? 0) + card.first.files.length }, opts);
      m = await hub.sendMessage(channelId, { content: plain.first.content, buttons: plain.first.buttons });
    }
    for (const part of card.rest) await hub.sendMessage(channelId, part);
    return m.id;
  };
  const extrasOf = async (a: ApprovalDto, why?: string): Promise<CardExtras> => (await src.extras?.(a, why).catch((e) => {
    d.log?.(`[hub] ${slug}: could not look up the extras for ${a.id}: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  })) ?? {};

  let target: Promise<ActionTarget | undefined> | undefined; // read once, only when a card is posted
  const pending = (await src.pendingApprovals()).slice().sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
  // a stand-up draft is posted once, under Today's note, not again in #approvals
  const standup = (await src.standupCards?.()) ?? [];
  const underNote = new Set(standup.map((x) => x.approval.id));
  const fresh: ApprovalDto[] = [];
  for (const a of pending) {
    if (underNote.has(a.id)) continue;
    const prior = await store.getPost(`${slug}|approval|${a.id}`);
    if (!prior?.messageId) fresh.push(a);
  }
  for (const a of fresh.slice(0, MAX_CARDS_PER_SYNC)) {
    const key = `${slug}|approval|${a.id}`;
    const opts = await cardOpts((target ??= src.actionTarget?.().catch(() => undefined) ?? Promise.resolve(undefined)));
    const id = await post(approvals, a, await extrasOf(a), opts);
    await store.savePost({ key, slug, kind: "approval", refId: a.id, channelId: approvals, messageId: id, closed: false, postedAt: now });
    out.cards++;
  }
  if (fresh.length > MAX_CARDS_PER_SYNC) out.more = fresh.length - MAX_CARDS_PER_SYNC;

  for (const p of await store.openApprovalPosts(slug)) {
    if (!p.messageId) continue;
    const a = await src.approval(p.refId);
    if (a && a.status === "pending") continue;
    if (a) {
      const x = await extrasOf(a);
      const card = renderApproval(a, { ...x, files: undefined }, { buttons: false, standup: p.key.includes("|today|") });
      await hub.editMessage(p.channelId, p.messageId, { content: `${card.first.content}\n${verdictLine(a)}`, buttons: [] }).catch(() => undefined);
    }
    await store.savePost({ ...p, closed: true });
    out.closed++;
  }
  const b = await src.latestBrief();
  if (b?.text.trim()) {
    const key = `${slug}|note|${b.id}${/^Your team (noticed|met) /m.test(b.text) ? "|standup" : ""}`;
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
  for (const { approval: a, why } of standup) {
    if (a.status !== "pending") continue;
    const key = `${slug}|today|${a.id}`;
    if ((await store.getPost(key))?.messageId) continue;
    const x = await extrasOf(a, why);
    const id = await post(noteChannel, a, { ...x, ...(oneLineWhy(why) ? { why: oneLineWhy(why)! } : {}) }, { standup: true });
    // kept as an approval post, so its buttons come off when it is decided anywhere
    await store.savePost({ key, slug, kind: "approval", refId: a.id, channelId: noteChannel, messageId: id, closed: false, postedAt: now });
    out.today = (out.today ?? 0) + 1;
  }
  return out;
}
