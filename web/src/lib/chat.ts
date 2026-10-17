// The chat's pure logic: who the owner is talking to, which conversations belong to whom, what the team said to each other,
// how an answer was reached in plain words, and what to suggest saying. No React and no DOM, so the tests run it as it is.
// Words follow docs/owner-words.md: the owner reads "your team", a person's name and job, "sources", never "agent" or "graph".
import type { AgentEvent, AgentId, AgentMode, SkillView, SourceRef, TurnChecks } from "../../../shared/contracts.js";
import { PLAIN_TOOLS } from "../../../shared/plain-tools.js";
import { AGENTS, agentById } from "../../../shared/roster.js";
import { LEGACY_NAMES } from "../../../shared/legacy-names.js";
import { STARTERS } from "./starters.js";
import { humanDates } from "./words.js";

export const CHIEF: AgentId = "chief-of-staff";
/** "team" is the whole team (the Chief routes); anything else is a roster id. */
export const TEAM = "team";
export type Who = typeof TEAM | AgentId;

// ---------------------------------------------------------------- addresses

/** /chat/team, /chat/content-strategist, /chat/team/<thread>: the thread id has colons, so it is encoded. */
export function chatPath(who: Who, sessionId?: string): string {
  const base = `/chat/${encodeURIComponent(who)}`;
  return sessionId ? `${base}/${encodeURIComponent(sessionId)}` : base;
}

/**
 * Where Home's ask box sends a question: the whole team's chat, with the question sent at once (/chat/team?ask=...). The Chat
 * page reads `ask` once, starts the turn and removes it, so a reload does not ask twice. On Discord the same is `/ask`.
 */
export function askPath(text: string, who: Who = TEAM): string {
  return `${chatPath(who)}?ask=${encodeURIComponent(text.trim())}`;
}

/** The entry an address names: a roster id, or the team. Anything else (a typo, an old link) is the team. */
export function whoFrom(param: string | undefined): Who {
  if (!param || param === TEAM || param === CHIEF) return TEAM;
  if (agentById(param)) return param;
  // /chat/growth-hacker reads as well as /chat/growth-marketer, and an old link by the name before the rename still lands
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const byName = AGENTS.find((a) => slug(a.name) === slug(param));
  const byOldName = Object.entries(LEGACY_NAMES).find(([old]) => old.toLowerCase() === param.toLowerCase())?.[1];
  return byName ? byName.id : byOldName ?? TEAM;
}

/** Which entry a thread belongs to: the person it was a direct chat with, else the whole team. */
export const whoOfThread = (t: { agent?: AgentId }): Who => (t.agent && t.agent !== CHIEF && agentById(t.agent) ? t.agent : TEAM);

export function threadsFor<T extends { agent?: AgentId }>(who: Who, threads: readonly T[] | undefined): T[] {
  return (threads ?? []).filter((t) => whoOfThread(t) === who);
}

// ---------------------------------------------------------------- status

export type Dot = "working" | "idle" | "off";

/** The dot beside a person: working now, ready, or resting (switched off). */
export function dotOf(s: { enabled: boolean; mode?: AgentMode } | undefined, working: boolean): Dot {
  if (s && (!s.enabled || s.mode === "off")) return "off";
  return working ? "working" : "idle";
}

export function dotWords(dot: Dot, mode?: AgentMode): string {
  if (dot === "off") return "Resting";
  if (dot === "working") return "Working now";
  return mode === "light" ? "Ready, light touch" : "Ready";
}

// ---------------------------------------------------------------- who is in a run

/** Who in a run is working this moment, from its events: started and not yet done. */
export function workingNow(events: readonly AgentEvent[]): AgentId[] {
  const on = new Set<AgentId>();
  for (const e of events) {
    if (e.type === "agent_start") on.add(e.agent);
    else if (e.type === "agent_done") on.delete(e.agent);
    else if (e.type === "final") on.clear();
  }
  return [...on];
}

// ---------------------------------------------------------------- watch the team talk

export type TalkKind = "plan" | "handoff" | "finding" | "review" | "proposal" | "skill" | "error";

/** One line of the thread the team has among itself. `to` is who it is said to, when it is said to someone. */
export interface TalkLine { kind: TalkKind; from: AgentId; to?: AgentId; text: string; verdict?: "ok" | "fix" | "reject"; at: number }

const nameOf = (id: AgentId): string => agentById(id)?.name ?? id;
const clip = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1).replace(/\s+\S*$/, "")}…`;
};
/** A working line without the [[id]] markers: the thread is read by an owner, not by the graph. */
const noCites = (s: string): string => s.replace(/\s*\[\[[^\]]*\]\]/g, "").replace(/\s+([.,;:])/g, "$1");
/** What a person added, as one plain sentence: no bold marks, no "Findings:" label, bullets run on, days in words. */
export const noteText = (s: string): string => humanDates(noCites(s)
  .replace(/\*\*|__|`/g, "")
  .replace(/^\s*(?:key\s+)?(?:findings?|notes?)\s*:\s*/i, "")
  .replace(/([.!?])\s+[-•]\s+/g, "$1 ")
  .replace(/^\s*[-•]\s+/, "")
  .replace(/\s+/g, " ").trim());

/** What a thread says when its question was saved and nothing after it (the run died with the server). */
export const LOST_ANSWER = "This question never got an answer: the team was interrupted before it finished.";

/** A saved turn's answer as the one event the chat needs to show it, for when its work log is missing or still loading. */
export function savedAnswer(t: { id: string; answer: string; citations?: string[]; checks: TurnChecks; agents?: AgentId[]; ms?: number }): AgentEvent[] {
  if (!t.answer?.trim()) return [];
  return [{ type: "final", turnId: t.id, answer: t.answer, citations: t.citations ?? [], checks: t.checks, agents: t.agents ?? [], ms: t.ms ?? 0 }];
}

/**
 * The messages the team sent each other in one turn, in order, as a readable thread: the Chief's plan, who handed what to
 * whom, what each person found, the reviews, and what is waiting for the owner. Streamed text and tool calls are not
 * messages; they live behind "how we got this".
 */
export function teamTalk(events: readonly AgentEvent[]): TalkLine[] {
  const out: TalkLine[] = [];
  const author = new Map<string, AgentId>(); // finding id -> who wrote it
  const handed = new Set<string>();
  events.forEach((e, at) => {
    switch (e.type) {
      case "plan": {
        const steps = e.steps.filter((s) => s.agent !== e.by);
        if (!steps.length) break;
        const who = steps.map((s) => nameOf(s.agent));
        const list = who.length > 1 ? `${who.slice(0, -1).join(", ")} and ${who[who.length - 1]}` : who[0]!;
        const why = e.rationale.trim();
        out.push({ kind: "plan", from: e.by, text: `${why ? `${noCites(why)} ` : ""}I'm asking ${list}.`.trim(), at });
        for (const s of steps) {
          const after = (s.after ?? []).map(nameOf);
          out.push({ kind: "plan", from: e.by, to: s.agent, text: `${noCites(s.task)}${after.length ? ` (after ${after.join(" and ")})` : ""}`, at });
        }
        break;
      }
      case "handoff": {
        const k = `${e.from}>${e.to}>${e.note}`;
        if (handed.has(k)) break;
        handed.add(k);
        // a handoff often carries the sender's own notes ("Firefighter's finding: …"): the name is already on the line
        out.push({ kind: "handoff", from: e.from, to: e.to, text: clip(noteText(e.note).replace(/^[A-Z][\w-]*['’]s (?:notes?|findings?):\s*/i, ""), 260), at });
        break;
      }
      case "skill_used":
        out.push({ kind: "skill", from: e.agent, text: `Using the skill “${e.name.trim().replace(/[.?!]+$/, "")}”.`, at });
        break;
      case "finding":
        author.set(e.findingId, e.agent);
        out.push({ kind: "finding", from: e.agent, text: clip(noteText(e.text), 260), at });
        break;
      case "review": {
        const by = author.get(e.findingId);
        const of = by && by !== e.agent ? `${nameOf(by)}'s note` : "that note";
        const lead = e.verdict === "ok" ? `Checked ${of}: fine.` : e.verdict === "fix" ? `Sent ${of} back for a fix.` : `Turned down ${of}.`;
        out.push({ kind: "review", from: e.agent, ...(by && by !== e.agent ? { to: by } : {}), verdict: e.verdict, text: `${lead}${e.note.trim() ? ` ${noteText(e.note)}` : ""}`, at });
        break;
      }
      case "proposal":
        out.push({ kind: "proposal", from: e.agent, text: `Suggests: ${noCites(e.title)}. This waits for your OK.`, at });
        break;
      case "error":
        if (e.agent) out.push({ kind: "error", from: e.agent, text: noCites(e.message), at });
        break;
      default:
    }
  });
  return out;
}

// ---------------------------------------------------------------- what each person contributed

/** One person's part in a team answer: what they found, and whether the others checked it. */
export interface Contribution { agent: AgentId; text: string; checks: Array<{ by: AgentId; verdict: "ok" | "fix" | "reject" }> }

/** The notes the people on the team wrote for this turn (never the Chief's own answer), with their reviews. */
export function contributions(events: readonly AgentEvent[]): Contribution[] {
  const by = new Map<string, Contribution>();
  const order: string[] = [];
  for (const e of events) {
    if (e.type === "finding") {
      if (!by.has(e.findingId)) order.push(e.findingId);
      by.set(e.findingId, { agent: e.agent, text: noteText(e.text), checks: by.get(e.findingId)?.checks ?? [] });
    } else if (e.type === "review") {
      by.get(e.findingId)?.checks.push({ by: e.agent, verdict: e.verdict });
    }
  }
  return order.map((id) => by.get(id)!);
}

// ---------------------------------------------------------------- how we got this

export interface HowWeGotThis {
  people: AgentId[];                                         // everyone who worked on it, in order
  tools: Array<{ agent: AgentId; words: string; times: number }>; // what they looked at or did, in plain words
  skills: Array<{ agent: AgentId; name: string }>;           // the skills they opened
  sources: SourceRef[];                                      // where the facts came from
  checks: Array<{ ok: boolean; text: string }>;              // what was checked on the answer
}

// Tools that are the team's own plumbing: not "what they looked at".
const PLUMBING = new Set(["show_path", "use_skill"]);

export function toolWords(name: string): string {
  return PLAIN_TOOLS[name] ?? name.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

export function checkLines(c: TurnChecks): HowWeGotThis["checks"] {
  const lines: HowWeGotThis["checks"] = [
    { ok: c.citationsValid, text: c.citationsValid ? "Every source it points to is in your records" : `It pointed to a source we could not find${c.invalidCitations.length ? `: ${c.invalidCitations.length}` : ""}` },
    { ok: c.numbersGrounded, text: c.numbersGrounded ? "Every number matches your records" : `${c.ungroundedNumbers.length || "A few"} number${c.ungroundedNumbers.length === 1 ? "" : "s"} could not be matched to a source` },
    { ok: c.simulatedDisclosed, text: c.simulatedDisclosed ? "Sample numbers are said to be samples" : "Sample numbers were not marked as samples" },
    { ok: c.freshnessDisclosed, text: c.freshnessDisclosed ? "Dates are stated" : "Dates were not stated" },
  ];
  if (c.modeDisclosed !== undefined) lines.push({ ok: c.modeDisclosed, text: c.modeDisclosed ? "Where the data came from is stated" : "Where the data came from was not stated" });
  return lines;
}

/** True when nothing on the answer needs the owner's care. */
export const checksPass = (c: TurnChecks): boolean => checkLines(c).every((l) => l.ok);

export function howWeGotThis(events: readonly AgentEvent[], final?: { agents: AgentId[]; checks: TurnChecks }): HowWeGotThis {
  const people = [...(final?.agents ?? [])];
  const seenPerson = new Set(people);
  const tools = new Map<string, { agent: AgentId; words: string; times: number }>();
  const skills: HowWeGotThis["skills"] = [];
  const sources = new Map<string, SourceRef>();
  for (const e of events) {
    if (e.type === "agent_start" && !seenPerson.has(e.agent)) { seenPerson.add(e.agent); people.push(e.agent); }
    if (e.type === "tool_call" && !PLUMBING.has(e.name)) {
      const k = `${e.agent}|${e.name}`;
      const have = tools.get(k);
      if (have) have.times += 1; else tools.set(k, { agent: e.agent, words: toolWords(e.name), times: 1 });
    }
    if (e.type === "skill_used" && !skills.some((s) => s.agent === e.agent && s.name === e.name)) skills.push({ agent: e.agent, name: e.name });
    if (e.type === "tool_result") for (const s of e.sources) if (!sources.has(s.id)) sources.set(s.id, s);
  }
  return { people, tools: [...tools.values()], skills, sources: [...sources.values()], checks: final ? checkLines(final.checks) : [] };
}

// ---------------------------------------------------------------- what to say

export interface Starter { label: string; prompt: string; id: string }

const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

/** A chip for one skill: its name as the label and a first sentence in the owner's voice. */
export function starterFor(skill: Pick<SkillView, "id" | "name" | "makes">): Starter {
  const label = skill.name.replace(/\s*\([^)]*\)\s*$/, "").trim();
  const known = STARTERS[skill.id];
  if (known) return { id: skill.id, label, prompt: known };
  // a skill we have no sentence for (the business's own, or a newer one)
  if (skill.makes) return { id: skill.id, label, prompt: `Make me ${lowerFirst(skill.makes.split(/,| with /)[0]!.trim())}.` };
  return { id: skill.id, label, prompt: `Help me with: ${lowerFirst(label)}.` };
}

/** The chips under an empty chat with one person: their skills that are on, then (with no skills) what they handle. */
export function startersFor(agent: AgentId, skills: readonly SkillView[] | undefined, max = 6): Starter[] {
  const on = (skills ?? []).filter((s) => s.on !== false).map(starterFor);
  if (on.length) return on.slice(0, max);
  const a = agentById(agent);
  return (a?.handles ?? []).slice(0, max).map((h) => ({ id: h, label: h.replace(/^./, (c) => c.toUpperCase()), prompt: `Help me with ${h}.` }));
}

// ---------------------------------------------------------------- tone

export interface Tone { id: string; label: string; says: string }

/** The tones to pick from. `says` finishes "always write in a …" for the instruction the team keeps. */
export const TONES: Tone[] = [
  { id: "warm", label: "Warm", says: "warm, friendly tone, like a good neighbour" },
  { id: "direct", label: "Straight to the point", says: "direct tone: the answer first, no padding" },
  { id: "playful", label: "Playful", says: "light, playful tone, with a little humour" },
  { id: "formal", label: "Formal", says: "formal, professional tone" },
];

/** The sentence "Tell your team" reads to keep a tone: it becomes a standing instruction for that one person. */
export const toneDirective = (name: string, tone: Tone): string => `${name}, always write in a ${tone.says}`;

// ---------------------------------------------------------------- the door a message came through

export function doorWords(source: "web" | "discord" | "cli" | undefined): string | undefined {
  return source === "discord" ? "From Discord" : undefined;
}
