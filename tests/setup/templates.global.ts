// Vitest global setup: seed each fixture graph once (tests/helpers/templates.ts), before any worker starts, and drop the
// templates when the run ends. Workers are forked after this and inherit the environment variable that names them.
// No test server reachable (a run of unit tests only): nothing is built, and a file that wants a fixture seeds it itself.
import { randomBytes } from "node:crypto";

export default async function setup(): Promise<() => Promise<void>> {
  const url = process.env.ALLEVIA_FALKORDB_URL; // set to the test server by vitest.config.ts, in this process too
  if (!url || /:6390\b/.test(url)) throw new Error("fixture templates: ALLEVIA_FALKORDB_URL must name the test server, never 6390");
  const { closeAll, connect, openGraphByName, pingServer } = await import("../../src/graph/client.js");
  const { SEEDERS, TEMPLATES_ENV } = await import("../helpers/templates.js");
  try {
    await pingServer(url);
  } catch {
    return async () => undefined;
  }

  const run = randomBytes(4).toString("hex");
  const built: string[] = [];
  const names: Record<string, string> = {};
  const dropAll = async (): Promise<void> => {
    const live = new Set(await (await connect()).list());
    for (const name of built) if (live.has(name)) await (await openGraphByName(name)).drop();
    await closeAll();
  };
  try {
    for (const [fixture, seed] of Object.entries(SEEDERS)) {
      const g = await openGraphByName(`allevia_test_tpl_${run}_${fixture}`);
      built.push(g.name);
      await seed(g);
      names[fixture] = g.name;
    }
  } catch (e) {
    await dropAll();
    throw e;
  }
  process.env[TEMPLATES_ENV] = JSON.stringify(names);
  await closeAll();
  return dropAll;
}
