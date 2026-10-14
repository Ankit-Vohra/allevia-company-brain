import { describe, it, expect } from "vitest";
import {
  SCHEMAS, checkHookOrder, compiles, loadGoogleAdsPolicy, loadGoogleUpdates, loadHooks, loadPatterns, type HooksData,
} from "../../src/ingest/sources/playbook-data.js";

const clone = <T>(x: T): T => structuredClone(x);

describe("vendored regexes are validated before they are compiled", () => {
  it("compiles() accepts plain flags and valid patterns only", () => {
    expect(compiles("\\bfoo\\b", "gi")).toBe(true);
    expect(compiles("(", "gi")).toBe(false);
    for (const flags of ["x", "gg", "d", "v", "ig!"]) expect(compiles("a", flags), flags).toBe(false);
  });

  it("rejects a pattern that does not compile, or has unusual flags, in patterns.json", () => {
    const ok = clone(loadPatterns().data);
    expect(SCHEMAS.patterns.safeParse(ok).success).toBe(true);
    for (const bad of [{ source: "(", flags: "gi" }, { source: "a", flags: "gx" }, { source: "a", flags: "d" }]) {
      const d = clone(ok);
      d.categories.chatbot!.patterns[0] = bad;
      expect(SCHEMAS.patterns.safeParse(d).success, JSON.stringify(bad)).toBe(false);
    }
    const t = clone(ok);
    t.tiers.tier1.phrases[0]!.pattern = { source: "[", flags: "i" };
    expect(SCHEMAS.patterns.safeParse(t).success).toBe(false);
  });

  it("rejects a hook whose match regex does not compile", () => {
    const d = clone(loadHooks().data);
    expect(SCHEMAS.hooks.safeParse(d).success).toBe(true);
    d.hooks[0]!.match = "(?<=";
    expect(SCHEMAS.hooks.safeParse(d).success).toBe(false);
  });

  it("marks the patterns the upstream engine only reports after extra logic as gated", () => {
    const { categories } = loadPatterns().data;
    const gated = (cat: string) => categories[cat]!.patterns.filter((p) => p.gated).length;
    expect(gated("title-case-header")).toBe(1);
    expect(gated("confidence-calibration")).toBe(7);
    expect(gated("negative-parallelism")).toBe(2);
    expect(categories["negative-parallelism"]!.patterns.some((p) => !p.gated)).toBe(true);
    expect(gated("chatbot")).toBe(0);
  });

  // Every vendored regex must stay cheap on hostile 20k-character input, whatever its source: the data is third-party.
  it("no vendored regex takes more than 50 ms on worst-case 20k-character input", () => {
    const hooks = loadHooks().data.hooks.map((h) => ({ label: `hook ${h.name}`, source: h.match, flags: "i" }));
    const p = loadPatterns().data;
    const patterns = [
      ...Object.entries(p.categories).flatMap(([c, d]) => d.patterns.map((x, i) => ({ label: `${c}[${i}]`, ...x }))),
      ...p.tiers.tier1.phrases.map((x, i) => ({ label: `tier1 phrase ${i}`, ...x.pattern })),
      ...p.tiers.tier2.conditional.map((x) => ({ label: `tier2 ${x.word}`, ...x.pattern })),
      ...p.tiers.tier3.phrases.map((x, i) => ({ label: `tier3 phrase ${i}`, ...x })),
    ];
    const all = [...hooks, ...patterns];
    expect(all.length).toBeGreaterThan(200);

    const N = 20_000;
    const fill = (unit: string) => unit.repeat(Math.ceil(N / unit.length)).slice(0, N);
    const generic = ["a", " ", "a ", "a, ", "a. ", "a\n", "a\n\n", "A b ", "— ", "a-"].map(fill);
    const timeOne = (re: RegExp, text: string): number => {
      const once = () => {
        const t0 = performance.now();
        let n = 0;
        for (const _m of text.matchAll(re)) n++;
        return n >= 0 ? performance.now() - t0 : 0;
      };
      const first = once();
      return first > 50 ? Math.min(first, once()) : first; // one retry so a GC pause is not a failure
    };

    const slow: string[] = [];
    let runs = 0;
    for (const r of all) {
      const re = new RegExp(r.source, r.flags.includes("g") ? r.flags : `${r.flags}g`);
      // the regex's own words, repeated with and without punctuation, so its trigger text is dense in the input
      const words = [...new Set(r.source.match(/[A-Za-z]{3,}/g) ?? [])];
      const dense = words.length ? [fill(`${words.join(" ")} `), fill(`${words.join(", ")}, `), fill(`${words.join(" ")}.\n`)] : [];
      for (const text of [...generic, ...dense]) {
        runs++;
        const ms = timeOne(re, text);
        if (ms > 50) slow.push(`${r.label} ${ms.toFixed(0)}ms on ${JSON.stringify(text.slice(0, 24))}`);
      }
    }
    expect(runs).toBeGreaterThan(2000);
    expect(slow).toEqual([]);
  }, 120_000);
});

describe("URLs from vendored data must be https", () => {
  it("rejects a Google update source that is not https", () => {
    const d = clone(loadGoogleUpdates().data);
    expect(SCHEMAS.googleUpdates.safeParse(d).success).toBe(true);
    for (const bad of ["http://developers.google.com/search", "javascript:alert(1)", "//example.com", ""]) {
      const x = clone(d);
      x.updates[0]!.source = bad;
      expect(SCHEMAS.googleUpdates.safeParse(x).success, bad).toBe(false);
    }
  });
  it("rejects a policy source_url that is not https, but allows none", () => {
    const d = clone(loadGoogleAdsPolicy().data);
    expect(SCHEMAS.policy.safeParse(d).success).toBe(true);
    d.entries[0]!.source_url = null;
    expect(SCHEMAS.policy.safeParse(d).success).toBe(true);
    d.entries[0]!.source_url = "http://support.google.com/x";
    expect(SCHEMAS.policy.safeParse(d).success).toBe(false);
  });
});

describe("checkHookOrder", () => {
  const real = loadHooks().data;
  const mk = (order: number[], ids = [1, 2, 3]): HooksData => ({
    classify_order: order,
    hooks: ids.map((id) => ({ ...real.hooks[0]!, id, name: `Hook ${id}` })),
  });

  it("is clean for the vendored file: classify_order names every hook exactly once", () => {
    expect(checkHookOrder(real)).toEqual({ unknownIds: [], missing: [], duplicateIds: [] });
  });
  it("reports unknown ids, hooks that are not in the order, and repeats", () => {
    expect(checkHookOrder(mk([2, 1, 99, 2]))).toEqual({ unknownIds: [99], missing: [{ id: 3, name: "Hook 3" }], duplicateIds: [2] });
  });
});
