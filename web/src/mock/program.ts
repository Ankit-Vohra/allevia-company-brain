// Mock Allevia 90, capability ladder, team settings and learning feed (product design §2.3–2.4, §3.3, §8), in the API's
// own shapes. Aamdani is three weeks into its program: a first-pass curve that climbs, six rules learned from the
// owner's edits, goals against a day-0 baseline (one of them unknown, because nothing was connected on day 0). AVS
// Atelier was set up today: day 0, every baseline unknown. Dates are relative to today so the demo never goes stale.
import type {
  AccessMode, AgentId, AgentMode, AgentSettings, CapabilityKey, CapabilityState, CapabilityStatus, DirectiveDiffLine,
  DirectivePatch, DirectivePreview, FirstPassPoint, LearnedRuleDto, ProgramGoal, ProgramScorecard,
} from "@shared/contracts";
import { AGENTS, agentById } from "@shared/roster";
import type { Approval, GoalSetup, Usage, UsageItem } from "../types-ext";
import type { MockGraph } from "./graph-kit";

const DAY = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const todayMs = () => Date.parse(`${isoDay(Date.now())}T00:00:00Z`);
const dayAt = (offset: number) => isoDay(todayMs() + offset * DAY);
/** An ISO timestamp `offset` days from today at hh:mm UTC. */
const at = (offset: number, hh = 4, mm = 0) => new Date(todayMs() + offset * DAY + (hh * 60 + mm) * 60_000).toISOString();

const shortDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

// ---------------------------------------------------------------- learned rules and the edits they came from

interface MockRule extends LearnedRuleDto { learnedDay: number }

/** The drafts the owner edited before approving: each taught one or two rules. */
export function editedApprovals(): Approval[] {
  return [
    {
      id: "appr:reels-wk39", kind: "content_draft", status: "executed", by: "content-strategist", title: "Two salary-reveal reels for week 39",
      createdAt: at(-19, 3), decidedAt: at(-19, 6, 40), result: "Draft saved to the reel pipeline (not published)",
      payload: {
        title: "2 reels · week 39", target: "Reel pipeline (draft only, never publishes)",
        body: "1. \"What a security guard's package really is\": open on the payslip, then the gate at 6 am.\n2. \"Candidates ask us: is the salary real?\": a driver reads his offer letter aloud.",
      },
      editedPayload: {
        title: "2 reels · week 39", target: "Reel pipeline (draft only, never publishes)",
        body: "1. \"What a security guard's salary really is\": open on the payslip, then the gate at 6 am.\n2. \"Job seekers ask us: is the salary real?\": a driver reads his offer letter aloud.",
      },
    },
    {
      id: "appr:caption-wk40", kind: "content_draft", status: "executed", by: "copy-editor", title: "Caption for the forklift reel",
      createdAt: at(-14, 3), decidedAt: at(-14, 5, 10), result: "Draft saved to the reel pipeline (not published)",
      payload: { title: "Caption · forklift reel", target: "Instagram caption (draft)", body: "₹18,000 + PF, every month, on time! 🚜💸 Real jobs, real pay. Apply in 2 minutes by talking! 🎙️" },
      editedPayload: { title: "Caption · forklift reel", target: "Instagram caption (draft)", body: "₹18,000 + PF, every month, on time. Real jobs, real pay. Apply in 2 minutes by talking." },
    },
    {
      id: "appr:gh-job-titles", kind: "github_issue", status: "executed", by: "tech-lead", title: "Job page titles: city before role",
      createdAt: at(-9, 9), decidedAt: at(-8, 4, 25), result: "Opened issue #96 in Ankit-Vohra/allevia",
      payload: { title: "SEO: job page titles", target: "Ankit-Vohra/allevia · label allevia-action", body: "Title template: \"{Role} vacancy · {City} · Aamdani\"." },
      editedPayload: { title: "SEO: job page titles", target: "Ankit-Vohra/allevia · label allevia-action", body: "Title template: \"{City}: {Role} jobs, ₹{min}–{max} a month · Aamdani\". Put the city first: that is what people search." },
    },
    {
      id: "appr:reel-script-wk41", kind: "content_draft", status: "executed", by: "content-strategist", title: "Reel script: a day with the screening call",
      createdAt: at(-2, 3), decidedAt: at(-1, 5, 5), result: "Draft saved to the reel pipeline (not published)",
      payload: {
        title: "Reel script · screening call", target: "Reel pipeline (draft only, never publishes)",
        body: "Hook: an employer in Raipur needs 4 drivers by Friday. We follow the posting from the moment it goes live, through the AI screening calls that happen while she runs her depot, to the shortlist that lands on her phone at 6 pm with notes on licence, route knowledge and availability, and the two candidates she calls first the next morning.",
      },
      editedPayload: {
        title: "Reel script · screening call", target: "Reel pipeline (draft only, never publishes)",
        body: "Hook: an employer in Raipur needs 4 drivers by Friday. The AI screening calls run while she works. At 6 pm the shortlist lands on her phone. Next morning she calls two.",
      },
    },
  ];
}

const RULES_AAMDANI = (): MockRule[] => [
  { id: "rule:learned-say-job-seekers-not-candidates", text: "Say \"job seekers\", not \"candidates\".", op: "replace", status: "active", confidence: 0.85, appliedCount: 11, learnedDay: -19, learnedAt: null, retiredAt: null, fromApprovalIds: ["appr:reels-wk39"], agents: ["content-strategist"] },
  { id: "rule:learned-say-salary-not-package", text: "Say \"salary\", not \"package\".", op: "replace", status: "active", confidence: 0.75, appliedCount: 7, learnedDay: -19, learnedAt: null, retiredAt: null, fromApprovalIds: ["appr:reels-wk39"], agents: ["content-strategist"] },
  { id: "rule:learned-no-emoji", text: "No emojis.", op: "remove_emoji", status: "active", confidence: 0.7, appliedCount: 6, learnedDay: -14, learnedAt: null, retiredAt: null, fromApprovalIds: ["appr:caption-wk40"], agents: ["copy-editor"] },
  { id: "rule:learned-no-exclaim", text: "No exclamation marks.", op: "no_exclaim", status: "active", confidence: 0.6, appliedCount: 6, learnedDay: -14, learnedAt: null, retiredAt: null, fromApprovalIds: ["appr:caption-wk40"], agents: ["copy-editor"] },
  { id: "rule:learned-say-vacancy-not-jobs", text: "Say \"vacancy\", not \"jobs\".", op: "replace", status: "retired", confidence: 0.5, appliedCount: 1, learnedDay: -12, learnedAt: null, retiredAt: at(-8, 4, 25), fromApprovalIds: [], agents: ["tech-lead"] },
  { id: "rule:learned-city-first", text: "Put the city first in job page titles.", op: "instruction", status: "active", confidence: 0.6, appliedCount: 2, learnedDay: -8, learnedAt: null, retiredAt: null, fromApprovalIds: ["appr:gh-job-titles"], agents: ["tech-lead"] },
  { id: "rule:learned-max-words-60", text: "Keep reel scripts under 60 words.", op: "max_words", status: "active", confidence: 0.5, appliedCount: 0, learnedDay: -1, learnedAt: null, retiredAt: null, fromApprovalIds: ["appr:reel-script-wk41"], agents: ["content-strategist"] },
];

const rules: Record<string, MockRule[]> = {
  aamdani: RULES_AAMDANI().map((r) => ({ ...r, learnedAt: at(r.learnedDay, 6) })),
  "avs-atelier": [],
};
const rulesOf = (t: string) => (rules[t] ??= []);

/** Rule, approval, action and draft nodes for the mock graph, so a Library book opens its LEARNED_FROM path. */
export function addLearningToGraph(g: MockGraph, tenant: string, approvals: Approval[]) {
  const node = (id: string, label: string, name: string, extra: Record<string, unknown> = {}) => {
    if (!g.nodes.has(id)) g.nodes.set(id, { id, label, name, community: label === "Rule" ? 4 : 7, rank: 0.2, ...extra });
  };
  const edge = (from: string, type: string, to: string, since?: string) => {
    if (!g.edges.some((e) => e.from === from && e.type === type && e.to === to)) g.edges.push({ from, type, to, since: since ? Date.parse(since) : undefined, until: null });
  };
  for (const a of approvals.filter((x) => x.editedPayload)) {
    node(a.id, "Approval", `${a.kind}: ${a.payload.title}`, { asOf: a.decidedAt?.slice(0, 10), summary: "Approved with the owner's edits.", props: { status: a.status, firstPass: false } });
    const action = a.id.replace(/^appr:/, "action:");
    const draft = a.id.replace(/^appr:/, "content:draft-");
    node(action, "Action", `${a.kind}: ${a.editedPayload!.title}`, { asOf: a.decidedAt?.slice(0, 10) });
    node(draft, "Content", a.editedPayload!.title, { asOf: a.decidedAt?.slice(0, 10), summary: a.editedPayload!.body.slice(0, 200), props: { status: "draft" } });
    edge(a.id, "RESULTED_IN", action, a.decidedAt);
    edge(action, "RESULTED_IN", draft, a.decidedAt);
    edge(`agent:${a.by}`, "PRODUCED", draft, a.decidedAt);
    node(`agent:${a.by}`, "Agent", `${agentById(a.by)?.name ?? a.by} · ${agentById(a.by)?.title ?? ""}`, { props: { kind: "allevia" } });
  }
  // the drafts written since, which applied the rules (USES_RULE): the compounding half of the story
  const later = tenant === "aamdani" ? "content:draft-reels-wk42" : undefined;
  if (later) node(later, "Content", "3 reels · week 42 (draft)", { asOf: dayAt(-1), props: { status: "awaiting approval" } });
  for (const r of rulesOf(tenant)) {
    node(r.id, "Rule", r.text, { summary: `Learned from the owner's edit (${r.fromApprovalIds.join(", ") || "approval since closed"}).`, props: { kind: "learned", op: r.op, status: r.status, confidence: r.confidence, appliedCount: r.appliedCount } });
    for (const a of r.fromApprovalIds) edge(r.id, "LEARNED_FROM", a, r.learnedAt ?? undefined);
    for (const ag of r.agents) {
      node(`agent:${ag}`, "Agent", `${agentById(ag)?.name ?? ag} · ${agentById(ag)?.title ?? ""}`, { props: { kind: "allevia" } });
      edge(r.id, "APPLIES_TO", `agent:${ag}`, r.learnedAt ?? undefined);
    }
    if (later && r.status === "active" && r.agents.includes("content-strategist")) edge(later, "USES_RULE", r.id, at(-1));
  }
}

export function learningFeed(t: string) {
  const list = rulesOf(t);
  const p = programs[t];
  const fp = p?.firstPass;
  return {
    since: new Date(0).toISOString(),
    firstPass: { rate: fp?.rate ?? null, decided30d: fp?.decided30d ?? 0, firstPass30d: fp?.firstPass30d ?? 0 },
    active: list.filter((r) => r.status === "active").length,
    rules: [...list].sort((a, b) => (b.learnedAt ?? "").localeCompare(a.learnedAt ?? "")).map(({ learnedDay: _d, ...r }) => r),
  };
}

export function retireRule(t: string, id: string): LearnedRuleDto {
  const r = rulesOf(t).find((x) => x.id === id);
  if (!r) throw new Error("No such learned rule.");
  if (r.status !== "retired") { r.status = "retired"; r.retiredAt = new Date().toISOString(); }
  syncProgramRules(t);
  const { learnedDay: _d, ...dto } = r;
  return dto;
}

/** A crude version of src/actions/learning.ts extractRules, enough for the demo: a swapped word, emojis or "!" cut, or a shorter draft. */
export function learnFromEdit(t: string, a: Approval, edited: { title: string; body: string }): Array<{ ruleId: string; text: string }> {
  const before = `${a.payload.title}\n${a.payload.body}`;
  const after = `${edited.title}\n${edited.body}`;
  const specs: Array<{ id: string; text: string; op: string }> = [];
  const EMOJI = /\p{Extended_Pictographic}/u;
  if (EMOJI.test(before) && !EMOJI.test(after)) specs.push({ id: "rule:learned-no-emoji", text: "No emojis.", op: "remove_emoji" });
  if (before.includes("!") && !after.includes("!")) specs.push({ id: "rule:learned-no-exclaim", text: "No exclamation marks.", op: "no_exclaim" });
  const w1 = before.split(/\s+/), w2 = after.split(/\s+/);
  let i = 0;
  while (i < w1.length && i < w2.length && w1[i] === w2[i]) i++;
  let j1 = w1.length - 1, j2 = w2.length - 1;
  while (j1 >= i && j2 >= i && w1[j1] === w2[j2]) { j1--; j2--; }
  const del = w1.slice(i, j1 + 1).join(" ").replace(/[^\p{L}\p{N}\s'-]/gu, "").trim();
  const ins = w2.slice(i, j2 + 1).join(" ").replace(/[^\p{L}\p{N}\s'-]/gu, "").trim();
  if (del && ins && del.split(" ").length <= 3 && ins.split(" ").length <= 3 && del.toLowerCase() !== ins.toLowerCase()) {
    specs.push({ id: `rule:learned-say-${ins.toLowerCase().replace(/\W+/g, "-")}-not-${del.toLowerCase().replace(/\W+/g, "-")}`, text: `Say "${ins}", not "${del}".`, op: "replace" });
  } else if (!specs.length && after.length < before.length * 0.7) {
    specs.push({ id: `rule:learned-shorter-${a.kind}`, text: "Keep drafts like this one shorter.", op: "max_words" });
  }
  const list = rulesOf(t);
  const now = new Date().toISOString();
  for (const s of specs) {
    const old = list.find((r) => r.id === s.id);
    if (old) { old.confidence = Math.min(0.95, Math.round((old.confidence + 0.1) * 100) / 100); old.status = "active"; old.learnedAt = now; old.fromApprovalIds = [...new Set([...old.fromApprovalIds, a.id])]; }
    else list.push({ id: s.id, text: s.text, op: s.op, status: "active", confidence: 0.5, appliedCount: 0, learnedDay: 0, learnedAt: now, retiredAt: null, fromApprovalIds: [a.id], agents: [a.by] });
  }
  syncProgramRules(t);
  return specs.map((s) => ({ ruleId: s.id, text: s.text }));
}

// ---------------------------------------------------------------- the capability ladder

const cap = (key: CapabilityKey, name: string, accessMode: AccessMode, status: CapabilityStatus, upgradeHint: string, dependsOn: string[], lastOk?: number): CapabilityState => ({
  id: `capability:${key.replace(/_/g, "-")}`, key, name, accessMode, status, lastOkAt: lastOk === undefined ? null : todayMs() + lastOk * DAY, upgradeHint, dependsOn,
});

const NOTHING = "Connected and current. Nothing to do.";
const CAPS: Record<string, CapabilityState[]> = {
  aamdani: [
    cap("ga4", "Website analytics (GA4)", "api", "ok", NOTHING, ["system:ga4"], -1),
    cap("search_console", "Google Search Console", "api", "ok", NOTHING, ["channel:google-search", "system:search-console"], -2),
    cap("gbp", "Google Business Profile", "none", "not_connected", "Not connected yet. Add Allevia's ops account as a Manager on your Google Business Profile to read views, calls and direction requests.", []),
    cap("instagram_insights", "Instagram insights", "api", "ok", NOTHING, ["channel:instagram", "system:instagram"], -1),
    cap("reviews", "Reviews", "public", "not_connected", "Reading your public reviews only. Add Allevia's ops account as a Manager on your Google Business Profile so we can draft replies.", []),
    cap("studio", "Studio (photo and video)", "api", "ok", NOTHING, ["system:higgsfield"], -1),
    cap("ads", "Ads", "benchmark", "not_connected", "Using industry benchmarks, not your own numbers. Share your Meta or Google Ads account with Allevia so we use your real spend and results instead.", ["channel:meta-ads"]),
  ],
  "avs-atelier": [
    cap("ga4", "Website analytics (GA4)", "none", "not_connected", "Not connected yet. Add Allevia's ops account as a Viewer on your GA4 property.", []),
    cap("search_console", "Google Search Console", "api", "ok", NOTHING, ["channel:google-search", "system:search-console"], -1),
    cap("gbp", "Google Business Profile", "public", "not_connected", "Reading your public listing only. Add Allevia's ops account as a Manager on your Google Business Profile to read calls and direction requests.", []),
    cap("instagram_insights", "Instagram insights", "public", "not_connected", "Reading your public profile only. Connect Instagram so we read reach and saves, not just likes.", ["channel:instagram"]),
    cap("reviews", "Reviews", "public", "not_connected", "Reading your public reviews only. Connect your Google Business Profile so we can draft replies.", []),
    cap("studio", "Studio (photo and video)", "api", "ok", NOTHING, ["system:higgsfield"], 0),
    cap("ads", "Ads", "benchmark", "not_connected", "Using industry benchmarks, not your own numbers. Share your Google Ads account with Allevia so we use your real spend.", ["channel:google-ads"]),
  ],
};
export const capabilitiesOf = (t: string): CapabilityState[] => CAPS[t] ?? CAPS["avs-atelier"]!;

// ---------------------------------------------------------------- Allevia 90

function goal(g: Omit<ProgramGoal, "currentAt" | "baselineAt" | "dueAt"> & { started: number }): ProgramGoal {
  const { started, ...rest } = g;
  return { ...rest, baselineAt: rest.baseline === null ? null : dayAt(started - 1), currentAt: rest.current === null ? null : dayAt(-1), dueAt: dayAt(started + 90) };
}

function series(start: number, days: number): FirstPassPoint[] {
  const out: FirstPassPoint[] = [];
  for (let d = 0; d <= days; d++) {
    const decided = d < 3 ? 0 : Math.min(30, Math.round(1 + d * 1.1));
    const wobble = Math.sin(d * 1.7) * 0.035 + Math.cos(d * 0.9) * 0.02;
    const rate = decided === 0 ? null : Math.round(Math.min(0.9, 0.16 + 0.44 * Math.pow((d - 2) / Math.max(1, days - 2), 0.75) + wobble) * 1000) / 1000;
    out.push({ date: dayAt(start + d), rate, decided, firstPass: rate === null ? 0 : Math.round(rate * decided) });
  }
  return out;
}

function makeProgram(t: string): ProgramScorecard | null {
  const startOffset = t === "aamdani" ? -23 : 0;
  const day = -startOffset;
  const s = startOffset;
  const fp = t === "aamdani" ? series(s, day) : [{ date: dayAt(0), rate: null, decided: 0, firstPass: 0 }];
  const last = fp[fp.length - 1]!;
  const checkpoint = (d: 0 | 30 | 60 | 90) => ({
    day: d, dueDate: dayAt(s + d), status: (d <= day ? "done" : "upcoming") as "done" | "upcoming",
    ...(d === 0 ? { id: `checkpoint:allevia90-${t}-day-0`, at: at(s, 5), summary: "Day 0 of Allevia 90: goals set and baselines locked from the data on hand." } : {}),
  });
  const goals: ProgramGoal[] = t === "aamdani"
    ? [
      goal({ id: "goal:weekly-signups", name: "Weekly signups", metricKey: "new_accounts", unit: "signups", period: "week", owner: { id: "growth-marketer", name: "Rohan" }, baseline: 264, baselineConf: "measured", target: 360, targetBasis: "baseline", current: 312, progress: 0.5, status: "on_track", started: s }),
      goal({ id: "goal:instagram-reach", name: "Instagram reach", metricKey: "account_reach", unit: "accounts", period: "month", owner: { id: "content-strategist", name: "Tara" }, baseline: 52_400, baselineConf: "measured", target: 78_600, targetBasis: "baseline", current: 61_900, progress: 0.36, status: "on_track", started: s }),
      goal({ id: "goal:search-clicks", name: "Search clicks", metricKey: "gsc_clicks", unit: "clicks", period: "month", owner: { id: "data-analyst", name: "Kabir" }, baseline: 9_800, baselineConf: "measured", target: 12_700, targetBasis: "baseline", current: 10_100, progress: 0.1, status: "at_risk", started: s }),
      goal({ id: "goal:gbp-calls", name: "Calls from Google", metricKey: "gbp_calls", unit: "calls", period: "month", owner: { id: "ops-manager", name: "Vikram" }, baseline: null, baselineConf: "unknown", target: 30, targetBasis: "template", current: null, progress: null, status: "no_data", started: s }),
    ]
    : [
      goal({ id: "goal:qualified-enquiries", name: "Qualified enquiries per month", metricKey: "enquiries", unit: "enquiries", period: "month", owner: { id: "growth-marketer", name: "Rohan" }, baseline: null, baselineConf: "unknown", target: 8, targetBasis: "template", current: null, progress: null, status: "no_data", started: s }),
      goal({ id: "goal:instagram-reach", name: "Instagram reach", metricKey: "account_reach", unit: "accounts", period: "month", owner: { id: "content-strategist", name: "Tara" }, baseline: null, baselineConf: "unknown", target: 1000, targetBasis: "template", current: null, progress: null, status: "no_data", started: s }),
      goal({ id: "goal:search-clicks", name: "Search clicks", metricKey: "gsc_clicks", unit: "clicks", period: "month", owner: { id: "data-analyst", name: "Kabir" }, baseline: null, baselineConf: "unknown", target: 50, targetBasis: "template", current: null, progress: null, status: "no_data", started: s }),
    ];
  const caps = capabilitiesOf(t);
  const byMode = { api: 0, delegated: 0, upload: 0, public: 0, benchmark: 0, none: 0 } as Record<AccessMode, number>;
  for (const c of caps) byMode[c.accessMode]++;
  return {
    id: `program:allevia90-${t}`, kind: "allevia90", status: "active", day, daysLeft: 90 - day,
    startDate: dayAt(s), endDate: dayAt(s + 90), today: dayAt(0), timeZone: "Asia/Kolkata",
    templateKey: t === "aamdani" ? "jobs_platform" : "architecture_studio",
    checkpoints: [checkpoint(0), checkpoint(30), checkpoint(60), checkpoint(90)],
    firstPass: {
      rate: last.rate, decided30d: last.decided, firstPass30d: last.firstPass, series: fp,
    },
    learnedRules: { active: 0, learnedSinceStart: 0, retired: 0, recent: [] },
    goals,
    capabilities: { byMode, items: caps.map(({ key, name, accessMode, status }) => ({ key, name, accessMode, status })) },
    deliverables: t === "aamdani"
      ? { approved: 21, approvedSinceStart: 21, editedSinceStart: 9, rejectedSinceStart: 2, pending: 3 }
      : { approved: 0, approvedSinceStart: 0, editedSinceStart: 0, rejectedSinceStart: 0, pending: 2 },
  };
}

const programs: Record<string, ProgramScorecard | null> = { aamdani: makeProgram("aamdani"), "avs-atelier": makeProgram("avs-atelier") };

function syncProgramRules(t: string) {
  const p = programs[t];
  if (!p) return;
  const list = rulesOf(t);
  const active = list.filter((r) => r.status === "active");
  p.learnedRules = {
    active: active.length,
    learnedSinceStart: list.length,
    retired: list.filter((r) => r.status === "retired").length,
    recent: [...active].sort((a, b) => (b.learnedAt ?? "").localeCompare(a.learnedAt ?? "")).slice(0, 5).map((r) => ({ id: r.id, text: r.text, learnedAt: r.learnedAt })),
  };
}
syncProgramRules("aamdani");
syncProgramRules("avs-atelier");

/** null for a business set up in this session: not in Allevia 90 yet (the API answers 404). */
export const programOf = (t: string): ProgramScorecard | null => programs[t] ?? null;

// ---------------------------------------------------------------- the goals the team suggests (GET /api/:t/goals/setup)

// Aamdani said OK to its goals three weeks ago; AVS Atelier was set up today, so its three are waiting for an OK.
const confirmedGoals: Record<string, Set<string>> = {
  aamdani: new Set(programs.aamdani?.goals.map((g) => g.id) ?? []),
  "avs-atelier": new Set(),
};

export function goalSetupOf(t: string): GoalSetup[] {
  return (programs[t]?.goals ?? []).map((g) => ({
    id: g.id, name: g.name, unit: g.unit, period: g.period, baseline: g.baseline, target: g.target, why: null, confirmed: confirmedGoals[t]?.has(g.id) ?? false,
  }));
}

/** OK (no target) or OK with the owner's own number, as POST /api/:t/goals/:id does. */
export function setGoal(t: string, id: string, target?: number): GoalSetup {
  const g = programs[t]?.goals.find((x) => x.id === id);
  if (!g) throw new Error("No such goal in your growth plan.");
  if (target !== undefined) g.target = target;
  (confirmedGoals[t] ??= new Set()).add(id);
  return goalSetupOf(t).find((x) => x.id === id)!;
}

// ---------------------------------------------------------------- this month's usage (GET /api/:t/usage)

/** Aamdani approved a few Studio posts this month; AVS Atelier was set up today and has spent nothing yet. */
export function usageOf(t: string, month = isoDay(Date.now()).slice(0, 7)): Usage {
  const thisMonth = month === isoDay(Date.now()).slice(0, 7);
  const items: UsageItem[] = t === "aamdani" && thisMonth
    ? [
      { subject: "content:post-guard-payslip", name: "Post: a guard's payslip, explained", credits: 1, date: dayAt(-1) },
      { subject: "content:carousel-raipur-jobs", name: "Carousel: five jobs hiring in Raipur", credits: 2, date: dayAt(-4) },
      { subject: "content:post-driver-offer", name: "Post: a driver reads his offer letter", credits: 1, date: dayAt(-6) },
      { subject: "content:reel-salary-real", name: "Reel: is the salary real?", credits: 4, date: dayAt(-9) },
    ].filter((i) => i.date.startsWith(month))
    : [];
  const used = items.reduce((s, i) => s + i.credits, 0);
  return {
    month, credits: { used, items }, costUsd: Math.round(items.length * 0.5 * 100) / 100,
    answers: t === "aamdani" && thisMonth ? 37 : 0, actionsLive: false, billingConnected: false,
  };
}

// ---------------------------------------------------------------- today's note, as src/insights/brief.ts writes it

export function briefText(t: string, name: string): string {
  const p = programs[t];
  const date = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Kolkata" });
  if (!p) return `Today's note, ${name}, ${date}

Your goals
- No goals set yet. Pick two or three when you set up and they show here.

Next step
- Ask your team what to fix first.`;
  const fmt = (n: number) => n.toLocaleString("en-GB");
  const goalLine = (g: ProgramGoal) => {
    const goalText = g.target !== null ? `Goal: ${fmt(g.target)} by ${shortDate(g.dueAt!)}.` : "No goal number set yet.";
    if (g.current === null) return `- ${g.name}: We'll know after your first full week. ${goalText} [[${g.id}]]`;
    const status = { achieved: "Going well", on_track: "Going well", at_risk: "Needs a push", off_track: "Behind", no_data: "We'll know after your first full week" }[g.status];
    const why = g.status === "at_risk" && g.progress !== null ? `: ${Math.round(g.progress * 100)}% of the way there, ${Math.round((p.day / 90) * 100)}% of the time used` : "";
    return `- ${g.name}: ${fmt(g.current)} now${g.baseline !== null ? `, you started at ${fmt(g.baseline)}` : ""}. ${goalText} ${status}${why}. [[${g.id}]]`;
  };
  if (t !== "aamdani") {
    return [
      `Today's note, ${name}, ${date}`, "", "Your goals", ...p.goals.map(goalLine), "",
      "What changed since yesterday", "- 46 new numbers came in and 3 new ideas.", "",
      "What we noticed", "1. Home page: title, main heading and local business details (Rohan). [[rec:avs-home-seo]]", "2. Verify the Google Business Profile (Vikram). [[rec:avs-gbp]]", "",
      "Waiting for your OK", "- 2 things are waiting for your OK.", "", "Next step", "- Say OK or edit: Home page: title, main heading and local business details. [[appr:avs-gh-home-seo]]",
    ].join("\n");
  }
  const newest = rulesOf(t).filter((r) => r.status === "active").sort((a, b) => (b.learnedAt ?? "").localeCompare(a.learnedAt ?? ""))[0];
  return [
    `Today's note, ${name}, ${date}`, "", "Your goals", ...p.goals.map(goalLine), "",
    "What changed since yesterday",
    "- 214 new numbers came in and 3 new ideas.",
    "- Signups, Aamdani: 288 -> 312 (+8%). [[observation:signups-wk41]]",
    ...(newest ? [`- Your team learned: ${newest.text} [[${newest.id}]]`] : []),
    `- Drafts you approved as they were: ${p.firstPass.firstPass30d} of ${p.firstPass.decided30d} in the last 30 days (${Math.round((p.firstPass.rate ?? 0) * 100)}%). Things your team learned from your edits: ${p.learnedRules.active}.`,
    "", "What we noticed",
    "1. Make salary-reveal reels the weekly anchor (Tara). [[rec:salary-reveal-reels]]",
    "2. Unique titles and descriptions for 38 job pages (Arjun). [[rec:jobs-meta]]",
    "3. Add a missed-call fallback to the sign-up code step (Kabir). [[rec:otp-fallback]]",
    "", "On call",
    "- Checkout errors have doubled since Tuesday's update (Zoya).",
    "- Version 4.2 is waiting for review on the Play Store (Imran).",
    "", "Waiting for your OK", "- 3 things are waiting for your OK; the oldest has waited 3 days.",
    "- Draft 3 reels: two salary reveals and a day with the screening call (a post draft). [[appr:content-3-reels]]",
    "", "Next step", "- Say OK or edit: Draft 3 reels: two salary reveals and a day with the screening call. [[appr:content-3-reels]]",
  ].join("\n");
}

// ---------------------------------------------------------------- team settings

interface Settings { enabled: boolean; mode: AgentMode; autonomy: number; statusNote?: string; skillsOff?: string[]; instructions: AgentSettings["instructions"] }
const team: Record<string, Record<string, Settings>> = {};

function settingsOf(t: string): Record<string, Settings> {
  if (team[t]) return team[t]!;
  const s: Record<string, Settings> = {};
  for (const a of AGENTS) s[a.id] = { enabled: true, mode: "full", autonomy: 0, instructions: [] };
  if (t === "aamdani") {
    s["content-strategist"]!.autonomy = 1;
    s["content-strategist"]!.instructions.push({ id: "memory:instruction-salary-first", text: "Open every reel on the salary figure.", channel: "Instagram", at: todayMs() - 20 * DAY });
    s["growth-marketer"]!.instructions.push({ id: "memory:instruction-spend-cap", text: "Never spend above ₹2,000 a day on ads.", at: todayMs() - 16 * DAY });
    s["ops-manager"]!.mode = "light";
    s["ops-manager"]!.statusNote = "weekly round-up only";
  }
  return (team[t] = s);
}

export function teamOf(t: string): AgentSettings[] {
  const s = settingsOf(t);
  return AGENTS.map((a) => ({
    id: a.id, nodeId: `agent:allevia-${a.id}`, name: a.name, title: a.title, department: a.department,
    enabled: s[a.id]!.enabled, mode: s[a.id]!.mode, autonomy: s[a.id]!.autonomy,
    ...(s[a.id]!.statusNote ? { statusNote: s[a.id]!.statusNote } : {}), ...(s[a.id]!.skillsOff?.length ? { skillsOff: [...s[a.id]!.skillsOff!] } : {}),
    instructions: [...s[a.id]!.instructions],
  }));
}

export function activeRulesFor(t: string, agent: AgentId) {
  return rulesOf(t).filter((r) => r.status === "active" && r.agents.includes(agent))
    .map(({ id, text, confidence, appliedCount, learnedAt }) => ({ id, text, confidence, appliedCount, learnedAt }));
}

const CHIEF_REFUSAL = "Meera can't be switched off: the Chief of Staff plans every request and writes every answer.";

export function setAgent(t: string, id: string, patch: { enabled?: boolean; mode?: AgentMode; autonomy?: number; statusNote?: string | null; skillsOff?: string[] }) {
  const s = settingsOf(t)[id];
  if (!s) throw new Error("No such agent on the team.");
  if (id === "chief-of-staff" && (patch.enabled === false || patch.mode === "off")) throw new Error(CHIEF_REFUSAL);
  if (patch.mode !== undefined) { s.mode = patch.mode; s.enabled = patch.mode !== "off"; }
  if (patch.enabled !== undefined) { s.enabled = patch.enabled; if (!s.enabled) s.mode = "off"; else if (s.mode === "off") s.mode = "full"; }
  if (patch.autonomy !== undefined) s.autonomy = patch.autonomy;
  if (patch.skillsOff !== undefined) { if (patch.skillsOff.length) s.skillsOff = [...new Set(patch.skillsOff)]; else delete s.skillsOff; }
  if (patch.statusNote !== undefined) { if (patch.statusNote) s.statusNote = patch.statusNote; else delete s.statusNote; }
}

// ---------------------------------------------------------------- "Tell your team": a small version of the rules parser

const ALIASES: Record<string, string[]> = {
  "chief-of-staff": ["chief of staff", "chief"], "coe-lead": ["coe lead", "coe"], "data-analyst": ["data analyst", "analyst"],
  "growth-marketer": ["growth marketer", "marketer"], "content-strategist": ["content strategist", "strategist"],
  "copy-editor": ["copy editor", "editor"], "fact-checker": ["fact checker"], "tech-lead": ["tech lead"],
  "ops-manager": ["ops manager"], librarian: ["librarian"],
};
const findAgent = (s: string): string | undefined => {
  const low = s.toLowerCase();
  return AGENTS.find((a) => new RegExp(`\\b${a.name.toLowerCase()}\\b`).test(low) || (ALIASES[a.id] ?? []).some((x) => low.includes(x)))?.id;
};
const CHANNELS = ["linkedin", "instagram", "facebook", "whatsapp", "youtube", "google", "x", "twitter"];
const cap1 = (s: string) => `${s.trim().replace(/[\s.!;,]+$/u, "").replace(/^./, (c) => c.toUpperCase())}.`;
const label = (id: string) => `${agentById(id)?.name} (${agentById(id)?.title})`;
const previews: Record<string, DirectivePreview & { tenant: string }> = {};
let seq = 0;

export function previewDirective(t: string, text: string): DirectivePreview {
  const patches: DirectivePatch[] = [];
  const unparsed: string[] = [];
  const notes: string[] = [];
  for (const raw of text.split(/[;\n]|\.\s+/)) {
    const clause = raw.trim();
    if (!clause) continue;
    const low = clause.toLowerCase();
    const scoped = /^(\w+),\s*(.+)$/.exec(clause);
    const scopedAgent = scoped ? findAgent(scoped[1]!) : undefined;
    const body = scopedAgent ? scoped![2]! : clause;
    const onOff = /\b(?:switch|turn|put)\s+(.+?)\s+(off|on)\b(?:\s+(?:till|until)\s+(.+))?|\b(.+?)\s+(off|on)\s+(?:till|until)\s+(.+)/i.exec(clause);
    const lightM = /\b(\w+)\s+(?:on\s+)?light\b|\blight mode for (\w+)/i.exec(clause);
    const auto = /autonomy\s+(?:to\s+|level\s+)?(?:l)?([0-3])\s+for\s+(\w+)|(\w+)\s+(?:to\s+)?(?:autonomy\s+)?l([0-3])\b/i.exec(clause);
    if (onOff) {
      const who = findAgent(onOff[1] ?? onOff[4] ?? "");
      const enabled = (onOff[2] ?? onOff[5])!.toLowerCase() === "on";
      if (!who) { unparsed.push(clause); continue; }
      if (who === "chief-of-staff" && !enabled) { notes.push(CHIEF_REFUSAL); continue; }
      const note = onOff[3] ?? onOff[6];
      patches.push({ kind: "agent.enabled", agent: who, enabled, ...(note ? { note: `till ${note.trim()}` } : {}) });
    } else if (lightM && findAgent(lightM[1] ?? lightM[2] ?? "")) {
      patches.push({ kind: "agent.mode", agent: findAgent(lightM[1] ?? lightM[2] ?? "")!, mode: "light" });
    } else if (auto && findAgent(auto[2] ?? auto[3] ?? "")) {
      patches.push({ kind: "agent.autonomy", agent: findAgent(auto[2] ?? auto[3] ?? "")!, autonomy: Number(auto[1] ?? auto[4]) });
    } else if (/^never say\b/i.test(body)) {
      patches.push({ kind: "brand_rule.add", text: cap1(body), ruleKind: "voice" });
    } else if (/^(?:no|never|always|don't|do not|avoid|use|keep)\b/i.test(body)) {
      const ch = CHANNELS.find((c) => new RegExp(`\\b(?:on|in|for)\\s+${c}\\b`, "i").test(low));
      const agents = scopedAgent ? [scopedAgent] : /spend|budget|ads?\b/.test(low) ? ["growth-marketer"] : ["content-strategist", "copy-editor"];
      patches.push({ kind: "memory.instruction", agents, text: cap1(body), ...(ch ? { channel: `channel:${ch}` } : {}) });
    } else {
      unparsed.push(clause);
    }
  }
  if (!patches.length && !unparsed.length && !notes.length) unparsed.push(text.trim());
  const s = settingsOf(t);
  const id = `document:directive-${dayAt(0)}-${(++seq).toString(16).padStart(6, "0")}`;
  const state = (x: Settings) => (!x.enabled ? "off" : x.mode === "light" ? "on (light)" : "on");
  const diff: DirectiveDiffLine[] = patches.map((p, i) => {
    switch (p.kind) {
      case "agent.enabled": return { patch: i, op: s[p.agent]!.enabled === p.enabled ? "same" : "change", target: `agent:allevia-${p.agent}`, label: label(p.agent), before: state(s[p.agent]!), after: p.enabled ? "on" : `off${p.note ? ` (${p.note})` : ""}` };
      case "agent.mode": return { patch: i, op: s[p.agent]!.mode === p.mode ? "same" : "change", target: `agent:allevia-${p.agent}`, label: `${label(p.agent)} mode`, before: s[p.agent]!.mode, after: p.mode };
      case "agent.autonomy": return { patch: i, op: s[p.agent]!.autonomy === p.autonomy ? "same" : "change", target: `agent:allevia-${p.agent}`, label: `${label(p.agent)} autonomy`, before: `L${s[p.agent]!.autonomy}`, after: `L${p.autonomy}` };
      case "memory.instruction": {
        const who = p.agents.map((a) => agentById(a)?.name).join(", ");
        const ch = p.channel ? p.channel.replace(/^channel:/, "") : undefined;
        return { patch: i, op: "add", target: `${id.replace("document:", "memory:")}-${i + 1}`, label: `Instruction for ${who}${ch ? ` on ${ch === "linkedin" ? "LinkedIn" : ch[0]!.toUpperCase() + ch.slice(1)}` : ""}`, after: p.text };
      }
      case "brand_rule.add": return { patch: i, op: "add", target: `brand-rule:${p.text.toLowerCase().replace(/\W+/g, "-").replace(/-$/, "")}`, label: `Brand rule (${p.ruleKind})`, after: p.text };
      // the sample mode never produces these (its parser only knows the older shapes); shown plainly if one arrives
      case "skill.rule": return { patch: i, op: "add", target: `${id.replace("document:", "memory:")}-${i + 1}`, label: `Rule for ${p.agents.map((a) => agentById(a)?.name).join(", ")}`, after: p.text };
      case "skill.add": return { patch: i, op: "add", target: `${id.replace("document:", "memory:")}-${i + 1}`, label: `New skill: ${p.name}`, after: p.text };
    }
  });
  const preview: DirectivePreview = { id, text, actor: "person:owner", status: "preview", patches, diff, unparsed, notes, parser: "rules" };
  previews[id] = { ...preview, tenant: t };
  return preview;
}

export function applyDirective(t: string, id: string): DirectivePreview & { errors: string[] } {
  const p = previews[id];
  if (!p || p.tenant !== t) throw new Error("No such directive preview.");
  if (p.status === "applied") return { ...p, errors: [] };
  const s = settingsOf(t);
  for (const patch of p.patches) {
    if (patch.kind === "agent.enabled") setAgent(t, patch.agent, { enabled: patch.enabled, ...(patch.note ? { statusNote: patch.note } : {}) });
    else if (patch.kind === "agent.mode") setAgent(t, patch.agent, { mode: patch.mode });
    else if (patch.kind === "agent.autonomy") setAgent(t, patch.agent, { autonomy: patch.autonomy });
    else if (patch.kind === "memory.instruction") {
      for (const a of patch.agents) {
        const ch = patch.channel?.replace(/^channel:/, "");
        s[a]!.instructions.push({ id: `${id.replace("document:", "memory:")}-${a}`, text: patch.text, ...(ch ? { channel: ch === "linkedin" ? "LinkedIn" : ch } : {}), at: Date.now() });
      }
    }
  }
  p.status = "applied";
  return { ...p, errors: [] };
}
