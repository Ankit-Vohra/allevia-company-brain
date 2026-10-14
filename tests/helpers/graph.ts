// Throwaway graph per test file: allevia_test_<random>, dropped by cleanup() in afterAll.
import { randomBytes } from "node:crypto";
import { openGraphByName, type GraphHandle } from "../../src/graph/client.js";

export function testGraphName(): string {
  return `allevia_test_${randomBytes(5).toString("hex")}`;
}

export async function testGraph(): Promise<{ g: GraphHandle; cleanup: () => Promise<void> }> {
  const g = await openGraphByName(testGraphName());
  return { g, cleanup: () => g.drop() };
}
