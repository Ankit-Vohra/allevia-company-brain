// Vitest setup file (every test file): its own throwaway reference graph (src/graph/reference.ts), so a test that onboards a
// business (which loads the shared reference) never changes what another file's agents read. Dropped after the file's tests,
// only when something opened it. The product's modules are imported only then: a static import here would load the playbook
// modules before a test file's vi.mock of them could apply.
import { afterAll } from "vitest";
import { randomBytes } from "node:crypto";

process.env.ALLEVIA_REFERENCE_GRAPH ??= `allevia_test_ref_${randomBytes(5).toString("hex")}`;

afterAll(async () => {
  const { referenceGraphName, referenceOpened } = await import("../../src/graph/reference.js");
  if (!referenceOpened()) return;
  const { closeAll, openGraphByName } = await import("../../src/graph/client.js");
  try {
    await (await openGraphByName(referenceGraphName())).drop();
  } catch {
    // the test server was not reachable: nothing to drop
  } finally {
    await closeAll();
  }
});
