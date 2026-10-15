// Holds every Cypher string in src/ to the two rules that keep FalkorDB 6.0.2 from crashing (src/graph/safety.ts,
// docs/notes/falkordb-nan-crash.md): the last key of every ORDER BY is unique, and nothing sorted can be NaN. Reads the
// source text, so it covers queries no test happens to run, and queries that only crash on a big or tied graph.
import { describe, it, expect } from "vitest";
import { nanRisks, unsafeSorts } from "../../src/graph/safety.js";
import { readSource, sourceFiles, stringLiterals } from "../helpers/ts-strings.js";

// Strings that mention ORDER BY but are not queries (prompts, error text). Keep this empty unless one really is not.
const NOT_CYPHER = new Set<string>([]);
// Prose that mentions ORDER BY and carries an example query: the cypher tool's description, which teaches the rule.
const NOT_CYPHER_TEXT = [/^Read-only Cypher, only when no other tool fits/];
const SKIP_FILES = new Set(["src/graph/safety.ts"]); // the analyzer's own messages and examples

interface Found { where: string; text: string }

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

  it("never sorts a value that can be NaN", () => {
    const bad = found.flatMap((f) => nanRisks(f.text).map((r) => `${f.where}  ${r}`));
    expect(bad).toEqual([]);
  });

  it("never skips the GraphHandle guard (the `unchecked` option is for crash experiments on a throwaway server)", () => {
    const users = sourceFiles("src").filter((f) => f !== "src/graph/client.ts" && /[{,(]\s*unchecked\s*:/.test(readSource(f)));
    expect(users).toEqual([]);
  });
});
