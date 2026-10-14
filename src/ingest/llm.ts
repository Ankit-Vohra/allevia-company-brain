// Structured LLM calls for ingestion. AgentSdkRunner runs Claude through the Agent SDK on the founder's subscription:
// no API key (ANTHROPIC_API_KEY is removed from the child's env), no tools, no user/project settings, an empty cwd so no
// CLAUDE.md is read, no session transcripts on disk, and a JSON-schema output format. At most `concurrency` calls run
// at once; a failed or timed-out call is retried `retries` times.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export interface StructuredInput { system: string; prompt: string; schema: object; model: string }

export interface LlmRunner {
  structured(input: StructuredInput): Promise<unknown>;
}

// The slice of the SDK's query() the runner uses; tests pass a fake.
export type QueryFn = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(readonly limit: number) {
    if (!(Number.isInteger(limit) && limit > 0)) throw new Error(`semaphore limit must be a positive integer, got ${limit}`);
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active < this.limit) this.active++;
    else await new Promise<void>((resolve) => this.waiting.push(resolve)); // the releasing call hands its slot over
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

export class LlmError extends Error {
  override name = "LlmError";
}

export interface AgentSdkRunnerOpts {
  concurrency?: number;   // default 3
  retries?: number;       // default 1
  timeoutMs?: number;     // default 120 s per attempt
  maxTurns?: number;      // default 4 (room for the SDK's own structured-output retries)
  cwd?: string;           // default: a fresh empty temp dir
  queryFn?: QueryFn;
}

// Child env: everything except the API key (calls must run on the subscription) and the marker that would make the
// CLI think it is nested inside another Claude Code session.
export function childEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const out = { ...env };
  delete out.ANTHROPIC_API_KEY;
  delete out.CLAUDECODE;
  return out;
}

export class AgentSdkRunner implements LlmRunner {
  private readonly sem: Semaphore;
  private readonly retries: number;
  private readonly timeoutMs: number;
  private readonly maxTurns: number;
  private readonly queryFn: QueryFn;
  private cwd: string | undefined;

  constructor(opts: AgentSdkRunnerOpts = {}) {
    this.sem = new Semaphore(opts.concurrency ?? 3);
    this.retries = opts.retries ?? 1;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.maxTurns = opts.maxTurns ?? 4;
    this.queryFn = opts.queryFn ?? query;
    this.cwd = opts.cwd;
  }

  structured(input: StructuredInput): Promise<unknown> {
    return this.sem.run(async () => {
      const errors: string[] = [];
      for (let attempt = 0; attempt <= this.retries; attempt++) {
        try {
          return await this.once(input);
        } catch (e) {
          errors.push(e instanceof Error ? e.message : String(e));
        }
      }
      throw new LlmError(`structured call failed after ${errors.length} attempt(s): ${errors.join(" | ")}`);
    });
  }

  private async once(input: StructuredInput): Promise<unknown> {
    this.cwd ??= mkdtempSync(join(tmpdir(), "allevia-llm-"));
    const ac = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ac.abort();
        reject(new Error(`timed out after ${this.timeoutMs} ms`));
      }, this.timeoutMs);
    });
    const run = async (): Promise<unknown> => {
      const messages = this.queryFn({
        prompt: input.prompt,
        options: {
          cwd: this.cwd,
          model: input.model,
          systemPrompt: input.system,
          settingSources: [],
          allowedTools: [],
          tools: [],
          permissionMode: "dontAsk",
          maxTurns: this.maxTurns,
          persistSession: false,
          abortController: ac,
          env: childEnv(),
          outputFormat: { type: "json_schema", schema: input.schema as Record<string, unknown> },
        },
      });
      for await (const m of messages) {
        if (m.type !== "result") continue;
        if (m.subtype === "success" && m.structured_output !== undefined) return m.structured_output;
        throw new Error(`result ${m.subtype}${m.subtype === "success" ? " without structured output" : ""}`);
      }
      throw new Error("the SDK stream ended without a result");
    };
    try {
      return await Promise.race([run(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
