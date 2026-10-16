// Seeded graphs built once per run. seedMini is ~800 single writes and seedInsights more; done by every file that wants
// one (40-odd files, some twice), that was tens of thousands of writes queued on the shared 2-thread test server, which
// is what made unrelated tests time out in a full run. Instead tests/setup/templates.global.ts seeds each fixture once,
// before any worker starts, and a file gets its own copy with one GRAPH.COPY (milliseconds for a graph this size).
// A copy is the same graph the seeder would build (the fixtures are deterministic: fixed clocks, no randomness).
// Outside a vitest run (no templates in the environment) the fixture is seeded directly, as before.
import { connect, openGraphByName, type GraphHandle } from "../../src/graph/client.js";
import { seedInsights } from "../fixtures/insights-graph.js";
import { seedMini } from "../fixtures/seed-graph.js";
import { testGraphName } from "./graph.js";

export const TEMPLATES_ENV = "ALLEVIA_TEST_TEMPLATES";

export const SEEDERS = {
  mini: seedMini,
  insights: seedInsights,
} satisfies Record<string, (g: GraphHandle) => Promise<void>>;

export type TemplateName = keyof typeof SEEDERS;

function templateGraph(name: TemplateName): string | undefined {
  const raw = process.env[TEMPLATES_ENV];
  if (!raw) return undefined;
  return (JSON.parse(raw) as Partial<Record<TemplateName, string>>)[name];
}

// Fills `g` (a new, empty graph) with the named fixture: a copy of the run's template, or a fresh seed without one.
export async function seedFrom(name: TemplateName, g: GraphHandle): Promise<void> {
  const tpl = templateGraph(name);
  if (!tpl) return SEEDERS[name](g);
  const db = await connect();
  await db.selectGraph(tpl).copy(g.name);
}

// A new throwaway graph holding the named fixture; cleanup() drops it.
export async function graphFrom(name: TemplateName): Promise<{ g: GraphHandle; cleanup: () => Promise<void> }> {
  const g = await openGraphByName(testGraphName());
  try {
    await seedFrom(name, g);
  } catch (e) {
    await g.drop().catch(() => undefined); // a failed seed must not leave its graph on the shared server
    throw e;
  }
  return { g, cleanup: () => g.drop() };
}
