// Claude looking at photos, for Tara's assessment and Nisha's fidelity check. ClaudeVision runs on the founder's Claude
// subscription through the Agent SDK, like AgentSdkRunner (src/ingest/llm.ts): the allow-listed env, no tools, no
// settings, a fresh empty cwd, a JSON-schema answer, and it fails closed unless the SDK's init message says the call is
// on the subscription (assertSubscription). The SDK takes Messages-API content blocks in a streamed user message, so
// the photos go in as base64 image blocks: no scratch files, no Read tool.
//
// CachedVision keeps each answer on disk under a hash of everything the model saw (model, prompts, schema, image
// bytes), so re-running the demo or re-assessing the same upload costs nothing. FakeVision answers tests.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type Options, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { assertSubscription, subscriptionEnv } from "../agent/sdk-env.js";
import { assertTenantSlug, isTenantSlug } from "../graph/slug.js";
import { TENANT_CONFIGS } from "../tenant-config.js";
import { sha256Hex } from "./image.js";

export interface VisionImage { label: string; mime: "image/jpeg" | "image/png" | "image/webp"; data: Buffer }
// A PDF the model reads whole (a brand guide): Claude takes it as a document block.
export interface VisionDocument { label: string; mime: "application/pdf"; data: Buffer }
export interface VisionInput { agent: string; system: string; prompt: string; images: VisionImage[]; documents?: VisionDocument[]; schema: object; model: string }

export interface VisionRunner {
  see(input: VisionInput): Promise<unknown>;
  // A runner whose cached answers are this business's own (CachedVision); a runner with no cache is its own view.
  forTenant?(tenant: string): VisionRunner;
}

export type VisionQueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => AsyncIterable<SDKMessage>;

export class VisionError extends Error {
  override name = "VisionError";
}

// The one user message: each photo after a text line naming it, then the instructions.
export function visionMessage(input: Pick<VisionInput, "prompt" | "images"> & { documents?: VisionDocument[] }): SDKUserMessage {
  const content: Array<Record<string, unknown>> = [];
  for (const d of input.documents ?? []) {
    content.push({ type: "text", text: `Document "${d.label}":` });
    content.push({ type: "document", source: { type: "base64", media_type: d.mime, data: d.data.toString("base64") } });
  }
  for (const img of input.images) {
    content.push({ type: "text", text: `Image "${img.label}":` });
    content.push({ type: "image", source: { type: "base64", media_type: img.mime, data: img.data.toString("base64") } });
  }
  content.push({ type: "text", text: input.prompt });
  return { type: "user", parent_tool_use_id: null, message: { role: "user", content } } as unknown as SDKUserMessage;
}

export interface ClaudeVisionOpts { timeoutMs?: number; maxTurns?: number; queryFn?: VisionQueryFn; log?: (line: string) => void }

export class ClaudeVision implements VisionRunner {
  private readonly timeoutMs: number;
  private readonly maxTurns: number;
  private readonly queryFn: VisionQueryFn;
  private readonly log: (line: string) => void;
  calls = 0;

  constructor(opts: ClaudeVisionOpts = {}) {
    this.timeoutMs = opts.timeoutMs ?? 180_000;
    this.maxTurns = opts.maxTurns ?? 4;
    this.queryFn = opts.queryFn ?? (query as unknown as VisionQueryFn);
    this.log = opts.log ?? ((line) => console.error(line));
  }

  async see(input: VisionInput): Promise<unknown> {
    this.calls++;
    const cwd = mkdtempSync(join(tmpdir(), "allevia-vision-"));
    const ac = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { ac.abort(); reject(new VisionError(`${input.agent}'s look at the photo timed out after ${this.timeoutMs} ms`)); }, this.timeoutMs);
    });
    async function* once(msg: SDKUserMessage): AsyncGenerator<SDKUserMessage> { yield msg; }
    const run = async (): Promise<unknown> => {
      const messages = this.queryFn({
        prompt: once(visionMessage(input)),
        options: {
          cwd, model: input.model, systemPrompt: input.system, settingSources: [], allowedTools: [], tools: [],
          permissionMode: "dontAsk", maxTurns: this.maxTurns, persistSession: false, abortController: ac,
          env: subscriptionEnv(), outputFormat: { type: "json_schema", schema: input.schema as Record<string, unknown> },
        },
      });
      let onSubscription = false;
      let sdkError: string | undefined;
      for await (const m of messages) {
        if (m.type === "system" && m.subtype === "init") {
          try {
            const src = assertSubscription(m);
            this.log(`[studio] ${input.agent} looks at ${input.images.length + (input.documents?.length ?? 0)} file(s) on the subscription (apiKeySource ${JSON.stringify(src)})`);
          } catch (e) {
            ac.abort();
            throw new VisionError((e as Error).message);
          }
          onSubscription = true;
          continue;
        }
        if (m.type === "assistant" && m.error) { sdkError = m.error; continue; }
        if (m.type !== "result") continue;
        if (!onSubscription) throw new VisionError("the SDK answered without an init message, so the call cannot be confirmed to run on the subscription");
        if (m.subtype === "success" && m.structured_output !== undefined) return m.structured_output;
        const said = "result" in m && typeof m.result === "string" ? `: ${m.result.slice(0, 160)}` : "";
        throw new VisionError(`result ${m.subtype}${m.subtype === "success" ? " without structured output" : ""}${sdkError ? ` (${sdkError})` : ""}${said}`);
      }
      throw new VisionError(`the SDK stream ended without a result${sdkError ? ` (${sdkError})` : ""}`);
    };
    try {
      return await Promise.race([run(), timeout]);
    } finally {
      clearTimeout(timer);
      rmSync(cwd, { recursive: true, force: true });
    }
  }
}

// The cache key: everything that could change the answer.
export function visionKey(input: VisionInput): string {
  return sha256Hex(Buffer.from(JSON.stringify({
    model: input.model, system: input.system, prompt: input.prompt, schema: input.schema,
    images: input.images.map((i) => [i.label, i.mime, sha256Hex(i.data)]),
    ...(input.documents?.length ? { documents: input.documents.map((d) => [d.label, d.mime, sha256Hex(d.data)]) } : {}),
  })));
}

// Answers cached on disk by everything that could change them. `forTenant` gives a view whose folder is the business's own
// (<dir>/<tenant>/): the same photo sent by two businesses is answered for each, never replayed from the other's answer.
// The founder's own businesses also read the shared folder of earlier versions (<dir>/) and copy a hit into their own.
// Used without forTenant it keeps its single folder (scripts and tests).
export class CachedVision implements VisionRunner {
  constructor(
    private inner: VisionRunner, private dir: string, private legacyDir?: string, private tally = { hits: 0, misses: 0 },
    private readonly owner?: string,
  ) {}

  get hits(): number { return this.tally.hits; }   // one tally for the cache and every business's view of it
  get misses(): number { return this.tally.misses; }

  // Asking a business's own view for a view again is the same view; for another business's it is a wiring mistake.
  forTenant(tenant: string): VisionRunner {
    if (this.owner !== undefined) {
      if (this.owner !== tenant) throw new Error(`this photo-reading cache is ${this.owner}'s, not ${tenant}'s`);
      return this;
    }
    return new CachedVision(this.inner, tenantFolder(this.dir, tenant), Object.hasOwn(TENANT_CONFIGS, tenant) ? this.dir : undefined, this.tally, tenant);
  }

  async see(input: VisionInput): Promise<unknown> {
    const name = `${visionKey(input)}.json`;
    const file = join(this.dir, name);
    if (existsSync(file)) {
      this.tally.hits++;
      return (JSON.parse(readFileSync(file, "utf8")) as { output: unknown }).output;
    }
    const old = this.legacyDir ? join(this.legacyDir, name) : undefined;
    if (old && existsSync(old)) {
      this.tally.hits++;
      const text = readFileSync(old, "utf8");
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(file, text);
      return (JSON.parse(text) as { output: unknown }).output;
    }
    this.tally.misses++;
    const output = await this.inner.see(input);
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ agent: input.agent, model: input.model, at: new Date().toISOString(), output }, null, 2));
    return output;
  }
}

const tenantFolder = (dir: string, tenant: string): string => join(dir, assertTenantSlug(tenant));

// The runner to use for a call made on this business's graph handle (`allevia_<slug>`): its own view of the cache. Whatever
// the caller (the Studio run, a revision, a video's first frame, Discord's #studio), a photo is read through the cache of the
// graph it belongs to. A graph whose name is not a tenant's (a scratch graph) gets the runner as it is.
export function visionForGraph(vision: VisionRunner, graphName: string): VisionRunner {
  const slug = graphName.replace(/^allevia_/, "");
  return graphName.startsWith("allevia_") && isTenantSlug(slug) ? vision.forTenant?.(slug) ?? vision : vision;
}

// Tests: answers per agent (a value, a list consumed in order, or a function of the input); records every call.
export class FakeVision implements VisionRunner {
  readonly calls: VisionInput[] = [];
  private n = new Map<string, number>();
  constructor(private answers: Record<string, unknown | unknown[] | ((input: VisionInput) => unknown)>) {}

  async see(input: VisionInput): Promise<unknown> {
    this.calls.push(input);
    const a = this.answers[input.agent];
    if (a === undefined) throw new VisionError(`no fake answer for ${input.agent}`);
    if (typeof a === "function") return (a as (i: VisionInput) => unknown)(input);
    if (Array.isArray(a)) {
      const i = this.n.get(input.agent) ?? 0;
      this.n.set(input.agent, i + 1);
      return a[Math.min(i, a.length - 1)];
    }
    return a;
  }
}
