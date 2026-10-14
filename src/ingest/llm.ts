// Structured LLM calls for ingestion. AgentSdkRunner runs Claude through the Agent SDK on the founder's subscription:
// an allow-listed env (subscriptionEnv: no API key, token or base URL), no tools, no user/project settings, a fresh
// empty cwd per call (removed afterwards) so no CLAUDE.md is read, no session transcripts on disk, and a JSON-schema
// output format. At most `concurrency` calls run at once. A failed or timed-out call is retried `retries` times after
// a 1-2 s jittered pause; auth/billing failures and aborts are not retried.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { subscriptionEnv } from "../agent/sdk-env.js";

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

// Retrying cannot fix these: the login, the account or the request itself is wrong, or someone aborted the call.
export class FatalLlmError extends LlmError {
  override name = "FatalLlmError";
}
const FATAL_SDK_ERRORS = new Set([
  "authentication_failed", "oauth_org_not_allowed", "account_on_hold", "verification_required", "billing_error",
  "invalid_request", "model_not_found", "cloud_credential_error",
]);
const isFatal = (e: unknown) =>
  e instanceof FatalLlmError || (e instanceof Error && (e.name === "AbortError" || /\babort(ed)?\b/i.test(e.message)));

export interface AgentSdkRunnerOpts {
  concurrency?: number;                        // default 3
  retries?: number;                            // default 1
  timeoutMs?: number;                          // default 120 s per attempt
  maxTurns?: number;                           // default 4 (room for the SDK's own structured-output retries)
  retryDelayMs?: { min: number; max: number }; // default 1-2 s
  cwd?: string;                                // default: a fresh empty temp dir per call, removed afterwards
  queryFn?: QueryFn;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class AgentSdkRunner implements LlmRunner {
  private readonly sem: Semaphore;
  private readonly retries: number;
  private readonly timeoutMs: number;
  private readonly maxTurns: number;
  private readonly retryDelay: { min: number; max: number };
  private readonly queryFn: QueryFn;
  private readonly cwd: string | undefined;

  constructor(opts: AgentSdkRunnerOpts = {}) {
    this.sem = new Semaphore(opts.concurrency ?? 3);
    this.retries = opts.retries ?? 1;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.maxTurns = opts.maxTurns ?? 4;
    this.retryDelay = opts.retryDelayMs ?? { min: 1_000, max: 2_000 };
    this.queryFn = opts.queryFn ?? query;
    this.cwd = opts.cwd;
  }

  structured(input: StructuredInput): Promise<unknown> {
    return this.sem.run(async () => {
      const errors: string[] = [];
      for (let attempt = 0; attempt <= this.retries; attempt++) {
        if (attempt > 0) await sleep(this.retryDelay.min + Math.random() * (this.retryDelay.max - this.retryDelay.min));
        try {
          return await this.once(input);
        } catch (e) {
          errors.push(e instanceof Error ? e.message : String(e));
          if (isFatal(e)) throw new FatalLlmError(`structured call failed (not retried): ${errors.join(" | ")}`);
        }
      }
      throw new LlmError(`structured call failed after ${errors.length} attempt(s): ${errors.join(" | ")}`);
    });
  }

  private async once(input: StructuredInput): Promise<unknown> {
    const cwd = this.cwd ?? mkdtempSync(join(tmpdir(), "allevia-llm-"));
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
          cwd,
          model: input.model,
          systemPrompt: input.system,
          settingSources: [],
          allowedTools: [],
          tools: [],
          permissionMode: "dontAsk",
          maxTurns: this.maxTurns,
          persistSession: false,
          abortController: ac,
          env: subscriptionEnv(),
          outputFormat: { type: "json_schema", schema: input.schema as Record<string, unknown> },
        },
      });
      let sdkError: string | undefined;
      for await (const m of messages) {
        if (m.type === "assistant" && m.error) {
          if (FATAL_SDK_ERRORS.has(m.error)) throw new FatalLlmError(`SDK error ${m.error}`);
          sdkError = m.error;
          continue;
        }
        if (m.type !== "result") continue;
        if (m.subtype === "success" && m.structured_output !== undefined) return m.structured_output;
        throw new Error(`result ${m.subtype}${m.subtype === "success" ? " without structured output" : ""}${sdkError ? ` (${sdkError})` : ""}`);
      }
      throw new Error(`the SDK stream ended without a result${sdkError ? ` (${sdkError})` : ""}`);
    };
    try {
      return await Promise.race([run(), timeout]);
    } finally {
      clearTimeout(timer);
      if (!this.cwd) rmSync(cwd, { recursive: true, force: true });
    }
  }
}
