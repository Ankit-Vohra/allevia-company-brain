// Query shapes that look a node up by id and still scan a label. See tests/setup/query-shapes.global.ts.
import type { IntentionalScan } from "./query-shapes.js";

export const INTENTIONAL_SCANS: IntentionalScan[] = [
  // Not an intention: the agent, the ingest pipeline and the librarian are being rewritten on another branch, and their
  // id anchors (and the Searchable / metricKey queries) are brought in line when that lands. Delete this entry then.
  {
    shape: /^MATCH \(p:Entity:Person\) WHERE p\.id = 'person:founder' OR p\.role IN /,
    why: "who is the owner: the id OR a role, so no index can serve it; Person is the team and the owner, a handful of nodes",
  },
  {
    shape: /^MATCH \(c:Entity:Channel\) WHERE c\.id = \$raw OR /,
    why: "a channel named by id or by name or platform: the OR cannot use the index; Channel is a handful of nodes",
  },
  {
    shape: /^MATCH \(t:Task \{id:'task:fix-sitemap'\}\) RETURN \{id: id\(t\)/,
    why: "the cypher tool passes the model's own query through (this one is a test's): its anchors are not ours to write",
  },
  {
    shape: /^MATCH \(r:Entity\) WHERE \(r:Rule OR r:BrandRule\) AND \(\$allowed IS NULL OR r\.id IN \$allowed\)/,
    why: "the rules survey (no names given, or filtered to one channel's): tens of Rule and BrandRule nodes, scanned by design",
  },
];
