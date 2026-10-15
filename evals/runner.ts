// The eval runner (spec §12): each question of a set goes through ask() as a new thread, is scored (evals/scorer.ts)
// and lands in the day's results (data/evals/<date>-<tenant>.json, gitignored: it is local run data) and the report
// (docs/evals/<date>-<tenant>.md, committed: aggregate scores and short answer excerpts only).
// - live (default): the real wiring (src/agent/wiring.ts) on the tenant's graph, one question at a time (the
//   subscription is shared, so nothing runs in parallel). Results are written after every question, so an
//   interrupted run keeps what it did; running a question again adds an attempt.
// - fake (--fake): a scripted FakeRuntime and fake tools through the same ask() on a throwaway graph that is dropped
//   afterwards. No model is called and no tenant graph is touched: it checks the plumbing (CI and dry runs).
// - rescore (--rescore): the day's stored turns scored again against the set as it is now (no model is called), so an
//   expectation fixed after a run applies to every attempt alike.
// CLI: `npm run cli -- eval <tenant> [--limit N] [--only a,b] [--tags x,y] [--fake] [--model haiku] [--verbose] [--rescore]`,
// or `npx tsx evals/runner.ts <same args>`.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import type { AgentEvent, NodeRef, TurnChecks } from "../shared/contracts.js";
import { ask, type AskDeps } from "../src/agent/ask.js";
import { FakeRuntime } from "../src/agent/runtime.js";
import type { AlleviaTool } from "../src/agent/tool.js";
import { closeAll, openGraph, openGraphByName, type GraphHandle } from "../src/graph/client.js";
import { ensureIndexes } from "../src/graph/indexes.js";
import { istDate } from "../src/util/time.js";
import { renderReport, keptNotes, type Attempt, type ResultsFile } from "./report.js";
import { scoreTurn, summarize, type ItemScore, type Summary } from "./scorer.js";
import { findSet, selectItems, type EvalItem, type EvalSet } from "./set.js";

const REPO = fileURLToPath(new URL("../", import.meta.url));
export const REPORT_DIR = join(REPO, "docs", "evals");
export const RESULTS_DIR = join(REPO, "data", "evals");

// ---------- fake mode ----------

export interface FakeAnswer {
  text: string;        // the Chief's answer
  nodes?: NodeRef[];   // what the fake tools return (the citations' ground)
  data?: unknown;      // the fake tools' data (the numbers' ground)
  tools?: string[];    // Chief tools to call, in order (default: search)
}

export const FAKE_NODE: NodeRef = { id: "fake:eval-node", label: "Entity", name: "Fake eval node" };

export const defaultFakeAnswer = (it: EvalItem): FakeAnswer => ({
  text: `Fake answer (no model was called) to "${it.question}" [[${FAKE_NODE.id}]].`,
});

// The company with a script instead of a model: the Chief plans to answer directly, calls the fake tools, and writes
// the scripted answer. Everything else (session, recall, checks, Turn persistence) is the real ask().
export function fakeAskDeps(graph: GraphHandle, answer: FakeAnswer, over: { now?: () => number } = {}): AskDeps {
  const names = answer.tools ?? ["search"];
  const nodes = answer.nodes ?? [FAKE_NODE];
  const tool = (name: string): AlleviaTool => ({
    name, description: `fake ${name}`, input: { query: z.string().optional(), ids: z.array(z.string()).optional() },
    async run() { return { data: answer.data ?? { fake: true }, nodes, edges: [], sources: [] }; },
  });
  const tools = new Map([...names, "show_path"].map((n) => [n, tool(n)]));
  const runtime = new FakeRuntime({
    "chief-of-staff:plan": { structured: { steps: [{ agent: "chief-of-staff", task: "Answer directly" }], rationale: "Fake company: the Chief answers directly." } },
    "chief-of-staff:direct": { calls: names.map((name) => ({ name, args: { query: "fake" } })), text: answer.text },
  });
  return {
    runtime, graph,
    getTools: (want) => want.map((n) => tools.get(n)).filter((t): t is AlleviaTool => !!t),
    ...(over.now ? { now: over.now } : {}),
  };
}

async function scratchGraph(): Promise<GraphHandle> {
  const g = await openGraphByName(`allevia_test_eval_${randomBytes(5).toString("hex")}`);
  await ensureIndexes(g);
  return g;
}

// ---------- the run ----------

export interface RunEvalOptions {
  tenant: string;
  set: EvalSet;
  setPath: string;                                         // shown in the report
  items?: EvalItem[];                                      // the selection (default: the whole set)
  mode: "live" | "fake";
  model?: string;                                          // live: override every agent's model
  depsFor?: (item: EvalItem) => AskDeps | Promise<AskDeps>; // default: the real wiring (live) or the fake company (fake)
  reportDir?: string;
  resultsDir?: string;
  date?: string;                                           // IST date, YYYY-MM-DD (default today)
  log?: (line: string) => void;
  onEvent?: (item: EvalItem, e: AgentEvent) => void;       // --verbose: the work log
  signal?: AbortSignal;
}

export interface RunEvalResult {
  scores: ItemScore[];
  summary: Summary;
  reportPath: string;
  resultsPath: string;
  scratchGraph?: string; // fake mode's own graph (already dropped)
}

const fileStem = (o: { date: string; tenant: string; mode: "live" | "fake" }) => `${o.date}-${o.tenant}${o.mode === "fake" ? "-fake" : ""}`;

function readResults(path: string, base: Omit<ResultsFile, "items">): ResultsFile {
  if (existsSync(path)) {
    const r = JSON.parse(readFileSync(path, "utf8")) as ResultsFile;
    return { ...r, ...base, items: r.items ?? {} };
  }
  return { ...base, items: {} };
}

const progress = (i: number, n: number, s: ItemScore): string =>
  `[${i + 1}/${n}] ${s.id.padEnd(28)} ${(s.pass ? "PASS" : s.ok ? "FAIL" : "ERROR").padEnd(5)} hits ${s.hits}/${s.total}` +
  `  checks ${s.failedChecks.length ? s.failedChecks.join("; ") : "ok"}  ${(s.ms / 1000).toFixed(1)}s  agents ${s.agents.join(",")}  tools ${s.toolCalls}  ${s.turnId}`;

export async function runEval(o: RunEvalOptions): Promise<RunEvalResult> {
  const items = o.items ?? o.set.items;
  const date = o.date ?? istDate(Date.now());
  const log = o.log ?? ((s: string) => console.log(s));
  const reportDir = o.reportDir ?? (o.mode === "fake" ? RESULTS_DIR : REPORT_DIR);
  const resultsDir = o.resultsDir ?? RESULTS_DIR;
  const stem = fileStem({ date, tenant: o.tenant, mode: o.mode });
  const reportPath = join(reportDir, `${stem}.md`);
  const resultsPath = join(resultsDir, `${stem}.json`);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(resultsDir, { recursive: true });
  const results = readResults(resultsPath, { tenant: o.tenant, date, mode: o.mode, setPath: o.setPath });

  let own: GraphHandle | undefined;
  let depsFor = o.depsFor;
  if (!depsFor) {
    if (o.mode === "fake") {
      const g = own = await scratchGraph();
      depsFor = (it) => fakeAskDeps(g, defaultFakeAnswer(it));
    } else {
      const { wiring } = await import("../src/agent/wiring.js");
      const deps = await wiring.createAskDeps({ tenant: o.tenant, ...(o.model ? { model: o.model } : {}) });
      depsFor = () => deps;
    }
  }

  const scores: ItemScore[] = [];
  try {
    for (const [i, it] of items.entries()) {
      if (o.signal?.aborted) { log("Stopped."); break; }
      const deps = await depsFor(it);
      const events: AgentEvent[] = [];
      const r = await ask(
        { tenant: o.tenant, question: it.question, channel: "cli" },
        { ...deps, ...(o.signal ? { signal: o.signal } : {}) },
        (e) => { events.push(e); o.onEvent?.(it, e); });
      const error = r.ok ? undefined : events.filter((e): e is Extract<AgentEvent, { type: "error" }> => e.type === "error").at(-1)?.message ?? "the turn failed";
      const s = scoreTurn(it, { ok: r.ok, turnId: r.turnId, answer: r.answer, citations: r.citations, checks: r.checks, agents: r.agents, ms: r.ms, events, ...(error ? { error } : {}) });
      scores.push(s);
      log(progress(i, items.length, s));
      const attempt: Attempt = { ...s, at: Date.now(), model: o.mode === "fake" ? "fake" : o.model ?? null };
      (results.items[it.id] ??= []).push(attempt);
      writeFileSync(resultsPath, `${JSON.stringify(results, null, 1)}\n`);
      const notes = keptNotes(existsSync(reportPath) ? readFileSync(reportPath, "utf8") : undefined);
      writeFileSync(reportPath, renderReport(results, o.set, { notes }));
    }
  } finally {
    if (own) await own.drop();
  }
  return { scores, summary: summarize(scores), reportPath, resultsPath, ...(own ? { scratchGraph: own.name } : {}) };
}

// ---------- re-scoring ----------

// Scores every stored attempt of the day again against the set as it is now, from the Turn saved in the graph (answer,
// citations, checks, agents, event log): an expectation fixed after a run applies to every turn alike, and no model is
// called. Attempts whose Turn is gone keep their old score.
export interface RescoreOptions {
  tenant: string;
  set: EvalSet;
  graph: GraphHandle;
  mode?: "live" | "fake";
  reportDir?: string;
  resultsDir?: string;
  date?: string;
}

interface StoredTurn { answer: string | null; citations: string[] | null; checks: string | null; agents: string[] | null; ms: number | null; events: string | null; status: string | null; error: string | null }

const parse = <T>(s: string | null, fallback: T): T => {
  try { return s ? (JSON.parse(s) as T) : fallback; } catch { return fallback; }
};

export async function rescore(o: RescoreOptions): Promise<{ changed: Array<{ id: string; attempt: number; was: boolean; now: boolean }>; reportPath: string; resultsPath: string }> {
  const mode = o.mode ?? "live";
  const date = o.date ?? istDate(Date.now());
  const stem = fileStem({ date, tenant: o.tenant, mode });
  const reportPath = join(o.reportDir ?? (mode === "fake" ? RESULTS_DIR : REPORT_DIR), `${stem}.md`);
  const resultsPath = join(o.resultsDir ?? RESULTS_DIR, `${stem}.json`);
  if (!existsSync(resultsPath)) throw new Error(`No results to re-score at ${resultsPath}.`);
  const results = JSON.parse(readFileSync(resultsPath, "utf8")) as ResultsFile;
  const changed: Array<{ id: string; attempt: number; was: boolean; now: boolean }> = [];
  for (const it of o.set.items) {
    const attempts = results.items[it.id];
    if (!attempts) continue;
    for (const [i, a] of attempts.entries()) {
      const [t] = await o.graph.roQuery<StoredTurn>(
        `MATCH (t:Turn {id:$id}) RETURN t.answer AS answer, t.citations AS citations, t.checks AS checks, t.agents AS agents, t.ms AS ms,
         t.events AS events, t.status AS status, t.error AS error`, { id: a.turnId });
      const checks = t ? parse<TurnChecks | null>(t.checks, null) : null;
      if (!t || !checks) continue;
      const ok = (t.status ?? "ok") === "ok";
      const s = scoreTurn(it, {
        ok, turnId: a.turnId, answer: t.answer ?? "", citations: t.citations ?? [], checks,
        agents: t.agents ?? [], ms: t.ms ?? a.ms, events: parse<AgentEvent[]>(t.events, []), ...(t.error ? { error: t.error } : {}),
      });
      if (s.pass !== a.pass) changed.push({ id: it.id, attempt: i + 1, was: a.pass, now: s.pass });
      attempts[i] = { ...s, at: a.at, model: a.model };
    }
  }
  writeFileSync(resultsPath, `${JSON.stringify(results, null, 1)}\n`);
  const notes = keptNotes(existsSync(reportPath) ? readFileSync(reportPath, "utf8") : undefined);
  writeFileSync(reportPath, renderReport(results, o.set, { notes }));
  return { changed, reportPath, resultsPath };
}

// ---------- the command ----------

export interface EvalArgs { tenant: string; limit?: number; only?: string[]; tags?: string[]; fake: boolean; model?: string; verbose: boolean; set?: string; rescore?: true }

const USAGE = "Usage: npm run cli -- eval <tenant> [--limit N] [--only id,id] [--tags a,b] [--fake] [--model haiku] [--verbose] [--set path.yaml] [--rescore]";
const list = (s: string | undefined): string[] | undefined => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : undefined);

export function parseEvalArgs(args: string[]): EvalArgs {
  const { values, positionals } = parseArgs({
    args, allowPositionals: true,
    options: {
      limit: { type: "string" }, only: { type: "string" }, tags: { type: "string" }, fake: { type: "boolean" },
      model: { type: "string" }, verbose: { type: "boolean" }, set: { type: "string" }, rescore: { type: "boolean" },
    },
  });
  const [tenant] = positionals;
  if (!tenant) throw new Error(USAGE);
  const limit = values.limit === undefined ? undefined : Number(values.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) throw new Error(`--limit takes a whole number (got "${values.limit}")`);
  return {
    tenant, fake: values.fake === true, verbose: values.verbose === true,
    ...(limit !== undefined ? { limit } : {}), ...(list(values.only) ? { only: list(values.only)! } : {}),
    ...(list(values.tags) ? { tags: list(values.tags)! } : {}), ...(values.model ? { model: values.model } : {}),
    ...(values.set ? { set: values.set } : {}), ...(values.rescore ? { rescore: true as const } : {}),
  };
}

const pct = (a: number, n: number): string => (n ? `${Math.round((a / n) * 100)}%` : "-");

// Runs the command; returns the exit code (0 when every question finished, whatever its score).
export async function evalMain(argv: string[], o: { signal?: AbortSignal; onEvent?: RunEvalOptions["onEvent"] } = {}): Promise<number> {
  let a: EvalArgs;
  try { a = parseEvalArgs(argv); } catch (e) { console.error(e instanceof Error ? e.message : String(e)); return 2; }
  const found = a.set ? { path: resolve(a.set), set: (await import("./set.js")).loadSet(resolve(a.set)) } : findSet(a.tenant);
  const items = selectItems(found.set.items, { ...(a.only ? { only: a.only } : {}), ...(a.tags ? { tags: a.tags } : {}), ...(a.limit !== undefined ? { limit: a.limit } : {}) });
  if (!items.length) { console.error("No questions selected."); return 2; }
  const tenant = found.set.tenant;
  if (a.rescore) {
    const r = await rescore({ tenant, set: found.set, graph: await openGraph(tenant), mode: a.fake ? "fake" : "live" });
    for (const c of r.changed) console.log(`${c.id} attempt ${c.attempt}: ${c.was ? "PASS" : "FAIL"} -> ${c.now ? "PASS" : "FAIL"}`);
    console.log(`Re-scored against ${relative(REPO, found.path)}: ${r.changed.length} verdict(s) changed. Report: ${relative(REPO, r.reportPath)}`);
    return 0;
  }
  console.log(`${a.fake ? "FAKE eval" : "Eval"}: ${tenant}, ${items.length} of ${found.set.items.length} question(s) from ${relative(REPO, found.path)}${a.model ? `, model ${a.model}` : ""}`);
  const r = await runEval({
    tenant, set: found.set, setPath: relative(REPO, found.path), items, mode: a.fake ? "fake" : "live",
    ...(a.model ? { model: a.model } : {}), ...(o.signal ? { signal: o.signal } : {}), ...(o.onEvent ? { onEvent: o.onEvent } : {}),
  });
  const s = r.summary;
  console.log(`\nPassed ${s.passed}/${s.n} · expectations ${s.hits}/${s.total} (${pct(s.hits, s.total)}) · citations ${pct(s.checkRates.citationsValid * s.n, s.n)} · numbers ${pct(s.checkRates.numbersGrounded * s.n, s.n)} · mean ${(s.meanMs / 1000).toFixed(1)}s`);
  console.log(`Report: ${relative(REPO, r.reportPath)}`);
  return s.turnsOk === s.n ? 0 : 1;
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url) || pathToFileURL(invoked).href === import.meta.url) {
  const { interruptible } = await import("../src/cli/_interrupt.js");
  const stop = interruptible();
  const log = process.argv.includes("--verbose") ? (await import("../src/cli/_worklog.js")).workLog() : undefined;
  evalMain(process.argv.slice(2), { signal: stop.signal, ...(log ? { onEvent: (_it: EvalItem, e: AgentEvent) => log(e) } : {}) })
    .catch((e) => { console.error(e instanceof Error ? e.message : String(e)); return 1; })
    .then(async (code) => { stop.dispose(); await closeAll(); process.exit(code); });
}
