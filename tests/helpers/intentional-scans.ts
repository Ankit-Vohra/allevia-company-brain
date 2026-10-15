// Query shapes that look a node up by id and still scan a label. See tests/setup/query-shapes.global.ts.
import type { IntentionalScan } from "./query-shapes.js";

export const INTENTIONAL_SCANS: IntentionalScan[] = [
  // Not an intention: the agent, the ingest pipeline and the librarian are being rewritten on another branch, and their
  // id anchors (and the Searchable / metricKey queries) are brought in line when that lands. Delete this entry then.
  { file: /^src\/(agent\/|ingest\/(pipeline|librarian)\.ts)/, why: "deferred: rewritten on another branch" },
  {
    shape: /^MATCH \(p:Entity:Person\) WHERE p\.id = 'person:founder' OR p\.role IN /,
    why: "who is the owner: the id OR a role, so no index can serve it; Person is the team and the owner, a handful of nodes",
  },
];
