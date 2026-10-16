// `discord-hub status`: is everything the hub needs in place? Read-only: it only reads from Discord and from the
// registry, never creates or changes anything, and it never prints a token. The answer is a plain pass / fail list;
// each failure says what to do about it.
import { BOT_PERMISSIONS, CHANNEL_KINDS, PERM, roleNameFor, statusOf, type ChannelKind, type HubPort, type HubStore, type PermName, type RoleInfo } from "./hub-types.js";

export interface Check { ok: boolean; label: string; fix?: string }

export interface CheckDeps {
  settings: { token: boolean; appId: boolean; guildId?: string; staffRoleId?: string };
  hub?: HubPort;              // absent when the settings are not complete
  store?: HubStore;
  inviteUrl?: string;         // the link that adds the bot to the hub with the right permissions
  ffmpeg?: boolean;           // is ffmpeg on this machine (optional: without it videos are kept but not looked at)
}

const PLAIN: Record<PermName, string> = {
  CreateInstantInvite: "Create Invite", ManageChannels: "Manage Channels", Administrator: "Administrator", AddReactions: "Add Reactions",
  ViewChannel: "View Channels", SendMessages: "Send Messages", EmbedLinks: "Embed Links", AttachFiles: "Attach Files",
  ReadMessageHistory: "Read Message History", MentionEveryone: "Mention Everyone", ManageRoles: "Manage Roles",
  CreatePublicThreads: "Create Public Threads", CreatePrivateThreads: "Create Private Threads", SendMessagesInThreads: "Send Messages in Threads",
};

const ROLE_LIMIT = 250;
const CHANNEL_LIMIT = 500;

// Discord lets a bot give out only roles that sit strictly below its own highest role. A role at the same place in the
// list as the bot's is level with it, not below it, so the bot cannot give it out (seen on the hub on 2026-10-16, issue
// #42). That happens when roles are made with no order set: they all land at the bottom, at place 1, together with the
// bot's own. This says which of the two it is (level or above), and what to do, in the words a person reads.
export function roleOrderCheck(customers: RoleInfo[], botTop: number): [boolean, string, string] {
  const label = "The bot's role sits above the customer roles";
  const level = customers.filter((r) => r.position === botTop);
  const over = customers.filter((r) => r.position > botTop);
  if (!level.length && !over.length) return [true, label, ""];
  const names = (rs: RoleInfo[]) => rs.map((r) => r.name).join(", ");
  const parts: string[] = [];
  if (level.length) {
    parts.push(`${names(level)} ${level.length === 1 ? "is" : "are"} level with the bot's role: ${level.length === 1 ? "it shares" : "they share"} place ${botTop} in the role list with it. `
      + "When two roles share a place Discord counts them as level, not as one above the other, and a bot can only give out roles below its own, so nobody can be given a level role.");
  }
  if (over.length) parts.push(`${names(over)} ${over.length === 1 ? "sits" : "sit"} above the bot's role (the bot's is at place ${botTop}).`);
  if (botTop < 2) {
    parts.push("The bot's role is at the very bottom of the list, so nothing can sit below it. In Server Settings > Roles, drag it up above the customer roles.");
  } else {
    const slugs = [...level, ...over].map((r) => r.name.slice(roleNameFor("").length));
    parts.push("Fix: in Server Settings > Roles, drag the bot's role above them (dragging also gives every role a place of its own, which ends the tie). "
      + `Or run: ${slugs.map((s) => `discord-hub provision ${s}`).join(" ; ")} (it puts the role just below the bot's; if Discord refuses that, drag).`);
  }
  return [false, label, parts.join(" ")];
}

export async function checkHub(d: CheckDeps): Promise<Check[]> {
  const out: Check[] = [];
  const add = (ok: boolean, label: string, fix?: string) => out.push({ ok, label, ...(fix && !ok ? { fix } : {}) });

  add(!!d.settings.guildId, "The hub server is named in the settings", "Add DISCORD_HUB_GUILD_ID to ~/.config/allevia/allevia.env.");
  add(!!d.settings.staffRoleId, "The Allevia staff role is named in the settings", "Add DISCORD_STAFF_ROLE_ID to ~/.config/allevia/allevia.env.");
  add(d.settings.token, "The bot's token is in the settings", "Add DISCORD_BOT_TOKEN to ~/.config/allevia/allevia.env.");
  add(d.settings.appId, "The bot's application id is in the settings", "Add DISCORD_APPLICATION_ID to ~/.config/allevia/allevia.env.");
  const hub = d.hub;
  if (!hub || !d.settings.token || !d.settings.guildId) return out;

  try {
    const name = await hub.guildName();
    out.push({ ok: true, label: `The bot is in the hub server${name ? ` ("${name}")` : ""}` });
  } catch (e) {
    const s = statusOf(e);
    if (s === 401) add(false, "Discord accepts the bot's token", "Discord refused the token, so it was probably reset. Copy the new one into DISCORD_BOT_TOKEN.");
    else if (s === 403 || s === 404) add(false, "The bot is in the hub server", `The bot has not been added to the hub server yet.${d.inviteUrl ? ` The server owner can add it with this link: ${d.inviteUrl}` : ""}`);
    else add(false, "Discord could be reached", "Discord did not answer. Try again in a minute.");
    return out;
  }

  try {
    const have = await hub.botPermissions();
    const missing = BOT_PERMISSIONS.filter((p) => (have & PERM[p]) !== PERM[p]);
    add(missing.length === 0, "The bot has every permission it needs", `Missing: ${missing.map((p) => PLAIN[p]).join(", ")}. Give the bot's role these in Server Settings > Roles.`);
  } catch {
    add(false, "The bot's permissions could be read", "Discord would not show them. Check the bot is in the server.");
  }

  try {
    const i = await hub.intents();
    add(i.serverMembers, "Server Members is switched on for the bot", "In the Developer Portal open the bot's page and turn on Server Members Intent. Without it nobody gets their role when they join.");
    add(i.messageContent, "Message Content is switched on for the bot", "In the Developer Portal turn on Message Content Intent, so the team can read what customers write.");
  } catch {
    add(false, "The bot's switches in the Developer Portal could be read", "Discord would not show them.");
  }

  try {
    const roles = await hub.listRoles();
    const staff = d.settings.staffRoleId;
    add(!!staff && staff !== hub.guildId && roles.some((r) => r.id === staff), "The Allevia staff role exists in the hub server",
      staff === hub.guildId ? "DISCORD_STAFF_ROLE_ID is the @everyone role. Use the staff role's own id." : "That role id is not in the hub server. Check DISCORD_STAFF_ROLE_ID.");
    const customers = roles.filter((r) => r.name.startsWith(roleNameFor("")));
    const top = await hub.botTopRolePosition();
    add(...roleOrderCheck(customers, top));
    add(roles.length < ROLE_LIMIT - 10, `There is room for more customers (${roles.length} of ${ROLE_LIMIT} roles used)`, "Discord allows 250 roles in one server. Each customer uses one. Time for a second hub.");
    const channels = await hub.listChannels();
    add(channels.length < CHANNEL_LIMIT - 10, `There is room for more customers (${channels.length} of ${CHANNEL_LIMIT} channels used)`, "Discord allows 500 channels in one server. Each customer uses five. Time for a second hub.");
  } catch {
    add(false, "The server's roles and channels could be read", "Discord would not show them.");
  }

  if (d.ffmpeg !== undefined) {
    out.push({ ok: true, label: d.ffmpeg ? "ffmpeg is installed, so videos can be looked at" : "ffmpeg is not installed: videos are kept but not looked at (optional; install ffmpeg to change that)" });
  }

  if (d.store) {
    try {
      const areas = await d.store.listAreas();
      const pending = areas.filter((a) => a.status !== "ready");
      out.push({ ok: true, label: `${areas.length - pending.length} customer${areas.length - pending.length === 1 ? "" : "s"} set up on the hub${pending.length ? `, ${pending.length} waiting to be set up` : ""}` });
    } catch {
      add(false, "The customer list could be read", "The graph database did not answer. Is it running?");
    }
  }
  return out;
}

export function formatChecks(checks: Check[]): string {
  return checks.map((c) => `${c.ok ? "PASS" : "FAIL"}  ${c.label}${c.fix ? `\n      ${c.fix}` : ""}`).join("\n");
}

// ---------- discord-hub list ----------

export interface CompanyRow {
  slug: string;
  name: string;
  status: "ready" | "pending";
  roleHere: boolean;
  inOrder: boolean;           // the channels sit in the order your-team, studio, approvals, todays-note, support
  channels: Array<{ kind: ChannelKind; id: string; here: boolean }>;
  join: "invite" | "joined" | "expired" | "none";
  error?: string;
}

// Every company on the hub with its channels, checked against Discord. Read-only.
export async function listCompanies(d: { hub: HubPort; store: HubStore; now?: () => number }): Promise<CompanyRow[]> {
  const now = (d.now ?? Date.now)();
  const [areas, channels, roles] = await Promise.all([d.store.listAreas(), d.hub.listChannels(), d.hub.listRoles()]);
  const rows: CompanyRow[] = [];
  for (const a of areas) {
    const invites = await d.store.invites(a.slug);
    const mine = CHANNEL_KINDS.filter((k) => a.channels[k]).map((k) => ({ kind: k, id: a.channels[k]!, here: channels.some((c) => c.id === a.channels[k]) }));
    const order = mine.filter((c) => c.here).map((c) => channels.find((x) => x.id === c.id)!).sort((x, y) => x.position - y.position || (x.id < y.id ? -1 : 1)).map((c) => c.id);
    rows.push({
      slug: a.slug, name: a.businessName, status: a.status, roleHere: !!a.roleId && roles.some((r) => r.id === a.roleId),
      inOrder: order.join() === mine.filter((c) => c.here).map((c) => c.id).join(), channels: mine,
      join: invites.some((i) => i.status === "used") ? "joined" : invites.some((i) => i.status === "open" && i.expiresAt > now) ? "invite" : invites.length ? "expired" : "none",
      ...(a.lastError ? { error: a.lastError } : {}),
    });
  }
  return rows;
}

const JOIN_WORDS = { invite: "link sent, nobody has joined yet", joined: "joined", expired: "the link ran out", none: "no link yet" } as const;

export function formatCompanies(rows: CompanyRow[]): string {
  if (!rows.length) return "No company is set up on the hub yet.";
  return rows.map((r) => [
    `${r.name} (${r.slug}): ${r.status === "ready" ? "ready" : "waiting to be set up"}; ${JOIN_WORDS[r.join]}`,
    ...CHANNEL_KINDS.map((k) => {
      const c = r.channels.find((x) => x.kind === k);
      return `    #${k}  ${!c ? "missing: run provision" : c.here ? "ok" : "gone from Discord: run provision"}`;
    }),
    ...(r.roleHere ? [] : ["    the customer role is missing: run provision"]),
    ...(r.channels.length && !r.inOrder ? ["    the channels are out of order: run provision"] : []),
    ...(r.error ? [`    last problem: ${r.error}`] : []),
  ].join("\n")).join("\n\n");
}
