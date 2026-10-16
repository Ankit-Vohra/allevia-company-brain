// FalkorDB 6.0.2 writes no effects for a node made and deleted in the SAME query ("modified but produced no effects payload;
// the change will not reach replicas or the AOF"). A label registered that way (`CREATE (n:Entity) DELETE n`) is then missing
// from the append-only file, and the first later effect that names it (an index on :Entity) makes the file unloadable: the
// server exits at its next start with "Diverged applying GRAPH.EFFECT ... label 'Entity' ... does not exist here", and the
// public demo's Docker volume has to be thrown away. Found on 16 October 2026 by restarting a container after `seed-demo`
// (docker-compose.yml runs with --appendonly yes). A label is registered in two statements instead: create, then delete.
// This is a source scan: the failure needs a server restart, which a test run on a shared throwaway server cannot do.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL("../../src/", import.meta.url).pathname;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
}

describe("append-only file stays loadable", () => {
  it("no query in src/ creates a node and deletes it in the same statement", () => {
    const hits: string[] = [];
    for (const f of files(SRC)) {
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return; // comments explain the rule
        if (/CREATE\s*\([a-z]*(:[A-Za-z_${}.]+)+[^)]*\)\s*DELETE\b/i.test(line)) hits.push(`${f.slice(SRC.length)}:${i + 1}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
