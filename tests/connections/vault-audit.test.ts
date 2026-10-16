// The sealed store's rotation and revocation, and the audit log's scrubbing and isolation.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SealedVault } from "../../src/connectors/google/store.js";
import { FileAuditLog, MemoryAuditLog, scrub } from "../../src/connections/audit.js";

const K1 = "first-connector-key-0123456789abcdef0123456789";
const K2 = "second-connector-key-0123456789abcdef012345678";

describe("the vault: rotation and revocation", () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "allevia-vault-")); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("opens what an older key sealed, and seals it again with the current key on read", async () => {
    await new SealedVault(dir, K1).put("kestrel", "shopify", { accountId: "ca_1" });
    const rotated = new SealedVault(dir, K2, [K1]);
    expect(await rotated.get("kestrel", "shopify")).toEqual({ accountId: "ca_1" });
    // now the old key is no longer needed
    expect(await new SealedVault(dir, K2).get("kestrel", "shopify")).toEqual({ accountId: "ca_1" });
    await expect(new SealedVault(dir, K1).get("kestrel", "shopify")).rejects.toThrow(/could not be opened/i);
  });

  it("rotateAll seals every business's records with the current key and reports the unreadable ones", async () => {
    await new SealedVault(dir, K1).put("kestrel", "hubspot", { a: 1 });
    await new SealedVault(dir, K1).put("other_shop", "stripe", { b: 2 });
    const r = await new SealedVault(dir, K2, [K1]).rotateAll();
    expect(r.unreadable).toEqual([]);
    expect(r.rotated).toBeGreaterThanOrEqual(3);
    const only2 = new SealedVault(dir, K2);
    expect(await only2.get("other_shop", "stripe")).toEqual({ b: 2 });
    expect(await only2.get("kestrel", "hubspot")).toEqual({ a: 1 });
  });

  it("deleteTenant forgets one business's connections and no one else's", async () => {
    const v = new SealedVault(dir, K2);
    await v.deleteTenant("kestrel");
    expect(await v.list("kestrel")).toEqual([]);
    expect(await v.list("other_shop")).toEqual(["stripe"]);
  });
});

describe("the audit log", () => {
  it("scrubs anything that looks like a credential, a bearer header or an email", () => {
    expect(scrub("Bearer ya29.A0AfH6SMBxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx failed")).toBe("Bearer [removed] failed");
    expect(scrub("token=abc123def and code=4/0AXYZ")).toBe("token=[removed] and code=[removed]");
    expect(scrub("sent to lead@client.example")).toBe("sent to [email]");
    expect(scrub("x".repeat(40))).toBe("[removed]");
    expect(scrub(undefined)).toBeUndefined();
  });

  it("keeps each business's entries apart, newest first, in memory and on disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "allevia-audit-"));
    try {
      for (const log of [new MemoryAuditLog(), new FileAuditLog(dir)]) {
        await log.append({ at: 1, tenant: "kestrel", connector: "gmail", op: "send", ok: true, detail: "to lead@client.example" });
        await log.append({ at: 2, tenant: "other_shop", connector: "gmail", op: "send", ok: false, detail: "Bearer abcdefghijklmnopqrstuvwxyz0123456789" });
        await log.append({ at: 3, tenant: "kestrel", connector: "google-calendar", op: "free time", ok: true, ms: 12.4 });
        const mine = await log.recent("kestrel");
        expect(mine.map((e) => e.op)).toEqual(["free time", "send"]);
        expect(mine[1]!.detail).toBe("to [email]");
        expect((await log.recent("kestrel", { connector: "gmail" })).length).toBe(1);
        expect((await log.recent("other_shop"))[0]!.detail).toBe("Bearer [removed]");
        expect(await log.recent("nobody")).toEqual([]);
      }
      expect(readFileSync(join(dir, "connectors", "other_shop", "audit.jsonl"), "utf8")).not.toMatch(/abcdefghijkl/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
