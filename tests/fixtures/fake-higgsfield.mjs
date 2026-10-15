#!/usr/bin/env node
// A stand-in for the `higgsfield` CLI, for tests of the real exec runner: it logs the exact argument array it was given
// (one JSON line per call, to $FAKE_HF_LOG) and answers the few commands the Studio uses. FAKE_HF_MODE=sleep hangs, to
// prove the timeout kills it. It never calls the network and never costs anything.
import { appendFileSync, existsSync, statSync } from "node:fs";

const args = process.argv.slice(2);
const log = process.env.FAKE_HF_LOG;
const img = args.includes("--image") ? args[args.indexOf("--image") + 1] : undefined;
if (log) appendFileSync(log, JSON.stringify({ args, imageExists: img ? existsSync(img) : null, imageMode: img && existsSync(img) ? statSync(img).mode & 0o777 : null }) + "\n");
if (process.env.FAKE_HF_MODE === "sleep") {
  setTimeout(() => {}, 60_000);
} else {
  const cmd = args.filter((a) => !a.startsWith("--")).slice(0, 2).join(" ");
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  if (cmd.startsWith("account status")) out({ credits: 100, email: "owner@example.test", subscription_plan_type: "max" });
  else if (cmd.startsWith("generate cost")) out({ credits: 2 });
  else if (cmd.startsWith("generate create")) out({ job_ids: ["0a1b2c3d-1111-4222-8333-444455556666"] });
  else if (cmd.startsWith("generate wait")) out({ status: "completed" });
  else if (cmd.startsWith("generate get")) out({ id: "0a1b2c3d-1111-4222-8333-444455556666", status: "completed", results: [{ type: "image", url: "https://cdn.example.test/out.png", thumbnail_url: "https://cdn.example.test/thumb.png" }] });
  else { process.stderr.write("unknown command\n"); process.exit(2); }
}
