// Counts the README states about the detectors and the team are derived from the code, so they can't drift.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { DETECTOR_NAMES } from "../../src/insights/detectors.js";
import { AGENTS, DEPARTMENTS } from "../../shared/roster.js";

const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");

describe("README counts", () => {
  it("says how many detectors there are", () => {
    const said = [...readme.matchAll(/\b(\d+) deterministic Cypher detectors|Run the (\d+) detectors/g)].map((m) => Number(m[1] ?? m[2]));
    expect(said.length).toBeGreaterThanOrEqual(2);
    for (const n of said) expect(n).toBe(DETECTOR_NAMES.length);
  });
  it("says how many staff and departments there are", () => {
    expect(readme).toMatch(/Twelve AI staff in eight departments/);
    expect(AGENTS).toHaveLength(12);
    expect(DEPARTMENTS).toHaveLength(8);
  });
});
