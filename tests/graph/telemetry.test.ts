// FalkorDB's own telemetry{<graph>} streams (issue #29): found and removed on a real server (the test FalkorDB), nothing
// else is touched, a server that allows graph commands only is detected and left alone, and the schedule behaves.
import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { closeAll, connect } from "../../src/graph/client.js";
import { isTelemetryKey, redisKeys, refusesPlainKeys, startTelemetrySweep, sweepTelemetry, telemetrySweepOn, type KeyAccess } from "../../src/graph/telemetry.js";

const tag = randomBytes(4).toString("hex");

describe("which keys are FalkorDB's telemetry", () => {
  it("only telemetry{<name>}", () => {
    expect(isTelemetryKey("telemetry{allevia_aamdani}")).toBe(true);
    expect(isTelemetryKey("telemetry{allevia_test_6e6ea56ee5}")).toBe(true);
    for (const k of ["telemetry", "telemetry{}", "telemetry{a}{b}", "x:telemetry{a}", "telemetry{a}:x", "allevia:graph-writes:allevia_aamdani", "allevia_aamdani"]) {
      expect(isTelemetryKey(k)).toBe(false);
    }
  });

  it("the switch", () => {
    expect(telemetrySweepOn({})).toBe(true);
    for (const v of ["off", "0", "false", "NO"]) expect(telemetrySweepOn({ ALLEVIA_TELEMETRY_SWEEP: v })).toBe(false);
    expect(telemetrySweepOn({ ALLEVIA_TELEMETRY_SWEEP: "on" })).toBe(true);
  });

  it("a refusal is told from an outage", () => {
    expect(refusesPlainKeys(new Error("NOPERM User falkordb has no permissions to run the 'scan' command"))).toBe(true);
    expect(refusesPlainKeys(new Error("ERR unknown command 'SCAN'"))).toBe(true);
    expect(refusesPlainKeys(new Error("connect ECONNREFUSED 127.0.0.1:6391"))).toBe(false);
    expect(refusesPlainKeys(new Error("LOADING Redis is loading the dataset in memory"))).toBe(false);
  });
});

describe("on a real server (the test FalkorDB)", () => {
  const mine = [`telemetry{allevia_test_${tag}_a}`, `telemetry{allevia_test_${tag}_b}`];
  const notStream = `telemetry{allevia_test_${tag}_text}`;       // matches the name but is not a stream: kept
  const stamp = `allevia:graph-writes:allevia_test_${tag}`;         // our own key: kept
  const lookalike = `x:telemetry{allevia_test_${tag}}`;             // not named telemetry{...}: kept

  afterAll(async () => {
    const r = await (await connect()).connection;
    await r.unlink([...mine, notStream, stamp, lookalike]);
    await closeAll();
  });

  it("lists with --dry-run, removes the streams, and leaves everything else alone", async () => {
    const r = await (await connect()).connection;
    for (const k of mine) await r.xAdd(k, "*", { n: "1" });
    await r.set(notStream, "x");
    await r.set(stamp, "1");
    await r.set(lookalike, "1");
    const keys = await redisKeys();

    const dry = await sweepTelemetry(keys, { dryRun: true });
    expect(dry.refused).toBe(false);
    expect(dry.removed).toEqual(expect.arrayContaining(mine));
    expect(dry.removed).not.toContain(notStream);
    expect(await r.exists(mine)).toBe(2);              // a dry run removes nothing

    const done = await sweepTelemetry(keys);
    expect(done.removed).toEqual(expect.arrayContaining(mine));
    expect(await r.exists(mine)).toBe(0);
    expect(await r.exists([notStream, stamp, lookalike])).toBe(3);

    expect((await sweepTelemetry(keys)).removed).not.toEqual(expect.arrayContaining(mine)); // nothing of mine is left to remove
  });

  it("finds every page of a long keyspace (SCAN is paged)", async () => {
    const r = await (await connect()).connection;
    const many = Array.from({ length: 250 }, (_, i) => `telemetry{allevia_test_${tag}_p${i}}`);
    for (let i = 0; i < many.length; i += 50) await Promise.all(many.slice(i, i + 50).map((k) => r.xAdd(k, "*", { n: "1" })));
    const done = await sweepTelemetry(await redisKeys());
    expect(done.removed).toEqual(expect.arrayContaining(many));
    expect(await r.exists(many.slice(0, 100))).toBe(0);
  });
});

// A server that answers every plain command with NOPERM, as FalkorDB Cloud does for graph-only users.
const refusing = (): KeyAccess & { asked: number } => {
  const deny = async () => { throw new Error("NOPERM User falkordb has no permissions to run the 'scan' command"); };
  const k = { asked: 0, scan: async () => { k.asked++; return deny(); }, type: deny, unlink: deny };
  return k;
};

describe("a server that allows graph commands only", () => {
  it("is reported as refused, quietly: nothing thrown, nothing removed", async () => {
    expect(await sweepTelemetry(refusing())).toEqual({ removed: [], refused: true });
  });

  it("any other failure is still thrown (the server is down)", async () => {
    const down: KeyAccess = { scan: async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:6390"); }, type: async () => "", unlink: async () => 0 };
    await expect(sweepTelemetry(down)).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe("the schedule", () => {
  const memory = (names: string[]) => {
    const live = new Set(names);
    const keys: KeyAccess = {
      scan: async () => ({ cursor: "0", keys: [...live] }),
      type: async () => "stream",
      unlink: async (ks) => { for (const k of ks) live.delete(k); return ks.length; },
    };
    return { keys, live };
  };

  it("sweeps on its clock, says how many it removed, and does not say anything when there is nothing", async () => {
    vi.useFakeTimers();
    try {
      const { keys, live } = memory(["telemetry{allevia_a}", "telemetry{allevia_b}"]);
      const log: string[] = [];
      const stop = startTelemetrySweep({ keys: async () => keys, log: (l) => log.push(l) }, { everyMs: 1000, firstDelayMs: 100 });
      await vi.advanceTimersByTimeAsync(150);
      expect(live.size).toBe(0);
      expect(log).toEqual(["[graph] removed 2 FalkorDB telemetry streams"]);
      live.add("telemetry{allevia_c}");
      await vi.advanceTimersByTimeAsync(1000);
      expect(log.at(-1)).toBe("[graph] removed 1 FalkorDB telemetry stream");
      await vi.advanceTimersByTimeAsync(3000);
      expect(log).toHaveLength(2);                      // quiet while there is nothing to remove
      stop();
    } finally { vi.useRealTimers(); }
  });

  it("on a refusing server it asks once, says nothing, and stops asking", async () => {
    vi.useFakeTimers();
    try {
      const k = refusing();
      const log: string[] = [];
      startTelemetrySweep({ keys: async () => k, log: (l) => log.push(l) }, { everyMs: 1000, firstDelayMs: 100 });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(k.asked).toBe(1);
      expect(log).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it("a failure is logged and the next tick tries again", async () => {
    vi.useFakeTimers();
    try {
      let up = false;
      const { keys } = memory(["telemetry{allevia_a}"]);
      const flaky: KeyAccess = { ...keys, scan: async (...a) => { if (!up) throw new Error("connect ECONNREFUSED 127.0.0.1:6390"); return keys.scan(...a); } };
      const log: string[] = [];
      const stop = startTelemetrySweep({ keys: async () => flaky, log: (l) => log.push(l) }, { everyMs: 1000, firstDelayMs: 100 });
      await vi.advanceTimersByTimeAsync(150);
      expect(log).toEqual(["[graph] telemetry sweep: connect ECONNREFUSED 127.0.0.1:6390"]);
      up = true;
      await vi.advanceTimersByTimeAsync(1000);
      expect(log.at(-1)).toBe("[graph] removed 1 FalkorDB telemetry stream");
      stop();
    } finally { vi.useRealTimers(); }
  });
});
