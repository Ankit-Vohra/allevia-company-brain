// The skills a turn can use: the code packs (skills/<agent|shared>/<id>/SKILL.md, shipped with Allevia) with one business's
// own skills and skill rules laid over them (src/agent/skills/business.ts reads those from that business's own graph).
// - loadSkillDir reads and checks a pack directory; it never throws (a broken skill is reported and left out, so a typo in
//   one SKILL.md cannot stop the team from answering). The lint test (tests/skills/packs.test.ts) is what keeps packs clean.
// - SkillCatalog answers "which skills does this agent have" and "give me skill X for this agent". A business skill with
//   the id of a code skill replaces it for that business (its name and `when` fall back to the code skill's); one with a new
//   id is added. A business never sees another business's skills, because the catalog is built per turn from one graph.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSkill, SHARED, type Skill } from "./format.js";

/** A rule the owner or the team attached to one skill ("our posts always end with a question"). */
export interface SkillRule {
  id: string;            // memory:…
  skillId: string;
  agents: string[];      // roster ids it applies to
  text: string;
  channel?: { id: string; name: string };
}

export interface BusinessSkills { skills: Skill[]; rules: SkillRule[] }

export class SkillCatalog {
  constructor(readonly skills: readonly Skill[] = [], readonly rules: readonly SkillRule[] = []) {}

  /** The skills an agent has, in the order they were written: code first, then the business's own additions. */
  forAgent(agentId: string): Skill[] {
    const byId = new Map<string, Skill>();
    for (const s of this.skills) if (s.agents.includes(agentId)) byId.set(s.id, s);
    return [...byId.values()];
  }

  get(agentId: string, id: string): Skill | undefined {
    return this.forAgent(agentId).find((s) => s.id === id);
  }

  has(agentId: string): boolean { return this.forAgent(agentId).length > 0; }

  rulesFor(agentId: string, skillId: string): SkillRule[] {
    const base = this.get(agentId, skillId)?.base;
    return this.rules.filter((r) => (r.skillId === skillId || r.skillId === "*" || (!!base && r.skillId === base)) && r.agents.includes(agentId));
  }

  /** This catalog with one business's skills and rules laid over it. */
  withBusiness(b: BusinessSkills): SkillCatalog {
    const code = new Map(this.skills.map((s) => [s.id, s] as const));
    // An override keeps what the code skill says about itself unless the business says otherwise.
    const mine = b.skills.map((s): Skill => {
      const base = code.get(s.id);
      return base ? { ...base, name: s.name || base.name, when: s.when || base.when, agents: s.agents, body: s.body, sections: s.sections, source: "business" } : s;
    });
    const out: Skill[] = [];
    for (const s of this.skills) {
      const o = mine.find((m) => m.id === s.id);
      if (!o) { out.push(s); continue; }
      // An override replaces the code skill for the agents it names; the others keep the code skill.
      const left = s.agents.filter((a) => !o.agents.includes(a));
      if (left.length) out.push({ ...s, agents: left });
    }
    return new SkillCatalog([...out, ...mine], [...this.rules, ...b.rules]);
  }
}

// ---------- reading a pack directory ----------

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SKILLS_DIR = join(HERE, "..", "..", "..", "skills");

export interface SkillFile { folder: string; id: string; path: string; text: string }
export interface LoadedPacks { skills: Skill[]; problems: Array<{ path: string; message: string }>; files: SkillFile[] }

// Every skills/<folder>/<id>/SKILL.md under `dir`, in a stable order (folder, then id).
export function readSkillFiles(dir: string): SkillFile[] {
  if (!existsSync(dir)) return [];
  const dirs = (p: string): string[] => readdirSync(p).filter((n) => !n.startsWith(".") && statSync(join(p, n)).isDirectory()).sort();
  const out: SkillFile[] = [];
  for (const folder of dirs(dir)) {
    for (const id of dirs(join(dir, folder))) {
      const path = join(dir, folder, id, "SKILL.md");
      if (existsSync(path)) out.push({ folder, id, path, text: readFileSync(path, "utf8") });
    }
  }
  return out;
}

export function loadSkillDir(dir: string = process.env.ALLEVIA_SKILLS_DIR || DEFAULT_SKILLS_DIR): LoadedPacks {
  const files = readSkillFiles(dir);
  const skills: Skill[] = [];
  const problems: LoadedPacks["problems"] = [];
  const seen = new Map<string, string>();
  for (const f of files) {
    const parsed = parseSkill(f.text, { folder: f.folder, source: "code", path: f.path });
    for (const message of parsed.problems) problems.push({ path: f.path, message });
    const s = parsed.skill;
    if (!s) continue;
    if (s.id !== f.id) { problems.push({ path: f.path, message: `id "${s.id}" must match its folder name "${f.id}"` }); continue; }
    if (seen.has(s.id)) { problems.push({ path: f.path, message: `id "${s.id}" is already used by ${seen.get(s.id)}` }); continue; }
    seen.set(s.id, f.path);
    skills.push(s);
  }
  return { skills, problems, files };
}

let cached: SkillCatalog | undefined;
let reported = false;

/** The shipped packs as a catalog (read once per process). Problems are reported once on stderr, never thrown. */
export function codeCatalog(dir?: string): SkillCatalog {
  if (dir) return new SkillCatalog(loadSkillDir(dir).skills);
  if (!cached) {
    const { skills, problems } = loadSkillDir();
    if (problems.length && !reported) {
      reported = true;
      for (const p of problems.slice(0, 5)) console.error(`[skills] ${p.path}: ${p.message}`);
    }
    cached = new SkillCatalog(skills);
  }
  return cached;
}

/** The owner's switch for the quality trials: ALLEVIA_SKILLS=off runs the team without skills. */
export const skillsEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(?:off|0|false|no)$/i.test(env.ALLEVIA_SKILLS ?? "");

export { SHARED };
