// ClaudeVision: photos reach the model as base64 image blocks in one streamed user message (no files, no tools), the
// call is locked to the subscription (fails closed on an API key), and answers are cached by everything the model saw.
import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { CachedVision, ClaudeVision, FakeVision, visionKey, type VisionInput, type VisionQueryFn } from "../../src/studio/vision.js";
import { HiggsfieldEngine } from "../../src/studio/engine.js";

const INPUT: VisionInput = {
  agent: "content-strategist", model: "sonnet", system: "You are Tara.", prompt: "Assess it.", schema: { type: "object" },
  images: [{ label: "the owner's photo", mime: "image/jpeg", data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) }],
};

function fakeQuery(apiKeySource: string, answer: unknown, seen: { prompt?: SDKUserMessage[]; options?: Options }): VisionQueryFn {
  return ({ prompt, options }) => (async function* () {
    seen.options = options;
    seen.prompt = [];
    for await (const m of prompt) seen.prompt.push(m);
    yield { type: "system", subtype: "init", apiKeySource } as unknown as SDKMessage;
    yield { type: "result", subtype: "success", is_error: false, structured_output: answer } as unknown as SDKMessage;
  })();
}

describe("studio vision", () => {
  it("sends the photo as a base64 image block with no tools or settings, on the subscription", async () => {
    const seen: { prompt?: SDKUserMessage[]; options?: Options } = {};
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-fake-not-a-real-key-value";
    try {
      const v = new ClaudeVision({ queryFn: fakeQuery("none", { ok: 1 }, seen), log: () => undefined });
      expect(await v.see(INPUT)).toEqual({ ok: 1 });
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prev;
    }
    const msg = seen.prompt![0]!;
    const content = (msg.message as unknown as { content: Array<Record<string, unknown>> }).content;
    expect(content.map((b) => b.type)).toEqual(["text", "image", "text"]);
    expect(content[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/2Q==" } });
    expect(content[2]).toEqual({ type: "text", text: "Assess it." });
    const o = seen.options!;
    expect(o.tools).toEqual([]);
    expect(o.allowedTools).toEqual([]);
    expect(o.settingSources).toEqual([]);
    expect(o.persistSession).toBe(false);
    expect(o.outputFormat).toEqual({ type: "json_schema", schema: { type: "object" } });
    expect(Object.keys(o.env ?? {})).not.toContain("ANTHROPIC_API_KEY");
  });

  it("fails closed when the SDK says the call would use an API key", async () => {
    const v = new ClaudeVision({ queryFn: fakeQuery("ANTHROPIC_API_KEY", { ok: 1 }, {}), log: () => undefined });
    await expect(v.see(INPUT)).rejects.toThrow(/subscription/);
  });

  it("CachedVision answers a repeat from disk, keyed by the image bytes too", async () => {
    const dir = mkdtempSync(join(tmpdir(), "allevia-vision-cache-"));
    try {
      const inner = new FakeVision({ "content-strategist": [{ n: 1 }, { n: 2 }] });
      const c = new CachedVision(inner, dir);
      expect(await c.see(INPUT)).toEqual({ n: 1 });
      expect(await c.see(INPUT)).toEqual({ n: 1 });
      expect(inner.calls).toHaveLength(1);
      const other = { ...INPUT, images: [{ ...INPUT.images[0]!, data: Buffer.from([1, 2, 3]) }] };
      expect(visionKey(other)).not.toBe(visionKey(INPUT));
      expect(await c.see(other)).toEqual({ n: 2 });
      expect(readdirSync(dir)).toHaveLength(2);
      expect({ hits: c.hits, misses: c.misses }).toEqual({ hits: 1, misses: 2 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the Higgsfield engine is a Phase 2 stub that says so", async () => {
    await expect(new HiggsfieldEngine().edit()).rejects.toThrow(/Phase 2/);
  });
});
