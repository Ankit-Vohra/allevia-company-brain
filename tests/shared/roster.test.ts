import { describe, it, expect } from "vitest";
import { AGENTS, DEPARTMENTS, DEPARTMENT_COUNT, STAFF_COUNT, agentById, numberWord } from "../../shared/roster.js";

describe("roster", () => {
  it("has twelve staff in eight departments, every id and name unique, every desk in a known department", () => {
    expect(AGENTS).toHaveLength(12);
    expect(DEPARTMENTS).toHaveLength(8);
    expect(new Set(AGENTS.map((a) => a.id)).size).toBe(AGENTS.length);
    expect(new Set(AGENTS.map((a) => a.name)).size).toBe(AGENTS.length);
    const depts = new Set(DEPARTMENTS.map((d) => d.id));
    for (const a of AGENTS) expect(depts.has(a.department), a.id).toBe(true);
    for (const a of AGENTS) for (const r of a.reviews ?? []) expect(agentById(r), `${a.id} reviews ${r}`).toBeDefined();
  });

  it("the tech department is three people: the Tech Lead, the On-call Engineer and the QA & Release Manager", () => {
    expect(AGENTS.filter((a) => a.department === "tech").map((a) => [a.id, a.name])).toEqual([
      ["tech-lead", "Arjun"], ["oncall-engineer", "Zoya"], ["qa-release", "Imran"],
    ]);
    expect(agentById("qa-release")!.reviews).toEqual(["tech-lead"]);
    expect(agentById("oncall-engineer")!.handles).toContain("Sentry issues");
  });

  it("says its own size: counts and words come from the roster, so copy can't drift", () => {
    expect(STAFF_COUNT).toBe(AGENTS.length);
    expect(DEPARTMENT_COUNT).toBe(DEPARTMENTS.length);
    expect(numberWord(STAFF_COUNT)).toBe("twelve");
    expect(numberWord(DEPARTMENT_COUNT)).toBe("eight");
    expect(numberWord(10)).toBe("ten");
    expect(numberWord(37)).toBe("37");
  });
});
