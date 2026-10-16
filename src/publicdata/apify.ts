// A small Apify REST client (https://docs.apify.com/api/v2): run one allow-listed store actor with an input, wait for it
// with a time limit (stopping it when the limit passes), and page through its dataset. No SDK, no MCP server: four
// endpoints over fetch.
//   POST /v2/acts/{owner~name}/runs?waitForFinish=60&maxItems=N&maxTotalChargeUsd=X&timeout=S   start (and wait up to 60 s)
//   GET  /v2/actor-runs/{runId}?waitForFinish=60                                                  wait more
//   POST /v2/actor-runs/{runId}/abort                                                             stop it at our time limit
//   GET  /v2/datasets/{datasetId}/items?clean=true&offset=O&limit=L                               the results, a page at a time
// The token travels only in the Authorization header. It is never put in a URL, an error message or a log line: every
// error here is built from the HTTP status and fixed words, never from a response body or the request.
import { isAllowedActor, type ActorId } from "./actors.js";

export const APIFY_BASE = "https://api.apify.com";
const WAIT_STEP_S = 60;          // the API waits at most 60 s per call
const PAGE = 100;

export interface ApifyRunRequest {
  actor: ActorId;
  input: Record<string, unknown>;
  maxItems: number;              // dataset results we read at most (also sent as the run's own cap)
  maxUsd: number;                // the most this run may charge (sent as maxTotalChargeUsd)
  timeoutMs: number;             // our limit; the run is stopped when it passes
  signal?: AbortSignal;
}

export interface ApifyRunResult {
  runId: string;
  status: string;
  items: unknown[];
  usd?: number;                  // what Apify says the run cost, when it says
}

export interface ApifyClient { run(req: ApifyRunRequest): Promise<ApifyRunResult> }

export type ApifyFailure = "auth" | "no_credit" | "timeout" | "failed" | "http" | "stopped" | "not_allowed";

export class ApifyError extends Error {
  override name = "ApifyError";
  // started: the run had begun on Apify's side, so it may have been charged (the ledger keeps its estimate)
  constructor(readonly kind: ApifyFailure, message: string, readonly started = false) { super(message); }
}

type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; ok: boolean; json(): Promise<unknown> }>;

interface RunData { id?: unknown; status?: unknown; defaultDatasetId?: unknown; usageTotalUsd?: unknown }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class RestApifyClient implements ApifyClient {
  private readonly fetchFn: FetchFn;
  private readonly base: string;
  constructor(private readonly token: string, o: { fetch?: FetchFn; base?: string; now?: () => number } = {}) {
    if (!token) throw new Error("an Apify token is needed");
    this.fetchFn = o.fetch ?? (globalThis.fetch as unknown as FetchFn);
    this.base = (o.base ?? APIFY_BASE).replace(/\/+$/, "");
    this.now = o.now ?? (() => Date.now());
  }
  private readonly now: () => number;

  // The token never appears in what this returns or throws.
  private async call(method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    let r;
    try {
      r = await this.fetchFn(`${this.base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch {
      if (signal?.aborted) throw new ApifyError("stopped", "the lookup was stopped");
      throw new ApifyError("http", "Apify could not be reached");
    }
    if (r.status === 401 || r.status === 403) throw new ApifyError("auth", "Apify refused the token (check APIFY_TOKEN)");
    if (r.status === 402) throw new ApifyError("no_credit", "the Apify account is out of credit");
    if (!r.ok) throw new ApifyError("http", `Apify answered HTTP ${r.status}`);
    try {
      return await r.json();
    } catch {
      throw new ApifyError("http", "Apify sent something that is not JSON");
    }
  }

  private static data(x: unknown): RunData {
    const d = x && typeof x === "object" ? (x as { data?: unknown }).data : undefined;
    return (d && typeof d === "object" ? d : {}) as RunData;
  }

  async run(req: ApifyRunRequest): Promise<ApifyRunResult> {
    if (!isAllowedActor(req.actor)) throw new ApifyError("not_allowed", "that public-data source is not on the allow-list");
    const deadline = this.now() + req.timeoutMs;
    const secs = Math.max(30, Math.ceil(req.timeoutMs / 1000));
    const q = new URLSearchParams({
      waitForFinish: String(Math.min(WAIT_STEP_S, secs)),
      maxItems: String(Math.max(1, Math.floor(req.maxItems))),
      maxTotalChargeUsd: String(Math.max(0.01, Math.round(req.maxUsd * 1000) / 1000)),
      timeout: String(secs),
    });
    const first = RestApifyClient.data(await this.call("POST", `/v2/acts/${encodeURIComponent(req.actor.replace("/", "~"))}/runs?${q}`, req.input, req.signal));
    const runId = typeof first.id === "string" ? first.id : "";
    if (!runId) throw new ApifyError("http", "Apify did not start the run");
    try {
      return await this.finish(req, runId, first, deadline);
    } catch (e) {
      throw e instanceof ApifyError ? new ApifyError(e.kind, e.message, true) : new ApifyError("http", "the lookup could not be finished", true);
    }
  }

  private async finish(req: ApifyRunRequest, runId: string, first: RunData, deadline: number): Promise<ApifyRunResult> {
    let run = first;
    const running = (s: unknown) => s === "READY" || s === "RUNNING";
    while (running(run.status)) {
      const left = deadline - this.now();
      if (left <= 0 || req.signal?.aborted) {
        await this.call("POST", `/v2/actor-runs/${encodeURIComponent(runId)}/abort`).catch(() => undefined);
        throw req.signal?.aborted ? new ApifyError("stopped", "the lookup was stopped") : new ApifyError("timeout", `the lookup took longer than ${Math.round(req.timeoutMs / 1000)} seconds and was stopped`);
      }
      const wait = Math.max(1, Math.min(WAIT_STEP_S, Math.floor(left / 1000)));
      run = RestApifyClient.data(await this.call("GET", `/v2/actor-runs/${encodeURIComponent(runId)}?waitForFinish=${wait}`, undefined, req.signal));
      if (running(run.status) && wait < 2) await sleep(500);
    }
    const usd = typeof run.usageTotalUsd === "number" && Number.isFinite(run.usageTotalUsd) ? run.usageTotalUsd : undefined;
    if (run.status !== "SUCCEEDED") throw new ApifyError("failed", `the lookup ended as ${typeof run.status === "string" ? run.status.toLowerCase().replace(/[^a-z-]/g, "") : "unknown"}`);
    const ds = typeof run.defaultDatasetId === "string" ? run.defaultDatasetId : "";
    const items: unknown[] = [];
    while (ds && items.length < req.maxItems) {
      const limit = Math.min(PAGE, req.maxItems - items.length);
      const page = await this.call("GET", `/v2/datasets/${encodeURIComponent(ds)}/items?clean=true&format=json&offset=${items.length}&limit=${limit}`, undefined, req.signal);
      const rows = Array.isArray(page) ? page : [];
      items.push(...rows.slice(0, limit));
      if (rows.length < limit) break;
    }
    return { runId, status: "SUCCEEDED", items, ...(usd !== undefined ? { usd } : {}) };
  }
}
