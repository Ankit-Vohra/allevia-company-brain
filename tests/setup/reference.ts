// Vitest setup file (every test file): its own throwaway reference graph (src/graph/reference.ts), so a test that onboards a
// business (which loads the shared reference) never changes what another file's agents read. Dropped after the file's tests,
// only when something opened it.
import { afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { closeAll, openGraphByName } from "../../src/graph/client.js";
import { referenceGraphName, referenceOpened } from "../../src/graph/reference.js";

process.env.ALLEVIA_REFERENCE_GRAPH ??= `allevia_test_ref_${randomBytes(5).toString("hex")}`;

afterAll(async () => {
  if (!referenceOpened()) return;
  try {
    await (await openGraphByName(referenceGraphName())).drop();
  } catch {
    // the test server was not reachable: nothing to drop
  } finally {
    await closeAll();
  }
});
