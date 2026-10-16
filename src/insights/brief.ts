// The morning brief, written to the owner as "Today's note" in plain words (docs/owner-words.md; the stored graph
// names stay: Goal, baseline, Recommendation, Approval). Shaped as a goal pulse (product design §3.2 "Daily 07:30", §9
// item 10). In order:
//   1. Your goals: each Goal against where the owner started and the goal's number: reached, going well, needs a push or
//      behind (no reading yet says "we'll know after your first full week"). A changed status is written back to the
//      Goal, so its history is a series of Versions.
//   2. What changed since the last note: new Observations (with the two biggest moves), facts that ended, things the
//      team learned from the owner's edits.
//   3. What we noticed: the top 3 open Recommendations (not the on-call ones).
//   4. On call: open tech Recommendations from Zoya (errors, crashes) and Imran (releases, app stores). Only when
//      something is open.
//   5. Waiting for your OK: the pending Approvals.
//   6. One next step.
// Every number comes from the graph; the text is a template. An optional Haiku pass (off by default) may tighten the
// wording but must keep every figure and [[id]] (polish.ts). Saved as Document {kind:'brief'} (one per day, re-written
// in place) PRODUCED by the Chief of Staff, MENTIONS everything it summarises. `publish` is the channel (Discord later).
import { openGraph, type GraphHandle } from "../graph/client.js";
import { closeEdge, upsertEdge, upsertNode } from "../graph/upsert.js";
import { AgentSdkRunner, type LlmRunner } from "../ingest/llm.js";
import { plainWho } from "../../shared/roster.js";
import { entityId } from "../util/ids.js";
import { isoDate } from "../util/time.js";
import { ensureAgentNode, existingIds, findBusinessId } from "../actions/shared.js";
import { learningMetrics, type LearningMetrics } from "../actions/learning.js";
import { DAY_MS, cap1, clip, dayMs, dayOf, fmt, longDate, money, pct, plural, round, shortDate } from "./text.js";
import { polishText } from "./polish.js";
import { humanPass } from "../agent/humanize.js";
import { readStandup } from "../proactive/note.js";

type Read = Pick<GraphHandle, "roQuery">;

export type GoalStatus = "achieved" | "on_track" | "at_risk" | "off_track" | "no_data";

export interface GoalPulse {
  id: string; name: string; metricKey: string | null; unit: string | null;
  baseline: number | null; target: number | null; current: number | null; currentAt?: string; obsId?: string;
  progress: number | null; elapsed: number | null; dueAt?: string; status: GoalStatus;
}

export interface Change { obsId: string; subject: string; name: string; metric: string; from: number; to: number; unit: string | null }
export interface ClosedFact { from: string; type: string; to: string; fromName: string; toName: string }

export interface Brief {
  id: string;
  title: string;
  text: string;
  date: string;
  since: number;
  goals: GoalPulse[];
  newObservations: number;
  changes: Change[];
  closed: { count: number; examples: ClosedFact[] };
  learned: Array<{ id: string; text: string }>;
  learning: LearningMetrics;
  newRecommendations: number;
  top: Array<{ id: string; title: string; by: string | null; score: number; approvalId: string | null }>;
  onCall: Array<{ id: string; title: string; by: string | null; score: number }>;
  pending: { count: number; overdue: number; oldestDays: number; cards: Array<{ id: string; title: string; kind: string; ageDays: number }> };
  next: string;
  mentions: string[];
  polished?: boolean;
  published?: string;
}

export interface BriefOpts {
  graph?: GraphHandle;
  now?: number;
  since?: number | string;
  llm?: boolean;
  runner?: LlmRunner;
  publish?: (b: Brief) => Promise<string | void>;
}

// ---------- 1. goal pulse ----------

interface GoalRow {
  id: string; name: string; metricKey: string | null; unit: string | null; target: number | null; baseline: number | null;
  startAt: string | number | null; dueAt: string | null; createdAt: number | null; status: string | null; programStart: string | number | null;
  own: boolean;
}

const toMs = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const d = dayOf(v);
  return d ? dayMs(d) : undefined;
};

export function goalStatus(p: { current: number | null; baseline: number | null; target: number | null; elapsed: number | null }): { status: GoalStatus; progress: number | null } {
  const { current, baseline, target, elapsed } = p;
  if (current === null || target === null) return { status: "no_data", progress: null };
  const base = baseline ?? 0;
  if (target === base) return { status: current >= target ? "achieved" : "at_risk", progress: current >= target ? 1 : 0 };
  const progress = (current - base) / (target - base);
  if (progress >= 1) return { status: "achieved", progress };
  if (progress < 0) return { status: "off_track", progress };
  if (elapsed === null) return { status: progress > 0 ? "on_track" : "at_risk", progress };
  return { status: progress >= elapsed - 0.1 ? "on_track" : "at_risk", progress };
}

export async function goalPulse(g: Read, now: number, businessId: string | null): Promise<GoalPulse[]> {
  const goals = await g.roQuery<GoalRow>(
    `MATCH (gl:Goal) WHERE NOT coalesce(gl.status, '') IN ['retired', 'superseded']
     OPTIONAL MATCH (gl)-[t:TRACKS]->(m:Metric) WHERE t.until IS NULL
     OPTIONAL MATCH (gl)-[pp:PART_OF]->(pr:Program)
     RETURN gl.id AS id, gl.name AS name, coalesce(gl.metricKey, m.key) AS metricKey, gl.unit AS unit, gl.target AS target,
            gl.baseline AS baseline, gl.startAt AS startAt, gl.dueAt AS dueAt, gl.createdAt AS createdAt, gl.status AS status,
            pr.startAt AS programStart, gl.measure IS NOT NULL AS own
     ORDER BY coalesce(gl.priority, 99), id LIMIT 20`);
  const out: GoalPulse[] = [];
  for (const gl of goals) {
    let current: number | null = null, currentAt: string | undefined, obsId: string | undefined, baseline = gl.baseline;
    if (gl.metricKey) {
      const obs = await g.roQuery<{ id: string; value: number; subject: string; at: string | null; baseline: boolean | null }>(
        `MATCH (o:Observation)-[m:MEASURES]->(s:Entity) WHERE o.metric = $key AND m.until IS NULL
         RETURN o.id AS id, o.value AS value, s.id AS subject, coalesce(o.windowEnd, o.asOf) AS at, o.baseline AS baseline
         ORDER BY at DESC, id LIMIT 500`, { key: gl.metricKey });
      const readings = obs.filter((o) => o.baseline !== true && typeof o.value === "number");
      // The goal's own series first, then the business's, then whichever subject reported the metric last. An Allevia 90
      // goal (one that says how it is measured) is read from its own readings only: another subject's number (a daily
      // count, a simulated campaign) is not the goal's period.
      const subject = gl.own || readings.some((o) => o.subject === gl.id) ? gl.id : businessId && readings.some((o) => o.subject === businessId) ? businessId : readings[0]?.subject;
      const series = readings.filter((o) => o.subject === subject);
      if (series[0]) ({ value: current, at: currentAt, id: obsId } = { value: series[0].value, at: series[0].at ?? undefined, id: series[0].id });
      if (baseline === null || baseline === undefined) {
        const b = obs.find((o) => o.baseline === true && (o.subject === gl.id || o.subject === subject)) ?? obs.find((o) => o.baseline === true);
        baseline = b ? b.value : null;
      }
    }
    const start = toMs(gl.startAt) ?? toMs(gl.programStart) ?? gl.createdAt ?? undefined;
    const due = toMs(gl.dueAt);
    const elapsed = start !== undefined && due !== undefined && due > start ? Math.max(0, Math.min(1, (now - start) / (due - start))) : null;
    const { status, progress } = goalStatus({ current, baseline: baseline ?? null, target: gl.target, elapsed });
    out.push({
      id: gl.id, name: gl.name, metricKey: gl.metricKey, unit: gl.unit, baseline: baseline ?? null, target: gl.target, current,
      ...(currentAt ? { currentAt } : {}), ...(obsId ? { obsId } : {}), progress: progress === null ? null : round(progress, 3),
      elapsed: elapsed === null ? null : round(elapsed, 3), ...(gl.dueAt ? { dueAt: gl.dueAt } : {}), status,
    });
  }
  return out;
}

const value = (n: number, unit: string | null) => (unit && /^(inr|usd|gbp|eur|aud|aed)$/i.test(unit) ? money(n, unit) : unit === "ratio" ? pct(n) : fmt(n));
// The owner's words for a goal's state (docs/owner-words.md): never "on track / at risk / off track".
export const STATUS_TEXT: Record<GoalStatus, string> = { achieved: "Reached", on_track: "Going well", at_risk: "Needs a push", off_track: "Behind", no_data: "We'll know after your first full week" };
// What an approval is, said as the owner's thing to OK.
const KIND_TEXT: Record<string, string> = { github_issue: "a fix for your website", content_draft: "a draft post", pause_ad: "pausing an ad", discord_post: "a message to your team chat" };
const kindText = (k: string): string => KIND_TEXT[k] ?? k.replace(/_/g, " ");

function goalLine(p: GoalPulse): string {
  const due = p.dueAt && dayOf(p.dueAt) ? ` by ${shortDate(dayOf(p.dueAt)!)}` : "";
  const goal = p.target !== null ? `Goal: ${value(p.target, p.unit)}${due}.` : "No goal number set yet.";
  if (p.current === null) return `- ${p.name}: ${STATUS_TEXT.no_data}. ${goal} [[${p.id}]]`;
  const from = p.baseline !== null ? `, you started at ${value(p.baseline, p.unit)}` : "";
  const why = p.status === "at_risk" && p.progress !== null && p.elapsed !== null
    ? `: ${pct(Math.max(0, p.progress), 0)} of the way there, ${pct(p.elapsed, 0)} of the time used`
    : p.status === "off_track" ? ": moving away from the goal" : "";
  return `- ${p.name}: ${value(p.current, p.unit)} now${from}. ${goal} ${STATUS_TEXT[p.status]}${why}. [[${p.id}]]`;
}

// ---------- 2. since the last brief ----------

export async function changesSince(g: Read, since: number, now: number): Promise<{ count: number; changes: Change[] }> {
  const today = isoDate(now);
  const [c] = await g.roQuery<{ n: number }>(
    "MATCH (o:Observation) WHERE o.createdAt >= $since AND NOT o.metric STARTS WITH 'allevia.' AND coalesce(o.baseline, false) = false RETURN count(o) AS n", { since });
  const rows = await g.roQuery<{
    id: string; metric: string; value: number; unit: string | null; subject: string; name: string | null; prev: number | null; simulated: boolean | null;
    oS: string | null; oE: string | null; pS: string | null; pE: string | null;
  }>(
    `MATCH (o:Observation)-[m:MEASURES]->(s:Entity)
     WHERE o.createdAt >= $since AND m.until IS NULL AND NOT o.metric STARTS WITH 'allevia.' AND coalesce(o.baseline, false) = false
     WITH o, s ORDER BY coalesce(o.windowEnd, o.asOf) DESC, o.id LIMIT 500
     OPTIONAL MATCH (p:Observation)-[pm:MEASURES]->(s)
     WHERE p.metric = o.metric AND pm.until IS NULL AND coalesce(p.baseline, false) = false AND coalesce(p.windowEnd, p.asOf) < coalesce(o.windowEnd, o.asOf)
     WITH o, s, p ORDER BY coalesce(p.windowEnd, p.asOf) DESC, p.id
     WITH o, s, collect(p)[0] AS p
     RETURN o.id AS id, o.metric AS metric, o.value AS value, o.unit AS unit, s.id AS subject, s.name AS name, p.value AS prev, o.simulated AS simulated,
            o.windowStart AS oS, coalesce(o.windowEnd, o.asOf) AS oE, p.windowStart AS pS, coalesce(p.windowEnd, p.asOf) AS pE`, { since });
  // Only like for like: a 7-day count is never compared with a 30-day one. Tiny bases (under 10) are noise.
  const span = (a: string | null, b: string | null): number => {
    const x = dayOf(a), y = dayOf(b);
    return x && y ? Math.round((dayMs(y) - dayMs(x)) / DAY_MS) : -1;
  };
  const changes = rows
    .filter((r) => r.prev !== null && r.prev !== undefined && r.simulated !== true && typeof r.value === "number" && Math.abs(r.prev) >= 10 && r.value !== r.prev)
    .filter((r) => span(r.oS, r.oE) === span(r.pS, r.pE))
    .filter((r) => !(r.oS && (dayOf(r.oE) ?? "") >= today))             // a window still open today is a partial count
    .map((r) => ({ r, rel: Math.abs((r.value - r.prev!) / r.prev!) * (span(r.oS, r.oE) === 0 ? 0.5 : 1) })) // day-to-day jitter ranks lower
    .sort((a, b) => b.rel - a.rel || a.r.id.localeCompare(b.r.id))
    .slice(0, 2)
    .map(({ r }): Change => ({ obsId: r.id, subject: r.subject, name: r.name ?? r.subject, metric: r.metric, from: r.prev!, to: r.value, unit: r.unit }));
  return { count: c?.n ?? 0, changes };
}

async function closedSince(g: Read, since: number): Promise<{ count: number; examples: ClosedFact[] }> {
  const [c] = await g.roQuery<{ n: number }>(
    "MATCH ()-[r]->() WHERE r.retiredAt >= $since AND NOT type(r) IN ['HAD_VERSION', 'EVIDENCED_BY', 'MENTIONS'] RETURN count(r) AS n", { since });
  const ex = await g.roQuery<ClosedFact>(
    `MATCH (a:Entity)-[r]->(b:Entity) WHERE r.retiredAt >= $since AND NOT type(r) IN ['HAD_VERSION', 'EVIDENCED_BY', 'MENTIONS']
     RETURN a.id AS from, type(r) AS type, b.id AS to, coalesce(a.name, a.id) AS fromName, coalesce(b.name, b.id) AS toName
     ORDER BY r.retiredAt DESC, from LIMIT 2`, { since });
  return { count: c?.n ?? 0, examples: ex };
}

// ---------- on call: open tech recommendations from Zoya and Imran ----------

export async function onCallOpen(g: Read): Promise<Brief["onCall"]> {
  return g.roQuery<Brief["onCall"][number]>(
    `MATCH (r:Recommendation) WHERE r.status = 'open' AND r.area = 'tech'
     RETURN r.id AS id, r.name AS title, r.by AS by, coalesce(r.score, 0) AS score
     ORDER BY score DESC, coalesce(r.createdAt, 0) DESC, id LIMIT 5`);
}

const verb = (t: string) => ({ OWNS: "owns", DEPENDS_ON: "depends on", BLOCKS: "blocks", MEMBER_OF: "is a member of", SUPERSEDES: "supersedes", USES: "uses", PUBLISHED_ON: "is published on" } as Record<string, string>)[t] ?? t.toLowerCase().replace(/_/g, " ");

// ---------- the brief ----------

export async function writeBrief(tenant: string, opts: BriefOpts = {}): Promise<Brief> {
  const g = opts.graph ?? (await openGraph(tenant));
  const now = opts.now ?? Date.now();
  const date = isoDate(now);
  const id = entityId("Document", `brief ${tenant} ${date}`);
  const biz = await findBusinessId(g, tenant);
  const [bizRow] = biz ? await g.roQuery<{ name: string }>("MATCH (b:Entity:Business {id:$id}) RETURN b.name AS name", { id: biz }) : [];

  let since: number;
  if (opts.since !== undefined) since = typeof opts.since === "number" ? opts.since : Date.parse(opts.since);
  else {
    const [last] = await g.roQuery<{ at: number }>(
      "MATCH (d:Document) WHERE d.kind = 'brief' AND d.id <> $id AND d.generatedAt < $now RETURN d.generatedAt AS at ORDER BY at DESC, d.id LIMIT 1", { id, now });
    since = last?.at ?? now - DAY_MS;
  }
  if (!Number.isFinite(since)) throw new Error(`brief: since is not a time: ${String(opts.since)}`);

  const goals = await goalPulse(g, now, biz);
  const kpi = await learningMetrics(g, now);
  const { count: newObservations, changes } = await changesSince(g, since, now);
  const closed = await closedSince(g, since);
  const learned = await g.roQuery<{ id: string; text: string }>(
    "MATCH (r:Rule) WHERE r.kind = 'learned' AND r.createdAt >= $since RETURN r.id AS id, coalesce(r.text, r.name) AS text ORDER BY r.createdAt, id LIMIT 5", { since });
  const [nr] = await g.roQuery<{ n: number }>("MATCH (r:Recommendation) WHERE r.createdAt >= $since RETURN count(r) AS n", { since });
  const top = await g.roQuery<{ id: string; title: string; by: string | null; score: number; approvalId: string | null }>(
    `MATCH (r:Recommendation) WHERE r.status = 'open' AND coalesce(r.area, '') <> 'tech' AND coalesce(r.source, '') <> 'standup'
     OPTIONAL MATCH (r)-[p:PROPOSES]->(a:Approval) WHERE p.until IS NULL AND a.status = 'pending'
     WITH r, collect(a.id)[0] AS approvalId
     RETURN r.id AS id, r.name AS title, r.by AS by, coalesce(r.score, 0) AS score, approvalId
     ORDER BY score DESC, coalesce(r.createdAt, 0) DESC, id LIMIT 3`);
  const onCall = await onCallOpen(g);
  const pendingRows = await g.roQuery<{ id: string; title: string | null; name: string; kind: string; createdAt: number | null; score: number | null }>(
    `MATCH (a:Approval) WHERE a.status = 'pending'
     OPTIONAL MATCH (r:Recommendation)-[p:PROPOSES]->(a) WHERE p.until IS NULL
     WITH a, max(r.score) AS score
     RETURN a.id AS id, a.title AS title, a.name AS name, a.kind AS kind, a.createdAt AS createdAt, score
     ORDER BY coalesce(score, 0) DESC, coalesce(createdAt, 0), id LIMIT 500`);
  const age = (ms: number | null) => (ms ? Math.max(0, Math.floor((now - ms) / DAY_MS)) : 0);
  const cards = pendingRows.map((r) => ({ id: r.id, title: r.title ?? r.name.replace(/^[a-z_]+:\s*/, ""), kind: r.kind, ageDays: age(r.createdAt) }));
  const pending = {
    count: cards.length,
    overdue: pendingRows.filter((r) => r.createdAt && now - r.createdAt > 2 * DAY_MS).length,
    oldestDays: cards.reduce((m, c) => Math.max(m, c.ageDays), 0),
    cards: cards.slice(0, 3),
  };

  // ---- text ----
  const lines: string[] = [`Today's note, ${bizRow?.name ?? tenant}, ${longDate(date)}`, ""];
  // the day's stand-up leads: what the team noticed and already drafted, or that nothing was worth the owner's time
  const standup = await readStandup(g, date);
  const drafted = (standup?.items ?? []).filter((i) => i.status === "drafted" && i.approvalId);
  if (standup?.waitingHeading) lines.push(standup.waitingHeading, ...standup.waitingLines, "");
  if (standup) lines.push(standup.heading, ...standup.lines, "");
  lines.push("Your goals");
  if (goals.length) lines.push(...goals.map(goalLine));
  else lines.push("- No goals set yet. Pick two or three when you set up and they show here.");
  lines.push("", `What changed since ${since >= now - 36 * 3_600_000 && since <= now ? "yesterday" : shortDate(isoDate(since))}`);
  lines.push(`- ${plural(newObservations, "new number")} came in${nr?.n ? ` and ${plural(nr.n, "new idea")}` : ""}.`);
  for (const c of changes) {
    const delta = (c.to - c.from) / c.from;
    lines.push(`- ${cap1(c.metric.replace(/_/g, " "))}, ${c.name}: ${value(c.from, c.unit)} -> ${value(c.to, c.unit)} (${delta > 0 ? "+" : ""}${pct(delta, 0)}). [[${c.obsId}]]`);
  }
  for (const f of closed.examples) lines.push(`- Changed: ${f.fromName} no longer ${verb(f.type)} ${f.toName}.`);
  for (const r of learned) lines.push(`- Your team learned: ${r.text} [[${r.id}]]`);
  if (kpi.decided30d) {
    lines.push(`- Drafts you approved as they were: ${fmt(kpi.firstPass30d)} of ${fmt(kpi.decided30d)} in the last 30 days (${pct(kpi.firstPassRate ?? 0, 0)}). Things your team learned from your edits: ${fmt(kpi.learnedRules)}.`);
  }
  lines.push("", "What we noticed");
  if (top.length) top.forEach((r, i) => lines.push(`${i + 1}. ${r.title}${r.by ? ` (${plainWho(r.by)})` : ""}. [[${r.id}]]`));
  else lines.push("- Nothing new to flag today.");
  if (onCall.length) {
    lines.push("", "On call");
    const shown = onCall.length <= 4 ? onCall : onCall.slice(0, 3); // never "1 more": show four whole, else three and a count
    for (const r of shown) lines.push(`- ${clip(r.title, 110).replace(/[.:]$/, "")}${r.by ? ` (${plainWho(r.by)})` : ""}. [[${r.id}]]`);
    if (onCall.length > shown.length) lines.push(`- ${plural(onCall.length - shown.length, "more thing")} to look at.`);
  }
  lines.push("", "Waiting for your OK");
  if (pending.count) {
    lines.push(`- ${plural(pending.count, "thing is", "things are")} waiting for your OK${pending.oldestDays ? `; the oldest has waited ${plural(pending.oldestDays, "day")}` : ""}${pending.overdue ? ` (${fmt(pending.overdue)} over 2 days)` : ""}.`);
    for (const c of pending.cards) lines.push(`- ${clip(c.title, 90)} (${kindText(c.kind)}). [[${c.id}]]`);
  } else {
    lines.push("- Nothing.");
  }
  const firstCard = pending.cards[0];
  const atRisk = goals.find((x) => x.status === "at_risk" || x.status === "off_track");
  const urgent = onCall.find((r) => r.score >= 0.8);
  const next = urgent ? `Look at this first: ${clip(urgent.title, 80).replace(/[.:]$/, "")}. [[${urgent.id}]]`
    : standup?.waiting?.[0] ? `Say OK to the biggest fix first: ${clip(standup.waiting[0].title, 80).replace(/[.:]$/, "")}. [[${standup.waiting[0].approvalId}]]`
    : drafted[0] ? `Say OK or change what your team drafted: ${clip(drafted[0].title, 80).replace(/[.:]$/, "")}. [[${drafted[0].approvalId}]]`
    : firstCard ? `Say OK or edit: ${clip(firstCard.title, 80).replace(/[.:]$/, "")}. [[${firstCard.id}]]`
    : top[0] ? `Take a look: ${clip(top[0].title, 80).replace(/[.:]$/, "")}. [[${top[0].id}]]`
    : atRisk ? `Ask your team how to get "${atRisk.name}" going again. [[${atRisk.id}]]`
    : "Nothing needs you today.";
  lines.push("", "Next step", `- ${next}`);
  let text = lines.join("\n");

  let polished: boolean | undefined;
  if (opts.llm) {
    const runner = opts.runner ?? new AgentSdkRunner({ concurrency: 1, retries: 0 });
    const r = await polishText(runner, { text, instruction: "Tighten this note. Keep its sections, order and line breaks; shorten lines, do not merge or drop any. Keep the plain words as they are: never write baseline, approval, recommendation or on track." });
    text = r.text;
    polished = r.polished;
  }
  // the standing last pass (no model): chatbot wrappers, dashes and curly quotes out; nothing the note relies on moves
  { const h = await humanPass(text, { skipModel: true }); text = h.text; }

  // ---- save ----
  const title = `Today's note, ${shortDate(date)}`;
  const mentions = [...new Set([
    ...(biz ? [biz] : []), ...goals.map((x) => x.id), ...goals.flatMap((x) => (x.obsId ? [x.obsId] : [])), ...changes.map((c) => c.obsId),
    ...learned.map((r) => r.id), ...top.map((r) => r.id), ...(onCall.length <= 4 ? onCall : onCall.slice(0, 3)).map((r) => r.id), ...pending.cards.map((c) => c.id),
    ...(standup ? [standup.id] : []), ...drafted.map((d) => d.approvalId!), ...(standup?.waiting ?? []).map((w) => w.approvalId),
  ])];
  const present = await existingIds(g, mentions);
  const agent = await ensureAgentNode(g, "chief-of-staff", now);
  await upsertNode(g, {
    type: "Document", id, name: title, summary: next.replace(/\s*\[\[[^\]]+\]\]/g, ""),
    props: { kind: "brief", title, text, date, generatedAt: now, since, tenant },
    asOf: date,
  }, now);
  await upsertEdge(g, { from: agent, type: "PRODUCED", to: id }, now);
  const had = await g.roQuery<{ id: string }>("MATCH (:Entity:Document {id:$id})-[m:MENTIONS]->(x:Entity) WHERE m.until IS NULL RETURN x.id AS id", { id });
  for (const m of mentions) if (present.has(m)) await upsertEdge(g, { from: id, type: "MENTIONS", to: m }, now);
  for (const h of had) if (!mentions.includes(h.id)) await closeEdge(g, id, "MENTIONS", h.id, now, "not in this brief");

  // Goal status is part of the pulse: a change is written back (Goal.status is TRACKED, so the old one is a Version).
  const stored = await g.roQuery<{ id: string; name: string; status: string | null }>(
    "MATCH (gl:Entity:Goal) WHERE gl.id IN $ids RETURN gl.id AS id, gl.name AS name, gl.status AS status", { ids: goals.map((x) => x.id) });
  for (const p of goals) {
    const s = stored.find((x) => x.id === p.id);
    if (s && p.status !== "no_data" && s.status !== p.status) await upsertNode(g, { type: "Goal", id: p.id, name: s.name, props: { status: p.status } }, now);
  }

  const brief: Brief = {
    id, title, text, date, since, goals, newObservations, changes, closed, learned, learning: kpi, newRecommendations: nr?.n ?? 0, top, onCall, pending,
    next, mentions: mentions.filter((m) => present.has(m)), ...(polished !== undefined ? { polished } : {}),
  };
  if (opts.publish) {
    const where = await opts.publish(brief);
    if (where) brief.published = where;
  }
  return brief;
}
