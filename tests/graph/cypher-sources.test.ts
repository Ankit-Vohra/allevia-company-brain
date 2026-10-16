// Holds every Cypher string in src/ to the two rules that keep FalkorDB 6.0.2 from crashing (src/graph/safety.ts,
// docs/notes/falkordb-nan-crash.md): the last key of every ORDER BY is unique, and nothing sorted can be NaN. Reads the
// source text, so it covers queries no test happens to run, and queries that only crash on a big or tied graph.
import { describe, it, expect } from "vitest";
import { blankLiterals, nanRisks, nullableGroupKeys, unsafeSorts } from "../../src/graph/safety.js";
import { readSource, sourceFiles, stringLiterals } from "../helpers/ts-strings.js";
import { entityCreateWithoutId, idAnchorsWithoutEntity, unguardedEdgeAggregates } from "../helpers/cypher-lint.js";

// Strings that mention ORDER BY but are not queries (prompts, error text). Keep this empty unless one really is not.
const NOT_CYPHER = new Set<string>([]);
// Prose that mentions ORDER BY and carries an example query: the cypher tool's description, which teaches the rule.
const NOT_CYPHER_TEXT = [/^Read-only Cypher, only when no other tool fits/];
const SKIP_FILES = new Set(["src/graph/safety.ts"]); // the analyzer's own messages and examples

interface Found { where: string; text: string }

// Files another branch is rewriting at the same time (the agent, the ingest pipeline and the librarian). Their id anchors
// and edge aggregates are brought in line by the follow-up that lands with those branches; until then they are only held
// to the count below, which can fall but not rise. Delete DEFERRED (and the ratchets) once they are clean.
const DEFERRED: RegExp[] = [];
const DEFERRED_ANCHORS_MAX = 0;
const DEFERRED_EDGE_AGGREGATES_MAX = 0;

// Every query-looking literal, not only the ones that sort.
function allCypher(): Found[] {
  const out: Found[] = [];
  for (const file of sourceFiles("src")) {
    if (SKIP_FILES.has(file)) continue;
    for (const lit of stringLiterals(readSource(file))) {
      if (!/(?<![\w.])(MATCH|MERGE)\b/.test(lit.text) || !/\b(RETURN|SET|DELETE|CREATE|WITH|YIELD)\b/.test(lit.text)) continue;
      if (NOT_CYPHER_TEXT.some((re) => re.test(lit.text))) continue;
      out.push({ where: `${file}:${lit.line}`, text: lit.text });
    }
  }
  return out;
}
const deferred = (f: Found): boolean => DEFERRED.some((re) => re.test(f.where));

function cypherWithSort(): Found[] {
  const out: Found[] = [];
  for (const file of sourceFiles("src")) {
    if (SKIP_FILES.has(file)) continue;
    for (const lit of stringLiterals(readSource(file))) {
      if (!/\bORDER\s+BY\b/i.test(lit.text) || !/(?<![\w.])(MATCH|RETURN|UNWIND|CALL|WITH)\b/.test(lit.text)) continue;
      const where = `${file}:${lit.line}`;
      if (!NOT_CYPHER.has(where) && !NOT_CYPHER_TEXT.some((re) => re.test(lit.text))) out.push({ where, text: lit.text });
    }
  }
  return out;
}

describe("every Cypher string in src/", () => {
  const found = cypherWithSort();

  it("was found (the scan is not silently empty)", () => {
    expect(found.length).toBeGreaterThan(80);
  });

  it("ends every ORDER BY in a unique key, so rows never tie", () => {
    const bad = found.flatMap((f) => unsafeSorts(f.text).map((s) => `${f.where}  ${s}`));
    expect(bad).toEqual([]);
  });

  it("never returns an aggregate beside a key that can be null (FalkorDB 6.0.2 panics in reply_compact)", () => {
    const bad = allCypher().flatMap((f) => nullableGroupKeys(f.text).map((r) => `${f.where}  ${r}`));
    expect(bad).toEqual([]);
  });

  it("creates every Entity node with its id in the CREATE pattern (FalkorDB Cloud checks the constraint before any SET)", () => {
    const bad = allCypher().flatMap((f) => entityCreateWithoutId(f.text).map((r) => `${f.where}  ${r}`));
    expect(bad).toEqual([]);
  });

  it("never sorts a value that can be NaN", () => {
    const bad = found.flatMap((f) => nanRisks(f.text).map((r) => `${f.where}  ${r}`));
    expect(bad).toEqual([]);
  });

  it("does no float math in Cypher: a ratio is computed in TypeScript, where a zero denominator is a null", () => {
    // Division by zero is NaN in Cypher (0.0/0.0) and Infinity (x/0.0); sqrt(-1) and log(-1) are NaN. None of the
    // 265 queries needs one, so none has one, and the database cannot produce a NaN that something later sorts.
    const FLOAT_MATH = /\/|\^|(?<![\w.$`])(?:sqrt|log|log10|acos|asin|pow)\s*\(/i;
    const bad: string[] = [];
    for (const file of sourceFiles("src")) {
      if (SKIP_FILES.has(file)) continue;
      for (const lit of stringLiterals(readSource(file))) {
        if (!/(?<![\w.])(MATCH|RETURN|UNWIND|CALL|MERGE|CREATE)\b/.test(lit.text) || !/\b(RETURN|SET|DELETE|YIELD|WITH)\b/.test(lit.text)) continue;
        if (NOT_CYPHER_TEXT.some((re) => re.test(lit.text))) continue;
        if (FLOAT_MATH.test(blankLiterals(lit.text))) bad.push(`${file}:${lit.line}  ${lit.text.replace(/\s+/g, " ").slice(0, 100)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  describe("index and parallel-edge rules (tests/helpers/cypher-lint.ts)", () => {
    const all = allCypher();

    it("was found (the scan is not silently empty)", () => {
      expect(all.length).toBeGreaterThan(250);
    });

    it("looks every node up by id with the Entity label, so the Entity.id index is used and not a label scan", () => {
      const bad = all.filter((f) => !deferred(f)).flatMap((f) => idAnchorsWithoutEntity(f.text).map((b) => `${f.where}  ${b}`));
      expect(bad).toEqual([]);
    });

    it("binds and uses the edge under every count, sum and collect, so parallel edges are not collapsed (FalkorDB 6.0.2)", () => {
      const bad = all.filter((f) => !deferred(f)).flatMap((f) => unguardedEdgeAggregates(f.text).map((b) => `${f.where}  ${b}`));
      expect(bad).toEqual([]);
    });

    it("keeps the deferred files from getting worse", () => {
      const d = all.filter(deferred);
      expect(d.filter((f) => idAnchorsWithoutEntity(f.text).length).length).toBeLessThanOrEqual(DEFERRED_ANCHORS_MAX);
      expect(d.filter((f) => unguardedEdgeAggregates(f.text).length).length).toBeLessThanOrEqual(DEFERRED_EDGE_AGGREGATES_MAX);
    });
  });

  it("never skips the GraphHandle guard (the `unchecked` option is for crash experiments on a throwaway server)", () => {
    const users = sourceFiles("src").filter((f) => f !== "src/graph/client.ts" && /[{,(]\s*unchecked\s*:/.test(readSource(f)));
    expect(users).toEqual([]);
  });
});
