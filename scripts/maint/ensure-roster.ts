// Make sure a tenant graph has every roster Agent and department Team: npx tsx scripts/maint/ensure-roster.ts <tenant>...
//   e.g. npx tsx scripts/maint/ensure-roster.ts aamdani avs_atelier demo_seed
// Run after a desk is added to shared/roster.ts. Idempotent (upserts of identical content change nothing), and it only
// adds Agent/Team nodes and their MEMBER_OF / PART_OF edges. Prints how many Agent nodes each graph has.
import { closeAll, graphName, listGraphs, openGraph } from "../../src/graph/client.js";
import { AGENTS } from "../../shared/roster.js";
import { findBusinessId } from "../../src/actions/shared.js";
import { ensureRoster } from "../../src/agent/memory.js";

const tenants = process.argv.slice(2);
if (!tenants.length) {
  console.error("usage: npx tsx scripts/maint/ensure-roster.ts <tenant>...");
  process.exit(2);
}

let code = 0;
try {
  const have = new Set(await listGraphs());
  for (const tenant of tenants) {
    if (!have.has(graphName(tenant))) { console.error(`ensure-roster: no graph ${graphName(tenant)}`); code = 2; continue; }
    const g = await openGraph(tenant);
    const biz = await findBusinessId(g, tenant);
    await ensureRoster(g, biz ? { businessId: biz } : {});
    const rows = await g.roQuery<{ c: number }>("MATCH (a:Agent {allevia:true}) RETURN count(a) AS c");
    console.log(`ensure-roster ${tenant}: ${rows[0]?.c ?? 0} Agent node(s), roster has ${AGENTS.length}`);
  }
} finally {
  await closeAll();
}
process.exit(code);
