// Owner tokens (src/auth/tokens.ts): long random, hashed at rest in the registry graph, scoped to one business (or to the
// operator), revocable, optionally expiring. A throwaway registry graph, never the real allevia_meta.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { closeAll, openGraph, openGraphByName } from "../../src/graph/client.js";
import { ensureTenant, getTenant, listTenants, setDemo } from "../../src/graph/tenants.js";
import { issueToken, listTokens, parseToken, revokeToken, verifyToken } from "../../src/auth/tokens.js";
import { testGraphName } from "../helpers/graph.js";

const metaGraph = testGraphName();
const opts = { metaGraph };
const A = `test_${Math.random().toString(36).slice(2, 8)}a`;
const B = `test_${Math.random().toString(36).slice(2, 8)}b`;

beforeAll(async () => {
  await ensureTenant({ slug: A, name: "Alpha" }, opts);
  await ensureTenant({ slug: B, name: "Bravo" }, opts);
});
afterAll(async () => {
  await (await openGraphByName(metaGraph)).drop();
  await (await openGraph(A)).drop();
  await (await openGraph(B)).drop();
  await closeAll();
});

describe("owner tokens", () => {
  it("issues a long random token that names its business, and shows it once", async () => {
    const t = await issueToken(A, { label: "Priya's laptop" }, opts);
    expect(t.scope).toBe(A);
    expect(t.token.startsWith(`${A}.`)).toBe(true);
    expect(t.token.length).toBeGreaterThanOrEqual(A.length + 1 + 43); // 256 bits of randomness, base64url
    const again = await issueToken(A, {}, opts);
    expect(again.token).not.toBe(t.token);
    expect(again.tokenId).not.toBe(t.tokenId);
  });

  it("keeps only a hash: the token is nowhere in the registry, and the listing cannot show it", async () => {
    const t = await issueToken(A, { label: "hash check" }, opts);
    const secret = t.token.slice(t.token.indexOf(".") + 1);
    const meta = await openGraphByName(metaGraph);
    const dump = JSON.stringify(await meta.roQuery("MATCH (n) RETURN properties(n) AS p ORDER BY id(n)"));
    expect(dump).not.toContain(secret);
    expect(dump).toContain(createHash("sha256").update(secret).digest("hex")); // the sha-256 of the secret is what is stored
    const listed = JSON.stringify(await listTokens({}, opts));
    expect(listed).not.toContain(secret);
    expect(listed).not.toMatch(/[0-9a-f]{64}/); // no hash either
    expect(listed).toContain("hash check");
    // the tenant list reads the same graph and still shows only businesses
    const tenants = JSON.stringify(await listTenants(opts));
    expect(tenants).not.toContain(secret);
    expect(tenants).not.toMatch(/[0-9a-f]{64}/);
    expect(await getTenant(A, opts)).not.toHaveProperty("hash");
  });

  it("verifies its own token for its own business and no other", async () => {
    const t = await issueToken(A, {}, opts);
    expect(await verifyToken(t.token, opts)).toMatchObject({ scope: A, tokenId: t.tokenId });
    // the same secret under another business's name is not valid
    const secret = t.token.slice(t.token.indexOf(".") + 1);
    expect(await verifyToken(`${B}.${secret}`, opts)).toBeNull();
    expect(await verifyToken(`operator.${secret}`, opts)).toBeNull();
  });

  it("refuses anything that is not a token it issued", async () => {
    const t = await issueToken(A, {}, opts);
    const secret = t.token.slice(t.token.indexOf(".") + 1);
    for (const bad of [
      "", ".", "x", `${A}.`, `.${secret}`, `${A}.${secret.slice(0, -1)}`, `${A}.${secret}x`, `${A}.${secret.toUpperCase()}`, ` ${t.token}`, `${t.token} `, `${t.token}\n`,
      `Bearer ${t.token}`, `${A}.${secret}.${secret}`, `${A}..${secret}`, "a".repeat(5000), `${A}.' OR 1=1 //`, `${A}.${"A".repeat(43)}`, `../${t.token}`, `${A.toUpperCase()}.${secret}`,
    ]) {
      expect(await verifyToken(bad, opts), JSON.stringify(bad).slice(0, 60)).toBeNull();
    }
    expect(parseToken(undefined)).toBeNull();
    expect(parseToken(42 as unknown as string)).toBeNull();
  });

  it("is revocable, at once, one token at a time", async () => {
    const keep = await issueToken(A, { label: "keep" }, opts);
    const drop = await issueToken(A, { label: "drop" }, opts);
    expect(await verifyToken(drop.token, opts)).not.toBeNull();
    expect(await revokeToken({ tokenId: drop.tokenId }, opts)).toBe(1);
    expect(await verifyToken(drop.token, opts)).toBeNull();
    expect(await verifyToken(keep.token, opts)).not.toBeNull();
    expect((await listTokens({ scope: A }, opts)).find((x) => x.tokenId === drop.tokenId)).toMatchObject({ revoked: true });
    expect(await revokeToken({ tokenId: drop.tokenId }, opts)).toBe(0); // already revoked
    // revoke every token of one business; the other business keeps its own
    const other = await issueToken(B, {}, opts);
    expect(await revokeToken({ scope: A }, opts)).toBeGreaterThanOrEqual(1);
    expect(await verifyToken(keep.token, opts)).toBeNull();
    expect(await verifyToken(other.token, opts)).not.toBeNull();
  });

  it("can expire", async () => {
    const t0 = Date.now();
    const short = await issueToken(A, { expiresAt: t0 + 60_000 }, opts);
    expect(await verifyToken(short.token, { ...opts, now: t0 + 30_000 })).not.toBeNull();
    expect(await verifyToken(short.token, { ...opts, now: t0 + 61_000 })).toBeNull();
    await expect(issueToken(A, { expiresAt: t0 - 1000 }, opts)).rejects.toThrow(/future/);
  });

  it("issues only for a registered business, and an operator token is its own scope", async () => {
    await expect(issueToken("not_registered_anywhere", {}, opts)).rejects.toThrow(/no such business/i);
    await expect(issueToken("Bad Slug", {}, opts)).rejects.toThrow(/tenant slug|scope/);
    await expect(issueToken("meta", {}, opts)).rejects.toThrow(/tenant slug|scope/);
    const op = await issueToken("operator", { label: "ops" }, opts);
    expect(op.token.startsWith("operator.")).toBe(true);
    expect(await verifyToken(op.token, opts)).toMatchObject({ scope: "operator" });
  });

  it("marks a business as a public demo, and only a registered one", async () => {
    expect(await setDemo(A, true, opts)).toBe(true);
    expect((await getTenant(A, opts))?.demo).toBe(true);
    expect((await getTenant(B, opts))?.demo).toBeUndefined();
    // re-registering (every ingest does) does not drop the flag
    await ensureTenant({ slug: A, name: "Alpha" }, opts);
    expect((await getTenant(A, opts))?.demo).toBe(true);
    expect(await setDemo(A, false, opts)).toBe(true);
    expect((await getTenant(A, opts))?.demo).toBeUndefined();
    expect(await setDemo("not_registered_anywhere", true, opts)).toBe(false);
  });
});
