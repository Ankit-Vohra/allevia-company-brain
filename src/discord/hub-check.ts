// `discord-hub status`: is everything the hub needs in place? Read-only: it only reads from Discord and from the
// registry, never creates or changes anything, and it never prints a token. The answer is a plain pass / fail list;
// each failure says what to do about it.
import { BOT_PERMISSIONS, PERM, roleNameFor, statusOf, type HubPort, type HubStore, type PermName } from "./hub-types.js";

export interface Check { ok: boolean; label: string; fix?: string }

export interface CheckDeps {
  settings: { token: boolean; appId: boolean; guildId?: string; staffRoleId?: string };
  hub?: HubPort;              // absent when the settings are not complete
  store?: HubStore;
  inviteUrl?: string;         // the link that adds the bot to the hub with the right permissions
}

const PLAIN: Record<PermName, string> = {
  CreateInstantInvite: "Create Invite", ManageChannels: "Manage Channels", Administrator: "Administrator", AddReactions: "Add Reactions",
  ViewChannel: "View Channels", SendMessages: "Send Messages", EmbedLinks: "Embed Links", AttachFiles: "Attach Files",
  ReadMessageHistory: "Read Message History", MentionEveryone: "Mention Everyone", ManageRoles: "Manage Roles",
  CreatePublicThreads: "Create Public Threads", CreatePrivateThreads: "Create Private Threads", SendMessagesInThreads: "Send Messages in Threads",
};

const ROLE_LIMIT = 250;
const CHANNEL_LIMIT = 500;

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
    const below = customers.filter((r) => r.position >= top);
    add(below.length === 0, "The bot's role sits above the customer roles", `Drag the bot's role above ${below.map((r) => r.name).join(", ")} in Server Settings > Roles, or it cannot give them out.`);
    add(roles.length < ROLE_LIMIT - 10, `There is room for more customers (${roles.length} of ${ROLE_LIMIT} roles used)`, "Discord allows 250 roles in one server. Each customer uses one. Time for a second hub.");
    const channels = await hub.listChannels();
    add(channels.length < CHANNEL_LIMIT - 10, `There is room for more customers (${channels.length} of ${CHANNEL_LIMIT} channels used)`, "Discord allows 500 channels in one server. Each customer uses five. Time for a second hub.");
  } catch {
    add(false, "The server's roles and channels could be read", "Discord would not show them.");
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
