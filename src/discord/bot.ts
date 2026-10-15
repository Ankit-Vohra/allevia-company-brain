// The Allevia Discord bot (spec §7.3, §10, §16.3), as plain logic over small "ports" (a message, a thread, a slash
// command, a button), so it is tested with a fake Discord and no network. src/discord/client.ts adapts discord.js to
// these ports and starts the bot.
//
// - Scope: the demo server (guildId) only, and only its Allevia channel (channelId) and threads under that channel.
//   Everything else is ignored; a slash command from elsewhere gets a polite ephemeral no.
// - Threads: a new message in the channel opens a public thread named after the question and is answered there.
//   Replies in the thread continue the same session (sessions.ts stores the thread id on the Session). Turns in one
//   thread run one after another; at most `maxLive` turns run at once across threads.
// - Work log: one message per turn, edited at most every ~1.5 s (ThrottledEditor): who is active and on which step.
// - Answer: [[id]] citations as short labels, the checks as badges, the web path view link; split under 2,000 chars.
// - /ask, /brief, /approvals. Approval cards carry Approve and Reject buttons; only the server owner may press them,
//   and a press makes the same decision as the API (decideAndNotify, with the same onDecision hook).
// - Who asks: the server owner asks as person:founder; anyone else as a generic person:discord-member, so no Discord
//   name or id is written into the graph.
import type { AgentEvent, TurnChecks } from "../../shared/contracts.js";
import { agentById } from "../../shared/roster.js";
import type { AskInput, AskResult } from "../agent/ask.js";
import type { GraphHandle } from "../graph/client.js";
import { DecisionError, decideAndNotify, type ActionOpts, type OnDecision } from "../server/approvals.js";
import { approvals as listApprovals, latestBrief } from "../server/reads.js";
import type { ApprovalDto } from "../server/types.js";
import { pathViewUrl, renderAnswer, renderCitations, splitMessage, threadName } from "./format.js";
import { findThreadSession, openThreadSession } from "./sessions.js";
import { ThrottledEditor, WorkLogState } from "./worklog.js";

// ---------- ports ----------

export interface ButtonSpec { customId: string; label: string; style: "success" | "danger" | "secondary" }
export type Outgoing = string | { content: string; buttons?: ButtonSpec[] };

export interface PostedPort { id: string; edit(m: Outgoing): Promise<void> }
export interface ThreadPort { id: string; send(m: Outgoing): Promise<PostedPort> }

export interface MessagePort {
  id: string;
  guildId: string | null;
  channelId: string;              // where it was posted (a thread's own id when posted in a thread)
  threadParentId: string | null;  // the thread's parent channel, when posted in a thread
  authorId: string;
  authorIsBot: boolean;
  authorIsOwner: boolean;         // the server owner
  system: boolean;                // a system message (thread created, pins, joins…)
  content: string;                // the bot's own mention removed
  thread(): ThreadPort | null;    // the thread it was posted in
  startThread(name: string): Promise<ThreadPort>;
  reply(m: Outgoing): Promise<void>;
}

export interface CommandPort {
  command: string;
  question?: string;
  guildId: string | null;
  channelId: string;
  threadParentId: string | null;
  userId: string;
  isOwner: boolean;
  defer(): Promise<void>;
  respond(m: Outgoing, opts?: { ephemeral?: boolean }): Promise<void>;
  followUp(m: Outgoing, opts?: { ephemeral?: boolean }): Promise<PostedPort>;
  thread(): ThreadPort | null;                  // the thread the command was used in, if any
  createThread(name: string): Promise<ThreadPort>; // a new public thread in the Allevia channel
}

export interface ButtonPort {
  customId: string;
  guildId: string | null;
  userId: string;
  isOwner: boolean;
  defer?(): Promise<void>;                      // acknowledge before slow work (the card is edited later)
  reply(text: string, opts?: { ephemeral?: boolean }): Promise<void>;
  update(m: Outgoing): Promise<void>;           // edit the card the button is on
}

export interface BotDeps {
  tenant: string;
  guildId: string;
  channelId: string;
  webBase: string;                              // the web app, for path-view links (config webBaseUrl)
  graph: GraphHandle;
  ask: (input: AskInput, emit: (e: AgentEvent) => void) => Promise<AskResult>;
  onDecision?: OnDecision;                      // the API's hook (ServerDeps.onDecision), run after each decision
  actions?: ActionOpts;                         // the API's executor settings (ServerDeps.actions): same actions either way
  now?: () => number;
  workLogIntervalMs?: number;                   // default 1,500
  maxLive?: number;                             // turns at once across threads (default 2)
  log?: (line: string) => void;
}

// ---------- constants ----------

export const FOUNDER = "person:founder";
export const MEMBER = "person:discord-member";
const BUTTON_PREFIX = "allevia";
const MAX_CARDS = 10;
const NOT_HERE = "Allevia only works on its demo server.";
const ALL_OK: TurnChecks = { citationsValid: true, invalidCitations: [], numbersGrounded: true, ungroundedNumbers: [], simulatedDisclosed: true, freshnessDisclosed: true };
const KIND_LABEL: Record<ApprovalDto["kind"], string> = {
  github_issue: "GitHub issue", content_draft: "content draft", pause_ad: "pause an ad", discord_post: "Discord post",
};

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const quote = (s: string): string => s.split("\n").map((l) => `> ${l}`).join("\n");

export const buttonId = (decision: "approve" | "reject", approvalId: string): string => `${BUTTON_PREFIX}:${decision}:${approvalId}`;
const BUTTON = new RegExp(`^${BUTTON_PREFIX}:(approve|reject):(.+)$`);

export function approvalCard(a: ApprovalDto, opts: { buttons?: boolean } = {}): { content: string; buttons: ButtonSpec[] } {
  const who = agentById(a.by)?.name ?? a.by;
  const lines = [
    `**${clip(a.title, 200)}** · ${KIND_LABEL[a.kind] ?? a.kind}${a.simulated ? " (simulated)" : ""}`,
    `Proposed by ${who} · ${a.createdAt.slice(0, 10)}`,
    ...(a.payload.body.trim() ? [quote(clip(a.payload.body.trim(), 900))] : []),
    ...(a.payload.target ? [`Target: ${clip(a.payload.target, 200)}`] : []),
    `\`${a.id}\``,
  ];
  const ids = [buttonId("approve", a.id), buttonId("reject", a.id)];
  const fits = ids.every((id) => id.length <= 100); // Discord's custom_id limit
  const buttons: ButtonSpec[] = opts.buttons === false || !fits ? [] : [
    { customId: ids[0]!, label: "Approve", style: "success" },
    { customId: ids[1]!, label: "Reject", style: "danger" },
  ];
  if (opts.buttons !== false && !fits) lines.push("_Decide this one in the web app._");
  return { content: clip(lines.join("\n"), 1900), buttons };
}

// ---------- the bot ----------

export class AlleviaBot {
  private live = 0;
  private queues = new Map<string, Promise<void>>();
  private sessions = new Map<string, string>();

  constructor(private d: BotDeps) {}

  private now(): number { return this.d.now?.() ?? Date.now(); }
  private log(line: string): void { (this.d.log ?? ((l: string) => console.error(l)))(`[discord] ${line}`); }

  // ----- messages -----

  async onMessage(m: MessagePort): Promise<void> {
    if (m.authorIsBot || m.system || m.guildId !== this.d.guildId) return;
    const question = m.content.trim();
    if (!question) return;
    const asker = m.authorIsOwner ? FOUNDER : MEMBER;
    if (m.channelId === this.d.channelId) {
      const thread = await m.startThread(threadName(question));
      await this.turn(thread, question, asker, () => this.openSession(thread.id, question, asker));
    } else if (m.threadParentId === this.d.channelId) {
      const thread = m.thread();
      if (!thread) return;
      await this.turn(thread, question, asker, () => this.sessionFor(thread.id, question, asker));
    }
  }

  // ----- slash commands -----

  async onCommand(c: CommandPort): Promise<void> {
    if (c.guildId !== this.d.guildId) return c.respond(NOT_HERE, { ephemeral: true });
    switch (c.command) {
      case "ask": return this.askCommand(c);
      case "brief": return this.briefCommand(c);
      case "approvals": return this.approvalsCommand(c);
      default: return c.respond("I don't know that command.", { ephemeral: true });
    }
  }

  private async askCommand(c: CommandPort): Promise<void> {
    const question = (c.question ?? "").trim();
    if (!question) return c.respond("Ask a question, e.g. `/ask question: What breaks if the Instagram token expires?`", { ephemeral: true });
    const asker = c.isOwner ? FOUNDER : MEMBER;
    if (c.threadParentId === this.d.channelId) {
      const thread = c.thread();
      if (!thread) return c.respond("I can't see this thread.", { ephemeral: true });
      await c.respond(quote(clip(question, 1900)));
      return this.turn(thread, question, asker, () => this.sessionFor(thread.id, question, asker));
    }
    if (c.channelId !== this.d.channelId) return c.respond(`Ask me in <#${this.d.channelId}>.`, { ephemeral: true });
    await c.defer();
    const thread = await c.createThread(threadName(question));
    const sessionId = await this.openSession(thread.id, question, asker);
    await c.respond(`Answering in <#${thread.id}>.`);
    await thread.send(`**Question:** ${clip(question, 1900)}`);
    return this.turn(thread, question, asker, async () => sessionId);
  }

  private async briefCommand(c: CommandPort): Promise<void> {
    await c.defer();
    const b = await latestBrief(this.d.graph);
    if (!b) return c.respond("No note yet. Once today's note has been written, `/brief` shows the latest one here.");
    const [first, ...rest] = splitMessage(`**${b.title}**${b.asOf ? ` · as of ${b.asOf}` : ""}\n\n${renderCitations(b.text, new Map())}`);
    await c.respond(first ?? b.title);
    for (const p of rest) await c.followUp(p);
  }

  private async approvalsCommand(c: CommandPort): Promise<void> {
    await c.defer();
    const pending = (await listApprovals(this.d.graph)).filter((a) => a.status === "pending");
    if (!pending.length) return c.respond("Nothing is waiting for your approval.");
    const shown = pending.slice(0, MAX_CARDS);
    await c.respond(`${pending.length} pending approval${pending.length === 1 ? "" : "s"}${pending.length > shown.length ? ` (the newest ${shown.length} below)` : ""}. Only the server owner can approve or reject.`);
    for (const a of shown) await c.followUp(approvalCard(a));
  }

  // ----- buttons -----

  async onButton(b: ButtonPort): Promise<void> {
    const m = BUTTON.exec(b.customId);
    if (!m) return;
    if (b.guildId !== this.d.guildId) return b.reply(NOT_HERE, { ephemeral: true });
    if (!b.isOwner) return b.reply("Only the server owner can approve or reject Allevia's proposals.", { ephemeral: true });
    const decision = m[1] as "approve" | "reject";
    const id = m[2]!;
    try {
      await b.defer?.();
      const after = await decideAndNotify(this.d.graph, this.d.tenant, id, { decision }, {
        now: this.now(), log: (l) => this.log(l), ...(this.d.onDecision ? { onDecision: this.d.onDecision } : {}), ...(this.d.actions ? { actions: this.d.actions } : {}),
      });
      const verdict = after.status === "rejected" ? "❌ Rejected by the owner" : `✅ Approved by the owner${after.status === "edited" ? " (edited)" : ""}`;
      await b.update({ content: `${approvalCard(after, { buttons: false }).content}\n${verdict}${after.result ? ` · ${clip(after.result, 200)}` : ""}`, buttons: [] });
    } catch (e) {
      if (e instanceof DecisionError && e.status === 409) return b.reply(`This one was already decided: ${e.message}`, { ephemeral: true });
      if (e instanceof DecisionError && e.status === 404) return b.reply("That approval no longer exists.", { ephemeral: true });
      this.log(`decision on ${id} failed: ${message(e)}`);
      return b.reply("I couldn't record that decision. Try again, or decide it in the web app.", { ephemeral: true });
    }
  }

  // ----- sessions -----

  private async openSession(threadId: string, title: string, asker: string): Promise<string> {
    const id = await openThreadSession(this.d.graph, { threadId, title, asker, now: this.now() });
    this.sessions.set(threadId, id);
    return id;
  }

  // The thread's session; a thread under the channel that has none yet (one a person opened) starts its own.
  private async sessionFor(threadId: string, question: string, asker: string): Promise<string> {
    const known = this.sessions.get(threadId) ?? await findThreadSession(this.d.graph, threadId);
    if (known) {
      this.sessions.set(threadId, known);
      return known;
    }
    return this.openSession(threadId, question, asker);
  }

  // ----- one turn -----

  // Turns in one thread run in order; the session is resolved inside the queue, so two quick replies agree on it.
  private turn(thread: ThreadPort, question: string, asker: string, session: () => Promise<string>): Promise<void> {
    const run = async () => this.runTurn(thread, question, asker, await session());
    const prev = this.queues.get(thread.id) ?? Promise.resolve();
    const next = prev.then(run, run);
    const settled = next.catch(() => undefined);
    this.queues.set(thread.id, settled);
    void settled.then(() => { if (this.queues.get(thread.id) === settled) this.queues.delete(thread.id); });
    return next;
  }

  private async runTurn(thread: ThreadPort, question: string, asker: string, sessionId: string): Promise<void> {
    if (this.live >= (this.d.maxLive ?? 2)) {
      await thread.send("The team is already working on other questions. Ask again in a minute.");
      return;
    }
    this.live++;
    const t0 = Date.now();
    try {
      const state = new WorkLogState();
      const logMsg = await thread.send(state.render());
      const editor = new ThrottledEditor((text) => logMsg.edit(text), this.d.workLogIntervalMs ?? 1500, undefined,
        (e) => this.log(`work log edit failed: ${message(e)}`));
      const names = new Map<string, string>();
      let lastError: string | undefined;
      const emit = (e: AgentEvent) => {
        state.apply(e);
        collectNames(e, names);
        if (e.type === "error") lastError = e.message;
        editor.update(state.render());
      };
      let result: AskResult | undefined;
      try {
        result = await this.d.ask({ tenant: this.d.tenant, question, sessionId, asker, channel: "discord" }, emit);
      } catch (e) {
        lastError = message(e);
      }
      await editor.flush();
      await this.nameMissing(result?.citations ?? [], names);
      const parts = renderAnswer({
        answer: result?.answer ?? "", checks: result?.checks ?? ALL_OK, names,
        url: pathViewUrl(this.d.webBase, this.d.tenant, sessionId), ...(lastError ? { error: lastError } : {}),
      });
      for (const p of parts) await thread.send(p);
      this.log(`thread ${thread.id}: ${result?.ok ? "answered" : "failed"} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } finally {
      this.live--;
    }
  }

  // Labels for citations no tool result named (best-effort: an unknown id keeps its slug as the label).
  private async nameMissing(ids: string[], names: Map<string, string>): Promise<void> {
    const missing = [...new Set(ids)].filter((id) => !names.has(id)).slice(0, 50);
    if (!missing.length) return;
    try {
      const rows = await this.d.graph.roQuery<{ id: string; name: string | null }>(
        "UNWIND $ids AS id MATCH (n:Entity {id:id}) RETURN n.id AS id, coalesce(n.name, n.title) AS name", { ids: missing });
      for (const r of rows) if (r.name) names.set(r.id, r.name);
    } catch { /* labels fall back to the id's slug */ }
  }
}

// Every node and source name the turn's tools and path returned, for citation labels.
function collectNames(e: AgentEvent, names: Map<string, string>): void {
  if (e.type === "tool_result") {
    for (const n of e.nodes) if (n.name) names.set(n.id, n.name);
    for (const s of e.sources) if (s.title) names.set(s.id, s.title);
  } else if (e.type === "path") {
    for (const n of e.nodes) if (n.name) names.set(n.id, n.name);
  }
}
