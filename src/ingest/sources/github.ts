// GitHub issues source (spec §6.2): the company's issues, read through the `gh` CLI with a GET-only `gh api` call.
// READ-ONLY: nothing here creates, edits or comments on anything.
//
//   Task(kind=issue)  status (open/closed), labels, ref "<repo>#<n>"; one Document per issue is its source
//   OWNS              the first assignee (a founder login → person:founder, anyone else → Person by login); with no
//                     assignee, a "founder-action" label → the founder. OWNS into a Task is functional: one owner.
//   MENTIONS          Task → a known entity whose name appears in the title or body (whole words; a one-word name must
//                     match its capitalisation, so "Ops" or "Content" in prose do not count), and Task → the Team of each
//                     "dept:<team>" label
// Pull requests are skipped (the issues endpoint returns them too), and so is any issue whose title or labels match the
// privacy filter's sensitive-name pattern (tokens, access, finance…), the same rule the vault's path policy applies.
// The body is never stored whole: sensitive sections are dropped, the rest is redacted, and only its first paragraph
// becomes the Task's summary. Issue text is untrusted data, never instructions.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { EdgeInput, NodeInput, Prim } from "../../graph/upsert.js";
import type { EntityType } from "../../graph/schema.js";
import { entityId, sha256 } from "../../util/ids.js";
import { SENSITIVE, dropSensitiveSections, redact } from "../privacy.js";
import { FOUNDER_ID, founderNode, isReservedId } from "../actors.js";
import type { KnownEntity } from "../resolve-names.js";
import type { SourceResult } from "../types.js";

const execFileP = promisify(execFile);

export interface GhIssue {
  number: number;
  title: string;
  body?: string | null;
  state: string;
  labels: string[];
  assignees: string[];
  isPr: boolean;
  createdAt: string;
  updatedAt: string;
  closedAt?: string | null;
  url?: string;
}

// One compact JSON object per issue (gh prints each jq result on its own line, across all pages).
export const ISSUE_JQ =
  ".[] | {number, title, body, state, labels: [.labels[].name], assignees: [.assignees[].login], isPr: (.pull_request != null), " +
  "createdAt: .created_at, updatedAt: .updated_at, closedAt: .closed_at, url: .html_url}";

export type GhRunner = (args: string[]) => Promise<string>;

export const ghCli: GhRunner = async (args) =>
  (await execFileP("gh", args, { maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" } })).stdout;

const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

export async function fetchIssues(repo: string, run: GhRunner = ghCli): Promise<GhIssue[]> {
  if (!REPO_NAME.test(repo)) throw new Error(`repo must be owner/name, got ${JSON.stringify(repo)}`);
  const out = await run(["api", `repos/${repo}/issues?state=all&per_page=100`, "--paginate", "--jq", ISSUE_JQ]);
  const issues: GhIssue[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const v = JSON.parse(line) as Partial<GhIssue>;
    if (typeof v.number !== "number" || typeof v.title !== "string") continue;
    issues.push({
      number: v.number, title: v.title, body: typeof v.body === "string" ? v.body : null, state: String(v.state ?? "open"),
      labels: Array.isArray(v.labels) ? v.labels.filter((l): l is string => typeof l === "string") : [],
      assignees: Array.isArray(v.assignees) ? v.assignees.filter((l): l is string => typeof l === "string") : [],
      isPr: v.isPr === true, createdAt: String(v.createdAt ?? ""), updatedAt: String(v.updatedAt ?? ""),
      closedAt: typeof v.closedAt === "string" ? v.closedAt : null, ...(typeof v.url === "string" ? { url: v.url } : {}),
    });
  }
  return issues;
}

// ---------- mapping ----------

export interface GithubCtx {
  repo: string;                 // owner/name
  founderLogins: string[];      // logins that are the founder
  known: KnownEntity[];         // entities to look for in the text (the pipeline passes what the graph holds)
  businessId?: string;          // the tenant's own Business: mentioned everywhere, so never a MENTIONS target
}

const repoShort = (repo: string) => repo.slice(repo.indexOf("/") + 1);
export const issueTaskId = (repo: string, n: number): string => entityId("Task", `issue ${repoShort(repo)}#${n}`);
export const issueDocId = (repo: string, n: number): string => entityId("Document", `github ${repo}#${n}`);

// Types worth a name match: things the business runs or is organised into. People, tasks, documents, rules and
// observations are left out (too generic, or reached another way).
const MATCH_TYPES = new Set<EntityType>(["Agent", "Team", "System", "Channel", "Product", "Feature", "Campaign", "Business"]);
const MIN_NAME = 4;
const SUMMARY_CHARS = 300;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface Matcher { id: string; res: RegExp[] }

function matchers(known: KnownEntity[], businessId?: string): Matcher[] {
  const out: Matcher[] = [];
  for (const k of known) {
    if (!MATCH_TYPES.has(k.type) || k.id === businessId || isReservedId(k.id)) continue;
    const res: RegExp[] = [];
    for (const name of new Set([k.name, ...(k.aliases ?? [])].map((n) => n.trim()))) {
      if (name.length < MIN_NAME || !/\p{L}/u.test(name)) continue;
      const multi = /\s/.test(name);
      // whole words: no letter or digit right before or after
      res.push(new RegExp(`(?<![\\p{L}\\p{N}])${escape(name).replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}])`, multi ? "iu" : "u"));
    }
    if (res.length) out.push({ id: k.id, res });
  }
  return out;
}

function firstParagraph(text: string): string | undefined {
  const para = text.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).find((p) => p && !p.startsWith("#") && !p.startsWith("```"));
  if (!para) return undefined;
  return para.length > SUMMARY_CHARS ? `${para.slice(0, SUMMARY_CHARS - 1).replace(/\s+\S*$/, "")}…` : para;
}

const day = (iso: string): string | undefined => (/^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : undefined);

export function mapIssues(issues: GhIssue[], ctx: GithubCtx): SourceResult {
  const skipped: SourceResult["skipped"] = [];
  const redactions: Record<string, number> = {};
  const count = (c: Record<string, number>) => { for (const [k, n] of Object.entries(c)) redactions[k] = (redactions[k] ?? 0) + n; };
  const nodes = new Map<string, NodeInput>();
  const edges: EdgeInput[] = [];
  const founders = new Set(ctx.founderLogins.map((l) => l.toLowerCase()));
  const found = matchers(ctx.known, ctx.businessId);
  const teams = new Set(ctx.known.filter((k) => k.type === "Team").map((k) => k.id));

  for (const is of [...issues].sort((a, b) => a.number - b.number)) {
    const ref = `${ctx.repo}#${is.number}`;
    if (is.isPr) { skipped.push({ ref, reason: "pull request" }); continue; }
    const sensitive = [is.title, ...is.labels].find((s) => SENSITIVE.test(s));
    if (sensitive !== undefined) { skipped.push({ ref, reason: "sensitive title or label (privacy filter)" }); continue; }

    const title = redact(is.title.replace(/\s+/g, " ").trim());
    count(title.counts);
    const body = redact(dropSensitiveSections(is.body ?? "").text);
    count(body.counts);
    const asOf = day(is.updatedAt) ?? day(is.createdAt);
    const docId = issueDocId(ctx.repo, is.number);
    const taskId = issueTaskId(ctx.repo, is.number);
    const prov = { src: docId, ...(asOf ? { asOf } : {}) };
    const opened = Date.parse(is.createdAt);
    const since = Number.isFinite(opened) ? { since: opened } : {};

    nodes.set(docId, {
      type: "Document", id: docId, name: `${repoShort(ctx.repo)}#${is.number}: ${title.text}`.slice(0, 200),
      props: { kind: "issue", repo: ctx.repo, number: is.number, title: title.text, hash: sha256(`${title.text}\n${body.text}`), ...(is.url ? { url: is.url } : {}) },
      ...(asOf ? { asOf } : {}),
    });
    const summary = firstParagraph(body.text);
    const props: Record<string, Prim> = {
      kind: "issue", status: is.state === "closed" ? "closed" : "open", title: title.text, ref: `${repoShort(ctx.repo)}#${is.number}`,
      repo: ctx.repo, number: is.number, labels: is.labels, openedAt: is.createdAt,
    };
    if (is.closedAt) props.closedAt = is.closedAt;
    if (is.url) props.url = is.url;
    nodes.set(taskId, { type: "Task", id: taskId, name: title.text, ...(summary ? { summary } : {}), props, ...prov });
    edges.push({ from: taskId, type: "SOURCED_FROM", to: docId, ...prov });

    // owner
    const assignee = is.assignees[0];
    let owner: string | undefined;
    let via = "";
    if (assignee) {
      if (founders.has(assignee.toLowerCase())) owner = FOUNDER_ID;
      else {
        owner = entityId("Person", assignee);
        if (!nodes.has(owner)) nodes.set(owner, { type: "Person", id: owner, name: assignee, props: { githubLogin: assignee } });
      }
      via = "assignee";
    } else if (is.labels.includes("founder-action")) {
      owner = FOUNDER_ID;
      via = "label:founder-action";
    }
    if (owner) {
      if (owner === FOUNDER_ID) nodes.set(FOUNDER_ID, founderNode());
      edges.push({ from: owner, type: "OWNS", to: taskId, ...since, props: { via }, ...prov });
    }

    // mentions: dept labels, then names in the text
    const mentioned = new Map<string, string>(); // id -> how it was found
    for (const l of is.labels) {
      const m = /^dept:([\w-]+)$/.exec(l);
      const team = m ? entityId("Team", m[1]!) : undefined;
      if (team && teams.has(team)) mentioned.set(team, "label");
    }
    const text = `${title.text}\n${body.text}`;
    for (const f of found) if (!mentioned.has(f.id) && f.res.some((re) => re.test(text))) mentioned.set(f.id, "name-match");
    for (const [id, via] of [...mentioned].sort(([a], [b]) => (a < b ? -1 : 1))) {
      edges.push({ from: taskId, type: "MENTIONS", to: id, ...since, conf: 0.8, props: { via }, ...prov });
    }
  }
  return { source: "github", docs: [], write: { nodes: [...nodes.values()], edges, observations: [] }, skipped, redactions };
}
