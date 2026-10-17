import { describe, it, expect } from "vitest";
import { AGENTS, DEPARTMENTS, DEPARTMENT_COUNT, STAFF_COUNT, agentById, numberWord, plainWho } from "../../shared/roster.js";

describe("roster", () => {
  it("has thirteen staff in nine departments, every id and name unique, every desk in a known department", () => {
    expect(AGENTS).toHaveLength(13);
    expect(DEPARTMENTS).toHaveLength(9);
    expect(new Set(AGENTS.map((a) => a.id)).size).toBe(AGENTS.length);
    expect(new Set(AGENTS.map((a) => a.name)).size).toBe(AGENTS.length);
    const depts = new Set(DEPARTMENTS.map((d) => d.id));
    for (const a of AGENTS) expect(depts.has(a.department), a.id).toBe(true);
    for (const a of AGENTS) for (const r of a.reviews ?? []) expect(agentById(r), `${a.id} reviews ${r}`).toBeDefined();
  });

  it("the tech department is three people: the Tech Lead, the On-call Engineer and the QA & Release Manager", () => {
    expect(AGENTS.filter((a) => a.department === "tech").map((a) => [a.id, a.name])).toEqual([
      ["tech-lead", "Techie"], ["oncall-engineer", "Firefighter"], ["qa-release", "Bug Hunter"],
    ]);
    expect(agentById("qa-release")!.reviews).toEqual(["tech-lead"]);
    expect(agentById("oncall-engineer")!.handles).toContain("Sentry error alerts");
  });

  it("the sales department is one person: Deal Closer, the Sales Lead", () => {
    const sales = AGENTS.filter((a) => a.department === "sales");
    expect(sales.map((a) => [a.id, a.name, a.title])).toEqual([["sales-lead", "Deal Closer", "Sales Lead"]]);
    expect(DEPARTMENTS.find((d) => d.id === "sales")!.hue).toBe(120);
    expect(new Set(DEPARTMENTS.map((d) => d.hue)).size).toBe(DEPARTMENTS.length);
    expect(plainWho("sales-lead")).toBe("Deal Closer · Sales");
  });

  it("says its own size: counts and words come from the roster, so copy can't drift", () => {
    expect(STAFF_COUNT).toBe(AGENTS.length);
    expect(DEPARTMENT_COUNT).toBe(DEPARTMENTS.length);
    expect(numberWord(STAFF_COUNT)).toBe("thirteen");
    expect(numberWord(DEPARTMENT_COUNT)).toBe("nine");
    expect(numberWord(10)).toBe("ten");
    expect(numberWord(37)).toBe("37");
  });
});
