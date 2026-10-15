// Vitest setup: integration tests talk to the local FalkorDB (127.0.0.1:6390), so give them room and run each file
// in its own forked process (one client connection per file, closed in afterAll). Tests never read the real secrets
// file: ALLEVIA_ENV_FILE points at a committed fixture with no values.
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    pool: "forks",
    // The query-shape check: setupFiles record what src/ sends, globalSetup plans it all with EXPLAIN when the run ends.
    globalSetup: ["tests/setup/query-shapes.global.ts"],
    setupFiles: ["tests/setup/query-shapes.ts"],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    env: {
      ALLEVIA_ENV_FILE: fileURLToPath(new URL("./tests/fixtures/allevia.test.env", import.meta.url)),
    },
  },
});
