// One read-only snapshot of Aamdani's live data through the aamdani-ops MCP server over SSH, then the mapper's counts.
//
//   npx tsx scripts/ops-snapshot.ts                      # snapshot via the config's ssh alias (aamdani-box), then counts
//   npx tsx scripts/ops-snapshot.ts --via <alias>        # another ~/.ssh/config alias (--via none: user@host with the key)
//   npx tsx scripts/ops-snapshot.ts --map <snapshot-dir> # map an existing snapshot only, print counts
//
// Prints statuses, timings, sizes and counts only: never a value, a secret or an env var. Set ALLEVIA_DATA_DIR to put
// the snapshot under another data dir (data/snapshots/aamdani/<IST date>/). Ctrl-C (or SIGTERM) closes the connection,
// which ends ssh and the remote server, writes the manifest and exits 130.
import { basename } from "node:path";
import { countWrite, mapSnapshot, redactText } from "../src/ingest/sources/ops-map/index.js";
import { runOpsSnapshot } from "../src/ingest/sources/ops.js";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

function printCounts(dir: string): void {
  const date = basename(dir);
  const counts = countWrite(mapSnapshot(dir, { tenantSlug: "aamdani", asOf: date }));
  console.log(JSON.stringify(counts, null, 1));
}

const mapOnly = flag("--map");
if (mapOnly) {
  printCounts(mapOnly);
} else {
  // Ctrl-C / kill: abort, which closes the MCP client (ending ssh and the remote server); the snapshot writes its
  // manifest and stops; exit 130. A second signal exits at once, and so does a close that takes more than 5 s.
  const stop = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      console.error(`\n${sig}: closing the ops connection`);
      stop.abort();
      setTimeout(() => process.exit(130), 5_000).unref();
    });
  }
  let result: Awaited<ReturnType<typeof runOpsSnapshot>>;
  try {
    result = await runOpsSnapshot({ via: flag("--via"), log: (l) => console.log(l), signal: stop.signal });
  } catch (e) {
    // Connecting or listing failed (or was interrupted): a short, redacted reason; the manifest says the rest.
    console.error(`snapshot failed: ${redactText(String((e as Error)?.message ?? e).slice(0, 300)).text}`);
    process.exit(stop.signal.aborted ? 130 : 1);
  }
  const { dir, manifest } = result;
  if (manifest.aborted) {
    console.error(`aborted: manifest written to ${dir}`);
    process.exit(130);
  }
  console.log(`\nsnapshot: ${dir}`);
  console.log(`server tools listed: ${manifest.serverToolCount}`);
  for (const [call, e] of Object.entries(manifest.calls)) {
    console.log(`  ${call.padEnd(22)} ${e.status.padEnd(15)} ${String(e.ms).padStart(6)} ms ${String(e.bytes).padStart(8)} B${e.cached ? " (cached)" : ""}`);
  }
  for (const [call, why] of Object.entries(manifest.skipped)) console.log(`  ${call.padEnd(22)} skipped: ${why}`);
  console.log("\nmapped counts:");
  printCounts(dir);
}
