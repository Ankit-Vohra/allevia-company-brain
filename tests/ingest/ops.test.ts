// The ops source's guard rails: only allow-listed read tools that the server itself marks read-only are ever called,
// the SSH launch runs nothing but the MCP server, and snapshot() writes one envelope per call plus a manifest. No test
// touches SSH or the production box: the client is exercised against a fake stdio MCP server
// (tests/fixtures/ops/fake-ops-server.ts).
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  READ_TOOLS, isReadTool, RefusedToolError, OpsClient, sshLaunch, remoteCommand, buildCallPlan, snapshot, isRateLimited,
  REMOTE_CACHE_DIR, type Envelope, type OpsCaller,
} from "../../src/ingest/sources/ops.js";

const FAKE_SERVER = fileURLToPath(new URL("../fixtures/ops/fake-ops-server.ts", import.meta.url));
const tmp: string[] = [];
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), "allevia-ops-")); tmp.push(d); return d; };
afterAll(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });

const REFUSED = ["brain_add_note", "github_create_issue", "github_comment_issue", "server_health", "cron_status", "clarity_insights", "money"];

const ok = (tool: string, data: unknown = {}): Envelope => ({ tool, status: "ok", asOf: "2026-10-15T03:00:00.000Z", sources: ["fake"], data });

describe("READ_TOOLS allow-list", () => {
  it("is exactly the read tools the snapshot may call (no money)", () => {
    expect([...READ_TOOLS].sort()).toEqual([
      "account_reach", "acquisition_sources", "admin_metrics", "ai_features", "analytics_ga4", "app_store_status",
      "brain_pending", "connectors_status", "facebook_reels", "marketplace", "new_users", "play_health",
      "posthog_funnels", "published_content", "reels_performance", "review_cards", "search_console", "sentry_issues",
      "signup_funnel", "users_summary", "youtube_stats",
    ]);
  });

  it("refuses writes, infrastructure tools, Clarity and money", () => {
    for (const t of REFUSED) expect(isReadTool(t), t).toBe(false);
    expect(isReadTool("users_summary")).toBe(true);
    expect(isReadTool("USERS_SUMMARY")).toBe(false);
  });

  it("OpsClient.call refuses them before anything is spawned or sent", async () => {
    // A command that cannot exist: if call() got past the checks it would fail differently (not connected).
    const client = new OpsClient({ command: "/nonexistent/allevia-should-never-run", args: [] });
    for (const t of REFUSED) await expect(client.call(t, {}), t).rejects.toBeInstanceOf(RefusedToolError);
    await client.close();
  });

  it("OpsClient.call refuses even an allow-listed tool until listTools() has run", async () => {
    const client = new OpsClient({ command: "/nonexistent/allevia-should-never-run", args: [] });
    await expect(client.call("users_summary", {})).rejects.toThrow(/listTools\(\) has not run/);
    await client.close();
  });
});

describe("SSH launch", () => {
  const ssh = { host: "203.0.113.10", user: "ankit", keyPath: "/Users/x/.ssh/k.pem", remoteDir: "/home/ankit/aamdani-social-automation" };

  it("builds a non-interactive ssh that runs only the MCP launch script, with no forwarding", () => {
    const l = sshLaunch(ssh);
    expect(l.command).toBe("ssh");
    expect(l.args.slice(0, 2)).toEqual(["-i", "/Users/x/.ssh/k.pem"]);
    for (const o of ["BatchMode=yes", "ConnectTimeout=15", "ServerAliveInterval=20", "ForwardAgent=no", "ClearAllForwardings=yes"]) {
      expect(l.args, o).toContain(o);
    }
    expect(l.args).toContain("ankit@203.0.113.10");
    const remote = l.args.at(-1)!;
    expect(remote).toBe(remoteCommand(ssh.remoteDir));
    expect(remote).toBe(`cd '/home/ankit/aamdani-social-automation' && exec env OPS_CACHE_DIR='${REMOTE_CACHE_DIR}' OPS_BRAIN_PULL=0 bash scripts/ops-mcp-launch.sh`);
    expect(remote).not.toMatch(/systemctl|crontab|restart|sudo|rm |git /);
  });

  it("goes through an ssh config alias without -i (the alias has its own key)", () => {
    const l = sshLaunch(ssh, { via: "aamdani-box" });
    expect(l.args).toContain("aamdani-box");
    expect(l.args).not.toContain("ankit@203.0.113.10");
    expect(l.args).not.toContain("-i");
    expect(l.args).not.toContain(ssh.keyPath);
    for (const o of ["ForwardAgent=no", "ClearAllForwardings=yes", "ConnectTimeout=25"]) expect(l.args, o).toContain(o);
    expect(l.args.at(-1)).toBe(remoteCommand(ssh.remoteDir));
  });

  it("via \"none\" (in the config or the call) means user@host with the key; no key file means no -i", () => {
    for (const l of [sshLaunch({ ...ssh, via: "none" }), sshLaunch({ ...ssh, via: "aamdani-box" }, { via: "none" })]) {
      expect(l.args.slice(0, 2)).toEqual(["-i", ssh.keyPath]);
      expect(l.args).toContain("ankit@203.0.113.10");
      expect(l.args).toContain("ConnectTimeout=15");
    }
    expect(sshLaunch({ ...ssh, keyPath: "" }).args).not.toContain("-i");
    expect(() => sshLaunch({ ...ssh, host: "", via: "none" })).toThrow(/host/);
  });

  it("uses the config's alias by default; an explicit via overrides it", () => {
    expect(sshLaunch({ ...ssh, via: "aamdani-box" }).args).toContain("aamdani-box");
    expect(sshLaunch({ ...ssh, via: "aamdani-box" }).args).not.toContain("ankit@203.0.113.10");
    expect(sshLaunch({ ...ssh, via: "aamdani-box" }, { via: "other" }).args).toContain("other");
  });

  it("refuses an alias, user or host that ssh could read as an option or that is not a plain name", () => {
    for (const via of ["-oProxyCommand=sh", "-F/tmp/x", "box name", "a;b", "", "$(id)"]) {
      expect(() => sshLaunch(ssh, { via }), via).toThrow(/not a plain/);
    }
    expect(() => sshLaunch({ ...ssh, host: "-oProxyCommand=sh" })).toThrow(/host/);
    expect(() => sshLaunch({ ...ssh, user: "-l" })).toThrow(/user/);
    expect(() => sshLaunch({ ...ssh, host: "box.example.test", user: "a.b-c_d" })).not.toThrow();
    // On the alias path user/host are not used, so they are not what is checked.
    expect(() => sshLaunch({ ...ssh, host: "-x" }, { via: "aamdani-box" })).not.toThrow();
  });

  it("does not hand the agent socket to the child", () => {
    const before = process.env.SSH_AUTH_SOCK;
    process.env.SSH_AUTH_SOCK = "/tmp/fake-agent.sock";
    try {
      expect(sshLaunch(ssh).env?.SSH_AUTH_SOCK).toBeUndefined();
      expect(sshLaunch(ssh, { via: "aamdani-box" }).env?.SSH_AUTH_SOCK).toBeUndefined();
    } finally {
      if (before === undefined) delete process.env.SSH_AUTH_SOCK; else process.env.SSH_AUTH_SOCK = before;
    }
  });

  it("quotes the remote directory", () => {
    expect(remoteCommand("/home/a b/it's")).toContain(`cd '/home/a b/it'\\''s'`);
  });
});

describe("call plan", () => {
  const now = new Date("2026-10-15T03:00:00Z"); // 08:30 IST
  const plan = buildCallPlan(now);

  it("covers every read tool, and nothing else", () => {
    expect(new Set(plan.map((c) => c.tool))).toEqual(new Set(READ_TOOLS));
    for (const c of plan) expect(isReadTool(c.tool)).toBe(true);
    expect(new Set(plan.map((c) => c.file)).size).toBe(plan.length);
    expect(plan.map((c) => c.tool)).not.toContain("money");
  });

  it("uses 28-day windows, never forces a fresh read, and asks for no review texts", () => {
    const args = (call: string) => plan.find((c) => c.call === call)!.args;
    expect(args("acquisition_sources")).toMatchObject({ from: "2026-09-18", to: "2026-10-15" });
    expect(args("signup_funnel")).toMatchObject({ from: "2026-09-18", to: "2026-10-15" });
    expect(args("search_console")).toMatchObject({ days: 28, breakdown: "query", fresh: false });
    expect(args("search_console.page")).toMatchObject({ days: 28, breakdown: "page", fresh: false });
    expect(args("reels_performance")).toMatchObject({ days: 28, fresh: false, include_duration: false });
    expect(args("play_health")).toMatchObject({ reviews: 0 });
    expect(args("app_store_status")).toMatchObject({ reviews: 0 });
    for (const c of plan) if ("fresh" in c.args) expect(c.args.fresh, c.call).toBe(false);
  });

  it("puts the Instagram-budget tools in one group", () => {
    const ig = plan.filter((c) => c.budget === "instagram").map((c) => c.tool).sort();
    expect(ig).toEqual(["account_reach", "connectors_status", "facebook_reels", "reels_performance", "youtube_stats"]);
  });
});

describe("isRateLimited", () => {
  const err = (message: string): Envelope => ({ ...ok("reels_performance"), status: "error", message });

  it("recognises Graph API and HTTP rate-limit errors", () => {
    expect(isRateLimited(err("Graph error (#4) Application request limit reached"))).toBe(true);
    expect(isRateLimited(err("HTTP 429 Too Many Requests"))).toBe(true);
    expect(isRateLimited(err("rate limit exceeded"))).toBe(true);
    expect(isRateLimited(err("token expired"))).toBe(false);
    expect(isRateLimited(ok("reels_performance"))).toBe(false);
  });

  it("sees a partial failure: status ok with the Graph error in warnings or in the data", () => {
    expect(isRateLimited({ ...ok("account_reach"), warnings: ["last28d: (#4) Application request limit reached"] })).toBe(true);
    expect(isRateLimited(ok("reels_performance", { reels: [{ id: "1", insightsError: "HTTP 429: too many calls" }] }))).toBe(true);
    expect(isRateLimited({ ...ok("account_reach"), warnings: ["follower history unavailable: table missing"] })).toBe(false);
    expect(isRateLimited(ok("reels_performance", { reels: [{ id: "1", caption: "rate limit our posting? no" }] }))).toBe(false);
  });
});

function fakeCaller(listed: string[], answer: (name: string, args: Record<string, unknown>) => Envelope) {
  const calls: string[] = [];
  const caller: OpsCaller = {
    listTools: async () => listed,
    call: async (name, args) => { calls.push(name); return answer(name, args); },
  };
  return { caller, calls };
}

describe("snapshot()", () => {
  const now = new Date("2026-10-15T03:00:00Z");

  it("calls each listed read tool once per planned call and writes envelope files plus a manifest", async () => {
    const dir = tempDir();
    const listed = [...READ_TOOLS, ...REFUSED, "ops_tools_help"].filter((t) => t !== "ai_features");
    const { caller, calls } = fakeCaller(listed, (name) => ok(name, { n: 1 }));
    const manifest = await snapshot(caller, dir, { now });

    expect(calls.every((c) => isReadTool(c))).toBe(true);
    expect(calls).not.toContain("ai_features");
    for (const t of REFUSED) expect(calls).not.toContain(t);
    expect(calls.filter((c) => c === "users_summary")).toHaveLength(1);
    expect(calls.filter((c) => c === "search_console")).toHaveLength(2); // query + page breakdowns

    expect(manifest.skipped.ai_features).toMatch(/not listed/);
    expect(manifest.calls.users_summary).toMatchObject({ tool: "users_summary", status: "ok", file: "users_summary.json" });
    expect(manifest.calls.users_summary!.bytes).toBeGreaterThan(0);
    expect(manifest.calls["search_console.page"]!.file).toBe("search_console.page.json");
    expect(manifest.remoteCacheDir).toBe(REMOTE_CACHE_DIR);

    const files = readdirSync(dir).sort();
    expect(files).toContain("manifest.json");
    expect(files).not.toContain("ai_features.json");
    expect(files.length).toBe(Object.keys(manifest.calls).length + 1);
    const env = JSON.parse(readFileSync(join(dir, "users_summary.json"), "utf8"));
    expect(env).toMatchObject({ tool: "users_summary", status: "ok", data: { n: 1 } });
    const onDisk = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    expect(onDisk.calls.users_summary.status).toBe("ok");
    expect(onDisk.calls.users_summary.args).toEqual({});
  });

  it("stops calling the Instagram-budget tools after one is rate limited", async () => {
    const dir = tempDir();
    const { caller, calls } = fakeCaller([...READ_TOOLS], (name) =>
      name === "reels_performance" ? { ...ok(name), status: "error", message: "(#4) Application request limit reached" } : ok(name));
    const manifest = await snapshot(caller, dir, { now });
    expect(calls).toContain("reels_performance");
    for (const t of ["account_reach", "facebook_reels", "youtube_stats", "connectors_status"]) {
      expect(calls, t).not.toContain(t);
      expect(manifest.skipped[t], t).toMatch(/rate limit/);
    }
    expect(calls).toContain("users_summary"); // the other sources carry on
    expect(manifest.calls.reels_performance!.status).toBe("error");
  });

  it("also stops when the rate limit comes back as a partial failure (status ok, error in warnings)", async () => {
    const dir = tempDir();
    const { caller, calls } = fakeCaller([...READ_TOOLS], (name) =>
      name === "reels_performance" ? ok(name, { reels: [{ id: "1", insightsError: "(#4) Application request limit reached" }] })
        : name === "account_reach" ? { ...ok(name), warnings: ["(#17) User request limit reached"] } : ok(name));
    const manifest = await snapshot(caller, dir, { now });
    expect(manifest.calls.reels_performance!.status).toBe("ok");
    for (const t of ["account_reach", "facebook_reels", "youtube_stats", "connectors_status"]) expect(calls, t).not.toContain(t);
  });

  it("stops when reels_performance answers ok with the Graph error only in its warnings", async () => {
    const dir = tempDir();
    const { caller, calls } = fakeCaller([...READ_TOOLS], (name) =>
      name === "reels_performance" ? { ...ok(name, { reels: [] }), warnings: ["insights: Graph error (#4) Application request limit reached"] } : ok(name));
    const manifest = await snapshot(caller, dir, { now });
    expect(manifest.calls.reels_performance!.status).toBe("ok");
    for (const t of ["account_reach", "facebook_reels", "youtube_stats", "connectors_status"]) {
      expect(calls, t).not.toContain(t);
      expect(manifest.skipped[t], t).toMatch(/rate limit hit by reels_performance/);
    }
  });

  it("stops at account_reach's ok-with-warnings answer, after reels_performance went through", async () => {
    const dir = tempDir();
    const { caller, calls } = fakeCaller([...READ_TOOLS], (name) =>
      name === "account_reach" ? { ...ok(name, { account: {} }), warnings: ["last7d: (#17) User request limit reached"] } : ok(name));
    const manifest = await snapshot(caller, dir, { now });
    expect(calls).toContain("reels_performance");
    expect(manifest.calls.account_reach!.status).toBe("ok");
    for (const t of ["facebook_reels", "youtube_stats", "connectors_status"]) {
      expect(calls, t).not.toContain(t);
      expect(manifest.skipped[t], t).toMatch(/rate limit hit by account_reach/);
    }
  });

  it("a warning that is not a rate limit does not stop the Instagram group", async () => {
    const dir = tempDir();
    const { caller, calls } = fakeCaller([...READ_TOOLS], (name) =>
      name === "reels_performance" ? { ...ok(name), warnings: ["follower history unavailable: table missing"] } : ok(name));
    await snapshot(caller, dir, { now });
    for (const t of ["account_reach", "facebook_reels", "youtube_stats", "connectors_status"]) expect(calls, t).toContain(t);
  });

  it("records a thrown call (a timeout) as an error and carries on", async () => {
    const dir = tempDir();
    const caller: OpsCaller = {
      listTools: async () => ["users_summary", "ai_features"],
      call: async (name) => { if (name === "ai_features") throw new Error("Request timed out"); return ok(name); },
    };
    const manifest = await snapshot(caller, dir, { now });
    expect(manifest.calls.ai_features).toMatchObject({ status: "error" });
    expect(manifest.calls.ai_features!.message).toMatch(/timed out/);
    expect(manifest.calls.users_summary!.status).toBe("ok");
    expect(JSON.parse(readFileSync(join(dir, "ai_features.json"), "utf8")).status).toBe("error");
  });

  it("writes the manifest even when listTools fails", async () => {
    const dir = tempDir();
    const calls: string[] = [];
    const caller: OpsCaller = {
      listTools: async () => { throw new Error("connection reset by peer"); },
      call: async (name) => { calls.push(name); return ok(name); },
    };
    await expect(snapshot(caller, dir, { now })).rejects.toThrow(/connection reset/);
    expect(calls).toEqual([]);
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    expect(m.error).toMatch(/listTools failed: connection reset/);
    expect(m.calls).toEqual({});
  });

  it("stops before the next call when aborted, and says so in the manifest", async () => {
    const dir = tempDir();
    const stop = new AbortController();
    const { caller, calls } = fakeCaller([...READ_TOOLS], (name) => { if (name === "new_users") stop.abort(); return ok(name); });
    const manifest = await snapshot(caller, dir, { now, signal: stop.signal });
    expect(calls).toEqual(["users_summary", "new_users"]);
    expect(manifest.aborted).toBe(true);
    expect(manifest.skipped.acquisition_sources).toBe("aborted");
    expect(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).aborted).toBe(true);
  });
});

describe("OpsClient over stdio (fake server, no SSH)", () => {
  const launch = (log: string) => ({
    command: process.execPath, args: ["--import", "tsx", FAKE_SERVER], env: { FAKE_OPS_CALL_LOG: log },
  });

  it("lists tools, calls a read-only allowed one, refuses the rest, times out slow calls, and closes", async () => {
    const dir = tempDir();
    const log = join(dir, "calls.log");
    const client = new OpsClient(launch(log), { callTimeoutMs: 800 });
    try {
      await client.connect();
      await expect(client.call("users_summary", {})).rejects.toThrow(/listTools\(\) has not run/);
      const tools = await client.listTools();
      expect(tools.sort()).toEqual(["ai_features", "brain_add_note", "marketplace", "new_users", "server_health", "users_summary"]);

      const env = await client.call("users_summary", {});
      expect(env).toMatchObject({ tool: "users_summary", status: "ok", data: { totals: { all: 17 } } });

      await expect(client.call("brain_add_note", { path: "x.md", note: "y" })).rejects.toBeInstanceOf(RefusedToolError);
      await expect(client.call("server_health", {})).rejects.toBeInstanceOf(RefusedToolError);
      // allow-listed, but the server does not say it is read-only (false, or no hint at all): refused
      await expect(client.call("marketplace", {})).rejects.toThrow(/does not mark it read-only/);
      await expect(client.call("new_users", {})).rejects.toThrow(/does not mark it read-only/);
      await expect(client.call("ai_features", {})).rejects.toThrow(/timed out/i);

      const manifest = await client.snapshot(join(dir, "snap"), { now: new Date("2026-10-15T03:00:00Z"), plan: [
        { call: "users_summary", tool: "users_summary", args: {}, file: "users_summary.json" },
        { call: "marketplace", tool: "marketplace", args: {}, file: "marketplace.json" },
      ] });
      expect(manifest.calls.users_summary!.status).toBe("ok");
      expect(manifest.skipped.marketplace).toMatch(/read-only/);
      expect(existsSync(join(dir, "snap", "users_summary.json"))).toBe(true);
      expect(existsSync(join(dir, "snap", "marketplace.json"))).toBe(false);
    } finally {
      await client.close();
    }
    const called = readFileSync(log, "utf8").trim().split("\n");
    for (const t of ["brain_add_note", "server_health", "marketplace", "new_users"]) expect(called, t).not.toContain(t);
    expect(called).toContain("users_summary");
  }, 30_000);
});
