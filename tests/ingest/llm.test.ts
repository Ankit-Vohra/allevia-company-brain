import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { AgentSdkRunner, FatalLlmError, LlmError, Semaphore, type QueryFn } from "../../src/ingest/llm.js";

const input = { system: "sys", prompt: "hi", schema: { type: "object" }, model: "haiku" };
const success = (out: unknown) => ({ type: "result", subtype: "success", structured_output: out }) as unknown as SDKMessage;
const failure = (subtype: string) => ({ type: "result", subtype }) as unknown as SDKMessage;
const assistantError = (error: string) => ({ type: "assistant", error, message: { content: [] } }) as unknown as SDKMessage;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const noDelay = { min: 0, max: 0 };

// A fake query(): each call takes the next scripted behaviour.
function fakeQuery(script: Array<(o: Options) => AsyncIterable<SDKMessage>>) {
  const seen: Options[] = [];
  const fn: QueryFn = ({ options }) => {
    seen.push(options);
    const next = script.shift();
    if (!next) throw new Error("unexpected call");
    return next(options);
  };
  return { fn, seen };
}
async function* yields(...ms: SDKMessage[]) {
  for (const m of ms) yield m;
}

describe("Semaphore", () => {
  it("never runs more than its limit at once", async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 7 }, () => sem.run(async () => {
      peak = Math.max(peak, ++active);
      await sleep(5);
      active--;
    })));
    expect(peak).toBe(2);
  });
});

describe("AgentSdkRunner", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "DISCORD_BOT_TOKEN"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("returns structured_output and runs on the subscription with no tools, settings or transcripts", async () => {
    let cwdAtCall: string[] | undefined;
    const { fn, seen } = fakeQuery([(o) => {
      cwdAtCall = readdirSync(o.cwd!);
      return yields({ type: "system" } as SDKMessage, success({ ok: 1 }));
    }]);
    expect(await new AgentSdkRunner({ queryFn: fn }).structured(input)).toEqual({ ok: 1 });
    expect(seen[0]).toMatchObject({
      model: "haiku", systemPrompt: "sys", settingSources: [], allowedTools: [], tools: [], permissionMode: "dontAsk",
      persistSession: false, outputFormat: { type: "json_schema", schema: { type: "object" } },
    });
    expect(cwdAtCall).toEqual([]); // an empty working dir: no CLAUDE.md, no project settings…
    expect(existsSync(seen[0]!.cwd!)).toBe(false); // …removed after the call
  });

  it("never passes a key, token or base URL to the child", async () => {
    Object.assign(process.env, {
      ANTHROPIC_API_KEY: "key-placeholder", ANTHROPIC_AUTH_TOKEN: "token-placeholder", ANTHROPIC_BASE_URL: "https://proxy.example",
      DISCORD_BOT_TOKEN: "discord-placeholder",
    });
    const { fn, seen } = fakeQuery([() => yields(success({}))]);
    await new AgentSdkRunner({ queryFn: fn }).structured(input);
    const env = seen[0]!.env!;
    for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "DISCORD_BOT_TOKEN"]) expect(k in env).toBe(false);
    expect(env.PATH).toBe(process.env.PATH);
  });

  it("retries once after a pause, then gives up with an LlmError", async () => {
    const ok = fakeQuery([() => yields(failure("error_max_structured_output_retries")), () => yields(success({ n: 2 }))]);
    const t0 = Date.now();
    expect(await new AgentSdkRunner({ queryFn: ok.fn, retryDelayMs: { min: 40, max: 60 } }).structured(input)).toEqual({ n: 2 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(39);
    expect(ok.seen).toHaveLength(2);

    const bad = fakeQuery([
      () => { throw new Error("spawn failed"); },
      () => yields(assistantError("overloaded"), success(undefined)),
    ]);
    const err = await new AgentSdkRunner({ queryFn: bad.fn, retryDelayMs: noDelay }).structured(input).catch((e: unknown) => e) as Error;
    expect(err).toBeInstanceOf(LlmError);
    expect(err).not.toBeInstanceOf(FatalLlmError);
    expect(err.message).toMatch(/2 attempt.*spawn failed.*without structured output \(overloaded\)/);
  });

  it("does not retry an auth failure or an abort", async () => {
    const auth = fakeQuery([() => yields(assistantError("authentication_failed"), failure("error_during_execution")), () => yields(success({}))]);
    const e1 = await new AgentSdkRunner({ queryFn: auth.fn, retryDelayMs: noDelay }).structured(input).catch((e: unknown) => e) as Error;
    expect(e1).toBeInstanceOf(FatalLlmError);
    expect(e1.message).toMatch(/authentication_failed/);
    expect(auth.seen).toHaveLength(1);

    const abort = fakeQuery([() => { throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" }); }, () => yields(success({}))]);
    const e2 = await new AgentSdkRunner({ queryFn: abort.fn, retryDelayMs: noDelay }).structured(input).catch((e: unknown) => e) as Error;
    expect(e2).toBeInstanceOf(FatalLlmError);
    expect(abort.seen).toHaveLength(1);
  });

  it("times out a call that hangs, aborts it, and retries the timeout", async () => {
    const aborted: boolean[] = [];
    const hang = (o: Options) => (async function* () {
      await new Promise((r) => o.abortController!.signal.addEventListener("abort", r));
      aborted.push(true);
    })();
    const { fn } = fakeQuery([hang, hang]);
    const err = await new AgentSdkRunner({ queryFn: fn, timeoutMs: 30, retryDelayMs: noDelay }).structured(input).catch((e: unknown) => e) as Error;
    expect(err.message).toMatch(/2 attempt.*timed out after 30 ms/);
    expect(aborted).toEqual([true, true]);
  });

  it("limits concurrent calls (default 3)", async () => {
    let active = 0;
    let peak = 0;
    const slow = () => (async function* () {
      peak = Math.max(peak, ++active);
      await sleep(10);
      active--;
      yield success({});
    })();
    const { fn } = fakeQuery(Array.from({ length: 8 }, () => slow));
    const runner = new AgentSdkRunner({ queryFn: fn });
    await Promise.all(Array.from({ length: 8 }, () => runner.structured(input)));
    expect(peak).toBe(3);
  });
});
