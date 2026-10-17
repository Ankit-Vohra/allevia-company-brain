// The production generative engine. It talks to Higgsfield through a backend: the business's own Higgsfield connected through
// Composio (higgsfield-composio.ts, the owner's subscription credits) when it has one, else the `higgsfield` CLI (v1.1.x) on the
// founder's login where the CLI can run (it has no Linux ARM build, so never on the t4g server). Everything that can go wrong is
// handled before a credit is spent, the same way on either backend:
//   login and balance -> quote (`generate cost`) -> the per-run cap -> the daily cap (ledger) -> create -> reserve the job
//   id in the ledger -> wait -> fetch the picture -> mark the job done.
// - The CLI is run with an argument ARRAY (execFile, no shell, nothing interpolated), with a timeout, and the owner's
//   photo is handed over as a file in a private temp directory (mode 0700) that is always deleted afterwards.
// - A refusal the owner should hear about is an EngineDecline with a plain-words message; the Studio then still delivers
//   the free local variant and says why. Nothing here throws a CLI error at the owner.
// - Idempotent by job id: the ledger remembers the job a request created, so the same request again (a double tap, a retry
//   after a timeout) joins that job and spends nothing more. A failed job is marked failed and no longer counts.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isIP } from "node:net";
import { CreditLedger, DailyCapReached, creditCaps, creditsWords, type CreditCaps } from "./credits.js";
import type { EditInput, EditOpts, EditResult, EngineQuote, GenerationEngine, PhotoshootOpts } from "./engine.js";import { EngineDecline } from "./engine.js";

export interface CliResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; missing: boolean }
export type CliRun = (args: string[], o?: { timeoutMs?: number }) => Promise<CliResult>;

export const DEFAULT_IMAGE_MODEL = "nano_banana_2_1";
// The premium ad picture is made by Higgsfield's product-photoshoot backend on gpt_image_2 (about 6.5 credits at 2k), so it has
// its own per-run cap (ALLEVIA_STUDIO_PREMIUM_CREDIT_CAP, default 8): the ordinary per-edit cap of 5 would always refuse it.
export const PHOTOSHOOT_MODEL = "gpt_image_2";
export const DEFAULT_PREMIUM_CAP = 8;
// The parameters of a silent clip differ by model: Kling takes `sound off`, Seedance `generate_audio false` (and a 720p ceiling).
export function clipParams(model: string, seconds: number, aspect: string): Record<string, string> {
  return /^seedance/.test(model)
    ? { duration: String(seconds), aspect_ratio: aspect, resolution: "720p", generate_audio: "false" }
    : { duration: String(seconds), aspect_ratio: aspect, sound: "off" };
}
export const DEFAULT_CLIP_MODEL = process.env.ALLEVIA_STUDIO_CLIP_MODEL?.trim() || "kling3_0";
const MAX_OUTPUT = 8 * 1024 * 1024;
const MAX_RESULT_BYTES = 40 * 1024 * 1024;

// ---------- the CLI, safely ----------

/** Runs the real CLI: an argument array (never a shell string), a timeout that kills it, and its output captured. */
export function execCli(bin: string = process.env.ALLEVIA_HIGGSFIELD_BIN || "higgsfield"): CliRun {
  return (args, o = {}) => new Promise<CliResult>((resolve) => {
    const clean = args.map((a) => String(a).replace(/\u0000/g, ""));
    execFile(bin, clean, { timeout: o.timeoutMs ?? 60_000, killSignal: "SIGKILL", maxBuffer: MAX_OUTPUT, windowsHide: true, shell: false, env: process.env }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null;
      resolve({
        code: e ? (typeof e.code === "number" ? e.code : null) : 0,
        stdout: String(stdout ?? ""), stderr: String(stderr ?? ""),
        timedOut: !!e && (e.killed === true || e.signal === "SIGKILL"),
        missing: !!e && e.code === "ENOENT",
      });
    });
  });
}

/** The JSON in a CLI answer (the CLI may print a progress line before it). undefined when there is none. */
export function parseCliJson(stdout: string): unknown {
  const text = stdout.trim();
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { /* look for the JSON inside */ }
  for (const [open, close] of [["{", "}"], ["[", "]"]] as const) {
    const a = text.indexOf(open);
    const b = text.lastIndexOf(close);
    if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch { /* next */ } }
  }
  return undefined;
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

const asNumber = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : undefined);

/** A price from `generate cost --json` ({"credits": 2}, or a near cousin). */
export function parseCost(stdout: string): number | undefined {
  const j = parseCliJson(stdout);
  if (typeof j === "number") return asNumber(j);
  if (j && typeof j === "object") {
    const o = j as Record<string, unknown>;
    for (const k of ["credits", "cost", "total", "total_credits", "credit_cost"]) { const n = asNumber(o[k]); if (n !== undefined) return n; }
    const inner = o.data ?? o.result;
    if (inner && typeof inner === "object") return parseCost(JSON.stringify(inner));
  }
  return undefined;
}

/** The balance from `account status --json`. */
export function parseBalance(stdout: string): number | undefined {
  const j = parseCliJson(stdout);
  if (j && typeof j === "object") {
    const o = j as Record<string, unknown>;
    for (const k of ["credits", "balance", "available_credits", "available"]) { const n = asNumber(o[k]); if (n !== undefined) return n; }
  }
  return undefined;
}

/** The job id out of `generate create --json` (an id, a list of ids, or a list of jobs). */
export function parseJobId(stdout: string): string | undefined {
  const j = parseCliJson(stdout);
  const fromValue = (v: unknown): string | undefined => {
    if (typeof v === "string") return UUID.exec(v)?.[0] ?? (/^[\w-]{8,64}$/.test(v) ? v : undefined);
    if (Array.isArray(v)) { for (const x of v) { const r = fromValue(x); if (r) return r; } return undefined; }
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      for (const k of ["id", "job_id", "jobId", "job_ids", "jobIds", "ids", "jobs", "data", "results"]) { const r = fromValue(o[k]); if (r) return r; }
    }
    return undefined;
  };
  return fromValue(j) ?? UUID.exec(stdout)?.[0];
}

export interface JobState { status: string; urls: Array<{ path: string; url: string }> }

const walk = (v: unknown, path: string, out: JobState["urls"], depth = 0): void => {
  if (depth > 8 || out.length > 40) return;
  if (typeof v === "string") { if (/^https:\/\/[^\s"']+$/i.test(v)) out.push({ path, url: v }); return; }
  if (Array.isArray(v)) { v.slice(0, 20).forEach((x, i) => walk(x, `${path}[${i}]`, out, depth + 1)); return; }
  if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k, out, depth + 1);
};

/** A job's status and the https URLs in it, from `generate get --json` (an object, or a one-item list). */
export function parseJob(stdout: string): JobState | undefined {
  let j = parseCliJson(stdout);
  if (Array.isArray(j)) j = j[0];
  if (!j || typeof j !== "object") return undefined;
  const o = j as Record<string, unknown>;
  const inner = (o.job && typeof o.job === "object" ? o.job : o) as Record<string, unknown>;
  const status = String(inner.status ?? inner.state ?? o.status ?? "").toLowerCase();
  const urls: JobState["urls"] = [];
  walk(inner, "", urls);
  return { status, urls };
}

const BAD_URL_PATH = /thumb|preview|poster|min_|mini|small|input|reference|avatar|icon|(?:^|\.)params\b|request/i;
const FAILED = /^(?:failed|error|errored|canceled|cancelled|nsfw|rejected|expired|timeout|timed_out)$/;
const FINISHED = /^(?:completed|complete|done|succeeded|success|finished|ready)$/;

/** The picture (or clip) a finished job made: the likeliest result URL, never a thumbnail or the input. */
export function pickResultUrl(job: JobState, kind: "image" | "video"): string | undefined {
  const ext = kind === "image" ? /\.(?:png|jpe?g|webp)(?:\?|$)/i : /\.(?:mp4|mov|webm)(?:\?|$)/i;
  const good = job.urls.filter((u) => !BAD_URL_PATH.test(u.path));
  const named = good.filter((u) => /raw|result|output/i.test(u.path));
  return named.find((u) => ext.test(u.url))?.url ?? good.find((u) => ext.test(u.url))?.url ?? named[0]?.url ?? good.find((u) => /url/i.test(u.path))?.url ?? good[0]?.url;
}

/** Downloads a result: https only, never a private address, a size cap, a time limit. */
export async function fetchResult(url: string, fetchFn: typeof fetch = fetch): Promise<Buffer> {
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  const privateHost = host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") ||
    (isIP(host) !== 0 && /^(?:127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|0\.|::1$|fc|fd|fe80)/i.test(host.replace(/^\[|\]$/g, "")));
  if (u.protocol !== "https:" || privateHost) throw new Error("the result is not on a public https address");
  const res = await fetchFn(u, { redirect: "follow", signal: AbortSignal.timeout(90_000) });
  if (!res.ok) throw new Error(`the result could not be downloaded (${res.status})`);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > MAX_RESULT_BYTES) throw new Error("the result is too large");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_RESULT_BYTES || buf.length < 100) throw new Error("the result is empty or too large");
  return buf;
}

// ---------- where the work is done: a backend ----------

// The engine below owns the money rules (the quote, the per-run cap, the daily cap and ledger, the balance floor, joining a
// job instead of paying twice). A backend only talks to Higgsfield: the CLI on the founder's login (this file), or the
// business's own Higgsfield connected through Composio (higgsfield-composio.ts). Every refusal is an EngineDecline in the
// owner's words; nothing a backend throws names a tool, a path or an id.

/** One generation as a backend sees it. */
export interface HfJob {
  kind: "image" | "video";
  model: string;
  prompt: string;
  params: Record<string, string>;
  file?: { flag: string; name: string; bytes: Buffer };   // absent: a picture drawn from the prompt alone
}

export type HfOutcome = { state: "done"; url: string } | { state: "failed" } | { state: "pending" };

export interface HiggsfieldBackend {
  readonly name: string;
  /** Connected, with credits; the balance. An EngineDecline in the owner's words otherwise. */
  balance(): Promise<number>;
  /** Readies the job's input (a private temp file, an upload) and runs `fn` with a reference to it; always cleans up. */
  withInput<T>(job: HfJob, fn: (ref: string) => Promise<T>): Promise<T>;
  /** The price in credits. Spends nothing. */
  cost(job: HfJob, ref: string): Promise<number>;
  /** Starts the job; its id. */
  create(job: HfJob, ref: string): Promise<string>;
  /** Waits for the job (up to the backend's own limit): done with the result's address, failed, or still running. */
  wait(jobId: string, kind: HfJob["kind"]): Promise<HfOutcome>;
  /** The product-photoshoot prompt writer, where the backend has one. */
  enhance?(intent: string, opts: PhotoshootOpts): Promise<string>;
}

// The CLI says this (and exits) on a computer it has no build for, e.g. the Linux ARM server.
const CLI_UNSUPPORTED = /native cli binary|not found for (?:linux|darwin|win)|unsupported (?:platform|architecture)|exec format error/i;

/** The owner's words when no way to make pictures is set up. */
export const PICTURES_OFF = "Picture making isn't switched on yet, so I made the simple clean-up only.";

/** The `higgsfield` CLI on the founder's login. */
export class CliBackend implements HiggsfieldBackend {
  readonly name = "higgsfield-cli";
  constructor(private o: { cli: CliRun; tmpRoot?: string; timeouts?: { account?: number; cost?: number; create?: number; wait?: number }; log?: (line: string) => void }) {}
  private log(line: string): void { this.o.log?.(`[higgsfield] ${line}`); }
  private t(k: "account" | "cost" | "create" | "wait"): number { return this.o.timeouts?.[k] ?? { account: 25_000, cost: 90_000, create: 120_000, wait: 270_000 }[k]; }

  async balance(): Promise<number> {
    const r = await this.o.cli(["--json", "account", "status"], { timeoutMs: this.t("account") });
    if (r.missing || CLI_UNSUPPORTED.test(`${r.stderr}\n${r.stdout}`)) throw new EngineDecline("missing", PICTURES_OFF);
    if (r.timedOut) throw new EngineDecline("unavailable", "The AI editor didn't answer in time, so I made the simple clean-up only.");
    const balance = r.code === 0 ? parseBalance(r.stdout) : undefined;
    if (balance === undefined) throw new EngineDecline("not-logged-in", "The AI editor isn't signed in right now, so I made the simple clean-up only.");
    return balance;
  }

  private args(job: HfJob, file: string): string[] {
    const a: string[] = [job.model, "--prompt", job.prompt];
    for (const [k, v] of Object.entries(job.params)) a.push(`--${k}`, v);
    if (job.file) a.push(`--${job.file.flag}`, file);
    return a;
  }

  // The photo is given to the CLI as a file in a private directory that is removed whatever happens.
  async withInput<T>(job: HfJob, fn: (ref: string) => Promise<T>): Promise<T> {
    const root = this.o.tmpRoot ?? tmpdir();
    mkdirSync(root, { recursive: true });
    if (!job.file) return fn("");
    const dir = mkdtempSync(join(root, "allevia-hf-"));
    try {
      const file = join(dir, job.file.name);
      writeFileSync(file, job.file.bytes, { mode: 0o600 });
      return await fn(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async cost(job: HfJob, file: string): Promise<number> {
    const r = await this.o.cli(["--json", "generate", "cost", ...this.args(job, file)], { timeoutMs: this.t("cost") });
    const credits = r.code === 0 ? parseCost(r.stdout) : undefined;
    if (credits === undefined) {
      this.log(`cost check failed (exit ${r.code}${r.timedOut ? ", timed out" : ""})`);
      throw new EngineDecline("unavailable", "I couldn't get a price for the AI edit, so I made the simple clean-up only. Nothing was spent.");
    }
    return credits;
  }

  async create(job: HfJob, file: string): Promise<string> {
    const r = await this.o.cli(["--json", "generate", "create", ...this.args(job, file)], { timeoutMs: this.t("create") });
    const jobId = r.code === 0 ? parseJobId(r.stdout) : undefined;
    if (!jobId) {
      this.log(`create failed (exit ${r.code}${r.timedOut ? ", timed out" : ""}): ${r.stderr.slice(0, 160).replace(/\s+/g, " ")}`);
      throw new EngineDecline("failed", "The AI edit didn't start, so I made the simple clean-up only. No Studio credits were counted.");
    }
    return jobId;
  }

  async wait(id: string, kind: HfJob["kind"]): Promise<HfOutcome> {
    const w = await this.o.cli(["--json", "generate", "wait", id, "--timeout", `${Math.round(this.t("wait") / 1000)}s`, "--quiet"], { timeoutMs: this.t("wait") + 20_000 });
    const g = await this.o.cli(["--json", "generate", "get", id], { timeoutMs: this.t("account") });
    const job = g.code === 0 ? parseJob(g.stdout) : undefined;
    if (job && FAILED.test(job.status)) return { state: "failed" };
    const url = job && (FINISHED.test(job.status) || (!job.status && !w.timedOut && w.code === 0)) ? pickResultUrl(job, kind) : undefined;
    return url ? { state: "done", url } : { state: "pending" };
  }

  // The product-photoshoot backend writes the prompt for a mode (the studio never freehands it). Its `--enhance-only` answer is
  // free and fast and needs no picture; the picture itself then goes to gpt_image_2 as the reference through the same ledgered,
  // capped, idempotent path as every other generation (the all-in-one `product-photoshoot create` with a picture was found to
  // run past the CLI's own 60 second limit on the enhance call, and gives no job id to reserve before waiting).
  async enhance(intent: string, opts: PhotoshootOpts): Promise<string> {
    const args = ["--json", "product-photoshoot", "create", "--mode", opts.mode, "--prompt", cleanPrompt(intent).slice(0, 1500), "--count", "1", "--aspect_ratio", opts.aspect, "--enhance-only"];
    if (opts.brandContext) args.push("--brand_context", opts.brandContext.slice(0, 600));
    if (opts.productContext) args.push("--product_context", opts.productContext.slice(0, 600));
    const r = await this.o.cli(args, { timeoutMs: 150_000 });
    const j = r.code === 0 ? parseCliJson(r.stdout) : undefined;
    const first = j && typeof j === "object" && Array.isArray((j as { prompts?: unknown }).prompts) ? ((j as { prompts: unknown[] }).prompts[0] as Record<string, unknown> | undefined) : undefined;
    const prompt = typeof first?.prompt === "string" ? first.prompt.trim() : "";
    if (!prompt) {
      this.log(`photoshoot prompt failed (exit ${r.code}${r.timedOut ? ", timed out" : ""}): ${r.stderr.slice(0, 160).replace(/\s+/g, " ")}`);
      throw new EngineDecline("unavailable", "The ad styling didn't answer, so no ad picture was made. Nothing was spent.");
    }
    return prompt;
  }
}

/** Says no to everything, in plain words: nothing here can make pictures. */
export class OffBackend implements HiggsfieldBackend {
  readonly name = "off";
  async balance(): Promise<number> { throw new EngineDecline("missing", PICTURES_OFF); }
  async withInput<T>(_job: HfJob, fn: (ref: string) => Promise<T>): Promise<T> { return fn(""); }
  async cost(): Promise<number> { throw new EngineDecline("missing", PICTURES_OFF); }
  async create(): Promise<string> { throw new EngineDecline("missing", PICTURES_OFF); }
  async wait(): Promise<HfOutcome> { return { state: "pending" }; }
}

/** Whether the CLI can run on this computer: present, with a build for it, and answering. Asked once, then remembered. */
export function cliProbe(cli: CliRun, o: { platform?: string; arch?: string } = {}): () => Promise<boolean> {
  let known: Promise<boolean> | undefined;
  return () => (known ??= (async () => {
    // The CLI ships no Linux ARM build (the t4g server): it is not even tried there.
    if ((o.platform ?? process.platform) === "linux" && /^arm/.test(o.arch ?? process.arch)) return false;
    try {
      const r = await cli(["--version"], { timeoutMs: 15_000 });
      return !r.missing && !r.timedOut && r.code === 0 && !CLI_UNSUPPORTED.test(`${r.stderr}\n${r.stdout}`);
    } catch {
      return false;
    }
  })());
}

/** Chooses the backend for one business: its connected Higgsfield first, then the CLI where it runs, else "not switched on". */
export function pickBackend(o: { connected?: (tenant: string) => Promise<HiggsfieldBackend | null>; cli?: HiggsfieldBackend; cliUsable?: () => Promise<boolean>; log?: (line: string) => void }): (tenant: string) => Promise<HiggsfieldBackend> {
  const off = new OffBackend();
  return async (tenant) => {
    const mine = o.connected ? await o.connected(tenant).catch((e: unknown) => { o.log?.(`[higgsfield] connection check failed: ${e instanceof Error ? e.message.slice(0, 120) : "unknown"}`); return null; }) : null;
    if (mine) return mine;
    if (o.cli && (!o.cliUsable || await o.cliUsable().catch(() => false))) return o.cli;
    return off;
  };
}

function cleanPrompt(p: string): string {
  // never starts with a dash (the CLI reads --name value pairs), no control characters, bounded
  const t = p.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ").trim().slice(0, 6000);
  return /^-/.test(t) ? `Edit: ${t}` : t;
}

// Where no prompt writer is at hand (the connected Higgsfield has none), the premium ad prompt is written here from the mode.
const MODE_SCENES: Record<PhotoshootOpts["mode"], string> = {
  lifestyle_scene: "A natural lifestyle photograph of this product in real use, in a real-world setting with hands and atmosphere, soft daylight, the look of a genuine customer photo",
  closeup_product_with_person: "A tight close-up photograph of this product held in a person's hands, shallow depth of field, soft natural light",
  product_shot: "A clean studio product photograph of this product on a simple seamless background, soft even light and a gentle shadow",
  ad_creative_pack: "A polished paid-social advertising photograph of this product, bold simple composition with space for words, premium lighting",
};
export function localPhotoshootPrompt(intent: string, opts: PhotoshootOpts): string {
  return [
    `${MODE_SCENES[opts.mode]}.`, `What it is for: ${intent.trim().slice(0, 600)}.`,
    opts.productContext ? `The product: ${opts.productContext.slice(0, 300)}.` : "", opts.brandContext ? `The brand: ${opts.brandContext.slice(0, 300)}.` : "",
    "Photographic and believable; no text or logos added.",
  ].filter(Boolean).join(" ");
}

// ---------- the engine ----------

export interface HiggsfieldOpts {
  /** The founder's CLI (tests pass a fake). Used when no `backend` is given. */
  cli?: CliRun;
  /** Who talks to Higgsfield: one backend, or one chosen per business (pickBackend). */
  backend?: HiggsfieldBackend | ((tenant: string) => Promise<HiggsfieldBackend>);
  ledger: CreditLedger;
  caps?: CreditCaps;
  model?: string;
  clipModel?: string;
  resolution?: string;
  /** The account is not touched when a job would leave less than this many credits (the founder's own balance). */
  balanceFloor?: number;
  fetchImage?: (url: string) => Promise<Buffer>;
  tmpRoot?: string;
  timeouts?: { account?: number; cost?: number; create?: number; wait?: number };
  log?: (line: string) => void;
}

interface JobSpec extends HfJob {
  tenant: string;
  keyParts: string[];
  maxCredits: number;
  onQuote?: (q: EngineQuote) => void;   // told the price just before the generation starts
  /** What identifies the request when the prompt itself is not stable (a model-written prompt differs run to run). */
  keyPrompt?: string;
}

export class HiggsfieldEngine implements GenerationEngine {
  readonly name = "higgsfield";
  readonly caps: CreditCaps;
  private pick: (tenant: string) => Promise<HiggsfieldBackend>;
  constructor(private o: HiggsfieldOpts) {
    this.caps = o.caps ?? creditCaps();
    const b = o.backend;
    if (typeof b === "function") this.pick = b;
    else {
      const fixed = b ?? (o.cli ? new CliBackend({ cli: o.cli, ...(o.tmpRoot ? { tmpRoot: o.tmpRoot } : {}), ...(o.timeouts ? { timeouts: o.timeouts } : {}), ...(o.log ? { log: o.log } : {}) }) : new OffBackend());
      this.pick = async () => fixed;
    }
  }

  private log(line: string): void { this.o.log?.(`[higgsfield] ${line}`); }

  // A backend that fails in a way nobody foresaw never reaches the owner as a raw error: it is logged and said plainly.
  private async backend(tenant: string): Promise<HiggsfieldBackend> {
    try { return await this.pick(tenant); } catch (e) { this.log(`no backend: ${e instanceof Error ? e.message.slice(0, 160) : "unknown"}`); return new OffBackend(); }
  }
  private async safely<T>(what: string, fn: () => Promise<T>): Promise<T> {
    try { return await fn(); } catch (e) {
      if (e instanceof EngineDecline || e instanceof DailyCapReached) throw e;
      this.log(`${what} failed: ${e instanceof Error ? e.message.slice(0, 200) : "unknown"}`);
      throw new EngineDecline("unavailable", "Picture making failed just now, so I made the simple clean-up only. Nothing was spent.");
    }
  }

  // ----- login and balance -----

  /** Connected with credits to spare, or an EngineDecline in the owner's words. Returns the balance. */
  async preflight(tenant = "unknown"): Promise<number> {
    const b = await this.backend(tenant);
    return this.safely("balance", () => b.balance());
  }

  private prompt(p: string): string { return cleanPrompt(p); }

  private spec(input: EditInput, prompt: string, opts: EditOpts): JobSpec {
    const ext = input.mime === "image/png" ? "png" : "jpg";
    return {
      kind: "image", model: opts.model ?? this.o.model ?? DEFAULT_IMAGE_MODEL, prompt: this.prompt(prompt),
      params: { resolution: this.o.resolution ?? "2k", ...(opts.aspect !== "same" ? { aspect_ratio: opts.aspect } : {}) },
      file: { flag: "image", name: `photo.${ext}`, bytes: input.image }, tenant: input.tenant ?? "unknown",
      keyParts: [input.originalSha256, opts.treatment, opts.aspect], maxCredits: opts.maxCredits ?? this.caps.run,
      ...(opts.onQuote ? { onQuote: opts.onQuote } : {}),
    };
  }

  /** What an edit would cost, checked against the caps and the balance. Spends nothing. */
  async quote(input: EditInput, prompt: string, opts: EditOpts): Promise<EngineQuote> {
    return this.quoteSpec(this.spec(input, prompt, opts));
  }

  async edit(input: EditInput, prompt: string, opts: EditOpts): Promise<EditResult> {
    const spec = this.spec(input, prompt, opts);
    const run = await this.runJob(spec);
    return { image: run.bytes, engine: this.name, model: spec.model, prompt: spec.prompt, jobId: run.jobId, credits: run.credits, recorded: false, createdAt: new Date(run.at).toISOString() };
  }

  // ----- the premium ad picture (Higgsfield product-photoshoot) -----

  // The backend's own prompt writer where it has one (the CLI's product-photoshoot), else the prompt written here from the mode.
  // The model is gpt_image_2: the price is checked for exactly that model, so it is the one used.
  private async enhance(b: HiggsfieldBackend, intent: string, opts: PhotoshootOpts): Promise<{ prompt: string; model: string; aspect: string }> {
    const prompt = b.enhance ? await this.safely("photoshoot prompt", () => b.enhance!(intent, opts)) : localPhotoshootPrompt(intent, opts);
    return { prompt, model: PHOTOSHOOT_MODEL, aspect: opts.aspect };
  }

  private photoshootSpec(input: EditInput, prompt: string, opts: PhotoshootOpts, model: string = PHOTOSHOOT_MODEL, keyPrompt?: string): JobSpec {
    const ext = input.mime === "image/png" ? "png" : "jpg";
    return {
      kind: "image", model, prompt: this.prompt(prompt), params: { resolution: this.o.resolution ?? "2k", aspect_ratio: opts.aspect },
      file: { flag: "image", name: `product.${ext}`, bytes: input.image }, tenant: input.tenant ?? "unknown",
      keyParts: [input.originalSha256, opts.treatment, opts.aspect], maxCredits: opts.maxCredits ?? premiumCap(),
      ...(opts.onQuote ? { onQuote: opts.onQuote } : {}), ...(keyPrompt ? { keyPrompt } : {}),
    };
  }

  /** What the premium ad picture would cost, checked against the caps and the balance. Spends nothing. */
  async quotePhotoshoot(input: EditInput, intent: string, opts: PhotoshootOpts): Promise<EngineQuote> {
    return this.quoteSpec(this.photoshootSpec(input, intent, opts));
  }

  async photoshoot(input: EditInput, intent: string, opts: PhotoshootOpts): Promise<EditResult> {
    const probe = this.photoshootSpec(input, intent, opts, PHOTOSHOOT_MODEL, intent);
    // the same request again joins its job (the ledger), so the backend is not asked for a prompt a second time
    const key = createHash("sha256").update([probe.model, probe.keyPrompt, JSON.stringify(probe.params), ...probe.keyParts].join("\u0001")).digest("hex");
    const prior = this.o.ledger.existing(key);
    const e = prior ? { prompt: probe.prompt, model: probe.model, aspect: opts.aspect } : await this.enhance(await this.backend(probe.tenant), intent, opts);
    // The reference picture is attached, and one sentence is added so the model keeps the product itself: the backend's prompt is
    // written for a product in words, the picture is what it must match.
    const guard = "Use the attached photo as the exact reference for the product: keep its shape, colour, material, label and logo exactly as in the photo, and do not invent any new text.";
    const spec = this.photoshootSpec(input, `${e.prompt}\n\n${guard}`, opts, e.model, intent);
    const run = await this.runJob(spec);
    return { image: run.bytes, engine: this.name, model: spec.model, prompt: e.prompt, jobId: run.jobId, credits: run.credits, recorded: false, createdAt: new Date(run.at).toISOString() };
  }

  /** A short clip from a still (a 9:16 start frame), priced and capped like an image edit. */
  async clip(o: { image: Buffer; tenant: string; sourceSha256: string; prompt: string; seconds?: number; aspect?: "9:16" | "4:5" | "1:1"; maxCredits?: number; onQuote?: (q: EngineQuote) => void }): Promise<{ video: Buffer; jobId: string; credits: number; model: string }> {
    const seconds = o.seconds ?? 5;
    const spec: JobSpec = {
      kind: "video", model: this.o.clipModel ?? DEFAULT_CLIP_MODEL, prompt: this.prompt(o.prompt),
      params: clipParams(this.o.clipModel ?? DEFAULT_CLIP_MODEL, seconds, o.aspect ?? "9:16"),
      file: { flag: "start-image", name: "start.jpg", bytes: o.image }, tenant: o.tenant,
      keyParts: [o.sourceSha256, "clip", String(seconds), o.aspect ?? "9:16"], maxCredits: o.maxCredits ?? this.caps.run,
      ...(o.onQuote ? { onQuote: o.onQuote } : {}),
    };
    const run = await this.runJob(spec);
    return { video: run.bytes, jobId: run.jobId, credits: run.credits, model: spec.model };
  }

  // A picture drawn from a description alone (a poster's artwork, a picture of a service), priced and capped like an edit, on
  // the same login, ledger and daily cap. Used by the creating tools (src/creative/wiring.ts).
  private drawSpec(o: { prompt: string; aspect: string; tenant: string; maxCredits?: number; model?: string }): JobSpec {
    const prompt = this.prompt(o.prompt);
    return {
      kind: "image", model: o.model ?? this.o.model ?? DEFAULT_IMAGE_MODEL, prompt, params: { resolution: this.o.resolution ?? "2k", aspect_ratio: o.aspect },
      tenant: o.tenant, keyParts: ["draw", createHash("sha256").update(prompt).digest("hex").slice(0, 16), o.aspect], maxCredits: o.maxCredits ?? this.caps.run,
    };
  }

  async drawQuote(o: { prompt: string; aspect: string; tenant: string; maxCredits?: number }): Promise<EngineQuote> {
    return this.quoteSpec(this.drawSpec(o));
  }

  async draw(o: { prompt: string; aspect: string; tenant: string; maxCredits?: number }): Promise<EditResult> {
    const spec = this.drawSpec(o);
    const run = await this.runJob(spec);
    return { image: run.bytes, engine: this.name, model: spec.model, prompt: spec.prompt, jobId: run.jobId, credits: run.credits, recorded: false, createdAt: new Date(run.at).toISOString() };
  }

  /** What a clip would cost, without making it. */
  async clipQuote(o: { image: Buffer; tenant: string; sourceSha256: string; prompt: string; seconds?: number; aspect?: "9:16" | "4:5" | "1:1"; maxCredits?: number }): Promise<EngineQuote> {
    const seconds = o.seconds ?? 5;
    return this.quoteSpec({
      kind: "video", model: this.o.clipModel ?? DEFAULT_CLIP_MODEL, prompt: this.prompt(o.prompt),
      params: clipParams(this.o.clipModel ?? DEFAULT_CLIP_MODEL, seconds, o.aspect ?? "9:16"),
      file: { flag: "start-image", name: "start.jpg", bytes: o.image }, tenant: o.tenant, keyParts: [], maxCredits: o.maxCredits ?? this.caps.run,
    });
  }

  // ----- the work -----

  private async quoteSpec(spec: JobSpec): Promise<EngineQuote> {
    const b = await this.backend(spec.tenant);
    return this.safely("quote", () => b.withInput(spec, async (ref) => (await this.vet(b, spec, ref)).quote));
  }

  // Connected, priced, within the run cap, the daily cap and the balance floor.
  private async vet(b: HiggsfieldBackend, spec: JobSpec, ref: string): Promise<{ quote: EngineQuote; balance: number }> {
    const balance = await b.balance();
    const credits = await b.cost(spec, ref);
    const quote: EngineQuote = { credits, words: creditsWords(credits, { about: true }) };
    if (credits > spec.maxCredits) {
      throw new EngineDecline("run-cap", `That would use ${creditsWords(credits, { about: true })}, more than the ${creditsWords(spec.maxCredits)} allowed for one edit, so I kept to the simple clean-up.`);
    }
    const left = this.o.ledger.remainingToday(this.caps.daily);
    if (credits > left) {
      throw new EngineDecline("daily-cap", `Today's Studio budget for AI edits is used up (${creditsWords(this.o.ledger.spentOn())} of ${this.caps.daily} today), so I kept to the simple clean-up. It starts again tomorrow.`);
    }
    const floor = this.o.balanceFloor ?? envNumber("ALLEVIA_STUDIO_BALANCE_FLOOR", 20);
    if (balance - credits < floor) {
      throw new EngineDecline("low-balance", "The AI editor's credits are running low, so I kept to the simple clean-up.");
    }
    return { quote, balance };
  }

  private async runJob(spec: JobSpec): Promise<{ bytes: Buffer; jobId: string; credits: number; at: number }> {
    const key = createHash("sha256").update([spec.model, spec.keyPrompt ?? spec.prompt, JSON.stringify(spec.params), ...spec.keyParts].join("\u0001")).digest("hex");
    // The same request again joins its job: nothing is created or charged twice (and the photo is not handed over again).
    const prior = this.o.ledger.existing(key);
    const b = await this.backend(spec.tenant);
    let jobId = prior?.jobId;
    let credits = prior?.credits ?? 0;
    if (!prior) {
      await this.safely("create", () => b.withInput(spec, async (ref) => {
        const { quote } = await this.vet(b, spec, ref);
        spec.onQuote?.(quote);
        jobId = await b.create(spec, ref);
        credits = quote.credits;
      }));
      try {
        await this.o.ledger.reserve({ jobId: jobId!, key, tenant: spec.tenant, model: spec.model, credits }, this.caps.daily);
      } catch (e) {
        if (e instanceof DailyCapReached) throw new EngineDecline("daily-cap", "Today's Studio budget for AI edits is used up, so I kept to the simple clean-up. It starts again tomorrow.");
        throw e;
      }
    }
    const id = jobId!;
    // a hiccup while waiting is not a failed job: it stays counted and the same request joins it later
    const out: HfOutcome = await b.wait(id, spec.kind).catch((e: unknown) => {
      if (e instanceof EngineDecline && e.code !== "unavailable") throw e;
      this.log(`wait failed: ${e instanceof Error ? e.message.slice(0, 200) : "unknown"}`);
      return { state: "pending" as const };
    });
    if (out.state === "failed") {
      await this.o.ledger.mark(id, "failed");
      throw new EngineDecline("failed", "The AI edit didn't work this time, so I made the simple clean-up only. No Studio credits were counted.");
    }
    if (out.state === "pending") {
      // still running (or the wait ran out): the job stays counted and the same request joins it later
      throw new EngineDecline("timeout", "The AI edit is taking longer than expected, so I made the simple clean-up for now. Ask again in a few minutes: it picks up the same job and is not charged twice.");
    }
    let bytes: Buffer;
    try {
      bytes = await (this.o.fetchImage ?? ((u: string) => fetchResult(u)))(out.url);
    } catch (e) {
      this.log(`result download failed: ${(e as Error).message}`);
      throw new EngineDecline("failed", "The AI edit finished but I couldn't fetch the picture, so I made the simple clean-up only. Ask again in a moment: it picks up the same job and is not charged twice.");
    }
    await this.o.ledger.mark(id, "done");
    return { bytes, jobId: id, credits, at: Date.now() };
  }
}

/** The most one premium ad picture may cost, in Studio credits. */
export function premiumCap(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.ALLEVIA_STUDIO_PREMIUM_CREDIT_CAP);
  return env.ALLEVIA_STUDIO_PREMIUM_CREDIT_CAP !== undefined && env.ALLEVIA_STUDIO_PREMIUM_CREDIT_CAP.trim() !== "" && Number.isFinite(n) && n > 0 ? n : DEFAULT_PREMIUM_CAP;
}

function envNumber(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return process.env[name] !== undefined && process.env[name]!.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : fallback;
}
