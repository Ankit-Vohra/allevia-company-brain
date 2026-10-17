// `db:usage` (src/graph/usage.ts, src/cli/db-usage.ts): how full the database is. FalkorDB Cloud's free plan is 100 MB and refuses writes
// when full, so the command prints the memory used against the limit and each graph's share, and warns from 80 percent (exit 3).
// The numbers are parsed from INFO memory and GRAPH.MEMORY USAGE; the integration part reads the test database (read-only).
import { afterAll, describe, expect, it, vi } from "vitest";
import { loadCommands } from "../../src/cli.js";
import { closeAll, connect, openGraphByName } from "../../src/graph/client.js";
import { loadConfig } from "../../src/config.js";
import { assess, memoryInfo, parseGraphMemory, parseInfo, readGraphUsage, readMemory, type MemoryInfo } from "../../src/graph/usage.js";
import { testGraphName } from "../helpers/graph.js";

const INFO = [
  "# Memory", "used_memory:67108864", "used_memory_human:64.00M", "used_memory_peak:104333312", "maxmemory:104857600", "maxmemory_human:100.00M", "maxmemory_policy:noeviction", "",
].join("\r\n");

const info = (usedMb: number, maxMb: number | null = null): MemoryInfo => ({ usedMb, peakMb: null, maxMb, policy: null });

describe("reading INFO memory", () => {
  it("takes the used memory, the peak, the server's own limit and its policy, in MB", () => {
    expect(parseInfo(INFO).maxmemory).toBe("104857600");
    expect(memoryInfo(INFO)).toEqual({ usedMb: 64, peakMb: 104333312 / 1048576, maxMb: 100, policy: "noeviction" });
  });

  it("reads a server with no limit (maxmemory 0) as having none, and refuses a reply with no used_memory", () => {
    expect(memoryInfo("used_memory:1048576\r\nmaxmemory:0\r\n")).toMatchObject({ usedMb: 1, maxMb: null, peakMb: null, policy: null });
    expect(() => memoryInfo("# Memory\r\n")).toThrow(/no used_memory/);
  });

  it("reads GRAPH.MEMORY USAGE's flat key and value reply", () => {
    expect(parseGraphMemory(["total_graph_sz_mb", 13, "label_matrices_sz_mb", 4, "node_block_storage_sz_mb", "2"])).toEqual({ total_graph_sz_mb: 13, label_matrices_sz_mb: 4, node_block_storage_sz_mb: 2 });
    expect(parseGraphMemory("nope")).toEqual({});
  });
});

describe("how full it is", () => {
  it("is fine below 80 percent, a warning from 80, critical from 95, against the server's own limit", () => {
    expect(assess(info(79.9, 100))).toMatchObject({ level: "ok", limitMb: 100, limitFrom: "server" });
    expect(assess(info(80, 100))).toMatchObject({ level: "warning" });
    expect(assess(info(94.9, 100)).level).toBe("warning");
    expect(assess(info(95, 100))).toMatchObject({ level: "critical" });
    expect(assess(info(100, 100))).toMatchObject({ level: "critical", percent: 100, roomMb: 0 });
    expect(assess(info(120, 100)).roomMb).toBe(0);
    expect(assess(info(64, 100))).toMatchObject({ percent: 64, roomMb: 36 });
  });

  it("takes the limit from --limit-mb first, then the server, then ALLEVIA_DB_LIMIT_MB; with none it says it cannot tell", () => {
    expect(assess(info(50, 100), { flagMb: 60, envMb: 70 })).toMatchObject({ limitMb: 60, limitFrom: "flag", level: "warning" });
    expect(assess(info(50, 100), { envMb: 70 })).toMatchObject({ limitMb: 100, limitFrom: "server" });
    expect(assess(info(50), { envMb: 100 })).toMatchObject({ limitMb: 100, limitFrom: "env", level: "ok" });
    expect(assess(info(50))).toEqual({ limitMb: null, limitFrom: null, percent: null, level: "unknown", roomMb: null });
    expect(() => assess(info(50), { flagMb: 0 })).toThrow(/above 0/);
  });

  it("reads ALLEVIA_DB_LIMIT_MB from the settings, and ignores a value that is not a number above 0", () => {
    const env = { ALLEVIA_ENV_FILE: "/nonexistent/allevia.env" };
    expect(loadConfig({ ...env, ALLEVIA_DB_LIMIT_MB: "100" }).dbLimitMb).toBe(100);
    expect(loadConfig({ ...env, ALLEVIA_DB_LIMIT_MB: "abc" }).dbLimitMb).toBeUndefined();
    expect(loadConfig({ ...env, ALLEVIA_DB_LIMIT_MB: "0" }).dbLimitMb).toBeUndefined();
    expect(loadConfig(env).dbLimitMb).toBeUndefined();
  });
});

describe("on a real server (the test database)", () => {
  const name = testGraphName();
  afterAll(async () => { await (await openGraphByName(name)).drop(); await closeAll(); });

  it("reads the used memory, and every graph's own share with the cached projections marked", async () => {
    const g = await openGraphByName(name);
    await g.query("CREATE (:Entity {id:'usage:a'})-[:KNOWS]->(:Entity {id:'usage:b'})");
    const db = await connect();
    const m = await readMemory(db);
    expect(m.usedMb).toBeGreaterThan(0);
    const rows = await readGraphUsage(db);
    const mine = rows.find((r) => r.graph === name);
    expect(mine).toMatchObject({ graph: name, projection: false });
    expect(mine!.mb === null || mine!.mb >= 0).toBe(true);
    expect(rows.every((r) => r.projection === r.graph.includes("__"))).toBe(true);
    const sizes = rows.map((r) => r.mb ?? -1);
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a)); // biggest first
  });

  async function run(...args: string[]): Promise<{ code: number; out: string; err: string }> {
    const cmd = (await loadCommands()).find((c) => c.name === "db:usage")!;
    let out = "", err = "";
    const log = vi.spyOn(console, "log").mockImplementation((...a) => { out += `${a.join(" ")}\n`; });
    const error = vi.spyOn(console, "error").mockImplementation((...a) => { err += `${a.join(" ")}\n`; });
    try { return { code: (await cmd.run(args)) ?? 0, out, err }; } finally { log.mockRestore(); error.mockRestore(); }
  }

  it("prints the memory used against the limit and the graphs, exit 0 when there is room", async () => {
    const r = await run("--limit-mb", "100000");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/redis:\/\/127\.0\.0\.1:6391: [\d.]+ MB used of 100000 MB \(\d+%\), .* free \(limit from --limit-mb\)/);
    expect(r.out).toMatch(/graphs: \d+, using/);
    expect(r.out).toContain(name);
    expect(r.err).toBe("");
  });

  it("warns, to the error stream and with exit 3, when it is nearly full; and says what to do", async () => {
    const r = await run("--limit-mb", "0.01");
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/^CRITICAL: the database is \d+% full/);
    expect(r.err).toMatch(/a full plan refuses every write/);
    expect(r.err).toMatch(/erase a business that is not needed \(tenant:erase\)/);
    expect(r.err).toMatch(new RegExp(`test graphs? \\(allevia_test_…\\) (is|are) using`)); // this run's own throwaway graph is one
  });

  it("says it cannot tell how full it is when no limit is known, rather than guessing", async () => {
    const r = await run();
    if (loadConfig().dbLimitMb !== undefined) return; // a machine that sets the limit for every command
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/the server reports no limit \(set ALLEVIA_DB_LIMIT_MB, or pass --limit-mb/);
  });

  it("refuses a limit that is not a number, and lists every graph with --all", async () => {
    expect((await run("--limit-mb", "lots")).code).toBe(2);
    expect((await run("--limit-mb", "-5")).code).toBe(2);
    const all = await run("--limit-mb", "100000", "--all");
    expect(all.out).not.toMatch(/and \d+ more/);
  });
});
