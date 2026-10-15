// The CLI that issues and revokes owner links. The registry is a throwaway graph (ALLEVIA_META_GRAPH), never allevia_meta.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { verifyToken } from "../../src/auth/tokens.js";
import { loadCommands } from "../../src/cli.js";
import { closeAll, openGraphByName } from "../../src/graph/client.js";
import { getTenant } from "../../src/graph/tenants.js";
import { testGraphName } from "../helpers/graph.js";

const metaGraph = testGraphName();
const saved = process.env.ALLEVIA_META_GRAPH;

async function run(name: string, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const cmd = (await loadCommands()).find((c) => c.name === name)!;
  let out = "";
  let err = "";
  const log = vi.spyOn(console, "log").mockImplementation((...a) => { out += `${a.join(" ")}\n`; });
  const error = vi.spyOn(console, "error").mockImplementation((...a) => { err += `${a.join(" ")}\n`; });
  try {
    return { code: (await cmd.run(args)) ?? 0, out, err };
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}
const tokenIn = (out: string): string => /#key=(\S+)/.exec(out)![1]!;

beforeAll(async () => {
  process.env.ALLEVIA_META_GRAPH = metaGraph;
  const meta = await openGraphByName(metaGraph);
  await meta.query("CREATE (:Tenant {slug:'test_cli_a', name:'Alpha', graph:'x', businessId:'b', ontologyVersion:1, createdAt:1, updatedAt:1})", {});
});
afterAll(async () => {
  if (saved === undefined) delete process.env.ALLEVIA_META_GRAPH; else process.env.ALLEVIA_META_GRAPH = saved;
  await (await openGraphByName(metaGraph)).drop();
  await closeAll();
});

describe("auth CLI", () => {
  it("issues a link once, lists it without the secret, and revokes it", async () => {
    const issued = await run("auth:issue", "test_cli_a", "--label", "Priya laptop", "--days", "30");
    expect(issued.code).toBe(0);
    const token = tokenIn(issued.out);
    expect(issued.out).toMatch(/Owner link for test_cli_a/);
    expect(issued.out).toMatch(/http:\/\/127\.0\.0\.1:\d+\/#key=test_cli_a\./);
    expect(await verifyToken(token)).toMatchObject({ scope: "test_cli_a" });

    const listed = await run("auth:list");
    expect(listed.out).toContain("Priya laptop");
    expect(listed.out).toContain("live");
    expect(listed.out).not.toContain(token.slice(token.indexOf(".") + 1));
    expect(listed.out).not.toMatch(/[0-9a-f]{64}/);
    expect((await run("auth:list", "test_cli_a")).out).toContain("test_cli_a");
    expect((await run("auth:list", "someone_else")).out).toMatch(/No links issued/);

    const id = /(tok_[0-9a-f]+)/.exec(issued.out)![1]!;
    const revoked = await run("auth:revoke", id);
    expect(revoked).toMatchObject({ code: 0, out: expect.stringMatching(/Revoked 1 link/) });
    expect(await verifyToken(token)).toBeNull();
    expect((await run("auth:list")).out).toContain("revoked");
    expect((await run("auth:revoke", id)).code).toBe(1); // already revoked
  });

  it("revokes every link of one business", async () => {
    const a1 = tokenIn((await run("auth:issue", "test_cli_a")).out);
    const a2 = tokenIn((await run("auth:issue", "test_cli_a")).out);
    const op = tokenIn((await run("auth:issue", "--operator", "--label", "ops")).out);
    expect((await run("auth:revoke", "--tenant", "test_cli_a")).code).toBe(0);
    expect(await verifyToken(a1)).toBeNull();
    expect(await verifyToken(a2)).toBeNull();
    expect(await verifyToken(op)).toMatchObject({ scope: "operator" });
    expect((await run("auth:revoke", "--operator")).code).toBe(0);
    expect(await verifyToken(op)).toBeNull();
  });

  it("refuses a business that is not registered, a reserved name, a crafted name and bad arguments", async () => {
    for (const slug of ["nobody_here", "meta", "Bad Slug", "../x", "operator "]) {
      await expect(run("auth:issue", slug), slug).rejects.toThrow(/No such business|scope must be/);
    }
    expect((await run("auth:issue")).code).toBe(2);
    expect((await run("auth:issue", "test_cli_a", "--days", "0")).code).toBe(2);
    expect((await run("auth:issue", "test_cli_a", "--days", "x")).code).toBe(2);
    expect((await run("auth:issue", "--operator", "test_cli_a")).code).toBe(2);
    expect((await run("auth:revoke")).code).toBe(2);
    expect((await run("auth:revoke", "tok_x", "--tenant", "test_cli_a")).code).toBe(2);
  });

  it("marks and unmarks a demo", async () => {
    expect((await run("auth:demo", "test_cli_a")).code).toBe(0);
    expect((await getTenant("test_cli_a"))?.demo).toBe(true);
    expect((await run("auth:demo", "test_cli_a", "--off")).code).toBe(0);
    expect((await getTenant("test_cli_a"))?.demo).toBeUndefined();
    expect((await run("auth:demo", "nobody_here")).code).toBe(1);
  });
});
