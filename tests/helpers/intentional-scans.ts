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
  {
    shape: /\(\w+\.id IN \$refIds OR coalesce\(\w+\.refStub, false\) = true OR /,
    why: "the reference filter (src/graph/reference.ts) tells general know-how apart inside a whole-graph read (the map, the counts, the growth story, the split): the scan is the read's own, the id list only filters it",
  },
  {
    shape: /^MATCH \(n:Entity\) WHERE \(n:Playbook OR n:Rule OR n:Event OR n:Document\) AND NOT n\.id IN \$have /,
    why: "the Brain map's \"Show general know-how\": the most connected things of the shared reference graph (a few hundred), less those already drawn",
  },
  {
    shape: /^MATCH \(a:Entity:Approval\) WITH a ORDER BY /,
    why: "the approvals list: every Approval, newest first, capped by $limit; the id lookup after it is per row",
  },
];
