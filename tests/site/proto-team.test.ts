// The website's "Meet your team" page is one section per team, not a long walk from person to person (the founder, 2026-10-17:
// "endless scrolling"). Each team: its name, one line on what it does, and its people by their role names.
import { describe, expect, it } from "vitest";
import { AGENTS, DEPARTMENTS } from "../../shared/roster.js";
import { TEAM_LINES, TEAM_SECTIONS } from "../../site/proto/shared/team-sections.js";

const html = TEAM_SECTIONS["team-story"]!("team");
const sections = [...html.matchAll(/<section class="dept[^"]*" data-team="([\w-]+)"[\s\S]*?<\/section>/g)];

describe("the team page", () => {
  it("has one section per team, in the page's order, each with its name, one line and its people", () => {
    expect(sections.map((m) => m[1])).toEqual(TEAM_LINES.map((t) => t.dept));
    expect(new Set(sections.map((m) => m[1]))).toEqual(new Set(DEPARTMENTS.map((d) => d.id)));
    for (const [block, dept] of sections) {
      const d = DEPARTMENTS.find((x) => x.id === dept)!;
      expect(block).toContain(`<h2 class="dept__name" id="team-${dept}">${d.name}</h2>`);
      expect((block.match(/class="dept__line"/g) ?? []).length).toBe(1);
      const names = [...block.matchAll(/<span class="member__name">([^<]+)<\/span>/g)].map((m) => m[1]);
      expect(names).toEqual(AGENTS.filter((a) => a.department === dept).map((a) => a.name));
    }
  });

  it("is short: no walk, no per-person cards, the dogs only by the closing button", () => {
    expect(html).not.toMatch(/data-sc-act|class="trail|class="card|class="hop/);
    expect((html.match(/class="member"/g) ?? []).length).toBe(AGENTS.length);
    expect((html.match(/class="dog dog--/g) ?? []).length).toBe(3);
    expect((html.match(/<h1[\s>]/g) ?? []).length).toBe(1);
  });
});
