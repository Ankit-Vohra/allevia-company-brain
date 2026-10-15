// Rewrite a tenant graph's strings through redact(), in place: npm exec tsx scripts/maint/redact-tenant.ts <tenant> [--dry-run]
//   e.g. npx tsx scripts/maint/redact-tenant.ts avs_atelier
// Graph writes never delete, so text stored before a source learned to redact (a crawled contact page, an old Version's
// JSON) stays until this runs. It leaves digests, content-addressed keys and ids alone (src/ingest/scrub.ts), is
// idempotent, and ends with the privacy scan: exit 0 when the tenant is clean, 1 when something is still flagged (an id
// that looks like an address, for one: that needs a hand). Prints counts and prop names, never the values.
import { parseArgs } from "node:util";
import { closeAll, listGraphs, graphName, openGraph } from "../../src/graph/client.js";
import { scanGraph } from "../../src/ingest/privacy.js";
import { redactGraph } from "../../src/ingest/scrub.js";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { "dry-run": { type: "boolean" } } });
const [tenant] = positionals;
if (!tenant || positionals.length > 1) {
  console.error("usage: npx tsx scripts/maint/redact-tenant.ts <tenant> [--dry-run]");
  process.exit(2);
}

let code = 0;
try {
  if (!(await listGraphs()).includes(graphName(tenant))) {
    console.error(`redact-tenant: no graph ${graphName(tenant)}`);
    process.exit(2);
  }
  const g = await openGraph(tenant);
  const before = await scanGraph(g);
  console.log(`redact-tenant ${tenant}: ${before.length} hit(s) before`);
  const t0 = Date.now();
  const r = await redactGraph(g, { dryRun: values["dry-run"] === true });
  const kinds = Object.entries(r.byKind).map(([k, n]) => `${k} ${n}`).join(", ") || "none";
  console.log(`${r.dryRun ? "would rewrite" : "rewrote"} ${r.props} prop(s) on ${r.nodes} node(s) and ${r.relationships} relationship(s) (${kinds}) in ${Date.now() - t0} ms`);
  if (!r.dryRun) {
    const left = await scanGraph(g);
    console.log(`redact-tenant ${tenant}: ${left.length} hit(s) after`);
    for (const h of left.slice(0, 50)) console.log(`  ${h.kind.padEnd(14)} ${h.id} .${h.prop}  ${h.sample}`);
    if (left.length) code = 1;
  }
} finally {
  await closeAll();
}
process.exit(code);
