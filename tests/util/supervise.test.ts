// scripts/ops/supervise.sh (issue #28): a process that exits is started again, and everything goes to the log file.
import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../scripts/ops/supervise.sh", import.meta.url));

describe("the supervisor", () => {
  it("starts the process again after it exits and logs its output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "allevia-supervise-"));
    try {
      await new Promise<void>((resolve, reject) => {
        execFile("sh", [SCRIPT, "probe", "sh", "-c", "echo hello from the probe; exit 3"], {
          env: { ...process.env, ALLEVIA_LOG_DIR: dir, ALLEVIA_SUPERVISE_MAX_RUNS: "3", ALLEVIA_SUPERVISE_PAUSE: "0" }, timeout: 15_000,
        }, (e) => (e ? reject(e) : resolve()));
      });
      const log = readFileSync(join(dir, "probe.log"), "utf8");
      expect(log.match(/^hello from the probe$/gm)).toHaveLength(3);
      expect(log.match(/\[supervise:probe\] starting:/g)).toHaveLength(3);
      expect(log).toMatch(/exited with code 3 after \d+s; starting again/);
      expect(log).toMatch(/run limit reached/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
