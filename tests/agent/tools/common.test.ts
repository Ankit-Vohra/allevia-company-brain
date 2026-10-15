import { describe, it, expect } from "vitest";
import type { GraphHandle } from "../../../src/graph/client.js";
import { MissingEndpoint } from "../../../src/graph/errors.js";
import {
  InputError, READ_TIMEOUT_MS, TOOL_ALGO_TIMEOUT_MS, SOURCE_CAP, clip, compactProps, defineTool, median, parseAsOf, ro, serial,
  sourcesFor,
} from "../../../src/agent/tools/common.js";
import { makeCtx } from "../../helpers/tools.js";

describe("tool plumbing", () => {
  it("parseAsOf: a bare date means the end of that day; junk is an input error", () => {
    expect(parseAsOf(undefined)).toBeUndefined();
    expect(parseAsOf("2026-10-01")).toBe(Date.parse("2026-10-01T23:59:59.999Z"));
    expect(parseAsOf("2026-10-01T05:00:00Z")).toBe(Date.parse("2026-10-01T05:00:00Z"));
    expect(() => parseAsOf("last tuesday")).toThrow(InputError);
  });

  it("reads stay under the read cap, and algorithms get no more", () => {
    expect(READ_TIMEOUT_MS).toBeLessThanOrEqual(8000);
    expect(TOOL_ALGO_TIMEOUT_MS).toBeLessThanOrEqual(READ_TIMEOUT_MS);
  });

  it("ro waits and retries while the server's query queue is full, and only then", async () => {
    let calls = 0;
    const busy = (times: number, err = "Max pending queries exceeded") => ({
      name: "fake", async roQuery() { if (++calls <= times) throw new Error(err); return [{ ok: 1 }]; },
    }) as unknown as GraphHandle;
    expect(await ro(makeCtx(busy(2)), "RETURN 1")).toEqual([{ ok: 1 }]);
    expect(calls).toBe(3);
    calls = 0;
    await expect(ro(makeCtx(busy(99)), "RETURN 1")).rejects.toThrow(/Max pending/);
    expect(calls).toBe(5);
    calls = 0;
    await expect(ro(makeCtx(busy(1, "Query timed out")), "RETURN 1")).rejects.toThrow(/timed out/);
    expect(calls).toBe(1);
  });

  it("sources cover every id first (one each), then fill up to the cap", async () => {
    // 30 nodes, each with its own document plus a shared one listed first for the first node.
    const rows = [{ of: "n0", id: "d:shared", title: "Shared", asOf: null }, ...Array.from({ length: 30 }, (_, i) => ({ of: `n${i}`, id: `d:${i}`, title: `Doc ${i}`, asOf: null }))];
    const g = { name: "fake", async roQuery() { return rows; } } as unknown as GraphHandle;
    const got = (await sourcesFor(makeCtx(g), Array.from({ length: 30 }, (_, i) => `n${i}`))).map((s) => s.id);
    expect(got.length).toBeGreaterThan(SOURCE_CAP);
    for (let i = 1; i < 30; i++) expect(got).toContain(`d:${i}`);
    expect(got).toContain("d:shared");
    expect(TOOL_ALGO_TIMEOUT_MS).toBeLessThanOrEqual(READ_TIMEOUT_MS);
  });

  it("defineTool turns input errors, missing endpoints and timeouts into results; other errors throw", async () => {
    const mk = (err: Error) => defineTool({ name: "t", description: "d", input: {}, run: async () => { throw err; } });
    const ctx = makeCtx({} as GraphHandle);
    expect((await mk(new InputError("bad id", { suggestions: ["a"] })).run({}, ctx)).data).toEqual({ error: "bad id", suggestions: ["a"] });
    expect((await mk(new MissingEndpoint(["x:1"])).run({}, ctx)).data).toMatchObject({ missing: ["x:1"] });
    expect((await mk(new Error("Query timed out")).run({}, ctx)).note).toMatch(/took too long/);
    await expect(mk(new Error("connection lost")).run({}, ctx)).rejects.toThrow("connection lost");
  });

  it("serial runs one job at a time per key, even after a failure", async () => {
    const order: string[] = [];
    const job = (name: string, ms: number, fail = false) => serial("k", async () => {
      order.push(`${name}+`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${name}-`);
      if (fail) throw new Error(name);
      return name;
    });
    const results = await Promise.allSettled([job("a", 20, true), job("b", 1), job("c", 5)]);
    expect(order).toEqual(["a+", "a-", "b+", "b-", "c+", "c-"]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "fulfilled", "fulfilled"]);
  });

  it("compactProps drops vectors, turns epochs into ISO and clips long text", () => {
    const out = compactProps([["embedding", [1, 2]], ["rev", 3], ["_mergeToken", "x"], ["createdAt", 0], ["text", "x".repeat(500)], ["tags", Array.from({ length: 25 }, (_, i) => `t${i}`)], ["n", null]]);
    expect(out).toEqual({ createdAt: "1970-01-01T00:00:00.000Z", text: `${"x".repeat(399)}…`, tags: [...Array.from({ length: 20 }, (_, i) => `t${i}`), "…5 more"] });
    expect(clip("short")).toBe("short");
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});
