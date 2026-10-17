// Efficiency benchmark (docs/graph-audit.md, README "Why FalkorDB does real work"): does an agent that follows a few hops in
// the graph answer with fewer tokens and less waiting than a model that is handed all the documents?
//
// Three arms, one question each, the same model and the same answer-style rules, all on the Claude subscription (no API key):
//   stuff - "reread the documents": one model call whose prompt holds the whole corpus (no tools, no graph).
//             demo_growth: every document, chunk, record and reading in the graph, as text (--corpus graph, the default;
//             Shiftly has no files outside the graph). aamdani: the vault's own markdown files (--corpus vault), the
//             documents the brain was built from.
//   solo  - one agent with the graph tools (search, get_entity, neighbors, find_paths, trace_decision, who_owns, who_knows,
//             impact_of, important, topics, metric_trend, history, recall, cypher): no documents in the prompt.
//   team  - the product as it ships: ask() with `ephemeral` (nothing is written), The Chief plans, desks work, reviewers
//             check, The Chief answers. Sums every agent run.
// Tokens are the Agent SDK's own usage numbers for each run ("read" = fresh + cached + stored prompt tokens, i.e. everything
// the model had in front of it; "fresh" = not served from the prompt cache). Time is wall-clock for the whole answer.
// Correctness is crude on purpose: regexes for what a right answer must say (the same ones the eval sets use).
//
// Usage: npx tsx scripts/bench-efficiency.ts <shiftly|aamdani> [--arms stuff,solo,team] [--only id,id] [--corpus graph|vault]
//   Reads only: both tenants are opened for reading and nothing is saved (the stuff and solo arms never write; the team arm
//   runs with ephemeral + readOnly). Results go to data/bench/<date>-<set>.json (gitignored) and a table on stdout.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.js";
import { closeAll, openGraph, type GraphHandle } from "../src/graph/client.js";
import { ask } from "../src/agent/ask.js";
import { checkTurn } from "../src/agent/checks.js";
import { createAskDeps, localEmbedder } from "../src/agent/wiring.js";
import { addUsage, EMPTY_USAGE, forModel, tokensRead, toolNameNote, type RunInput, type Usage } from "../src/agent/runtime.js";
import { TouchedSet, type AlleviaTool, type ToolContext } from "../src/agent/tool.js";
import { toolsByName } from "../src/agent/tools/index.js";
import type { AgentEvent } from "../shared/contracts.js";

interface Q { id: string; question: string; match: RegExp[]; note: string }
interface Set { tenant: string; label: string; corpus: "graph" | "vault"; questions: Q[] }

const SETS: Record<string, Set> = {
  shiftly: {
    tenant: "demo_growth", label: "Shiftly (synthetic shift-jobs app, the public hero demo)", corpus: "graph",
    questions: [
      { id: "hero-why", question: "Why did sign-ups drop this week, and what should we do?", note: "cause, chain, a few hops across number, step, screen, crash, release",
        match: [/phone/i, /2\.8\.0/, /sign-?up screen/i, /7 Oct|2026-10-07|October 7/i] },
      { id: "impact", question: "What else breaks if the sign-up screen keeps crashing?", note: "depth 1 against depth 4",
        match: [/employer|alert|referral|first application/i, /sign-?up/i] },
      { id: "ads-trap", question: "Did pausing the Meta ads cause the sign-up drop?", note: "a tempting cause the dates rule out",
        match: [/\bno\b|not|didn.t|rules? out/i, /before|earlier|7 Oct|2026-10-07|October 7/i] },
    ],
  },
  aamdani: {
    tenant: "aamdani", label: "Aamdani (a real business, read-only)", corpus: "vault",
    questions: [
      { id: "instagram-token", question: "What breaks if the Instagram token expires?", note: "impact over DEPENDS_ON/AFFECTS from a system",
        match: [/instagram/i, /post|publish|reel|insights|attribution/i] },
      { id: "pause-stories", question: "Why did we pause daily stories and image posts?", note: "a decision, its evidence and its date",
        match: [/poor|quality|effort|never reviewed|not reviewed/i, /reels?/i] },
    ],
  },
};

const GRAPH_TOOLS = ["search", "get_entity", "neighbors", "find_paths", "trace_decision", "who_owns", "who_knows", "impact_of", "important", "topics", "metric_trend", "history", "recall", "cypher"];
const STYLE = "Lead with the answer in plain words, at most about 200 words, name the date of each fact, and say plainly what is not in what you were given. Do not invent anything.";
const SYSTEM_STUFF = `You answer a business owner's question using ONLY the documents and records given in the prompt. ${STYLE}`;
const SYSTEM_SOLO = `You answer a business owner's question using ONLY the graph tools, which read the business's own records. Search, then follow the links between things (what depends on what, who decided, what happened when) instead of guessing, and cite the ids you used as [[id]]. ${STYLE}`;

const TIMEOUT_MS = 420_000;
const fmt = (n: number): string => n.toLocaleString("en-US");
const approxTokens = (s: string): number => Math.round(s.length / 4);

// ---------- the corpora ----------

async function graphCorpus(g: GraphHandle): Promise<string> {
  const out: string[] = [];
  const docs = await g.roQuery<{ id: string; name: string | null; asOf: string | null; kind: string | null; chunks: Array<string | null> }>(
    `MATCH (d:Entity:Document) OPTIONAL MATCH (d)-[:HAS_CHUNK]->(c:Entity:Chunk)
     WITH d, collect(c.text) AS chunks
     RETURN d.id AS id, d.name AS name, d.asOf AS asOf, d.kind AS kind, chunks ORDER BY d.id`, {}, { timeoutMs: 60_000 });
  out.push("# Documents");
  for (const d of docs) out.push(`## ${d.name ?? d.id} (${d.kind ?? "document"}, ${d.asOf ?? "undated"})\n${d.chunks.filter(Boolean).join("\n")}`);
  const recs = await g.roQuery<{ id: string; l: string; name: string | null; summary: string | null; asOf: string | null }>(
    `MATCH (n:Entity) WHERE NOT (n:Chunk OR n:Document OR n:Observation OR n:Turn OR n:Session OR n:Finding OR n:Version OR n:Agent OR n:Capability OR n:Memory OR n:Approval OR n:Recommendation OR n:Action)
     RETURN n.id AS id, [x IN labels(n) WHERE x <> 'Entity' AND x <> 'Searchable'][0] AS l, n.name AS name, n.summary AS summary, n.asOf AS asOf ORDER BY n.id`, {}, { timeoutMs: 60_000 });
  out.push("# Records");
  for (const r of recs) out.push(`- ${r.l}: ${r.name ?? r.id}${r.summary ? ` - ${r.summary}` : ""}${r.asOf ? ` (${r.asOf})` : ""}`);
  const obs = await g.roQuery<{ metric: string; subject: string; d: string; v: number }>(
    "MATCH (o:Entity:Observation) RETURN o.metric AS metric, o.subject AS subject, o.asOf AS d, o.value AS v ORDER BY o.metric, o.subject, o.asOf, o.id", {}, { timeoutMs: 60_000 });
  out.push("# Readings (metric of subject: date=value)");
  let key = "";
  let line: string[] = [];
  const flush = (): void => { if (line.length) out.push(`${key}: ${line.join(", ")}`); line = []; };
  for (const o of obs) {
    const k = `${o.metric} of ${o.subject}`;
    if (k !== key) { flush(); key = k; }
    line.push(`${o.d}=${o.v}`);
  }
  flush();
  return out.join("\n");
}

function vaultCorpus(root: string): { text: string; files: number } {
  const parts: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith(".")) continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.endsWith(".md")) parts.push(`## FILE ${relative(root, p)}\n${readFileSync(p, "utf8")}`);
    }
  };
  walk(root);
  return { text: parts.join("\n\n"), files: parts.length };
}

// ---------- one arm ----------

interface ArmResult {
  arm: "stuff" | "solo" | "team";
  ok: boolean;
  error?: string;
  ms: number;
  usage: Usage;
  tokensRead: number;
  tokensFresh: number;
  tokensOut: number;
  toolCalls: number;
  nodesTouched: number;
  /** What the tools handed the model, in tokens (4 characters each): the business data it actually read, against the corpus. */
  evidenceTokens: number;
  answer: string;
  hits: number;
  hitsOf: number;
  checksOk?: boolean;
  promptTokensEstimate?: number;
}

// Counts what each tool call handed to the model (the compact JSON the runtime sends: forModel), so "how much of the business
// did it have to read" is measured, not guessed.
function metered(tools: AlleviaTool[], counter: { chars: number }): AlleviaTool[] {
  return tools.map((t) => ({ ...t, run: async (args, ctx) => { const r = await t.run(args, ctx); counter.chars += forModel(r).length; return r; } }));
}

const hits = (q: Q, answer: string): number => q.match.filter((r) => r.test(answer)).length;

function ctxFor(g: GraphHandle, tenant: string, embedQuery: ToolContext["embedQuery"], now: number): ToolContext {
  return { graph: g, tenant, turnId: "bench", agentId: "chief-of-staff", asker: "person:founder", touched: new TouchedSet(), now, readOnly: true, ...(embedQuery ? { embedQuery } : {}) };
}

const withTimeout = (): { signal: AbortSignal; done: () => void } => {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(new Error(`timed out after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS);
  return { signal: c.signal, done: () => clearTimeout(t) };
};

async function runStuff(runtime: AskDepsRuntime, g: GraphHandle, set: Set, q: Q, corpus: string, model: string): Promise<ArmResult> {
  const events: AgentEvent[] = [];
  const to = withTimeout();
  const t0 = Date.now();
  const input: RunInput = {
    agentId: "chief-of-staff", model, system: SYSTEM_STUFF, prompt: `<documents>\n${corpus}\n</documents>\n\nThe owner asks: ${q.question}`,
    tools: [], ctx: ctxFor(g, set.tenant, undefined, Date.now()), maxTurns: 2, signal: to.signal, phase: "direct",
  };
  try {
    const r = await runtime.run(input, (e) => events.push(e));
    const usage = r.usage ?? EMPTY_USAGE;
    return { arm: "stuff", ok: true, ms: Date.now() - t0, usage, tokensRead: tokensRead(usage), tokensFresh: usage.inputTokens, tokensOut: usage.outputTokens,
      toolCalls: 0, nodesTouched: 0, evidenceTokens: approxTokens(corpus), answer: r.text, hits: hits(q, r.text), hitsOf: q.match.length, promptTokensEstimate: approxTokens(input.prompt + input.system) };
  } catch (e) {
    return failed("stuff", Date.now() - t0, e, q, approxTokens(input.prompt));
  } finally { to.done(); }
}

async function runSolo(runtime: AskDepsRuntime, g: GraphHandle, set: Set, q: Q, model: string, embedQuery: ToolContext["embedQuery"]): Promise<ArmResult> {
  const events: AgentEvent[] = [];
  const to = withTimeout();
  const t0 = Date.now();
  const ctx = ctxFor(g, set.tenant, embedQuery, Date.now());
  const counter = { chars: 0 };
  const tools = metered(toolsByName(GRAPH_TOOLS), counter);
  const input: RunInput = {
    agentId: "chief-of-staff", model, system: SYSTEM_SOLO, prompt: `The owner asks: ${q.question}`, tools, ctx, maxTurns: 14, signal: to.signal, phase: "direct",
  };
  try {
    const r = await runtime.run(input, (e) => events.push(e));
    const usage = r.usage ?? EMPTY_USAGE;
    const checks = checkTurn(r.text, ctx.touched, { now: ctx.now, question: q.question });
    const ok = Object.values(checks).every((v) => (typeof v === "boolean" ? v : true));
    return { arm: "solo", ok: true, ms: Date.now() - t0, usage, tokensRead: tokensRead(usage), tokensFresh: usage.inputTokens, tokensOut: usage.outputTokens,
      toolCalls: events.filter((e) => e.type === "tool_call").length, nodesTouched: ctx.touched.nodes().length, evidenceTokens: approxTokens("x".repeat(counter.chars)), answer: r.text,
      hits: hits(q, r.text), hitsOf: q.match.length, checksOk: ok };
  } catch (e) {
    return failed("solo", Date.now() - t0, e, q);
  } finally { to.done(); }
}

async function runTeam(tenant: string, q: Q, model: string | undefined): Promise<ArmResult> {
  const deps = await createAskDeps({ tenant, ...(model ? { model } : {}) });
  const counter = { chars: 0 };
  const events: AgentEvent[] = [];
  const to = withTimeout();
  const t0 = Date.now();
  try {
    const r = await ask({ tenant, question: q.question, channel: "cli", ephemeral: true }, { ...deps, getTools: (names) => metered(deps.getTools(names), counter), readOnly: true, signal: to.signal }, (e) => events.push(e));
    const usage = r.usage ?? { ...EMPTY_USAGE, toolCalls: 0 };
    const checksOk = Object.values(r.checks).every((v) => (typeof v === "boolean" ? v : Array.isArray(v) ? v.length === 0 : true));
    return { arm: "team", ok: r.ok, ms: Date.now() - t0, usage, tokensRead: tokensRead(usage), tokensFresh: usage.inputTokens, tokensOut: usage.outputTokens,
      toolCalls: usage.toolCalls, nodesTouched: r.outcome?.touched.nodes().length ?? 0, evidenceTokens: approxTokens("x".repeat(counter.chars)), answer: r.answer, hits: hits(q, r.answer), hitsOf: q.match.length, checksOk,
      ...(r.ok ? {} : { error: "the team could not finish" }) };
  } catch (e) {
    return failed("team", Date.now() - t0, e, q);
  } finally { to.done(); }
}

function failed(arm: ArmResult["arm"], ms: number, e: unknown, q: Q, promptTokens?: number): ArmResult {
  return { arm, ok: false, error: e instanceof Error ? e.message : String(e), ms, usage: EMPTY_USAGE, tokensRead: 0, tokensFresh: 0, tokensOut: 0, toolCalls: 0, nodesTouched: 0,
    evidenceTokens: 0, answer: "", hits: 0, hitsOf: q.match.length, ...(promptTokens ? { promptTokensEstimate: promptTokens } : {}) };
}

type AskDepsRuntime = Awaited<ReturnType<typeof createAskDeps>>["runtime"];

// ---------- main ----------

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { arms: { type: "string" }, only: { type: "string" }, corpus: { type: "string" }, model: { type: "string" } } });
  const set = SETS[positionals[0] ?? ""];
  if (!set) { console.error(`Usage: npx tsx scripts/bench-efficiency.ts <${Object.keys(SETS).join("|")}> [--arms stuff,solo,team] [--only id,id] [--corpus graph|vault] [--model sonnet]`); process.exit(2); }
  const arms = new Set((values.arms ?? "stuff,solo,team").split(","));
  const only = values.only ? new Set(values.only.split(",")) : undefined;
  const model = values.model ?? "sonnet";
  const corpusKind = (values.corpus ?? set.corpus) as "graph" | "vault";
  const g = await openGraph(set.tenant);
  const deps = await createAskDeps({ tenant: set.tenant, model });
  const embedQuery = await localEmbedder();
  let corpus = "";
  let corpusNote = "";
  if (arms.has("stuff")) {
    if (corpusKind === "vault") {
      const v = vaultCorpus(loadConfig().brainPath);
      corpus = v.text;
      corpusNote = `the vault's ${v.files} markdown files, ${fmt(v.text.length)} characters, about ${fmt(approxTokens(v.text))} tokens`;
    } else {
      corpus = await graphCorpus(g);
      corpusNote = `every document, chunk, record and reading in the graph as text, ${fmt(corpus.length)} characters, about ${fmt(approxTokens(corpus))} tokens`;
    }
    console.log(`Stuffing corpus for ${set.tenant}: ${corpusNote}`);
  }
  const results: Array<{ q: Q; arms: ArmResult[] }> = [];
  for (const q of set.questions) {
    if (only && !only.has(q.id)) continue;
    console.log(`\n== ${q.id}: ${q.question}`);
    const row: ArmResult[] = [];
    for (const arm of ["stuff", "solo", "team"] as const) {
      if (!arms.has(arm)) continue;
      const r = arm === "stuff" ? await runStuff(deps.runtime, g, set, q, corpus, model)
        : arm === "solo" ? await runSolo(deps.runtime, g, set, q, model, embedQuery)
        : await runTeam(set.tenant, q, model);
      row.push(r);
      console.log(`  ${arm.padEnd(5)} ${r.ok ? "ok " : "ERR"} ${(r.ms / 1000).toFixed(1).padStart(6)}s  read ${fmt(r.tokensRead).padStart(9)}  evidence ${fmt(r.evidenceTokens).padStart(8)}  out ${fmt(r.tokensOut).padStart(6)}  calls ${String(r.usage.modelCalls).padStart(2)}  tools ${String(r.toolCalls).padStart(2)}  nodes ${String(r.nodesTouched).padStart(3)}  says ${r.hits}/${r.hitsOf}${r.checksOk === undefined ? "" : r.checksOk ? "  checks ok" : "  checks FAIL"}${r.error ? `  ${r.error.slice(0, 160)}` : ""}`);
    }
    results.push({ q, arms: row });
  }
  mkdirSync(join(loadConfig().dataDir, "bench"), { recursive: true });
  const file = join(loadConfig().dataDir, "bench", `${new Date().toISOString().slice(0, 10)}-${positionals[0]}.json`);
  writeFileSync(file, JSON.stringify({ set: positionals[0], tenant: set.tenant, model, corpusNote, at: new Date().toISOString(), results: results.map((r) => ({ id: r.q.id, question: r.q.question, note: r.q.note, arms: r.arms })) }, null, 1));
  console.log(`\nSaved ${file}`);
  // a second look at the totals
  const sum = (arm: ArmResult["arm"], pick: (r: ArmResult) => number): number => results.reduce((s, r) => s + r.arms.filter((a) => a.arm === arm).reduce((x, a) => x + pick(a), 0), 0);
  for (const arm of ["stuff", "solo", "team"] as const) {
    if (!arms.has(arm)) continue;
    const u = results.flatMap((r) => r.arms.filter((a) => a.arm === arm)).reduce((s, a) => addUsage(s, a.usage), EMPTY_USAGE);
    console.log(`${arm.padEnd(5)} total over ${results.length} questions: read ${fmt(tokensRead(u))}, fresh ${fmt(u.inputTokens)}, out ${fmt(u.outputTokens)}, ${(sum(arm, (a) => a.ms) / 1000).toFixed(0)}s`);
  }
  void toolNameNote;
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => closeAll());
