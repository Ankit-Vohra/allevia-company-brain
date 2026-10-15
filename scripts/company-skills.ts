// Write (or refresh) each business's own skills from its own graph: <company>-brand-voice, -domain, -reel and -ad.
// Onboarding does this for a new business; this backfills existing ones and refreshes them after big changes.
//   npx tsx scripts/company-skills.ts aamdani avs_atelier demo_seed [--print]
// --print also prints each skill's text. Unchanged skills write nothing; a skill the owner rewrote is never overwritten.
import { closeAll, openGraph } from "../src/graph/client.js";
import { loadBusinessSkills } from "../src/agent/skills/business.js";
import { writeCompanySkills } from "../src/agent/skills/company.js";

const args = process.argv.slice(2);
const print = args.includes("--print");
const tenants = args.filter((a) => !a.startsWith("--"));
if (!tenants.length) { console.error("usage: npx tsx scripts/company-skills.ts <tenant> [...] [--print]"); process.exit(2); }
try {
  for (const t of tenants) {
    const g = await openGraph(t);
    const r = await writeCompanySkills(g, { tenant: t });
    console.log(`${t}: written ${r.written.join(", ") || "none"}; unchanged ${r.unchanged.join(", ") || "none"}; owner's own kept ${r.kept.join(", ") || "none"}`);
    if (print) for (const s of (await loadBusinessSkills(g)).skills) console.log(`\n=== ${s.id} (${s.name}; ${s.agents.join(", ")})\n${s.body}`);
  }
} finally {
  await closeAll();
}
