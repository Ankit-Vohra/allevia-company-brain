// Generative edits (product design §6, step 6). One interface, several engines, the way AgentRuntime has several
// runtimes:
// - RecordedEngine loads an edit that was generated ahead of time, by key (the original photo's sha256 and the
//   treatment). It is how the demo and the tests run: a real Higgsfield output, made once with the founder's approval,
//   replayed without spending credits. A photo with no recording gets no generative variant (null), never a fake.
// - HiggsfieldEngine is the Phase 2 production engine (the Higgsfield API under its own agreement: quoted, reserved in
//   the ledger, idempotent by job id). It is a stub: the product server cannot use the founder's MCP session.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export interface EditInput {
  image: Buffer;            // the owner's photo, metadata stripped
  mime: "image/jpeg" | "image/png";
  originalSha256: string;   // its sha256 (the recording key)
}

export interface EditOpts {
  treatment: string;        // e.g. "relight-clean-editorial"
  aspect: "same" | "4:5" | "1:1" | "9:16"; // "same": keep the input's framing (the studio crops afterwards)
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

export class HiggsfieldEngine implements GenerationEngine {
  readonly name = "higgsfield";
  async edit(): Promise<EditResult | null> {
    throw new Error(
      "HiggsfieldEngine is Phase 2: live edits go through the Higgsfield API under Allevia's own agreement (quoted, " +
      "reserved in the ledger, idempotent by job id). The product server cannot use the founder's MCP session.");
  }
}

// Tests: returns a fixed image for any input, and records the prompts it was given.
export class FakeEngine implements GenerationEngine {
  readonly name = "fake";
  readonly prompts: string[] = [];
  constructor(private make: (input: EditInput) => Promise<Buffer> | Buffer, private opts: { credits?: number } = {}) {}
  async edit(input: EditInput, prompt: string): Promise<EditResult> {
    this.prompts.push(prompt);
    return { image: await this.make(input), engine: "fake", model: "fake-edit", prompt, recorded: false, ...(this.opts.credits !== undefined ? { credits: this.opts.credits } : {}) };
  }
}

export const recordingsDir = (dataDir: string): string => join(dataDir, "studio", "recorded");
export const recordingsManifest = (dataDir: string): string => join(recordingsDir(dataDir), "manifest.json");
