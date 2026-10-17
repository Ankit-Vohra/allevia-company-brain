// What moved a goal: the plan reads what is aimed at each goal from the graph, not from a list the code keeps. Everything that ADVANCES a
// goal now is an edge into it (a card the team proposed, the draft behind it, a post, a fix, a lead, a deal, a meeting, a message), so
// two traversals answer "what is this goal getting":
//   1. everything with a current ADVANCES edge into the goals, grouped by its label, what kind of card or post it is, and its status;
//   2. each post (Content) that advances a goal with its newest reading (Observation -MEASURES-> Content).
// The plan's line ("2 approved drafts and 1 fix are aimed at ...") counts the cards the owner sees, the Approvals, once: the idea behind
// a card (Recommendation) advances the same goal, and counting it too would say everything twice.
import type { GoalAim } from "../../shared/contracts.js";
import type { GraphHandle } from "../graph/client.js";
import { list, plural } from "../insights/text.js";

type Read = Pick<GraphHandle, "roQuery">;

// The labels an ADVANCES edge can start from (schema.ts), in the order the plan reads them.
const KINDS = ["Approval", "Recommendation", "Content", "Task", "Campaign", "Lead", "Deal", "Meeting", "Message"] as const;
const APPROVED = new Set(["approved", "edited", "executed"]);

// What a card is, as one word for the owner (the action kinds of shared/contracts.ts), singular and plural.
const NOUN: Record<string, [string, string]> = {
  content_draft: ["draft", "drafts"], github_issue: ["fix", "fixes"], email_send: ["email", "emails"], calendar_event: ["invite", "invites"],
  publish_post: ["post", "posts"], pause_ad: ["ad change", "ad changes"], discord_post: ["message", "messages"], connection_action: ["change", "changes"],
};
const noun = (what: string | null, n: number): string => NOUN[what ?? ""]?.[n === 1 ? 0 : 1] ?? (n === 1 ? "action" : "actions");

interface GroupRow { goalId: string; kinds: string[]; status: string | null; what: string | null; n: number }
interface ContentRow { goalId: string; id: string; name: string | null; status: string | null; obsId: string | null; metric: string | null; value: number | null; unit: string | null; at: string | null }

/** The plan's line for one goal, from its Approval groups; null when nothing is aimed at it. */
export function aimSentence(goalName: string, groups: GoalAim["groups"]): string | null {
  const approved = new Map<string, number>();
  let waiting = 0;
  for (const x of groups) {
    if (x.kind !== "Approval") continue;
    if (APPROVED.has(x.status ?? "")) approved.set(x.what ?? "", (approved.get(x.what ?? "") ?? 0) + x.count);
    else if ((x.status ?? "pending") === "pending") waiting += x.count;
  }
  const parts = [...approved.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = parts.reduce((a, [, n]) => a + n, 0);
  const said = parts.map(([what, n], i) => `${n} ${i === 0 ? "approved " : ""}${noun(what || null, n)}`);
  const goal = `"${goalName}"`;
  const aimed = total ? `${list(said, 4)} ${total === 1 ? "is" : "are"} aimed at ${goal}.` : "";
  const wait = !waiting ? "" : aimed
    ? ` ${waiting} more ${waiting === 1 ? "is" : "are"} waiting for your OK.`
    : `${plural(waiting, "idea")} ${waiting === 1 ? "is" : "are"} waiting for your OK to help with ${goal}.`;
  return `${aimed}${wait}` || null;
}

/** What is aimed at each of these goals now. A goal nothing advances is not in the map. */
export async function goalAims(g: Read, goals: ReadonlyArray<{ id: string; name: string }>): Promise<Map<string, GoalAim>> {
  const out = new Map<string, GoalAim>();
  if (!goals.length) return out;
  const ids = goals.map((x) => x.id);
  const names = new Map(goals.map((x) => [x.id, x.name]));
  // grouped in a WITH (the status and the kind can be missing); the edge is bound and tested under the count
  const rows = await g.roQuery<GroupRow>(
    `MATCH (x:Entity)-[a:ADVANCES]->(gl:Entity:Goal) WHERE ID(a) >= 0 AND a.until IS NULL AND gl.id IN $ids
     WITH gl.id AS goalId, labels(x) AS kinds, x.status AS status, coalesce(x.kind, x.format) AS what, count(x) AS n
     RETURN goalId, kinds, status, what, n`, { ids });
  const content = await g.roQuery<ContentRow>(
    `MATCH (c:Entity:Content)-[a:ADVANCES]->(gl:Entity:Goal) WHERE a.until IS NULL AND gl.id IN $ids
     OPTIONAL MATCH (o:Observation)-[m:MEASURES]->(c) WHERE m.until IS NULL AND coalesce(o.baseline, false) = false
     WITH gl, c, o ORDER BY coalesce(o.windowEnd, o.asOf) DESC, o.id DESC
     WITH gl, c, collect(o)[0] AS o
     RETURN gl.id AS goalId, c.id AS id, c.name AS name, c.status AS status, o.id AS obsId, o.metric AS metric, o.value AS value, o.unit AS unit,
            coalesce(o.windowEnd, o.asOf) AS at ORDER BY goalId, id LIMIT 200`, { ids });

  for (const r of rows) {
    const kind = KINDS.find((k) => r.kinds.includes(k));
    if (!kind) continue;
    const aim = out.get(r.goalId) ?? { total: 0, groups: [], content: [], sentence: null };
    aim.groups.push({ kind, what: r.what, status: r.status, count: r.n });
    aim.total += r.n;
    out.set(r.goalId, aim);
  }
  for (const c of content) {
    const aim = out.get(c.goalId) ?? { total: 0, groups: [], content: [], sentence: null };
    aim.content.push({
      id: c.id, name: c.name ?? c.id, status: c.status,
      latest: c.obsId && c.metric && typeof c.value === "number" ? { metric: c.metric, value: c.value, unit: c.unit, at: c.at, obsId: c.obsId } : null,
    });
    out.set(c.goalId, aim);
  }
  for (const [id, aim] of out) {
    aim.groups.sort((a, b) => KINDS.indexOf(a.kind as (typeof KINDS)[number]) - KINDS.indexOf(b.kind as (typeof KINDS)[number]) || b.count - a.count || (a.what ?? "").localeCompare(b.what ?? "") || (a.status ?? "").localeCompare(b.status ?? ""));
    aim.sentence = aimSentence(names.get(id) ?? id, aim.groups);
  }
  return out;
}
