// Counts the README states about the detectors and the team are derived from the code, so they can't drift.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { DETECTOR_NAMES } from "../../src/insights/detectors.js";
import { AGENTS, DEPARTMENTS } from "../../shared/roster.js";

const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");

describe("README counts", () => {
  it("any detector count it states is the real one", () => {
    const said = [...readme.matchAll(/\b(\d+) (?:deterministic (?:Cypher )?)?detectors|Run the (\d+) detectors/g)].map((m) => Number(m[1] ?? m[2]));
    for (const n of said) expect(n).toBe(DETECTOR_NAMES.length);
  });
  it("says how many agents and departments there are", () => {
    expect(readme).toMatch(/\b13 AI agents\b/);
    expect(readme).toMatch(/\bnine departments\b/);
    expect(AGENTS).toHaveLength(13);
    expect(DEPARTMENTS).toHaveLength(9);
  });
});
