// Vitest global setup. Every query the product sent during the run was recorded by tests/setup/query-shapes.ts; when
// the run ends this plans each distinct one with GRAPH.EXPLAIN on a scratch graph that has the real indexes and
// constraints, and fails the run if a query that looks a node up by id also scans a label or the whole graph (see
// tests/helpers/plan-lint.ts). It is what keeps `MATCH (d:Document {id:$x})` (a scan of every Document, for lack of the
// Entity label the id index is on) from coming back, in code the test suite exercises and in code it does not know about.
// A run of a few files checks the shapes of those files.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { INTENTIONAL_SCANS } from "../helpers/intentional-scans.js";
import { SHAPES_ENV, checkShapes, readShapes } from "../helpers/query-shapes.js";

export default function setup(): () => Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "allevia-query-shapes-"));
  process.env[SHAPES_ENV] = dir; // the workers are forked after this, and inherit it

  return async () => {
    try {
      const shapes = readShapes(dir);
      if (process.env.ALLEVIA_SHAPES_DEBUG) console.log(`[query-shapes] ${shapes.length} shapes recorded in ${dir}`);
      if (!shapes.length) return;
      // The same config the tests ran with: the fixture env file, never the real secrets file.
      process.env.ALLEVIA_ENV_FILE ??= fileURLToPath(new URL("../fixtures/allevia.test.env", import.meta.url));
      const { openGraphByName, closeAll } = await import("../../src/graph/client.js");
      const { ensureIndexes } = await import("../../src/graph/indexes.js");
      const { ACCOUNT_INDEXES } = await import("../../src/auth/accounts.js");
      const { testGraphName } = await import("./../helpers/graph.js");
      const g = await openGraphByName(testGraphName());
      try {
        await ensureIndexes(g);
        // the registry's own indexes too (accounts: User.id, Session.idHash, …), so its queries plan as they do in allevia_meta
        await ensureIndexes(g, ACCOUNT_INDEXES.map((i) => ({ ...i, type: "RANGE" as const })));
        const r = await checkShapes((q) => g.explain(q), shapes, INTENTIONAL_SCANS);
        if (r.unplannable > 0.1 * shapes.length) throw new Error(`query-shape check: ${r.unplannable} of ${shapes.length} recorded shapes would not plan`);
        if (r.violations.length) {
          const lines = r.violations.map((v) => `  ${v.file}\n    ${v.scans.join(", ")}\n    ${v.q.slice(0, 260)}`);
          throw new Error(
            `${r.violations.length} of ${r.checked} query shapes look a node up by id and still scan (add the Entity label to the anchor; ` +
            `if the scan is intended, list the shape in tests/helpers/intentional-scans.ts):\n${lines.join("\n")}`);
        }
      } finally {
        await g.drop();
        await closeAll();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
