// The shared Allevia bot for the hub: one bot, every customer. It adds NOTHING to what the bot answers; it only decides
// WHICH business a Discord event belongs to, then hands the event to that business's own AlleviaBot (bot.ts), so asking,
// threads, the work log, /brief, /approvals and Approve / Reject behave exactly as in the demo.
//
// Tenant isolation (the rules this file exists to keep):
//   1. The business comes ONLY from a channel id looked up in the allevia_meta mapping (HubStore.channel), in the hub
//      server. A thread counts as its parent channel (Discord sets that, a person cannot). Message text, channel names,
//      category names, display names and button ids never choose a business.
//   2. A channel that is not in the mapping, any other server, and DMs are ignored (commands get a polite no).
//   3. The mapping must agree with the business's area record (the channel is that area's channel of that kind).
//   4. The person must hold that business's own role: only then is the question answered or the button obeyed. The
//      Allevia staff role alone never asks the team questions or decides a card for a customer.
//   5. Each business has its own graph and its own AlleviaBot; a card id from another business is simply not in this
//      business's graph.
//   #support is humans only: nothing in it is ever given to an agent; each message is copied to the staff-only
//   #support-inbox with the business name and a link.
import type { AlleviaBot, ButtonPort, CommandPort, MessagePort } from "./bot.js";
import { attributeJoin } from "./hub-join.js";
import type { AreaRecord, ChannelKind, HubPort, HubStore } from "./hub-types.js";

export interface JoinPort {
  guildId: string | null;
  userId: string;
  isBot: boolean;
  addRole(roleId: string): Promise<void>;
}

export interface HubBotDeps {
  guildId: string;
  staffRoleId: string;
  store: HubStore;
  hub: HubPort;
  /** The business's own bot (its graph, its ask deps). Called once per business; the result is kept. */
  botFor(area: AreaRecord): Promise<AlleviaBot> | AlleviaBot;
  now?: () => number;
  log?: (line: string) => void;
}

interface Resolved { kind: ChannelKind; area: AreaRecord; channelId: string }

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// A copy of a port that says the person is the business's owner-side member (they hold the business's role), so the
// business's bot treats them as it treats the owner in the demo. Methods keep working through the prototype.
const asMember = <T extends object>(port: T, extra: Record<string, unknown>): T =>
  Object.create(port, Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, { value: v, enumerable: true }]))) as T;

// What a person typed, made harmless to pass on: nobody gets pinged by it.
export const neutralize = (s: string): string => s.replace(/@(everyone|here)/gi, "@​$1").replace(/<@/g, "<@​");

export class HubBot {
  private bots = new Map<string, Promise<AlleviaBot>>();
  private joins: Promise<void> = Promise.resolve();

  constructor(private d: HubBotDeps) {}

  private log(line: string): void { (this.d.log ?? ((l: string) => console.error(l)))(`[hub] ${line}`); }

  private hasRole(roles: string[] | undefined, roleId: string | undefined): boolean {
    return !!roleId && roleId !== this.d.guildId && !!roles?.includes(roleId);
  }

  // The one place a channel becomes a business.
  async resolve(guildId: string | null, channelId: string, threadParentId: string | null | undefined): Promise<Resolved | null> {
    if (!guildId || guildId !== this.d.guildId) return null;
    const id = threadParentId ?? channelId;
    const ref = await this.d.store.channel(guildId, id);
    if (!ref || ref.guildId !== guildId) return null;
    const area = await this.d.store.getArea(ref.slug);
    if (!area || area.guildId !== guildId || area.channels[ref.kind] !== id || !area.roleId) return null;
    return { kind: ref.kind, area, channelId: id };
  }

  private bot(area: AreaRecord): Promise<AlleviaBot> {
    const key = `${area.slug}|${area.channels["your-team"]}`;
    let b = this.bots.get(key);
    if (!b) {
      b = Promise.resolve(this.d.botFor(area));
      b.catch(() => this.bots.delete(key));
      this.bots.set(key, b);
    }
    return b;
  }

  // ----- messages -----

  async onMessage(m: MessagePort): Promise<void> {
    if (m.authorIsBot || m.system || !m.guildId || m.guildId !== this.d.guildId) return;
    const r = await this.resolve(m.guildId, m.channelId, m.threadParentId);
    if (!r) return;
    if (r.kind === "support") return this.mirrorSupport(m, r);
    if (r.kind !== "your-team") return; // the other channels are read-only for people
    if (!this.hasRole(m.memberRoleIds, r.area.roleId)) return;
    await (await this.bot(r.area)).onMessage(asMember(m, { authorIsOwner: true }));
  }

  // #support: never answered by the team. Copied to the staff-only #support-inbox so a person at Allevia sees it.
  private async mirrorSupport(m: MessagePort, r: Resolved): Promise<void> {
    if (m.memberRoleIds?.includes(this.d.staffRoleId)) return; // staff answering: not copied back
    if (!this.hasRole(m.memberRoleIds, r.area.roleId)) return;
    const text = m.content.trim();
    const files = m.attachments ?? 0;
    if (!text && !files) return;
    const inbox = (await this.d.store.getHub(this.d.guildId))?.supportInboxId;
    if (!inbox) {
      this.log(`support message from ${r.area.slug} not copied: the hub has no #support-inbox yet (run discord-hub provision)`);
      return;
    }
    const link = `https://discord.com/channels/${this.d.guildId}/${m.channelId}/${m.id}`;
    const quoted = text ? clip(neutralize(text), 1500).split("\n").map((l) => `> ${l}`).join("\n") : "";
    const parts = [
      `**${neutralize(r.area.businessName)}** wrote in #support`,
      ...(quoted ? [quoted] : []),
      ...(files ? [`(${files} ${files === 1 ? "file" : "files"} attached)`] : []),
      `Open it: <${link}>`,
    ];
    await this.d.hub.sendMessage(inbox, parts.join("\n"));
  }

  // ----- slash commands -----

  async onCommand(c: CommandPort): Promise<void> {
    const r = await this.resolve(c.guildId, c.channelId, c.threadParentId);
    if (!r) return c.respond("I only work inside your team's own channels on the Allevia server.", { ephemeral: true });
    if (r.kind === "support") return c.respond(`That is a place for people. Ask your team in <#${r.area.channels["your-team"]}>.`, { ephemeral: true });
    if (!this.hasRole(c.memberRoleIds, r.area.roleId)) return c.respond(`Only people on ${r.area.businessName}'s team can use this.`, { ephemeral: true });
    await (await this.bot(r.area)).onCommand(asMember(c, { isOwner: true }));
  }

  // ----- buttons -----

  async onButton(b: ButtonPort): Promise<void> {
    if (!b.channelId) return b.reply("I can't tell which team space this is. Decide it in the web app.", { ephemeral: true });
    const r = await this.resolve(b.guildId, b.channelId, b.threadParentId);
    if (!r || r.kind === "support") return b.reply("This button does not belong to a team space I know.", { ephemeral: true });
    if (!this.hasRole(b.memberRoleIds, r.area.roleId)) return b.reply(`Only people on ${r.area.businessName}'s team can say OK or No here.`, { ephemeral: true });
    await (await this.bot(r.area)).onButton(asMember(b, { isOwner: true }));
  }

  // ----- joins -----

  // One at a time: two people joining together are told apart only if they are looked at one after the other.
  onMemberJoin(j: JoinPort): Promise<void> {
    const run = () => this.handleJoin(j);
    const next = this.joins.then(run, run);
    this.joins = next.catch(() => undefined);
    return next;
  }

  private async handleJoin(j: JoinPort): Promise<void> {
    if (j.isBot || !j.guildId || j.guildId !== this.d.guildId) return;
    const a = await attributeJoin({ hub: this.d.hub, store: this.d.store, staffRoleId: this.d.staffRoleId, ...(this.d.now ? { now: this.d.now } : {}) });
    if (a.kind === "none") {
      this.log("someone joined without a valid join link: no access given");
      return;
    }
    if (a.kind === "ambiguous") {
      this.log(`two join links were used at once (${a.slugs.join(", ")}): no access given`);
      await this.tellStaff(`Two people joined at about the same time, using links for: ${a.slugs.join(", ")}. I cannot tell whose is whose, so <@${j.userId}> has no access yet. Give them the right customer role by hand, or send a new link with \`discord-hub reinvite <business>\`.`);
      return;
    }
    try {
      await j.addRole(a.roleId);
      this.log(`${a.slug}: a new member joined with their link and got the customer role`);
    } catch (e) {
      this.log(`${a.slug}: could not give the customer role: ${message(e)}`);
      await this.tellStaff(`<@${j.userId}> joined with ${a.slug}'s link but I could not give them the customer role (${clip(message(e), 150)}). Check the bot's role sits above the customer roles, then give it by hand.`);
    }
  }

  private async tellStaff(text: string): Promise<void> {
    try {
      const inbox = (await this.d.store.getHub(this.d.guildId))?.supportInboxId;
      if (inbox) await this.d.hub.sendMessage(inbox, text);
    } catch (e) {
      this.log(`could not tell staff: ${message(e)}`);
    }
  }
}
