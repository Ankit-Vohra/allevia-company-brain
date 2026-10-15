// discord.js 14 wiring for the Allevia bot: adapts Discord messages, slash commands and buttons to bot.ts's ports,
// registers the guild-scoped slash commands, and starts the client. Never logs the token: every line this file logs
// goes through redact(), and errors from discord.js are reduced to their message.
//
// Intents: Guilds, GuildMessages and MessageContent (privileged: switch on "Message Content Intent" for the bot in the
// Developer Portal). If Discord refuses MessageContent, the bot starts without it and says so: slash commands and
// messages that @mention the bot still work.
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client, Events, GatewayIntentBits, MessageFlags, MessageType,
  REST, Routes, SlashCommandBuilder, ThreadAutoArchiveDuration,
  type ButtonInteraction, type ChatInputCommandInteraction, type Interaction, type Message, type MessageCreateOptions,
  type MessageEditOptions, type SendableChannels, type ThreadChannel,
} from "discord.js";
import type { AlleviaBot, ButtonPort, ButtonSpec, CommandPort, MessagePort, Outgoing, PostedPort, ThreadPort } from "./bot.js";

export interface DiscordSettings { token: string; appId: string; guildId: string; channelId: string }

// Permissions the bot needs in the Allevia channel: view, send, send in threads, create public threads, read history,
// embed links. The invite link asks for exactly these.
const PERMISSIONS = (1024n + 2048n + 16384n + 65536n + 34359738368n + 274877906944n).toString();

export const inviteUrl = (appId: string): string =>
  `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(appId)}&scope=bot%20applications.commands&permissions=${PERMISSIONS}`;

export const SLASH_COMMANDS = [
  new SlashCommandBuilder().setName("ask").setDescription("Ask Allevia's team a question; the answer comes in a thread")
    .addStringOption((o) => o.setName("question").setDescription("What do you want to know?").setRequired(true).setMaxLength(1000)),
  new SlashCommandBuilder().setName("brief").setDescription("Today's note: the latest summary"),
  new SlashCommandBuilder().setName("approvals").setDescription("Proposals waiting for the owner's approval"),
].map((c) => c.toJSON());

export function redactor(token: string | undefined): (s: string) => string {
  return (s) => (token ? s.split(token).join("[token]") : s);
}

// ---------- outgoing messages ----------

const STYLE: Record<ButtonSpec["style"], ButtonStyle> = { success: ButtonStyle.Success, danger: ButtonStyle.Danger, secondary: ButtonStyle.Secondary };
const NO_PINGS = { parse: [] as never[] };

function components(buttons: ButtonSpec[] | undefined) {
  if (!buttons?.length) return [];
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    buttons.slice(0, 5).map((b) => new ButtonBuilder().setCustomId(b.customId).setLabel(b.label).setStyle(STYLE[b.style]))).toJSON()];
}

function payload(m: Outgoing): MessageCreateOptions & MessageEditOptions {
  if (typeof m === "string") return { content: m, allowedMentions: NO_PINGS };
  return { content: m.content, components: components(m.buttons), allowedMentions: NO_PINGS };
}

const posted = (msg: Message): PostedPort => ({ id: msg.id, edit: async (m) => { await msg.edit(payload(m)); } });

export function threadPort(t: ThreadChannel | SendableChannels & { id: string }): ThreadPort {
  return { id: t.id, send: async (m) => posted(await t.send(payload(m))) };
}

// ---------- incoming ----------

export function messagePort(m: Message, botUserId: string): MessagePort {
  const inThread = m.channel.isThread();
  const mention = new RegExp(`<@!?${botUserId}>`, "g");
  return {
    id: m.id,
    guildId: m.guildId,
    channelId: m.channelId,
    threadParentId: inThread ? (m.channel as ThreadChannel).parentId : null,
    authorId: m.author.id,
    authorIsBot: m.author.bot,
    authorIsOwner: !!m.guild && m.guild.ownerId === m.author.id,
    system: m.system || (m.type !== MessageType.Default && m.type !== MessageType.Reply),
    content: m.content.replace(mention, " ").trim(),
    thread: () => (inThread ? threadPort(m.channel as ThreadChannel) : null),
    startThread: async (name) => threadPort(await m.startThread({ name, autoArchiveDuration: ThreadAutoArchiveDuration.OneDay })),
    reply: async (out) => { await m.reply(payload(out)); },
  };
}

export function commandPort(i: ChatInputCommandInteraction, channelId: string): CommandPort {
  const ch = i.channel;
  const inThread = !!ch?.isThread();
  const answer = async (m: Outgoing, ephemeral: boolean) => {
    const p = payload(m);
    if (i.deferred || i.replied) await i.editReply({ content: p.content ?? null, components: p.components ?? [], allowedMentions: NO_PINGS });
    else await i.reply({ content: p.content ?? "", components: p.components ?? [], allowedMentions: NO_PINGS, ...(ephemeral ? { flags: MessageFlags.Ephemeral } : {}) });
  };
  return {
    command: i.commandName,
    ...(i.options.getString("question") ? { question: i.options.getString("question")! } : {}),
    guildId: i.guildId,
    channelId: i.channelId,
    threadParentId: inThread ? (ch as ThreadChannel).parentId : null,
    userId: i.user.id,
    isOwner: !!i.guild && i.guild.ownerId === i.user.id,
    defer: async () => { if (!i.deferred && !i.replied) await i.deferReply(); },
    respond: (m, opts) => answer(m, !!opts?.ephemeral),
    followUp: async (m, opts) => {
      const p = payload(m);
      const msg = await i.followUp({ content: p.content ?? "", components: p.components ?? [], allowedMentions: NO_PINGS, ...(opts?.ephemeral ? { flags: MessageFlags.Ephemeral } : {}) });
      return posted(msg);
    },
    thread: () => (inThread ? threadPort(ch as ThreadChannel) : null),
    createThread: async (name) => {
      const parent = await i.client.channels.fetch(channelId);
      if (!parent || parent.type !== ChannelType.GuildText) throw new Error("The Allevia channel is not a text channel I can open threads in.");
      return threadPort(await parent.threads.create({ name, autoArchiveDuration: ThreadAutoArchiveDuration.OneDay, type: ChannelType.PublicThread }));
    },
  };
}

export function buttonPort(i: ButtonInteraction): ButtonPort {
  return {
    customId: i.customId,
    guildId: i.guildId,
    userId: i.user.id,
    isOwner: !!i.guild && i.guild.ownerId === i.user.id,
    defer: async () => { if (!i.deferred && !i.replied) await i.deferUpdate(); },
    reply: async (text, opts) => {
      const p = { content: text, allowedMentions: NO_PINGS, ...(opts?.ephemeral ? { flags: MessageFlags.Ephemeral as const } : {}) };
      if (i.deferred || i.replied) await i.followUp(p);
      else await i.reply(p);
    },
    update: async (m) => {
      const p = payload(m);
      if (i.deferred || i.replied) await i.editReply({ content: p.content ?? null, components: p.components ?? [] });
      else await i.update({ content: p.content ?? null, components: p.components ?? [] });
    },
  };
}

// ---------- startup ----------

export interface StartedBot { client: Client; inGuild: boolean; messageContent: boolean; stop: () => Promise<void> }

// Is the bot in the demo server? GET /users/@me/guilds with the bot token.
export async function botGuilds(rest: REST): Promise<string[]> {
  const guilds = await rest.get(Routes.userGuilds()) as Array<{ id: string }>;
  return guilds.map((g) => g.id);
}

export async function registerCommands(rest: REST, s: DiscordSettings): Promise<void> {
  await rest.put(Routes.applicationGuildCommands(s.appId, s.guildId), { body: SLASH_COMMANDS });
}

const DISALLOWED_INTENTS = /disallowed intents|4014/i;

export async function startClient(bot: AlleviaBot, s: DiscordSettings, log: (line: string) => void): Promise<StartedBot> {
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
  if (inGuild) {
    await registerCommands(rest, s).then(() => say("Slash commands /ask, /brief, /approvals registered on the demo server."),
      (e) => say(`Could not register slash commands: ${err(e)}`));
  } else {
    say("The bot is not in the Allevia Demo server yet, so it will not post anything. The server owner can invite it with:");
    say(`  ${inviteUrl(s.appId)}`);
  }

  const login = async (messageContent: boolean): Promise<Client> => {
    const client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, ...(messageContent ? [GatewayIntentBits.MessageContent] : [])],
      allowedMentions: NO_PINGS,
    });
    client.once(Events.ClientReady, (c) => {
      say(`Logged in as ${c.user.tag}${messageContent ? "" : " (without the Message Content intent: @mention the bot or use /ask)"}.`);
      for (const [id, g] of c.guilds.cache) if (id !== s.guildId) say(`Ignoring server "${g.name}": Allevia only answers on its demo server.`);
    });
    client.on(Events.GuildCreate, (g) => {
      if (g.id !== s.guildId || inGuild) return;
      inGuild = true;
      say("Invited to the demo server.");
      void registerCommands(rest, s).then(() => say("Slash commands registered."), (e) => say(`Could not register slash commands: ${err(e)}`));
    });
    client.on(Events.MessageCreate, (m) => {
      if (!client.user || m.author.id === client.user.id) return;
      bot.onMessage(messagePort(m, client.user.id)).catch((e) => say(`message ${m.id}: ${err(e)}`));
    });
    client.on(Events.InteractionCreate, (i: Interaction) => {
      if (i.isChatInputCommand()) bot.onCommand(commandPort(i, s.channelId)).catch((e) => say(`/${i.commandName}: ${err(e)}`));
      else if (i.isButton()) bot.onButton(buttonPort(i)).catch((e) => say(`button: ${err(e)}`));
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
    say("Discord refused the Message Content intent. Turn it on in the Developer Portal (Bot > Privileged Gateway Intents) to answer every message; starting without it.");
    messageContent = false;
    client = await login(false);
  }
  return { client, inGuild, messageContent, stop: async () => { await client.destroy(); } };
}
