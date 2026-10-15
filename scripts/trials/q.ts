// Read-only Cypher against a tenant graph, for the content trials. Usage: npx tsx scripts/trials/q.ts <tenant> "<cypher>"
import { closeAll, openGraph } from "../../src/graph/client.js";
const [tenant, cypher] = process.argv.slice(2);
const g = await openGraph(tenant!);
try { console.log(JSON.stringify(await g.roQuery(cypher!, {}), null, 1)); } finally { await closeAll(); }
