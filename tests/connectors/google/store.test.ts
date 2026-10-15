// Connector tokens at rest: sealed per tenant (AES-256-GCM, a key derived from the server's connector key and the tenant's
// slug), in a file only the server can read, never in the graph. One tenant's file cannot be opened as another's.
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { open, seal } from "../../../src/connectors/google/crypto.js";
import { FileTokenStore, type TokenRecord } from "../../../src/connectors/google/store.js";

const KEY = "test-connector-key-0123456789abcdef0123456789abcdef"; // a test value, not a real key
const rec = (n: string): TokenRecord => ({ accessToken: `access-${n}-AAAAAAAAAAAAAAAA`, refreshToken: `refresh-${n}-BBBBBBBBBBBBBBBB`, expiresAt: 1_800_000_000_000, scope: "https://www.googleapis.com/auth/webmasters.readonly", obtainedAt: 1_790_000_000_000 });

describe("sealing", () => {
  it("round-trips, and a sealed value is not the plain value", () => {
    const sealed = seal(KEY, "kestrel", "search-console", { hello: "world" });
    expect(sealed).not.toContain("world");
    expect(open(KEY, "kestrel", "search-console", sealed)).toEqual({ hello: "world" });
  });

  it("is bound to the tenant, the connector and the key", () => {
    const sealed = seal(KEY, "kestrel", "search-console", { a: 1 });
    expect(() => open(KEY, "other", "search-console", sealed)).toThrow(/could not be opened/i);
    expect(() => open(KEY, "kestrel", "ga4", sealed)).toThrow(/could not be opened/i);
    expect(() => open(`${KEY}x`, "kestrel", "search-console", sealed)).toThrow(/could not be opened/i);
    expect(() => open(KEY, "kestrel", "search-console", `${sealed.slice(0, -4)}AAAA`)).toThrow(/could not be opened/i);
  });

  it("uses a fresh nonce each time", () => {
    expect(seal(KEY, "kestrel", "search-console", { a: 1 })).not.toBe(seal(KEY, "kestrel", "search-console", { a: 1 }));
  });

  it("refuses a short or missing key", () => {
    expect(() => seal("short", "kestrel", "search-console", {})).toThrow(/key/i);
    expect(() => seal("", "kestrel", "search-console", {})).toThrow(/key/i);
  });
});

describe("the token file store", () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "allevia-tokens-")); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("keeps each tenant's tokens apart and encrypted on disk", async () => {
    const store = new FileTokenStore(dir, KEY);
    await store.put("kestrel", "search-console", rec("k"));
    await store.put("other_shop", "search-console", rec("o"));
    expect(await store.get("kestrel", "search-console")).toEqual(rec("k"));
    expect(await store.get("other_shop", "search-console")).toEqual(rec("o"));
    expect(await store.get("nobody", "search-console")).toBeNull();
    // nothing readable on disk: no token, no refresh token, not even the scope
    const files = readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith(".sealed"));
    expect(files.sort()).toEqual(["connectors/kestrel/search-console.sealed", "connectors/other_shop/search-console.sealed"]);
    for (const f of files) {
      const raw = readFileSync(join(dir, f), "utf8");
      expect(raw).not.toMatch(/access-|refresh-|webmasters/);
      expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600);
    }
  });

  it("a file copied into another tenant's folder cannot be read there", async () => {
    const store = new FileTokenStore(dir, KEY);
    const from = join(dir, "connectors", "kestrel", "search-console.sealed");
    await store.put("copycat", "search-console", rec("c")); // makes the folder
    writeFileSync(join(dir, "connectors", "copycat", "search-console.sealed"), readFileSync(from));
    await expect(store.get("copycat", "search-console")).rejects.toThrow(/could not be opened/i);
  });

  it("a different server key cannot read it either, and delete removes it", async () => {
    await expect(new FileTokenStore(dir, `${KEY}-rotated`).get("kestrel", "search-console")).rejects.toThrow(/could not be opened/i);
    const store = new FileTokenStore(dir, KEY);
    await store.delete("kestrel", "search-console");
    expect(await store.get("kestrel", "search-console")).toBeNull();
    await store.delete("kestrel", "search-console"); // deleting nothing is fine
  });

  it("refuses odd tenant names (no path tricks)", async () => {
    const store = new FileTokenStore(dir, KEY);
    for (const bad of ["../x", "a/b", "", ".", "A B"]) await expect(store.put(bad, "search-console", rec("x"))).rejects.toThrow(/tenant/i);
  });
});
