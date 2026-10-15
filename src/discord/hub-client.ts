// discord.js wiring for the hub bot: the same adapters as the demo (client.ts), plus the Server Members intent, which is
// how the bot hears that someone joined. Without it nobody could be given their role, so unlike Message Content this
// intent is required: if Discord refuses it the bot stops and says exactly what to switch on. Never logs the token.
import { Client, Events, GatewayIntentBits, REST, type GuildMember, type Interaction } from "discord.js";
import { botGuilds, buttonPort, commandPort, HUB_SLASH_COMMANDS, messagePort, redactor, registerCommands } from "./client.js";
import type { HubBot } from "./hub-bot.js";
import { hubInviteUrl } from "./hub-service.js";

export interface HubClientSettings { token: string; appId: string; guildId: string }
export interface StartedHubClient { client: Client; messageContent: boolean; stop: () => Promise<void> }

const DISALLOWED_INTENTS = /disallowed intents|4014/i;
const NO_PINGS = { parse: [] as never[] };

export async function startHubClient(bot: HubBot, s: HubClientSettings, log: (line: string) => void): Promise<StartedHubClient> {
  const redact = redactor(s.token);
  const say = (line: string) => log(redact(line));
  const err = (e: unknown) => redact(e instanceof Error ? e.message : String(e));
  const rest = new REST({ version: "10" }).setToken(s.token);

  let inGuild = false;
  try {
    inGuild = (await botGuilds(rest)).includes(s.guildId);
  } catch (e) {
    throw new Error(`Discord refused the bot token or could not be reached: ${err(e)}`);
  }
  if (!inGuild) throw new Error(`The bot is not in the hub server yet. The server owner can add it with: ${hubInviteUrl(s.appId)}`);
  await registerCommands(rest, { token: s.token, appId: s.appId, guildId: s.guildId, channelId: "" }, HUB_SLASH_COMMANDS)
    .then(() => say("Slash commands /ask, /brief, /approvals, /continue registered on the hub."), (e) => say(`Could not register slash commands: ${err(e)}`));

  const login = async (messageContent: boolean): Promise<Client> => {
    const client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers, ...(messageContent ? [GatewayIntentBits.MessageContent] : [])],
      allowedMentions: NO_PINGS,
    });
    client.once(Events.ClientReady, (c) => say(`Logged in as ${c.user.tag}${messageContent ? "" : " (without the Message Content intent: customers must @mention the bot or use /ask)"}.`));
    client.on(Events.MessageCreate, (m) => {
      if (!client.user || m.author.id === client.user.id) return;
      bot.onMessage(messagePort(m, client.user.id)).catch((e) => say(`message ${m.id}: ${err(e)}`));
    });
    client.on(Events.InteractionCreate, (i: Interaction) => {
      if (i.isChatInputCommand()) bot.onCommand(commandPort(i, i.channelId)).catch((e) => say(`/${i.commandName}: ${err(e)}`));
      else if (i.isButton()) bot.onButton(buttonPort(i)).catch((e) => say(`button: ${err(e)}`));
    });
    client.on(Events.GuildMemberAdd, (m: GuildMember) => {
      bot.onMemberJoin({ guildId: m.guild.id, userId: m.id, isBot: m.user.bot, addRole: async (roleId) => { await m.roles.add(roleId); } })
        .catch((e) => say(`join: ${err(e)}`));
    });
    client.on(Events.Error, (e) => say(`client error: ${err(e)}`));
    client.on(Events.Warn, (w) => say(`warning: ${redact(w)}`));
    try {
      await client.login(s.token);
    } catch (e) {
      await client.destroy().catch(() => undefined);
      throw e;
    }
    return client;
  };

  let messageContent = true;
  let client: Client;
  try {
    client = await login(true);
  } catch (e) {
    if (!DISALLOWED_INTENTS.test(err(e))) throw new Error(`Could not log in to Discord: ${err(e)}`);
    say("Discord refused one of the switches. Trying without Message Content (customers would have to @mention the bot).");
    messageContent = false;
    try {
      client = await login(false);
    } catch (e2) {
      if (DISALLOWED_INTENTS.test(err(e2))) throw new Error("Discord refused the Server Members switch. In the Developer Portal open the bot's page and turn on Server Members Intent: without it nobody gets their role when they join.");
      throw new Error(`Could not log in to Discord: ${err(e2)}`);
    }
  }
  return { client, messageContent, stop: async () => { await client.destroy(); } };
}
