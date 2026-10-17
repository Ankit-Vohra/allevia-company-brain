// The Studio's Higgsfield backend on the business's OWN Higgsfield, connected through Composio (the `higgsfield_mcp` toolkit,
// connection `app-higgsfield_mcp`): generations are paid from the owner's Higgsfield subscription credits, and it works on any
// server (the CLI has no Linux ARM build). The engine (higgsfield.ts) still owns every money rule: the quote, the per-run and
// daily caps in the shared ledger, the balance floor, joining a job instead of paying twice. This file only runs the toolkit's
// actions, all as this business and only this business (ConnectionsPort.run):
//   BALANCE                       the credits left (the floor, and the "credits left" line on Your tools)
//   MEDIA_UPLOAD, PUT, MEDIA_CONFIRM   the owner's photo, handed over as a private upload (no public address is made)
//   GENERATE_IMAGE / GENERATE_VIDEO   with `get_cost: true` for the price (nothing is submitted), then for real
//   JOBS_WAIT, JOB_STATUS         the job's state and its result address
// Argument names follow each action's input schema (Composio /api/v3/tools/<slug>, latest version, read on 17 Oct 2026). Paid
// from credits always (`use_unlim: false`): a free-trial allowance is never spent, and never asked about, without the owner.
// Nothing an owner reads names an action, an id or a tool: refusals are EngineDeclines in plain words.
import { isIP } from "node:net";
import { EngineDecline } from "./engine.js";
import type { HfJob, HfOutcome, HiggsfieldBackend } from "./higgsfield.js";

export const HIGGSFIELD_CONNECTION = "app-higgsfield_mcp";
const T = (name: string) => `HIGGSFIELD_MCP_${name}`;

/** Runs one Composio action as this business. */
export type McpCall = (tool: string, args: Record<string, unknown>) => Promise<unknown>;
/** Opens a session on the business's Higgsfield connection for one step (the connection's audit log names `op`). */
export type McpSession = <R>(op: string, fn: (call: McpCall) => Promise<R>) => Promise<R>;

export interface ComposioHiggsfieldOpts {
  session: McpSession;
  /** The PUT of the photo to the presigned upload address (tests pass a fake). */
  fetchFn?: typeof fetch;
  /** How long one generation may be waited for, in ms (default 270 s, like the CLI). */
  waitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
}

const TERMINAL_FAIL = /^(?:failed|canceled|cancelled|nsfw|ip_detected)$/;
const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The model's media role for a reference picture (from models_explore: each model names its own). */
export function mediaRole(model: string, kind: HfJob["kind"]): string {
  if (kind === "video") return /^(?:kling|seedance|minimax|wan|hailuo)/.test(model) ? "start_image" : "image";
  if (/^nano_banana/.test(model)) return "image_references";
  return "image";
}

/** The CLI's string parameters as the action's JSON: whole numbers as numbers, true/false as booleans. */
export function jsonParams(params: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) out[k] = /^\d+$/.test(v) ? Number(v) : v === "true" ? true : v === "false" ? false : v;
  return out;
}

const publicHttps = (url: string): boolean => {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    return u.protocol === "https:" && h !== "localhost" && !h.endsWith(".localhost") && !h.endsWith(".internal") && isIP(h.replace(/^\[|\]$/g, "")) === 0;
  } catch { return false; }
};

export class ComposioHiggsfieldBackend implements HiggsfieldBackend {
  readonly name = "higgsfield-connected";
  constructor(private o: ComposioHiggsfieldOpts) {}
  private log(line: string): void { this.o.log?.(`[higgsfield-connected] ${line}`); }

  // A refusal from the connection itself (not connected, needs reconnecting, too many calls) or an action that failed, in the
  // owner's words. The raw error goes to the log only.
  private async run<R>(op: string, fn: (call: McpCall) => Promise<R>, failed: DeclineFor): Promise<R> {
    try {
      return await this.o.session(op, fn);
    } catch (e) {
      if (e instanceof EngineDecline) throw e;
      const name = e instanceof Error ? e.name : "";
      const msg = e instanceof Error ? e.message : String(e);
      this.log(`${op} failed (${name}): ${msg.slice(0, 200)}`);
      if (name === "NotConnectedError" || name === "NeedsAttentionError" || name === "NotConfiguredError") {
        throw new EngineDecline("not-logged-in", "Your Higgsfield connection needs connecting again (open Your tools), so I made the simple clean-up only.");
      }
      if (/credit|balance|insufficient|upgrade|payment/i.test(msg)) throw new EngineDecline("low-balance", LOW);
      throw new EngineDecline(failed.code, failed.words);
    }
  }

  // What an action answered that means "no": an error, a request to buy credits, or a question for the owner.
  private refusal(data: unknown, op: string, failed: DeclineFor): void {
    const d = asRecord(data);
    if (d.upgrade_url || d.checkout_url || d.recovery_tool === "show_plans_and_credits") throw new EngineDecline("low-balance", LOW);
    if (d.unlim_choice) { this.log(`${op}: asked about free generations`); throw new EngineDecline(failed.code, failed.words); }
    const err = str(d.error);
    if (err) {
      this.log(`${op}: ${err.slice(0, 200)}`);
      if (/credit|balance|insufficient/i.test(err)) throw new EngineDecline("low-balance", LOW);
      throw new EngineDecline(failed.code, failed.words);
    }
  }

  async balance(): Promise<number> {
    const data = await this.run("credits left", (call) => call(T("BALANCE"), {}), { code: "unavailable", words: "Higgsfield didn't answer just now, so I made the simple clean-up only." });
    const credits = num(asRecord(data).credits);
    if (credits === undefined) {
      this.refusal(data, "balance", { code: "unavailable", words: "Higgsfield didn't answer just now, so I made the simple clean-up only." });
      throw new EngineDecline("unavailable", "Higgsfield didn't answer just now, so I made the simple clean-up only.");
    }
    return credits;
  }

  // The photo goes up as a private upload (a presigned address from MEDIA_UPLOAD, then MEDIA_CONFIRM); its media id is the ref.
  async withInput<R>(job: HfJob, fn: (ref: string) => Promise<R>): Promise<R> {
    if (!job.file) return fn("");
    const file = job.file;
    const mime = /\.png$/i.test(file.name) ? "image/png" : "image/jpeg";
    const failed = { code: "unavailable" as const, words: "I couldn't hand your photo to Higgsfield just now, so I made the simple clean-up only. Nothing was spent." };
    const mediaId = await this.run("upload the photo", async (call) => {
      const up = asRecord(await call(T("MEDIA_UPLOAD"), { filename: file.name, content_type: mime }));
      this.refusal(up, "upload", failed);
      const first = asRecord(Array.isArray(up.uploads) ? up.uploads[0] : undefined);
      const url = str(first.upload_url), id = str(first.media_id);
      if (!url || !id || !publicHttps(url)) throw new EngineDecline(failed.code, failed.words);
      const put = await (this.o.fetchFn ?? fetch)(url, { method: "PUT", headers: { "content-type": str(first.content_type) || mime }, body: new Uint8Array(file.bytes), signal: AbortSignal.timeout(60_000) });
      if (!put.ok) { this.log(`upload PUT answered ${put.status}`); throw new EngineDecline(failed.code, failed.words); }
      const ok = asRecord(await call(T("MEDIA_CONFIRM"), { type: "image", media_id: id }));
      this.refusal(ok, "confirm", failed);
      return id;
    }, failed);
    return fn(mediaId);
  }

  private params(job: HfJob, ref: string): Record<string, unknown> {
    return {
      model: job.model, prompt: job.prompt, ...jsonParams(job.params), use_unlim: false,
      ...(job.file && ref ? { medias: [{ role: mediaRole(job.model, job.kind), value: ref }] } : {}),
    };
  }
  private tool(job: HfJob): string { return T(job.kind === "video" ? "GENERATE_VIDEO" : "GENERATE_IMAGE"); }

  async cost(job: HfJob, ref: string): Promise<number> {
    const failed = { code: "unavailable" as const, words: "I couldn't get a price for the AI edit, so I made the simple clean-up only. Nothing was spent." };
    const data = await this.run("price", (call) => call(this.tool(job), { params: { ...this.params(job, ref), get_cost: true } }), failed);
    this.refusal(data, "price", failed);
    const c = asRecord(asRecord(data).cost);
    const credits = num(c.credits_exact) ?? num(c.credits);
    if (credits === undefined) throw new EngineDecline(failed.code, failed.words);
    return credits;
  }

  async create(job: HfJob, ref: string): Promise<string> {
    const failed = { code: "failed" as const, words: "The AI edit didn't start, so I made the simple clean-up only. No Studio credits were counted." };
    const data = await this.run("generate", (call) => call(this.tool(job), { params: this.params(job, ref) }), failed);
    this.refusal(data, "generate", failed);
    const first = asRecord(Array.isArray(asRecord(data).results) ? (asRecord(data).results as unknown[])[0] : undefined);
    const id = str(first.id);
    if (!id) throw new EngineDecline(failed.code, failed.words);
    if (TERMINAL_FAIL.test(str(first.status))) throw new EngineDecline(failed.code, failed.words);
    return id;
  }

  // Long-polls the job (each JOBS_WAIT waits up to 15 s) until it is done, failed, or our own limit runs out.
  async wait(jobId: string, kind: HfJob["kind"]): Promise<HfOutcome> {
    const now = this.o.now ?? Date.now;
    const sleep = this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const deadline = now() + (this.o.waitMs ?? 270_000);
    return this.run("wait for the job", async (call) => {
      for (;;) {
        const data = asRecord(await call(T("JOBS_WAIT"), { jobs: [{ index: 0, job_id: jobId }], timeout_seconds: 15 }));
        const job = asRecord(Array.isArray(data.jobs) ? data.jobs[0] : undefined);
        const status = str(job.status).toLowerCase();
        if (TERMINAL_FAIL.test(status)) return { state: "failed" } as const;
        if (status === "completed") {
          const url = str(job.result_url) || (await this.statusUrl(call, jobId, kind));
          return url && publicHttps(url) ? { state: "done", url } as const : { state: "pending" } as const;
        }
        if (status === "lookup_failed" && job.retryable === false) return { state: "pending" } as const;
        if (now() >= deadline) return { state: "pending" } as const;
        await sleep(Math.min(10_000, Math.max(0, (num(data.poll_after_seconds) ?? 2) * 1000)));
      }
    }, { code: "unavailable", words: "Higgsfield didn't answer while the picture was being made." });
  }

  // The full-size result from JOB_STATUS, when the wait's answer carried no address.
  private async statusUrl(call: McpCall, jobId: string, kind: HfJob["kind"]): Promise<string> {
    const g = asRecord(asRecord(await call(T("JOB_STATUS"), { jobId })).generation);
    const r = asRecord(g.results);
    const raw = str(r.rawUrl);
    return raw || (kind === "image" ? str(r.minUrl) : "");
  }
  // No prompt writer here (no `enhance`): the engine writes the premium ad prompt itself (localPhotoshootPrompt).
}

type DeclineFor = { code: "unavailable" | "failed"; words: string };
const LOW = "The Higgsfield credits are running low, so I kept to the simple clean-up.";

/** The connected Higgsfield's credits left, for a line on Your tools; undefined when it can't be read. */
export async function connectedCredits(call: McpCall): Promise<number | undefined> {
  try { return num(asRecord(await call(T("BALANCE"), {})).credits); } catch { return undefined; }
}
