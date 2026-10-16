// docs/falkordb-queries.md is part of the submission ("the Cypher queries the product depends on"), so it is held to
// the code: every `file:line` it cites exists, every file it names exists, and every ```cypher block passes the
// FalkorDB 6.0.2 crash rules and plans with GRAPH.EXPLAIN on a seeded throwaway graph.
import { existsSync, readFileSync } from "node:fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { assertSafeQuery } from "../../src/graph/safety.js";
import { graphFrom } from "../helpers/templates.js";

const DOC = readFileSync(new URL("../../docs/falkordb-queries.md", import.meta.url), "utf8");
const root = (p: string) => new URL(`../../${p}`, import.meta.url);

describe("docs/falkordb-queries.md", () => {
  it("cites lines that exist and files that exist", () => {
    const refs = [...DOC.matchAll(/((?:src|tests|scripts|docs)\/[\w./-]+\.(?:ts|md|tsx)):(\d+)/g)];
    expect(refs.length).toBeGreaterThan(30);
    for (const [, file, line] of refs) {
      expect(existsSync(root(file!)), file).toBe(true);
      const lines = readFileSync(root(file!), "utf8").split("\n").length;
      expect(Number(line), `${file}:${line}`).toBeLessThanOrEqual(lines);
    }
    for (const [, file] of DOC.matchAll(/`((?:src|tests|scripts|docs)\/[\w./-]+\.(?:ts|md))`/g)) expect(existsSync(root(file!)), file).toBe(true);
  });

  describe("every cypher block (integration)", () => {
    let g: GraphHandle;
    let cleanup: () => Promise<void>;
    beforeAll(async () => {
      ({ g, cleanup } = await graphFrom("mini"));
    }, 60_000);
    afterAll(async () => {
      await cleanup();
      await closeAll();
    });
    const blocks = [...DOC.matchAll(/```cypher\n([\s\S]*?)```/g)].map((m) => m[1]!.trim());

    it("has the blocks the product depends on", () => expect(blocks.length).toBeGreaterThanOrEqual(15));
    it.each(blocks.map((b, i) => [i + 1, b] as const))("block %i is safe and plans", async (_, q) => {
      expect(() => assertSafeQuery(q)).not.toThrow();
      const plan = await g.explain(q);
      expect(plan.length).toBeGreaterThan(0);
    });
  });
});
