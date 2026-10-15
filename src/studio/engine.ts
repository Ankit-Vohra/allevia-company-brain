// Generative edits (product design §6, step 6). One interface, several engines, the way AgentRuntime has several
// runtimes:
// - RecordedEngine loads an edit that was generated ahead of time, by key (the original photo's sha256 and the
//   treatment). It is how the demo and the tests run: a real Higgsfield output, made once with the founder's approval,
//   replayed without spending credits. A photo with no recording gets no generative variant (null), never a fake.
// - HiggsfieldEngine (higgsfield.ts) is the production engine: the `higgsfield` CLI on the founder's login, quoted before
//   every generation, capped per run and per day, reserved in a ledger and idempotent by job id.
// - ChainEngine tries engines in order (the recordings first, which are free, then the live one).
// An engine that cannot or must not generate right now throws an EngineDecline: its message is in the owner's words, and
// the Studio still delivers the free local variant and says why.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export interface EditInput {
  image: Buffer;            // the owner's photo, metadata stripped
  mime: "image/jpeg" | "image/png";
  originalSha256: string;   // its sha256 (the recording key)
  tenant?: string;          // whose spend this is (the ledger records it)
}

export interface EditOpts {
  treatment: string;        // e.g. "relight-clean-editorial"
  aspect: "same" | "4:5" | "1:1" | "9:16"; // "same": keep the input's framing (the studio crops afterwards)
  model?: string;           // a model other than the engine's default
  maxCredits?: number;      // a cap tighter than the engine's per-run cap
  onQuote?: (q: EngineQuote) => void; // told the price just before a generation starts (so the work log can say it)
}

// What an edit would cost, said before anything is spent.
export interface EngineQuote { credits: number; words: string }

export type DeclineCode = "missing" | "not-logged-in" | "low-balance" | "run-cap" | "daily-cap" | "failed" | "timeout" | "unavailable";

// The engine will not generate this time. `message` is the owner's plain words; nothing was spent unless it says so.
export class EngineDecline extends Error {
  constructor(public code: DeclineCode, message: string) {
    super(message);
    this.name = "EngineDecline";
  }
}

export interface EditResult {
  image: Buffer;
  engine: string;
  model: string;
  prompt: string;           // the prompt the edit was actually made with
  jobId?: string;
  credits?: number;         // what it cost in Higgsfield credits
  recorded: boolean;        // true: generated earlier and replayed
  createdAt?: string;
}

export interface GenerationEngine {
  readonly name: string;
  edit(input: EditInput, prompt: string, opts: EditOpts): Promise<EditResult | null>;
  /** What this edit would cost, spending nothing; absent for engines that cost nothing (recordings, fakes). */
  quote?(input: EditInput, prompt: string, opts: EditOpts): Promise<EngineQuote>;
}

export const recordingKey = (originalSha256: string, treatment: string): string => `${originalSha256}:${treatment}`;

export interface Recording {
  key: string;
  file: string;             // relative to the manifest's directory
  engine: string;
  model: string;
  prompt: string;
  jobId?: string;
  credits?: number;
  inputSha256?: string;
  createdAt: string;
  note?: string;
}

export class RecordedEngine implements GenerationEngine {
  readonly name = "recorded";
  constructor(private manifestPath: string) {}

  recordings(): Recording[] {
    if (!existsSync(this.manifestPath)) return [];
    const raw = JSON.parse(readFileSync(this.manifestPath, "utf8")) as { recordings?: Recording[] };
    return Array.isArray(raw.recordings) ? raw.recordings : [];
  }

  has(originalSha256: string, treatment: string): boolean {
    return this.recordings().some((r) => r.key === recordingKey(originalSha256, treatment));
  }

  async edit(input: EditInput, _prompt: string, opts: EditOpts): Promise<EditResult | null> {
    const rec = this.recordings().find((r) => r.key === recordingKey(input.originalSha256, opts.treatment));
    if (!rec) return null;
    const dir = resolve(dirname(this.manifestPath));
    const file = resolve(dir, rec.file);
    if (!file.startsWith(dir + sep) || !existsSync(file)) return null;
    return {
      image: readFileSync(file), engine: rec.engine, model: rec.model, prompt: rec.prompt, recorded: true, createdAt: rec.createdAt,
      ...(rec.jobId ? { jobId: rec.jobId } : {}), ...(rec.credits !== undefined ? { credits: rec.credits } : {}),
    };
  }
}

// Tries each engine in order: the first one with an edit for this photo wins. A decline from an earlier engine does not stop
// the later ones; if every engine declines, the last decline is the one the owner hears.
export class ChainEngine implements GenerationEngine {
  readonly name: string;
  constructor(private engines: GenerationEngine[]) {
    this.name = engines.map((e) => e.name).join("+");
  }
  async quote(input: EditInput, prompt: string, opts: EditOpts): Promise<EngineQuote> {
    // a recording replays for free
    for (const e of this.engines) {
      if (e instanceof RecordedEngine) { if (e.has(input.originalSha256, opts.treatment)) return { credits: 0, words: "no Studio credits (made earlier)" }; continue; }
      if (e.quote) return e.quote(input, prompt, opts);
    }
    return { credits: 0, words: "no Studio credits" };
  }
  async edit(input: EditInput, prompt: string, opts: EditOpts): Promise<EditResult | null> {
    let decline: EngineDecline | undefined;
    for (const e of this.engines) {
      try {
        const r = await e.edit(input, prompt, opts);
        if (r) return r;
      } catch (err) {
        if (!(err instanceof EngineDecline)) throw err;
        decline = err;
      }
    }
    if (decline) throw decline;
    return null;
  }
}

// Tests: returns a fixed image for any input, and records the prompts it was given.
export class FakeEngine implements GenerationEngine {
  readonly name = "fake";
  readonly prompts: string[] = [];
  constructor(private make: (input: EditInput) => Promise<Buffer> | Buffer, private opts: { credits?: number } = {}) {}
  readonly calls: Array<{ input: EditInput; opts: EditOpts }> = [];
  async quote(): Promise<EngineQuote> {
    const c = this.opts.credits ?? 0;
    return { credits: c, words: c > 0 ? `about ${c} Studio credit${c === 1 ? "" : "s"}` : "no Studio credits" };
  }
  async edit(input: EditInput, prompt: string, opts?: EditOpts): Promise<EditResult> {
    this.prompts.push(prompt);
    if (opts) this.calls.push({ input, opts });
    // like a live engine, say the price before generating
    if (opts?.onQuote && this.opts.credits !== undefined && this.opts.credits > 0) opts.onQuote({ credits: this.opts.credits, words: `about ${this.opts.credits} Studio credit${this.opts.credits === 1 ? "" : "s"}` });
    return { image: await this.make(input), engine: "fake", model: "fake-edit", prompt, recorded: false, ...(this.opts.credits !== undefined ? { credits: this.opts.credits } : {}) };
  }
}

export const recordingsDir = (dataDir: string): string => join(dataDir, "studio", "recorded");
export const recordingsManifest = (dataDir: string): string => join(recordingsDir(dataDir), "manifest.json");
