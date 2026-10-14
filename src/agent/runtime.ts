// Agent runtimes. One `run` = one agent doing one job (plan, work, review, revise, synthesise) with only its tools.
// Every tool call goes through `invokeTool`, the single place that (a) emits the attributed tool_call and a human
// agent_status line, (b) runs the tool bound to the turn's ToolContext, (c) records the result in ctx.touched (what the
// answer checks verify against), (d) emits tool_result with the nodes it touched, and (e) hands the model compact JSON.
// Tool errors never crash a run: the model gets "error: …" and the work log gets a status line.
//
// ClaudeAgentSdkRuntime runs on the founder's Claude subscription through the Agent SDK (settings verified in
// scripts/spikes/agent-sdk.ts): no user settings, no built-in tools, only our MCP tools, ANTHROPIC_API_KEY removed.
// FakeRuntime follows a script per agent and drives the same invokeTool path, for tests.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { AgentEvent, ToolResult } from "../../shared/contracts.js";
import type { AlleviaTool, ToolContext } from "./tool.js";

export type Emit = (e: AgentEvent) => void;
export type RunPhase = "plan" | "work" | "review" | "revise" | "synthesis" | "direct";

export interface RunInput {
  agentId: string;
  model: string;
  system: string;
  prompt: string;
  tools: AlleviaTool[];
  ctx: ToolContext;
  outputSchema?: object;
  streamText?: boolean;
  maxTurns?: number;
  phase?: RunPhase;      // which job this is (FakeRuntime scripts key on it; the SDK ignores it)
  signal?: AbortSignal;  // aborts the run (the orchestrator's per-agent timeout)
  // Called after each successful tool call, right after its tool_result event (the orchestrator turns show_path and
  // propose_action results into path/proposal events here).
  onToolResult?: (call: { agent: string; id: string; name: string; args: unknown; result: ToolResult }) => void;
}

export interface RunOutput { text: string; structured?: unknown }

export interface AgentRuntime {
  run(input: RunInput, emit: Emit): Promise<RunOutput>;
}

// ---------- the shared tool path ----------

const MAX_MODEL_JSON = 16_000;
const MAX_SUMMARY = 140;

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

function argStr(args: unknown, ...keys: string[]): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  for (const k of keys) {
    const v = a[k];
    if (typeof v === "string" && v.trim()) return clip(v.trim(), 60);
    if (Array.isArray(v) && v.length && typeof v[0] === "string") return clip(v.slice(0, 3).join(", "), 60);
  }
  return "";
}

const ID_KEYS = ["id", "entity", "entityId", "node", "nodeId", "ids"];

// "Opening page:x" when the call names its subject, "Opening an entity" when it doesn't.
const phrase = (keys: string[], said: (x: string) => string, plain: string) => (a: unknown): string => {
  const x = argStr(a, ...keys);
  return x ? said(x) : plain;
};

// One human line per tool call for the office speech bubble and the work log.
const STATUS: Record<string, (a: unknown) => string> = {
  search: phrase(["query", "q", "text"], (x) => `Searching the graph for "${x}"`, "Searching the graph"),
  recall: phrase(["query", ...ID_KEYS], (x) => `Recalling what we know about ${x}`, "Recalling what we already know"),
  get_entity: phrase([...ID_KEYS, "name"], (x) => `Opening ${x}`, "Opening an entity"),
  neighbors: phrase(ID_KEYS, (x) => `Looking around ${x}`, "Looking at what's connected"),
  find_paths: (a) => `Tracing how ${argStr(a, "from", "source", "a") || "one thing"} connects to ${argStr(a, "to", "target", "b") || "another"}`,
  show_path: () => "Drawing the explanation path",
  remember: () => "Saving a note to memory",
  propose_action: phrase(["title", "kind"], (x) => `Drafting a proposal: ${x}`, "Drafting a proposal"),
  metric_trend: phrase(["metric", "name"], (x) => `Checking the ${x} trend`, "Checking a metric trend"),
  important: () => "Ranking what matters most",
  topics: () => "Mapping the topics",
  cypher: () => "Running a read-only graph query",
  seo_report: () => "Reading the SEO report",
  content_performance: () => "Comparing content performance",
  ad_report: () => "Reading ad results (simulated)",
  playbook: phrase(["topic", "query", "name"], (x) => `Reading the ${x} playbook`, "Reading the playbook"),
  impact_of: phrase(ID_KEYS, (x) => `Checking what depends on ${x}`, "Checking what depends on it"),
  who_owns: phrase([...ID_KEYS, "query"], (x) => `Finding who owns ${x}`, "Finding the owner"),
  who_knows: phrase(["topic", "query", ...ID_KEYS], (x) => `Finding who knows about ${x}`, "Finding who knows"),
  trace_decision: phrase([...ID_KEYS, "query"], (x) => `Tracing the decision ${x}`, "Tracing a decision"),
  history: phrase(ID_KEYS, (x) => `Reading the history of ${x}`, "Reading the history"),
};

export function statusLine(name: string, args: unknown): string {
  const f = STATUS[name];
  return clip(f ? f(args) : `Using ${name.replace(/_/g, " ")}`, 120);
}

// A short, data-derived line for the work log: how much came back and the first few names.
export function summarise(r: ToolResult): string {
  const d = r.data as unknown;
  let count: number | undefined;
  if (Array.isArray(d)) count = d.length;
  else if (d && typeof d === "object") {
    const arr = Object.values(d as Record<string, unknown>).find(Array.isArray) as unknown[] | undefined;
    if (arr) count = arr.length;
  }
  const names = r.nodes.slice(0, 3).map((n) => n.name).filter(Boolean);
  const parts: string[] = [];
  if (count !== undefined) parts.push(`${count} result${count === 1 ? "" : "s"}`);
  else if (r.nodes.length) parts.push(`${r.nodes.length} node${r.nodes.length === 1 ? "" : "s"}`);
  if (names.length) parts.push(names.join(", ") + (r.nodes.length > 3 ? ` +${r.nodes.length - 3}` : ""));
  if (!parts.length) {
    const s = typeof d === "string" ? d : JSON.stringify(d ?? null);
    parts.push(s === "null" || s === "{}" || s === "[]" ? "nothing found" : s);
  }
  if (r.note) parts.push(r.note);
  return clip(parts.join(" · "), MAX_SUMMARY);
}

// What the model sees: data, sources and the ids it may cite. Clipped so one tool can't flood the context.
export function forModel(r: ToolResult): string {
  const body: Record<string, unknown> = { data: r.data, ids: r.nodes.map((n) => n.id) };
  if (r.sources.length) body.sources = r.sources;
  if (r.nodes.some((n) => n.simulated)) body.simulated = r.nodes.filter((n) => n.simulated).map((n) => n.id);
  if (r.note) body.note = r.note;
  const s = JSON.stringify(body);
  return s.length <= MAX_MODEL_JSON ? s : `${s.slice(0, MAX_MODEL_JSON)}… [truncated: ask for fewer rows]`;
}

export interface ToolCallOutcome { text: string; isError: boolean; result?: ToolResult }

// The single path every tool call takes, in both runtimes.
export async function invokeTool(tool: AlleviaTool, rawArgs: unknown, input: RunInput, emit: Emit, callId: string): Promise<ToolCallOutcome> {
  const agent = input.agentId;
  emit({ type: "tool_call", agent, id: callId, name: tool.name, args: rawArgs ?? {} });
  emit({ type: "agent_status", agent, text: statusLine(tool.name, rawArgs) });
  try {
    const parsed = z.object(tool.input).safeParse(rawArgs ?? {});
    if (!parsed.success) throw new Error(`bad arguments: ${parsed.error.issues.map((i) => `${i.path.join(".") || "args"} ${i.message}`).join("; ")}`);
    const ctx: ToolContext = { ...input.ctx, agentId: agent };
    const result = await tool.run(parsed.data, ctx);
    input.ctx.touched.add(result);
    emit({ type: "tool_result", agent, id: callId, name: tool.name, summary: summarise(result), nodes: result.nodes, edges: result.edges, sources: result.sources });
    input.onToolResult?.({ agent, id: callId, name: tool.name, args: parsed.data, result });
    return { text: forModel(result), isError: false, result };
  } catch (e) {
    const msg = clip(e instanceof Error ? e.message : String(e), 300);
    emit({ type: "agent_status", agent, text: clip(`Couldn't use ${tool.name}: ${msg}`, 120) });
    emit({ type: "tool_result", agent, id: callId, name: tool.name, summary: clip(`error: ${msg}`, MAX_SUMMARY), nodes: [], edges: [], sources: [] });
    return { text: `error: ${msg}`, isError: true };
  }
}

let callSeq = 0;
export const nextCallId = (agentId: string): string => `${agentId}#${++callSeq}`;

// ---------- Claude Agent SDK ----------

type QueryFn = typeof import("@anthropic-ai/claude-agent-sdk").query;

export interface SdkRuntimeOpts {
  cwd?: string;                 // default: one empty temp dir per process (no CLAUDE.md, no project settings)
  env?: NodeJS.ProcessEnv;      // default: process.env; ANTHROPIC_API_KEY is always removed
}

let scratch: string | undefined;
const scratchDir = (): string => (scratch ??= mkdtempSync(join(tmpdir(), "allevia-agent-")));

export const MCP_SERVER = "allevia";
export const sdkToolName = (name: string): string => `mcp__${MCP_SERVER}__${name}`;

// Folds SDK stream messages into text/structured output and streamed `text` events. Pure, so it is unit-tested.
export class SdkMessageFolder {
  private texts: string[] = [];
  result?: { ok: boolean; text?: string; structured?: unknown; error?: string };

  constructor(private agentId: string, private streamText: boolean, private emit: Emit) {}

  push(m: unknown): void {
    const msg = m as { type?: string; subtype?: string; parent_tool_use_id?: string | null; [k: string]: unknown };
    if (msg.parent_tool_use_id) return; // nested agents' chatter is not this agent's answer
    if (msg.type === "stream_event" && this.streamText) {
      const ev = msg.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
      if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
        this.emit({ type: "text", agent: this.agentId, delta: ev.delta.text });
      }
    } else if (msg.type === "assistant") {
      const content = (msg.message as { content?: Array<{ type: string; text?: string }> } | undefined)?.content ?? [];
      const text = content.filter((b) => b.type === "text" && b.text).map((b) => b.text!).join("");
      if (text.trim()) this.texts.push(text);
    } else if (msg.type === "result") {
      if (msg.subtype === "success" && !msg.is_error) {
        this.result = { ok: true, text: typeof msg.result === "string" ? msg.result : undefined, structured: msg.structured_output };
      } else {
        const errs = Array.isArray(msg.errors) ? (msg.errors as string[]).join("; ") : "";
        this.result = { ok: false, error: `${msg.subtype ?? "error"}${errs ? `: ${errs}` : typeof msg.result === "string" ? `: ${msg.result}` : ""}` };
      }
    }
  }

  // Every top-level assistant text block, in order: an answer written before the final show_path call is kept even
  // though the SDK's `result` only carries the last message.
  output(): RunOutput {
    if (!this.result) throw new Error("agent run ended without a result");
    if (!this.result.ok) throw new Error(this.result.error ?? "agent run failed");
    const text = this.texts.length ? this.texts.join("\n\n") : this.result.text ?? "";
    return this.result.structured === undefined ? { text } : { text, structured: this.result.structured };
  }
}

export class ClaudeAgentSdkRuntime implements AgentRuntime {
  constructor(private opts: SdkRuntimeOpts = {}) {}

  async run(input: RunInput, emit: Emit): Promise<RunOutput> {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const query: QueryFn = sdk.query;
    const tools = input.tools.map((t) =>
      sdk.tool(t.name, t.description, t.input, async (args: unknown) => {
        const r = await invokeTool(t, args, input, emit, nextCallId(input.agentId));
        return { content: [{ type: "text" as const, text: r.text }], ...(r.isError ? { isError: true } : {}) };
      }));
    const env = { ...(this.opts.env ?? process.env) };
    delete env.ANTHROPIC_API_KEY;
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    if (input.signal?.aborted) abort.abort();
    input.signal?.addEventListener("abort", onAbort, { once: true });

    const folder = new SdkMessageFolder(input.agentId, !!input.streamText, emit);
    try {
      const q = query({
        prompt: input.prompt,
        options: {
          cwd: this.opts.cwd ?? scratchDir(),
          model: input.model,
          systemPrompt: input.system,
          settingSources: [],
          mcpServers: tools.length ? { [MCP_SERVER]: sdk.createSdkMcpServer({ name: MCP_SERVER, version: "0.1.0", tools }) } : {},
          allowedTools: input.tools.map((t) => sdkToolName(t.name)),
          tools: [],
          permissionMode: "dontAsk",
          includePartialMessages: !!input.streamText,
          maxTurns: input.maxTurns ?? 10,
          env,
          abortController: abort,
          ...(input.outputSchema ? { outputFormat: { type: "json_schema" as const, schema: input.outputSchema as Record<string, unknown> } } : {}),
        },
      });
      for await (const m of q) folder.push(m);
    } catch (e) {
      if (input.signal?.aborted) throw new Error(`${input.agentId} was stopped (timeout)`);
      throw e;
    } finally {
      input.signal?.removeEventListener("abort", onAbort);
    }
    return folder.output();
  }
}

// ---------- FakeRuntime (tests) ----------

export interface FakeStep {
  calls?: Array<{ name: string; args?: unknown }>; // tool calls to make, in order, through invokeTool
  text?: string;                                   // final text (streamed as `text` deltas when streamText)
  structured?: unknown;
  delayMs?: number;                                // wait before answering (respects the abort signal)
  fail?: string;                                   // throw this error instead of answering
}
export type FakeScript = FakeStep | FakeStep[] | ((input: RunInput, n: number) => FakeStep);

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true });
  });

// Scripts are keyed "<agentId>:<phase>" first, then "<agentId>". An array is consumed one step per run; a function
// gets the run input and how many times that key has run before.
export class FakeRuntime implements AgentRuntime {
  readonly runs: RunInput[] = [];
  private counts = new Map<string, number>();

  constructor(private scripts: Record<string, FakeScript>) {}

  private step(input: RunInput): FakeStep {
    const key = [`${input.agentId}:${input.phase}`, input.agentId].find((k) => k in this.scripts);
    if (!key) return { text: "", structured: undefined };
    const n = this.counts.get(key) ?? 0;
    this.counts.set(key, n + 1);
    const s = this.scripts[key]!;
    if (typeof s === "function") return s(input, n);
    if (Array.isArray(s)) return s[Math.min(n, s.length - 1)] ?? {};
    return s;
  }

  async run(input: RunInput, emit: Emit): Promise<RunOutput> {
    this.runs.push(input);
    const st = this.step(input);
    if (st.delayMs) await sleep(st.delayMs, input.signal);
    if (input.signal?.aborted) throw new Error(`${input.agentId} was stopped (timeout)`);
    for (const c of st.calls ?? []) {
      const tool = input.tools.find((t) => t.name === c.name);
      if (!tool) {
        emit({ type: "agent_status", agent: input.agentId, text: `No tool named ${c.name}` });
        continue;
      }
      await invokeTool(tool, c.args ?? {}, input, emit, nextCallId(input.agentId));
    }
    if (st.fail) throw new Error(st.fail);
    const text = st.text ?? "";
    if (input.streamText && text) {
      for (const piece of text.match(/[\s\S]{1,40}/g) ?? []) emit({ type: "text", agent: input.agentId, delta: piece });
    }
    return st.structured === undefined ? { text } : { text, structured: st.structured };
  }
}
