// Executors (spec §9): what happens when the owner approves a card. Each writes one Action {kind, status, result, at},
// Approval -RESULTED_IN-> Action, Action -AFFECTS-> its target, and Action -RESULTED_IN-> whatever it made.
//   github_issue   `gh issue create` on config.githubActionRepo with the label allevia-action (created if missing).
//   content_draft  a Content {status:'draft', format} PRODUCED by the agent, its markdown under
//                  <dataDir>/drafts/<tenant>/ (gitignored), USES_RULE for every learned or brand rule applied. Never
//                  publishes anything.
//   pause_ad       simulated: the simulated Campaign's status becomes paused (TRACKED, so a Version keeps "active").
//                  A real campaign is never touched: the action is skipped and says so.
//   discord_post   posts to config.discord.channelId; skipped when there is no token.
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
import { upsertEdge, upsertNode } from "../graph/upsert.js";
import { entityId, slugify } from "../util/ids.js";
import { isoDate } from "../util/time.js";
import { clip, oneLine } from "../insights/text.js";
import { activeRules, applyRules, DETERMINISTIC_OPS, markRulesApplied, type ActiveRule } from "./learning.js";
import { ensureAgentNode, existingIds, findBusinessId, type Payload } from "./shared.js";

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

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const agentName = (rosterId: string | undefined) => (rosterId ? agentById(rosterId)?.name ?? rosterId : "Allevia");

async function firstEvidence(g: GraphHandle, recId: string | undefined): Promise<string | undefined> {
  if (!recId) return undefined;
  const [r] = await g.roQuery<{ id: string }>(
    "MATCH (:Recommendation {id:$id})-[e:EVIDENCED_BY]->(x:Entity) WHERE e.until IS NULL RETURN x.id AS id ORDER BY e.since, id LIMIT 1", { id: recId });
  return r?.id;
}

// ---------- github_issue ----------

async function githubIssue(g: GraphHandle, input: ExecInput, deps: ExecutorDeps): Promise<Outcome> {
  const repo = deps.config?.githubActionRepo ?? loadConfig().githubActionRepo;
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
  const agent = input.agent ?? "content-strategist";
  const agentId = await ensureAgentNode(g, agent, input.now);
  const format = str(p.format) ?? "post";
  const channelId = str(p.channelId) && (await existingIds(g, [str(p.channelId)!])).has(str(p.channelId)!) ? str(p.channelId) : undefined;
  const [ch] = channelId ? await g.roQuery<{ name: string }>("MATCH (c:Channel {id:$id}) RETURN c.name AS name", { id: channelId }) : [];
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
  const file = join(dataDir, "drafts", slugify(deps.tenant) || "tenant", `${slugify(suffix) || "draft"}.md`);
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
      "MATCH (:Recommendation {id:$id})-[a:ADVANCES]->(gl:Goal) WHERE a.until IS NULL RETURN gl.id AS id", { id: input.recommendationId });
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
    "MATCH (c:Campaign {id:$id}) RETURN c.name AS name, c.status AS status, c.simulated AS simulated", { id });
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
  const discord = deps.config?.discord ?? loadConfig().discord;
  const channel = str(input.payload.channelId)?.match(/^\d+$/) ? str(input.payload.channelId)! : discord.channelId;
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

// ---------- the one entry point ----------

async function readAction(g: GraphHandle, id: string): Promise<ActionView | null> {
  const [a] = await g.roQuery<{ p: Record<string, unknown>; affects: string[]; produced: string[] }>(
    `MATCH (a:Action {id:$id})
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
      default: out = { status: "failed", result: `No executor for ${String(input.kind)}.`, produced: [] };
    }
  } catch (e) {
    out = { status: "failed", result: clip(oneLine(e instanceof Error ? e.message : String(e)), 500), produced: [] };
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
