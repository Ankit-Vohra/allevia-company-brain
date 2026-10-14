// Prompts for the agent company (spec §16.2). Every agent shares the house rules (answer only from tool results,
// [[id]] citations, numbers with dates, "not recorded" over guessing, Hindi in -> Hindi out, Jarvis-style brevity)
// and gets its persona, department focus and tools from shared/roster.ts. The Chief of Staff has three jobs with their
// own prompts: PLAN (structured), SYNTHESIS (streamed answer + show_path) and DIRECT (the one-desk fast path).
import { AGENTS, agentById, departmentById, type AgentDef } from "../../shared/roster.js";
import { formatIst, istDate } from "../util/time.js";
import type { AlleviaTool } from "./tool.js";

export const CHIEF = "chief-of-staff";
export const FINDING_MAX_CHARS = 1_200;
export const MAX_PLAN_STEPS = 5;

export const HOUSE_RULES = `House rules (every Allevia agent):
- Answer only from this turn's tool results, the findings handed to you, and the "what we already know" brief. If it isn't there, say "not recorded". Never guess.
- Cite every claim with the node id it came from, written [[id]] (for example [[metric:signups]]). Use only ids you saw in a tool result or the brief; never invent, shorten or alter an id.
- Every number carries its date or period ("55 signups in the week to 2026-10-05"). Copy numbers exactly as the tools gave them; you may only round to fewer digits.
- If any data you use is marked simulated, say "simulated" next to it.
- If the newest data you use is more than 7 days old, say "as of <date>".
- Reply in the language of the question: Hindi in, Hindi out (ids and numbers stay as they are).
- Be brief, like a sharp chief of staff: the answer first, then bullets (at most 5 per group), then one next action.`;

// What each reviewer looks for when it checks someone else's finding.
const REVIEW_FOCUS: Record<string, string> = {
  "copy-editor": "Hold it to the brand's voice rules (look them up with playbook) and strip AI-sounding phrasing. Facts are the fact checker's job.",
  "fact-checker": "Check every claim and number against the graph (open the cited ids). Anything unsupported goes back.",
  "coe-lead": "Check every figure: the right number, the right period, the right comparison. Anything not in the data goes back.",
};

const NOTHING_KNOWN = "(nothing recorded yet)";

function toolList(tools: AlleviaTool[]): string {
  return tools.length ? tools.map((t) => `- ${t.name}: ${t.description}`).join("\n") : "- (none: work from what you are given)";
}

export function agentSystemPrompt(agent: AgentDef, tools: AlleviaTool[], opts: { now: number; tenant: string }): string {
  const dept = departmentById(agent.department);
  return [
    `You are ${agent.name}, ${agent.title} in ${dept ? `the ${dept.name} department` : "the team"} of Allevia, the AI staff that runs the company brain of the business "${opts.tenant}".`,
    agent.persona,
    dept ? `Your department: ${dept.blurb}` : "",
    `You handle: ${agent.handles.join(", ")}.`,
    `Today is ${istDate(opts.now)} (${formatIst(opts.now)}).`,
    `Your tools (read the company graph; nothing you do changes the business without the owner's approval):\n${toolList(tools)}`,
    HOUSE_RULES,
  ].filter(Boolean).join("\n\n");
}

// ---------- structured outputs ----------

export const PLAN_SCHEMA = {
  type: "object",
  properties: {
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          agent: { type: "string", enum: AGENTS.map((a) => a.id) },
          task: { type: "string" },
          after: { type: "array", items: { type: "string" } },
        },
        required: ["agent", "task"],
        additionalProperties: false,
      },
    },
    rationale: { type: "string" },
  },
  required: ["steps", "rationale"],
  additionalProperties: false,
} as const;

export const FINDING_SCHEMA = {
  type: "object",
  properties: {
    text: { type: "string" },
    citations: { type: "array", items: { type: "string" } },
    basedOn: { type: "array", items: { type: "string" } },
    proposals: { type: "array", items: { type: "string" } },
  },
  required: ["text", "citations"],
  additionalProperties: false,
} as const;

export const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["ok", "fix", "reject"] },
    note: { type: "string" },
  },
  required: ["verdict", "note"],
  additionalProperties: false,
} as const;

// ---------- shared pieces ----------

export interface FindingView {
  id: string;
  agent: string;
  text: string;
  citations: string[];
  proposals?: string[];
  reviews?: Array<{ reviewer: string; verdict: string; note: string }>;
  rejected?: boolean;
  autoCheck?: string;   // the deterministic check of its citations and numbers against this turn's tool results
}

// What the reviewers get besides the text: the cited nodes the team's tools returned and the automatic check.
export interface ReviewEvidence {
  citedNodes: Array<{ id: string; label: string; name: string; asOf?: string }>;
  autoCheck: string;
}

const who = (id: string): string => {
  const a = agentById(id);
  return a ? `${a.name} (${a.title})` : id;
};

const quoteQ = (q: string): string => `The owner asked: "${q.trim()}"`;
const recallBlock = (recall: string): string => `What we already know (from earlier threads and notes; cite these ids if you use them):\n${recall.trim() || NOTHING_KNOWN}`;

function findingBlock(f: FindingView, withReviews: boolean): string {
  const lines = [`### ${who(f.agent)} [${f.id}]${f.rejected ? " REJECTED: do not rely on it" : ""}`, f.text.trim()];
  if (f.citations.length) lines.push(`Cites: ${f.citations.join(", ")}`);
  if (f.proposals?.length) lines.push(`Proposes:\n${f.proposals.map((p) => `- ${p}`).join("\n")}`);
  if (withReviews && f.autoCheck) lines.push(`Automatic check: ${f.autoCheck}`);
  if (withReviews && f.reviews?.length) lines.push(`Reviews: ${f.reviews.map((r) => `${who(r.reviewer)}: ${r.verdict}, ${r.note}`).join(" | ")}`);
  return lines.join("\n");
}

// ---------- PLAN (Chief of Staff, structured, no tools) ----------

export function planSystemPrompt(opts: { now: number; tenant: string }): string {
  const desks = AGENTS.filter((a) => a.id !== CHIEF).map((a) => {
    const dept = departmentById(a.department)?.name ?? a.department;
    const reviews = a.reviews?.length ? ` Reviews ${a.reviews.join(", ")} automatically.` : "";
    return `- ${a.id}: ${a.name}, ${a.title} (${dept}). Handles ${a.handles.join(", ")}. Tools: ${a.tools.join(", ")}.${reviews}`;
  }).join("\n");
  const chief = agentById(CHIEF)!;
  return [
    `You are ${chief.name}, Chief of Staff of Allevia, the AI staff that runs the company brain of the business "${opts.tenant}". Right now you only PLAN who does what; you do not answer yet.`,
    `Today is ${istDate(opts.now)}.`,
    `The desks:\n${desks}\n- ${CHIEF}: you. Tools: ${chief.tools.join(", ")}. Take a quick lookup yourself.`,
    `How to plan:
- Choose the fewest desks that can answer well. A simple factual question gets ONE step: one desk, or "${CHIEF}" yourself for a quick lookup (search, an entity, a path, what we already know).
- Use "after" (a list of agent ids) only when a desk needs another desk's finding, e.g. growth-marketer after data-analyst. Steps without "after" run in parallel.
- Content requests (reel ideas, posts, briefs, a content calendar) go to content-strategist. The copy editor and fact checker review its work automatically: do not plan them.
- Numbers-heavy work (KPIs, trends, spend) goes to data-analyst, growth-marketer or coe-lead. The CoE lead reviews analysts' and marketers' figures automatically.
- At most ${MAX_PLAN_STEPS} steps, one per desk. Each task is one sentence telling that desk exactly what to find.
- rationale: one sentence on why these desks.`,
  ].join("\n\n");
}

export function planPrompt(o: { question: string; recall: string }): string {
  return [quoteQ(o.question), recallBlock(o.recall), "Return the plan."].join("\n\n");
}

// ---------- WORK (a department agent, ends with a structured Finding) ----------

export function workPrompt(o: { question: string; task: string; recall: string; inputs: FindingView[]; failedDeps: string[] }): string {
  const parts = [quoteQ(o.question), `Your task from the Chief of Staff: ${o.task.trim()}`, recallBlock(o.recall)];
  if (o.inputs.length) parts.push(`Findings handed to you (build on them; list their ids in basedOn):\n\n${o.inputs.map((f) => findingBlock(f, false)).join("\n\n")}`);
  if (o.failedDeps.length) parts.push(`${o.failedDeps.map(who).join(" and ")} could not finish; work without that finding and say what is missing.`);
  parts.push(`Do the task with your tools, then return your Finding:
- text: at most ${FINDING_MAX_CHARS} characters of plain markdown. Every claim cited as [[id]]; every number with its date or period; "not recorded" where the graph has nothing.
- citations: every id you cited.
- basedOn: the finding ids above that you built on (empty if none).
- proposals: actions you would suggest, one line each (optional). Do not execute anything.`);
  return parts.join("\n\n");
}

// ---------- REVIEW (a reviewer, structured verdict) ----------

export function reviewPrompt(o: { question: string; reviewer: AgentDef; finding: FindingView; evidence?: ReviewEvidence }): string {
  const focus = REVIEW_FOCUS[o.reviewer.id] ?? o.reviewer.persona;
  const parts = [
    quoteQ(o.question),
    `${who(o.finding.agent)} wrote this finding [${o.finding.id}]:\n"""\n${o.finding.text.trim()}\n"""\nIt cites: ${o.finding.citations.join(", ") || "nothing"}`,
  ];
  if (o.evidence) {
    const nodes = o.evidence.citedNodes.map((n) => `- ${n.id}: ${n.label} "${n.name}"${n.asOf ? `, as of ${n.asOf}` : ""}`);
    parts.push(`What the team's tools returned this turn (the system checked this, so you don't need to re-find these ids):\n${nodes.join("\n") || "- none of the cited ids"}\nAutomatic check: ${o.evidence.autoCheck}`);
  }
  parts.push(`Review it as ${o.reviewer.title}. ${focus}
- Check it with your tools where you can. Not finding something with your own tools is not proof it is wrong: reject only what the evidence contradicts or what no tool returned.
- verdict "ok": accurate and usable as is. "fix": usable after a specific change; say exactly what in the note. "reject": wrong or unsupported at its core.
- note: one or two sentences.`);
  return parts.join("\n\n");
}

// ---------- REVISE (the producer, once, after a "fix") ----------

export function revisePrompt(o: { question: string; task: string; finding: FindingView; notes: Array<{ reviewer: string; verdict: string; note: string }> }): string {
  return [
    quoteQ(o.question),
    `Your task: ${o.task.trim()}`,
    `Your finding [${o.finding.id}]:\n"""\n${o.finding.text.trim()}\n"""`,
    `Reviewers asked for changes:\n${o.notes.map((n) => `- ${who(n.reviewer)}: ${n.verdict}, ${n.note}`).join("\n")}`,
    `Revise the finding once, addressing every note (use your tools if you need to check something). Return the full revised Finding with the same rules: at most ${FINDING_MAX_CHARS} characters, [[id]] citations, numbers with dates.`,
  ].join("\n\n");
}

// ---------- SYNTHESIS (the Chief, streamed answer, then show_path) ----------

const ANSWER_RULES = `Write the answer to the owner now:
- Lead with the answer in one or two sentences, then bullets (at most 5 per group), then one next action.
- Cite [[id]] for every claim, using the entity ids the findings cite (never the finding ids). Numbers with their dates. The "simulated" and "as of <date>" rules apply.
- Don't narrate the team's process unless it helps the owner trust the answer (for example "Isha double-checked the figures").
- Write the answer exactly once. Then call show_path once with the ordered ids that explain it (cause to effect). After show_path returns, write nothing more: no recap, no second version.
- If an action is clearly warranted, you may call propose_action. It only creates an approval card; nothing is executed.`;

export function synthesisPrompt(o: { question: string; recall: string; findings: FindingView[]; failed: string[]; chiefTask?: string }): string {
  const parts = [quoteQ(o.question), recallBlock(o.recall)];
  if (o.chiefTask) parts.push(`Your own note from planning: ${o.chiefTask}`);
  parts.push(o.findings.length
    ? `The desks' findings:\n\n${o.findings.map((f) => findingBlock(f, true)).join("\n\n")}`
    : "No desk produced a finding. Use your own tools for a quick check, or say what is not recorded.");
  if (o.failed.length) parts.push(`Desks that could not finish: ${o.failed.map(who).join(", ")}. Answer with what you have and say what is missing.`);
  parts.push(ANSWER_RULES);
  return parts.join("\n\n");
}

// ---------- DIRECT (fast path: the Chief answers alone with tools) ----------

export function directPrompt(o: { question: string; recall: string; task?: string }): string {
  const parts = [quoteQ(o.question)];
  if (o.task && o.task.trim() !== o.question.trim()) parts.push(`Your plan: ${o.task.trim()}`);
  parts.push(recallBlock(o.recall));
  parts.push(`Look it up yourself with your tools (search first, then open what matters), then answer.\n\n${ANSWER_RULES}`);
  return parts.join("\n\n");
}
