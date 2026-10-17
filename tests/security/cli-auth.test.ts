// The CLI that issues and revokes owner links. The registry is a throwaway graph (ALLEVIA_META_GRAPH), never allevia_meta.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { acceptInvite, checkLogin, createUser, listUsers, previewInvite, useResetCode } from "../../src/auth/accounts.js";
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

describe("accounts CLI", () => {
  const PW = "a long enough password";

  it("invites an owner into a business set up before sign-in, lists accounts without a hash, resets a password, switches an account off", async () => {
    const inv = await run("auth:invite", "test_cli_a", "--role", "owner");
    expect(inv.code).toBe(0);
    const code = /\/invite\/([A-Za-z0-9_-]{43})/.exec(inv.out)![1]!;
    expect(inv.out).toMatch(/as owner/);
    expect(await previewInvite(code)).toMatchObject({ slug: "test_cli_a", role: "owner" });
    const u = (await createUser({ email: "cli.owner@example.com", name: "Cli Owner", password: PW }))!;
    expect(await acceptInvite(code, u.id)).toMatchObject({ slug: "test_cli_a", role: "owner" });

    const users = await run("auth:users");
    expect(users.out).toMatch(/cli\.owner@example\.com .*"Cli Owner"\s+test_cli_a \(owner\)/);
    expect(users.out).not.toMatch(/scrypt|[0-9a-f]{64}/);
    expect((await run("auth:users", "test_cli_a")).out).toContain("cli.owner@example.com");
    expect((await run("auth:users", "someone_else")).out).toMatch(/No accounts in someone_else/);

    const reset = await run("auth:reset-link", "CLI.Owner@example.com");
    expect(reset.code).toBe(0);
    const resetCode = /\/reset\/([A-Za-z0-9_-]{43})/.exec(reset.out)![1]!;
    expect(await useResetCode(resetCode, "a fresh new password")).toMatchObject({ id: u.id });
    expect(await checkLogin("cli.owner@example.com", "a fresh new password")).not.toBeNull();
    expect((await run("auth:reset-link", "nobody@example.com")).code).toBe(1);

    expect((await run("auth:disable", "cli.owner@example.com")).code).toBe(0);
    expect(await checkLogin("cli.owner@example.com", "a fresh new password")).toBeNull();
    expect((await run("auth:users")).out).toMatch(/OFF/);
    expect((await run("auth:disable", "cli.owner@example.com", "--off")).code).toBe(0);
    expect(await checkLogin("cli.owner@example.com", "a fresh new password")).not.toBeNull();
  });

  it("makes an account the operator, shows it in auth:users, and takes it away with --off", async () => {
    await createUser({ email: "cli.founder@example.com", name: "Cli Founder", password: PW });
    const on = await run("auth:operator", "CLI.Founder@example.com");
    expect(on).toMatchObject({ code: 0, out: expect.stringMatching(/cli\.founder@example\.com is the operator/) });
    expect((await listUsers()).find((u) => u.email === "cli.founder@example.com")?.operator).toBe(true);
    expect((await run("auth:users")).out).toMatch(/cli\.founder@example\.com\s+OPERATOR/);
    const off = await run("auth:operator", "cli.founder@example.com", "--off");
    expect(off).toMatchObject({ code: 0, out: expect.stringMatching(/no longer the operator/) });
    expect((await listUsers()).find((u) => u.email === "cli.founder@example.com")?.operator).toBe(false);
    expect((await run("auth:users")).out).not.toMatch(/OPERATOR/);
    expect((await run("auth:operator")).code).toBe(2);
    expect((await run("auth:operator", "a@example.com", "b@example.com")).code).toBe(2);
    expect((await run("auth:operator", "nobody@example.com")).code).toBe(1);
  });

  it("refuses bad arguments", async () => {
    expect((await run("auth:invite")).code).toBe(2);
    expect((await run("auth:invite", "test_cli_a", "--role", "admin")).code).toBe(2);
    expect((await run("auth:invite", "test_cli_a", "--days", "99")).code).toBe(2);
    expect((await run("auth:invite", "nobody_here")).code).toBe(1);
    expect((await run("auth:reset-link")).code).toBe(2);
    expect((await run("auth:disable")).code).toBe(2);
    expect((await run("auth:disable", "nobody@example.com")).code).toBe(1);
  });
});
