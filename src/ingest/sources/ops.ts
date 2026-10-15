// The aamdani-ops source: a READ-ONLY snapshot of Aamdani's live business data through its existing `aamdani-ops` MCP
// server (aamdani-social-automation, src/ops-mcp), started over SSH on the marketing box exactly the way Jarvis starts
// it (scripts/ops-mcp-launch.sh -> gen.sh's light path: no generation lock, nothing printed on stdout).
//
// Read-only discipline, in code:
//   - READ_TOOLS is the allow-list. OpsClient.call() refuses anything else before a byte is sent, and refuses a tool the
//     server itself does not list with readOnlyHint true (so listTools() must run first). Writes (brain_add_note,
//     github_*), infrastructure (server_health, cron_status), Clarity (10 reads a day) and money are never called.
//   - The only remote command is the MCP launch, with OPS_BRAIN_PULL=0 (brain_pending would otherwise `git pull` the
//     box's brain checkout) and OPS_CACHE_DIR pointed at a temp dir (only clarity_insights writes there, and it is not
//     on the list, so nothing is written on the box). The tools' answer cache lives in memory and dies with the process.
//   - Instagram, Facebook and YouTube share Instagram's 200 calls/hour with the live publisher: each is called once,
//     sequentially, and the group stops at the first rate-limit sign (in the message, warnings or data, any status).
//   - ssh: alias or user/host must be plain words (no leading "-"); no agent or port forwarding, no agent socket, and
//     the key file only on the direct path.
// Snapshots land in <dataDir>/snapshots/<tenant>/<IST date>/ (gitignored); ops-map/ turns them into graph writes.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadConfig, type AlleviaConfig } from "../../config.js";
import { istDate } from "../../util/time.js";
import { redactText } from "./ops-map/index.js";

export { mapSnapshot } from "./ops-map/index.js";

// The allow-list (spec §6.2), and why each is safe to call. Every one is a read (readOnly in aamdani-ops); the
// app-database tools read its PII-free `ops` views through a read-only database role. Finance stays out (founder's
// privacy rule), so `money` is not here and admin_metrics' money metrics are dropped by the mapper.
//   users_summary       account counts by kind, platform and channel; no person-level rows
//   new_users           new accounts per IST day; counts only
//   acquisition_sources sign-ups by channel / source; counts only
//   signup_funnel       stage counts for seekers and employers; counts only
//   marketplace         jobs, applications and hires as counts
//   admin_metrics       the COE dashboard tiles (aggregates); the mapper drops money / plan / price metrics
//   published_content   our own posts: per-channel publish result, caption first line, public ids
//   review_cards        the approval queue as counts (the mapper reads only the summary)
//   brain_pending       PENDING items; the mapper keeps only counts by owner, and skips sensitive sections entirely
//   search_console      Google Search aggregates per query / page (Google already hides rare queries)
//   analytics_ga4       aggregated visitor numbers by source / page; consent-gated
//   posthog_funnels     in-app activity and funnel counts; test accounts filtered by PostHog
//   sentry_issues       crash-free rates and issue counts (the mapper reads no issue text)
//   play_health         Play vitals rates; called with reviews: 0, so no review text
//   app_store_status    App Store review state; called with reviews: 0, so no review text
//   ai_features         AI screening / voice onboarding / helpline call counts and rates
//   reels_performance   our own reels' public metrics (Instagram budget group)
//   account_reach       our own account's reach and followers (Instagram budget group)
//   facebook_reels      our own Page reels' metrics (Instagram budget group)
//   youtube_stats       our own channel and uploads (Instagram budget group)
//   connectors_status   whether each integration works; the mapper keeps only name and status (Instagram budget group)
export const READ_TOOLS = [
  "users_summary", "new_users", "acquisition_sources", "signup_funnel", "marketplace", "admin_metrics",
  "published_content", "review_cards", "brain_pending", "search_console", "analytics_ga4", "posthog_funnels",
  "sentry_issues", "play_health", "app_store_status", "ai_features", "reels_performance", "account_reach",
  "facebook_reels", "youtube_stats", "connectors_status",
] as const;
export type ReadTool = (typeof READ_TOOLS)[number];

const READ_SET = new Set<string>(READ_TOOLS);
export const isReadTool = (name: string): name is ReadTool => READ_SET.has(name);

export class RefusedToolError extends Error {
  constructor(readonly tool: string, why: string) {
    super(`refused to call ${JSON.stringify(tool)}: ${why}`);
    this.name = "RefusedToolError";
  }
}

export const TENANT = "aamdani";
export const REMOTE_CACHE_DIR = "/tmp/allevia-ops-cache";
export const CALL_TIMEOUT_MS = 90_000;
const CONNECT_TIMEOUT_MS = 60_000;

/** The envelope every aamdani-ops tool answers in (src/ops-mcp/envelope.ts there). */
export interface Envelope {
  tool: string;
  status: "ok" | "not_configured" | "error";
  asOf: string;
  asOfIST?: string;
  sources: string[];
  message?: string;
  setup?: string;
  warnings?: string[];
  cached?: boolean;
  data?: unknown;
}

export interface OpsCaller {
  listTools(): Promise<string[]>;
  call(name: string, args: Record<string, unknown>): Promise<Envelope>;
}

export interface LaunchSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The one command run on the box: start the MCP server the way Jarvis does, reading nothing else and writing nothing. */
export function remoteCommand(remoteDir: string): string {
  return `cd ${shq(remoteDir)} && exec env OPS_CACHE_DIR=${shq(REMOTE_CACHE_DIR)} OPS_BRAIN_PULL=0 bash scripts/ops-mcp-launch.sh`;
}

// An ssh destination word: no leading "-" (which ssh would read as an option), no spaces or shell characters.
const SSH_WORD = /^[A-Za-z0-9][\w.@-]*$/;
/** opsSsh.via values that mean "no alias: ssh to user@host with the key". */
const NO_ALIAS = /^(none|direct|off)$/i;

export type OpsSshConfig = Pick<AlleviaConfig["opsSsh"], "host" | "user" | "keyPath" | "remoteDir"> & { via?: string };

/**
 * ssh to the box, non-interactive. `via` (the call's, else the config's) names an ssh config alias instead of user@host:
 * the box has no public SSH, and its alias goes through a tunnel (which needs longer to open). Without one (or with
 * via "none"), user@host with the key is the fallback.
 */
export function sshLaunch(ssh: OpsSshConfig, opts: { via?: string } = {}): LaunchSpec {
  const v = opts.via ?? ssh.via;
  const via = v === undefined || NO_ALIAS.test(v) ? undefined : v;
  const check = (what: string, w: string) => {
    if (!SSH_WORD.test(w)) throw new Error(`ops ssh: ${what} ${JSON.stringify(w)} is not a plain host/alias/user name`);
  };
  if (via !== undefined) check("alias", via);
  else { check("user", ssh.user); check("host", ssh.host); }
  // No agent socket: the child gets only the default environment plus what the tunnel (the alias's ProxyCommand)
  // needs to find its AWS credentials.
  const env: Record<string, string> = { ...getDefaultEnvironment() };
  for (const k of ["AWS_PROFILE", "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE"]) {
    const val = process.env[k];
    if (val) env[k] = val;
  }
  delete env.SSH_AUTH_SOCK;
  return {
    command: "ssh",
    args: [
      // The alias brings its own IdentityFile; the key is passed only on the direct path.
      ...(via === undefined && ssh.keyPath ? ["-i", ssh.keyPath] : []),
      "-T",
      "-o", "BatchMode=yes", "-o", `ConnectTimeout=${via ? 25 : 15}`, "-o", "ServerAliveInterval=20", "-o", "LogLevel=ERROR",
      "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes",
      via ?? `${ssh.user}@${ssh.host}`, remoteCommand(ssh.remoteDir),
    ],
    env,
  };
}

function parseEnvelope(name: string, res: Record<string, unknown>): Envelope {
  const sc = res.structuredContent as Partial<Envelope> | undefined;
  if (sc && typeof sc === "object" && typeof sc.status === "string") return sc as Envelope;
  const text = Array.isArray(res.content) ? (res.content.find((c: { type?: string }) => c?.type === "text") as { text?: string } | undefined)?.text : undefined;
  if (text) {
    try {
      const j = JSON.parse(text) as Partial<Envelope>;
      if (j && typeof j.status === "string") return j as Envelope;
    } catch { /* not an envelope */ }
  }
  return { tool: name, status: "error", asOf: new Date().toISOString(), sources: [],
    message: `the server answered without an envelope${text ? `: ${redactText(text.slice(0, 200)).text}` : ""}` };
}

export class OpsClient implements OpsCaller {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private readOnly: Map<string, boolean | undefined> | null = null; // set by listTools()
  private stderr: string[] = [];
  private readonly callTimeoutMs: number;

  constructor(private readonly spec: LaunchSpec, opts: { callTimeoutMs?: number } = {}) {
    this.callTimeoutMs = opts.callTimeoutMs ?? CALL_TIMEOUT_MS;
  }

  async connect(): Promise<void> {
    if (this.client) return;
    this.transport = new StdioClientTransport({ command: this.spec.command, args: this.spec.args, env: this.spec.env, stderr: "pipe" });
    // Keep a short, redacted tail of the server's (and ssh's) stderr for error reports; never echo it.
    this.transport.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) if (line.trim()) this.stderr.push(redactText(line.slice(0, 300)).text);
      if (this.stderr.length > 20) this.stderr.splice(0, this.stderr.length - 20);
    });
    const client = new Client({ name: "allevia-ops-snapshot", version: "0.1.0" });
    try {
      await client.connect(this.transport, { timeout: CONNECT_TIMEOUT_MS });
    } catch (e) {
      await this.transport.close().catch(() => {});
      this.transport = null;
      throw new Error(`could not start aamdani-ops: ${(e as Error).message}${this.stderr.length ? ` — stderr: ${this.stderrTail()}` : ""}`);
    }
    this.client = client;
  }

  stderrTail(): string {
    return this.stderr.slice(-5).join(" | ");
  }

  async listTools(): Promise<string[]> {
    if (!this.client) throw new Error("OpsClient is not connected");
    const { tools } = await this.client.listTools(undefined, { timeout: this.callTimeoutMs });
    this.readOnly = new Map(tools.map((t) => [t.name, t.annotations?.readOnlyHint]));
    return tools.map((t) => t.name);
  }

  async call(name: string, args: Record<string, unknown>): Promise<Envelope> {
    // The allow-list comes first: a refused tool never reaches the transport, connected or not. Then the server's own
    // word: only a tool it lists with readOnlyHint exactly true is called, so listTools() must have run.
    if (!isReadTool(name)) throw new RefusedToolError(name, "not on the read-only allow-list");
    if (!this.readOnly) throw new RefusedToolError(name, "listTools() has not run, so the server's read-only flags are unknown");
    if (this.readOnly.get(name) !== true) throw new RefusedToolError(name, "the server does not mark it read-only");
    if (!this.client) throw new Error("OpsClient is not connected");
    const res = await this.client.callTool({ name, arguments: args }, undefined, { timeout: this.callTimeoutMs });
    return parseEnvelope(name, res);
  }

  snapshot(outDir: string, opts: SnapshotOptions = {}): Promise<SnapshotManifest> {
    return snapshot(this, outDir, opts);
  }

  async close(): Promise<void> {
    const c = this.client, t = this.transport;
    this.client = null;
    this.transport = null;
    this.readOnly = null;
    if (c) await c.close().catch(() => {});
    else if (t) await t.close().catch(() => {});
  }
}

// ---------- the call plan ----------

export interface CallSpec {
  call: string;          // manifest key and file stem: the tool name, or "<tool>.<variant>" for a second breakdown
  tool: ReadTool;
  args: Record<string, unknown>;
  file: string;
  budget?: "instagram";  // shares Instagram's 200 calls/hour with the live publisher
}

const DAY_MS = 86_400_000;

/**
 * One call per read tool (two for Search Console and GA4: by query and by page, by source and by page), 28-day windows
 * where a tool offers one, never `fresh: true`, and no review texts (Play, App Store). Every key is in the tool's
 * strict input schema; an unknown key would be refused by the server.
 */
export function buildCallPlan(now: Date): CallSpec[] {
  const to = istDate(now.getTime());
  const from = istDate(Date.parse(`${to}T12:00:00Z`) - 27 * DAY_MS);
  const range = { from, to };
  const spec = (tool: ReadTool, args: Record<string, unknown>, variant?: string, budget?: "instagram"): CallSpec => {
    const call = variant ? `${tool}.${variant}` : tool;
    return { call, tool, args, file: `${call}.json`, ...(budget ? { budget } : {}) };
  };
  return [
    // the app database (read-only ops views)
    spec("users_summary", {}),
    spec("new_users", { ...range, group_by: "day" }),
    spec("acquisition_sources", { ...range, limit: 15 }),
    spec("signup_funnel", { ...range }),
    spec("marketplace", { ...range, top: 10, series: false }),
    spec("ai_features", { ...range }),
    spec("admin_metrics", { tab: "overview", days: 28 }),
    // marketing tables and the brain
    spec("published_content", { days: 28, limit: 100 }),
    spec("review_cards", { days: 28, limit: 100 }),
    spec("brain_pending", { owner: "all", include_done: false, limit: 200 }),
    // Google, PostHog, Sentry, the stores
    spec("search_console", { days: 28, breakdown: "query", limit: 25, fresh: false }),
    spec("search_console", { days: 28, breakdown: "page", limit: 25, fresh: false }, "page"),
    spec("analytics_ga4", { days: 28, breakdown: "source", site: "all", limit: 25, fresh: false }),
    spec("analytics_ga4", { days: 28, breakdown: "page", site: "www", limit: 25, fresh: false }, "page"),
    spec("posthog_funnels", { days: 28, funnel: "seeker_signup", fresh: false }),
    spec("sentry_issues", { period: "14d", environment: "production", limit: 10, fresh: false }),
    spec("play_health", { days: 28, reviews: 0, fresh: false }),
    spec("app_store_status", { reviews: 0, fresh: false }),
    // Instagram's shared budget, last and one at a time (connectors_status reads Instagram /me too)
    spec("reels_performance", { days: 28, include_duration: false, fresh: false }, undefined, "instagram"),
    spec("account_reach", { fresh: false }, undefined, "instagram"),
    spec("facebook_reels", { limit: 25, fresh: false }, undefined, "instagram"),
    spec("youtube_stats", { limit: 25, fresh: false }, undefined, "instagram"),
    spec("connectors_status", {}, undefined, "instagram"),
  ];
}

const RATE_LIMIT = /rate.?limit|too many (calls|requests)|request limit|\(#(4|17|32|613)\)|\b429\b|quota exceeded|user request limit/i;

// Error strings inside the data: a partial failure (account_reach's window warnings, a reel's insightsError) comes
// back with status ok, so the rate-limit check cannot rely on the status.
function errorStrings(v: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 6 || out.length > 200 || !v || typeof v !== "object") return out;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (typeof x === "string" && /error|warning/i.test(k)) out.push(x);
    else if (x && typeof x === "object") errorStrings(x, depth + 1, out);
  }
  return out;
}

/** True when any part of the answer (message, warnings, error fields in the data) reports a rate limit, whatever the status. */
export function isRateLimited(e: Envelope): boolean {
  return RATE_LIMIT.test([e.message ?? "", ...(e.warnings ?? []), ...errorStrings(e.data)].join(" "));
}

// ---------- snapshot ----------

export interface ManifestEntry {
  tool: string;
  file: string;
  args: Record<string, unknown>;
  status: Envelope["status"];
  asOf: string;
  ms: number;
  bytes: number;
  cached?: boolean;
  message?: string;
}

export interface SnapshotManifest {
  tenant: string;
  snapshotDate: string;
  startedAt: string;
  finishedAt: string;
  remoteCacheDir: string;
  serverToolCount: number;
  calls: Record<string, ManifestEntry>;
  skipped: Record<string, string>;
  error?: string;    // listTools() failed: no call was made
  aborted?: boolean; // stopped by a signal (Ctrl-C)
}

export interface SnapshotOptions {
  now?: Date;
  plan?: CallSpec[];
  log?: (line: string) => void;
  signal?: AbortSignal;
}

/** Calls each planned read tool the server lists, once, sequentially; writes `<call>.json` (the envelope) and a manifest. */
export async function snapshot(caller: OpsCaller, outDir: string, opts: SnapshotOptions = {}): Promise<SnapshotManifest> {
  const now = opts.now ?? new Date();
  const plan = opts.plan ?? buildCallPlan(now);
  const log = opts.log ?? (() => {});
  mkdirSync(outDir, { recursive: true });
  const manifest: SnapshotManifest = {
    tenant: TENANT, snapshotDate: istDate(now.getTime()), startedAt: new Date().toISOString(), finishedAt: "",
    remoteCacheDir: REMOTE_CACHE_DIR, serverToolCount: 0, calls: {}, skipped: {},
  };
  const writeManifest = () => {
    manifest.finishedAt = new Date().toISOString();
    writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 1)}\n`);
  };
  let listed: Set<string>;
  try {
    listed = new Set(await caller.listTools());
  } catch (e) {
    manifest.error = `listTools failed: ${redactText(String((e as Error)?.message ?? e).slice(0, 300)).text}`;
    writeManifest();
    throw e;
  }
  manifest.serverToolCount = listed.size;
  let instagramLimited: string | null = null;
  for (const c of plan) {
    if (opts.signal?.aborted) { manifest.aborted = true; manifest.skipped[c.call] = "aborted"; continue; }
    if (!isReadTool(c.tool)) { manifest.skipped[c.call] = "not on the read-only allow-list"; continue; }
    if (!listed.has(c.tool)) { manifest.skipped[c.call] = "not listed by the server"; continue; }
    if (c.budget === "instagram" && instagramLimited) {
      manifest.skipped[c.call] = `Instagram rate limit hit by ${instagramLimited}; not spending more of the publisher's budget`;
      continue;
    }
    const t0 = Date.now();
    let env: Envelope;
    try {
      env = await caller.call(c.tool, c.args);
    } catch (e) {
      if (e instanceof RefusedToolError) { manifest.skipped[c.call] = e.message; continue; }
      env = { tool: c.tool, status: "error", asOf: new Date().toISOString(), sources: [],
        message: redactText(String((e as Error)?.message ?? e).slice(0, 300)).text };
    }
    const ms = Date.now() - t0;
    const text = `${JSON.stringify(env, null, 1)}\n`;
    writeFileSync(join(outDir, c.file), text);
    manifest.calls[c.call] = {
      tool: c.tool, file: c.file, args: c.args, status: env.status, asOf: env.asOf, ms, bytes: Buffer.byteLength(text),
      ...(env.cached ? { cached: true } : {}),
      ...(env.status !== "ok" && env.message ? { message: redactText(env.message.slice(0, 200)).text } : {}),
    };
    log(`${c.call}: ${env.status} in ${ms} ms`);
    if (c.budget === "instagram" && isRateLimited(env)) instagramLimited = c.call;
  }
  writeManifest();
  return manifest;
}

/** Snapshot directory for a date: <dataDir>/snapshots/aamdani/<YYYY-MM-DD>. */
export function snapshotDir(cfg: AlleviaConfig, date: string): string {
  return join(cfg.dataDir, "snapshots", TENANT, date);
}

/**
 * One live, read-only snapshot over SSH (scripts/ops-snapshot.ts; not yet wired into the ingest CLI). `via` overrides the
 * config's ssh alias (opsSsh.via, default aamdani-box). Aborting `signal` closes the connection (which ends the remote
 * server) and the snapshot stops before its next call.
 */
export async function runOpsSnapshot(opts: { via?: string; now?: Date; log?: (line: string) => void; signal?: AbortSignal } = {}): Promise<{ dir: string; manifest: SnapshotManifest }> {
  const cfg = loadConfig();
  const now = opts.now ?? new Date();
  const dir = snapshotDir(cfg, istDate(now.getTime()));
  const client = new OpsClient(sshLaunch(cfg.opsSsh, { via: opts.via }));
  const onAbort = () => { void client.close(); };
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await client.connect();
    const manifest = await client.snapshot(dir, { now, log: opts.log, signal: opts.signal });
    return { dir, manifest };
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    await client.close();
  }
}
