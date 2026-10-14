import { describe, it, expect, afterEach } from "vitest";
import { readdirSync } from "node:fs";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { AgentSdkRunner, LlmError, Semaphore, childEnv, type QueryFn } from "../../src/ingest/llm.js";

const input = { system: "sys", prompt: "hi", schema: { type: "object" }, model: "haiku" };
const success = (out: unknown) => ({ type: "result", subtype: "success", structured_output: out }) as unknown as SDKMessage;
const failure = (subtype: string) => ({ type: "result", subtype }) as unknown as SDKMessage;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  const saved = process.env.ANTHROPIC_API_KEY;
  afterEach(() => {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  });

  it("returns structured_output and runs on the subscription with no tools, settings or transcripts", async () => {
    process.env.ANTHROPIC_API_KEY = "test-placeholder";
    const { fn, seen } = fakeQuery([() => yields({ type: "system" } as SDKMessage, success({ ok: 1 }))]);
    expect(await new AgentSdkRunner({ queryFn: fn }).structured(input)).toEqual({ ok: 1 });
    const o = seen[0]!;
    expect(o).toMatchObject({
      model: "haiku", systemPrompt: "sys", settingSources: [], allowedTools: [], tools: [], permissionMode: "dontAsk",
      persistSession: false, outputFormat: { type: "json_schema", schema: { type: "object" } },
    });
    expect(o.env).toBeDefined();
    expect("ANTHROPIC_API_KEY" in o.env!).toBe(false);
    expect(readdirSync(o.cwd!)).toEqual([]); // an empty working dir: no CLAUDE.md, no project settings
  });

  it("retries once, then gives up with an LlmError", async () => {
    const ok = fakeQuery([() => yields(failure("error_max_structured_output_retries")), () => yields(success({ n: 2 }))]);
    expect(await new AgentSdkRunner({ queryFn: ok.fn }).structured(input)).toEqual({ n: 2 });
    expect(ok.seen).toHaveLength(2);

    const bad = fakeQuery([
      () => { throw new Error("spawn failed"); },
      () => yields(success(undefined)),
    ]);
    const err = await new AgentSdkRunner({ queryFn: bad.fn }).structured(input).catch((e: unknown) => e) as Error;
    expect(err).toBeInstanceOf(LlmError);
    expect(err.message).toMatch(/2 attempt.*spawn failed.*without structured output/);
  });

  it("times out a call that hangs, and aborts it", async () => {
    const aborted: boolean[] = [];
    const hang = (o: Options) => (async function* () {
      await new Promise((r) => o.abortController!.signal.addEventListener("abort", r));
      aborted.push(true);
    })();
    const { fn } = fakeQuery([hang, hang]);
    const err = await new AgentSdkRunner({ queryFn: fn, timeoutMs: 30 }).structured(input).catch((e: unknown) => e) as Error;
    expect(err.message).toMatch(/timed out after 30 ms/);
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

  it("childEnv drops the API key and the nested-session marker only", () => {
    expect(childEnv({ ANTHROPIC_API_KEY: "x", CLAUDECODE: "1", PATH: "/bin", HOME: "/h" })).toEqual({ PATH: "/bin", HOME: "/h" });
  });
});
