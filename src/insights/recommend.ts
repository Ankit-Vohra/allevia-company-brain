// Recommendations (spec §9 "Recommend"): the analyst job. runInsights runs the detectors and turns each candidate into a
// Recommendation node, with a pending Approval card when the candidate suggests an action. Text comes from the
// detectors' templates, so the numbers come only from the graph; an optional Haiku pass (off by default) may reword
// the "why" but never its figures (polish.ts).
//   (agent:allevia-<owner>)-[:PRODUCED]->(Recommendation)-[:EVIDENCED_BY]->(evidence…)
//                                          (Recommendation)-[:PROPOSES]->(Approval {status:'pending', kind, payload})
//                                          (Recommendation)-[:ADVANCES]->(Goal)   when a related goal exists
// Idempotent: a candidate's key fixes its Recommendation and Approval ids, so a re-run updates them in place (numbers,
// evidence, payload of a still-pending card) instead of adding new ones. A decided card is never reopened, a
// dismissed recommendation stays dismissed, and an open one whose detector ran clean this time becomes 'resolved'.
// A content_draft card is written with the active learned rules already applied, so the owner sees the improved draft.
import { ensureRoster } from "../agent/memory.js";
import { openGraph, type GraphHandle } from "../graph/client.js";
import { closeEdge, upsertEdge, upsertNode } from "../graph/upsert.js";
import { AgentSdkRunner, type LlmRunner } from "../ingest/llm.js";
import { sha256, slugify } from "../util/ids.js";
import { isoDate } from "../util/time.js";
import { applyLearnedRules } from "../actions/learning.js";
import { agentNodeId, ensureAgentNode, existingIds, findBusinessId } from "../actions/shared.js";
import { runDetectors, type Area, type Candidate, type DetectorName } from "./detectors.js";
import { polishText } from "./polish.js";

export const INSIGHTS_SOURCE = "insights";

const suffix = (key: string): string => `insight-${slugify(key).slice(0, 60).replace(/-+$/, "")}-${sha256(key).slice(0, 6)}`;
export const insightRecId = (key: string): string => `recommendation:${suffix(key)}`;
export const insightApprovalId = (key: string): string => `approval:${suffix(key)}`;

export interface GoalRef { id: string; name: string; metricKey: string | null }

// Which goals a finding moves: a goal tracking one of its metrics, else one whose metric belongs to the finding's area.
const AREA_METRICS: Record<Area, RegExp | null> = {
  seo: /gsc|search|organic|impression|click|ctr|seo|index|traffic|session/i,
  content: /view|reel|follower|reach|post|content|engagement|subscriber|play|story|short/i,
  funnel: /signup|setup|activat|conversion|funnel|otp|onboard|account|enquir|lead/i,
  ads: /cpa|^ads?_|_ads?$|ad_spend|spend|lead|conversion|roas|enquir/i,
  knowledge: null,
};

export function relatedGoals(c: Pick<Candidate, "area" | "metrics">, goals: GoalRef[]): GoalRef[] {
  const exact = goals.filter((g) => g.metricKey && (c.metrics ?? []).includes(g.metricKey));
  if (exact.length) return exact;
  const re = AREA_METRICS[c.area];
  return re ? goals.filter((g) => g.metricKey && re.test(g.metricKey)) : [];
}

export async function loadGoals(g: Pick<GraphHandle, "roQuery">): Promise<GoalRef[]> {
  return g.roQuery<GoalRef>(
    `MATCH (gl:Goal) WHERE NOT coalesce(gl.status, '') IN ['retired', 'superseded', 'achieved']
     OPTIONAL MATCH (gl)-[t:TRACKS]->(m:Metric) WHERE t.until IS NULL
     RETURN gl.id AS id, gl.name AS name, coalesce(gl.metricKey, m.key) AS metricKey ORDER BY coalesce(gl.priority, 99), id`);
}

export interface WriteOpts {
  now: number;
  tenant?: string;
  goals?: GoalRef[];
  businessId?: string | null;
  polish?: (c: Candidate) => Promise<string>;
}

export interface RecWrite {
  id: string; key: string; title: string; area: Area; by: string; created: boolean;
  approvalId?: string; approvalCreated?: boolean; goals: string[]; evidence: string[];
}

interface Existing { status: string | null; whyTemplate: string | null; summary: string | null; approvals: Array<{ id: string; status: string | null }> }

async function readExisting(g: GraphHandle, recId: string): Promise<Existing | null> {
  const [r] = await g.roQuery<Existing>(
    `MATCH (r:Recommendation {id:$id})
     OPTIONAL MATCH (r)-[p:PROPOSES]->(a:Approval) WHERE p.until IS NULL
     WITH r, a ORDER BY coalesce(a.createdAt, 0) DESC
     RETURN r.status AS status, r.whyTemplate AS whyTemplate, r.summary AS summary,
            [x IN collect(a) WHERE x IS NOT NULL | {id: x.id, status: x.status}] AS approvals`, { id: recId });
  return r ?? null;
}

// One candidate -> its Recommendation (and card). Exported for callers that hold a candidate of their own (tests, a
// future agent desk); runInsights is the usual way in.
export async function writeRecommendation(g: GraphHandle, c: Candidate, opts: WriteOpts): Promise<RecWrite> {
  const { now } = opts;
  const recId = insightRecId(c.key);
  const agentId = await ensureAgentNode(g, c.agent, now);
  const old = await readExisting(g, recId);
  // Keep a polished "why" while the template behind it is unchanged; re-polish (or use the template) when it moves.
  const why = old?.whyTemplate === c.why && old.summary ? old.summary : opts.polish ? await opts.polish(c) : c.why;
  const status = old?.status && old.status !== "resolved" ? old.status : "open";
  const asOf = isoDate(now);
  await upsertNode(g, {
    type: "Recommendation", id: recId, name: c.title, summary: why,
    props: {
      status, area: c.area, by: c.agent, detector: c.detector, key: c.key, source: INSIGHTS_SOURCE, whyTemplate: c.why,
      numbers: JSON.stringify(c.numbers), score: c.score, confidence: c.confidence, lastSeenAt: now,
      ...(c.impact ? { impact: c.impact } : {}), ...(c.suggestedAction ? { kind: c.suggestedAction.kind } : {}),
      ...(c.metrics?.length ? { metrics: c.metrics } : {}),
    },
    asOf, ...(c.simulated ? { simulated: true } : {}),
  }, now);
  await upsertEdge(g, { from: agentId, type: "PRODUCED", to: recId }, now);

  // Evidence: the ids that exist now; an edge to evidence that no longer backs the finding is closed (kept as history).
  const evidence = [...(await existingIds(g, c.evidence))].sort((a, b) => c.evidence.indexOf(a) - c.evidence.indexOf(b));
  const had = await g.roQuery<{ id: string }>(
    "MATCH (:Recommendation {id:$id})-[e:EVIDENCED_BY]->(x:Entity) WHERE e.until IS NULL RETURN x.id AS id", { id: recId });
  for (const to of evidence) await upsertEdge(g, { from: recId, type: "EVIDENCED_BY", to, asOf }, now);
  for (const h of had) if (!evidence.includes(h.id)) await closeEdge(g, recId, "EVIDENCED_BY", h.id, now, "no longer evidence");

  const goals = relatedGoals(c, opts.goals ?? []);
  for (const gl of goals) await upsertEdge(g, { from: recId, type: "ADVANCES", to: gl.id }, now);

  const out: RecWrite = { id: recId, key: c.key, title: c.title, area: c.area, by: c.agent, created: !old, goals: goals.map((x) => x.id), evidence };
  const action = c.suggestedAction;
  if (!action) return out;

  let payload = { ...action.payload };
  if (action.kind === "content_draft") {
    const applied = await applyLearnedRules(g, payload, {
      agentId: agentNodeId(c.agent), channelId: typeof payload.channelId === "string" ? payload.channelId : undefined, businessId: opts.businessId,
    });
    payload = { ...payload, title: applied.title, body: applied.body, ...(applied.applied.length ? { rulesApplied: applied.applied.map((r) => r.id) } : {}) };
  }
  const pending = old?.approvals.find((a) => a.status === "pending");
  const decided = old?.approvals.find((a) => a.status !== "pending");
  if (decided && !pending) return { ...out, approvalId: decided.id, approvalCreated: false };
  const approvalId = pending?.id ?? insightApprovalId(c.key);
  const [card] = await g.roQuery<{ name: string }>("MATCH (a:Approval {id:$id}) RETURN a.name AS name", { id: approvalId });
  await upsertNode(g, {
    type: "Approval", id: approvalId, name: card?.name ?? `${action.kind}: ${payload.title}`,
    props: {
      kind: action.kind, payload: JSON.stringify(payload), title: payload.title, recommendation: recId, by: c.agent, area: c.area,
      ...(pending ? {} : { status: "pending" }),
    },
    asOf, ...(c.simulated ? { simulated: true } : {}),
  }, now);
  await upsertEdge(g, { from: recId, type: "PROPOSES", to: approvalId }, now);
  for (const gl of goals) await upsertEdge(g, { from: approvalId, type: "ADVANCES", to: gl.id }, now);
  return { ...out, approvalId, approvalCreated: !pending && !card };
}

export interface InsightsOpts {
  graph?: GraphHandle;
  now?: number;
  llm?: boolean;                 // Haiku polish of each new "why" (off by default)
  runner?: LlmRunner;            // injected runner (tests); built on the subscription when llm is on and none is given
  only?: DetectorName[];
  log?: (line: string) => void;
}

export interface InsightsResult {
  tenant: string;
  candidates: Candidate[];
  recommendations: RecWrite[];
  resolved: string[];
  errors: Array<{ detector: string; error: string }>;
  polished: number;
}

export async function runInsights(tenant: string, opts: InsightsOpts = {}): Promise<InsightsResult> {
  const g = opts.graph ?? (await openGraph(tenant));
  const now = opts.now ?? Date.now();
  const biz = await findBusinessId(g, tenant);
  await ensureRoster(g, biz ? { businessId: biz } : {}, now);
  const run = await runDetectors(g, { now, ...(opts.only ? { only: opts.only } : {}) });
  for (const e of run.errors) opts.log?.(`detector ${e.detector} failed: ${e.error}`);
  const goals = await loadGoals(g);
  let polished = 0;
  const runner = opts.llm ? (opts.runner ?? new AgentSdkRunner({ concurrency: 1, retries: 0 })) : undefined;
  const polish = runner ? async (c: Candidate) => {
    const r = await polishText(runner, {
      text: c.why, numbers: Object.values(c.numbers),
      instruction: "Rewrite this finding as one or two plain sentences an owner understands at a glance.",
    });
    if (r.polished) polished++;
    return r.text;
  } : undefined;

  const recommendations: RecWrite[] = [];
  for (const c of run.candidates.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))) {
    recommendations.push(await writeRecommendation(g, c, { now, tenant, goals, businessId: biz, ...(polish ? { polish } : {}) }));
  }

  // Open findings from a detector that ran cleanly and no longer fires are resolved (a Version keeps "open").
  const keys = run.candidates.map((c) => c.key);
  const stale = await g.roQuery<{ id: string; name: string }>(
    `MATCH (r:Recommendation) WHERE r.source = $src AND r.status = 'open' AND r.detector IN $ran AND NOT r.key IN $keys
     RETURN r.id AS id, r.name AS name ORDER BY id`, { src: INSIGHTS_SOURCE, ran: run.ran, keys });
  for (const r of stale) await upsertNode(g, { type: "Recommendation", id: r.id, name: r.name, props: { status: "resolved", resolvedAt: now } }, now);

  return { tenant, candidates: run.candidates, recommendations, resolved: stale.map((r) => r.id), errors: run.errors, polished };
}
