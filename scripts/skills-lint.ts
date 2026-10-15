// Check skill packs while writing them:
//   npx tsx scripts/skills-lint.ts                      every skill under skills/
//   npx tsx scripts/skills-lint.ts content-strategist   only paths containing that text (any number of arguments)
// Prints each problem as "path: message" and exits 1 if there is any. It is the same check as tests/skills/packs.test.ts
// (parse, then lint: tools exist and belong to the agent, creating needs the owner's OK, no thin sections, plain words).
import { basename, dirname } from "node:path";
import { DEFAULT_SKILLS_DIR, loadSkillDir } from "../src/agent/skills/catalog.js";
import { lintSkill, type LintEnv } from "../src/agent/skills/format.js";
import { ALL_TOOLS } from "../src/agent/tools/index.js";
import { AGENTS } from "../shared/roster.js";

const env: LintEnv = { toolNames: new Set(ALL_TOOLS.map((t) => t.name)), agentTools: (id) => AGENTS.find((a) => a.id === id)?.tools };
const only = process.argv.slice(2);
const wanted = (path: string): boolean => !only.length || only.some((o) => path.includes(o));

const packs = loadSkillDir(DEFAULT_SKILLS_DIR);
const lines: string[] = [];
for (const p of packs.problems) if (wanted(p.path)) lines.push(`${p.path}: ${p.message}`);
for (const s of packs.skills) {
  if (!wanted(s.path!)) continue;
  for (const m of lintSkill(s, env, basename(dirname(dirname(s.path!))))) lines.push(`${s.path}: ${m}`);
}
const checked = packs.files.filter((f) => wanted(f.path)).length;
if (lines.length) {
  console.log(lines.join("\n"));
  console.log(`\n${lines.length} problem${lines.length === 1 ? "" : "s"} in ${checked} skill${checked === 1 ? "" : "s"}.`);
  process.exit(1);
}
console.log(`${checked} skill${checked === 1 ? "" : "s"} clean.`);
