// Vitest setup: integration tests talk to a test-only FalkorDB (127.0.0.1:6391, never the real 6390), so give them room and run each file
// in its own forked process (one client connection per file, closed in afterAll). Tests never read the real secrets
// file: ALLEVIA_ENV_FILE points at a committed fixture with no values.
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const TEST_FALKORDB_URL = process.env.ALLEVIA_TEST_FALKORDB_URL ?? "redis://127.0.0.1:6391";
const ENV_FILE = fileURLToPath(new URL("./tests/fixtures/allevia.test.env", import.meta.url));
if (/:6390\b/.test(TEST_FALKORDB_URL)) throw new Error("tests never run against 6390, the real tenants' database");
// `env` below reaches the workers only. The global setups (query-shape check, fixture templates) run in this process
// and open graphs too: without these they would read the fixture env file's defaults and connect to 6390.
process.env.ALLEVIA_FALKORDB_URL = TEST_FALKORDB_URL;
process.env.ALLEVIA_ENV_FILE = ENV_FILE;

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    pool: "forks",
    // Keep the machine light: at most 4 test processes at once.
    maxWorkers: 4,
    // Node 24.18 on this Mac dies now and then with SIGTRAP inside V8's incremental-marking GC task (crash reports in
    // ~/Library/Logs/DiagnosticReports). The GC is not what the tests exercise: collect in one stop-the-world pass instead.
    execArgv: ["--no-incremental-marking", "--no-concurrent-marking"],
    // The query-shape check: setupFiles record what src/ sends, globalSetup plans it all with EXPLAIN when the run ends.
    globalSetup: ["tests/setup/query-shapes.global.ts", "tests/setup/templates.global.ts"],
    setupFiles: ["tests/setup/query-shapes.ts", "tests/setup/native.ts"],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    env: {
      // Tests never touch the real tenants' database (6390): they get their own throwaway FalkorDB on 6391
      // (container allevia-falkordb-test, no persistence). Override with ALLEVIA_TEST_FALKORDB_URL.
      ALLEVIA_FALKORDB_URL: TEST_FALKORDB_URL,
      ALLEVIA_ENV_FILE: ENV_FILE,
    },
  },
});
