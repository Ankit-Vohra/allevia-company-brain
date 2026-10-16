// The shipped skill packs (skills/<agent|shared>/<id>/SKILL.md) are checked as code: every one parses, passes the lint
// (tools exist and belong to the agent, creating needs the owner's OK, no empty sections, plain words for what the owner
// reads), ids are unique, and every person on the team has a real set. A broken skill is skipped at run time, so this
// test is the thing that keeps the packs honest.
import { describe, it, expect } from "vitest";
import { basename, dirname } from "node:path";
import { SkillCatalog, DEFAULT_SKILLS_DIR, loadSkillDir, readSkillFiles } from "../../src/agent/skills/catalog.js";
import { lintSkill, SHARED, type LintEnv } from "../../src/agent/skills/format.js";
import { ALL_TOOLS } from "../../src/agent/tools/index.js";
import { AGENTS } from "../../shared/roster.js";

const env: LintEnv = {
  toolNames: new Set(ALL_TOOLS.map((t) => t.name)),
  agentTools: (id) => AGENTS.find((a) => a.id === id)?.tools,
};

const packs = loadSkillDir(DEFAULT_SKILLS_DIR);
const catalog = new SkillCatalog(packs.skills);
const folderOf = (path: string): string => basename(dirname(dirname(path)));

describe("the shipped skill packs", () => {
  it("every SKILL.md parses and sits in a folder named for an agent or shared", () => {
    expect(packs.problems).toEqual([]);
    expect(packs.files.length).toBeGreaterThan(0);
    expect(packs.skills).toHaveLength(packs.files.length);
    const folders = new Set([SHARED, ...AGENTS.map((a) => a.id)]);
    for (const f of packs.files) expect(folders.has(f.folder), `${f.path}: skills/${f.folder} is not an agent id or shared`).toBe(true);
  });

  it("every skill passes the lint", () => {
    const bad = packs.skills.flatMap((s) => lintSkill(s, env, folderOf(s.path!)).map((m) => `${s.path}: ${m}`));
    expect(bad).toEqual([]);
  });

  it("ids are unique across all packs, and names are unique for each agent", () => {
    const ids = packs.skills.map((s) => s.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    for (const a of AGENTS) {
      const names = catalog.forAgent(a.id).map((s) => s.name.toLowerCase());
      expect(names.filter((n, i) => names.indexOf(n) !== i), a.id).toEqual([]);
    }
  });

  it("every person on the team has skills of their own: three to twenty-five", () => {
    for (const a of AGENTS) {
      const mine = catalog.forAgent(a.id);
      expect(mine.length, `${a.name} has ${mine.length} skills`).toBeGreaterThanOrEqual(3);
      expect(mine.length, `${a.name} has ${mine.length} skills`).toBeLessThanOrEqual(25); // only names and one line each sit in the prompt; the full text loads on use
    }
  });

  it("a shared skill belongs to people who all have its tools, and is listed for each of them", () => {
    for (const s of packs.skills.filter((x) => basename(dirname(dirname(x.path!))) === SHARED)) {
      for (const a of s.agents) expect(catalog.forAgent(a).map((x) => x.id), `${a} should list ${s.id}`).toContain(s.id);
    }
  });

  it("everyone who makes something owner-visible says what, and the ones that make nothing say so", () => {
    for (const s of packs.skills) {
      if (s.output === "creates") expect(s.makes, s.id).toBeTruthy();
      else expect(s.needsOk, s.id).toBe(false);
    }
  });

  it("each skill's folder id matches its file, and the file is the only thing in its folder that matters", () => {
    for (const f of readSkillFiles(DEFAULT_SKILLS_DIR)) expect(basename(dirname(f.path)), f.path).toBe(f.id);
  });
});
