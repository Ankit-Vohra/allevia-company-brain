// LIVE VERIFICATION ONLY: a picture-from-a-description engine over the founder's `higgsfield` CLI, for scripts/creative/live-poster.ts.
// The product's engine is the Studio's capped Higgsfield engine (src/studio/engine.ts, being finished in another workstream);
// until it can draw from a description, this script-side adapter lets the live check run the real creating tools end to end.
// It is deliberately small and strict:
//   - argument arrays (execFile, no shell), timeouts that kill the CLI;
//   - a quote (`generate cost`) before every job, and a HARD cap for the whole process (default 10 credits): a job whose quote
//     would cross it is refused before anything is created;
//   - every job is written to a log (model, credits, job id, prompt) for docs/higgsfield-spend.md;
//   - results are downloaded over https only.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClipRequest, CreativeEngine, EngineStatus, GeneratedClip, GeneratedImage, GeneratedMusic, ImageRequest, MusicRequest } from "../../src/creative/ports.js";
import { EngineUnavailable } from "../../src/creative/ports.js";

interface Cli { code: number | null; stdout: string; stderr: string; missing: boolean }
const run = (args: string[], timeoutMs: number): Promise<Cli> => new Promise((resolve) => {
  execFile("higgsfield", args, { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 8 << 20, shell: false }, (err, stdout, stderr) => {
    const e = err as NodeJS.ErrnoException | null;
    resolve({ code: e ? (typeof e.code === "number" ? e.code : null) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), missing: e?.code === "ENOENT" });
  });
});
const json = (s: string): unknown => { try { return JSON.parse(s.trim()); } catch { const a = s.indexOf("{"), b = s.lastIndexOf("}"); try { return a >= 0 ? JSON.parse(s.slice(a, b + 1)) : undefined; } catch { return undefined; } } };

export interface SpendLine { at: string; model: string; credits: number; jobId: string; prompt: string; aspect: string }

export class HiggsfieldTextEngine implements CreativeEngine {
  readonly name = "higgsfield";
  spent = 0;
  readonly log: SpendLine[] = [];
  // replay: finished jobs to use again instead of paying twice (a run that crashed after the jobs were made), by model, in order
  constructor(private o: { cap: number; model?: string; resolution?: string; quality?: string; replay?: Record<string, string[]> }) {}
  private get model(): string { return this.o.model ?? "nano_banana_2_1"; }
  private params(req: ImageRequest): string[] { return [this.model, "--prompt", req.prompt.replace(/^-+/, ""), "--aspect_ratio", req.aspect, "--resolution", this.o.resolution ?? "1k", ...(this.o.quality ? ["--quality", this.o.quality] : [])]; }

  async status(): Promise<EngineStatus> {
    const r = await run(["--json", "account", "status"], 25_000);
    if (r.missing) return { ok: false, reason: "no_cli", plain: "the Higgsfield tool isn't installed on this computer" };
    const j = json(r.stdout) as Record<string, unknown> | undefined;
    const credits = Number(j?.credits ?? j?.balance);
    if (r.code !== 0 || !Number.isFinite(credits)) return { ok: false, reason: "not_signed_in", plain: "the Higgsfield account isn't signed in" };
    if (credits < 5) return { ok: false, reason: "no_credits", plain: "the Higgsfield credits are nearly used up" };
    if (this.spent >= this.o.cap) return { ok: false, reason: "cap", plain: `this run's limit of ${this.o.cap} credits is used up` };
    return { ok: true, credits };
  }

  async quote(req: ImageRequest): Promise<number | null> {
    const r = await run(["--json", "generate", "cost", ...this.params(req)], 60_000);
    const n = Number((json(r.stdout) as { credits?: unknown } | undefined)?.credits);
    return r.code === 0 && Number.isFinite(n) ? n : null;
  }

  async generate(req: ImageRequest): Promise<GeneratedImage> {
    const cost = await this.quote(req);
    if (cost === null) throw new EngineUnavailable("error", "I couldn't get a price for the picture, so I didn't make it");
    if (this.spent + cost > this.o.cap) throw new EngineUnavailable("cap", `that would go over this run's limit of ${this.o.cap} credits`);
    this.spent += cost; // reserved before the job starts: a crash cannot spend past the cap
    const c = await run(["--json", "generate", "create", ...this.params(req)], 120_000);
    const created = json(c.stdout);
    const id = (JSON.stringify(created ?? c.stdout).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) ?? [])[0];
    if (!id) { this.spent -= cost; throw new EngineUnavailable("error", "the picture didn't start (nothing was charged)"); }
    this.log.push({ at: new Date().toISOString(), model: this.model, credits: cost, jobId: id, prompt: req.prompt, aspect: req.aspect });
    await run(["generate", "wait", id, "--timeout", "4m", "--quiet"], 260_000);
    const g = json((await run(["--json", "generate", "get", id], 30_000)).stdout) as { status?: string; result_url?: string } | undefined;
    if (g?.status !== "completed" || !g.result_url?.startsWith("https://")) throw new EngineUnavailable("error", `the picture didn't finish (${g?.status ?? "no answer"})`);
    const res = await fetch(g.result_url, { signal: AbortSignal.timeout(90_000) });
    if (!res.ok) throw new EngineUnavailable("error", "the finished picture couldn't be downloaded");
    return { image: Buffer.from(await res.arrayBuffer()), engine: "higgsfield", model: this.model, prompt: req.prompt, jobId: id, credits: cost, recorded: false };
  }

  // One quoted, capped job of any model; returns the finished file.
  private async job(model: string, params: string[], prompt: string, aspect: string): Promise<{ bytes: Buffer; id: string; cost: number }> {
    const again = this.o.replay?.[model]?.shift();
    if (again) {
      const g = json((await run(["--json", "generate", "get", again], 30_000)).stdout) as { status?: string; result_url?: string } | undefined;
      if (g?.status === "completed" && g.result_url?.startsWith("https://")) {
        const res = await fetch(g.result_url, { signal: AbortSignal.timeout(180_000) });
        if (res.ok) {
          this.log.push({ at: new Date().toISOString(), model, credits: 0, jobId: again, prompt: `(replayed) ${prompt}`, aspect });
          return { bytes: Buffer.from(await res.arrayBuffer()), id: again, cost: 0 };
        }
      }
    }
    const q = await run(["--json", "generate", "cost", model, ...params], 120_000);
    const cost = Number((json(q.stdout) as { credits?: unknown } | undefined)?.credits);
    if (q.code !== 0 || !Number.isFinite(cost)) throw new EngineUnavailable("error", `I couldn't get a price for the ${model} job, so I didn't start it`);
    if (this.spent + cost > this.o.cap) throw new EngineUnavailable("cap", `that would go over this run's limit of ${this.o.cap} credits`);
    this.spent += cost;
    const c = await run(["--json", "generate", "create", model, ...params], 180_000);
    const id = (JSON.stringify(json(c.stdout) ?? c.stdout).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) ?? [])[0];
    if (!id) { this.spent -= cost; throw new EngineUnavailable("error", `the ${model} job didn't start (nothing was charged)`); }
    this.log.push({ at: new Date().toISOString(), model, credits: cost, jobId: id, prompt, aspect });
    await run(["generate", "wait", id, "--timeout", "8m", "--quiet"], 500_000);
    const g = json((await run(["--json", "generate", "get", id], 30_000)).stdout) as { status?: string; result_url?: string } | undefined;
    if (g?.status !== "completed" || !g.result_url?.startsWith("https://")) throw new EngineUnavailable("error", `the ${model} job didn't finish (${g?.status ?? "no answer"})`);
    const res = await fetch(g.result_url, { signal: AbortSignal.timeout(180_000) });
    if (!res.ok) throw new EngineUnavailable("error", "the finished file couldn't be downloaded");
    return { bytes: Buffer.from(await res.arrayBuffer()), id, cost };
  }

  private clipParams(req: Pick<ClipRequest, "seconds" | "aspect">, prompt: string, image: string): string[] {
    return ["--prompt", prompt.replace(/^-+/, ""), "--start-image", image, "--aspect_ratio", req.aspect === "9:16" ? "9:16" : "3:4", "--duration", String(Math.max(4, Math.min(8, Math.round(req.seconds)))), "--resolution", "720p", "--generate_audio", "false"];
  }

  async quoteClip(): Promise<number | null> { return 5; } // seedance_2_0_mini, 5 s at 720p, no sound: quoted again with the real picture before the job

  async animate(req: ClipRequest): Promise<GeneratedClip> {
    const dir = mkdtempSync(join(tmpdir(), "allevia-clip-"));
    try {
      const f = join(dir, "start.jpg");
      writeFileSync(f, req.image);
      const r = await this.job("seedance_2_0_mini", this.clipParams(req, req.prompt, f), req.prompt, req.aspect);
      return { video: r.bytes, engine: "higgsfield", model: "seedance_2_0_mini", jobId: r.id, credits: r.cost, mime: "video/mp4", seconds: req.seconds };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async quoteMusic(req: MusicRequest): Promise<number | null> {
    const q = await run(["--json", "generate", "cost", "sonilo_music", "--prompt", req.prompt.replace(/^-+/, ""), "--duration", String(Math.round(req.seconds))], 60_000);
    const n = Number((json(q.stdout) as { credits?: unknown } | undefined)?.credits);
    return q.code === 0 && Number.isFinite(n) ? n : null;
  }

  async music(req: MusicRequest): Promise<GeneratedMusic> {
    const r = await this.job("sonilo_music", ["--prompt", req.prompt.replace(/^-+/, ""), "--duration", String(Math.round(req.seconds))], req.prompt, "audio");
    return { audio: r.bytes, model: "sonilo_music", jobId: r.id, credits: r.cost };
  }
}
