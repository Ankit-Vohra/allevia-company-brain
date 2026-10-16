// Where an approved fix lands, per business (docs: onboarding trials, gap 2). Until now the `github_issue` action opened an
// issue on one repo from the server's config, Allevia's own, so a customer's findings would have landed in Allevia's
// tracker. Now each business has its own action target, stored on its Business node:
//   app     (the default) a Task inside the app. The owner already saw the card on the web or in Discord; the approved fix
//           becomes an open task the team keeps. No outside system is touched.
//   github  an issue on a repo the business chose for itself (opt-in; the server's `gh` must be able to write there).
// A customer's business can never be pointed at the repo Allevia runs on (ALLEVIA_ACTION_REPO): setActionTarget refuses it,
// and getActionTarget (which the executor calls every time) treats it as "app" even if the graph was written directly. The
// founder's own businesses (tenant-config.ts, ALLEVIA_ACTION_TENANTS) keep using that tracker when they chose nothing;
// beyond that only an operator (the CLI, never a web request) can mark a business as allowed to use that repo.
import { loadConfig } from "../config.js";
import type { GraphHandle } from "../graph/client.js";
import { upsertNode } from "../graph/upsert.js";
import { findBusinessId } from "./shared.js";

export type ActionTarget = { kind: "app"; reason?: string } | { kind: "github"; repo: string };

export class ActionTargetError extends Error {
  override name = "ActionTargetError";
}

// owner/name as GitHub writes them: the owner is letters, digits and single hyphens; the name adds dots and underscores.
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/[A-Za-z0-9._-]{1,100}$/;

export const normalizeRepo = (raw: string): string => raw.trim().replace(/\/+$/, "");
export const validRepo = (raw: string): boolean => {
  const r = normalizeRepo(raw);
  const name = r.split("/")[1] ?? "";
  return REPO.test(r) && name !== "." && name !== "..";
};
const same = (a: string, b: string): boolean => normalizeRepo(a).toLowerCase() === normalizeRepo(b).toLowerCase();

export const APP_TARGET_LABEL = "Tasks inside the app and on Discord";

// What an approved fix does, in the owner's words, for a card that waits for their OK (Discord, issue #8).
export function fixDestinationWords(t: ActionTarget | undefined): string {
  if (t?.kind === "github") return `If you say OK, it goes to ${t.repo} on GitHub as a to-do. Nothing on your site changes yet.`;
  return "If you say OK, it becomes a to-do in your tasks. Nothing on your site changes yet.";
}
const OWN_REPO_REASON = "That repo is Allevia's own, so the fix went to your tasks instead.";

interface Stored { t: string | null; r: string | null; op: boolean | null }

async function readStored(g: GraphHandle, businessId: string): Promise<Stored | undefined> {
  const [row] = await g.roQuery<Stored>("MATCH (b:Entity:Business {id:$id}) RETURN b.actionTarget AS t, b.actionRepo AS r, b.actionOperator AS op", { id: businessId });
  return row;
}

// What the executor reads on every github_issue approval.
//   the business chose `app`                        -> a task
//   the business chose a repo of its own            -> that repo (Allevia's own repo only when an operator allowed it)
//   it chose nothing (the usual case):
//     the founder's own business (`founders`)       -> the founder's tracker (serverRepo), as before this existed
//     a connector repo passed in (`connectorRepo`)  -> used as given, except Allevia's own repo for a business not the founder's
//     anyone else                                   -> a task
// Anything unclear is "app".
export async function getActionTarget(
  g: GraphHandle, tenant?: string, opts: { serverRepo?: string; businessId?: string; founders?: boolean; connectorRepo?: string } = {},
): Promise<ActionTarget> {
  const serverRepo = opts.serverRepo ?? loadConfig().githubActionRepo;
  const biz = opts.businessId ?? (await findBusinessId(g, tenant));
  const s = biz ? await readStored(g, biz) : undefined;
  if (s?.t === "app") return { kind: "app" };
  if (s?.t === "github") {
    if (typeof s.r !== "string" || !validRepo(s.r)) return { kind: "app" };
    if (same(s.r, serverRepo) && s.op !== true) return { kind: "app", reason: OWN_REPO_REASON };
    return { kind: "github", repo: normalizeRepo(s.r) };
  }
  if (opts.connectorRepo && validRepo(opts.connectorRepo) && (opts.founders || !same(opts.connectorRepo, serverRepo))) return { kind: "github", repo: normalizeRepo(opts.connectorRepo) };
  if (opts.founders) return { kind: "github", repo: normalizeRepo(serverRepo) };
  return { kind: "app" };
}

export type ActionTargetInput = { target: "app" } | { target: "github"; repo: string };

export async function setActionTarget(
  g: GraphHandle, input: ActionTargetInput,
  opts: { now?: number; tenant?: string; businessId?: string; serverRepo?: string; operator?: boolean } = {},
): Promise<ActionTarget> {
  const now = opts.now ?? Date.now();
  const biz = opts.businessId ?? (await findBusinessId(g, opts.tenant));
  if (!biz) throw new ActionTargetError("This business isn't set up yet.");
  const [b] = await g.roQuery<{ name: string }>("MATCH (b:Entity:Business {id:$id}) RETURN b.name AS name", { id: biz });
  if (!b) throw new ActionTargetError("This business isn't set up yet.");
  if (input.target === "app") {
    await upsertNode(g, { type: "Business", id: biz, name: b.name, props: { actionTarget: "app", actionRepo: null, actionOperator: false } }, now);
    return { kind: "app" };
  }
  if (!validRepo(input.repo)) throw new ActionTargetError("That doesn't look like a GitHub repo. Write it as owner/name, for example kestrel-dental/website-fixes.");
  const repo = normalizeRepo(input.repo);
  const serverRepo = opts.serverRepo ?? loadConfig().githubActionRepo;
  if (same(repo, serverRepo) && !opts.operator) {
    throw new ActionTargetError("That repo is Allevia's own tracker. Pick one of your own, or keep fixes in your tasks.");
  }
  await upsertNode(g, { type: "Business", id: biz, name: b.name, props: { actionTarget: "github", actionRepo: repo, actionOperator: opts.operator === true && same(repo, serverRepo) } }, now);
  return { kind: "github", repo };
}
