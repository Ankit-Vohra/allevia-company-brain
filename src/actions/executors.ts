// Executors (spec §9): what happens when the owner approves a card. Each writes one Action {kind, status, result, at},
// Approval -RESULTED_IN-> Action, Action -AFFECTS-> its target, and Action -RESULTED_IN-> whatever it made.
//   github_issue   where the business's action target says (target.ts). By default a Task {kind:'fix'} inside the app, with no
//                  outside system touched. A business that opted in gets `gh issue create` on ITS OWN repo with the label
//                  allevia-action (created if missing); never on ALLEVIA_ACTION_REPO (config.githubActionRepo), which is
//                  Allevia's own tracker and is only used to refuse that.
//   content_draft  a Content {status:'draft', format} PRODUCED by the agent, its markdown under
//                  <dataDir>/drafts/<tenant>/ (gitignored), USES_RULE for every learned or brand rule applied. Never
//                  publishes anything.
//   pause_ad       simulated: the simulated Campaign's status becomes paused (TRACKED, so a Version keeps "active").
//                  A real campaign is never touched: the action is skipped and says so.
//   discord_post   posts to config.discord.channelId; skipped when there is no token.
//   publish_post   posts to the owner's own Instagram, Facebook Page or LinkedIn through their Composio connection (src/publish):
//                  only the exact content the owner approved, now or at the time chosen, a dry run until ALLEVIA_ACTIONS_LIVE=1.
// With dryRun, github_issue and discord_post touch nothing outside the graph: the Action records status 'dry_run' and
// what would have been created. The API and Discord decide cards with dryRun on unless ALLEVIA_ACTIONS_LIVE=1.
// The outside world (gh, HTTP, the drafting model) is injected. Tests must inject gh and HTTP: the defaults refuse to
// run under vitest, so a test can never open a real issue or post a real message.
// Exactly once: the Action id is derived from the Approval id, and an Action already on record is returned as it is.
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { ActionKind } from "../../shared/contracts.js";
import { agentById } from "../../shared/roster.js";
import { loadConfig, type AlleviaConfig } from "../config.js";
import type { GraphHandle } from "../graph/client.js";
import { assertTenantSlug } from "../graph/slug.js";
import { TENANT_CONFIGS } from "../tenant-config.js";
import { upsertEdge, upsertNode } from "../graph/upsert.js";
import { entityId, slugify } from "../util/ids.js";
import { isoDate } from "../util/time.js";
import { clip, oneLine } from "../insights/text.js";
import { activeRules, applyRules, DETERMINISTIC_OPS, markRulesApplied, type ActiveRule } from "./learning.js";
import { ensureAgentNode, existingIds, findBusinessId, type Payload } from "./shared.js";
import { getActionTarget } from "./target.js";
import { RateLimitedError, type ConnectionsPort } from "../connections/service.js";
import { NeedsAttentionError, NotAllowedError, NotConfiguredError, NotConnectedError } from "../connections/types.js";
import type { GoogleSession } from "../connections/google/product.js";
import { GoogleApiError } from "../connectors/google/client.js";
import { recordSalesOutcome } from "../sales/after.js";
import { publishPostAction, type PublishRuntime } from "../publish/executor.js";

export type GhRunner = (args: string[]) => Promise<string>;
export interface HttpResponse { ok: boolean; status: number; text(): Promise<string> }
export type HttpFn = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<HttpResponse>;
export interface DraftInput { title: string; body: string; format: string; channel?: string; agent: string; instructions: string[] }
export type Drafter = (input: DraftInput) => Promise<string>;

export interface ExecutorDeps {
  tenant: string;
  config?: Partial<Pick<AlleviaConfig, "githubActionRepo" | "discord" | "dataDir">>;
  gh?: GhRunner;
  http?: HttpFn;
  drafter?: Drafter;
  connections?: ConnectionsPort; // this business's connections (calendar_event, email_send, publish_post); absent: the server's own, built on first use
  publish?: PublishRuntime;   // publish_post: how a picture is made reachable and the daily limit; absent: from the server's config
  dryRun?: boolean;           // github_issue and discord_post record what they would do, and do nothing
}

export interface ExecInput {
  approvalId: string;
  kind: ActionKind;
  payload: Payload;           // what was approved: the edited payload when the owner edited it
  agent?: string;             // roster id of the agent that proposed it
  recommendationId?: string;
  now: number;
}

export type ActionStatus = "done" | "failed" | "skipped" | "dry_run";
export interface ActionView {
  id: string; kind: ActionKind; status: ActionStatus; result: string; at: number; url?: string; simulated?: boolean;
  affects: string[]; produced: string[]; rulesApplied?: string[];
}

interface Outcome { status: ActionStatus; result: string; url?: string; simulated?: boolean; produced: string[]; affects?: string[]; rulesApplied?: string[] }

export const ISSUE_LABEL = "allevia-action";
const inTests = () => !!process.env.VITEST;

export const defaultGh: GhRunner = (args) => {
  if (inTests()) return Promise.reject(new Error("tests must inject gh: refusing to run the real gh CLI"));
  return new Promise((resolve, reject) => {
    execFile("gh", args, { timeout: 60_000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) reject(new Error(oneLine(`${err.message} ${stderr ?? ""}`)));
      else resolve(String(stdout));
    });
  });
};

export const defaultHttp: HttpFn = async (url, init) => {
  if (inTests()) throw new Error("tests must inject http: refusing to call the network");
  return fetch(url, init);
};

export const actionIdFor = (approvalId: string): string => `action:${approvalId.replace(/^approval:/, "")}`;

// The GitHub repo and the Discord channel in the env file are the founder's: they belong to the founder's own businesses
// (tenant-config.ts) and to any business named in ALLEVIA_ACTION_TENANTS. A business a customer onboarded has no connector
// of its own yet, so its approved cards do not use them: a fix lands in its own tasks (target.ts), a post is skipped (a
// connector passed in deps.config is used as given). Otherwise a customer's approved card would be filed on, or posted
// into, an account that is not theirs.
export function usesFoundersAccounts(tenant: string): boolean {
  return Object.hasOwn(TENANT_CONFIGS, tenant) || loadConfig().actionTenants.includes(tenant);
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const agentName = (rosterId: string | undefined) => (rosterId ? agentById(rosterId)?.name ?? rosterId : "Allevia");

async function firstEvidence(g: GraphHandle, recId: string | undefined): Promise<string | undefined> {
  if (!recId) return undefined;
  const [r] = await g.roQuery<{ id: string }>(
    "MATCH (:Entity:Recommendation {id:$id})-[e:EVIDENCED_BY]->(x:Entity) WHERE e.until IS NULL RETURN x.id AS id ORDER BY e.since, id LIMIT 1", { id: recId });
  return r?.id;
}

// ---------- github_issue ----------

// The default target: the approved fix becomes an open Task in the business's own graph (the app lists it; Discord already
// showed the card). Safe in a dry run too: it touches nothing outside the graph.
async function appTask(g: GraphHandle, input: ExecInput, reason?: string): Promise<Outcome> {
  const p = input.payload;
  const taskId = entityId("Task", `fix ${input.approvalId.replace(/^approval:/, "")}`);
  await upsertNode(g, {
    type: "Task", id: taskId, name: clip(p.title, 160),
    summary: clip(oneLine(p.body), 300),
    props: { kind: "fix", status: "open", origin: "allevia", approval: input.approvalId, body: clip(p.body, 4000), ...(input.agent ? { by: input.agent } : {}) },
  }, input.now);
  return {
    status: "done", produced: [taskId],
    result: `Added to your tasks: “${clip(p.title, 160)}”. ${reason ? `${reason} ` : ""}Nothing was sent to GitHub or anywhere outside Allevia.`,
  };
}

async function githubIssue(g: GraphHandle, input: ExecInput, deps: ExecutorDeps): Promise<Outcome> {
  // Where this business's approved fix goes (target.ts): its own choice, else the founder's tracker for the founder's own
  // businesses, else a task in the app. A connector passed in deps.config is used as given, except Allevia's own repo for a
  // business that is not the founder's.
  const target = await getActionTarget(g, deps.tenant, {
    serverRepo: loadConfig().githubActionRepo, founders: usesFoundersAccounts(deps.tenant), ...(deps.config?.githubActionRepo ? { connectorRepo: deps.config.githubActionRepo } : {}),
  });
  if (target.kind === "app") return appTask(g, input, target.reason);
  const repo = target.repo;
  const gh = deps.gh ?? defaultGh;
  const p = input.payload;
  const body = `${p.body}\n\n---\nProposed by Allevia (${agentName(input.agent)}) and approved by the owner. Approval: ${input.approvalId}.`;
  const create = ["issue", "create", "--repo", repo, "--title", clip(p.title, 240), "--body", body, "--label", ISSUE_LABEL];
  if (deps.dryRun) {
    return {
      status: "dry_run", produced: [],
      result: `Dry run: would open a GitHub issue on ${repo} titled "${clip(p.title, 160)}" with the label ${ISSUE_LABEL}. Nothing was created; ALLEVIA_ACTIONS_LIVE=1 creates it.`,
    };
  }
  let out: string;
  try {
    out = await gh(create);
  } catch (e) {
    if (!/label/i.test((e as Error).message)) throw e;
    await gh(["label", "create", ISSUE_LABEL, "--repo", repo, "--color", "C8A23D", "--description", "Proposed by Allevia, approved by the owner", "--force"]);
    out = await gh(create);
  }
  const url = out.split(/\s+/).find((s) => /^https:\/\/github\.com\/\S+\/issues\/\d+/.test(s));
  if (!url) return { status: "failed", result: `gh did not return an issue URL: ${clip(oneLine(out), 200)}`, produced: [] };
  const num = /\/issues\/(\d+)/.exec(url)![1]!;
  const taskId = entityId("Task", `issue ${repo} ${num}`);
  await upsertNode(g, { type: "Task", id: taskId, name: clip(p.title, 160), props: { kind: "issue", status: "open", ref: url, repo, number: Number(num) } }, input.now);
  return { status: "done", result: url, url, produced: [taskId] };
}

// ---------- content_draft ----------

function markdown(d: { title: string; body: string; format: string; channel?: string; agent: string; approvalId: string; date: string; applied: ActiveRule[]; instructions: ActiveRule[] }): string {
  const head = [`# ${d.title}`, "", `Format: ${d.format}${d.channel ? ` · Channel: ${d.channel}` : ""} · Drafted by ${d.agent} · ${d.date} · ${d.approvalId}`, "", "Status: draft. Nothing has been published.", ""];
  const rules = [
    ...(d.applied.length ? ["", "## Rules applied", ...d.applied.map((r) => `- ${r.text} (${r.id})`)] : []),
    ...(d.instructions.length ? ["", "## Rules to follow when finishing this draft", ...d.instructions.map((r) => `- ${r.text} (${r.id})`)] : []),
  ];
  return [...head, d.body.trim(), ...rules, ""].join("\n");
}

async function contentDraft(g: GraphHandle, input: ExecInput, deps: ExecutorDeps): Promise<Outcome> {
  const p = input.payload;
  // A card with nothing to post is not a draft (content trial 2026-10-15: a plan with "script: not yet written" and no body
  // was approved into an empty file and counted as a first-pass approval). Fail closed and say why.
  if (!(typeof p.body === "string" && p.body.trim())) {
    return { status: "failed", result: "Nothing was saved: the card has no text to post (payload.body is empty). Ask the team to write the full text and propose it again.", produced: [] };
  }
  const agent = input.agent ?? "content-strategist";
  const agentId = await ensureAgentNode(g, agent, input.now);
  const format = str(p.format) ?? "post";
  const channelId = str(p.channelId) && (await existingIds(g, [str(p.channelId)!])).has(str(p.channelId)!) ? str(p.channelId) : undefined;
  const [ch] = channelId ? await g.roQuery<{ name: string }>("MATCH (c:Entity:Channel {id:$id}) RETURN c.name AS name", { id: channelId }) : [];
  const biz = await findBusinessId(g, deps.tenant);
  const rules = await activeRules(g, { agentId, channelId, businessId: biz });
  const first = applyRules({ title: p.title, body: p.body }, rules);
  let { title, body } = first;
  if (deps.drafter) {
    const drafted = await deps.drafter({ title, body, format, channel: ch?.name, agent, instructions: first.instructions.map((r) => r.text) });
    // A model can ignore an instruction; the deterministic rules are re-applied to what it wrote.
    const again = applyRules({ title, body: drafted }, rules.filter((r) => DETERMINISTIC_OPS.has(r.op)));
    body = again.body;
    for (const r of again.applied) if (!first.applied.some((x) => x.id === r.id)) first.applied.push(r);
  }
  // Rules already applied when the card was written count as applied to this draft too.
  const preApplied = Array.isArray(p.rulesApplied) ? p.rulesApplied.filter((x): x is string => typeof x === "string") : [];
  for (const r of rules) if (preApplied.includes(r.id) && !first.applied.some((x) => x.id === r.id)) first.applied.push(r);
  const suffix = input.approvalId.replace(/^approval:/, "");
  const contentId = entityId("Content", `draft ${suffix}`);
  const dataDir = deps.config?.dataDir ?? loadConfig().dataDir;
  const file = join(dataDir, "drafts", slugify(assertTenantSlug(deps.tenant)), `${slugify(suffix) || "draft"}.md`);
  const date = isoDate(input.now);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, markdown({ title, body, format, channel: ch?.name, agent: agentName(agent), approvalId: input.approvalId, date, applied: first.applied, instructions: first.instructions }), "utf8");
  const draftPath = relative(dataDir, file);
  await upsertNode(g, {
    type: "Content", id: contentId, name: clip(title, 160), summary: clip(oneLine(body), 300),
    props: { status: "draft", format, title, caption: clip(body, 2000), draftPath, approval: input.approvalId, ...(channelId ? { channel: channelId } : {}) },
  }, input.now);
  await upsertEdge(g, { from: agentId, type: "PRODUCED", to: contentId }, input.now);
  // Every rule that shaped it: pre-applied when the card was written, applied now, or passed on as an instruction;
  // plus the hook formula it was briefed on.
  const used = [...new Set([...preApplied, ...first.applied.map((r) => r.id), ...first.instructions.map((r) => r.id), ...(str(p.hookRuleId) ? [str(p.hookRuleId)!] : [])])];
  const rulesApplied = await markRulesApplied(g, contentId, used, input.now);
  if (input.recommendationId) {
    const goals = await g.roQuery<{ id: string }>(
      "MATCH (:Entity:Recommendation {id:$id})-[a:ADVANCES]->(gl:Goal) WHERE a.until IS NULL RETURN gl.id AS id", { id: input.recommendationId });
    for (const gl of goals) await upsertEdge(g, { from: contentId, type: "ADVANCES", to: gl.id }, input.now);
  }
  const learned = rulesApplied.filter((id) => rules.some((r) => r.id === id && r.kind === "learned") || preApplied.includes(id));
  return {
    status: "done", produced: [contentId], rulesApplied, affects: channelId ? [channelId] : undefined,
    result: `Draft saved to ${draftPath}${learned.length ? `; applied ${learned.length} learned rule${learned.length === 1 ? "" : "s"}` : ""}. Not published.`,
  };
}

// ---------- pause_ad (simulated) ----------

async function pauseAd(g: GraphHandle, input: ExecInput): Promise<Outcome> {
  const id = str(input.payload.campaignId) ?? str(input.payload.targetId);
  if (!id) return { status: "failed", result: "No campaign id in the payload.", produced: [] };
  const [c] = await g.roQuery<{ name: string; status: string | null; simulated: boolean | null }>(
    "MATCH (c:Entity:Campaign {id:$id}) RETURN c.name AS name, c.status AS status, c.simulated AS simulated", { id });
  if (!c) return { status: "failed", result: `Campaign ${id} is not in the graph.`, produced: [] };
  if (c.simulated !== true) {
    return { status: "skipped", result: `"${c.name}" is a real campaign and no ad account is connected; pause it in the ads manager.`, produced: [], affects: [id] };
  }
  if (c.status !== "paused") await upsertNode(g, { type: "Campaign", id, name: c.name, props: { status: "paused", pausedAt: input.now, pausedBy: input.approvalId } }, input.now);
  return {
    status: "done", simulated: true, produced: [id], affects: [id],
    result: `Simulated: "${c.name}" paused in Allevia's simulated ads (was ${c.status ?? "active"}). No real ad account was touched.`,
  };
}

// ---------- discord_post ----------

async function discordPost(input: ExecInput, deps: ExecutorDeps): Promise<Outcome> {
  const discord = deps.config?.discord ?? (usesFoundersAccounts(deps.tenant) ? loadConfig().discord : {});
  // The channel is the connector's own. A card (or its edit) cannot name another channel for the bot to post in.
  const channel = discord.channelId;
  if (!discord.token && !channel && !usesFoundersAccounts(deps.tenant) && !deps.config?.discord) {
    return { status: "skipped", result: "No Discord channel is connected for this business, so nothing was posted.", produced: [] };
  }
  if (deps.dryRun) {
    return {
      status: "dry_run", produced: [],
      result: `Dry run: would post "${clip(input.payload.title, 160)}" to ${channel ? "the Allevia Discord channel" : "Discord (no channel is configured)"}. Nothing was posted; ALLEVIA_ACTIONS_LIVE=1 posts it.`,
    };
  }
  if (!discord.token || !channel) return { status: "skipped", result: "Skipped: no Discord bot token or channel is configured.", produced: [] };
  const content = clip(`**${input.payload.title}**\n${input.payload.body}`, 2000);
  const res = await (deps.http ?? defaultHttp)(`https://discord.com/api/v10/channels/${channel}/messages`, {
    method: "POST", headers: { authorization: `Bot ${discord.token}`, "content-type": "application/json" }, body: JSON.stringify({ content }),
  });
  if (!res.ok) return { status: "failed", result: `Discord returned ${res.status}: ${clip(oneLine(await res.text().catch(() => "")), 200)}`, produced: [] };
  let url: string | undefined;
  try {
    const m = JSON.parse(await res.text()) as { id?: string; guild_id?: string };
    if (m.id && discord.guildId) url = `https://discord.com/channels/${discord.guildId}/${channel}/${m.id}`;
  } catch {
    // the post went out; the link is a nicety
  }
  return { status: "done", result: url ?? "Posted to Discord.", ...(url ? { url } : {}), produced: [] };
}

// ---------- calendar_event and email_send (through the owner's Google connections) ----------

const EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
export const addressesOf = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,;]/) : []).map((x) => String(x).trim()).filter(Boolean);
export const validAddresses = (xs: string[]): boolean => xs.length > 0 && xs.length <= 5 && xs.every((x) => EMAIL.test(x) && x.length <= 254);

// The sample connections of a demo business reach nobody, so an approved email or invite really runs through them even when real actions are off.
const sampleOnly = (deps: ExecutorDeps): boolean => (deps.connections as { simulated?: boolean } | undefined)?.simulated === true;

async function portFor(deps: ExecutorDeps): Promise<ConnectionsPort> {
  return deps.connections ?? (await import("../connections/production.js")).productionConnections().port(deps.tenant);
}

// Words for a refusal from a connection, or for Google being unsure. Anything that might have been sent is NOT retried by
// itself: the Action is recorded, so approving again does nothing, and the owner is told to check first.
function refusal(e: unknown, what: string): Outcome {
  if (e instanceof NotConnectedError || e instanceof NeedsAttentionError || e instanceof NotAllowedError) {
    return { status: "failed", produced: [], result: `${e.words.replace(/Ask the owner to /g, "").replace(/Ask them to /g, "")} Nothing was done.` };
  }
  if (e instanceof NotConfiguredError) return { status: "failed", produced: [], result: `${e.availability.message} Nothing was done.` };
  if (e instanceof RateLimitedError) return { status: "failed", produced: [], result: `${e.words} Nothing was done.` };
  if (e instanceof GoogleApiError && e.status < 500 && e.status !== 429) return { status: "failed", produced: [], result: `Google would not ${what} (${e.message.replace(/\.$/, "")}). Nothing was changed.` };
  const sent = what === "send the email";
  if (what === "do that") return { status: "failed", produced: [], result: "We couldn't confirm that it was done. Check the tool itself before trying again; we won't repeat it on our own." };
  return { status: "failed", produced: [], result: `We couldn't confirm that Google ${sent ? "sent the email" : "added the meeting"}. Check ${sent ? "your Sent folder" : "your calendar"} before trying again; we won't repeat it on our own.` };
}

async function calendarEvent(input: ExecInput, deps: ExecutorDeps): Promise<Outcome> {
  const p = input.payload;
  const start = str(p.start), end = str(p.end);
  const attendees = addressesOf(p.attendees);
  if (!start || !end || Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end)) || Date.parse(end) <= Date.parse(start)) {
    return { status: "failed", produced: [], result: "Nothing was added: the card has no valid start and end time." };
  }
  if (attendees.length && !validAddresses(attendees)) return { status: "failed", produced: [], result: "Nothing was added: a guest's email address isn't valid." };
  if (deps.dryRun && !sampleOnly(deps)) {
    return { status: "dry_run", produced: [], result: `Dry run: would add "${clip(p.title, 120)}" on ${start}${attendees.length ? ` and invite ${attendees.join(", ")}` : ""}. Nothing was added; ALLEVIA_ACTIONS_LIVE=1 adds it.` };
  }
  try {
    const made = await (await portFor(deps)).run<GoogleSession, { id: string; link?: string }>("google-calendar", "add meeting", async (s) => {
      if (!s.allowed("https://www.googleapis.com/auth/calendar.events")) throw new NotAllowedError("google-calendar", "Google Calendar", "Google Calendar is connected but you did not allow adding meetings. Connect it again and leave every box ticked.");
      return s.apis.createEvent(s.accessToken, {
        summary: clip(p.title, 200), ...(p.body ? { description: clip(p.body, 4000) } : {}), start, end, ...(str(p.timeZone) ? { timeZone: str(p.timeZone)! } : {}), ...(attendees.length ? { attendees } : {}),
      });
    }, { ...(input.agent ? { actor: input.agent } : {}) });
    return { status: "done", produced: [], result: made.link ?? `Added "${clip(p.title, 120)}" to your calendar.`, ...(made.link ? { url: made.link } : {}) };
  } catch (e) {
    return refusal(e, "add the meeting");
  }
}

async function emailSend(input: ExecInput, deps: ExecutorDeps): Promise<Outcome> {
  const p = input.payload;
  const to = addressesOf(p.to), cc = addressesOf(p.cc);
  if (!validAddresses(to) || (cc.length && !validAddresses(cc))) return { status: "failed", produced: [], result: "Nothing was sent: an email address on the card isn't valid." };
  const subject = str(p.subject) ?? p.title;
  if (!p.body.trim()) return { status: "failed", produced: [], result: "Nothing was sent: the email has no text." };
  if (p.send === false) {
    return { status: "done", produced: [], result: "Approved. This wording is saved as ready; nothing was sent. Ask your team to send it when you want it to go." };
  }
  if (deps.dryRun && !sampleOnly(deps)) {
    return { status: "dry_run", produced: [], result: `Dry run: would send "${clip(subject, 120)}" to ${to.join(", ")}. Nothing was sent; ALLEVIA_ACTIONS_LIVE=1 sends it.` };
  }
  try {
    const sent = await (await portFor(deps)).run<GoogleSession, { id: string }>("gmail", "send email", (s) =>
      s.apis.sendEmail(s.accessToken, { to, ...(cc.length ? { cc } : {}), subject: clip(subject, 300), body: p.body, ...(str(p.threadId) ? { threadId: str(p.threadId)! } : {}) }), { ...(input.agent ? { actor: input.agent } : {}) });
    return { status: "done", produced: [], result: `Sent "${clip(subject, 120)}" to ${to.join(", ")} (message ${sent.id}).` };
  } catch (e) {
    return refusal(e, "send the email");
  }
}

// connection_action: any change on a connected tool (post, send a campaign, add a CRM note, pause a keyword ...) the owner approved.
async function connectionAction(input: ExecInput, deps: ExecutorDeps): Promise<Outcome> {
  const p = input.payload;
  const connection = str(p.connection), tool = str(p.tool);
  const args = p.args && typeof p.args === "object" && !Array.isArray(p.args) ? (p.args as Record<string, unknown>) : {};
  if (!connection || !tool || !/^[A-Za-z0-9_]+$/.test(tool)) return { status: "failed", produced: [], result: "Nothing was done: the card does not name a tool and an action." };
  if (deps.dryRun) {
    return { status: "dry_run", produced: [], result: `Dry run: would do "${clip(p.title, 120)}" in ${str(p.target) ?? connection}. Nothing was done; ALLEVIA_ACTIONS_LIVE=1 does it.` };
  }
  try {
    const out = await (await portFor(deps)).run<{ execute(t: string, a: Record<string, unknown>): Promise<unknown> }, unknown>(connection, tool, (s) => s.execute(tool, args), { ...(input.agent ? { actor: input.agent } : {}) });
    return { status: "done", produced: [], result: `Done in ${str(p.target) ?? connection}: "${clip(p.title, 120)}".${out && typeof out === "object" ? "" : ""}` };
  } catch (e) {
    return refusal(e, "do that");
  }
}

// ---------- the one entry point ----------

async function readAction(g: GraphHandle, id: string): Promise<ActionView | null> {
  const [a] = await g.roQuery<{ p: Record<string, unknown>; affects: string[]; produced: string[] }>(
    `MATCH (a:Entity:Action {id:$id})
     OPTIONAL MATCH (a)-[f:AFFECTS]->(t:Entity) WHERE f.until IS NULL
     WITH a, collect(DISTINCT t.id) AS affects
     OPTIONAL MATCH (a)-[r:RESULTED_IN]->(x:Entity) WHERE r.until IS NULL
     RETURN properties(a) AS p, affects, collect(DISTINCT x.id) AS produced`, { id });
  if (!a) return null;
  const p = a.p;
  return {
    id, kind: p.kind as ActionKind, status: p.status as ActionStatus, result: String(p.result ?? ""), at: Number(p.at ?? 0),
    ...(typeof p.url === "string" ? { url: p.url } : {}), ...(p.simulated === true ? { simulated: true } : {}),
    affects: a.affects, produced: a.produced,
    ...(Array.isArray(p.rulesApplied) ? { rulesApplied: p.rulesApplied as string[] } : {}),
  };
}

export async function executeApproval(g: GraphHandle, input: ExecInput, deps: ExecutorDeps): Promise<ActionView> {
  const id = actionIdFor(input.approvalId);
  const existing = await readAction(g, id);
  if (existing) return existing;
  let out: Outcome;
  try {
    switch (input.kind) {
      case "github_issue": out = await githubIssue(g, input, deps); break;
      case "content_draft": out = await contentDraft(g, input, deps); break;
      case "pause_ad": out = await pauseAd(g, input); break;
      case "discord_post": out = await discordPost(input, deps); break;
      case "calendar_event": out = await calendarEvent(input, deps); break;
      case "email_send": out = await emailSend(input, deps); break;
      case "connection_action": out = await connectionAction(input, deps); break;
      case "publish_post": out = await publishPostAction(g, { approvalId: input.approvalId, payload: input.payload, ...(input.agent ? { agent: input.agent } : {}), now: input.now }, deps); break;
      default: out = { status: "failed", result: `No executor for ${String(input.kind)}.`, produced: [] };
    }
  } catch (e) {
    out = { status: "failed", result: clip(oneLine(e instanceof Error ? e.message : String(e)), 500), produced: [] };
  }
  // An email that went out or a meeting that was booked is written into the Sales records (a dry run sent nothing, so writes nothing).
  if (out.status === "done" && (input.kind === "email_send" || input.kind === "calendar_event")) {
    try {
      const sales = await recordSalesOutcome(g, { approvalId: input.approvalId, kind: input.kind, payload: input.payload, ...(input.agent ? { agent: input.agent } : {}), now: input.now, tenant: deps.tenant }, out.url);
      out = { ...out, produced: [...out.produced, ...sales.produced] };
    } catch (e) {
      out = { ...out, result: `${out.result} (It was done, but the sales records could not be updated: ${clip(oneLine(e instanceof Error ? e.message : String(e)), 160)}.)` };
    }
  }
  await upsertNode(g, {
    type: "Action", id, name: clip(`${input.kind}: ${input.payload.title}`, 160),
    props: {
      kind: input.kind, status: out.status, result: out.result, at: input.now, approval: input.approvalId,
      ...(out.url ? { url: out.url } : {}), ...(out.rulesApplied?.length ? { rulesApplied: out.rulesApplied } : {}),
      ...(input.agent ? { by: input.agent } : {}),
    },
    ...(out.simulated ? { simulated: true } : {}),
  }, input.now);
  await upsertEdge(g, { from: input.approvalId, type: "RESULTED_IN", to: id }, input.now);
  const target = out.affects ?? [str(input.payload.targetId), str(input.payload.channelId), str(input.payload.campaignId)].filter((x): x is string => !!x);
  const affects = [...(await existingIds(g, target))];
  if (!affects.length) {
    const ev = await firstEvidence(g, input.recommendationId);
    if (ev) affects.push(ev);
  }
  for (const t of affects) await upsertEdge(g, { from: id, type: "AFFECTS", to: t }, input.now);
  for (const x of out.produced) await upsertEdge(g, { from: id, type: "RESULTED_IN", to: x }, input.now);
  return (await readAction(g, id))!;
}
