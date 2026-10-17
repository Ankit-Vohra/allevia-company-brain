// Home's logic, kept out of the components so it can be tested as it is (tests/web/home.test.ts): which drafts wait for the
// owner and in what order, the status line, what the stand-up's note says in one line, the goals in one figure, which tool to
// ask the owner to connect next, who is working right now, and how a meeting is said. The words follow docs/owner-words.md.
// No React and no DOM.
//
// Types are the narrow shapes this file reads (the web app's own types satisfy them), so the file runs under the server's
// compiler too.
import type { AgentId, AgentMode, ProgramGoal } from "../../../shared/contracts.js";
import { AGENTS } from "../../../shared/roster.js";
import { CHIEF, TEAM, dotOf, workingNow, type Dot } from "./chat.js";
import { goalState, goalView, monthWeek, notStartedYet, type GoalView } from "./plainwords.js";
import { humanDates } from "./words.js";

// ---------------------------------------------------------------- waiting for your OK

interface DraftLike { id: string; status: string; createdAt: string; preview?: { why?: string } }

/** The stand-up as Home reads it (GET /api/:t/standup). */
export interface StandupLike {
  heading: string;
  quiet?: boolean;
  items: Array<{ key: string; agent: AgentId; title: string; why: string; status: string; approvalId?: string }>;
  waiting?: Array<{ approvalId: string; title: string; agent: AgentId; matters: string }>;
  lessons?: string[];
}

export interface WaitingItem<A> {
  approval: A;
  /** One line on why it matters: the stand-up's own words, else the idea's reason. */
  why?: string;
  /** One of the big problems the stand-up led with. */
  big: boolean;
}

/**
 * The drafts waiting for the owner, in the order to say OK: the big problems the stand-up led with first (they matter this
 * week), then what it drafted this morning, then everything else, newest first. Decided drafts are left out.
 */
export function waitingList<A extends DraftLike>(approvals: readonly A[] | undefined, standup: StandupLike | null | undefined): WaitingItem<A>[] {
  const pending = (approvals ?? []).filter((a) => a.status === "pending");
  const rank = new Map<string, number>();
  const why = new Map<string, string>();
  const big = new Set<string>();
  (standup?.waiting ?? []).forEach((w, i) => { rank.set(w.approvalId, i); why.set(w.approvalId, w.matters); big.add(w.approvalId); });
  (standup?.items ?? []).filter((i) => i.status === "drafted" && i.approvalId).forEach((i, n) => {
    if (!rank.has(i.approvalId!)) rank.set(i.approvalId!, 1000 + n);
    if (!why.has(i.approvalId!) && i.why) why.set(i.approvalId!, i.why);
  });
  return [...pending]
    .sort((a, b) => (rank.get(a.id) ?? 1e6) - (rank.get(b.id) ?? 1e6) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
    .map((a) => {
      const line = why.get(a.id) || a.preview?.why;
      return { approval: a, ...(line ? { why: humanDates(line) } : {}), big: big.has(a.id) };
    });
}

/** The first few to decide here, and how many more wait on the Approvals page. */
export function firstFew<T>(list: readonly T[], n = 3): { shown: T[]; more: number } {
  return { shown: list.slice(0, n), more: Math.max(0, list.length - n) };
}

/** The title the owner reads: without the "(simulated)" tag, which is shown as "sample numbers" beside it. */
export const plainTitle = (s: string): string => s.replace(/\s*\((?:simulated|sample numbers)\)/gi, "").replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------- today's note

/** The note collapsed to its first line: how many things the team noticed, or that it was quiet. */
export function noteLine(standup: StandupLike | null | undefined): string {
  if (!standup) return "Your team meets every morning. Today's note will be here.";
  const drafted = standup.items.filter((i) => i.status === "drafted").length;
  if (drafted === 0) return "Nothing new worth your time today.";
  return standup.heading || `Your team noticed ${drafted} ${drafted === 1 ? "thing" : "things"} worth doing today`;
}

/** The stand-up's picks, each with its reason: the full note, behind one tap. */
export function notePicks(standup: StandupLike | null | undefined): Array<{ key: string; agent: AgentId; title: string; why: string; approvalId?: string }> {
  return (standup?.items ?? []).filter((i) => i.status === "drafted").map((i) => ({ key: i.key, agent: i.agent, title: plainTitle(i.title), why: humanDates(i.why), ...(i.approvalId ? { approvalId: i.approvalId } : {}) }));
}

// ---------------------------------------------------------------- your plan

export interface PlanSummary {
  /** "Month 1 · week 2" */
  when: string;
  goals: GoalView[];
  /** Every goal is still waiting for its first reading. */
  allWaiting: boolean;
}

/** The three goals with their bars, in the owner's words (the first week says "We'll know after your first full week"). */
export function planSummary(p: { day: number; goals: ProgramGoal[] } | null | undefined, fmt: (n: number) => string): PlanSummary | null {
  if (!p) return null;
  const goals = p.goals.slice(0, 3).map((g) => goalView(g, p.day, fmt));
  const allWaiting = p.goals.length > 0 && p.goals.slice(0, 3).every((g) => goalState(g, p.day) === "no_data" || notStartedYet(g, p.day) || g.current === null);
  return { when: monthWeek(p.day), goals, allWaiting };
}

/** The goals in one figure for Home's small tile: "2 of 3 going well", or that the first reading is still coming. */
export function goalsTally(plan: PlanSummary | null): { big: string; line: string } | null {
  if (!plan || plan.goals.length === 0) return null;
  const n = plan.goals.length;
  if (plan.allWaiting) return { big: `${n} ${n === 1 ? "goal" : "goals"}`, line: "First reading next week" };
  const well = plan.goals.filter((g) => g.status?.tone === "ok").length;
  return { big: `${well} of ${n}`, line: "going well" };
}

/** How the business is doing, in a few words for Home's status line: "Weekly signups up 18%". Null before a first reading. */
export function pulseWords(goals: ReadonlyArray<Pick<ProgramGoal, "name" | "current" | "baseline">> | undefined, pct: (n: number) => string): string | null {
  const g = (goals ?? []).find((x) => x.current !== null && x.baseline !== null && x.baseline > 0);
  if (!g) return null;
  const change = (g.current! - g.baseline!) / g.baseline!;
  return Math.abs(change) < 0.005 ? `${g.name} level` : `${g.name} ${change > 0 ? "up" : "down"} ${pct(Math.abs(change))}`;
}

/** Home's one status line: what needs the owner, then how the business is doing. */
export function homeStatus(waiting: number, pulse: string | null): string {
  const need = waiting === 0 ? "Nothing needs you" : `${waiting} ${waiting === 1 ? "thing needs" : "things need"} you`;
  return pulse ? `${need} · ${pulse}` : need;
}

// ---------------------------------------------------------------- your tools

/** The slice of a connection Home reads (ConnectionRow). */
export interface ToolLike { id: string; name: string; state: "not_connected" | "connected" | "needs_attention"; available: boolean; soon?: boolean }

/** What connecting each one lets the team do, finishing "Connect X ...". */
const SEES: Record<string, string> = {
  gmail: "so your team can answer your enquiries",
  "google-calendar": "so your team can book calls for you",
  "google-analytics": "to see visits",
  "search-console": "to see what people search to find you",
  "google-ads": "to see where your ad money works",
  instagram: "to see which posts bring you enquiries",
  "facebook-pages": "to see how your Page is doing",
  "meta-ads": "to see how your ads do",
  whatsapp: "so your team can draft replies to your customers",
  shopify: "to see your orders and best sellers",
  stripe: "to see your real revenue",
  hubspot: "so your team can follow up on every lead",
  calendly: "to see who booked a call with you",
  mailchimp: "to see how your emails did",
  linkedin: "to see how your posts did",
  slack: "so your team can post its note where you work",
  zoho: "so your team can follow up on every lead",
  tiktok: "to see how your videos did",
  quickbooks: "to see who still owes you",
  xero: "to see who still owes you",
  "google-sheets": "so your team can keep notes and numbers in a sheet",
};
const SEES_DEFAULT = "so your team can see more";

/** Which goal metric each connection feeds, so a goal with no numbers yet points at the tool that would give it some. */
const FEEDS: Record<string, string[]> = {
  gsc_clicks: ["search-console"],
  ga4_sessions: ["google-analytics"],
  account_reach: ["instagram"],
  gbp_actions: ["search-console"],
  enquiries: ["gmail", "hubspot"],
  orders: ["shopify", "stripe"],
};

export interface ToolsSummary {
  connected: ToolLike[];
  /** The tool to connect next, with the one line that says why, or null when everything useful is connected. */
  next: { tool: ToolLike; line: string; reconnect: boolean } | null;
}

/**
 * What is connected, and what would help most. A tool that stopped working comes first ("Connect Gmail again"). Then a tool that
 * would give a goal its first numbers. Then the order the Your tools page recommends for this kind of business (the API already
 * puts the best fit for the business first). Tools that are not switched on yet are never offered.
 */
export function toolsSummary(rows: readonly ToolLike[] | undefined, goals: ReadonlyArray<Pick<ProgramGoal, "metricKey" | "current" | "status">> = []): ToolsSummary {
  const all = rows ?? [];
  const connected = all.filter((r) => r.state === "connected");
  const attention = all.find((r) => r.state === "needs_attention" && r.available);
  if (attention) return { connected, next: { tool: attention, line: `Connect ${attention.name} again ${SEES[attention.id] ?? SEES_DEFAULT}`, reconnect: true } };
  const offer = all.filter((r) => r.state === "not_connected" && r.available && !r.soon);
  const empty = goals.filter((g) => g.current === null || g.status === "no_data");
  const wanted = new Set(empty.flatMap((g) => FEEDS[g.metricKey] ?? []));
  const tool = offer.find((r) => wanted.has(r.id)) ?? offer[0];
  return { connected, next: tool ? { tool, line: `Connect ${tool.name} ${SEES[tool.id] ?? SEES_DEFAULT}`, reconnect: false } : null };
}

// ---------------------------------------------------------------- your team

export interface StripPerson { id: AgentId; name: string; title: string; dot: Dot }

/** Everyone on the team, the ones working first, with the dot beside each (working now, ready, resting). */
export function teamStrip(
  settings: ReadonlyArray<{ id: string; enabled: boolean; mode?: AgentMode }> | undefined,
  working: ReadonlySet<string>,
): { people: StripPerson[]; line: string; working: number; resting: number } {
  const byId = new Map((settings ?? []).map((s) => [s.id, s]));
  const people = AGENTS.map((a): StripPerson => ({ id: a.id, name: a.name, title: a.title, dot: dotOf(byId.get(a.id), working.has(a.id)) }));
  const order = { working: 0, idle: 1, off: 2 } as const;
  const sorted = [...people].sort((a, b) => order[a.dot] - order[b.dot]); // stable: the roster's own order inside each group
  const on = sorted.filter((p) => p.dot === "working");
  const off = sorted.filter((p) => p.dot === "off").length;
  const names = on.map((p) => p.name);
  const line = on.length === 0
    ? off === people.length ? "Everyone is resting." : "Your team is ready."
    : on.length === 1 ? `${names[0]} is working.`
    : on.length === 2 ? `${names[0]} and ${names[1]} are working.`
    : `${names.slice(0, 2).join(", ")} and ${on.length - 2} more are working.`;
  return { people: sorted, line, working: on.length, resting: off };
}

interface RunLike { kind: string; tenant: string; status: string; target?: string; events: Parameters<typeof workingNow>[0] }
interface SessionLike { running?: boolean; agent?: string }

/** Who is working this moment: the live runs in this tab, and the threads the server says are still running (either door). */
export function whoIsWorking(runs: readonly RunLike[], sessions: readonly SessionLike[] | undefined, tenant: string): Set<string> {
  const on = new Set<string>();
  const add = (id: string) => on.add(id === TEAM ? CHIEF : id);
  for (const r of runs) {
    if (r.kind !== "live" || r.tenant !== tenant || r.status !== "running") continue;
    add(r.target ?? TEAM);
    for (const a of workingNow(r.events)) add(a);
  }
  for (const s of sessions ?? []) if (s.running) add(s.agent ?? TEAM);
  return on;
}

// ---------------------------------------------------------------- a meeting, said plainly

/** "Wednesday 21 October, 3:30 to 4:00 pm", on the owner's clock (or the meeting's own, when it names one). */
export function meetingWords(when: { start: string; end?: string; timeZone?: string }, o: { timeZone?: string; locale?: string } = {}): string {
  const start = new Date(when.start);
  if (Number.isNaN(start.getTime())) return "";
  const zone = pick(when.timeZone ?? o.timeZone);
  const loc = locale(o.locale);
  const day = new Intl.DateTimeFormat(loc, { weekday: "long", day: "numeric", month: "long", ...(zone ? { timeZone: zone } : {}) }).format(start).replace(",", "");
  const clock = new Intl.DateTimeFormat(loc, { hour: "numeric", minute: "2-digit", ...(zone ? { timeZone: zone } : {}) });
  const end = when.end ? new Date(when.end) : undefined;
  const keep = (t: string) => t.replace(/\s(?=[ap]m$)/i, " "); // "11:30 am" never breaks between the time and the am
  const from = keep(clock.format(start));
  if (!end || Number.isNaN(end.getTime())) return `${day}, ${from}`;
  return `${day}, ${from} to ${keep(clock.format(end))}`;
}

const pick = (z: string | undefined): string | undefined => {
  if (!z) return undefined;
  try { new Intl.DateTimeFormat("en", { timeZone: z }); return z; } catch { return undefined; }
};
const locale = (l: string | undefined): string => {
  if (!l) return "en-GB";
  try { return Intl.getCanonicalLocales(l)[0] ?? "en-GB"; } catch { return "en-GB"; }
};
