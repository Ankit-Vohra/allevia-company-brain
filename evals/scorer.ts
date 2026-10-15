// Scores one eval turn: the answer checks ask() already ran (spec §7.4: citations, numbers, simulated, freshness,
// access mode), the item's expectations (evals/set.ts), latency, the agents that worked and the tools they called.
// A turn passes when it finished, every check passed and every expectation hit. Pure: no graph, no model.
import type { AgentEvent, TurnChecks } from "../shared/contracts.js";
import { SIMULATED_WORD } from "../src/agent/checks.js";
import { typeFromId } from "../src/util/ids.js";
import type { EvalItem } from "./set.js";

export const CHECKS = ["citationsValid", "numbersGrounded", "simulatedDisclosed", "freshnessDisclosed", "modeDisclosed"] as const;
export type CheckName = (typeof CHECKS)[number];
export const CHECK_LABEL: Record<CheckName, string> = {
  citationsValid: "citations", numbersGrounded: "numbers", simulatedDisclosed: "simulated", freshnessDisclosed: "freshness", modeDisclosed: "mode",
};

export type ExpectationKind = "cite" | "match" | "tool" | "agent" | "forbid" | "simulated";
export const EXPECTATION_KINDS: ExpectationKind[] = ["cite", "match", "tool", "agent", "forbid", "simulated"];

export interface ExpectationResult { kind: ExpectationKind; want: string; ok: boolean; got?: string }

// What a turn produced, as ask() returned it plus its event log.
export interface TurnObservation {
  ok: boolean;
  turnId: string;
  answer: string;
  citations: string[];
  checks: TurnChecks;
  agents: string[];
  ms: number;
  events: AgentEvent[];
  error?: string;
}

export interface ItemScore {
  id: string;
  question: string;
  tags: string[];
  turnId: string;
  ok: boolean;              // the turn finished with an answer
  error?: string;
  checks: Record<CheckName, boolean>;
  failedChecks: string[];   // "numbers: 56, 12%", "freshness"
  expectations: ExpectationResult[];
  hits: number;
  total: number;
  pass: boolean;
  ms: number;
  agents: string[];
  tools: string[];          // unique tool names, in first-use order
  toolCalls: number;
  citations: number;
  excerpt: string;
}

// ---------- patterns ----------

export function compilePattern(p: string): RegExp {
  const lit = /^\/(.+)\/([a-z]*)$/s.exec(p);
  return lit ? new RegExp(lit[1]!, lit[2]!.includes("u") ? lit[2]! : `${lit[2]!}u`) : new RegExp(p, "iu");
}

const escapeRe = (s: string): string => s.replace(/[.+?^${}()[\]\\/]/g, "\\$&");
const LABEL = /^[A-Z][A-Za-z]*$/;

// One mustCite entry -> does this cited id satisfy it? Labels come from the turn's tool results, else the id prefix.
export function citeMatcher(entry: string): (id: string, labels: ReadonlyMap<string, string>) => boolean {
  const alts = entry.split("|").map((a) => a.trim()).filter(Boolean).map((a) => {
    if (LABEL.test(a)) return (id: string, labels: ReadonlyMap<string, string>) => (labels.get(id) ?? typeFromId(id)) === a;
    const re = new RegExp(`^${a.split("*").map(escapeRe).join(".*")}$`, "u");
    return (id: string) => re.test(id);
  });
  return (id, labels) => alts.some((f) => f(id, labels));
}

const CITATION = /\s*\[\[[^\]]*\]\]/g;
export const prose = (answer: string): string => answer.replace(CITATION, "");

export function excerpt(answer: string, max = 300): string {
  const s = prose(answer).replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).replace(/\s+\S*$/, "")}…`;
}

const alternatives = (entry: string): string[] => entry.split("|").map((a) => a.trim()).filter(Boolean);
const unique = <T>(xs: T[]): T[] => [...new Set(xs)];

// ---------- scoring ----------

export function scoreTurn(item: EvalItem, t: TurnObservation): ItemScore {
  const calls = t.events.filter((e): e is Extract<AgentEvent, { type: "tool_call" }> => e.type === "tool_call");
  const tools = unique(calls.map((c) => c.name));
  const labels = new Map<string, string>();
  for (const e of t.events) {
    if (e.type === "tool_result" || e.type === "path") for (const n of e.nodes) labels.set(n.id, n.label);
  }
  const invalid = new Set(t.checks.invalidCitations ?? []);
  const valid = t.citations.filter((c) => !invalid.has(c));
  const text = prose(t.answer);
  const x = item.expect;
  const out: ExpectationResult[] = [];

  for (const want of x.mustCite) {
    const ok = valid.some((id) => citeMatcher(want)(id, labels));
    out.push({ kind: "cite", want, ok, ...(ok ? {} : { got: valid.slice(0, 8).join(", ") || "no valid citations" }) });
  }
  for (const want of x.mustMatch) {
    const ok = compilePattern(want).test(text);
    out.push({ kind: "match", want, ok });
  }
  for (const want of x.mustUseTools) {
    const ok = alternatives(want).some((a) => tools.includes(a));
    out.push({ kind: "tool", want, ok, ...(ok ? {} : { got: tools.join(", ") || "no tools" }) });
  }
  for (const want of x.mustUseAgents) {
    const ok = alternatives(want).some((a) => t.agents.includes(a));
    out.push({ kind: "agent", want, ok, ...(ok ? {} : { got: t.agents.join(", ") || "no agents" }) });
  }
  for (const want of x.forbid) {
    const m = compilePattern(want).exec(text);
    out.push({ kind: "forbid", want, ok: !m, ...(m ? { got: m[0] } : {}) });
  }
  if (x.simulated) out.push({ kind: "simulated", want: "says the data is simulated", ok: SIMULATED_WORD.test(text) });

  const checks: Record<CheckName, boolean> = {
    citationsValid: t.checks.citationsValid, numbersGrounded: t.checks.numbersGrounded, simulatedDisclosed: t.checks.simulatedDisclosed,
    freshnessDisclosed: t.checks.freshnessDisclosed, modeDisclosed: t.checks.modeDisclosed ?? true,
  };
  const failedChecks: string[] = [];
  if (!checks.citationsValid) failedChecks.push(`citations: ${t.checks.invalidCitations.join(", ")}`);
  if (!checks.numbersGrounded) failedChecks.push(`numbers: ${t.checks.ungroundedNumbers.join(", ")}`);
  if (!checks.simulatedDisclosed) failedChecks.push("simulated");
  if (!checks.freshnessDisclosed) failedChecks.push("freshness");
  if (!checks.modeDisclosed) failedChecks.push("mode");

  const hits = out.filter((e) => e.ok).length;
  return {
    id: item.id, question: item.question, tags: item.tags, turnId: t.turnId, ok: t.ok, ...(t.error ? { error: t.error } : {}),
    checks, failedChecks, expectations: out, hits, total: out.length,
    pass: t.ok && failedChecks.length === 0 && hits === out.length,
    ms: t.ms, agents: t.agents, tools, toolCalls: calls.length, citations: t.citations.length, excerpt: excerpt(t.answer),
  };
}

// ---------- aggregates ----------

export interface Summary {
  n: number;
  turnsOk: number;
  passed: number;
  checkRates: Record<CheckName, number>;
  hits: number;
  total: number;
  byKind: Partial<Record<ExpectationKind, { hits: number; total: number }>>;
  meanMs: number;
  medianMs: number;
  maxMs: number;
  meanToolCalls: number;
  agentUse: Record<string, number>; // turns each agent worked on
}

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function summarize(scores: ItemScore[]): Summary {
  const n = scores.length;
  const checkRates = Object.fromEntries(CHECKS.map((c) => [c, n ? scores.filter((s) => s.checks[c]).length / n : 0])) as Record<CheckName, number>;
  const byKind: Summary["byKind"] = {};
  for (const s of scores) {
    for (const e of s.expectations) {
      const k = (byKind[e.kind] ??= { hits: 0, total: 0 });
      k.total++;
      if (e.ok) k.hits++;
    }
  }
  const agentUse: Record<string, number> = {};
  for (const s of scores) for (const a of unique(s.agents)) agentUse[a] = (agentUse[a] ?? 0) + 1;
  const ms = scores.map((s) => s.ms);
  return {
    n, turnsOk: scores.filter((s) => s.ok).length, passed: scores.filter((s) => s.pass).length, checkRates,
    hits: scores.reduce((a, s) => a + s.hits, 0), total: scores.reduce((a, s) => a + s.total, 0), byKind,
    meanMs: mean(ms), medianMs: median(ms), maxMs: ms.length ? Math.max(...ms) : 0,
    meanToolCalls: mean(scores.map((s) => s.toolCalls)), agentUse,
  };
}
