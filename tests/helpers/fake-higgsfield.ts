// An in-process fake of the `higgsfield` CLI (a CliRun): it answers the commands the Studio uses, records every argument
// array, and checks that the photo it is handed is a real file in a private directory at the moment it is used.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { CliResult, CliRun } from "../../src/studio/higgsfield.js";

export interface FakeCliOpts {
  loggedIn?: boolean;
  missing?: boolean;
  balance?: number;
  cost?: number | "garbage";
  createFails?: boolean;
  /** What `generate get` says: completed, failed or running. May be a function of the call count, per job. */
  status?: "completed" | "failed" | "running" | ((n: number) => "completed" | "failed" | "running");
  resultUrl?: string;
}

export interface FakeCli {
  run: CliRun;
  calls: string[][];
  /** The photo files seen in create/cost calls: where, whether the file existed then, its directory's mode, its size. */
  images: Array<{ path: string; existed: boolean; dirMode: number | null; fileMode: number | null; bytes: number }>;
  created: string[];
}

const out = (o: unknown): CliResult => ({ code: 0, stdout: `${JSON.stringify(o)}\n`, stderr: "", timedOut: false, missing: false });
const fail = (stderr = "error"): CliResult => ({ code: 1, stdout: "", stderr, timedOut: false, missing: false });

export function fakeCli(o: FakeCliOpts = {}): FakeCli {
  const calls: string[][] = [];
  const images: FakeCli["images"] = [];
  const created: string[] = [];
  let gets = 0;
  let seq = 0;
  const run: CliRun = async (args) => {
    calls.push(args);
    if (o.missing) return { code: null, stdout: "", stderr: "", timedOut: false, missing: true };
    const words = args.filter((a) => !a.startsWith("--"));
    const cmd = `${words[0]} ${words[1]}`;
    const img = ["--image", "--start-image"].map((f) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined)).find(Boolean);
    if (img) {
      const ok = existsSync(img);
      images.push({ path: img, existed: ok, dirMode: ok ? statSync(dirname(img)).mode & 0o777 : null, fileMode: ok ? statSync(img).mode & 0o777 : null, bytes: ok ? readFileSync(img).length : 0 });
    }
    if (cmd === "account status") return o.loggedIn === false ? fail("not logged in") : out({ credits: o.balance ?? 600, email: "owner@example.test" });
    if (cmd === "generate cost") return o.cost === "garbage" ? { ...out({}), stdout: "not json at all" } : out({ credits: o.cost ?? 2 });
    if (cmd === "generate create") {
      if (o.createFails) return fail("boom");
      const id = `0a1b2c3d-1111-4222-8333-${String(++seq).padStart(12, "0")}`;
      created.push(id);
      return out({ job_ids: [id] });
    }
    if (cmd === "generate wait") return out({ status: "running" });
    if (cmd === "generate get") {
      gets++;
      const status = typeof o.status === "function" ? o.status(gets) : o.status ?? "completed";
      return out({ id: args[args.indexOf("get") + 1], status, results: status === "completed" ? [{ type: "image", url: o.resultUrl ?? "https://cdn.example.test/out.png", thumbnail_url: "https://cdn.example.test/thumb.png" }] : [] });
    }
    return fail("unknown command");
  };
  return { run, calls, images, created };
}
