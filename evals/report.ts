// The eval report: docs/evals/<date>-<tenant>.md (a fake run adds "-fake"). Rendered from the day's results file, so a
// re-run of one question adds an attempt instead of replacing the run: the summary shows the first run next to the
// latest when anything was re-run. Answers appear only as short excerpts (spec: the repo is public; the full answer
// stays on the Turn in the tenant's graph). Hand-written notes between <!-- notes --> and <!-- /notes --> survive
// every re-render.
import { agentById } from "../shared/roster.js";
import { CHECKS, CHECK_LABEL, EXPECTATION_KINDS, summarize, type ItemScore, type Summary } from "./scorer.js";
import type { EvalSet } from "./set.js";

export type Attempt = ItemScore & { at: number; model: string | null };

export interface ResultsFile {
  tenant: string;
  date: string;
  mode: "live" | "fake";
  setPath: string;
  items: Record<string, Attempt[]>; // by item id, oldest attempt first
}

const NOTES = /<!-- notes -->\n([\s\S]*?)<!-- \/notes -->/;

export function keptNotes(existing: string | undefined): string {
  return existing ? NOTES.exec(existing)?.[1] ?? "" : "";
}

const pct = (x: number): string => `${Math.round(x * 100)}%`;
const ofN = (a: number, n: number): string => `${a} of ${n}${n ? ` (${pct(a / n)})` : ""}`;
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
const who = (id: string): string => agentById(id)?.name ?? id;

function failures(a: ItemScore): string[] {
  const out: string[] = [];
  if (!a.ok) out.push(`Turn failed: ${a.error ?? "no answer"}`);
  for (const e of a.expectations) {
    if (e.ok) continue;
    if (e.kind === "simulated") out.push(`Missed simulated: ${e.want}`);
    else if (e.kind === "forbid") out.push(`Forbidden \`${e.want}\` matched: "${e.got ?? ""}"`);
    else out.push(`Missed ${e.kind} \`${e.want}\`${e.got ? ` (got: ${e.got})` : ""}`);
  }
  for (const c of a.failedChecks) out.push(`Check failed: ${c}`);
  return out;
}

const verdict = (a: ItemScore): string => (a.pass ? "PASS" : a.ok ? "FAIL" : "ERROR");

function summaryRows(first: Summary, latest: Summary | undefined): string[] {
  const row = (label: string, f: (s: Summary) => string) => `| ${label} | ${f(first)} |${latest ? ` ${f(latest)} |` : ""}`;
  return [
    latest ? "| | First run | Latest (after re-runs) |" : "| | |",
    latest ? "|---|---|---|" : "|---|---|",
    row("Questions", (s) => String(s.n)),
    row("Turns that finished", (s) => ofN(s.turnsOk, s.n)),
    row("Passed (every check and expectation)", (s) => ofN(s.passed, s.n)),
    row("Expectations hit", (s) => ofN(s.hits, s.total)),
    ...CHECKS.map((c) => row(`${CHECK_LABEL[c]} ${c === "citationsValid" ? "valid" : c === "numbersGrounded" ? "grounded" : "disclosed"}`, (s) => pct(s.checkRates[c]))),
    row("Mean latency", (s) => secs(s.meanMs)),
    row("Median / max latency", (s) => `${secs(s.medianMs)} / ${secs(s.maxMs)}`),
    row("Mean tool calls", (s) => s.meanToolCalls.toFixed(1)),
  ];
}

export function renderReport(r: ResultsFile, set: EvalSet, o: { notes?: string; modelLabel?: string } = {}): string {
  const order = new Map(set.items.map((it, i) => [it.id, i]));
  const ids = Object.keys(r.items).filter((id) => r.items[id]!.length)
    .sort((a, b) => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity) || a.localeCompare(b));
  const firsts = ids.map((id) => r.items[id]![0]!);
  const latests = ids.map((id) => r.items[id]!.at(-1)!);
  const rerun = ids.some((id) => r.items[id]!.length > 1);
  const first = summarize(firsts);
  const latest = rerun ? summarize(latests) : undefined;
  const now = latest ?? first;
  const models = [...new Set(latests.map((a) => a.model ?? "roster default"))];

  const lines: string[] = [
    `# Eval: ${r.tenant}, ${r.date}`,
    "",
    r.mode === "fake"
      ? "FAKE run: a scripted FakeRuntime and fake tools through the real `ask()` on a throwaway graph. No model was called, so the scores test the runner, not the agents."
      : `Live run of \`${r.setPath}\` through \`ask()\` with the real wiring (\`src/agent/wiring.ts\`): the Claude Agent SDK on the founder's subscription and the graph tools on \`allevia_${r.tenant}\`. Every question is a new thread; its Turn (answer, checks, full event log) is saved in the graph.`,
    "",
    `Model: ${o.modelLabel ?? models.join(", ")}. Questions run: ${ids.length} of ${set.items.length} in the set. Answers below are the first 300 characters, citation markers removed.`,
    "",
    "<!-- notes -->",
    `${o.notes ?? ""}<!-- /notes -->`,
    "",
    "## Summary",
    "",
    ...summaryRows(first, latest),
    "",
    `Expectation hits by kind: ${EXPECTATION_KINDS.filter((k) => now.byKind[k]).map((k) => `${k} ${now.byKind[k]!.hits}/${now.byKind[k]!.total}`).join(" · ") || "none"}.`,
    "",
    `Agents (turns worked on): ${Object.entries(now.agentUse).sort((a, b) => b[1] - a[1]).map(([a, n]) => `${who(a)} ${n}`).join(" · ") || "none"}.`,
    "",
    "## Questions",
    "",
    "| # | id | tags | result | checks | hits | latency | agents | tool calls | turn |",
    "|---|---|---|---|---|---|---|---|---|---|",
  ];
  ids.forEach((id, i) => {
    const a = r.items[id]!.at(-1)!;
    const res = `${verdict(a)}${r.items[id]!.length > 1 ? " (re-run)" : ""}`;
    const checks = a.failedChecks.length ? a.failedChecks.map((c) => c.split(":")[0]).join(", ") : "ok";
    lines.push(`| ${i + 1} | ${id} | ${cell(a.tags.join(", "))} | ${res} | ${checks} | ${a.hits}/${a.total} | ${secs(a.ms)} | ${cell(a.agents.map(who).join(", "))} | ${a.toolCalls}${a.tools.length ? `: ${cell(a.tools.join(", "))}` : ""} | \`${a.turnId}\` |`);
  });

  lines.push("", "## Answers and failures", "");
  ids.forEach((id, i) => {
    const attempts = r.items[id]!;
    const a = attempts.at(-1)!;
    lines.push(`### ${i + 1}. ${id}: ${verdict(a)}${attempts.length > 1 ? " (re-run)" : ""}`, "", `**Q:** ${a.question}`, "", `> ${a.excerpt || "(no answer)"}`, "");
    const f = failures(a);
    for (const x of f) lines.push(`- ${x}`);
    if (attempts.length > 1) {
      attempts.slice(0, -1).forEach((p, j) => {
        const pf = failures(p);
        lines.push(`- Attempt ${j + 1}: ${verdict(p)} (\`${p.turnId}\`, ${secs(p.ms)})${pf.length ? `: ${pf.join("; ")}` : ""}`);
      });
    }
    if (f.length || attempts.length > 1) lines.push("");
  });
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}
